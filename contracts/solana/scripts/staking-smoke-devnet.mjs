#!/usr/bin/env node
/**
 * nave_staking — devnet smoke test (drip edition).
 *
 * Exercises the full rolling-365d drip cycle against the LIVE devnet pool:
 *
 *   1. stake      — principal lands in the stake vault (and the persisted
 *                   UserStake.bump keeps unstake derivable — the original SEC
 *                   regression this smoke guarded).
 *   2. fund+sync  — transfer NAVE into the reward vault and poke `sync`: the
 *                   pool must OPEN a drip window (reward_rate > 0,
 *                   period_finish ≈ now + reward_duration) instead of folding
 *                   the funds into acc_reward_per_share instantly.
 *   3. drip       — wait, sync again: pending must GROW with elapsed time and
 *                   remain a tiny fraction of the funded amount (no instant
 *                   distribution).
 *   4. claim      — pays out the dripped-so-far amount only.
 *   5. unstake    — principal comes back.
 *
 *   node scripts/staking-smoke-devnet.mjs --wallet .deploy-wallet-devnet.json
 */
import { createHash } from "node:crypto";
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
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const deployments = JSON.parse(readFileSync(join(ROOT, "deployments", "devnet.json"), "utf8"));
const v2 = deployments.bridgeV2;
const RPC = process.env.SMOKE_RPC || "https://api.devnet.solana.com";
const walletPath = process.argv.includes("--wallet") ? process.argv[process.argv.indexOf("--wallet") + 1] : ".deploy-wallet-devnet.json";

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(ROOT, walletPath), "utf8"))));
const connection = new Connection(RPC, "confirmed");
const STAKING = new PublicKey(v2.stakingProgram);
const MINT = new PublicKey(deployments.naveToken.devnetReplicaMint);
const POOL = new PublicKey(v2.stakePool);
const POOL_AUTH = new PublicKey(v2.poolAuthority);
const STAKE_VAULT = new PublicKey(v2.stakeVault);
const REWARD_VAULT = new PublicKey(v2.rewardVault);

