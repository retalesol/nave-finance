#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";

const { AnchorProvider, BN, Program, Wallet } = anchorPkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TARGET_DEPLOY_DIR = join(ROOT, "target", "deploy");
const TARGET_IDL_DIR = join(ROOT, "target", "idl");
const DEPLOYMENTS_DIR = join(ROOT, "deployments");
const MAINNET_DEPLOYMENT_PATH = join(DEPLOYMENTS_DIR, "mainnet.json");
const MAINNET_LAUNCH_ARTIFACT_PATH = join(DEPLOYMENTS_DIR, "mainnet-launch-artifact.json");
const PROGRAM_ENV_PATH = join(DEPLOYMENTS_DIR, "mainnet-program-ids.env");
const KNOWN_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
// ── Formation fee (unified DAO creation flow) ─────────────────────────────────
// DEPRECATED ECONOMICS — creation charges no protocol fee. The protocol takes no
// SOL profit at DAO creation: `initialize_dao` performs NO SOL transfer and
// `nave_core::FORMATION_FEE_LAMPORTS` is 0 on every network. Forming a treasury
// does not lock NAVE. Gas and rent only. A founder may still deposit their own
// assets as a seed; that is not a fee. The constant below is retained ONLY so
// this script keeps writing a value to `global_config.formation_fee_lamports`
// (the field still exists for layout compatibility); that value is INERT.
//
// NAVE STAKE GATE: this script now pins the canonical mainnet NAVE mint via
// `set_nave_mint(EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory)` in the
// deploy-contracts phase (and as a standalone `set-nave-mint` phase). Once
// pinned, `stake_dao_creation` requires the staked mint to match it. The
// matching EVM stake config (`NaveProtocol.setNaveStakeConfig` + `setDaoStake`)
// is handled by `evm-mainnet-cutover.mjs --phase stake`.
//
// STRUCTURAL BACKSTOP (nave_core, added alongside the MarginFi/guardrail audit
// pass): `stake_dao_creation` now HARD-REJECTS (`StakeMintUnset`) any stake
// when `global_config.nave_mint` is unset AND the program was built with
// `--features mainnet` (the only feature set `build.sh --features mainnet` /
// this script's deploy phase ever produces). The devnet/test any-mint fallback
// is therefore unreachable on a real mainnet build regardless of run order —
// this script's `set_nave_mint` step remains required (mainnet builds simply
// can no longer silently skip it), it is just no longer the ONLY thing
// preventing an arbitrary-mint stake on mainnet.
const MAINNET_FORMATION_FEE_LAMPORTS = 0; // fee-free creation (value is inert on-chain)
const MAINNET_TREASURY_SEED_LAMPORTS = 0; // no fee carve-out; user seed is separate
const DEFAULT_FORMATION_FEE_LAMPORTS = MAINNET_FORMATION_FEE_LAMPORTS;
const DEFAULT_MAX_SIGN_ATTEMPTS = 100;

// Canonical mainnet NAVE SPL mint. New treasuries do not lock it. The mint stays
// pinned so an existing lock can still be identified. The devnet replica mint
// (GmBM…) MUST NEVER appear on the mainnet path. Required stake is 0.
const MAINNET_NAVE_MINT = "EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory";
const DAO_STAKE_TARGET_USD = 0;

// BPF Upgradeable Loader — owner of every upgradeable program's ProgramData
// account. `initialize_global_config` now requires the program + its ProgramData
// account and gates on `program_data.upgrade_authority == authority`, so the init
// step MUST run as the upgrade authority (the deploy wallet, pre-handoff) and
// supply both accounts.
const BPF_UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

// Audit-revision on-chain constants surfaced in the cutover summary so the
// operator/integration worker confirm the posture before launch. These mirror
// the program constants (authoritative on-chain):
//   nave_execution::NAV_MAX_STALENESS_SECS   = 900  (strategy deploys hard-block
//     on stale NAV; revalue_treasury must be fresh < 15 min before execute)
//   nave_core::PYTH_MAX_CONFIDENCE_BPS       = 200  (oracle confidence ceiling, 2%)
//   nave_core::GUARDIAN_ACTION_STALE_SECS    = 604800 (7-day guardian action expiry)
//   nave_core::MAX_POSITION_MARK_STEP_BPS    = 5000 (50% max single-call move on a
//     manual StrategyPosition.current_value mark — audit finding M8, 2026-06-30)
//   nave_core::POSITION_MARK_COOLDOWN_SECS   = 300 (5-min cooldown between marks)
const AUDIT_CONSTANTS = {
  navMaxStalenessSecs: 900,
  pythMaxConfidenceBps: 200,
  guardianActionStaleSecs: 604_800,
  maxPositionMarkStepBps: 5_000,
  positionMarkCooldownSecs: 300,
};

// Account size growth in this revision — relevant only for PRE-EXISTING devnet
// accounts created before the revision (fresh mainnet accounts are created at the
// new sizes). Documented here for any devnet→mainnet reconciliation.
const ACCOUNT_SIZE_GROWTH = {
  DaoRegistry: 8,
  GuardianAction: 1,
  TreasuryVault: 8,
};

// Yield-only treasury fee model (set per-DAO at creation, NOT by this script —
// recorded here so the app-side integration worker wires the right values):
//   - performance fee = 15% (1500 bps) of realized yield, skimmed on
//     record_strategy_withdrawal to the protocol revenue wallet's ATA.
//   - management fee   = 0. There is no annual collect.
// New required on-chain config the app/cutover must set at DAO creation:
//   InitializeDaoParams.protocol_revenue_wallet (non-zero Pubkey),
//   management_fee_bps = 0, performance_fee_bps = 1500. The revenue wallet must
//   have an ATA for each registered mint to receive the yield skim.
const FEE_MODEL = {
  performanceFeeBps: 1500,
  managementFeeBps: 0,
  managementFeePeriodSecs: 0,
  managementFeeAnchor: "none",
  // The protocol revenue wallet doubles as the protocol fee wallet env var.
  revenueWalletEnvVar: "VITE_NAVE_PROTOCOL_FEE_WALLET",
  paidInKind: true,
};

