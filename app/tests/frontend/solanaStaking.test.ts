// Solana staking: instruction encoding, on-chain account decode + pending
// accrual mirror, and APY. The on-chain reward_rate is FIXED-POINT scaled by
// 1e12 (RATE_SCALE) — the decoder de-scales it for display.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  buildStakeInstruction,
  buildUnstakeInstruction,
  buildClaimInstruction,
  computeStakingApy,
  readStakePoolStats,
  readStakingPosition,
  RATE_SCALE,
  SECONDS_PER_YEAR,
} from '../../src/lib/staking/solanaStakingProgram';

const PROGRAM = new PublicKey('AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf');
const OWNER = new PublicKey('EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn');
const MINT = new PublicKey('GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa');

assert.equal(RATE_SCALE, 1_000_000_000_000n);
assert.equal(SECONDS_PER_YEAR, 31_536_000n);

// ── Instruction encoding ─────────────────────────────────────────────────────

test('stake / unstake instructions: correct discriminator + u64 amount', () => {
  const stakeIx = buildStakeInstruction({ programId: PROGRAM, owner: OWNER, naveMint: MINT }, 4_200_000n);
  assert.deepEqual(stakeIx.data.subarray(0, 8), Buffer.from(sha256('global:stake')).subarray(0, 8));
  assert.equal(stakeIx.data.readBigUInt64LE(8), 4_200_000n);
  assert.equal(stakeIx.keys.filter((k) => k.isSigner).length, 1);
  assert.ok(stakeIx.keys.find((k) => k.isSigner)!.pubkey.equals(OWNER));

  const unstakeIx = buildUnstakeInstruction({ programId: PROGRAM, owner: OWNER, naveMint: MINT }, 1_000_000n);
  assert.deepEqual(unstakeIx.data.subarray(0, 8), Buffer.from(sha256('global:unstake')).subarray(0, 8));
  assert.equal(unstakeIx.data.readBigUInt64LE(8), 1_000_000n);
});

test('claim instruction: discriminator only, no args', () => {
  const claimIx = buildClaimInstruction({ programId: PROGRAM, owner: OWNER, naveMint: MINT });
  assert.equal(claimIx.data.length, 8);
  assert.deepEqual(claimIx.data, Buffer.from(sha256('global:claim')).subarray(0, 8));
});

// ── Account decode helpers ───────────────────────────────────────────────────

function poolBuffer(fields: {
  totalStaked: bigint;
  accRewardPerShare?: bigint;
  lastRewardBalance?: bigint;
  paused?: boolean;
  rewardRate?: bigint;
  periodFinish?: bigint;
  lastUpdateTime?: bigint;
  rewardDuration?: bigint;
}): Buffer {
  const b = Buffer.alloc(320);
  b.writeBigUInt64LE(fields.totalStaked, 202);
  b.writeBigUInt64LE(fields.accRewardPerShare ?? 0n, 210); // u128 low
  b.writeBigUInt64LE(0n, 218); // u128 high
  b.writeBigUInt64LE(fields.lastRewardBalance ?? 0n, 226);
  b.writeUInt8(fields.paused ? 1 : 0, 234);
  b.writeBigUInt64LE(fields.rewardRate ?? 0n, 235); // u128 low
  b.writeBigUInt64LE(0n, 243); // u128 high
  b.writeBigInt64LE(fields.periodFinish ?? 0n, 251);
  b.writeBigInt64LE(fields.lastUpdateTime ?? 0n, 259);
  b.writeBigInt64LE(fields.rewardDuration ?? 0n, 267);
  return b;
}

function userBuffer(fields: { amount: bigint; rewardDebt?: bigint; pending?: bigint }): Buffer {
  const b = Buffer.alloc(100);
  b.writeBigUInt64LE(fields.amount, 41);
  b.writeBigUInt64LE(fields.rewardDebt ?? 0n, 49); // u128 low
  b.writeBigUInt64LE(0n, 57); // u128 high
  b.writeBigUInt64LE(fields.pending ?? 0n, 65);
  return b;
}

