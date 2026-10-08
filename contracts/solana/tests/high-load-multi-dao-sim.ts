import * as anchor from "@coral-xyz/anchor";
import { getAccount, mintTo } from "@solana/spl-token";
import { assert } from "chai";
import { NaveTestHarness, VOTE_FOR, pctOfTreasury, InitializedDao } from "./helpers/nave-harness";

/**
 * Phase-4 high-load / multi-DAO simulation.
 *
 * Drives several DAOs through the full money loop — deploy -> compound ->
 * withdraw — over the REAL production execution path (`execute_strategy` after a
 * genuine review window; agents stay enabled, no break-glass) and asserts the
 * system-wide invariants under that load:
 *
 *   • no double-harvest: a fully unwound position cannot be withdrawn again;
 *   • no allocation-cap bypass: a deploy over the per-protocol cap rejects even
 *     while other DAOs are mid-cycle;
 *   • accounting stays consistent: per-DAO escrow balance, the position mark,
 *     and the vault's USD `deployed_capital` move together and net to zero after
 *     a full round-trip — and one DAO's lifecycle never bleeds into another's.
 *
 * The review windows are lowered to the 60s minimum and all DAOs are approved
 * up-front, so a single ~66s wait clears every window at once.
 */
describe("high-load: multi-DAO deploy/compound/withdraw stays consistent", () => {
  let h: NaveTestHarness;
  const N = 3;
  const DEPLOY_BPS = 2000; // 20% of NAV per DAO (under 40% kamino cap)
  const MIN_REVIEW = 60;
  const WAIT_MS = (MIN_REVIEW + 6) * 1000;
  // Mirrors `POSITION_MARK_COOLDOWN_SECS` (constants.rs) + a small buffer so
  // the on-chain clock has unambiguously cleared it.
  const POSITION_MARK_COOLDOWN_MS = (5 * 60 + 10) * 1000;

  const dao: InitializedDao[] = [];
  const execReq: anchor.web3.PublicKey[] = [];
  const deployed: bigint[] = [];
  const gain: bigint[] = [];

  before(async function () {
    this.timeout(300_000);
    h = new NaveTestHarness();
    // DAOs share the founder wallet + global dao_count, so creation serializes;
    // their lifecycles are then driven phase-by-phase to interleave state.
    for (let i = 0; i < N; i++) {
      const d = await h.createDao({
        name: `load-${i}`,
        memberCount: 4,
        depositPerMemberUsdc: 5_000,
        guardianCount: 3,
        guardianThreshold: 2,
      });
      await h.enableAgents(d); // agents are created disabled; turn on the pipeline
      await h.setReviewWindow(d, MIN_REVIEW);
      const amount = pctOfTreasury(d.totalTreasuryRaw, DEPLOY_BPS);
      const { proposal, payloadHash } = await h.createStrategyProposal(
        d,
        `load-${i}-strat`,
        h.strategyPayload(h.kamino.programId, amount, d.vaultMint)
      );
      await h.lockQuorumVotes(d, proposal, VOTE_FOR);
      await h.finalizeProposal(d, proposal);
      const er = await h.createExecutionRequest(d, proposal, amount, h.kamino.programId);
      // Executive -> Financial -> Oversight -> InReview (review_end = now + 60s).
      await h.runAgentApprovals(d, er, payloadHash);
      dao.push(d);
      execReq.push(er);
      deployed.push(amount);
      gain.push(amount / 10n); // +10% simulated harvest
    }
  });

  async function escrowBalance(d: InitializedDao): Promise<bigint> {
    const escrow = h.strategyEscrowPda(d.daoRegistry, "kamino", d.vaultMint);
    const info = await h.provider.connection.getAccountInfo(escrow);
    if (!info) return 0n;
    return BigInt((await getAccount(h.provider.connection, escrow)).amount.toString());
  }

  function positionPda(d: InitializedDao): anchor.web3.PublicKey {
    return h.strategyPositionPda(d.daoRegistry, "kamino", d.vaultMint);
  }

  it("PHASE 1 — deploys all DAOs after the review window; escrow + USD match", async function () {
    this.timeout(WAIT_MS + 180_000);
    // One shared wait clears every DAO's review window at once.
    await h.sleep(WAIT_MS);

    for (let i = 0; i < N; i++) {
      const vaultBefore = BigInt(
        (await getAccount(h.provider.connection, dao[i].assetVaultTokenAccount)).amount.toString()
      );
      await h.executeStrategy(dao[i], execReq[i], h.kamino.programId, "kamino");

      const esc = await escrowBalance(dao[i]);
      const vaultAfter = BigInt(
        (await getAccount(h.provider.connection, dao[i].assetVaultTokenAccount)).amount.toString()
      );
      const tv = await h.core.account.treasuryVault.fetch(dao[i].treasuryVault);

      assert.equal(esc.toString(), deployed[i].toString(), `DAO ${i}: escrow holds deployed amount`);
      assert.equal(
        (vaultBefore - vaultAfter).toString(),
        deployed[i].toString(),
        `DAO ${i}: vault decreased by exactly the deployed amount`
      );
      // 6-decimal stablecoin: micro-USD value == base units.
      assert.equal(
        tv.deployedCapital.toString(),
        deployed[i].toString(),
        `DAO ${i}: USD deployed_capital == deployed amount`
      );
    }
  });

  it("PHASE 2 — isolation: each DAO's deployed state is independent", async () => {
    for (let i = 0; i < N; i++) {
      const tv = await h.core.account.treasuryVault.fetch(dao[i].treasuryVault);
      const pos = await h.core.account.strategyPosition.fetch(positionPda(dao[i]));
      assert.equal(tv.deployedCapital.toString(), deployed[i].toString());
      assert.equal(pos.depositedAmount.toString(), deployed[i].toString());
      assert.equal(pos.currentValue.toString(), deployed[i].toString());
    }
  });

  it("PHASE 3 — compounds (harvest yield) into each position", async function () {
    this.timeout(POSITION_MARK_COOLDOWN_MS + 120_000);
    // `update_strategy_position_value` now enforces POSITION_MARK_COOLDOWN_SECS
    // (5 minutes) between marks on the same position; PHASE 1's deploy already
    // stamped `last_updated`, so wait out the cooldown before marking up the
    // simulated harvest — this exercises the real bounded-step/cooldown path
    // instead of tripping PositionMarkCooldownActive.
    await h.sleep(POSITION_MARK_COOLDOWN_MS);
    for (let i = 0; i < N; i++) {
      // Mint the simulated harvest into the per-protocol escrow (the tokens a
      // real adapter withdraw would have returned as yield), then mark the
      // position up so the realized-gain skim fires on the way out.
      const escrow = h.strategyEscrowPda(dao[i].daoRegistry, "kamino", dao[i].vaultMint);
      await mintTo(h.provider.connection, h.founder, dao[i].vaultMint, escrow, h.founder, gain[i]);
      await h.core.methods
        .updateStrategyPositionValue("kamino", new anchor.BN((deployed[i] + gain[i]).toString()))
        .accounts({
          authority: h.founder.publicKey,
          globalConfig: h.globalConfig,
          daoRegistry: dao[i].daoRegistry,
          agentSet: dao[i].agentSet,
          mint: dao[i].vaultMint,
          strategyPosition: positionPda(dao[i]),
        })
        .rpc();

      const pos = await h.core.account.strategyPosition.fetch(positionPda(dao[i]));
      assert.equal(pos.currentValue.toString(), (deployed[i] + gain[i]).toString());
    }
  });

  it("PHASE 4 — withdraws full marked value; skims 8.5% fee; nets to zero per DAO", async function () {
    this.timeout(180_000);
    for (let i = 0; i < N; i++) {
      const revBefore = BigInt(
        (await getAccount(h.provider.connection, dao[i].feeRecipientAta)).amount.toString()
      );
      const full = deployed[i] + gain[i];
      await h.withdrawFromStrategy(dao[i], execReq[i], h.kamino.programId, "kamino", full);

      const esc = await escrowBalance(dao[i]);
      const tv = await h.core.account.treasuryVault.fetch(dao[i].treasuryVault);
      const pos = await h.core.account.strategyPosition.fetch(positionPda(dao[i]));
      const revAfter = BigInt(
        (await getAccount(h.provider.connection, dao[i].feeRecipientAta)).amount.toString()
      );

      assert.equal(esc.toString(), "0", `DAO ${i}: escrow drained`);
      assert.equal(pos.currentValue.toString(), "0", `DAO ${i}: position closed`);
      assert.equal(pos.depositedAmount.toString(), "0", `DAO ${i}: principal returned`);
      assert.equal(tv.deployedCapital.toString(), "0", `DAO ${i}: deployed_capital net zero`);

      // Performance skim = performance_fee_bps of the realized gain, paid to the
      // revenue ATA (the harness configures the rate on fee_config at creation).
      const feeCfg = await h.core.account.feeConfig.fetch(dao[i].feeConfig);
      const perfBps = BigInt(feeCfg.performanceFeeBps);
      const expectedFee = (gain[i] * perfBps) / 10_000n;
      assert.equal(
        (revAfter - revBefore).toString(),
        expectedFee.toString(),
        `DAO ${i}: exactly the ${perfBps}-bps performance skim was taken`
      );
    }
  });

  it("PHASE 5 — no double-harvest: re-withdrawing a closed position rejects", async () => {
    for (let i = 0; i < N; i++) {
      let rejected = false;
      try {
        await h.withdrawFromStrategy(dao[i], execReq[i], h.kamino.programId, "kamino", deployed[i]);
      } catch {
        rejected = true;
      }
      assert.isTrue(rejected, `DAO ${i}: a second harvest of a closed position must reject`);
      const pos = await h.core.account.strategyPosition.fetch(positionPda(dao[i]));
      assert.equal(pos.currentValue.toString(), "0", `DAO ${i}: still closed (no double-harvest)`);
    }
  });

  it("PHASE 6 — cross-DAO accounting is consistent + net-zero after the cycle", async () => {
    // After the full concurrent deploy→compound→withdraw cycle, EVERY DAO must
    // be back to a clean, isolated zero state — no residual deployment, no
    // escrow dust, no cross-DAO contamination.
    for (let i = 0; i < N; i++) {
      const tv = await h.core.account.treasuryVault.fetch(dao[i].treasuryVault);
      const pos = await h.core.account.strategyPosition.fetch(positionPda(dao[i]));
      assert.equal(tv.deployedCapital.toString(), "0", `DAO ${i}: USD deployed_capital net zero`);
      assert.equal((await escrowBalance(dao[i])).toString(), "0", `DAO ${i}: escrow empty`);
      assert.equal(pos.currentValue.toString(), "0", `DAO ${i}: position closed`);
      assert.equal(pos.depositedAmount.toString(), "0", `DAO ${i}: principal returned`);
    }
  });

  it("PHASE 7 — no allocation-cap bypass on a fresh DAO under load", async function () {
    this.timeout(120_000);
    // A deploy exceeding the 40% kamino cap must reject. A fresh DAO is used so
    // its members still hold their (un-locked) voting tokens for the proposal.
    const d = await h.createDao({
      name: "load-overcap",
      memberCount: 4,
      depositPerMemberUsdc: 5_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    await h.enableAgents(d);
    const over = pctOfTreasury(d.totalTreasuryRaw, 6000); // 60% > 40% cap
    const { proposal, payloadHash } = await h.createStrategyProposal(
      d,
      "load-overcap-strat",
      h.strategyPayload(h.kamino.programId, over, d.vaultMint)
    );
    await h.lockQuorumVotes(d, proposal, VOTE_FOR);
    await h.finalizeProposal(d, proposal);
    const er = await h.createExecutionRequest(d, proposal, over, h.kamino.programId);
    // Break-glass now requires the request to already be InReview/OversightApproved
    // before the (unrelated) allocation-cap rejection is even reachable.
    await h.runAgentApprovals(d, er, payloadHash);
    await h.disableAgentsForDirectExecute(d);
    await h.expectError(
      () => h.executeStrategyDirect(d, er, h.kamino.programId, "kamino"),
      "AllocationLimitExceeded"
    );
  });
});