// Unified DAO creation + auto-activation flow (recorded in the manifest/artifact
// and surfaced in the cutover summary so the operator/integration worker confirm
// the posture). This script only deploys programs + global config; the per-DAO
// seed + bootstrap steps are orchestrated client-side at DAO creation:
//   - Formation fee charged on-chain (above); user treasury seed deposited
//     client-side separately (not part of the fee).
//   - Bootstrap activation: a one-time, founder-gated `create_execution_request`
//     (bootstrap=true) snapshots `review_window = 0` so the FIRST action deploys
//     immediately; the `dao_registry.bootstrap_used` latch blocks reuse. Emits
//     `DaoBootstrapUsed` + `BootstrapExecutionRequestCreated` for indexers.
//   - The review window is editable post-creation via `set_review_window`
//     (bounded MIN..MAX below).
const CREATION_FLOW = {
  formationFeeLamports: MAINNET_FORMATION_FEE_LAMPORTS,
  treasurySeedLamports: MAINNET_TREASURY_SEED_LAMPORTS,
  totalCarveoutLamports: MAINNET_FORMATION_FEE_LAMPORTS,
  userSeedAsset: "wSOL (AssetKind::SolLike) — user-chosen, not a fee carve-out",
  bootstrapImmediateFirstAction: true,
  bootstrapLatch: "dao_registry.bootstrap_used",
  reviewWindowSecs: { default: 86_400, min: 60, max: 604_800 },
};

// DAO creation does not lock NAVE. The mint may still be pinned so an existing
// lock can be released. Required amount is 0. Reopening does not restake.
const NAVE_STAKE = {
  mint: MAINNET_NAVE_MINT,
  stakeTargetUsd: DAO_STAKE_TARGET_USD,
  requiredStake: "0",
  pinnedVia: "set_nave_mint (global_config.authority-gated, pre-handoff)",
  amountSource: "none — forming a treasury does not require NAVE",
  moonlighting: "an existing lock, if any, is released on moonlight; restore_dao reopens without a new stake",
};

// Cutover scope: `bridge-stake` (default) ships ONLY nave_bridge + nave_staking
// so treasury/DAO programs stay on devnet until a later `--scope full` cutover.
// `full` adds the six DAO programs (nave_core … marginfi_adapter).
const CUTOVER_SCOPES = new Set(["bridge-stake", "full"]);
const DEFAULT_CUTOVER_SCOPE = "bridge-stake";

const DAO_PROGRAMS = [
  { name: "nave_core", so: "nave_core.so", keypair: "nave_core-keypair.json" },
  { name: "nave_governance", so: "nave_governance.so", keypair: "nave_governance-keypair.json" },
  { name: "nave_execution", so: "nave_execution.so", keypair: "nave_execution-keypair.json" },
  { name: "nave_jito_adapter", so: "nave_jito_adapter.so", keypair: "nave_jito_adapter-keypair.json" },
  { name: "nave_kamino_adapter", so: "nave_kamino_adapter.so", keypair: "nave_kamino_adapter-keypair.json" },
  { name: "nave_marginfi_adapter", so: "nave_marginfi_adapter.so", keypair: "nave_marginfi_adapter-keypair.json" },
];

const BRIDGE_STAKE_PROGRAMS = [
  // Bridge + staking (mainnet-hardened NAVE <-> wNAVE bridge). After deploy,
  // `initialize_config` / `initialize_pool` must be run with the LAUNCH values:
  //   nave_bridge.initialize_config(owner = Squads vault, relayer = KMS relayer
  //     pubkey, protocol_fee_owner = 6N5JiWP2zF6VXhG6hwgYEYhxBEARAV5P6WRgfYb2zskC
  //     (or BRIDGE_SOLANA_PROTOCOL_WALLET), staking_pool_owner = the RELAYER
  //     wallet that owns the neutral staking fee COLLECTOR token account (the
  //     1% staking leg lands there and the signer-service mirror splits it
  //     across chains by stake weight — NOT the nave_staking pool-authority
  //     PDA / reward vault), fee 250 bps split 100/100/50, per-tx + daily caps)
  //   nave_staking.initialize_pool(owner = Squads vault) — seeds the rolling
  //     365-day drip schedule (reward_duration = 31536000) itself; only a
  //     pre-drip pool ever needs the one-time `init_reward_schedule`.
  // Then create the collector (dedicated NAVE token account owned by the
  // relayer wallet — see scripts/staking-drip-cutover.mjs for the devnet
  // template) and carry it into the app/relayer env:
  //   BRIDGE_SOLANA_STAKING_COLLECTOR = BRIDGE_SOLANA_STAKING_POOL_ACCOUNT =
  //   VITE_NAVE_BRIDGE_STAKING_POOL_ACCOUNT = <collector>.
  { name: "nave_bridge", so: "nave_bridge.so", keypair: "nave_bridge-keypair.json" },
  { name: "nave_staking", so: "nave_staking.so", keypair: "nave_staking-keypair.json" },
];

function resolvePrograms(scope) {
  if (scope === "full") return [...DAO_PROGRAMS, ...BRIDGE_STAKE_PROGRAMS];
  return [...BRIDGE_STAKE_PROGRAMS];
}

function isBridgeStakeScope(scope) {
  return scope !== "full";
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    envPath: "",
    keyDir: "",
    phase: "all",
    scope: (process.env.CUTOVER_SCOPE || DEFAULT_CUTOVER_SCOPE).trim(),
    confirmMainnet: false,
    reuseProgramIds: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") out.envPath = args[++i];
    else if (arg === "--key-dir") out.keyDir = args[++i];
    else if (arg === "--phase") out.phase = args[++i];
    else if (arg === "--scope") out.scope = args[++i];
    else if (arg === "--confirm-mainnet") out.confirmMainnet = true;
    else if (arg === "--reuse-program-ids") out.reuseProgramIds = true;
  }

  if (!out.envPath) throw new Error("Missing required flag: --env <path>");
  if (!out.keyDir) throw new Error("Missing required flag: --key-dir <path>");
  if (!CUTOVER_SCOPES.has(out.scope)) {
    throw new Error(`Invalid --scope "${out.scope}" (allowed: bridge-stake, full).`);
  }
  if (!out.confirmMainnet) {
    throw new Error("Refusing to run mainnet flow without --confirm-mainnet.");
  }

  return out;
}

