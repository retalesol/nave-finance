/**
 * Public-beta Solana devnet dry run. Uses the app transaction builders.
 * Does not print key material or RPC URLs. Does not touch mainnet.
 *
 * Run from app/:
 *   node --import tsx --import ./tests/frontend/support/register.mjs scripts/public-beta-solana-dry-run.mjs
 */
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";

register("./public-beta-anchor-resolve.mjs", import.meta.url);
import { createPrivateKey, randomBytes, sign as edSign } from "node:crypto";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_ENV = `${ROOT}app/.env.local`;
const SOL_ENV = `${ROOT}contracts/solana/.env.testnet.local`;
const WALLET_PATH = `${ROOT}contracts/solana/.deploy-wallet-ej9-devnet.json`;
const STATE_PATH = "/tmp/nave-public-beta-solana.json";
const GUARDIAN_PATH = "/tmp/nave-public-beta-solana-guardians.json";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEPOSIT_LAMPORTS = 200_000_000n;
const DEPLOY_LAMPORTS = 50_000_000n;
const STAKE_POOL = new PublicKey("azFVdHtAJN8BX3sbGAYkXvtdjdrT5U6rj9rovvUFos9");
const STAKE_RESERVE = new PublicKey("aRkys1kVHeysrcn9bJFat9FkvoyyYD8M1kK286X3Aro");
const POOL_MINT = new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1");
const PYTH_SOL = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

function loadFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const row of readFileSync(path, "utf8").split("\n")) {
    const match = row.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function short(error) {
  const message = error?.message || String(error);
  return message.replace(/https?:\/\/\S+/g, "[endpoint]").split("\n")[0].slice(0, 400);
}

function signEd(keypair, message) {
  const seed = Buffer.from(keypair.secretKey.slice(0, 32));
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const keyObject = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return edSign(null, Buffer.from(message), keyObject).toString("base64");
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { sigs: {} };
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadGuardians() {
  if (!existsSync(GUARDIAN_PATH)) {
    const created = [Keypair.generate(), Keypair.generate()];
    writeFileSync(GUARDIAN_PATH, JSON.stringify(created.map((kp) => Array.from(kp.secretKey))));
    chmodSync(GUARDIAN_PATH, 0o600);
    return created;
  }
  const raw = JSON.parse(readFileSync(GUARDIAN_PATH, "utf8"));
  return raw.map((secret) => Keypair.fromSecretKey(Uint8Array.from(secret)));
}

async function sendTx(connection, payer, builtList, extra = [], opts = {}) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  const signers = [payer, ...extra];
  for (const built of builtList) {
    if (!built?.instruction && !built?.preInstructions?.length) {
      throw new Error(built?.error || "empty instruction");
    }
    if (built.preInstructions) tx.add(...built.preInstructions);
    if (built.instruction) tx.add(built.instruction);
    if (built.signers) signers.push(...built.signers);
  }
  tx.feePayer = payer.publicKey;
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: Boolean(opts.skipPreflight),
  });
  const confirmed = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmed.value.err) {
    const error = new Error(`transaction failed ${signature}`);
    error.signature = signature;
    throw error;
  }
  return signature;
}

async function edge(base, anon, name, body) {
  const response = await fetch(`${base}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anon}`,
      apikey: anon,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(`${name} HTTP ${response.status}: ${data.error || "request failed"}`);
  }
  return data;
}

function signaturesFrom(payload) {
  const found = [];
  const walk = (value, action) => {
    if (!value || typeof value !== "object") return;
    const nextAction = value.action || value.action_type || action;
    if (typeof value.signature === "string" && value.signature.length > 40) {
      found.push({ action: nextAction || "unknown", signature: value.signature });
    }
    if (typeof value.tx_signature === "string" && value.tx_signature.length > 40) {
      found.push({ action: nextAction || "unknown", signature: value.tx_signature });
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") walk(child, nextAction);
    }
  };
  walk(payload, null);
  return found;
}

