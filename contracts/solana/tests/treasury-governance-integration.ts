import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { NaveTestHarness, VOTE_FOR, VOTE_AGAINST, pctOfTreasury } from "./helpers/nave-harness";
import { simulateYield, usdcToRaw } from "./helpers/apy-simulator";

describe("on-chain governance across DAO sizes", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  const scenarios = [
    { label: "micro-3", members: 3, deposit: 10_000, guardians: 2, threshold: 2 },
    { label: "family-5", members: 5, deposit: 10_000, guardians: 3, threshold: 2 },
    { label: "family-20", members: 8, deposit: 10_000, guardians: 3, threshold: 2 },
  ] as const;

  for (const s of scenarios) {
    describe(s.label, () => {
      it("passes strategy proposal when quorum (35%) votes for with majority", async () => {
        const dao = await harness.createDao({
          name: s.label,
          memberCount: s.members,
          depositPerMemberUsdc: s.deposit,
          guardianCount: s.guardians,
          guardianThreshold: s.threshold,
        });

        const { proposal } = await harness.createStrategyProposal(
          dao,
          "Deploy Kamino",
          Buffer.from(`deploy-kamino-${s.label}`)
        );

        await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);

        await harness.finalizeProposal(dao, proposal);

        const p = await harness.governance.account.proposal.fetch(proposal);
        assert.equal(p.status, 1); // Passed
        assert.isTrue(p.votesFor.gt(p.votesAgainst));
      });

      it("fails proposal when participation below 35% quorum", async () => {
        const dao = await harness.createDao({
          name: `${s.label}-low-q`,
          memberCount: s.members,
          depositPerMemberUsdc: s.deposit,
          guardianCount: s.guardians,
          guardianThreshold: s.threshold,
          tokensPerMember: usdcToRaw(50_000),
        });

        const { proposal } = await harness.createStrategyProposal(
          dao,
          "Should fail quorum",
          Buffer.from(`fail-quorum-${s.label}`),
          30
        );

        const required = await harness.requiredQuorumWeight(dao, proposal);
        const target = required > 0n ? required - 1n : 0n;
        let locked = 0n;
        for (const member of dao.members) {
          if (locked >= target) break;
          const ata = dao.memberTokenAccounts.get(member.publicKey.toBase58())!;
          const acc = await getAccount(harness.provider.connection, ata);
          const available = BigInt(acc.amount.toString());
          const need = target - locked;
          const lockAmount = available < need ? available : need;
          if (lockAmount > 0n) {
            await harness.lockTokensAndVote(dao, proposal, member, lockAmount, VOTE_FOR);
            locked += lockAmount;
          }
        }

        // FN-H4: a voting window that closes without quorum no longer reverts
        // (QuorumNotMet) — it finalizes to the terminal Failed status so vote
        // escrows become releasable.
        await harness.finalizeProposal(dao, proposal);
        const p = await harness.governance.account.proposal.fetch(proposal);
        assert.equal(p.status, 2); // Failed (no quorum at window close)
      });

      it("fails proposal when quorum met but against majority among voters", async () => {
        const dao = await harness.createDao({
          name: `${s.label}-against`,
          memberCount: s.members,
          depositPerMemberUsdc: s.deposit,
          guardianCount: s.guardians,
          guardianThreshold: s.threshold,
        });

        // Use a 30s voting period so sequential per-member lock calls have time to complete.
        const { proposal } = await harness.createStrategyProposal(
          dao,
          "Should fail majority",
          Buffer.from(`fail-majority-${s.label}`),
          30
        );

        // member[0] votes FOR (all tokens), remaining members vote AGAINST.
        // votingStake formula ensures combined tokens == quorum, so N-1 AGAINST > 1 FOR.
        await harness.lockQuorumSplit(dao, proposal);

        await harness.finalizeProposal(dao, proposal);

        const p = await harness.governance.account.proposal.fetch(proposal);
        assert.equal(p.status, 2); // Failed
      });
    });
  }
});