function parseEnvFile(path) {
  const raw = readFileSync(path, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    env[key] = val;
  }
  return env;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding ?? "utf8",
  });
  if (result.status !== 0) {
    const rendered = `${cmd} ${args.join(" ")}`;
    throw new Error(`Command failed (${rendered})`);
  }
  return result;
}

function runCapture(cmd, args, env) {
  const result = run(cmd, args, { stdio: "pipe", env });
  return result.stdout.trim();
}

function assertFileMode0600(path) {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) chmodSync(path, 0o600);
}

function ensureDir0700(path) {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);
}

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function parseProgramAuthority(programId, rpcUrl) {
  const show = runCapture("solana", ["program", "show", programId, "--url", rpcUrl], {});
  const match = show.match(/Authority:\s+([^\s]+)/);
  return match?.[1] ?? "unknown";
}

async function verifyMainnetRpc(rpcUrl) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getGenesisHash",
    params: [],
  };
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`RPC check failed with status ${resp.status}`);
  }
  const json = await resp.json();
  const hash = json?.result;
  if (!hash || !String(hash).startsWith(KNOWN_MAINNET_GENESIS_HASH)) {
    throw new Error(`RPC is not mainnet-beta (genesis hash: ${hash ?? "missing"})`);
  }
}

function requiredEnv(env) {
  const keys = [
    "MAINNET_RPC_URL",
    "DEPLOY_WALLET_PATH",
    "SQUADS_VAULT",
    "VITE_NAVE_PROTOCOL_FEE_WALLET",
  ];
  for (const key of keys) {
    if (!env[key]) throw new Error(`Missing required env var: ${key}`);
  }
}

function assertDistinctSecrets(env) {
  const a = env.NAVE_AGENT_SECRET ?? "";
  const b = env.NAVE_SIGNER_SECRET ?? "";
  const c = env.NAVE_INDEXER_SECRET ?? "";
  if (a && b && a === b) throw new Error("NAVE_AGENT_SECRET must differ from NAVE_SIGNER_SECRET");
  if (a && c && a === c) throw new Error("NAVE_AGENT_SECRET must differ from NAVE_INDEXER_SECRET");
  if (b && c && b === c) throw new Error("NAVE_SIGNER_SECRET must differ from NAVE_INDEXER_SECRET");
}

function assertRevalueKeeperCoverage(env) {
  const gate = (env.NAVE_REVALUE_TREASURY_KEEPER_CONFIRMED || "").trim().toLowerCase();
  if (gate !== "passed") {
    throw new Error(
      "NAVE_REVALUE_TREASURY_KEEPER_CONFIRMED=passed is required before mainnet cutover. " +
        "Strategy execution hard-blocks on stale NAV, so revalue_treasury keeper coverage must be proven before launch.",
    );
  }
}

// Mainnet SAFETY GATE for the formation fee + treasury seed constants. Creation
// is now FEE-FREE: `initialize_dao` performs no SOL transfer and the on-chain
// constant is 0, so `global_config.formation_fee_lamports` is inert. If an
// operator pins these env values they MUST be exact, fail closed otherwise:
//   - FORMATION_FEE_LAMPORTS (if set) MUST equal 0 (no protocol fee at formation).
//   - TREASURY_SEED_LAMPORTS (if set) MUST equal 0 (user seed is separate).
// Both are OPTIONAL: when unset the script writes 0 to the global config.
function assertFeeSplitConfig(env) {
  const feeRaw = (env.FORMATION_FEE_LAMPORTS ?? "").trim();
  if (feeRaw) {
    if (!/^[0-9]+$/.test(feeRaw)) {
      throw new Error(`FORMATION_FEE_LAMPORTS must be a non-negative integer (lamports), got "${feeRaw}".`);
    }
    if (Number(feeRaw) !== MAINNET_FORMATION_FEE_LAMPORTS) {
      throw new Error(
        `FORMATION_FEE_LAMPORTS ${feeRaw} must equal ${MAINNET_FORMATION_FEE_LAMPORTS} ` +
          "(creation charges no protocol fee; gas and rent only. Forming a treasury does not lock NAVE).",
      );
    }
  }
  const seedRaw = (env.TREASURY_SEED_LAMPORTS ?? "").trim();
  if (seedRaw) {
    if (!/^[0-9]+$/.test(seedRaw)) {
      throw new Error(`TREASURY_SEED_LAMPORTS must be a non-negative integer (lamports), got "${seedRaw}".`);
    }
    if (Number(seedRaw) !== MAINNET_TREASURY_SEED_LAMPORTS) {
      throw new Error(
        `TREASURY_SEED_LAMPORTS ${seedRaw} must equal ${MAINNET_TREASURY_SEED_LAMPORTS} ` +
          "(no fee carve-out; user seed is supplied separately in the creation wizard).",
      );
    }
  }
}

// Mainnet SAFETY GATE for the NAVE stake mint. The mainnet stake mint is the
// hardcoded constant above; an operator MAY pin `MAINNET_NAVE_MINT` in the env
// only to RE-CONFIRM it, in which case it MUST match exactly (fail closed). The
// devnet replica mint must NEVER reach the mainnet path. Fail closed otherwise.
const DEVNET_REPLICA_NAVE_MINT = "GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa";
function assertNaveMintConfig(env) {
  const raw = (env.MAINNET_NAVE_MINT ?? "").trim();
  if (raw && raw !== MAINNET_NAVE_MINT) {
    throw new Error(
      `MAINNET_NAVE_MINT ${raw} must equal the canonical mainnet NAVE mint ${MAINNET_NAVE_MINT}. ` +
        "The canonical NAVE mint is fixed on mainnet; refusing a mismatched mint.",
    );
  }
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.trim() === DEVNET_REPLICA_NAVE_MINT) {
      throw new Error(
        `Devnet replica NAVE mint ${DEVNET_REPLICA_NAVE_MINT} found in env var ${k}; ` +
          "it must NEVER appear on the mainnet cutover path.",
      );
    }
  }
}

function commandExists(cmd) {
  const result = spawnSync(cmd, ["--version"], {
    cwd: ROOT,
    env: process.env,
    stdio: "pipe",
    encoding: "utf8",
  });
  return !result.error && result.status === 0;
}

