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
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

import { NaveTestHarness, VOTE_FOR, InitializedDao } from "./helpers/nave-harness";

/**
 * Localnet regression tests for the pre-redeploy hardening pass
 * (`fix/pre-redeploy-hardening`):
 *
 *   1. CRITICAL — `lock_tokens_and_vote` accepted an arbitrary caller-supplied
 *      `dao_token_mint`, so anyone could mint their own token and buy unbounded
 *      voting weight. `Proposal.token_mint` now snapshots the DAO's designated
 *      `voting_token` at creation and the vote instruction pins `dao_token_mint`
 *      to it (`VotingMintMismatch`).
 *
 *   2. HIGH — `record_moonlight_request` / `finalize_moonlight` only flipped
 *      `dao_registry.agents_enabled`, but every agent gate reads
 *      `agent_set.agents_enabled`, so the moonlight "halt" never halted the
 *      agents. Both flags are now flipped, and `nave_execution`'s deposit paths
 *      (`create_execution_request`, `execute_strategy`,
 *      `execute_strategy_direct`) additionally refuse while the DAO lifecycle is
 *      not `Active` (`DaoMoonlighting`).
 *
 * The bridge lock daily-cap / destination-allowlist tests live in
 * `bridge-staking-localnet.ts` (the bridge config is a singleton PDA shared by
 * that suite).
 */