describe("on-chain treasury deposits by DAO size", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  it("records correct NAV for $200k family treasury (8 x $25k)", async () => {
    const dao = await harness.createDao({
      name: "chen-family",
      memberCount: 8,
      depositPerMemberUsdc: 25_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });

    const vault = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
    // Audit ABI: deposits flow through the per-asset `deposit_to_asset` path and
    // the aggregate USD NAV (set by revalue_treasury) is the source of truth; the
    // legacy `total_deposited` field is only written by the deprecated
    // single-asset `deposit_to_vault`.
    assert.equal(vault.currentNav.toString(), usdcToRaw(200_000).toString());
  });

  it("records correct NAV for large community ($5M)", async () => {
    const dao = await harness.createDao({
      name: "large-community",
      memberCount: 10, // keep test fast; math covers 100-member presets
      depositPerMemberUsdc: 500_000,
      guardianCount: 7,
      guardianThreshold: 5,
    });

    const vault = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
    assert.equal(vault.currentNav.toString(), usdcToRaw(5_000_000).toString());
  });
});

describe("on-chain strategy deployment with simulated yield harvest", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  it("deploys to Kamino after governance + agents, then simulates 8% APY harvest", async () => {
    const dao = await harness.createDao({
      name: "growth-dao",
      memberCount: 5,
      depositPerMemberUsdc: 10_000,
      guardianCount: 3,
      guardianThreshold: 2,
    });
    await harness.enableAgents(dao); // agents created disabled; enable pipeline

    const deployAmount = pctOfTreasury(dao.totalTreasuryRaw, 4000);
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      "Kamino 40%",
      harness.strategyPayload(harness.kamino.programId, deployAmount, dao.vaultMint)
    );

    await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await harness.finalizeProposal(dao, proposal);

    const execReq = await harness.createExecutionRequest(
      dao,
      proposal,
      deployAmount,
      harness.kamino.programId
    );
    await harness.runAgentApprovals(dao, execReq, payloadHash);
    await harness.disableAgentsForDirectExecute(dao);
    await harness.executeStrategyDirect(
      dao,
      execReq,
      harness.kamino.programId,
      "kamino"
    );
    await harness.enableAgents(dao);

    const vaultAfter = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
    assert.equal(vaultAfter.deployedCapital.toString(), deployAmount.toString());

    const yieldRaw = simulateYield(deployAmount, 800, 365);
    await harness.simulateYieldDeposit(dao, yieldRaw);

    const vaultFinal = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
    const expectedNav = dao.totalTreasuryRaw + yieldRaw;
    assert.equal(vaultFinal.currentNav.toString(), expectedNav.toString());

    // Audit ABI: principal lives in the per-asset vault; execute_strategy moved
    // `deployAmount` of it into the escrow. Simulated yield is deposited via the
    // legacy deposit_to_vault into the main vault token account.
    const assetVaultAcc = await getAccount(harness.provider.connection, dao.assetVaultTokenAccount);
    assert.equal(assetVaultAcc.amount.toString(), (dao.totalTreasuryRaw - deployAmount).toString());

    const mainVaultAcc = await getAccount(harness.provider.connection, dao.vaultTokenAccount);
    assert.equal(mainVaultAcc.amount.toString(), yieldRaw.toString());

    const escrowPk = harness.strategyEscrowPda(dao.daoRegistry, "kamino", dao.vaultMint);
    const escrowAcc = await getAccount(harness.provider.connection, escrowPk);
    assert.equal(escrowAcc.amount.toString(), deployAmount.toString());
  });

  for (const apyBps of [300, 500, 800, 1000, 1200]) {
    it(`projects ${apyBps / 100}% APY harvest on $50k deployed capital`, async () => {
      const dao = await harness.createDao({
        name: `apy-${apyBps}`,
        memberCount: 3,
        depositPerMemberUsdc: 50_000,
        guardianCount: 2,
        guardianThreshold: 2,
      });
      await harness.enableAgents(dao); // agents created disabled; enable pipeline

      const deployAmount = pctOfTreasury(dao.totalTreasuryRaw, 3000);
      // Audit ABI: asset_kind↔protocol routing is now enforced on-chain. The
      // harness treasury asset is a stablecoin, which routes to a lending
      // protocol (kamino), not the SOL-staking jito adapter (which requires a
      // SolLike asset and rejects a stablecoin with AssetKindMismatch).
      const { proposal, payloadHash } = await harness.createStrategyProposal(
        dao,
        `Deploy ${apyBps}bps`,
        harness.strategyPayload(harness.kamino.programId, deployAmount, dao.vaultMint)
      );

      await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
      await harness.finalizeProposal(dao, proposal);

      const execReq = await harness.createExecutionRequest(
        dao,
        proposal,
        deployAmount,
        harness.kamino.programId
      );
      await harness.runAgentApprovals(dao, execReq, payloadHash);
      await harness.disableAgentsForDirectExecute(dao);
      await harness.executeStrategyDirect(
        dao,
        execReq,
        harness.kamino.programId,
        "kamino"
      );
      await harness.enableAgents(dao);

      const yieldRaw = simulateYield(deployAmount, apyBps, 180);
      await harness.simulateYieldDeposit(dao, yieldRaw);

      const vault = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
      assert.isAbove(Number(vault.currentNav), Number(dao.totalTreasuryRaw));
    });
  }
});

