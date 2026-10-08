/**
 * Batch 1 — Solana Critical audit remediation coverage.
 *
 * SOL-C1: governance transfer execution must bind the payload-decoded
 *         `recipient` to the actual `recipient` account passed to the
 *         instruction (governance_transfer.rs).
 * SOL-C2: `switch_voting_system` must be CPI-only from a passed
 *         `nave_governance` `SwitchVotingSystem` proposal — a direct call
 *         (no CPI) must be rejected, and a valid CPI'd call must succeed
 *         exactly once (replay-protected).
 * SOL-C3: a freshly created DAO's `jupiter_swap` must enforce non-zero
 *         slippage/single-swap-size guardrails by default, with no founder
 *         opt-in required.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { assert } from "chai";
import { NaveTestHarness, VOTE_FOR } from "./helpers/nave-harness";

const JUPITER_SWAP_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/** `nave_governance::constants::SWITCH_VOTING_QUORUM_BPS` (70%) — overrides the
 * DAO's configured `quorum_bps` for this proposal type, so the harness's
 * generic `requiredQuorumWeight` (which only reads `dao_registry.quorum_bps`)
 * would under-lock votes here without this override. */
const SWITCH_VOTING_QUORUM_BPS = 7000n;

async function switchVotingQuorumWeight(
  harness: NaveTestHarness,
  proposal: PublicKey
): Promise<bigint> {
  const p = await harness.governance.account.proposal.fetch(proposal);
  return (BigInt(p.snapshotSupply.toString()) * SWITCH_VOTING_QUORUM_BPS) / 10000n;
}