const ACC_SCALE = 1_000_000_000_000n; // 1e12 — mirrors constants.rs
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const [userStake] = PublicKey.findProgramAddressSync([Buffer.from("user_stake"), wallet.publicKey.toBuffer()], STAKING);
const userAta = getAssociatedTokenAddressSync(MINT, wallet.publicKey);
const bal = async (a) => { try { return (await getAccount(connection, a)).amount; } catch { return 0n; } };
const assertEq = (l, a, e) => { if (a !== e) throw new Error(`ASSERT ${l}: expected ${e}, got ${a}`); console.log(`  ✓ ${l} = ${a}`); };
const assertTrue = (l, cond, detail) => { if (!cond) throw new Error(`ASSERT ${l}: ${detail}`); console.log(`  ✓ ${l} (${detail})`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readU128 = (d, o) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

/** Post-drip-upgrade StakePool absolute offsets (incl. 8-byte discriminator). */
async function readPool() {
  const info = await connection.getAccountInfo(POOL);
  if (!info) throw new Error("stake_pool account not found");
  const d = info.data;
  return {
    totalStaked: d.readBigUInt64LE(202),
    accRewardPerShare: readU128(d, 210),
    lastRewardBalance: d.readBigUInt64LE(226),
    paused: d.readUInt8(234) === 1,
    rewardRate: readU128(d, 235),
    periodFinish: d.readBigInt64LE(251),
    lastUpdateTime: d.readBigInt64LE(259),
    rewardDuration: d.readBigInt64LE(267),
  };
}

/** UserStake: disc(8) + bump u8 + owner Pubkey(32) + amount u64 + reward_debt u128 + pending u64. */
async function readUser() {
  const info = await connection.getAccountInfo(userStake);
  if (!info) return { amount: 0n, rewardDebt: 0n, pending: 0n };
  const d = info.data;
  return { amount: d.readBigUInt64LE(41), rewardDebt: readU128(d, 49), pending: d.readBigUInt64LE(65) };
}

/** Pending as the on-chain accrue_user would compute it right now. */
function pendingOf(pool, user) {
  const accumulated = (user.amount * pool.accRewardPerShare) / ACC_SCALE;
  const earned = accumulated > user.rewardDebt ? accumulated - user.rewardDebt : 0n;
  return user.pending + earned;
}

function syncIx() {
  return new TransactionInstruction({
    programId: STAKING,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: REWARD_VAULT, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(disc("sync")),
  });
}

async function main() {
  const AMOUNT = 2_000_000n; // 2 NAVE staked
  const FUND = 100_000_000n; // 100 NAVE into the reward vault (rate ≈ 3.17 base units/s over 365d)
  const before = { user: await bal(userAta), vault: await bal(STAKE_VAULT) };

  // ── 1. stake ────────────────────────────────────────────────────────────
  const stakeIx = new TransactionInstruction({
    programId: STAKING,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: userStake, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: STAKE_VAULT, isSigner: false, isWritable: true },
      { pubkey: REWARD_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("stake"), u64le(AMOUNT)]),
  });
  console.log(`stake: ${await sendAndConfirmTransaction(connection, new Transaction().add(stakeIx), [wallet])}`);
  assertEq("stake vault delta", (await bal(STAKE_VAULT)) - before.vault, AMOUNT);

  const poolAfterStake = await readPool();
  assertTrue("drip schedule seeded", poolAfterStake.rewardDuration > 0n, `reward_duration=${poolAfterStake.rewardDuration}s`);

  // ── 2. fund the reward vault + sync — window must OPEN, not dump ─────────
  const fundTx = new Transaction().add(
    createTransferInstruction(userAta, REWARD_VAULT, wallet.publicKey, FUND),
    syncIx(),
  );
  console.log(`fund+sync: ${await sendAndConfirmTransaction(connection, new Transaction().add(...fundTx.instructions), [wallet])}`);

  const pool1 = await readPool();
  const user1 = await readUser();
  const pending1 = pendingOf(pool1, user1);
  const nowish = BigInt(Math.floor(Date.now() / 1000));
  assertTrue("drip window opened", pool1.rewardRate > 0n, `reward_rate=${pool1.rewardRate}`);
  assertTrue(
    "period_finish ≈ now + reward_duration",
    pool1.periodFinish > nowish + pool1.rewardDuration - 600n && pool1.periodFinish <= nowish + pool1.rewardDuration + 600n,
    `period_finish=${pool1.periodFinish}`,
  );
  assertTrue(
    "no instant distribution",
    pending1 < FUND / 100n,
    `pending=${pending1} right after funding ${FUND} (< 1% of fund)`,
  );

  // ── 3. wait — pending must GROW with elapsed time ────────────────────────
  const WAIT_S = 20;
  console.log(`waiting ${WAIT_S}s for the drip…`);
  await sleep(WAIT_S * 1000);
  console.log(`sync: ${await sendAndConfirmTransaction(connection, new Transaction().add(syncIx()), [wallet])}`);

  const pool2 = await readPool();
  const user2 = await readUser();
  const pending2 = pendingOf(pool2, user2);
  assertTrue("pending grew over time", pending2 > pending1, `pending ${pending1} -> ${pending2} after ${WAIT_S}s`);
  assertTrue("still dripping, not dumped", pending2 < FUND / 100n, `pending=${pending2} (< 1% of fund)`);

  // ── 4. claim — pays only the dripped-so-far amount ───────────────────────
  const userBeforeClaim = await bal(userAta);
  const claimIx = new TransactionInstruction({
    programId: STAKING,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: userStake, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: REWARD_VAULT, isSigner: false, isWritable: true },
      { pubkey: POOL_AUTH, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(disc("claim")),
  });
  console.log(`claim: ${await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [wallet])}`);
  const claimed = (await bal(userAta)) - userBeforeClaim;
  assertTrue("claim paid out a positive drip", claimed > 0n, `claimed=${claimed}`);
  assertTrue("claim did NOT pay the whole fund", claimed < FUND / 100n, `claimed=${claimed} (< 1% of ${FUND})`);

  // ── 5. unstake — principal comes back (UserStake.bump persisted) ─────────
  const unstakeIx = new TransactionInstruction({
    programId: STAKING,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: userStake, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: STAKE_VAULT, isSigner: false, isWritable: true },
      { pubkey: REWARD_VAULT, isSigner: false, isWritable: true },
      { pubkey: POOL_AUTH, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("unstake"), u64le(AMOUNT)]),
  });
  console.log(`unstake: ${await sendAndConfirmTransaction(connection, new Transaction().add(unstakeIx), [wallet])}`);
  // Net wallet delta: -FUND (left dripping in the reward vault) + claimed.
  assertEq("principal returned (net of fund + claim)", await bal(userAta), before.user - FUND + claimed);

  console.log("\nSTAKING SMOKE PASSED — stake → fund → drip grows over time (no instant dump) → claim → unstake.");
}

main().catch((e) => { console.error(e); process.exit(1); });
