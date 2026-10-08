import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  NaveTestHarness,
  VOTE_FOR,
  pctOfTreasury,
} from "./helpers/nave-harness";

describe("guardian emergency M-of-N across thresholds", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  const guardianConfigs = [
    { members: 5, guardians: 3, threshold: 2, label: "2-of-3" },
    { members: 20, guardians: 7, threshold: 7, label: "7-of-7 family" },
    { members: 10, guardians: 10, threshold: 7, label: "7-of-10 community" },
  ] as const;

  for (const cfg of guardianConfigs) {
    describe(cfg.label, () => {
      it("freezes DAO only after threshold guardians sign", async () => {
        const dao = await harness.createDao({
          name: cfg.label,
          memberCount: cfg.members,
          depositPerMemberUsdc: 10_000,
          guardianCount: cfg.guardians,
          guardianThreshold: cfg.threshold,
        });

        const partial = dao.guardians.slice(0, cfg.threshold - 1);
        await harness.guardianEmergencyFreeze(dao, 1, partial);

        let registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
        assert.isFalse(registry.frozen);

        await harness.guardianEmergencyFreeze(dao, 1, [dao.guardians[cfg.threshold - 1]]);

        registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
        assert.isTrue(registry.frozen);
      });

      it("unfreezes after threshold guardians sign unfreeze action", async () => {
        const dao = await harness.createDao({
          name: `${cfg.label}-unfreeze`,
          memberCount: Math.min(cfg.members, 5),
          depositPerMemberUsdc: 10_000,
          guardianCount: cfg.guardians,
          guardianThreshold: cfg.threshold,
        });

        await harness.guardianEmergencyFreeze(dao, 2, dao.guardians.slice(0, cfg.threshold));
        let registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
        assert.isTrue(registry.frozen);

        await harness.guardianEmergencyUnfreeze(dao, 3, dao.guardians.slice(0, cfg.threshold));
        registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
        assert.isFalse(registry.frozen);
      });
    });
  }

  it("minority guardians cannot unfreeze without threshold", async () => {
    const dao = await harness.createDao({
      name: "minority-unfreeze",
      memberCount: 5,
      depositPerMemberUsdc: 10_000,
      guardianCount: 7,
      guardianThreshold: 5,
    });

    await harness.guardianEmergencyFreeze(dao, 10, dao.guardians.slice(0, 5));

    await harness.guardianEmergencyUnfreeze(dao, 11, dao.guardians.slice(0, 2));
    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    assert.isTrue(registry.frozen);
  });
});

describe("emergency freeze during active execution review", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  it("family DAO: guardians freeze during 24h review; executive can direct-execute only when frozen", async () => {
    const dao = await harness.createDao({
      name: "family-emergency",
      memberCount: 8,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });

    // Audit ABI: agents are created disabled; the 3-of-3 approval path requires
    // agents_enabled, so turn on the pipeline before recording approvals.
    await harness.enableAgents(dao);

    const amount = pctOfTreasury(dao.totalTreasuryRaw, 3000);
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      "Suspicious deploy",
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
    await harness.runAgentApprovals(dao, execReq, payloadHash);

    await harness.guardianEmergencyFreeze(
      dao,
      42,
      dao.guardians.slice(0, dao.config.guardianThreshold)
    );

    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    assert.isTrue(registry.frozen);

    // Direct execute allowed for executive when frozen (break-glass)
    await harness.executeStrategyDirect(
      dao,
      execReq,
      harness.kamino.programId,
      "kamino"
    );

    const vault = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
    assert.equal(vault.deployedCapital.toString(), amount.toString());
  });
});

describe("guardian wallet voting (weight=1) complements token voting", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  it("guardians can cast wallet votes on policy proposals", async () => {
    const dao = await harness.createDao({
      name: "guardian-votes",
      memberCount: 5,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
      governanceType: 0, // wallet governance — guardian wallet votes apply
    });

    const registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposalIndex = registry.proposalCount;
    const proposal = harness.proposalPda(dao, proposalIndex);

    await harness.governance.methods
      .createProposal({
        title: "Policy change",
        description: "Update ops policy",
        payload: Buffer.from("policy"),
        proposalType: 0,
        votingPeriodSeconds: new anchor.BN(30),
      })
      .accountsPartial({
        proposer: harness.founder.publicKey,
        daoRegistry: dao.daoRegistry,
        proposal,
        daoTokenMint: dao.vaultMint,
      })
      .rpc();

    await harness.castGuardianVote(dao, proposal, dao.guardians[0], VOTE_FOR);
    await harness.castGuardianVote(dao, proposal, dao.guardians[1], VOTE_FOR);

    await harness.lockQuorumVotes(
      dao,
      proposal,
      VOTE_FOR,
      (await harness.requiredQuorumWeight(dao, proposal)) - 2n
    );

    await harness.finalizeProposal(dao, proposal);

    const p = await harness.governance.account.proposal.fetch(proposal);
    assert.isAtLeast(p.votesFor.toNumber(), 2);
    assert.equal(p.status, 1);
  });
});
