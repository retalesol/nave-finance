#!/usr/bin/env node
/**
 * NAVE bridge — devnet smoke test for the hardened bridge program.
 *
 * Exercises, against the LIVE devnet deployment:
 *   1. `lock` (single-signature bridge-out): pulls net + 2.5% from the sender,
 *      keeps net in custody, burns 0.5%, pays 1% staking + 1% protocol.
 *   2. `release` (relayer-signed bridge-in): pays net to the recipient, resolves
 *      the same fee split out of custody, records the replay guard.
 *   3. Replay: a second `release` with the SAME source message id must FAIL.
 *
 * Asserts exact balance deltas for custody, the staking fee COLLECTOR (the
 * neutral relayer-owned account the 1% staking leg lands in post drip-cutover
 * — NOT the pool reward vault; the staking mirror distributes it from there),
 * protocol fee account, recipient, and mint supply (burn leg).
 *
 *   node scripts/bridge-smoke-devnet.mjs --wallet .deploy-wallet-devnet.json
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount, getMint } from "@solana/spl-token";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const deployments = JSON.parse(readFileSync(join(ROOT, "deployments", "devnet.json"), "utf8"));
const v2 = deployments.bridgeV2;
if (!v2) throw new Error("deployments/devnet.json has no bridgeV2 block — run bridge-staking-init.mjs first.");

const RPC = process.env.SMOKE_RPC || "https://api.devnet.solana.com";
const walletPath = process.argv.includes("--wallet")
  ? process.argv[process.argv.indexOf("--wallet") + 1]
  : ".deploy-wallet-devnet.json";

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(ROOT, walletPath), "utf8"))));
const connection = new Connection(RPC, "confirmed");

const BRIDGE = new PublicKey(v2.bridgeProgram);
const MINT = new PublicKey(deployments.naveToken.devnetReplicaMint);
const CONFIG = new PublicKey(v2.bridgeConfig);
const CUSTODY = new PublicKey(v2.custody);
const CUSTODY_AUTH = new PublicKey(v2.custodyAuthority);
const PROTOCOL_ATA = new PublicKey(v2.protocolFeeAccount);
if (!v2.stakingCollector) {
  throw new Error(
    "deployments/devnet.json bridgeV2 has no stakingCollector — run staking-drip-cutover.mjs first " +
      "(the bridge staking leg is validated against BridgeConfig.staking_pool_owner = the collector owner).",
  );
}
const STAKING_COLLECTOR = new PublicKey(v2.stakingCollector);

const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64le = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

async function bal(addr) {
  try {
    return (await getAccount(connection, addr)).amount;
  } catch {
    return 0n;
  }
}
async function supply() {
  return (await getMint(connection, MINT)).supply;
}
function assertEq(label, actual, expected) {
  if (actual !== expected) throw new Error(`ASSERT ${label}: expected ${expected}, got ${actual}`);
  console.log(`  ✓ ${label} = ${actual}`);
}

async function main() {
  const senderAta = getAssociatedTokenAddressSync(MINT, wallet.publicKey);

  // ── 1. lock 1 NAVE net (user pays 1.025) ────────────────────────────────
  const NET = 1_000_000n; // 1 NAVE
  const FEE = 25_000n; // 2.5%
  const STK = 10_000n, PROTO = 10_000n, BURN = 5_000n;
  const evmRecipient = Buffer.alloc(20, 0x11);

  const before = {
    sender: await bal(senderAta),
    custody: await bal(CUSTODY),
    collector: await bal(STAKING_COLLECTOR),
    proto: await bal(PROTOCOL_ATA),
    supply: await supply(),
  };

  const lockIx = new TransactionInstruction({
    programId: BRIDGE,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: CONFIG, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: senderAta, isSigner: false, isWritable: true },
      { pubkey: CUSTODY, isSigner: false, isWritable: true },
      { pubkey: CUSTODY_AUTH, isSigner: false, isWritable: false },
      { pubkey: PROTOCOL_ATA, isSigner: false, isWritable: true },
      { pubkey: STAKING_COLLECTOR, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("lock"), u64le(NET), u64le(84532), evmRecipient]),
  });
  const lockSig = await sendAndConfirmTransaction(connection, new Transaction().add(lockIx), [wallet]);
  console.log(`lock: ${lockSig}`);

  assertEq("sender delta (gross)", before.sender - (await bal(senderAta)), NET + FEE);
  assertEq("custody delta (net)", (await bal(CUSTODY)) - before.custody, NET);
  assertEq("staking COLLECTOR delta", (await bal(STAKING_COLLECTOR)) - before.collector, STK);
  assertEq("protocol fee delta", (await bal(PROTOCOL_ATA)) - before.proto, PROTO);
  assertEq("burned supply delta", before.supply - (await supply()), BURN);

  // ── 2. release 0.5 NAVE net back to the wallet ──────────────────────────
  const RNET = 500_000n;
  const RSTK = 5_000n, RPROTO = 5_000n, RBURN = 2_500n;
  const msgId = randomBytes(32);
  const [processed] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_processed"), CONFIG.toBuffer(), u64le(84532), msgId],
    BRIDGE,
  );

  const before2 = {
    recipient: await bal(senderAta),
    custody: await bal(CUSTODY),
    collector: await bal(STAKING_COLLECTOR),
    proto: await bal(PROTOCOL_ATA),
    supply: await supply(),
  };

  const releaseIx = () =>
    new TransactionInstruction({
      programId: BRIDGE,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: CONFIG, isSigner: false, isWritable: true },
        { pubkey: MINT, isSigner: false, isWritable: true },
        { pubkey: CUSTODY, isSigner: false, isWritable: true },
        { pubkey: CUSTODY_AUTH, isSigner: false, isWritable: false },
        { pubkey: senderAta, isSigner: false, isWritable: true },
        { pubkey: PROTOCOL_ATA, isSigner: false, isWritable: true },
        { pubkey: STAKING_COLLECTOR, isSigner: false, isWritable: true },
        { pubkey: processed, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        disc("release"),
        u64le(84532),
        msgId,
        u64le(RNET),
        wallet.publicKey.toBuffer(),
      ]),
    });

  const relSig = await sendAndConfirmTransaction(connection, new Transaction().add(releaseIx()), [wallet]);
  console.log(`release: ${relSig}`);

  assertEq("recipient delta (net)", (await bal(senderAta)) - before2.recipient, RNET);
  assertEq("custody outflow (gross)", before2.custody - (await bal(CUSTODY)), RNET + RSTK + RPROTO + RBURN);
  assertEq("staking COLLECTOR delta", (await bal(STAKING_COLLECTOR)) - before2.collector, RSTK);
  assertEq("protocol fee delta", (await bal(PROTOCOL_ATA)) - before2.proto, RPROTO);
  assertEq("burned supply delta", before2.supply - (await supply()), RBURN);

  // ── 3. replay must fail ──────────────────────────────────────────────────
  let replayFailed = false;
  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(releaseIx()), [wallet]);
  } catch {
    replayFailed = true;
  }
  if (!replayFailed) throw new Error("ASSERT replay: second release with same message id SUCCEEDED (must fail)");
  console.log("  ✓ replay of the same source message id rejected");

  console.log("\nSMOKE TEST PASSED — lock fee split, release fee split, and replay guard verified on devnet.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