describe("pre-redeploy hardening (audit fixes)", () => {
  let harness: NaveTestHarness;

  // Stake constants mirror `moonlight-replay.ts`.
  const DECIMALS = 6;
  const STAKE = 9_900_000n; // 9.9 NAVE @ 6 decimals ($99 at the $10 devnet price)
  const PRICE_USD_MICRO = 10_000_000n; // $10

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

  /** Create + immediately pass a proposal of the given type. */
  async function createAndPassProposal(
    dao: InitializedDao,
    proposalType: number,
    payload: Buffer,
    title: string,
  ): Promise<PublicKey> {
    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposal = harness.proposalPda(dao, registry.nextProposalIndex);

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
      // Return the locked weight so the next proposal can reach quorum.
      await harness.releaseVoteEscrows(dao, proposal, dao.members);
      return proposal;
  }

  before(async () => {
    harness = new NaveTestHarness();
    await harness.ensureGlobalConfig();
  });

  // ── Finding 1: voting-mint binding ──────────────────────────────────────────

  it("snapshots the DAO voting mint on the proposal and rejects lock_tokens_and_vote with any other mint", async () => {
    const dao = await harness.createDao({
      name: "Vote Mint Binding DAO",
      memberCount: 3,
      depositPerMemberUsdc: 100,
      guardianCount: 1,
      guardianThreshold: 1,
      governanceType: 1, // Token-weighted
    });

    const { proposal } = await harness.createStrategyProposal(
      dao,
      "mint-binding",
      harness.strategyPayload(harness.kamino.programId, 100n, dao.vaultMint),
      60, // long window: we only exercise voting here
    );

    // The proposal pins the DAO's designated voting token.
    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    const prop = await harness.governance.account.proposal.fetch(proposal);
    assert.equal(
      prop.tokenMint.toBase58(),
      dao.vaultMint.toBase58(),
      "Proposal.token_mint must equal the DAO governance mint",
    );
    assert.equal(
      registry.votingToken.toBase58(),
      dao.vaultMint.toBase58(),
      "DaoRegistry.voting_token should be the registered governance mint",
    );

    // Attacker mints their own token with unlimited supply and tries to vote
    // with it. Pre-fix this was accepted: the handler only checked that the
    // escrow/voter accounts matched the caller-supplied mint.
    const attacker = dao.members[0];
    const attackerMint = await createMint(
      harness.provider.connection,
      harness.founder,
      harness.founder.publicKey,
      null,
      DECIMALS,
    );
    const attackerAta = await getOrCreateAssociatedTokenAccount(
      harness.provider.connection,
      harness.founder,
      attackerMint,
      attacker.publicKey,
    );
    const bogusWeight = 1_000_000_000_000n; // 1M tokens — dwarfs the real supply
    await mintTo(
      harness.provider.connection,
      harness.founder,
      attackerMint,
      attackerAta.address,
      harness.founder,
      bogusWeight,
    );

    const voteEscrow = harness.voteEscrowPda(proposal, attacker.publicKey);
    const voteRecord = harness.voteRecordPda(proposal, attacker.publicKey);
    const bogusEscrowAta = getAssociatedTokenAddressSync(attackerMint, voteEscrow, true);
    const pre = [
      createAssociatedTokenAccountInstruction(
        harness.founder.publicKey,
        bogusEscrowAta,
        voteEscrow,
        attackerMint,
      ),
    ];

    await harness.expectError(
      () =>
        harness.governance.methods
          .lockTokensAndVote(new anchor.BN(bogusWeight.toString()), VOTE_FOR)
          .accountsPartial({
            voter: attacker.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            proposal,
            daoTokenMint: attackerMint, // <-- the attack
            voterTokenAccount: attackerAta.address,
            escrowTokenAccount: bogusEscrowAta,
            voteEscrow,
            voteRecord,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(pre)
          .signers([attacker, harness.founder])
          .rpc(),
      "VotingMintMismatch",
    );

    // No weight landed on the proposal.
    const afterAttack = await harness.governance.account.proposal.fetch(proposal);
    assert.equal(afterAttack.votesFor.toString(), "0", "bogus-mint vote must not count");

    // Positive control: the same voter CAN vote with the real governance token.
    const realAta = dao.memberTokenAccounts.get(attacker.publicKey.toBase58())!;
    const realBalance = (await harness.provider.connection.getTokenAccountBalance(realAta)).value
      .amount;
    await harness.lockTokensAndVote(dao, proposal, attacker, BigInt(realBalance), VOTE_FOR);
    const afterReal = await harness.governance.account.proposal.fetch(proposal);
    assert.equal(afterReal.votesFor.toString(), realBalance, "real-mint vote counts");
  });

  it("create_proposal rejects a registered-but-not-voting mint for token DAOs", async () => {
    const dao = await harness.createDao({
      name: "Create Proposal Mint DAO",
      memberCount: 2,
      depositPerMemberUsdc: 50,
      guardianCount: 1,
      guardianThreshold: 1,
      governanceType: 1,
    });
    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposal = harness.proposalPda(dao, registry.nextProposalIndex);
    const strangerMint = await createMint(
      harness.provider.connection,
      harness.founder,
      harness.founder.publicKey,
      null,
      DECIMALS,
    );

    // Not registered at all → TokenMintNotRegistered (existing check keeps
    // firing first); the point is that a proposer cannot pick a mint other
    // than `dao_registry.voting_token`.
    await harness.expectError(
      () =>
        harness.governance.methods
          .createProposal({
            title: "wrong mint",
            description: "wrong mint",
            payload: Buffer.alloc(0),
            proposalType: 9,
            votingPeriodSeconds: new anchor.BN(2),
          })
          .accountsPartial({
            proposer: harness.founder.publicKey,
            daoRegistry: dao.daoRegistry,
            proposal,
            daoTokenMint: strangerMint,
          })
          .rpc(),
      "TokenMintNotRegistered",
    );
  });

  // ── Finding 2: moonlight halt must flip the real agent gate ─────────────────

  it("record_moonlight_request flips agent_set.agents_enabled and nave_execution refuses new deployments", async () => {
    const dao = await harness.createDao({
      name: "Moonlight Halt DAO",
      memberCount: 3,
      depositPerMemberUsdc: 100,
      guardianCount: 1,
      guardianThreshold: 1,
      governanceType: 1,
    });

    // Agents are created disabled; enable the pipeline so the halt is observable.
    await harness.enableAgents(dao);
    let agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
    assert.isTrue(agentSet.agentsEnabled, "precondition: agents enabled");

    // Lock the NAVE creation stake (required before a moonlight request).
    const naveMint = await createMint(
      harness.provider.connection,
      harness.founder,
      harness.founder.publicKey,
      null,
      DECIMALS,
    );
    const founderNaveAta = (
      await getOrCreateAssociatedTokenAccount(
        harness.provider.connection,
        harness.founder,
        naveMint,
        harness.founder.publicKey,
      )
    ).address;
    await mintTo(
      harness.provider.connection,
      harness.founder,
      naveMint,
      founderNaveAta,
      harness.founder,
      1_000_000_000n,
    );
    const daoStakeLock = stakeLockPda(dao.daoRegistry);
    const stakeEscrow = stakeEscrowPda(dao.daoRegistry);
    const daoLifecycle = harness.daoLifecyclePda(dao.daoRegistry);

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

    // Before the moonlight request, a Strategy proposal can be turned into an
    // execution request (positive control for the DaoMoonlighting gate below;
    // the lifecycle PDA does not even exist yet and must be tolerated).
    const preAmount = 100n;
    const { proposal: preProposal } = await harness.createStrategyProposal(
      dao,
      "pre-moonlight strategy",
      harness.strategyPayload(harness.kamino.programId, preAmount, dao.vaultMint),
    );
    await harness.lockQuorumVotes(dao, preProposal, VOTE_FOR);
    await harness.finalizeProposal(dao, preProposal);
    await harness.releaseVoteEscrows(dao, preProposal, dao.members);
    await harness.createExecutionRequest(dao, preProposal, preAmount, harness.kamino.programId);

    // Pass a MoonlightRequest (type 9) and record it.
    const requestProposal = await createAndPassProposal(dao, 9, Buffer.alloc(0), "Wind down");
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

    const lifecycle = await harness.core.account.daoLifecycle.fetch(daoLifecycle);
    assert.equal(lifecycle.status, 1, "lifecycle Requested");

    // THE FIX: the gate every agent path reads is now off, not just the mirror.
    agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
    assert.isFalse(agentSet.agentsEnabled, "agent_set.agents_enabled must be halted");
    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    assert.isFalse(registry.agentsEnabled, "registry mirror also halted");

    // Governance itself keeps working (the wind-down needs further votes), so a
    // Strategy proposal can still pass — but it must not be deployable.
    const { proposal: strategyProposal } = await harness.createStrategyProposal(
      dao,
      "post-moonlight strategy",
      harness.strategyPayload(harness.kamino.programId, 100n, dao.vaultMint),
    );
    await harness.lockQuorumVotes(dao, strategyProposal, VOTE_FOR);
    await harness.finalizeProposal(dao, strategyProposal);

    // nave_execution refuses to queue a new deployment while moonlighting.
    await harness.expectError(
      () => harness.createExecutionRequest(dao, strategyProposal, 100n, harness.kamino.programId),
      "DaoMoonlighting",
    );

    // Agent approvals on the pre-existing request are blocked by the halted gate.
    const execReq = harness.executionRequestPda(preProposal);
    await harness.expectError(
      () =>
        harness.execution.methods
          .executiveApprove(Array(32).fill(1))
          .accounts({
            authority: dao.agents[0].publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            executionRequest: execReq,
          })
          .signers([dao.agents[0]])
          .rpc(),
      "AgentsDisabled",
    );
  });
});
