import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

import { NaveTestHarness, VOTE_FOR, InitializedDao } from "./helpers/nave-harness";

/**
 * Regression test for P6-3 (`nave-app/docs/AUDIT_FINDINGS.md`): before the fix,
 * `record_moonlight_request` / `execute_moonlight_distribution` never flipped
 * the `MoonlightRequest` / `MoonlightDistribution` governance proposals they
 * consumed to `Executed`, so after a `restore_dao` cycle the EXACT SAME
 * already-consumed proposal pair could be replayed to re-trigger moonlighting
 * without a fresh vote.
 *
 * The fix adds `nave_governance::mark_moonlight_proposal_executed` (callable
 * only as a CPI from `nave_core`, verified via the instructions sysvar) and
 * `nave_core`'s moonlight handlers now call it immediately after validating
 * each proposal, before advancing the lifecycle.
 *
 * This test drives a full moonlight cycle end-to-end, confirms both consumed
 * proposals land in `Executed` status, restores the DAO, and then proves the
 * exact same (now-`Executed`) proposal pair is rejected with
 * `MoonlightProposalInvalid` when fed into the handlers a second time — the
 * replay the vulnerability would have allowed.
 */
describe("moonlight cross-cycle replay protection (P6-3)", () => {
  let harness: NaveTestHarness;
  const DECIMALS = 6;
  const STAKE = 9_900_000n; // 9.9 NAVE @ 6 decimals ($99 at $10 devnet price)
  const PRICE_USD_MICRO = 10_000_000n; // $10

  let naveMint: PublicKey;
  let founderNaveAta: PublicKey;
  let recipient: Keypair;
  let recipientNaveAccount: PublicKey;

  function stakeLockPda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dao_stake_lock"), daoRegistry.toBuffer()],
      harness.core.programId,
    )[0];
  }
  function stakeEscrowPda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("stake_escrow"), daoRegistry.toBuffer()],
      harness.core.programId,
    )[0];
  }
  function lifecyclePda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dao_lifecycle"), daoRegistry.toBuffer()],
      harness.core.programId,
    )[0];
  }

  /** Create + immediately pass a moonlight-family proposal (type 9 or 10). */
  async function createAndPassMoonlightProposal(
    dao: InitializedDao,
    proposalType: number,
    payload: Buffer,
    title: string,
  ): Promise<PublicKey> {
    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposalIndex = registry.proposalCount;
    const proposal = harness.proposalPda(dao, proposalIndex);

    await harness.governance.methods
      .createProposal({
        title,
        description: title,
        payload,
        proposalType,
        votingPeriodSeconds: new anchor.BN(2),
      })
      .accountsPartial({
        proposer: harness.founder.publicKey,
        daoRegistry: dao.daoRegistry,
        proposal,
        daoTokenMint: dao.vaultMint,
      })
      .rpc();

    await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await harness.finalizeProposal(dao, proposal);

    const p = await harness.governance.account.proposal.fetch(proposal);
    assert.equal(p.status, 1, `${title} should be Passed`);

    // Members collectively hold ~quorum weight (the remainder of the supply
    // sits in the vault), so return the locked tokens or the next proposal in
    // this DAO cannot reach quorum.
    await harness.releaseVoteEscrows(dao, proposal, dao.members);

    return proposal;
  }

  before(async () => {
    harness = new NaveTestHarness();
    await harness.ensureGlobalConfig();
    naveMint = await createMint(
      harness.provider.connection,
      harness.founder,
      harness.founder.publicKey,
      null,
      DECIMALS,
    );
    const ata = await getOrCreateAssociatedTokenAccount(
      harness.provider.connection,
      harness.founder,
      naveMint,
      harness.founder.publicKey,
    );
    founderNaveAta = ata.address;
    await mintTo(
      harness.provider.connection,
      harness.founder,
      naveMint,
      founderNaveAta,
      harness.founder,
      1_000_000_000n, // 1000 NAVE — enough for the initial stake + restore
    );

    recipient = Keypair.generate();
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      harness.provider.connection,
      harness.founder,
      naveMint,
      recipient.publicKey,
    );
    recipientNaveAccount = recipientAta.address;
  });

  it("consumes MoonlightRequest/MoonlightDistribution proposals (Executed) and rejects their replay after restore_dao", async () => {
    const dao = await harness.createDao({
      name: "Moonlight Replay DAO",
      memberCount: 3,
      depositPerMemberUsdc: 100,
      guardianCount: 1,
      guardianThreshold: 1,
      governanceType: 1, // Token-weighted: required for lockQuorumVotes-style voting.
    });

    const daoStakeLock = stakeLockPda(dao.daoRegistry);
    const stakeEscrow = stakeEscrowPda(dao.daoRegistry);
    const daoLifecycle = lifecyclePda(dao.daoRegistry);

    // ── Step 1: lock the NAVE creation stake ────────────────────────────────
    await harness.core.methods
      .stakeDaoCreation(new anchor.BN(STAKE.toString()), new anchor.BN(PRICE_USD_MICRO.toString()))
      .accounts({
        founder: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        naveMint,
        founderNaveAccount: founderNaveAta,
        daoStakeLock,
        stakeEscrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // ── Step 2: create + pass a MoonlightRequest (type 9) proposal ──────────
    // record_moonlight_request_handler never reads the proposal payload, only
    // type/status/proposer, so an empty payload is sufficient.
    const requestProposal = await createAndPassMoonlightProposal(
      dao,
      9,
      Buffer.alloc(0),
      "Wind down the DAO",
    );

    await harness.core.methods
      .recordMoonlightRequest()
      .accounts({
        founder: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        daoLifecycle,
        requestProposal,
        governanceProgram: harness.governance.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    let lifecycle = await harness.core.account.daoLifecycle.fetch(daoLifecycle);
    assert.equal(lifecycle.status, 1, "lifecycle Requested");

    await harness.core.methods
      .setMoonlightDistribution(recipient.publicKey)
      .accounts({
        initiator: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle,
      })
      .rpc();

    lifecycle = await harness.core.account.daoLifecycle.fetch(daoLifecycle);
    assert.equal(lifecycle.status, 2, "lifecycle DistributionPending");

    // ── Step 3: create + pass a MoonlightDistribution (type 10) proposal ────
    // execute_moonlight_distribution_handler reads the approved recipient from
    // the first 32 payload bytes.
    const distributionProposal = await createAndPassMoonlightProposal(
      dao,
      10,
      recipient.publicKey.toBuffer(),
      "Distribute to recipient",
    );

    await harness.core.methods
      .executeMoonlightDistribution()
      .accounts({
        authority: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle,
        daoStakeLock,
        stakeEscrow,
        recipientNaveAccount,
        distributionProposal,
        governanceProgram: harness.governance.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    lifecycle = await harness.core.account.daoLifecycle.fetch(daoLifecycle);
    assert.equal(lifecycle.status, 3, "lifecycle Distributing");

    const recipientAcc = await getAccount(harness.provider.connection, recipientNaveAccount);
    assert.equal(recipientAcc.amount.toString(), STAKE.toString(), "stake released to recipient");

    await harness.core.methods
      .finalizeMoonlight()
      .accounts({
        authority: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        daoLifecycle,
      })
      .rpc();

    lifecycle = await harness.core.account.daoLifecycle.fetch(daoLifecycle);
    assert.equal(lifecycle.status, 4, "lifecycle Moonlighted");

    // ── Key assertion #1: both consumed proposals are now Executed on the
    // nave_governance side (this is the fix — previously they stayed Passed
    // forever, which is exactly what made the replay possible). ────────────
    const requestProp = await harness.governance.account.proposal.fetch(requestProposal);
    assert.equal(requestProp.status, 4, "MoonlightRequest proposal marked Executed");

    const distributionProp = await harness.governance.account.proposal.fetch(distributionProposal);
    assert.equal(distributionProp.status, 4, "MoonlightDistribution proposal marked Executed");

    // ── Step 4: restore_dao reopens without pulling a new NAVE lock ────────
    const founderBeforeRestore = await getAccount(harness.provider.connection, founderNaveAta);
    const escrowBeforeRestore = await getAccount(harness.provider.connection, stakeEscrow);
    assert.equal(escrowBeforeRestore.amount.toString(), "0", "escrow already emptied by release");

    await harness.core.methods
      .restoreDao(new anchor.BN(STAKE.toString()), new anchor.BN(PRICE_USD_MICRO.toString()))
      .accounts({
        founder: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle,
        daoStakeLock,
        naveMint,
        founderNaveAccount: founderNaveAta,
        stakeEscrow,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    lifecycle = await harness.core.account.daoLifecycle.fetch(daoLifecycle);
    assert.equal(lifecycle.status, 0, "lifecycle restored to Active");
    const founderAfterRestore = await getAccount(harness.provider.connection, founderNaveAta);
    assert.equal(
      founderAfterRestore.amount.toString(),
      founderBeforeRestore.amount.toString(),
      "restore does not pull NAVE",
    );
    const escrowAfterRestore = await getAccount(harness.provider.connection, stakeEscrow);
    assert.equal(escrowAfterRestore.amount.toString(), "0", "escrow stays empty");
    const lockAfterRestore = await harness.core.account.daoStakeLock.fetch(daoStakeLock);
    assert.equal(lockAfterRestore.status, 1, "existing lock stays Released");
    assert.equal(lockAfterRestore.lockedAmount.toString(), "0");

    // ── Key assertion #2 (the fix under test): replaying the EXACT SAME
    // now-Executed proposal pair must be rejected. Before the fix, these
    // proposals stayed `Passed` forever and this replay would have SUCCEEDED,
    // re-triggering moonlighting (and re-releasing the stake) without any
    // fresh vote. ────────────────────────────────────────────────────────────
    await harness.expectError(
      () =>
        harness.core.methods
          .recordMoonlightRequest()
          .accounts({
            founder: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            daoLifecycle,
            requestProposal,
            governanceProgram: harness.governance.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      "MoonlightProposalInvalid",
    );

    await harness.expectError(
      () =>
        harness.core.methods
          .executeMoonlightDistribution()
          .accounts({
            authority: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            daoLifecycle,
            daoStakeLock,
            stakeEscrow,
            recipientNaveAccount,
            distributionProposal,
            governanceProgram: harness.governance.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
      "MoonlightProposalInvalid",
    );

    // Confirm the replay attempts left both proposals' Executed status intact
    // (mark_moonlight_proposal_executed is never reached — load_passed_proposal
    // rejects the replay before any CPI happens) and the lifecycle unchanged.
    const requestPropAfter = await harness.governance.account.proposal.fetch(requestProposal);
    assert.equal(requestPropAfter.status, 4, "MoonlightRequest proposal still Executed");
    const distributionPropAfter = await harness.governance.account.proposal.fetch(distributionProposal);
    assert.equal(distributionPropAfter.status, 4, "MoonlightDistribution proposal still Executed");

    lifecycle = await harness.core.account.daoLifecycle.fetch(daoLifecycle);
    assert.equal(lifecycle.status, 0, "lifecycle still Active after rejected replay attempts");
  });

  it("moonlights and restores a treasury that never locked NAVE", async () => {
    const dao = await harness.createDao({
      name: "Moonlight No Stake DAO",
      memberCount: 3,
      depositPerMemberUsdc: 100,
      guardianCount: 1,
      guardianThreshold: 1,
      governanceType: 1,
    });
    const daoLifecycle = lifecyclePda(dao.daoRegistry);
    const founderBefore = await getAccount(harness.provider.connection, founderNaveAta);

    const requestProposal = await createAndPassMoonlightProposal(
      dao,
      9,
      Buffer.alloc(0),
      "Wind down without a stake",
    );
    await harness.core.methods
      .recordMoonlightRequest()
      .accounts({
        founder: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        daoLifecycle,
        requestProposal,
        governanceProgram: harness.governance.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await harness.core.methods
      .setMoonlightDistribution(recipient.publicKey)
      .accounts({
        initiator: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle,
      })
      .rpc();

    const distributionProposal = await createAndPassMoonlightProposal(
      dao,
      10,
      recipient.publicKey.toBuffer(),
      "Distribute with no stake",
    );
    const recipientBefore = await getAccount(harness.provider.connection, recipientNaveAccount);
    await harness.core.methods
      .executeMoonlightDistribution()
      .accounts({
        authority: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle,
        daoStakeLock: null,
        stakeEscrow: null,
        recipientNaveAccount: null,
        distributionProposal,
        governanceProgram: harness.governance.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const recipientAfter = await getAccount(harness.provider.connection, recipientNaveAccount);
    assert.equal(
      recipientAfter.amount.toString(),
      recipientBefore.amount.toString(),
      "no stake means nothing is released",
    );

    await harness.core.methods
      .finalizeMoonlight()
      .accounts({
        authority: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        daoLifecycle,
      })
      .rpc();

    await harness.core.methods
      .restoreDao(new anchor.BN(0), new anchor.BN(0))
      .accounts({
        founder: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle,
        daoStakeLock: null,
        naveMint: null,
        founderNaveAccount: null,
        stakeEscrow: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const lifecycle = await harness.core.account.daoLifecycle.fetch(daoLifecycle);
    assert.equal(lifecycle.status, 0, "stake-less treasury restored to Active");
    const founderAfter = await getAccount(harness.provider.connection, founderNaveAta);
    assert.equal(
      founderAfter.amount.toString(),
      founderBefore.amount.toString(),
      "stake-less restore does not pull NAVE",
    );
  });
});