function preflight(env, args) {
  requiredEnv(env);
  assertDistinctSecrets(env);
  assertRevalueKeeperCoverage(env);
  assertFeeSplitConfig(env);
  assertNaveMintConfig(env);
  if (env.VITE_USE_MOCKS && env.VITE_USE_MOCKS !== "false") {
    throw new Error("VITE_USE_MOCKS must be false for mainnet.");
  }
  if (env.MAINNET_RPC_URL.includes("devnet")) {
    throw new Error("MAINNET_RPC_URL appears to be devnet.");
  }
  if (!existsSync(env.DEPLOY_WALLET_PATH)) {
    throw new Error(`Deploy wallet not found: ${env.DEPLOY_WALLET_PATH}`);
  }
  ensureDir0700(args.keyDir);
  run("solana", ["--version"]);
  run("anchor", ["--version"]);
  run("avm", ["--version"]);
  run("cargo", ["--version"]);
  // solana-verify is only required for `--phase verify` (on-chain hash checks).
  // Missing it must not block preflight/keys/build/deploy.
  if (!commandExists("solana-verify")) {
    console.warn(
      "\n  WARNING: solana-verify not found on PATH.\n" +
        "  Install before `--phase verify`: cargo install solana-verify --locked\n" +
        "  Continuing — deploy/upgrade does not need it.\n",
    );
  } else {
    run("solana-verify", ["--version"]);
  }
}

function generateProgramKeys(env, args) {
  const programs = resolvePrograms(args.scope);
  ensureDir0700(args.keyDir);
  ensureDir0700(TARGET_DEPLOY_DIR);
  for (const program of programs) {
    const securePath = join(args.keyDir, program.keypair);
    if (!existsSync(securePath)) {
      run("solana-keygen", [
        "new",
        "--silent",
        "--no-bip39-passphrase",
        "--outfile",
        securePath,
      ]);
    }
    assertFileMode0600(securePath);

    const targetPath = join(TARGET_DEPLOY_DIR, program.keypair);
    copyFileSync(securePath, targetPath);
    assertFileMode0600(targetPath);
  }

  if (!args.reuseProgramIds && args.scope === "full") {
    run("anchor", ["keys", "sync"]);
  }
}

function runMainnetBuildAndTests(env, scope) {
  if (isBridgeStakeScope(scope)) {
    // Bridge/stake-only: compile just the two programs (no nave_core mainnet feature).
    // cargo-build-sbf owns its own flags; package selectors must go after `--`.
    run("cargo", ["build-sbf", "--arch", "v3", "--", "-p", "nave_bridge", "-p", "nave_staking"]);
    if ((env.RUN_LOCALNET_TESTS ?? "").toLowerCase() === "true") {
      run("npm", ["run", "test:localnet", "--", "--grep", "bridge-staking"]);
    }
    return;
  }
  // Full scope: --features mainnet is REQUIRED for nave_core (Jupiter Lend program id).
  run("bash", [join(ROOT, "build.sh"), "--features", "mainnet"]);
  run("npm", ["run", "test:unit"]);
  if ((env.RUN_LOCALNET_TESTS ?? "").toLowerCase() === "true") {
    run("npm", ["run", "test:localnet", "--", "--grep", "beta-path"]);
  }
}

function resolveProtocolTreasury(env, fallbackPubkey) {
  const val = env.VITE_NAVE_PROTOCOL_FEE_WALLET?.trim();
  if (!val) return fallbackPubkey;
  return new PublicKey(val);
}

async function maybeInitializeGlobalConfig(env, deployed, deployWallet) {
  const idlPath = join(TARGET_IDL_DIR, "nave_core.json");
  if (!existsSync(idlPath)) {
    console.warn("Skipping global config init: target/idl/nave_core.json missing.");
    return null;
  }

  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  const connection = new Connection(env.MAINNET_RPC_URL, "confirmed");
  const wallet = new Wallet(deployWallet);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const coreProgramId = new PublicKey(deployed.nave_core);
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    coreProgramId,
  );
  const existing = await connection.getAccountInfo(globalConfig);
  if (existing) return globalConfig.toBase58();

  // `initialize_global_config` is now UPGRADE-AUTHORITY gated: it requires the
  // program + its ProgramData account and asserts
  // `program_data.upgrade_authority == authority`. This init MUST therefore run
  // as the upgrade authority (the deploy wallet, BEFORE the authority handoff to
  // the Squads vault). Derive ProgramData (PDA of the BPF Upgradeable Loader) and
  // verify the deploy wallet is still the upgrade authority — fail closed.
  const [programData] = PublicKey.findProgramAddressSync(
    [coreProgramId.toBuffer()],
    new PublicKey(BPF_UPGRADEABLE_LOADER_ID),
  );
  const currentAuthority = parseProgramAuthority(coreProgramId.toBase58(), env.MAINNET_RPC_URL);
  if (currentAuthority !== deployWallet.publicKey.toBase58()) {
    throw new Error(
      `Refusing to initialize_global_config: nave_core upgrade authority is ${currentAuthority}, ` +
        `expected the deploy wallet ${deployWallet.publicKey.toBase58()}. ` +
        "Run init BEFORE handoff-authority (the on-chain instruction requires the upgrade authority to sign).",
    );
  }

  const protocolTreasury = resolveProtocolTreasury(env, deployWallet.publicKey);
  const formationFee = Number(env.FORMATION_FEE_LAMPORTS ?? DEFAULT_FORMATION_FEE_LAMPORTS);
  await program.methods
    .initializeGlobalConfig(new BN(formationFee))
    .accounts({
      authority: deployWallet.publicKey,
      treasury: protocolTreasury,
      globalConfig,
      program: coreProgramId,
      programData,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return globalConfig.toBase58();
}

// Pin the canonical mainnet NAVE stake mint on-chain via `set_nave_mint`. This
// is `global_config.authority`-gated (NOT upgrade-authority gated), so it MUST
// run as the global-config authority — the deploy wallet, set at
// `initialize_global_config`, BEFORE any authority handoff. Fail closed if the
// deploy wallet is not the global-config authority, or if the on-chain mint does
// not match the canonical mainnet mint after the call. Idempotent: skips when it
// is already pinned to the correct mint.
async function pinNaveStakeMint(env, deployed, deployWallet) {
  const idlPath = join(TARGET_IDL_DIR, "nave_core.json");
  if (!existsSync(idlPath)) {
    throw new Error("Cannot set_nave_mint: target/idl/nave_core.json missing (run build first).");
  }
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  const connection = new Connection(env.MAINNET_RPC_URL, "confirmed");
  const wallet = new Wallet(deployWallet);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const coreProgramId = new PublicKey(deployed.nave_core);
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    coreProgramId,
  );

  const cfg = await program.account.naveGlobalConfig.fetch(globalConfig);
  const naveMint = new PublicKey(MAINNET_NAVE_MINT);
  if (cfg.naveMint && new PublicKey(cfg.naveMint).equals(naveMint)) {
    return MAINNET_NAVE_MINT; // already pinned
  }
  if (cfg.authority.toBase58() !== deployWallet.publicKey.toBase58()) {
    throw new Error(
      `Refusing set_nave_mint: global_config.authority is ${cfg.authority.toBase58()}, ` +
        `expected the deploy wallet ${deployWallet.publicKey.toBase58()}. ` +
        "set_nave_mint is authority-gated; run it BEFORE the authority handoff.",
    );
  }

  await program.methods
    .setNaveMint(naveMint)
    .accounts({ authority: deployWallet.publicKey, globalConfig })
    .rpc();

  const after = await program.account.naveGlobalConfig.fetch(globalConfig);
  if (!new PublicKey(after.naveMint).equals(naveMint)) {
    throw new Error(
      `set_nave_mint verification failed: on-chain nave_mint is ${new PublicKey(after.naveMint).toBase58()}, ` +
        `expected ${MAINNET_NAVE_MINT}.`,
    );
  }
  return MAINNET_NAVE_MINT;
}

