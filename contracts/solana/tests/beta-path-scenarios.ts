import { assert } from "chai";
import { getAccount } from "@solana/spl-token";
import { NaveTestHarness, VOTE_FOR, pctOfTreasury } from "./helpers/nave-harness";

/**
 * Beta-path coverage (devnet public-beta entry gate).
 *
 * These exercise the production execution paths that the existing suite skips
 * by using the break-glass `execute_strategy_direct` (which disables agents to
 * bypass the review window). Here we drive the REAL pipeline:
 *
 *   - `execute_strategy` after a genuine review window elapses (not direct),
 *   - `withdraw_from_strategy` round-trip reversal,
 *   - `expire_request` on a timed-out InReview request,
 *   - emergency freeze BLOCKS `execute_strategy` (audit H1 regression guard).
 *
 * The DAO review window is lowered to the on-chain minimum (60s) so the waits
 * are bounded; each test raises its mocha timeout accordingly.
 */
describe("beta-path: real execution pipeline (no break-glass)", () => {
  let harness: NaveTestHarness;
  const MIN_REVIEW = 60; // MIN_REVIEW_WINDOW_SECONDS
  const WAIT_MS = (MIN_REVIEW + 6) * 1000;

  before(() => {
    harness = new NaveTestHarness();
  });

  async function passedRequestInReview(name: string) {
    const dao = await harness.createDao({
      name,
      memberCount: 5,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    await harness.enableAgents(dao); // agents are created disabled; turn on the pipeline
    await harness.setReviewWindow(dao, MIN_REVIEW);

    const amount = pctOfTreasury(dao.totalTreasuryRaw, 2000); // 20% of NAV, under the 40% kamino cap
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      `${name}-strategy`,
      harness.strategyPayload(harness.kamino.programId, amount, dao.vaultMint)
    );

    await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await harness.finalizeProposal(dao, proposal);

    const execReq = await harness.createExecutionRequest(
      dao,
      proposal,
      amount,
      harness.kamino.programId
    );

    // Executive -> Financial -> Oversight -> InReview (review_end = now + 60s).
    await harness.runAgentApprovals(dao, execReq, payloadHash);

    return { dao, execReq, amount };
  }

  it("executes after the review window and reconciles balances, then withdraws back", async function () {
    this.timeout(WAIT_MS + 60_000);
    const { dao, execReq, amount } = await passedRequestInReview("beta-exec");

    const vaultBefore = BigInt(
      (await getAccount(harness.provider.connection, dao.assetVaultTokenAccount)).amount.toString()
    );

    // Wait out the review window, then run the permissionless production path.
    await harness.sleep(WAIT_MS);
    await harness.executeStrategy(dao, execReq, harness.kamino.programId, "kamino");

    const req = await harness.execution.account.executionRequest.fetch(execReq);
    assert.equal(req.status, 5, "status should be Executed");

    const escrow = harness.strategyEscrowPda(dao.daoRegistry, "kamino", dao.vaultMint);
    const escrowBal = BigInt((await getAccount(harness.provider.connection, escrow)).amount.toString());
    const vaultAfter = BigInt(
      (await getAccount(harness.provider.connection, dao.assetVaultTokenAccount)).amount.toString()
    );
    const vault = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);

    // Reconciliation invariants (RECONCILIATION.md): real SPL moved vault -> escrow.
    assert.equal(escrowBal.toString(), amount.toString(), "escrow holds the deployed amount");
    assert.equal((vaultBefore - vaultAfter).toString(), amount.toString(), "vault decreased by amount");
    assert.equal(vault.deployedCapital.toString(), amount.toString(), "deployed_capital == amount");

    // Round-trip: Executive unwinds the full position back to the vault.
    await harness.withdrawFromStrategy(dao, execReq, harness.kamino.programId, "kamino", amount);

    const escrowAfterW = BigInt((await getAccount(harness.provider.connection, escrow)).amount.toString());
    const vaultAfterW = BigInt(
      (await getAccount(harness.provider.connection, dao.assetVaultTokenAccount)).amount.toString()
    );
    const vaultStateW = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);

    assert.equal(escrowAfterW.toString(), "0", "escrow drained after withdraw");
    assert.equal(vaultAfterW.toString(), vaultBefore.toString(), "vault restored to pre-execute balance");
    assert.equal(vaultStateW.deployedCapital.toString(), "0", "deployed_capital back to 0");
  });

  it("expires an InReview request once its window elapses", async function () {
    this.timeout(WAIT_MS + 60_000);
    const { dao, execReq } = await passedRequestInReview("beta-expire");

    await harness.sleep(WAIT_MS);
    await harness.expireRequest(dao, execReq);

    const req = await harness.execution.account.executionRequest.fetch(execReq);
    assert.equal(req.status, 7, "status should be Expired");
  });

  it("rejects execute_strategy while the DAO is frozen (H1)", async function () {
    this.timeout(WAIT_MS + 60_000);
    const { dao, execReq } = await passedRequestInReview("beta-frozen");

    // Guardians freeze during the review window.
    await harness.guardianEmergencyFreeze(dao, 1, dao.guardians.slice(0, dao.config.guardianThreshold));

    await harness.sleep(WAIT_MS);
    await harness.expectError(
      () => harness.executeStrategy(dao, execReq, harness.kamino.programId, "kamino"),
      "DaoFrozen"
    );
  });
});
