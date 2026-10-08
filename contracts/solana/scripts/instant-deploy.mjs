#!/usr/bin/env node
/**
 * Deploy all Nave Finance programs to devnet and initialize global config.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEPLOY_DIR = join(ROOT, "target", "deploy");
const IDL_PATH = join(ROOT, "idl", "nave_core.json");
const MANIFEST_PATH = join(ROOT, "deployments", "devnet.json");

const DEFAULT_RPC = "https://roseanna-tzdvmq-fast-devnet.helius-rpc.com";
// Protocol revenue portion of the formation fee. This is a DEVNET bootstrap
// script, so it mirrors the on-chain devnet (default-features) fee of 0.01 SOL
// (mainnet uses 1.8 SOL via `--features mainnet`). The founder also seeds the
// four agent wallets with 0.01 SOL each (0.04 SOL total) on devnet.
const FORMATION_FEE_LAMPORTS = 10_000_000;
const MIN_BALANCE_SOL = 18;

function resolveProtocolFeeWallet(fallbackPubkey) {
  const raw = process.env.NAVE_PROTOCOL_FEE_WALLET?.trim();
  if (!raw) return fallbackPubkey;
  try {
    return new PublicKey(raw);
  } catch {
    console.warn(`Invalid NAVE_PROTOCOL_FEE_WALLET: ${raw} — using deploy wallet`);
    return fallbackPubkey;
  }
}

const PROGRAMS = [
  { name: "nave_core", so: "nave_core.so", keypair: "nave_core-keypair.json" },
  { name: "nave_governance", so: "nave_governance.so", keypair: "nave_governance-keypair.json" },
  { name: "nave_execution", so: "nave_execution.so", keypair: "nave_execution-keypair.json" },
  { name: "nave_jito_adapter", so: "nave_jito_adapter.so", keypair: "nave_jito_adapter-keypair.json" },
  { name: "nave_kamino_adapter", so: "nave_kamino_adapter.so", keypair: "nave_kamino_adapter-keypair.json" },
  {
    name: "nave_marginfi_adapter",
    so: "nave_marginfi_adapter.so",
    keypair: "nave_marginfi_adapter-keypair.json",
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let walletPath = null;
  let rpc = DEFAULT_RPC;
  let skipBuild = false;
  let skipInit = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wallet") walletPath = args[++i];
    else if (args[i] === "--rpc") rpc = args[++i];
    else if (args[i] === "--skip-build") skipBuild = true;
    else if (args[i] === "--skip-init") skipInit = true;
  }

  if (!walletPath) {
    console.error("Missing --wallet <path-to-keypair.json>");
    process.exit(1);
  }

  return { walletPath, rpc, skipBuild, skipInit };
}

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${cmdArgs.join(" ")}`);
  }
}

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function ensureBuilt(skipBuild) {
  const missing = PROGRAMS.some((p) => !existsSync(join(DEPLOY_DIR, p.so)));
  if (!missing) return;

  if (skipBuild) {
    throw new Error("Program binaries missing. Run ./build.sh first or remove --skip-build.");
  }

  console.log("\n🔨 Building programs (first run may take a few minutes)...\n");
  run("bash", [join(ROOT, "build.sh")]);
}

function deployProgram(name, soPath, keypairPath, walletPath, rpc) {
  console.log(`\n📦 Deploying ${name}...`);
  run("solana", [
    "program",
    "deploy",
    soPath,
    "--program-id",
    keypairPath,
    "--url",
    rpc,
    "--keypair",
    walletPath,
    "--max-sign-attempts",
    "60",
  ]);
  const pubkeyResult = spawnSync("solana-keygen", ["pubkey", keypairPath], {
    encoding: "utf8",
  });
  const id = pubkeyResult.stdout.trim();
  console.log(`   ✓ ${name} → ${id}`);
  return id;
}

function getGlobalConfigPda(programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    new PublicKey(programId),
  );
}

async function initializeGlobalConfig(connection, payer, programId, protocolTreasury) {
  const [globalConfigPda] = getGlobalConfigPda(programId);
  const existing = await connection.getAccountInfo(globalConfigPda);
  if (existing) {
    console.log(`\n⚙️  Global config already initialized at ${globalConfigPda.toBase58()}`);
    console.log(`   Protocol fee wallet (env): ${protocolTreasury.toBase58()}`);
    return globalConfigPda.toBase58();
  }

  if (!existsSync(IDL_PATH)) {
    console.warn("\n⚠️  Skipping global config init — IDL not found at", IDL_PATH);
    return null;
  }

  console.log("\n⚙️  Initializing global config...");
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);

  console.log(`   Protocol fee wallet: ${protocolTreasury.toBase58()}`);

  await program.methods
    .initializeGlobalConfig(new BN(FORMATION_FEE_LAMPORTS))
    .accounts({
      authority: payer.publicKey,
      treasury: protocolTreasury,
      globalConfig: globalConfigPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`   ✓ Global config → ${globalConfigPda.toBase58()}`);
  return globalConfigPda.toBase58();
}

async function main() {
  const { walletPath, rpc, skipBuild, skipInit } = parseArgs();
  const payer = loadKeypair(walletPath);
  const protocolTreasury = resolveProtocolFeeWallet(payer.publicKey);

  console.log("═══════════════════════════════════════════════════");
  console.log("  Nave Finance — Instant Devnet Deploy");
  console.log("═══════════════════════════════════════════════════");
  console.log(`RPC:     ${rpc}`);
  console.log(`Wallet:  ${payer.publicKey.toBase58()}`);
  console.log(`Fee wallet: ${protocolTreasury.toBase58()}`);

  ensureBuilt(skipBuild);

  const connection = new Connection(rpc, "confirmed");
  const balance = await connection.getBalance(payer.publicKey);
  const balanceSol = balance / 1e9;
  console.log(`Balance: ${balanceSol.toFixed(4)} SOL`);

  if (balanceSol < MIN_BALANCE_SOL) {
    console.error(
      `\n❌ Insufficient balance. Need ~${MIN_BALANCE_SOL} SOL, have ${balanceSol.toFixed(4)} SOL.`,
    );
    console.error("   Request devnet SOL from https://faucet.solana.com/ or Helius faucet.");
    process.exit(1);
  }

  const deployed = {};
  for (const prog of PROGRAMS) {
    const soPath = join(DEPLOY_DIR, prog.so);
    const keypairPath = join(DEPLOY_DIR, prog.keypair);
    if (!existsSync(soPath) || !existsSync(keypairPath)) {
      throw new Error(`Missing artifact: ${prog.so} or ${prog.keypair}`);
    }
    deployed[prog.name] = deployProgram(prog.name, soPath, keypairPath, walletPath, rpc);
  }

  let globalConfigPda = null;
  if (!skipInit) {
    globalConfigPda = await initializeGlobalConfig(
      connection,
      payer,
      deployed.nave_core,
      protocolTreasury,
    );
  }

  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  const manifest = {
    cluster: "devnet",
    rpc,
    deployedAt: new Date().toISOString(),
    authority: payer.publicKey.toBase58(),
    treasury: protocolTreasury.toBase58(),
    formationFeeLamports: FORMATION_FEE_LAMPORTS,
    globalConfig: globalConfigPda,
    programs: deployed,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ✅ Deploy complete");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Manifest: ${MANIFEST_PATH}`);
  for (const [name, id] of Object.entries(deployed)) {
    console.log(`  ${name.padEnd(22)} ${id}`);
  }
  if (globalConfigPda) {
    console.log(`  global_config          ${globalConfigPda}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("\n❌ Deploy failed:", err.message ?? err);
  process.exit(1);
});