function deployPrograms(env, scope) {
  const deployed = {};
  const maxAttempts = String(env.SOLANA_DEPLOY_MAX_SIGN_ATTEMPTS ?? DEFAULT_MAX_SIGN_ATTEMPTS);
  const cuPrice = env.SOLANA_DEPLOY_CU_PRICE_MICROLAMPORTS?.trim();

  for (const program of resolvePrograms(scope)) {
    const soPath = join(TARGET_DEPLOY_DIR, program.so);
    const keypairPath = join(TARGET_DEPLOY_DIR, program.keypair);
    if (!existsSync(soPath)) throw new Error(`Missing binary: ${soPath}`);
    if (!existsSync(keypairPath)) throw new Error(`Missing program keypair: ${keypairPath}`);

    const deployArgs = [
      "program",
      "deploy",
      soPath,
      "--program-id",
      keypairPath,
      "--url",
      env.MAINNET_RPC_URL,
      "--keypair",
      env.DEPLOY_WALLET_PATH,
      "--max-sign-attempts",
      maxAttempts,
    ];
    if (cuPrice) {
      deployArgs.push("--with-compute-unit-price", cuPrice);
    }
    run("solana", deployArgs);
    const id = runCapture("solana-keygen", ["pubkey", keypairPath], env);
    deployed[program.name] = id;
  }
  return deployed;
}

function writeProgramEnv(deployed, scope) {
  const lines = [];
  if (!isBridgeStakeScope(scope)) {
    lines.push(
      `VITE_NAVE_CORE_PROGRAM_ID=${deployed.nave_core}`,
      `VITE_NAVE_GOVERNANCE_PROGRAM_ID=${deployed.nave_governance}`,
      `VITE_NAVE_EXECUTION_PROGRAM_ID=${deployed.nave_execution}`,
      `VITE_NAVE_JITO_ADAPTER_ID=${deployed.nave_jito_adapter}`,
      `VITE_NAVE_KAMINO_ADAPTER_ID=${deployed.nave_kamino_adapter}`,
      `VITE_NAVE_MARGINFI_ADAPTER_ID=${deployed.nave_marginfi_adapter}`,
      `NAVE_CORE_PROGRAM_ID=${deployed.nave_core}`,
      `NAVE_GOVERNANCE_PROGRAM_ID=${deployed.nave_governance}`,
      `NAVE_EXECUTION_PROGRAM_ID=${deployed.nave_execution}`,
      `NAVE_JITO_ADAPTER_ID=${deployed.nave_jito_adapter}`,
      `NAVE_KAMINO_ADAPTER_ID=${deployed.nave_kamino_adapter}`,
      `NAVE_MARGINFI_ADAPTER_ID=${deployed.nave_marginfi_adapter}`,
    );
  }
  lines.push(
    `VITE_NAVE_BRIDGE_PROGRAM_ID=${deployed.nave_bridge}`,
    `VITE_NAVE_STAKING_PROGRAM_ID=${deployed.nave_staking}`,
    `BRIDGE_SOLANA_BRIDGE_PROGRAM=${deployed.nave_bridge}`,
    `NAVE_STAKING_PROGRAM_ID=${deployed.nave_staking}`,
    "",
  );
  mkdirSync(dirname(PROGRAM_ENV_PATH), { recursive: true });
  writeFileSync(PROGRAM_ENV_PATH, lines.join("\n"));
}

function writeDeploymentManifest(env, deployed, scope, globalConfig, deployWalletPubkey, naveStakeMint) {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const payload = {
    cluster: "mainnet-beta",
    scope,
    rpc: env.MAINNET_RPC_URL,
    deployedAt: new Date().toISOString(),
    authority: deployWalletPubkey,
    treasury: env.VITE_NAVE_PROTOCOL_FEE_WALLET,
    programs: deployed,
  };
  if (!isBridgeStakeScope(scope)) {
    payload.globalConfig = globalConfig;
    payload.creationFlow = CREATION_FLOW;
    payload.naveStake = { ...NAVE_STAKE, pinned: naveStakeMint === NAVE_STAKE.mint };
  }
  writeFileSync(MAINNET_DEPLOYMENT_PATH, JSON.stringify(payload, null, 2));
}

// ── Bridge/staking on-chain ownership assertion (audit P1) ────────────────────
// The bridge/staking config `owner` is set to the Squads vault at
// `initialize_config` / `initialize_pool` (see the PROGRAMS comment). This
// fail-closed check reads the live accounts and enforces the P1 invariant that
// the multisig owner is present AND distinct from the relayer hot key, so a
// misconfigured init (or an owner left as the deploy/relayer key) can never pass
// the cutover. Byte offsets mirror BridgeConfig / StakePool in
// programs/nave_{bridge,staking}/src/state.rs (disc 8 + bump 1, then pubkeys).
const BRIDGE_CONFIG_SEED = "bridge_config";
const STAKE_POOL_SEED = "stake_pool";
const ACCOUNT_OWNER_OFFSET = 9; // 8 (discriminator) + 1 (bump)
const BRIDGE_RELAYER_OFFSET = 9 + 32 + 32; // after owner + pending_owner
// BridgeConfig layout (programs/nave_bridge/src/state.rs): fields after
// outbound_nonce + reserved[64] are the outbound lock guardrails.
const BRIDGE_LOCK_DAILY_CAP_OFFSET = 347;
const BRIDGE_ALLOWED_DEST_OFFSET = 371;
const BRIDGE_MAX_ALLOWED_DEST_CHAINS = 8;

