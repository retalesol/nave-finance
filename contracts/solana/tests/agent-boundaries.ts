import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { getAccount, mintTo } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  NaveTestHarness,
  InitializedDao,
  VOTE_FOR,
  pctOfTreasury,
  makeReasoningHash,
  GUARDIAN_ACTION_DISABLE_AGENTS,
  GUARDIAN_CHANGE_ROTATE_KEY,
} from "./helpers/nave-harness";

/**
 * Role boundaries: each agent can do its own job and nothing else, a single
 * actor cannot open the break-glass path, guardian changes to agents wait out
 * a founder-vetoable delay, and position marks come from on-chain balances.
 */
describe("agent role boundaries", () => {
  let h: NaveTestHarness;
  const ZERO = Array(32).fill(0);

  before(() => {
    h = new NaveTestHarness();
  });

  async function newDao(name: string, reviewWindowSecs: number | null = 60): Promise<InitializedDao> {
    const dao = await h.createDao({
      name,
      memberCount: 4,
      depositPerMemberUsdc: 5_000,
      guardianCount: 3,
      guardianThreshold: 2,
      reviewWindowSecs,
    });
    await h.enableAgents(dao);
    return dao;
  }

  async function approvedRequest(dao: InitializedDao, label: string) {
    const amount = pctOfTreasury(dao.totalTreasuryRaw, 1000);
    const { proposal, payloadHash } = await h.createStrategyProposal(
      dao,
      label,
      h.strategyPayload(h.kamino.programId, amount, dao.vaultMint)
    );
    await h.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await h.finalizeProposal(dao, proposal);
    const execReq = await h.createExecutionRequest(dao, proposal, amount, h.kamino.programId);
    return { proposal, payloadHash, execReq, amount };
  }

  function approvalBase(dao: InitializedDao, executionRequest: PublicKey) {
    return {
      globalConfig: h.globalConfig,
      daoRegistry: dao.daoRegistry,
      agentSet: dao.agentSet,
      executionRequest,
    };
  }

  async function guardianDisable(dao: InitializedDao, nonce: number) {
    const guardianAction = h.guardianActionPda(dao, GUARDIAN_ACTION_DISABLE_AGENTS, [], nonce);
    for (const guardian of dao.guardians.slice(0, 2)) {
      await h.core.methods
        .guardianDisableAgents(new anchor.BN(nonce))
        .accountsPartial({
          guardian: guardian.publicKey,
          globalConfig: h.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
          guardianAction,
          agentSet: dao.agentSet,
        })
        .signers([guardian])
        .rpc();
    }
  }

  function executiveToggle(dao: InitializedDao, enabled: boolean) {
    return h.core.methods
      .toggleAgents(enabled)
      .accountsPartial({
        authority: dao.agents[0].publicKey,
        globalConfig: h.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
      })
      .signers([dao.agents[0]])
      .rpc();
  }

  it("Executive cannot re-enable agents after a guardian-quorum disable", async () => {
    const dao = await newDao("bnd-lock");
    await guardianDisable(dao, 11);
    const control = await h.fetchDaoControl(dao);
    assert.isTrue(control.guardianLocked, "guardian disable sets the lock");

    await h.expectError(() => executiveToggle(dao, true), "AgentsLockedByGuardians");

    await h.guardianEnableAgents(dao, 12);
    const agentSet = await h.core.account.agentSet.fetch(dao.agentSet);
    assert.isTrue(agentSet.agentsEnabled);
    assert.isFalse((await h.fetchDaoControl(dao)).guardianLocked);
  });

  it("a single-actor pause does not open the Executive break-glass path", async () => {
    const dao = await newDao("bnd-pause");
    const { execReq, payloadHash } = await approvedRequest(dao, "bnd-pause-strat");
    await h.runAgentApprovals(dao, execReq, payloadHash);

    await h.core.methods
      .emergencyPauseAgents()
      .accountsPartial({
        authority: h.founder.publicKey,
        globalConfig: h.globalConfig,
        daoRegistry: dao.daoRegistry,
        guardianConfig: dao.guardianConfig,
        agentSet: dao.agentSet,
      })
      .rpc();

    await h.expectError(
      () => h.executeStrategyDirect(dao, execReq, h.kamino.programId, "kamino"),
      "DirectExecutionNotAllowed"
    );
  });

  it("break-glass never skips the review window", async () => {
    const dao = await newDao("bnd-review", 3600);
    const { execReq, payloadHash } = await approvedRequest(dao, "bnd-review-strat");
    await h.runAgentApprovals(dao, execReq, payloadHash);
    await guardianDisable(dao, 21);

    // Submit directly (the harness helper would wait for review_end).
    await h.initStrategyPosition(dao, h.kamino.programId, "kamino");
    const strategyEscrow = await h.initStrategyEscrow(dao, "kamino");
    await h.expectError(
      () =>
        h.execution.methods
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
            mint: dao.vaultMint,
            executionRequest: execReq,
            strategyEscrow,
            strategyPosition: h.strategyPositionPda(dao.daoRegistry, "kamino", dao.vaultMint),
            priceUpdate: dao.daoRegistry,
          })
          .signers([dao.agents[0]])
          .rpc(),
      "ReviewWindowActive"
    );
  });

  it("permissionless execute_strategy is blocked while agents are disabled", async () => {
    const dao = await newDao("bnd-exec");
    const { execReq, payloadHash } = await approvedRequest(dao, "bnd-exec-strat");
    await h.runAgentApprovals(dao, execReq, payloadHash);
    await h.waitForReviewEnd(execReq);
    await guardianDisable(dao, 31);

    await h.expectError(
      () => h.executeStrategy(dao, execReq, h.kamino.programId, "kamino"),
      "AgentsDisabled"
    );
  });

  it("Operational cannot clear a halt without a reason, and Oversight needs a payload hash", async () => {
    const dao = await newDao("bnd-clear");
    const { execReq, payloadHash } = await approvedRequest(dao, "bnd-clear-strat");
    const base = approvalBase(dao, execReq);

    await h.execution.methods
      .executiveApprove(makeReasoningHash("executive"))
      .accountsPartial({ authority: dao.agents[0].publicKey, ...base })
      .signers([dao.agents[0]])
      .rpc();
    await h.execution.methods
      .financialApprove(Array.from(payloadHash), makeReasoningHash("financial"))
      .accountsPartial({ authority: dao.agents[1].publicKey, ...base })
      .signers([dao.agents[1]])
      .rpc();
    await h.expectError(
      () =>
        h.execution.methods
          .oversightApprove(ZERO, makeReasoningHash("oversight"))
          .accountsPartial({ authority: dao.agents[2].publicKey, ...base })
          .signers([dao.agents[2]])
          .rpc(),
      "PayloadHashMismatch"
    );
    await h.execution.methods
      .oversightApprove(Array.from(payloadHash), makeReasoningHash("oversight"))
      .accountsPartial({ authority: dao.agents[2].publicKey, ...base })
      .signers([dao.agents[2]])
      .rpc();

    await h.operationalHalt(dao, execReq);
    await h.expectError(() => h.operationalClear(dao, execReq, ZERO), "ReasoningHashRequired");
    await h.operationalClear(dao, execReq);
    const req = await h.execution.account.executionRequest.fetch(execReq);
    assert.equal(req.status, 4, "cleared back to InReview");
  });

  it("agents cannot approve outside their own role", async () => {
    const dao = await newDao("bnd-roles");
    const { execReq, payloadHash } = await approvedRequest(dao, "bnd-roles-strat");
    const base = approvalBase(dao, execReq);

    // Financial signing the Executive step, then Executive signing Financial.
    await h.expectError(
      () =>
        h.execution.methods
          .executiveApprove(makeReasoningHash("x"))
          .accountsPartial({ authority: dao.agents[1].publicKey, ...base })
          .signers([dao.agents[1]])
          .rpc(),
      "Unauthorized"
    );
    await h.execution.methods
      .executiveApprove(makeReasoningHash("executive"))
      .accountsPartial({ authority: dao.agents[0].publicKey, ...base })
      .signers([dao.agents[0]])
      .rpc();
    await h.expectError(
      () =>
        h.execution.methods
          .financialApprove(Array.from(payloadHash), makeReasoningHash("x"))
          .accountsPartial({ authority: dao.agents[0].publicKey, ...base })
          .signers([dao.agents[0]])
          .rpc(),
      "Unauthorized"
    );
  });

  it("agent keys must be distinct from each other, the founder, and guardians", async () => {
    const dao = await newDao("bnd-keys");
    const current = (await h.core.account.agentSet.fetch(dao.agentSet)).agents.map(
      (a: { authority: PublicKey }) => new PublicKey(a.authority)
    );
    const updateAgentSet = (keys: PublicKey[]) =>
      h.core.methods
        .updateAgentSet(keys)
        .accountsPartial({
          authority: h.founder.publicKey,
          globalConfig: h.globalConfig,
          daoRegistry: dao.daoRegistry,
          agentSet: dao.agentSet,
          guardianConfig: dao.guardianConfig,
        })
        .rpc();

    const duplicate = [...current];
    duplicate[3] = current[0];
    await h.expectError(() => updateAgentSet(duplicate), "AgentKeyConflict");

    const founderAsAgent = [...current];
    founderAsAgent[2] = h.founder.publicKey;
    await h.expectError(() => updateAgentSet(founderAsAgent), "AgentKeyConflict");

    await h.expectError(
      () => h.guardianRotateAgentKey(dao, 1, dao.guardians[2].publicKey, 41, dao.guardians.slice(0, 2)),
      "AgentKeyConflict"
    );
  });

  it("guardian key rotation waits 24h and the founder can veto it", async () => {
    const dao = await newDao("bnd-rotate");
    const newKey = Keypair.generate();
    await h.guardianRotateAgentKey(dao, 3, newKey.publicKey, 51, dao.guardians.slice(0, 2));

    const agentSet = await h.core.account.agentSet.fetch(dao.agentSet);
    assert.equal(new PublicKey(agentSet.agents[3].authority).toBase58(), dao.agents[3].publicKey.toBase58());
    const control = await h.fetchDaoControl(dao);
    assert.equal(control.pendingAgentChanges[3].kind, GUARDIAN_CHANGE_ROTATE_KEY);

    await h.expectError(
      () =>
        h.core.methods
          .applyGuardianAgentChange(3)
          .accountsPartial({
            authority: dao.members[0].publicKey,
            globalConfig: h.globalConfig,
            daoRegistry: dao.daoRegistry,
            guardianConfig: dao.guardianConfig,
            agentSet: dao.agentSet,
          })
          .signers([dao.members[0]])
          .rpc(),
      "GuardianChangeNotReady"
    );
    await h.expectError(
      () =>
        h.core.methods
          .cancelGuardianAgentChange(3)
          .accountsPartial({
            authority: dao.guardians[0].publicKey,
            globalConfig: h.globalConfig,
            daoRegistry: dao.daoRegistry,
          })
          .signers([dao.guardians[0]])
          .rpc(),
      "Unauthorized"
    );
    await h.core.methods
      .cancelGuardianAgentChange(3)
      .accountsPartial({
        authority: h.founder.publicKey,
        globalConfig: h.globalConfig,
        daoRegistry: dao.daoRegistry,
      })
      .rpc();
    assert.equal((await h.fetchDaoControl(dao)).pendingAgentChanges[3].kind, 0);
  });

  it("shortening the review window after proposals exist is delayed 24h", async () => {
    const dao = await newDao("bnd-window", 3600);
    await approvedRequest(dao, "bnd-window-strat");

    await h.setReviewWindow(dao, 600);
    const constitution = await h.core.account.treasuryConstitution.fetch(dao.constitution);
    assert.equal(Number(constitution.reviewWindowSecs), 3600, "reduction is not applied immediately");
    const control = await h.fetchDaoControl(dao);
    assert.equal(Number(control.pendingReviewWindowSecs), 600);

    await h.expectError(
      () =>
        h.core.methods
          .applyReviewWindow()
          .accountsPartial({
            authority: dao.members[0].publicKey,
            globalConfig: h.globalConfig,
            daoRegistry: dao.daoRegistry,
            constitution: dao.constitution,
          })
          .signers([dao.members[0]])
          .rpc(),
      "ReviewWindowChangeNotReady"
    );
  });

  it("position marks come from on-chain balances and are drift-capped", async () => {
    const dao = await newDao("bnd-mark");
    const { execReq, payloadHash, amount } = await approvedRequest(dao, "bnd-mark-strat");
    await h.runAgentApprovals(dao, execReq, payloadHash);
    await h.waitForReviewEnd(execReq);
    await h.executeStrategy(dao, execReq, h.kamino.programId, "kamino");

    // Inflate the escrow by 50%: the mark must not follow it.
    const escrow = h.strategyEscrowPda(dao.daoRegistry, "kamino", dao.vaultMint);
    await mintTo(h.provider.connection, h.founder, dao.vaultMint, escrow, h.founder, amount / 2n);
    const position = h.strategyPositionPda(dao.daoRegistry, "kamino", dao.vaultMint);
    const mark = (signer: Keypair) =>
      h.core.methods
        .updateStrategyPositionValue("kamino")
        .accountsPartial({
          authority: signer.publicKey,
          globalConfig: h.globalConfig,
          daoRegistry: dao.daoRegistry,
          agentSet: dao.agentSet,
          mint: dao.vaultMint,
          strategyPosition: position,
          vaultAuthority: dao.vaultAuthority,
          strategyEscrow: escrow,
          venueState: escrow,
          receiptTokenAccount: escrow,
        })
        .signers(signer === h.founder ? [] : [signer])
        .rpc();

    // Only the founder or the Operational agent may trigger a mark.
    await h.expectError(() => mark(dao.agents[1]), "Unauthorized");
    await mark(dao.agents[3]);

    const pos = await h.core.account.strategyPosition.fetch(position);
    const escrowed = BigInt((await getAccount(h.provider.connection, escrow)).amount.toString());
    const marked = BigInt(pos.currentValue.toString());
    assert.isTrue(marked >= amount, "mark never drops below untouched principal");
    assert.isTrue(marked < escrowed, "mark is capped below the inflated escrow");
    // 1%/day of principal over a few minutes is far below 1% in total.
    assert.isTrue(marked - amount < amount / 100n, "upward drift stays under the daily cap");
  });
});