async function main() {
  const appEnv = loadFile(APP_ENV);
  const vite = globalThis.__NAVE_VITE_ENV__;
  for (const [key, value] of Object.entries(appEnv)) {
    if (key.startsWith("VITE_") && value) vite[key] = value;
  }
  vite.VITE_USE_MOCKS = "false";
  vite.VITE_NAVE_BOOTSTRAP_DEPLOYED = "true";
  if (!vite.VITE_SOLANA_RPC_URL || /mainnet/i.test(vite.VITE_SOLANA_RPC_URL)) {
    throw new Error("refusing to run without a non-mainnet Solana RPC");
  }

  const {
    buildInitializeDao,
    buildInitializeDaoExtensions,
    buildInitializeDaoGovernance,
    buildSeedTreasuryWsol,
    buildUpdateConstitution,
    buildSetPolicyParameters,
    buildRevalueTreasury,
    buildInitStrategyPosition,
    buildInitStrategyEscrow,
    buildConfigurePositionTargets,
    buildCreateProposal,
    buildCastVoteWallet,
    buildFinalizeProposal,
    buildCreateExecutionRequest,
    encodeStrategyProposalPayload,
    WSOL_MINT,
  } = await import("../src/lib/transactionBuilders.ts");
  const {
    NAVE_PROTOCOL_FEE_WALLET,
    NAVE_JITO_ADAPTER_ID,
    SUPABASE_FUNCTIONS_URL,
    SUPABASE_ANON_KEY,
    MANAGEMENT_FEE_BPS_NORMAL,
    MANAGEMENT_FEE_BPS_FROZEN,
    PERFORMANCE_FEE_BPS,
    FROZEN_PERFORMANCE_FEE_BPS,
  } = await import("../src/lib/programConfig.ts");
  const { getNavePrograms } = await import("../src/lib/naveProgram.ts");
  const {
    getDaoRegistryPDA,
    getNaveGlobalConfigPDA,
    getProposalPDA,
    getExecutionRequestPDA,
    getConstitutionPDA,
    getAgentSetPDA,
  } = await import("../src/lib/pdaDerivation.ts");

  const connection = new Connection(vite.VITE_SOLANA_RPC_URL, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error("RPC is not Solana devnet");
  const founder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, "utf8"))));
  const guardians = loadGuardians();
  const state = loadState();
  state.founder = founder.publicKey.toBase58();
  state.guardians = [founder.publicKey.toBase58(), ...guardians.map((kp) => kp.publicKey.toBase58())];
  state.sigs = state.sigs || {};
  const { core, governance } = getNavePrograms(connection);

  async function note(label, signature) {
    state.sigs[label] = signature;
    saveState(state);
    console.log(`  tx ${label} ${signature}`);
  }

  const daoParams = (daoId, agentKeys) => ({
    name: `Beta Solana ${daoId}`,
    guardianWallets: [founder.publicKey, ...guardians.map((kp) => kp.publicKey)],
    guardianThreshold: 2,
    agentAuthorities: agentKeys,
    managementFeeBps: MANAGEMENT_FEE_BPS_NORMAL,
    performanceFeeBps: PERFORMANCE_FEE_BPS,
    frozenManagementFeeBps: MANAGEMENT_FEE_BPS_FROZEN,
    frozenPerformanceFeeBps: FROZEN_PERFORMANCE_FEE_BPS,
    privacyMode: 0,
    feeRecipient: getAssociatedTokenAddressSync(NATIVE_MINT, founder.publicKey, true),
    protocolRevenueWallet: NAVE_PROTOCOL_FEE_WALLET,
    quorumBps: 3500,
    governanceType: 0,
  });

  if (!state.sigs.initializeDao) {
    const [globalPda] = getNaveGlobalConfigPDA();
    const global = await core.account.naveGlobalConfig.fetch(globalPda);
    const daoId = Number(global.daoCount);
    const [dao] = getDaoRegistryPDA(founder.publicKey, daoId);
    const nonce = randomBytes(12).toString("base64url");
    const message = `nave-agent-keys|${dao.toBase58()}|solana|${Date.now()}|${nonce}`;
    const keyData = await edge(SUPABASE_FUNCTIONS_URL, SUPABASE_ANON_KEY, "generate-agent-keys", {
      dao_address: dao.toBase58(),
      creator_wallet: founder.publicKey.toBase58(),
      creator_message: message,
      creator_signature: signEd(founder, message),
      dao_id: daoId,
    });
    const agents = {};
    for (const role of ["executive", "financial", "oversight", "operational"]) {
      const pubkey = keyData.agents?.[role]?.pubkey;
      if (!pubkey) throw new Error(`generate-agent-keys did not return ${role}`);
      agents[role] = pubkey;
    }
    const agentKeys = Object.values(agents).map((value) => new PublicKey(value));
    state.daoId = daoId;
    state.dao = dao.toBase58();
    state.agents = agents;
    saveState(state);
    console.log(`  dao id ${daoId} ${dao.toBase58()}`);
    console.log(`  agents ${agentKeys.map((key) => key.toBase58()).join(" ")}`);
    const params = daoParams(daoId, agentKeys);
    const init = await buildInitializeDao(founder.publicKey, global.treasury, daoId, params);
    init.preInstructions = agentKeys.map((agent) => SystemProgram.transfer({
      fromPubkey: founder.publicKey,
      toPubkey: agent,
      lamports: 20_000_000,
    }));
    await note("initializeDao", await sendTx(connection, founder, [init]));
  }

  const createdDao = new PublicKey(state.dao);
  const createdId = state.daoId;
  const createdAgents = Object.values(state.agents).map((value) => new PublicKey(value));
  const createdParams = daoParams(createdId, createdAgents);
  if (!state.sigs.initializeExtensions) {
    const { getVaultAuthorityPDA } = await import("../src/lib/pdaDerivation.ts");
    const [vaultAuthority] = getVaultAuthorityPDA(createdDao);
    const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuthority, true);
    const ext = await buildInitializeDaoExtensions(founder.publicKey, createdId, NATIVE_MINT, createdParams);
    ext.preInstructions = [
      createAssociatedTokenAccountIdempotentInstruction(founder.publicKey, vaultAta, vaultAuthority, NATIVE_MINT),
    ];
    await note("initializeExtensions", await sendTx(connection, founder, [ext]));
  }
  if (!state.sigs.initializeGovernance) {
    const gov = await buildInitializeDaoGovernance(founder.publicKey, createdId, createdParams);
    await note("initializeGovernance", await sendTx(connection, founder, [gov]));
  }

  const dao = new PublicKey(state.dao);
  const daoId = state.daoId;
  const registry = await core.account.daoRegistry.fetch(dao);
  state.agentsEnabledAtCreate = Boolean(registry.agentsEnabled);
  const [constitutionPda] = getConstitutionPDA(dao);
  const constitution = await core.account.treasuryConstitution.fetch(constitutionPda);
  state.reviewWindowSecs = Number(constitution.reviewWindowSecs);
  console.log(`  agentsEnabled ${state.agentsEnabledAtCreate} reviewWindow ${state.reviewWindowSecs}`);
  saveState(state);

  for (const guardian of guardians) {
    const balance = await connection.getBalance(guardian.publicKey);
    if (balance < 20_000_000) {
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: founder.publicKey,
        toPubkey: guardian.publicKey,
        lamports: 50_000_000,
      }));
      await note(`fundGuardian${guardian.publicKey.toBase58().slice(0, 4)}`, await sendTx(connection, founder, [{ instruction: tx.instructions[0] }]));
    }
  }

  if (!state.sigs.enableAgents) {
    if (state.agentsEnabledAtCreate) throw new Error("new DAO agents were already enabled");
    const message = `nave-admin|${dao.toBase58()}|toggle_agents|1|${Date.now()}`;
    const data = await edge(SUPABASE_FUNCTIONS_URL, SUPABASE_ANON_KEY, "agent-admin", {
      dao_address: dao.toBase58(),
      wallet: founder.publicKey.toBase58(),
      message,
      signature: signEd(founder, message),
      enabled: true,
    });
    const sigs = signaturesFrom(data);
    state.sigs.enableAgents = sigs[0]?.signature || data.signature || "submitted";
    state.enableAgentsResponse = { success: data.success !== false, signatures: sigs };
    saveState(state);
    console.log(`  tx enableAgents ${state.sigs.enableAgents}`);
  }

  if (!state.sigs.deposit) {
    const seeded = await buildSeedTreasuryWsol(dao, founder.publicKey, DEPOSIT_LAMPORTS, PYTH_SOL);
    await note("registerAsset", await sendTx(connection, founder, [seeded.register]));
    await note("deposit", await sendTx(connection, founder, [seeded.deposit]));
    if (seeded.revalue?.instruction) {
      try {
        await note("revalue", await sendTx(connection, founder, [seeded.revalue]));
      } catch (error) {
        console.log(`  revalue skipped: ${short(error)}`);
      }
    }
  }

  const [vaultPda] = (await import("../src/lib/pdaDerivation.ts")).getTreasuryVaultPDA(dao);
  const vault = await core.account.treasuryVault.fetch(vaultPda);
  const nav = BigInt(vault.currentNav?.toString?.() || "0");
  state.nav = nav.toString();
  const threshold = nav > 1_000_000n ? 1_000_000 : 0;
  state.agentThresholdUsdMicro = threshold;
  if (!state.sigs.constitution) {
    const update = await buildUpdateConstitution(dao, founder.publicKey, [{
      protocolId: "jito",
      programId: NAVE_JITO_ADAPTER_ID,
      maxAllocationBps: 5000,
      approved: true,
    }], 70, threshold);
    const policy = await buildSetPolicyParameters(dao, founder.publicKey, 0, 5000, 2000, 30 * 86400);
    await note("constitution", await sendTx(connection, founder, [update, policy]));
  }

  if (!state.sigs.initEscrow) {
    const position = await buildInitStrategyPosition(dao, founder.publicKey, "jito", WSOL_MINT);
    const escrow = await buildInitStrategyEscrow(dao, founder.publicKey, "jito", WSOL_MINT);
    const targets = await buildConfigurePositionTargets(
      dao,
      founder.publicKey,
      "jito",
      WSOL_MINT,
      POOL_MINT,
      STAKE_POOL,
      STAKE_RESERVE,
    );
    try {
      await note("initPosition", await sendTx(connection, founder, [position]));
    } catch (error) {
      console.log(`  initPosition: ${short(error)}`);
    }
    await note("initEscrow", await sendTx(connection, founder, [escrow]));
    await note("configureJito", await sendTx(connection, founder, [targets]));
  }

  const [proposalPda] = getProposalPDA(dao, 0);
  if (!state.sigs.createProposal) {
    const payload = encodeStrategyProposalPayload(NAVE_JITO_ADAPTER_ID, DEPLOY_LAMPORTS, WSOL_MINT);
    const create = await buildCreateProposal(dao, 0, founder.publicKey, {
      title: "deploy-jito",
      description: "live devnet treasury check",
      payload,
      proposalType: 1,
      votingPeriodSeconds: 60,
    }, NATIVE_MINT);
    await note("createProposal", await sendTx(connection, founder, [create]));
    const first = await buildCastVoteWallet(dao, 0, guardians[0].publicKey, 0);
    await note("firstVote", await sendTx(connection, guardians[0], [first]));
    try {
      const unexpected = await sendTx(connection, founder, [await buildFinalizeProposal(dao, 0, founder.publicKey)], [], { skipPreflight: true });
      throw new Error(`one guardian finalized unexpectedly ${unexpected}`);
    } catch (error) {
      if (String(error.message).includes("unexpectedly")) throw error;
      state.oneGuardianRevert = error.signature || short(error);
      saveState(state);
      console.log(`  expected revert one-guardian finalize ${state.oneGuardianRevert}`);
    }
    const second = await buildCastVoteWallet(dao, 0, founder.publicKey, 0);
    await note("secondVote", await sendTx(connection, founder, [second]));
    const fin = await buildFinalizeProposal(dao, 0, founder.publicKey);
    await note("finalize", await sendTx(connection, founder, [fin]));
  }
  const proposal = await governance.account.proposal.fetch(proposalPda);
  state.proposalStatus = Number(proposal.status);
  console.log(`  proposal status ${state.proposalStatus}`);
  if (state.proposalStatus !== 1 && state.proposalStatus !== 4) {
    throw new Error(`proposal status ${state.proposalStatus}`);
  }

  const [er] = getExecutionRequestPDA(proposalPda);
  state.executionRequest = er.toBase58();
  if (!state.sigs.createExecutionRequest) {
    const request = await buildCreateExecutionRequest(
      dao,
      proposalPda,
      founder.publicKey,
      DEPLOY_LAMPORTS,
      NAVE_JITO_ADAPTER_ID,
      WSOL_MINT,
      false,
    );
    await note("createExecutionRequest", await sendTx(connection, founder, [request]));
  }

  if (state.reviewWindowSecs !== 60) {
    state.blocker = `stored review window is ${state.reviewWindowSecs}s; not shortening it, so Jito execute is not due yet`;
    saveState(state);
    console.log(`BLOCKED ${state.blocker}`);
    return;
  }

  const dispatch = async (target) => {
    const message = `nave-dispatch|${dao.toBase58()}|${target}|${Date.now()}`;
    const body = {
      dao_address: dao.toBase58(),
      wallet: founder.publicKey.toBase58(),
      message,
      signature: signEd(founder, message),
    };
    if (target !== "poll") body.execution_request_address = target;
    return edge(SUPABASE_FUNCTIONS_URL, SUPABASE_ANON_KEY, "orchestrator-proxy", body);
  };

  if (!state.orchestrated) {
    const first = await dispatch(er.toBase58());
    state.orchestratorSignatures = signaturesFrom(first);
    state.orchestratorErrors = first.errors || first.error || null;
    saveState(state);
    console.log(`  orchestrator signatures ${state.orchestratorSignatures.length}`);
    const request = await (await import("../src/lib/naveProgram.ts")).getNavePrograms(connection).execution.account.executionRequest.fetch(er);
    const reviewEnd = Number(request.reviewEnd || 0);
    const waitMs = Math.max(0, reviewEnd * 1000 - Date.now()) + 5000;
    if (waitMs > 0 && waitMs < 180_000) {
      console.log(`  waiting ${Math.round(waitMs / 1000)}s review window`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const second = await dispatch(er.toBase58());
      state.orchestratorSignatures.push(...signaturesFrom(second));
      state.orchestratorErrors = second.errors || state.orchestratorErrors;
    }
    state.orchestrated = true;
    saveState(state);
  }

  const after = await (await import("../src/lib/naveProgram.ts")).getNavePrograms(connection).execution.account.executionRequest.fetch(er);
  state.executionStatus = Number(after.status);
  saveState(state);
  console.log(`  execution status ${state.executionStatus}`);
  console.log(`STATE ${STATE_PATH}`);
}

main().catch((error) => {
  const message = String(error?.message || error).replace(/https?:\/\/\S+/g, "[endpoint]");
  console.error(`FAIL solana: ${message.slice(0, 2500)}`);
  const logs = error?.logs || error?.transactionLogs;
  if (Array.isArray(logs)) console.error(logs.slice(-15).join("\n"));
  process.exitCode = 1;
});