describe("Batch 1 — Solana critical audit fixes", () => {
  describe("SOL-C1: governance transfer recipient binding", () => {
    it("rejects a treasury SPL transfer whose recipient account does not match the proposal payload", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sol-c1-recipient",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 2,
        guardianThreshold: 1,
      });

      const approvedRecipient = Keypair.generate();
      const attackerRecipient = Keypair.generate();
      await harness.airdrop(approvedRecipient.publicKey, 0.05);
      await harness.airdrop(attackerRecipient.publicKey, 0.05);

      const grantRaw = 50_000n;
      const { proposal } = await harness.createTransferProposal(
        dao,
        "Grant to approved recipient",
        approvedRecipient.publicKey,
        dao.vaultMint,
        grantRaw,
        60
      );
      await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
      await harness.finalizeProposal(dao, proposal);
      const p = await harness.governance.account.proposal.fetch(proposal);
      assert.equal(p.status, 1, "transfer proposal should be Passed");

      // Executing with a DIFFERENT recipient than the one bound in the
      // proposal's payload must now fail (previously only recipient_token's
      // owner was checked against `recipient`, never the payload itself).
      await harness.expectError(
        () => harness.executeTransferSpl(dao, proposal, attackerRecipient.publicKey, dao.vaultMint),
        "RecipientMismatch"
      );

      // The proposal must remain executable by the APPROVED recipient.
      const assetVaultBefore = await getAccount(harness.provider.connection, dao.assetVaultTokenAccount);
      await harness.executeTransferSpl(dao, proposal, approvedRecipient.publicKey, dao.vaultMint);
      const approvedAta = getAssociatedTokenAddressSync(dao.vaultMint, approvedRecipient.publicKey);
      const approvedBal = await getAccount(harness.provider.connection, approvedAta);
      assert.equal(approvedBal.amount.toString(), grantRaw.toString());
      const assetVaultAfter = await getAccount(harness.provider.connection, dao.assetVaultTokenAccount);
      assert.equal(assetVaultBefore.amount - assetVaultAfter.amount, grantRaw);

      // Attacker's ATA must never have received funds despite the failed attempt
      // (the whole transaction reverts, including any init_if_needed side effects).
      const attackerAta = getAssociatedTokenAddressSync(dao.vaultMint, attackerRecipient.publicKey);
      const attackerAtaInfo = await harness.provider.connection.getAccountInfo(attackerAta);
      assert.isNull(attackerAtaInfo, "attacker ATA must not have been created/funded");
    });
  });

  describe("SOL-C2: switch_voting_system is CPI-only from a passed proposal", () => {
    it("rejects a direct (non-CPI) call to nave_core::switch_voting_system", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sol-c2-direct-reject",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 2,
        guardianThreshold: 1,
        // SwitchVotingSystem requires 70% quorum (vs. the DAO's default 35%),
        // so members need much more spare voting-token balance (beyond their
        // treasury deposit) than the harness's default sizing provides.
        tokensPerMember: 5_000_000_000n,
      });

      const newGuardian = Keypair.generate();
      const payload = harness.switchVotingPayload(0, PublicKey.default, 1, [newGuardian.publicKey]);
      const { proposal } = await harness.createSwitchVotingProposal(
        dao,
        "Switch to wallet governance",
        payload,
        60
      );
      await harness.lockQuorumVotes(
        dao,
        proposal,
        VOTE_FOR,
        await switchVotingQuorumWeight(harness, proposal)
      );
      await harness.finalizeProposal(dao, proposal);
      const p = await harness.governance.account.proposal.fetch(proposal);
      assert.equal(p.status, 1, "switch-voting-system proposal should be Passed");

      // Direct top-level call (no nave_governance CPI wrapper) must fail the
      // instructions-sysvar caller check, even though the proposal is a
      // legitimately Passed SwitchVotingSystem proposal for this DAO.
      await harness.expectError(
        () => harness.switchVotingSystemDirect(dao, proposal),
        "Unauthorized"
      );

      // The DAO's governance type must be untouched by the rejected call.
      const daoAfterReject = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
      assert.equal(daoAfterReject.governanceType, 1, "governance_type unchanged (still Token)");
    });

    it("succeeds when CPI'd from nave_governance against a valid Passed proposal, and cannot be replayed", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sol-c2-cpi-success",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 2,
        guardianThreshold: 1,
        tokensPerMember: 5_000_000_000n,
      });

      const newGuardian = Keypair.generate();
      const payload = harness.switchVotingPayload(0, PublicKey.default, 1, [newGuardian.publicKey]);
      const { proposal } = await harness.createSwitchVotingProposal(
        dao,
        "Switch to wallet governance",
        payload,
        60
      );
      await harness.lockQuorumVotes(
        dao,
        proposal,
        VOTE_FOR,
        await switchVotingQuorumWeight(harness, proposal)
      );
      await harness.finalizeProposal(dao, proposal);

      await harness.executeSwitchVotingSystem(dao, proposal);

      const daoAfter = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
      assert.equal(daoAfter.governanceType, 0, "governance_type switched to Wallet");
      assert.equal(daoAfter.votingToken.toString(), PublicKey.default.toString());

      const guardianConfigAfter = await harness.core.account.guardianConfig.fetch(dao.guardianConfig);
      assert.equal(guardianConfigAfter.threshold, 1);
      assert.equal(guardianConfigAfter.walletCount, 1);
      assert.equal(
        new PublicKey(guardianConfigAfter.wallets[0]).toString(),
        newGuardian.publicKey.toString()
      );

      const proposalAfter = await harness.governance.account.proposal.fetch(proposal);
      assert.equal(proposalAfter.status, 4, "proposal marked Executed after CPI");

      // Replay must be rejected: the proposal is no longer Passed.
      await harness.expectError(
        () => harness.executeSwitchVotingSystem(dao, proposal),
        "InvalidProposalStatus"
      );
    });
  });

  describe("SOL-C3: jupiter_swap guardrail defaults", () => {
    it("enforces non-zero slippage and single-swap-size guardrails on a freshly created DAO with no founder opt-in", async () => {
      const harness = new NaveTestHarness();
      const dao = await harness.createDao({
        name: "sol-c3-guardrail-default",
        memberCount: 3,
        depositPerMemberUsdc: 1_000,
        guardianCount: 1,
        guardianThreshold: 1,
      });
      await harness.enableAgents(dao);

      const constitutionAcc = await harness.core.account.treasuryConstitution.fetch(dao.constitution);
      assert.equal(constitutionAcc.maxSlippageBps, 150, "max_slippage_bps seeded to 150 bps by default");
      assert.equal(
        constitutionAcc.maxSingleSwapBps,
        2000,
        "max_single_swap_bps seeded to 2000 bps by default"
      );

      const mintOut = await createMint(
        harness.provider.connection,
        harness.founder,
        harness.founder.publicKey,
        null,
        6
      );
      const assetConfigOut = harness.assetConfigPda(dao.daoRegistry, mintOut);
      const treasuryAssetOut = harness.treasuryAssetPda(dao.daoRegistry, mintOut);
      const assetVaultOut = harness.assetVaultPda(dao.daoRegistry, mintOut);
      await harness.core.methods
        .registerAsset(new Array(32).fill(0), true, 0)
        .accounts({
          authority: harness.founder.publicKey,
          globalConfig: harness.globalConfig,
          daoRegistry: dao.daoRegistry,
          mint: mintOut,
          vaultAuthority: dao.vaultAuthority,
          treasuryVault: dao.treasuryVault,
          assetConfig: assetConfigOut,
          treasuryAsset: treasuryAssetOut,
          assetVault: assetVaultOut,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const assetConfigIn = harness.assetConfigPda(dao.daoRegistry, dao.vaultMint);
      const treasuryAssetIn = harness.treasuryAssetPda(dao.daoRegistry, dao.vaultMint);
      const operational = dao.agents[3];

      const jupiterSwapAccounts = {
        operationalAgent: operational.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        constitution: dao.constitution,
        vaultAuthority: dao.vaultAuthority,
        treasuryVault: dao.treasuryVault,
        mintIn: dao.vaultMint,
        mintOut,
        assetConfigIn,
        assetConfigOut,
        treasuryAssetIn,
        treasuryAssetOut,
        sourceTokenAccount: dao.assetVaultTokenAccount,
        destinationTokenAccount: assetVaultOut,
        jupiterProgram: JUPITER_SWAP_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any;

      const preSrc = (await getAccount(harness.provider.connection, dao.assetVaultTokenAccount)).amount;

      // 1. Slippage guardrail fires even though the founder never called
      //    set_max_slippage_bps (150 bps default from DAO creation).
      const expectedOut = new anchor.BN(1_000_000);
      const violatingMinOut = new anchor.BN(900_000); // 10% implied slippage > 1.5% default cap
      const smallAmountIn = new anchor.BN(((preSrc * 1n) / 100n).toString()); // 1% of balance
      await harness.expectError(
        () =>
          harness.core.methods
            .jupiterSwap(smallAmountIn, violatingMinOut, expectedOut, Buffer.alloc(0))
            .accounts(jupiterSwapAccounts)
            .remainingAccounts([])
            .signers([operational])
            .rpc(),
        "MaxSlippageExceeded"
      );

      // 2. Single-swap-size guardrail fires even though the founder never
      //    called set_max_single_swap_bps (2000 bps / 20% default cap).
      const compliantMinOut = new anchor.BN(990_000); // 1% implied slippage <= 1.5% default cap
      const tooBigAmountIn = new anchor.BN(((preSrc * 25n) / 100n).toString()); // 25% > 20% cap
      await harness.expectError(
        () =>
          harness.core.methods
            .jupiterSwap(tooBigAmountIn, compliantMinOut, expectedOut, Buffer.alloc(0))
            .accounts(jupiterSwapAccounts)
            .remainingAccounts([])
            .signers([operational])
            .rpc(),
        "MaxSingleSwapExceeded"
      );
    });
  });
});
