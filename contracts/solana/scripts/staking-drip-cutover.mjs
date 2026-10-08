#!/usr/bin/env node
/**
 * Staking drip cutover (devnet) — activate the rolling-365d drip on the live
 * pool and repoint the bridge's 1% staking-fee leg at a NEUTRAL collector.
 *
 * Steps (idempotent — each skips if already done):
 *
 *   1. nave_staking.init_reward_schedule — one-time owner-only seed of the
 *      drip schedule on the already-live pool (guard: reward_duration == 0).
 *   2. Create the staking fee COLLECTOR: a dedicated NAVE token account owned
 *      by the relayer wallet. Deliberately NOT the wallet's ATA — the ATA
 *      holds the wallet's own NAVE, and the mirror job distributes the entire
 *      collector balance, so the collector must start (and stay) segregated.
 *   3. nave_bridge.set_config — repoint staking_pool_owner from the staking
 *      pool-authority PDA to the relayer wallet, so lock/release fee-destination
 *      validation accepts the collector. All other config fields are re-passed
 *      unchanged (read live from the BridgeConfig account).
 *   4. Record stakingCollector / stakingPoolOwner in deployments/devnet.json.
 *
 * ── Running (devnet) ─────────────────────────────────────────────────────────
 *   node scripts/staking-drip-cutover.mjs --wallet .deploy-wallet-devnet.json
 *
 * Flags:
 *   --wallet <path>  owner + payer keypair (default .deploy-wallet-devnet.json)
 *   --rpc <url>      RPC (default from deployments/devnet.json)
 *   --dry-run        print addresses/plan only; send no txs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  createInitializeAccountInstruction,
  getMinimumBalanceForRentExemptAccount,
} from "@solana/spl-token";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEPLOYMENTS = join(ROOT, "deployments", "devnet.json");
const COLLECTOR_KEYPAIR_PATH = join(ROOT, ".staking-collector-devnet.json");

const BRIDGE_PROGRAM_ID = new PublicKey("Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6");
const STAKING_PROGRAM_ID = new PublicKey("AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf");

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u16le(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { walletPath: ".deploy-wallet-devnet.json", rpc: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--wallet") out.walletPath = args[++i];
    else if (a === "--rpc") out.rpc = args[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

/** BridgeConfig layout offsets (after the 8-byte discriminator). */
function decodeBridgeConfig(data) {
  let o = 8;
  const bump = data.readUInt8(o); o += 1;
  const custodyAuthorityBump = data.readUInt8(o); o += 1;
  const owner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const pendingOwner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const relayer = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const naveMint = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const custody = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const protocolFeeOwner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const stakingPoolOwner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const feeBps = data.readUInt16LE(o); o += 2;
  const stakingBps = data.readUInt16LE(o); o += 2;
  const protocolBps = data.readUInt16LE(o); o += 2;
  const burnBps = data.readUInt16LE(o); o += 2;
  const perTxCap = data.readBigUInt64LE(o); o += 8;
  const dailyCap = data.readBigUInt64LE(o); o += 8;
  return {
    bump, custodyAuthorityBump, owner, pendingOwner, relayer, naveMint, custody,
    protocolFeeOwner, stakingPoolOwner, feeBps, stakingBps, protocolBps, burnBps,
    perTxCap, dailyCap,
  };
}