describe("allocation cap enforcement", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  it("rejects deploying an amount exceeding protocol max_allocation_bps", async () => {
    const dao = await harness.createDao({
      name: "cap-test",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 2,
      guardianThreshold: 2,
    });
    await harness.enableAgents(dao);

    const overCap = pctOfTreasury(dao.totalTreasuryRaw, 5000); // 50% > 40% kamino cap
    const { proposal, payloadHash } = await harness.createStrategyProposal(
      dao,
      "Over cap",
      harness.strategyPayload(harness.kamino.programId, overCap, dao.vaultMint)
    );
    await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
    await harness.finalizeProposal(dao, proposal);
    // Audit ABI: the USD-denominated allocation cap depends on a live NAV, so it
    // is enforced at EXECUTION time (not at create_execution_request, which only
    // binds the payload). The over-cap deploy must reject when executed.
    const execReq = await harness.createExecutionRequest(
      dao,
      proposal,
      overCap,
      harness.kamino.programId
    );
    // Break-glass now requires the request to already be InReview/OversightApproved
    // before the (unrelated) allocation-cap rejection is even reachable.
    await harness.runAgentApprovals(dao, execReq, payloadHash);
    await harness.disableAgentsForDirectExecute(dao);
    await harness.expectError(
      () => harness.executeStrategyDirect(dao, execReq, harness.kamino.programId, "kamino"),
      "AllocationLimitExceeded"
    );
  });
});

describe("founder cannot bypass execution pipeline for withdrawals", () => {
  let harness: NaveTestHarness;
  before(() => {
    harness = new NaveTestHarness();
  });

  it("rejects direct vault withdraw", async () => {
    const dao = await harness.createDao({
      name: "withdraw-block",
      memberCount: 3,
      depositPerMemberUsdc: 10_000,
      guardianCount: 2,
      guardianThreshold: 2,
    });

    await harness.expectError(
      () =>
        harness.core.methods
          .withdrawFromVault(new anchor.BN(1))
          .accounts({
            authority: harness.founder.publicKey,
            globalConfig: harness.globalConfig,
            daoRegistry: dao.daoRegistry,
            treasuryVault: dao.treasuryVault,
            vaultAuthority: dao.vaultAuthority,
            vaultTokenAccount: dao.vaultTokenAccount,
            recipientTokenAccount: dao.feeRecipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
      "ExecutionRequestRequired"
    );
  });
});
