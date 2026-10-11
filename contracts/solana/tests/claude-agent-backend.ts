import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  NaveTestHarness,
  VOTE_FOR,
  pctOfTreasury,
  makeReasoningHash,
  ZERO_HASH,
  AGENT_STATUS,
  GUARDIAN_CHANGE_ROTATE_KEY,
  GUARDIAN_CHANGE_SET_STATUS,
} from "./helpers/nave-harness";

describe("claude agent backend support", () => {
  let harness: NaveTestHarness;

  before(() => {
    harness = new NaveTestHarness();
  });

  function execBase(dao: any, executionRequest: PublicKey) {
    return {
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
      agentSet: dao.agentSet,
      executionRequest,
    };
  }

  async function setupExecRequest(name: string) {
    const dao = await harness.createDao({
      name,
      memberCount: 5,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    // Audit ABI: agents are created disabled; enable the pipeline so the
    // approval instructions reach their real authority/state checks.
    await harness.enableAgents(dao);

    const amount = pctOfTreasury(dao.totalTreasuryRaw, 1000);
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      name,
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

    return { dao, proposal, payloadHash, execReq };
  }

  it("defaults constitution confidence_threshold to 70 and supports governance updates", async () => {
    const dao = await harness.createDao({
      name: "confidence-cfg",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 2,
      guardianThreshold: 2,
    });

    let constitution = await harness.core.account.treasuryConstitution.fetch(
      dao.constitution
    );
    assert.equal(constitution.confidenceThreshold, 70);

    const protocols = [
      {
        protocolId: "kamino",
        programId: harness.kamino.programId,
        maxAllocationBps: 4000,
        approved: true,
      },
    ];

    await harness.core.methods
      .updateConstitution(protocols, 85, null)
      .accounts({
        authority: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        constitution: dao.constitution,
      })
      .rpc();

    constitution = await harness.core.account.treasuryConstitution.fetch(
      dao.constitution
    );
    assert.equal(constitution.confidenceThreshold, 85);

    // Omitting the threshold (null) leaves it unchanged.
    await harness.core.methods
      .updateConstitution(protocols, null, null)
      .accounts({
        authority: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        constitution: dao.constitution,
      })
      .rpc();
    constitution = await harness.core.account.treasuryConstitution.fetch(
      dao.constitution
    );
    assert.equal(constitution.confidenceThreshold, 85);

    await harness.expectError(
      () =>
        harness.core.methods
          .updateConstitution(protocols, 101, null)
          .accounts({
            authority: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            constitution: dao.constitution,
          })
          .rpc(),
      "InvalidConfidenceThreshold"
    );
  });

  it("enforces non-zero reasoning hashes through the full agent pipeline", async () => {
    const { dao, execReq, payloadHash } = await setupExecRequest("reason-pipeline");
    const hashArray = Array.from(payloadHash);

    // Executive: zero hash rejected, valid hash stored.
    await harness.expectError(
      () =>
        harness.execution.methods
          .executiveApprove(ZERO_HASH)
          .accounts({ authority: dao.agents[0].publicKey, ...execBase(dao, execReq) })
          .signers([dao.agents[0]])
          .rpc(),
      "ReasoningHashRequired"
    );

    const execHash = makeReasoningHash("executive-reasoning");
    await harness.execution.methods
      .executiveApprove(execHash)
      .accounts({ authority: dao.agents[0].publicKey, ...execBase(dao, execReq) })
      .signers([dao.agents[0]])
      .rpc();

    // Financial: zero hash rejected, valid hash stored.
    await harness.expectError(
      () =>
        harness.execution.methods
          .financialApprove(hashArray, ZERO_HASH)
          .accounts({ authority: dao.agents[1].publicKey, ...execBase(dao, execReq) })
          .signers([dao.agents[1]])
          .rpc(),
      "ReasoningHashRequired"
    );

    const finHash = makeReasoningHash("financial-reasoning");
    await harness.execution.methods
      .financialApprove(hashArray, finHash)
      .accounts({ authority: dao.agents[1].publicKey, ...execBase(dao, execReq) })
      .signers([dao.agents[1]])
      .rpc();

    // Oversight: zero hash rejected, valid hash stored (moves to InReview).
    await harness.expectError(
      () =>
        harness.execution.methods
          .oversightApprove(hashArray, ZERO_HASH)
          .accounts({ authority: dao.agents[2].publicKey, ...execBase(dao, execReq) })
          .signers([dao.agents[2]])
          .rpc(),
      "ReasoningHashRequired"
    );

    const oversightHash = makeReasoningHash("oversight-reasoning");
    await harness.execution.methods
      .oversightApprove(hashArray, oversightHash)
      .accounts({ authority: dao.agents[2].publicKey, ...execBase(dao, execReq) })
      .signers([dao.agents[2]])
      .rpc();

    let req = await harness.execution.account.executionRequest.fetch(execReq);
    assert.deepEqual(Array.from(req.executiveReasoningHash), execHash);
    assert.deepEqual(Array.from(req.financialReasoningHash), finHash);
    assert.deepEqual(Array.from(req.oversightReasoningHash), oversightHash);
    assert.equal(req.status, 4); // InReview

    // Operational halt: zero reason hash rejected, valid hash stored.
    await harness.expectError(
      () =>
        harness.execution.methods
          .operationalHalt(ZERO_HASH)
          .accounts({
            authority: dao.agents[3].publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            executionRequest: execReq,
          })
          .signers([dao.agents[3]])
          .rpc(),
      "ReasoningHashRequired"
    );

    const haltHash = makeReasoningHash("operational-halt-reason");
    await harness.execution.methods
      .operationalHalt(haltHash)
      .accounts({
        authority: dao.agents[3].publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        executionRequest: execReq,
      })
      .signers([dao.agents[3]])
      .rpc();

    req = await harness.execution.account.executionRequest.fetch(execReq);
    assert.equal(req.status, 6); // Halted
    assert.deepEqual(Array.from(req.operationalHaltReasonHash), haltHash);
  });

  it("rejects approval when signer does not match the agent slot", async () => {
    const { dao, execReq } = await setupExecRequest("signer-mismatch");

    // Financial agent (slot 1) attempting the executive approval.
    await harness.expectError(
      () =>
        harness.execution.methods
          .executiveApprove(makeReasoningHash("spoof"))
          .accounts({ authority: dao.agents[1].publicKey, ...execBase(dao, execReq) })
          .signers([dao.agents[1]])
          .rpc(),
      "Unauthorized"
    );
  });

  it("update_agent_status validates slot and status ranges", async () => {
    const dao = await harness.createDao({
      name: "status-validate",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });

    await harness.expectError(
      () =>
        harness.guardianUpdateAgentStatus(dao, 9, AGENT_STATUS.Paused, 1, [
          dao.guardians[0],
        ]),
      "InvalidAgentSlot"
    );

    await harness.expectError(
      () =>
        harness.guardianUpdateAgentStatus(dao, 0, 9, 2, [dao.guardians[0]]),
      "InvalidAgentStatus"
    );
  });

  it("guardian multisig pauses an agent and blocks its approval on-chain", async () => {
    const { dao, execReq } = await setupExecRequest("status-pause");

    // Two guardians (threshold 2) pause the Executive agent (slot 0).
    await harness.guardianUpdateAgentStatus(dao, 0, AGENT_STATUS.Paused, 1, [
      dao.guardians[0],
      dao.guardians[1],
    ]);

    const agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
    assert.equal(agentSet.agents[0].status, AGENT_STATUS.Paused);

    // Paused executive can no longer approve.
    await harness.expectError(
      () =>
        harness.execution.methods
          .executiveApprove(makeReasoningHash("after-pause"))
          .accounts({ authority: dao.agents[0].publicKey, ...execBase(dao, execReq) })
          .signers([dao.agents[0]])
          .rpc(),
      "Unauthorized"
    );

    // Guardian re-activation is queued for 24h (founder can veto), so the
    // agent stays paused and still cannot approve.
    await harness.guardianUpdateAgentStatus(dao, 0, AGENT_STATUS.Active, 2, [
      dao.guardians[0],
      dao.guardians[1],
    ]);
    const queued = await harness.core.account.agentSet.fetch(dao.agentSet);
    assert.equal(queued.agents[0].status, AGENT_STATUS.Paused);
    const control = await harness.fetchDaoControl(dao);
    assert.equal(control.pendingAgentChanges[0].kind, GUARDIAN_CHANGE_SET_STATUS);
    assert.equal(control.pendingAgentChanges[0].newStatus, AGENT_STATUS.Active);
    await harness.expectError(
      () =>
        harness.core.methods
          .applyGuardianAgentChange(0)
          .accountsPartial({
            authority: dao.members[0].publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            agentSet: dao.agentSet,
            guardianConfig: dao.guardianConfig,
          })
          .signers([dao.members[0]])
          .rpc(),
      "GuardianChangeNotReady"
    );

    const req = await harness.execution.account.executionRequest.fetch(execReq);
    assert.equal(req.status, 0); // still Pending
  });

  it("does not reach quorum with a single guardian signature", async () => {
    const dao = await harness.createDao({
      name: "status-quorum",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });

    // Only one of the required two guardians signs.
    await harness.guardianUpdateAgentStatus(dao, 1, AGENT_STATUS.Paused, 1, [
      dao.guardians[0],
    ]);

    const agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
    // Threshold not reached, so status remains Active.
    assert.equal(agentSet.agents[1].status, AGENT_STATUS.Active);
  });

  it("rotate_agent_key queues the swap for 24h and the founder can veto it", async () => {
    const dao = await harness.createDao({
      name: "key-rotation",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });

    const newKey = Keypair.generate();

    await harness.guardianRotateAgentKey(dao, 1, newKey.publicKey, 1, [
      dao.guardians[0],
      dao.guardians[1],
    ]);

    const agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
    assert.equal(
      agentSet.agents[1].authority.toBase58(),
      dao.agents[1].publicKey.toBase58(),
      "key is unchanged until the 24h delay elapses"
    );
    let control = await harness.fetchDaoControl(dao);
    assert.equal(control.pendingAgentChanges[1].kind, GUARDIAN_CHANGE_ROTATE_KEY);
    assert.equal(control.pendingAgentChanges[1].newAuthority.toBase58(), newKey.publicKey.toBase58());

    await harness.core.methods
      .cancelGuardianAgentChange(1)
      .accountsPartial({
        authority: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
      })
      .rpc();
    control = await harness.fetchDaoControl(dao);
    assert.equal(control.pendingAgentChanges[1].kind, 0);
  });

  it("rotate_agent_key rejects an invalid slot", async () => {
    const dao = await harness.createDao({
      name: "rotation-invalid",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });

    const newKey = Keypair.generate();
    await harness.expectError(
      () =>
        harness.guardianRotateAgentKey(dao, 9, newKey.publicKey, 1, [
          dao.guardians[0],
        ]),
      "InvalidAgentSlot"
    );
  });
});