async function main() {
  const args = parseArgs();
  const deployments = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const rpc = args.rpc || deployments.rpc;
  const mint = new PublicKey(deployments.naveToken.devnetReplicaMint);
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(ROOT, args.walletPath), "utf8"))),
  );
  const connection = new Connection(rpc, "confirmed");

  const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from("stake_pool")], STAKING_PROGRAM_ID);
  const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], BRIDGE_PROGRAM_ID);

  console.log(`wallet         ${wallet.publicKey.toBase58()}`);
  console.log(`stake_pool     ${stakePool.toBase58()}`);
  console.log(`bridge_config  ${bridgeConfig.toBase58()}`);

  // ── 1. init_reward_schedule (one-time; guard reward_duration == 0) ────────
  const poolInfo = await connection.getAccountInfo(stakePool);
  if (!poolInfo) throw new Error("stake_pool not found — run bridge-staking-init.mjs first");
  const rewardDuration = poolInfo.data.readBigInt64LE(267);
  if (rewardDuration !== 0n) {
    console.log(`init_reward_schedule: already seeded (reward_duration=${rewardDuration}s) — skipping.`);
  } else if (args.dryRun) {
    console.log("init_reward_schedule: WOULD run (dry-run).");
  } else {
    const ix = new TransactionInstruction({
      programId: STAKING_PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: stakePool, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(disc("init_reward_schedule")),
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    console.log(`init_reward_schedule: ${sig}`);
  }

  // ── 2. Collector token account (dedicated keypair, owner = wallet) ────────
  let collectorKeypair;
  if (existsSync(COLLECTOR_KEYPAIR_PATH)) {
    collectorKeypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(COLLECTOR_KEYPAIR_PATH, "utf8"))),
    );
    console.log(`collector keypair: reusing ${collectorKeypair.publicKey.toBase58()}`);
  } else {
    collectorKeypair = Keypair.generate();
    if (!args.dryRun) {
      writeFileSync(COLLECTOR_KEYPAIR_PATH, JSON.stringify(Array.from(collectorKeypair.secretKey)));
    }
    console.log(`collector keypair: generated ${collectorKeypair.publicKey.toBase58()} (saved to .staking-collector-devnet.json)`);
  }
  const collector = collectorKeypair.publicKey;

  const collectorInfo = await connection.getAccountInfo(collector);
  if (collectorInfo) {
    console.log("collector token account: already exists — skipping create.");
  } else if (args.dryRun) {
    console.log("collector token account: WOULD create (dry-run).");
  } else {
    const rent = await getMinimumBalanceForRentExemptAccount(connection);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: collector,
        space: ACCOUNT_SIZE,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(collector, mint, wallet.publicKey),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet, collectorKeypair]);
    console.log(`collector token account created: ${collector.toBase58()} (tx ${sig})`);
  }

  // ── 3. set_config: staking_pool_owner -> relayer wallet ───────────────────
  const cfgInfo = await connection.getAccountInfo(bridgeConfig);
  if (!cfgInfo) throw new Error("bridge_config not found — run bridge-staking-init.mjs first");
  const cfg = decodeBridgeConfig(cfgInfo.data);
  console.log(`current staking_pool_owner: ${cfg.stakingPoolOwner.toBase58()}`);
  if (cfg.stakingPoolOwner.equals(wallet.publicKey)) {
    console.log("set_config: staking_pool_owner already the relayer wallet — skipping.");
  } else if (args.dryRun) {
    console.log(`set_config: WOULD repoint staking_pool_owner -> ${wallet.publicKey.toBase58()} (dry-run).`);
  } else {
    const data = Buffer.concat([
      disc("set_config"),
      u16le(cfg.feeBps),
      u16le(cfg.stakingBps),
      u16le(cfg.protocolBps),
      u16le(cfg.burnBps),
      u64le(cfg.perTxCap),
      u64le(cfg.dailyCap),
      cfg.protocolFeeOwner.toBuffer(),
      wallet.publicKey.toBuffer(), // staking_pool_owner = relayer wallet (collector owner)
    ]);
    const ix = new TransactionInstruction({
      programId: BRIDGE_PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: bridgeConfig, isSigner: false, isWritable: true },
      ],
      data,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    console.log(`set_config (staking_pool_owner -> relayer): ${sig}`);
  }

  // ── 4. Record in deployments/devnet.json ──────────────────────────────────
  if (!args.dryRun) {
    deployments.bridgeV2 = deployments.bridgeV2 || {};
    deployments.bridgeV2.stakingCollector = collector.toBase58();
    deployments.bridgeV2.stakingPoolOwner = wallet.publicKey.toBase58();
    deployments.bridgeV2.stakingCollectorNote =
      "Neutral relayer-owned NAVE token account (dedicated keypair, NOT the wallet ATA). Destination of the bridge's 1% staking leg; drained by the signer-service staking mirror.";
    writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + "\n");
    console.log("deployments/devnet.json updated (bridgeV2.stakingCollector).");
  }

  console.log("\nEnv values:");
  console.log(`  BRIDGE_SOLANA_STAKING_COLLECTOR=${collector.toBase58()}`);
  console.log(`  BRIDGE_SOLANA_STAKING_POOL_ACCOUNT=${collector.toBase58()}`);
  console.log(`  VITE_NAVE_BRIDGE_STAKING_POOL_ACCOUNT=${collector.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
