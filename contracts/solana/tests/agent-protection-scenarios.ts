import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { createHash } from "crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  NaveTestHarness,
  VOTE_FOR,
  VOTE_AGAINST,
  pctOfTreasury,
  makeReasoningHash,
} from "./helpers/nave-harness";

describe("agent pipeline protections", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  async function setupPassedProposal() {
    const dao = await harness.createDao({
      name: "agent-test",
      memberCount: 5,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    // Audit ABI: agents are created disabled; enable the pipeline so the
    // approval/halt instructions reach their real state checks.
    await harness.enableAgents(dao);

    const amount = pctOfTreasury(dao.totalTreasuryRaw, 2000);
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      "Agent pipeline",
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

    return { dao, proposal, payloadHash, execReq, amount };
  }

  it("rejects financial approve before executive approve", async () => {
    const { dao, execReq, payloadHash } = await setupPassedProposal();
    const hashArray = Array.from(payloadHash);
    const base = {
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
      agentSet: dao.agentSet,
      executionRequest: execReq,
    };

    await harness.expectError(
      () =>
        harness.execution.methods
          .financialApprove(hashArray, makeReasoningHash("financial"))
          .accounts({ authority: dao.agents[1].publicKey, ...base })
          .signers([dao.agents[1]])
          .rpc(),
      "InvalidStateTransition"
    );
  });

  it("rejects oversight approve when payload hash mismatches financial", async () => {
    const { dao, execReq, payloadHash } = await setupPassedProposal();
    const base = {
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
      agentSet: dao.agentSet,
      executionRequest: execReq,
    };

    await harness.execution.methods
      .executiveApprove(makeReasoningHash("executive"))
      .accounts({ authority: dao.agents[0].publicKey, ...base })
      .signers([dao.agents[0]])
      .rpc();

    await harness.execution.methods
      .financialApprove(Array.from(payloadHash), makeReasoningHash("financial"))
      .accounts({ authority: dao.agents[1].publicKey, ...base })
      .signers([dao.agents[1]])
      .rpc();

    const wrongHash = createHash("sha256").update(Buffer.from("malicious")).digest();
    await harness.expectError(
      () =>
        harness.execution.methods
          .oversightApprove(Array.from(wrongHash), makeReasoningHash("oversight"))
          .accounts({ authority: dao.agents[2].publicKey, ...base })
          .signers([dao.agents[2]])
          .rpc(),
      "PayloadHashMismatch"
    );
  });

  it("rejects operational halt before oversight review window", async () => {
    const { dao, execReq, payloadHash } = await setupPassedProposal();
    const base = {
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
      agentSet: dao.agentSet,
      executionRequest: execReq,
    };

    await harness.execution.methods
      .executiveApprove(makeReasoningHash("executive"))
      .accounts({ authority: dao.agents[0].publicKey, ...base })
      .signers([dao.agents[0]])
      .rpc();

    await harness.expectError(
      () => harness.operationalHalt(dao, execReq),
      "InvalidStateTransition"
    );

    await harness.completeAgentApprovals(dao, execReq, payloadHash);
    await harness.operationalHalt(dao, execReq);

    const req = await harness.execution.account.executionRequest.fetch(execReq);
    assert.equal(req.status, 6); // Halted
  });

  it("operational clear resumes halted execution request", async () => {
    const { dao, execReq, payloadHash } = await setupPassedProposal();
    await harness.runAgentApprovals(dao, execReq, payloadHash);
    await harness.operationalHalt(dao, execReq);
    await harness.operationalClear(dao, execReq);

    const req = await harness.execution.account.executionRequest.fetch(execReq);
    assert.equal(req.status, 4); // InReview
  });

  it("rejects execute_strategy while 24h review window active", async () => {
    const { dao, execReq, payloadHash } = await setupPassedProposal();
    await harness.runAgentApprovals(dao, execReq, payloadHash);

    // Audit ABI: execute_strategy's account graph changed (per-asset vault, mint
    // binding, NAV priceUpdate). Use the harness helper, which builds the
    // current account set; executing inside the review window must reject.
    await harness.expectError(
      () => harness.executeStrategy(dao, execReq, harness.kamino.programId, "kamino"),
      "ReviewWindowActive"
    );
  });

  it("rejects executive-only execute when agents enabled and DAO not frozen", async () => {
    const { dao, execReq, payloadHash } = await setupPassedProposal();
    await harness.runAgentApprovals(dao, execReq, payloadHash);

    await harness.expectError(
      () =>
        harness.executeStrategyDirect(
          dao,
          execReq,
          harness.kamino.programId,
          "kamino"
        ),
      "DirectExecutionNotAllowed"
    );
  });
});

describe("rogue agent scenarios", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  it("guardian M-of-N nullify freezes DAO and blocks further agent approvals", async () => {
    const dao = await harness.createDao({
      name: "rogue-exec",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 2,
      guardianThreshold: 2,
    });

    await harness.enableAgents(dao); // agents created disabled; enable pipeline
    const freezeAmt = pctOfTreasury(dao.totalTreasuryRaw, 1000);
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      "Freeze test",
      harness.strategyPayload(harness.kamino.programId, freezeAmt, dao.vaultMint)
    );
    await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await harness.finalizeProposal(dao, proposal);

    const execReq = await harness.createExecutionRequest(
      dao,
      proposal,
      freezeAmt,
      harness.kamino.programId
    );

    await harness.execution.methods
      .executiveApprove(makeReasoningHash("executive"))
      .accounts({
        authority: dao.agents[0].publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        executionRequest: execReq,
      })
      .signers([dao.agents[0]])
      .rpc();

    // SOL-H2: nullify_agent is now a guardian M-of-N action (was a single
    // Executive key). Both guardians (threshold 2) sign to nullify Financial.
    await harness.guardianNullifyAgent(dao, 1, 1, dao.guardians.slice(0, 2));

    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    assert.isTrue(registry.frozen);

    await harness.expectError(
      () =>
        harness.execution.methods
          .financialApprove(Array.from(payloadHash), makeReasoningHash("financial"))
          .accounts({
            authority: dao.agents[1].publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            executionRequest: execReq,
          })
          .signers([dao.agents[1]])
          .rpc(),
      "DaoFrozen"
    );
  });

  it("rogue operational cannot halt before review — only griefs during review", async () => {
    const dao = await harness.createDao({
      name: "rogue-ops",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 2,
      guardianThreshold: 2,
    });

    await harness.enableAgents(dao); // agents created disabled; enable pipeline
    const opsAmt = pctOfTreasury(dao.totalTreasuryRaw, 1000);
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      "Ops grief",
      harness.strategyPayload(harness.kamino.programId, opsAmt, dao.vaultMint)
    );
    await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await harness.finalizeProposal(dao, proposal);

    const execReq = await harness.createExecutionRequest(
      dao,
      proposal,
      opsAmt,
      harness.kamino.programId
    );

    await harness.expectError(
      () => harness.operationalHalt(dao, execReq),
      "InvalidStateTransition"
    );

    await harness.runAgentApprovals(dao, execReq, payloadHash);
    await harness.operationalHalt(dao, execReq);
    const halted = await harness.execution.account.executionRequest.fetch(execReq);
    assert.equal(halted.status, 6);
  });

  it("non-agent cannot approve execution request", async () => {
    const dao = await harness.createDao({
      name: "impersonator",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 2,
      guardianThreshold: 2,
    });

    await harness.enableAgents(dao); // agents created disabled; enable pipeline
    const impAmt = pctOfTreasury(dao.totalTreasuryRaw, 1000);
    const { proposal } = await harness.createStrategyProposal(
      dao,
      "Impersonate",
      harness.strategyPayload(harness.kamino.programId, impAmt, dao.vaultMint)
    );
    await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await harness.finalizeProposal(dao, proposal);

    const execReq = await harness.createExecutionRequest(
      dao,
      proposal,
      impAmt,
      harness.kamino.programId
    );

    const impostor = dao.members[1];
    await harness.expectError(
      () =>
        harness.execution.methods
          .executiveApprove(makeReasoningHash("executive"))
          .accounts({
            authority: impostor.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            executionRequest: execReq,
          })
          .signers([impostor])
          .rpc(),
      "Unauthorized"
    );
  });
});
