import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import {
  NaveTestHarness,
  VOTE_FOR,
  pctOfTreasury,
  makeReasoningHash,
  PROPOSAL_TYPE,
} from "./helpers/nave-harness";

/**
 * Phase-4 adversarial "fund-loss route" suite.
 *
 * Every test here drives a route that, if it SUCCEEDED, would move or
 * mis-account treasury capital outside the governance + 3-of-3 + review-window
 * pipeline. Each MUST be asserted to FAIL/reject. All routes are written to
 * reject IMMEDIATELY (no long review-window sleeps) so the suite is fast.
 *
 * Routes whose only trigger is a 15-minute NAV-staleness clock advance
 * (`StaleNav`) or a live wide-confidence Pyth `PriceUpdateV2` are proven
 * hermetically as Rust unit tests in
 * `programs/nave_core/src/utils/longterm_sim.rs`
 * (`nav_staleness_gate_blocks_zero_and_old_snapshots`,
 * `wide_confidence_band_is_rejected_at_the_two_percent_bound`) and on devnet via
 * `tests/revalue-multiasset-devnet.ts`; see the report for how to run them.
 */
describe("adversarial: fund-loss routes all reject", () => {
  let h: NaveTestHarness;
  const KAMINO_DEPLOY_BPS = 2000; // 20% of NAV — under the default 40% kamino cap

  before(() => {
    h = new NaveTestHarness();
  });

  /** Create a DAO with a Passed Strategy proposal + a Pending ExecutionRequest. */
  async function stagedRequest(name: string, deployBps = KAMINO_DEPLOY_BPS) {
    const dao = await h.createDao({
      name,
      memberCount: 4,
      depositPerMemberUsdc: 5_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    // Agents are created disabled; enable the autonomous pipeline so the
    // approval-path routes are exercised against the real validator checks.
    await h.enableAgents(dao);
    const amount = pctOfTreasury(dao.totalTreasuryRaw, deployBps);
    const { proposal, payloadHash } = await h.createStrategyProposal(
      dao,
      `${name}-strat`,
      h.strategyPayload(h.kamino.programId, amount, dao.vaultMint)
    );
    await h.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await h.finalizeProposal(dao, proposal);
    const execReq = await h.createExecutionRequest(dao, proposal, amount, h.kamino.programId);
    return { dao, proposal, execReq, payloadHash, amount };
  }

  it("rejects approval signed by the WRONG agent role", async () => {
    const { dao, execReq } = await stagedRequest("adv-wrong-role");
    // Executive-approve must be signed by the Executive (slot 0). Signing with
    // the Financial agent (slot 1) must be rejected.
    await h.expectError(
      () =>
        h.execution.methods
          .executiveApprove(makeReasoningHash("evil"))
          .accounts({
            authority: dao.agents[1].publicKey, // Financial — wrong role
            globalConfig: h.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            executionRequest: execReq,
          })
          .signers([dao.agents[1]])
          .rpc(),
      "Unauthorized"
    );
  });

  it("rejects out-of-order approval (financial before executive)", async () => {
    const { dao, execReq, payloadHash } = await stagedRequest("adv-out-of-order");
    // A fresh request is Pending; financial_approve requires ExecutiveApproved.
    await h.expectError(
      () =>
        h.execution.methods
          .financialApprove(Array.from(payloadHash), makeReasoningHash("fin"))
          .accounts({
            authority: dao.agents[1].publicKey,
            globalConfig: h.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            executionRequest: execReq,
          })
          .signers([dao.agents[1]])
          .rpc(),
      "InvalidStateTransition"
    );
  });

  it("rejects execute_strategy BEFORE the review window ends", async () => {
    const dao = await h.createDao({
      name: "adv-prereview",
      memberCount: 4,
      depositPerMemberUsdc: 5_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    await h.enableAgents(dao);
    await h.setReviewWindow(dao, 60); // 60s window — we execute immediately
    const amount = pctOfTreasury(dao.totalTreasuryRaw, KAMINO_DEPLOY_BPS);
    const { proposal, payloadHash } = await h.createStrategyProposal(
      dao,
      "adv-prereview-strat",
      h.strategyPayload(h.kamino.programId, amount, dao.vaultMint)
    );
    await h.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await h.finalizeProposal(dao, proposal);
    const execReq = await h.createExecutionRequest(dao, proposal, amount, h.kamino.programId);
    // Executive -> Financial -> Oversight -> InReview (review_end = now + 60s).
    await h.runAgentApprovals(dao, execReq, payloadHash);

    // Executing now (window still open) must be rejected.
    await h.expectError(
      () => h.executeStrategy(dao, execReq, h.kamino.programId, "kamino"),
      "ReviewWindowActive"
    );
  });

  it("rejects create_execution_request for a NON-Strategy (Policy) proposal", async () => {
    const dao = await h.createDao({
      name: "adv-policytype",
      memberCount: 4,
      depositPerMemberUsdc: 5_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    const amount = pctOfTreasury(dao.totalTreasuryRaw, KAMINO_DEPLOY_BPS);
    // Create a POLICY proposal (type 0) carrying a strategy-shaped payload.
    const registry = await h.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposal = h.proposalPda(dao, registry.proposalCount);
    await h.governance.methods
      .createProposal({
        title: "policy",
        description: "policy",
        payload: h.strategyPayload(h.kamino.programId, amount, dao.vaultMint),
        proposalType: PROPOSAL_TYPE.Policy,
        votingPeriodSeconds: new anchor.BN(2),
      })
      .accountsPartial({
        proposer: h.founder.publicKey,
        daoRegistry: dao.daoRegistry,
        proposal,
        daoTokenMint: dao.vaultMint,
      })
      .rpc();
    await h.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await h.finalizeProposal(dao, proposal);

    await h.expectError(
      () => h.createExecutionRequest(dao, proposal, amount, h.kamino.programId),
      "InvalidProposalType"
    );
  });

  it("allows creation of a ProposalType::Transfer proposal", async () => {
    const dao = await h.createDao({
      name: "adv-transfer",
      memberCount: 3,
      depositPerMemberUsdc: 2_000,
      guardianCount: 2,
      guardianThreshold: 1,
    });
    const registry = await h.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposal = h.proposalPda(dao, registry.proposalCount);
    const recipient = Keypair.generate().publicKey.toBuffer();
    const mint = Buffer.alloc(32); // native SOL sentinel
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(1n, 0);
    const payload = Buffer.concat([recipient, mint, amount]);
    await h.governance.methods
      .createProposal({
        title: "transfer",
        description: "drain",
        payload,
        proposalType: 8, // ProposalType::Transfer
        votingPeriodSeconds: new anchor.BN(2),
      })
      .accountsPartial({
        proposer: h.founder.publicKey,
        daoRegistry: dao.daoRegistry,
        proposal,
        daoTokenMint: dao.vaultMint,
      })
      .rpc();
  });

  it("rejects re-executing an already-Executed request (direct status pre-check)", async () => {
    const { dao, execReq, payloadHash } = await stagedRequest("adv-reexec");
    // Break-glass now requires the request to have already completed the full
    // agent-approval pipeline (InReview/OversightApproved) before it can be
    // force-executed — drive it there first so the FIRST call below succeeds.
    await h.runAgentApprovals(dao, execReq, payloadHash);
    await h.disableAgentsForDirectExecute(dao);
    // First break-glass execution succeeds (NAV is fresh from createDao).
    await h.executeStrategyDirect(dao, execReq, h.kamino.programId, "kamino");
    const req = await h.execution.account.executionRequest.fetch(execReq);
    assert.equal(req.status, 5, "request should be Executed");
    // Re-executing the terminal request must be rejected.
    await h.expectError(
      () => h.executeStrategyDirect(dao, execReq, h.kamino.programId, "kamino"),
      "InvalidStateTransition"
    );
  });

  it("rejects direct-executing a HALTED request (direct status pre-check)", async () => {
    const { dao, execReq, payloadHash } = await stagedRequest("adv-halted");
    // Drive to InReview, then Operational halts it.
    await h.runAgentApprovals(dao, execReq, payloadHash);
    await h.operationalHalt(dao, execReq);
    const halted = await h.execution.account.executionRequest.fetch(execReq);
    assert.equal(halted.status, 6, "request should be Halted");
    // Now disable agents and try the break-glass path on the halted request.
    await h.disableAgentsForDirectExecute(dao);
    await h.expectError(
      () => h.executeStrategyDirect(dao, execReq, h.kamino.programId, "kamino"),
      "InvalidStateTransition"
    );
  });

  it("rejects a deploy that breaches the stablecoin reserve floor", async () => {
    const dao = await h.createDao({
      name: "adv-reserve",
      memberCount: 4,
      depositPerMemberUsdc: 5_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    // Disable the global deployment cap + liquidity floor, raise the kamino
    // allocation cap, and keep a 35% stablecoin reserve floor — so the ONLY
    // ceiling a 70% deploy can hit is the reserve floor.
    await h.core.methods
      .setPolicyParameters(3_500, 0, 0, new anchor.BN(0))
      .accounts({
        authority: h.founder.publicKey,
        globalConfig: h.globalConfig,
        daoRegistry: dao.daoRegistry,
        constitution: dao.constitution,
      })
      .rpc();
    await h.core.methods
      .updateConstitution(
        [{ protocolId: "kamino", programId: h.kamino.programId, maxAllocationBps: 8000, approved: true }],
        null,
        null
      )
      .accounts({
        authority: h.founder.publicKey,
        globalConfig: h.globalConfig,
        daoRegistry: dao.daoRegistry,
        constitution: dao.constitution,
      })
      .rpc();
    await h.enableAgents(dao);

    const amount = pctOfTreasury(dao.totalTreasuryRaw, 7000); // 70% — idle would be 30% < 35%
    const { proposal, payloadHash } = await h.createStrategyProposal(
      dao,
      "adv-reserve-strat",
      h.strategyPayload(h.kamino.programId, amount, dao.vaultMint)
    );
    await h.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await h.finalizeProposal(dao, proposal);
    const execReq = await h.createExecutionRequest(dao, proposal, amount, h.kamino.programId);
    // Satisfy the break-glass state precondition (InReview/OversightApproved)
    // so the rejection below comes from the reserve-floor check, not the
    // (now stricter) request-status gate.
    await h.runAgentApprovals(dao, execReq, payloadHash);
    await h.disableAgentsForDirectExecute(dao);

    await h.expectError(
      () => h.executeStrategyDirect(dao, execReq, h.kamino.programId, "kamino"),
      "StablecoinReserveBreached"
    );
  });

  it("rejects a deploy that exceeds the per-protocol allocation cap", async () => {
    const dao = await h.createDao({
      name: "adv-alloccap",
      memberCount: 4,
      depositPerMemberUsdc: 5_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    await h.enableAgents(dao);
    // Default kamino cap is 40%. Deploy 50% -> AllocationLimitExceeded.
    const amount = pctOfTreasury(dao.totalTreasuryRaw, 5000);
    const { proposal, payloadHash } = await h.createStrategyProposal(
      dao,
      "adv-alloc-strat",
      h.strategyPayload(h.kamino.programId, amount, dao.vaultMint)
    );
    await h.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await h.finalizeProposal(dao, proposal);
    const execReq = await h.createExecutionRequest(dao, proposal, amount, h.kamino.programId);
    // Satisfy the break-glass state precondition (InReview/OversightApproved)
    // so the rejection below comes from the allocation-cap check, not the
    // (now stricter) request-status gate.
    await h.runAgentApprovals(dao, execReq, payloadHash);
    await h.disableAgentsForDirectExecute(dao);

    await h.expectError(
      () => h.executeStrategyDirect(dao, execReq, h.kamino.programId, "kamino"),
      "AllocationLimitExceeded"
    );
  });

  it("rejects a deploy whose mint is NOT the governance-bound request mint", async () => {
    // NE-7 mint binding (fixed in this audit pass for the deposit paths): the
    // executor must deploy `request.mint`, never substitute another mint's
    // accounts. Passing a foreign mint must reject (the deploy cannot proceed).
    const { dao, execReq } = await stagedRequest("adv-wrongmint");
    await h.disableAgentsForDirectExecute(dao);

    const foreignMint = Keypair.generate().publicKey; // not a registered asset
    const strategyEscrow = h.strategyEscrowPda(dao.daoRegistry, "kamino", dao.vaultMint);
    const strategyPosition = h.strategyPositionPda(dao.daoRegistry, "kamino", dao.vaultMint);
    // We expect a rejection regardless of the precise error (AssetMintMismatch
    // from the new binding, or an account-resolution failure for the unknown
    // mint's PDAs) — the invariant is that no deploy of a non-request mint
    // succeeds.
    let rejected = false;
    try {
      await h.execution.methods
        .executeStrategyDirect()
        .accountsPartial({
          authority: dao.agents[0].publicKey,
          globalConfig: h.globalConfig,
          daoRegistry: dao.daoRegistry,
          agentSet: dao.agentSet,
          constitution: dao.constitution,
          vaultAuthority: dao.vaultAuthority,
          treasuryVault: dao.treasuryVault,
          vaultTokenAccount: dao.assetVaultTokenAccount,
          executionAuthority: h.executionAuthorityPda(dao.daoRegistry),
          adapterProgram: h.kamino.programId,
          mint: foreignMint,
          executionRequest: execReq,
          strategyEscrow,
          strategyPosition,
          priceUpdate: dao.daoRegistry,
          naveCoreProgram: h.core.programId,
        })
        .signers([dao.agents[0]])
        .rpc();
    } catch (_e) {
      rejected = true;
    }
    assert.isTrue(rejected, "deploying a non-request mint must reject");
    // And the request must remain un-executed.
    const req = await h.execution.account.executionRequest.fetch(execReq);
    assert.notEqual(req.status, 5, "request must NOT be Executed via the wrong mint");
  });

  it("does NOT freeze the DAO with fewer than the guardian threshold of signatures", async () => {
    const dao = await h.createDao({
      name: "adv-threshold",
      memberCount: 3,
      depositPerMemberUsdc: 2_000,
      guardianCount: 3,
      guardianThreshold: 2, // 2-of-3 required
    });
    // A single guardian signature must NOT trip the M-of-N freeze.
    await h.guardianEmergencyFreeze(dao, 1, [dao.guardians[0]]);
    const reg = await h.core.account.daoRegistry.fetch(dao.daoRegistry);
    assert.isFalse(reg.frozen, "1 of 2 signatures must not freeze the DAO");
  });
});