test('readStakePoolStats: decodes totals + de-scales reward_rate by 1e12', async () => {
  const connection = {
    async getAccountInfo() {
      return {
        data: poolBuffer({
          totalStaked: 100_000_000n,
          rewardRate: 3n * RATE_SCALE, // 3 base-units/sec, stored scaled
          periodFinish: 4_000_000_000n,
          paused: false,
        }),
      };
    },
    async getTokenAccountBalance() {
      return { value: { amount: '7777' } };
    },
  };
  const stats = await readStakePoolStats(connection as never, PROGRAM);
  assert.ok(stats);
  assert.equal(stats!.totalStaked, 100_000_000n);
  assert.equal(stats!.rewardBalance, 7777n);
  assert.equal(stats!.rewardRatePerSec, 3n * RATE_SCALE, 'scaled value retained');
  assert.equal(stats!.rewardRatePerSecFloat, 3, 'de-scaled float = rate / 1e12');
  assert.equal(stats!.periodFinish, 4_000_000_000n);
  assert.equal(stats!.paused, false);
});

test('readStakePoolStats: returns null when the pool account is absent', async () => {
  const connection = {
    async getAccountInfo() {
      return null;
    },
    async getTokenAccountBalance() {
      throw new Error('unused');
    },
  };
  assert.equal(await readStakePoolStats(connection as never, PROGRAM), null);
});

test('readStakingPosition: pending reflects acc-based accrual (drip off → exact)', async () => {
  // acc = 1e12, user has 2 NAVE staked, zero debt, 0.5 NAVE already-pending.
  // accumulated = amount * acc / ACC_SCALE = 2_000_000; earned = 2_000_000.
  const pool = poolBuffer({ totalStaked: 5_000_000n, accRewardPerShare: RATE_SCALE, rewardRate: 0n });
  const user = userBuffer({ amount: 2_000_000n, rewardDebt: 0n, pending: 500_000n });
  const connection = {
    async getMultipleAccountsInfo() {
      return [{ data: pool }, { data: user }];
    },
  };
  const pos = await readStakingPosition(connection as never, PROGRAM, OWNER);
  assert.equal(pos.staked, 2_000_000n);
  assert.equal(pos.pending, 2_500_000n, 'pending = stored pending + (accumulated - rewardDebt)');
  assert.equal(pos.paused, false);
});

test('readStakingPosition: no user account → zeroed position, pool pause still surfaced', async () => {
  const pool = poolBuffer({ totalStaked: 0n, paused: true });
  const connection = {
    async getMultipleAccountsInfo() {
      return [{ data: pool }, null];
    },
  };
  const pos = await readStakingPosition(connection as never, PROGRAM, OWNER);
  assert.equal(pos.staked, 0n);
  assert.equal(pos.pending, 0n);
  assert.equal(pos.paused, true);
});

// ── APY ──────────────────────────────────────────────────────────────────────

test('computeStakingApy: positive when the drip is live', () => {
  // annual emission = staked → 100% APY.
  const apy = computeStakingApy({
    annualEmissionRaw: 1_000_000n,
    totalStakedRaw: 1_000_000n,
    periodFinish: 4_000_000_000n,
    nowSec: 1_000,
  });
  assert.equal(apy, 100);
});

test('computeStakingApy: null when inactive (no stake / no emission / window ended)', () => {
  const base = { annualEmissionRaw: 1_000_000n, totalStakedRaw: 1_000_000n, periodFinish: 4_000_000_000n, nowSec: 1_000 };
  assert.equal(computeStakingApy({ ...base, totalStakedRaw: 0n }), null, 'nothing staked');
  assert.equal(computeStakingApy({ ...base, annualEmissionRaw: 0n }), null, 'zero emission');
  assert.equal(computeStakingApy({ ...base, periodFinish: 0n }), null, 'uninitialized window');
  assert.equal(computeStakingApy({ ...base, nowSec: 5_000_000_000 }), null, 'window already ended');
});