function decodePubkeyAt(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

async function assertBridgeAndStakingOwnership(env, deployed) {
  const connection = new Connection(env.MAINNET_RPC_URL, "confirmed");
  const squads = env.SQUADS_VAULT;
  const result = {};

  const bridgeProgram = deployed.nave_bridge;
  if (bridgeProgram) {
    const programId = new PublicKey(bridgeProgram);
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from(BRIDGE_CONFIG_SEED)], programId);
    const info = await connection.getAccountInfo(configPda);
    if (!info) {
      throw new Error(
        `nave_bridge BridgeConfig ${configPda.toBase58()} not found — run initialize_config ` +
          "(owner = Squads vault, relayer = hot key) BEFORE verify.",
      );
    }
    const owner = decodePubkeyAt(info.data, ACCOUNT_OWNER_OFFSET);
    const pendingOwner = decodePubkeyAt(info.data, ACCOUNT_OWNER_OFFSET + 32);
    const relayer = decodePubkeyAt(info.data, BRIDGE_RELAYER_OFFSET);
    if (owner !== squads && pendingOwner !== squads) {
      throw new Error(
        `P1 violation: nave_bridge owner ${owner} (pending ${pendingOwner}) is neither the Squads vault ${squads}. ` +
          "The bridge must be owned by (or pending to) the multisig before mainnet value flows.",
      );
    }
    if (owner === relayer) {
      throw new Error(
        `P1 violation: nave_bridge owner ${owner} equals the relayer hot key. ` +
          "Owner and relayer must be distinct keys (a compromised relayer must not control caps/pause).",
      );
    }
    if (relayer === squads) {
      throw new Error(`P1 violation: nave_bridge relayer equals the Squads vault ${squads}. The relayer must be a distinct hot key.`);
    }
    if (info.data.length < BRIDGE_ALLOWED_DEST_OFFSET + 8 * BRIDGE_MAX_ALLOWED_DEST_CHAINS) {
      throw new Error(
        `nave_bridge BridgeConfig ${configPda.toBase58()} is a pre-hardening layout ` +
          `(${info.data.length} bytes). Redeploy the program that appends lock_daily_cap + allowed_dest_chains.`,
      );
    }
    const lockDailyCap = info.data.readBigUInt64LE(BRIDGE_LOCK_DAILY_CAP_OFFSET);
    const destChains = [];
    for (let i = 0; i < BRIDGE_MAX_ALLOWED_DEST_CHAINS; i++) {
      const id = info.data.readBigUInt64LE(BRIDGE_ALLOWED_DEST_OFFSET + i * 8);
      if (id !== 0n) destChains.push(id.toString());
    }
    if (lockDailyCap === 0n) {
      throw new Error(
        "nave_bridge lock_daily_cap is 0 (unlimited outbound). Call set_lock_daily_cap before verify — " +
          "an unbounded lock window lets a compromised or buggy client drain custody in one day.",
      );
    }
    if (destChains.length === 0) {
      throw new Error(
        "nave_bridge allowed_dest_chains is empty — every lock is rejected, and that is the fail-closed " +
          "default. Owner must call set_dest_chain_allowed(chain_id, true) for each served EVM id " +
          "(mainnet: 1, 8453, 4663) BEFORE verify.",
      );
    }
    result.bridge = { config: configPda.toBase58(), owner, pendingOwner, relayer, lockDailyCap: lockDailyCap.toString(), destChains };
    console.log(`  nave_bridge owner=${owner} pending=${pendingOwner} relayer=${relayer} (P1 separation OK).`);
    console.log(`  nave_bridge lock_daily_cap=${lockDailyCap} dest_chains=[${destChains.join(",")}]`);
  }

  const stakingProgram = deployed.nave_staking;
  if (stakingProgram) {
    const programId = new PublicKey(stakingProgram);
    const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from(STAKE_POOL_SEED)], programId);
    const info = await connection.getAccountInfo(poolPda);
    if (!info) {
      throw new Error(
        `nave_staking StakePool ${poolPda.toBase58()} not found — run initialize_pool (owner = Squads vault) BEFORE verify.`,
      );
    }
    const owner = decodePubkeyAt(info.data, ACCOUNT_OWNER_OFFSET);
    const pendingOwner = decodePubkeyAt(info.data, ACCOUNT_OWNER_OFFSET + 32);
    if (owner !== squads && pendingOwner !== squads) {
      throw new Error(
        `P1 violation: nave_staking owner ${owner} (pending ${pendingOwner}) is neither the Squads vault ${squads}.`,
      );
    }
    result.staking = { pool: poolPda.toBase58(), owner, pendingOwner };
    console.log(`  nave_staking owner=${owner} pending=${pendingOwner} (Squads ownership OK).`);
  }

  return result;
}

function authorityHandoff(env, deployed) {
  const verified = {};
  for (const [, programId] of Object.entries(deployed)) {
    run("solana", [
      "program",
      "set-upgrade-authority",
      programId,
      "--new-upgrade-authority",
      env.SQUADS_VAULT,
      "--keypair",
      env.DEPLOY_WALLET_PATH,
      "--url",
      env.MAINNET_RPC_URL,
    ]);
    const authority = parseProgramAuthority(programId, env.MAINNET_RPC_URL);
    if (authority !== env.SQUADS_VAULT) {
      throw new Error(`Authority handoff failed for ${programId}: got ${authority}`);
    }
    verified[programId] = authority;
  }
  return verified;
}

