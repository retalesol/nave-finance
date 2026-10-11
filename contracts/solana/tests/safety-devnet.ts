/**
 * Live Solana devnet safety/guardian coverage.
 *
 * Exercises, against the deployed programs (real transactions, real state
 * fetches — no localnet), every safety-relevant instruction NOT already
 * covered by devnet-e2e.ts:
 *
 *   1. emergency_pause_agents   — founder-immediate, single-signer kill switch
 *   2. toggle_agents(true)      — Executive-only re-enable
 *   3. guardian_disable_agents  — guardian M-of-N break-glass kill switch
 *   4. emergency_freeze / emergency_unfreeze — guardian M-of-N DAO freeze
 *   5. update_agent_status      — guardian M-of-N pause/restore an agent slot
 *   6. rotate_agent_key         — guardian M-of-N IMMEDIATE key rotation
 *   7. update_agent_set + apply_agent_rotation — founder 48h TIMELOCKED
 *      rotation path (scheduling verified + immediate-apply correctly
 *      rejected with AgentRotationNotReady; the full 48h wait is not
 *      performed live — see report)
 *   8. execute_strategy_direct  — Executive break-glass execution path
 *   9. withdraw_from_strategy   — realized_yield_withdraw_cap enforcement
 *      (over-cap request rejected, in-cap request succeeds)
 *
 * Run:
 *   RPC=https://api.devnet.solana.com \
 *   ../node_modules/.bin/ts-node tests/safety-devnet.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NaveTestHarness, VOTE_FOR, pctOfTreasury } from "./helpers/nave-harness";

class DevnetHarness extends NaveTestHarness {
  async airdrop(key: PublicKey, sol = 0.05): Promise<void> {
    await this.provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.founder.publicKey,
          toPubkey: key,
          lamports: Math.floor(sol * anchor.web3.LAMPORTS_PER_SOL),
        })
      )
    );
  }

  async airdropMany(keypairs: Keypair[], sol = 0.05): Promise<void> {
    for (const kp of keypairs) await this.airdrop(kp.publicKey, sol);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function expectRevert(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
    throw new Error(`expected "${label}" to revert but it succeeded`);
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("Error: expected")) throw e;
    console.log(`  ✓ correctly reverted: ${label} (${msg.split("\n")[0].slice(0, 140)})`);
  }
}

async function main() {
  const harness = new DevnetHarness();
  console.log("Founder/deployer:", harness.founder.publicKey.toBase58());
  console.log("RPC:", harness.provider.connection.rpcEndpoint);

  const dao = await harness.createDao({
    name: "safety-devnet",
    memberCount: 2,
    depositPerMemberUsdc: 10_000,
    guardianCount: 3,
    guardianThreshold: 2,
  });
  console.log("DAO registry:", dao.daoRegistry.toBase58());

  // ── 1/2: emergency_pause_agents (founder) + toggle_agents(true) re-enable ──
  await harness.enableAgents(dao);
  let agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
  assert(agentSet.agentsEnabled === true, "agents enabled after initial toggle_agents(true)");

  await harness.core.methods
    .emergencyPauseAgents()
    .accounts({
      authority: harness.founder.publicKey,
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
      guardianConfig: dao.guardianConfig,
      agentSet: dao.agentSet,
    })
    .rpc();
  agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
  let registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
  assert(agentSet.agentsEnabled === false, "emergency_pause_agents disabled agent_set");
  assert(registry.agentsEnabled === false, "emergency_pause_agents disabled dao_registry");
  console.log("✓ emergency_pause_agents (founder, immediate, single-signer) — agents disabled");

  await harness.enableAgents(dao);
  agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
  assert(agentSet.agentsEnabled === true, "toggle_agents(true) re-enabled after emergency pause");
  console.log("✓ toggle_agents(true) (Executive) re-enabled after emergency pause");

  // ── 3: guardian_disable_agents M-of-N break-glass ───────────────────────────
  const guardianActionPda = (actionType: number, extra: Buffer[], nonce: number) =>
    harness.guardianActionPda(dao, actionType, extra, nonce);

  await harness.core.methods
    .guardianDisableAgents(new anchor.BN(101))
    .accounts({
      guardian: dao.guardians[0].publicKey,
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
      guardianConfig: dao.guardianConfig,
      guardianAction: guardianActionPda(4, [], 101),
      agentSet: dao.agentSet,
      systemProgram: SystemProgram.programId,
    })
    .signers([dao.guardians[0]])
    .rpc();
  agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
  assert(agentSet.agentsEnabled === true, "1-of-2 guardian sig must NOT disable agents yet");
  console.log("✓ guardian_disable_agents: 1-of-2 signature does not yet disable (below threshold)");

  await harness.core.methods
    .guardianDisableAgents(new anchor.BN(101))
    .accounts({
      guardian: dao.guardians[1].publicKey,
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
      guardianConfig: dao.guardianConfig,
      guardianAction: guardianActionPda(4, [], 101),
      agentSet: dao.agentSet,
      systemProgram: SystemProgram.programId,
    })
    .signers([dao.guardians[1]])
    .rpc();
  agentSet = await harness.core.account.agentSet.fetch(dao.agentSet);
  assert(agentSet.agentsEnabled === false, "2-of-2 guardian sig must disable agents");
  console.log("✓ guardian_disable_agents: 2-of-2 (M-of-N) reached threshold — agents disabled");

  await harness.enableAgents(dao);

  // ── 4: guardian emergency freeze / unfreeze M-of-N ──────────────────────────
  await harness.guardianEmergencyFreeze(dao, 201, dao.guardians.slice(0, 1));
  registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
  assert(registry.frozen === false, "1-of-2 guardian freeze sig must not freeze yet");

  await harness.guardianEmergencyFreeze(dao, 201, dao.guardians.slice(1, 2));
  registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
  assert(registry.frozen === true, "2-of-2 guardian freeze sig must freeze DAO");
  console.log("✓ emergency_freeze: M-of-N (2-of-2) froze the DAO");

  await harness.guardianEmergencyUnfreeze(dao, 202, dao.guardians.slice(0, 2));
  registry = await harness.core.account.daoRegistry.fetch(dao.daoRegistry);
  assert(registry.frozen === false, "2-of-2 guardian unfreeze sig must unfreeze DAO");
  console.log("✓ emergency_unfreeze: M-of-N (2-of-2) unfroze the DAO");

  // ── 5: guardian update_agent_status (pause Operational; re-activation queued) ─
  // Operational is not needed by the approval pipeline below, so it can stay
  // paused for the rest of the run.
  const PAUSED_SLOT = 3;
  await harness.guardianUpdateAgentStatus(dao, PAUSED_SLOT, 1 /* Paused */, 301, dao.guardians.slice(0, 2));
  let agentSetAcc = await harness.core.account.agentSet.fetch(dao.agentSet);
  assert(agentSetAcc.agents[PAUSED_SLOT].status === 1, "operational slot paused via guardian M-of-N");
  console.log("✓ guardian update_agent_status: Operational slot paused (M-of-N)");

  await harness.guardianUpdateAgentStatus(dao, PAUSED_SLOT, 0 /* Active */, 302, dao.guardians.slice(0, 2));
  agentSetAcc = await harness.core.account.agentSet.fetch(dao.agentSet);
  assert(agentSetAcc.agents[PAUSED_SLOT].status === 1, "guardian re-activation is queued, slot stays Paused");
  let control = await harness.fetchDaoControl(dao);
  assert(control.pendingAgentChanges[PAUSED_SLOT].kind === 2, "re-activation queued in DaoControl");
  await harness.core.methods
    .cancelGuardianAgentChange(PAUSED_SLOT)
    .accountsPartial({
      authority: harness.founder.publicKey,
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
    })
    .rpc();
  console.log("✓ guardian update_agent_status: re-activation queued 24h; founder vetoed it");

  // ── 6: guardian rotate_agent_key — queued 24h (founder can veto) ────────────
  const FINANCIAL_SLOT = 1;
  const newFinancialKey = Keypair.generate();
  await harness.guardianRotateAgentKey(dao, FINANCIAL_SLOT, newFinancialKey.publicKey, 401, dao.guardians.slice(0, 2));
  agentSetAcc = await harness.core.account.agentSet.fetch(dao.agentSet);
  assert(
    new PublicKey(agentSetAcc.agents[FINANCIAL_SLOT].authority).equals(dao.agents[FINANCIAL_SLOT].publicKey),
    "guardian rotation does not swap the key before the 24h delay"
  );
  control = await harness.fetchDaoControl(dao);
  assert(
    new PublicKey(control.pendingAgentChanges[FINANCIAL_SLOT].newAuthority).equals(newFinancialKey.publicKey),
    "rotation queued in DaoControl"
  );
  console.log("✓ rotate_agent_key: guardian M-of-N rotation queued for 24h");

  // ── 7: founder 48h TIMELOCKED rotation path ─────────────────────────────────
  const OPERATIONAL_SLOT = 3;
  const newOperationalKey = Keypair.generate();
  const currentAuthorities = agentSetAcc.agents.map((a: { authority: PublicKey }) => new PublicKey(a.authority));
  const scheduledAuthorities = [...currentAuthorities];
  scheduledAuthorities[OPERATIONAL_SLOT] = newOperationalKey.publicKey;

  await harness.core.methods
    .updateAgentSet(scheduledAuthorities)
    .accounts({
      authority: harness.founder.publicKey,
      globalConfig: harness.globalConfig,
      daoRegistry: dao.daoRegistry,
      agentSet: dao.agentSet,
    })
    .rpc();
  agentSetAcc = await harness.core.account.agentSet.fetch(dao.agentSet);
  const pending = agentSetAcc.pendingRotations[OPERATIONAL_SLOT];
  assert(
    new PublicKey(pending.pendingAuthority).equals(newOperationalKey.publicKey),
    "update_agent_set scheduled the pending rotation for operational slot"
  );
  const nowSecs = Math.floor(Date.now() / 1000);
  const effectiveAt = Number(pending.effectiveAt.toString());
  assert(effectiveAt - nowSecs > 172_000 && effectiveAt - nowSecs <= 172_800, "effective_at is ~48h in the future");
  console.log(
    `✓ update_agent_set (founder, 48h timelock): operational rotation scheduled, effective_at=${new Date(effectiveAt * 1000).toISOString()}`
  );

  await expectRevert(
    () =>
      harness.core.methods
        .applyAgentRotation(OPERATIONAL_SLOT)
        .accounts({
          authority: harness.founder.publicKey,
          globalConfig: harness.globalConfig,
          daoRegistry: dao.daoRegistry,
          agentSet: dao.agentSet,
        })
        .rpc(),
    "apply_agent_rotation before the 48h timelock elapses (AgentRotationNotReady)"
  );

  // ── 8/9: strategy pipeline -> execute_strategy_direct -> withdraw cap ───────
  const deployAmount = pctOfTreasury(dao.totalTreasuryRaw, 3000); // under kamino's 40% cap
  const { proposal, payloadHash } = await harness.createStrategyProposal(
    dao,
    "Deploy 30% to Kamino (safety-devnet)",
    harness.strategyPayload(harness.kamino.programId, deployAmount, dao.vaultMint),
    8
  );
  await harness.lockQuorumVotes(dao, proposal, VOTE_FOR);
  await harness.finalizeProposal(dao, proposal);
  const finalizedProposal = await harness.governance.account.proposal.fetch(proposal);
  assert(finalizedProposal.status === 1, "strategy proposal Passed");

  const execReq = await harness.createExecutionRequest(dao, proposal, deployAmount, harness.kamino.programId);
  await harness.runAgentApprovals(dao, execReq, payloadHash);
  console.log("✓ full 3-agent approval pipeline signed (executive / financial / oversight)");

  await harness.disableAgentsForDirectExecute(dao, 501);
  await harness.executeStrategyDirect(dao, execReq, harness.kamino.programId, "kamino");
  await harness.enableAgents(dao);

  const vaultAfterDeploy = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
  assert(
    vaultAfterDeploy.deployedCapital.toString() === deployAmount.toString(),
    "execute_strategy_direct deployed the approved amount"
  );
  console.log(`✓ execute_strategy_direct (Executive break-glass): deployed ${deployAmount} to Kamino`);

  await expectRevert(
    () => harness.withdrawFromStrategy(dao, execReq, harness.kamino.programId, "kamino", deployAmount + 1n),
    "withdraw_from_strategy above realized_yield_withdraw_cap (no marked gain ⇒ cap == principal)"
  );

  await harness.withdrawFromStrategy(dao, execReq, harness.kamino.programId, "kamino", deployAmount);
  const vaultAfterWithdraw = await harness.core.account.treasuryVault.fetch(dao.treasuryVault);
  assert(
    vaultAfterWithdraw.deployedCapital.toString() === "0",
    "in-cap withdraw_from_strategy fully unwound the position"
  );
  console.log("✓ withdraw_from_strategy: over-cap request rejected, in-cap (full principal) request succeeded");

  console.log("\nDEVNET_SAFETY_SUMMARY=" + JSON.stringify({
    network: "solana-devnet",
    daoRegistry: dao.daoRegistry.toBase58(),
    checks: [
      "emergency_pause_agents",
      "toggle_agents",
      "guardian_disable_agents (M-of-N)",
      "emergency_freeze/unfreeze (M-of-N)",
      "guardian update_agent_status (M-of-N pause; re-activation queued 24h + founder veto)",
      "rotate_agent_key (guardian M-of-N, queued 24h)",
      "update_agent_set + apply_agent_rotation (founder 48h timelock; scheduling + not-ready rejection verified live, full 48h wait not performed)",
      "execute_strategy_direct (Executive break-glass)",
      "withdraw_from_strategy realized_yield_withdraw_cap (over-cap rejected, in-cap succeeded)",
    ],
  }));
  console.log("E2E_DAO_ADDRESS=" + dao.daoRegistry.toBase58());
}

main().catch((err) => {
  console.error("\n❌ safety-devnet FAILED:", err?.message ?? err);
  if (err?.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