function verifyPrograms(env, deployed) {
  if (!commandExists("solana-verify")) {
    throw new Error(
      "solana-verify is required for --phase verify but was not found on PATH. " +
        "Install with: cargo install solana-verify --locked",
    );
  }
  const hashes = {};
  for (const [, programId] of Object.entries(deployed)) {
    const out = runCapture("solana-verify", ["get-program-hash", "-u", env.MAINNET_RPC_URL, programId], env);
    hashes[programId] = out;
  }
  return hashes;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeLaunchArtifact(env, deployed, scope, authorities, verifyHashes, checks) {
  const gitCommit = runCapture("git", ["rev-parse", "HEAD"], env);
  const artifact = {
    generatedAt: new Date().toISOString(),
    gitCommit,
    network: "mainnet-beta",
    scope,
    rpcUrl: env.MAINNET_RPC_URL,
    programs: deployed,
    authorities: {
      expectedMultisig: env.SQUADS_VAULT,
      verified: authorities,
    },
    supabase: {
      projectRef: env.SUPABASE_PROJECT_REF ?? "",
      url: env.VITE_SUPABASE_URL ?? "",
    },
    webhook: {
      id: env.HELIUS_WEBHOOK_ID ?? "",
      network: "mainnet",
    },
    checks,
    verifyHashes,
  };
  if (!isBridgeStakeScope(scope)) {
    artifact.creationFlow = CREATION_FLOW;
    artifact.naveStake = { ...NAVE_STAKE, pinned: Boolean(checks.naveStakePinned) };
  }
  writeFileSync(MAINNET_LAUNCH_ARTIFACT_PATH, JSON.stringify(artifact, null, 2));
}

async function main() {
  const args = parseArgs();
  const env = parseEnvFile(resolve(args.envPath));
  const phase = args.phase;
  const runAll = phase === "all";
  const bridgeStakeOnly = isBridgeStakeScope(args.scope);
  const checks = {
    scope: args.scope,
    contractsPreflight: false,
    contractsBuild: false,
    contractsDeploy: false,
    naveStakePinned: false,
    authorityHandoff: false,
    contractsVerify: false,
  };

  console.log(`\nNave Solana cutover — scope=${args.scope} phase=${phase}`);

  if (runAll || phase === "preflight") {
    preflight(env, args);
    await verifyMainnetRpc(env.MAINNET_RPC_URL);
    checks.contractsPreflight = true;
  }
  if (runAll || phase === "keys") {
    generateProgramKeys(env, args);
  }
  if (runAll || phase === "build") {
    runMainnetBuildAndTests(env, args.scope);
    checks.contractsBuild = true;
  }

  let deployment = readJsonIfExists(MAINNET_DEPLOYMENT_PATH);
  const deployWallet = loadKeypair(env.DEPLOY_WALLET_PATH);
  if (runAll || phase === "deploy-contracts") {
    const deployed = deployPrograms(env, args.scope);
    let globalConfig = null;
    let naveStakeMint = null;
    if (!bridgeStakeOnly) {
      globalConfig = await maybeInitializeGlobalConfig(env, deployed, deployWallet);
      naveStakeMint = await pinNaveStakeMint(env, deployed, deployWallet);
      checks.naveStakePinned = naveStakeMint === NAVE_STAKE.mint;
    }
    writeProgramEnv(deployed, args.scope);
    writeDeploymentManifest(env, deployed, args.scope, globalConfig, deployWallet.publicKey.toBase58(), naveStakeMint);
    deployment = readJsonIfExists(MAINNET_DEPLOYMENT_PATH);
    checks.contractsDeploy = true;
  }

  // preflight / keys / build do not need a deployment manifest.
  const needsDeployment = runAll || ["deploy-contracts", "set-nave-mint", "handoff-authority", "verify"].includes(phase);
  if (needsDeployment && !deployment?.programs) {
    throw new Error("No deployment manifest found. Run deploy-contracts first.");
  }
  if (!needsDeployment) {
    console.log(`\nContracts mainnet phase complete (phase=${phase}; no deployment manifest required).`);
    return;
  }

  if (phase === "set-nave-mint") {
    if (bridgeStakeOnly) {
      throw new Error("set-nave-mint is only available in --scope full (requires nave_core).");
    }
    const naveStakeMint = await pinNaveStakeMint(env, deployment.programs, deployWallet);
    checks.naveStakePinned = naveStakeMint === NAVE_STAKE.mint;
    writeDeploymentManifest(
      env,
      deployment.programs,
      args.scope,
      deployment.globalConfig ?? null,
      deployment.authority ?? deployWallet.publicKey.toBase58(),
      naveStakeMint,
    );
    deployment = readJsonIfExists(MAINNET_DEPLOYMENT_PATH);
    console.log(`\nNAVE stake mint pinned on-chain: ${naveStakeMint}`);
  }

  let authorities = {};
  if (runAll || phase === "handoff-authority") {
    authorities = authorityHandoff(env, deployment.programs);
    checks.authorityHandoff = true;
  } else {
    for (const [, programId] of Object.entries(deployment.programs)) {
      authorities[programId] = parseProgramAuthority(programId, env.MAINNET_RPC_URL);
    }
  }

  let verifyHashes = {};
  if (runAll || phase === "verify") {
    verifyHashes = verifyPrograms(env, deployment.programs);
    // P1: fail closed unless the bridge/staking config is owned by (or pending
    // to) the Squads vault AND the owner is distinct from the relayer hot key.
    checks.bridgeOwnership = await assertBridgeAndStakingOwnership(env, deployment.programs);
    checks.bridgeOwnershipVerified = true;
    checks.contractsVerify = true;
  }

  writeLaunchArtifact(env, deployment.programs, args.scope, authorities, verifyHashes, checks);

  console.log("\nContracts mainnet phase complete.");
  console.log(`Scope:               ${args.scope}${bridgeStakeOnly ? " (nave_bridge + nave_staking only — treasury stays on devnet)" : ""}`);
  console.log(`Deployment manifest: ${MAINNET_DEPLOYMENT_PATH}`);
  console.log(`Program env file:    ${PROGRAM_ENV_PATH}`);
  console.log(`Launch artifact:     ${MAINNET_LAUNCH_ARTIFACT_PATH}`);

  if (!bridgeStakeOnly) {
    // Surface the redesigned fee-model config the app/integration worker must wire
    // per DAO (this script only deploys programs + global config; DAO-level fee
    // config is set at DAO creation, app-side).
    console.log("\nFee model — per-DAO on-chain config the integration worker MUST set:");
    console.log(`  protocol_revenue_wallet = ${env.VITE_NAVE_PROTOCOL_FEE_WALLET ?? "<unset>"} (${FEE_MODEL.revenueWalletEnvVar})`);
    console.log(`  performance_fee_bps     = ${FEE_MODEL.performanceFeeBps} (15% of realized yield, skimmed on withdrawal)`);
    console.log(`  management_fee_bps      = ${FEE_MODEL.managementFeeBps} (no annual fee)`);
    console.log("  + an ATA of protocol_revenue_wallet for each registered mint (receives the yield skim).");

    const sol = (lamports) => (lamports / 1_000_000_000).toFixed(3);
    console.log("\nUnified DAO creation flow (gas and rent only; no NAVE lock; optional founder seed + bootstrap):");
    console.log(
      `  formation fee (protocol):    ${CREATION_FLOW.formationFeeLamports} lamports (${sol(CREATION_FLOW.formationFeeLamports)} SOL) ` +
        "— no protocol fee: written to global_config.formation_fee_lamports but INERT (initialize_dao charges nothing). " +
        "Forming a treasury does not lock NAVE.",
    );
    console.log(
      `  treasury seed (per DAO):     ${CREATION_FLOW.treasurySeedLamports} lamports (${sol(CREATION_FLOW.treasurySeedLamports)} SOL) ` +
        `— user-chosen ${CREATION_FLOW.userSeedAsset}; deposited client-side (NOT part of the fee).`,
    );
    console.log(
      `  total protocol fee:          ${CREATION_FLOW.totalCarveoutLamports} lamports (${sol(CREATION_FLOW.totalCarveoutLamports)} SOL). ` +
        "Devnet: 0 protocol fee, and global_config.formation_fee_lamports MUST be 0 (on-chain .max(0)).",
    );
    console.log(
      "  bootstrap activation:        one-time founder-gated create_execution_request(bootstrap=true) snapshots " +
        `review_window=0 (immediate first action); ${CREATION_FLOW.bootstrapLatch} latch blocks reuse. ` +
        "Emits DaoBootstrapUsed + BootstrapExecutionRequestCreated.",
    );
    console.log(
      `  review window (editable):    default ${CREATION_FLOW.reviewWindowSecs.default}s, bounds ` +
        `${CREATION_FLOW.reviewWindowSecs.min}s..${CREATION_FLOW.reviewWindowSecs.max}s via set_review_window.`,
    );

    const stakePinned = Boolean(checks.naveStakePinned) || deployment?.naveStake?.pinned;
    console.log("\nDAO creation NAVE stake (none for new treasuries):");
    console.log(
      `  stake mint (mainnet):    ${NAVE_STAKE.mint} ` +
        `— ${stakePinned ? "PINNED on-chain via set_nave_mint" : "NOT YET PINNED: run `--phase set-nave-mint` (authority-gated, pre-handoff)"}.`,
    );
    console.log(
      `  required stake:          ${NAVE_STAKE.requiredStake} ($${NAVE_STAKE.stakeTargetUsd}). Forming a treasury does not require NAVE.`,
    );
    console.log(
      "  moonlighting release:    an existing lock, if any, is released with the distribution. restore_dao reopens without a new stake.",
    );
    console.log(
      "  EVM parity:              run `node scripts/evm-mainnet-cutover.mjs --phase stake` per chain to set " +
        "NaveProtocol.setNaveStakeConfig(wrappedNave, 0) + setDaoStake(module) BEFORE the Safe handoff.",
    );

    console.log("\nAudit-revision on-chain behaviors (authoritative on-chain):");
    console.log(
      `  NAV staleness ceiling:   ${AUDIT_CONSTANTS.navMaxStalenessSecs}s — strategy deploys HARD-BLOCK on stale NAV. ` +
        "revalue_treasury must be fresh (< 15 min) before execute.",
    );
    console.log(`  Pyth confidence ceiling: ${AUDIT_CONSTANTS.pythMaxConfidenceBps} bps (2%) max conf/price.`);
    console.log(`  Guardian action expiry:  ${AUDIT_CONSTANTS.guardianActionStaleSecs}s (7 days).`);
    console.log(
      `  Position mark step/cooldown: ${AUDIT_CONSTANTS.maxPositionMarkStepBps} bps (50%) per call, ` +
        `${AUDIT_CONSTANTS.positionMarkCooldownSecs}s between manual marks.`,
    );
    console.log(
      "  initialize_global_config: UPGRADE-AUTHORITY gated — runs as the deploy wallet with " +
        "program + program_data accounts, BEFORE the authority handoff.",
    );
    console.log(
      "  deposit_to_vault:        requires mint + asset_config; accepts REGISTERED STABLECOINS only " +
        "(non-stable assets use deposit_to_asset + revalue_treasury).",
    );
    console.log(
      "  vault->escrow movement:  LIVE + enforced on-chain (record_strategy_deposit runs transfer_vault_to_escrow; " +
        "adapters reject escrow == vault). Keep NAVE_ESCROW_PDA_ENABLED / VITE_ESCROW_PDA_ENABLED = true.",
    );
    console.log(
      `  Account size growth (pre-existing devnet accounts only): DaoRegistry +${ACCOUNT_SIZE_GROWTH.DaoRegistry}, ` +
        `GuardianAction +${ACCOUNT_SIZE_GROWTH.GuardianAction}, TreasuryVault +${ACCOUNT_SIZE_GROWTH.TreasuryVault} bytes.`,
    );
  } else {
    console.log("\nBridge/stake next steps (manual — see docs/MAINNET_BRIDGE_STAKING_RUNBOOK.md):");
    console.log("  1. nave_bridge.initialize_config (owner = Squads, relayer = hot key, inbound caps, fee 250 bps)");
    console.log("     then set_lock_daily_cap + set_dest_chain_allowed(1/8453/4663) — empty allowlist rejects every lock");
    console.log("  2. nave_staking.initialize_pool (owner = Squads, 365-day drip)");
    console.log("  3. Create neutral staking-fee collector; wire BRIDGE_SOLANA_STAKING_COLLECTOR");
    console.log("  4. Run --phase verify, then --phase handoff-authority LAST");
  }
}

main().catch((error) => {
  console.error(`\nMainnet cutover contracts phase failed: ${error.message}`);
  process.exit(1);
});
