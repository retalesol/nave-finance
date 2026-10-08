import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  buildSyncInstruction,
  decodeStakePoolAccount,
  derivePoolAuthority,
  deriveRewardVault,
  deriveStakePool,
  deriveStakeVault,
  DEFAULT_STAKING_PROGRAM_ID,
  meetsRateFloor,
  shouldDistribute,
  splitCollectorBalance,
  STAKE_POOL_ACCOUNT_SIZE,
} from './stakingMirror.js';

// ─── Proportional split math ──────────────────────────────────────────────────

test('splitCollectorBalance splits proportionally and routes the rounding remainder to Solana', () => {
  // Solana 60, Sepolia 25, Base Sepolia 15 → shares of 1_000_001 base units.
  const split = splitCollectorBalance(1_000_001n, {
    solanaStaked: 60n,
    evmStaked: { 11155111: 25n, 84532: 15n },
  });
  assert.equal(split.totalStaked, 100n);
  // floor(1000001*25/100)=250000, floor(1000001*15/100)=150000, Solana gets the rest.
  assert.equal(split.evmShares[11155111], 250_000n);
  assert.equal(split.evmShares[84532], 150_000n);
  assert.equal(split.solanaShare, 600_001n);
  assert.equal(split.undistributed, 0n);
  assert.equal(split.solanaShare + split.evmShares[11155111] + split.evmShares[84532], 1_000_001n);
});

test('splitCollectorBalance conserves every base unit for awkward weights', () => {
  for (const balance of [1n, 7n, 999_999n, 123_456_789n]) {
    const split = splitCollectorBalance(balance, {
      solanaStaked: 3_333_333n,
      evmStaked: { 11155111: 1_111_111n, 84532: 7n },
    });
    const distributed = split.solanaShare + split.evmShares[11155111] + split.evmShares[84532];
    assert.equal(distributed + split.undistributed, balance);
    // Solana has stake, so it absorbs all rounding — nothing left behind.
    assert.equal(split.undistributed, 0n);
  }
});

test('splitCollectorBalance gives zero to chains with zero stake', () => {
  const split = splitCollectorBalance(1_000_000n, {
    solanaStaked: 100n,
    evmStaked: { 11155111: 0n, 84532: 50n },
  });
  assert.equal(split.evmShares[11155111], 0n);
  assert.ok(split.evmShares[84532] > 0n);
  assert.equal(split.solanaShare + split.evmShares[84532], 1_000_000n);
});

test('splitCollectorBalance short-circuits on zero global stake (fees stay in collector)', () => {
  const split = splitCollectorBalance(5_000_000n, {
    solanaStaked: 0n,
    evmStaked: { 11155111: 0n, 84532: 0n },
  });
  assert.equal(split.totalStaked, 0n);
  assert.equal(split.solanaShare, 0n);
  assert.equal(split.evmShares[11155111], 0n);
  assert.equal(split.evmShares[84532], 0n);
  assert.equal(split.undistributed, 5_000_000n);
});

test('splitCollectorBalance leaves dust undistributed when only EVM has stake', () => {
  // Solana can't absorb rounding when it has zero stake: with equal EVM
  // weights and an odd balance, 1 base unit must remain in the collector.
  const split = splitCollectorBalance(1_000_001n, {
    solanaStaked: 0n,
    evmStaked: { 11155111: 50n, 84532: 50n },
  });
  assert.equal(split.solanaShare, 0n);
  assert.equal(split.evmShares[11155111], 500_000n);
  assert.equal(split.evmShares[84532], 500_000n);
  assert.equal(split.undistributed, 1n);
});

// ─── Threshold gating ─────────────────────────────────────────────────────────

test('shouldDistribute gates on the minimum threshold (inclusive)', () => {
  assert.equal(shouldDistribute(999_999n, 1_000_000n), false);
  assert.equal(shouldDistribute(1_000_000n, 1_000_000n), true);
  assert.equal(shouldDistribute(1_000_001n, 1_000_000n), true);
  assert.equal(shouldDistribute(0n, 1_000_000n), false);
});

test('meetsRateFloor rejects shares notifyReward would truncate to a zero rate', () => {
  const YEAR = 31_536_000n; // 365-day default rewardsDuration
  // 75_613 raw over a year floors to rate 0 — the exact stranding observed on
  // Sepolia/Robinhood testnet: tokens accepted, rewardRate stayed 0.
  assert.equal(meetsRateFloor(75_613n, 0n, YEAR), false);
  // One full duration's worth (1 unit/sec) is the smallest deliverable share.
  assert.equal(meetsRateFloor(YEAR, 0n, YEAR), true);
  assert.equal(meetsRateFloor(YEAR - 1n, 0n, YEAR), false);
  // Leftover from a still-running window counts toward the floor.
  assert.equal(meetsRateFloor(1n, YEAR - 1n, YEAR), true);
  // Degenerate duration never passes.
  assert.equal(meetsRateFloor(YEAR, 0n, 0n), false);
});

// ─── StakePool account decoding (drip-upgrade offsets) ────────────────────────

function u128leBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE(value >> 64n, 8);
  return buf;
}

/** Build a synthetic 299-byte StakePool account at the documented offsets. */
function syntheticPool(fields: {
  totalStaked: bigint;
  accRewardPerShare: bigint;
  lastRewardBalance: bigint;
  paused: boolean;
  rewardRate: bigint;
  periodFinish: bigint;
  lastUpdateTime: bigint;
  rewardDuration: bigint;
}): Buffer {
  const buf = Buffer.alloc(STAKE_POOL_ACCOUNT_SIZE);
  buf.writeBigUInt64LE(fields.totalStaked, 202);
  u128leBytes(fields.accRewardPerShare).copy(buf, 210);
  buf.writeBigUInt64LE(fields.lastRewardBalance, 226);
  buf.writeUInt8(fields.paused ? 1 : 0, 234);
  u128leBytes(fields.rewardRate).copy(buf, 235);
  buf.writeBigInt64LE(fields.periodFinish, 251);
  buf.writeBigInt64LE(fields.lastUpdateTime, 259);
  buf.writeBigInt64LE(fields.rewardDuration, 267);
  return buf;
}

test('decodeStakePoolAccount reads the drip fields at their absolute offsets', () => {
  const rateScale = 1_000_000_000_000n; // RATE_SCALE = 1e12
  const fields = {
    totalStaked: 123_456_789_000n,
    accRewardPerShare: (7n << 64n) + 42n, // exercises the u128 high half
    lastRewardBalance: 9_999n,
    paused: false,
    rewardRate: 31_709_791n * rateScale, // ~1 NAVE/year worth of rate units
    periodFinish: 1_790_000_000n,
    lastUpdateTime: 1_780_000_000n,
    rewardDuration: 31_536_000n, // 365 days
  };
  const decoded = decodeStakePoolAccount(syntheticPool(fields));
  assert.deepEqual(decoded, fields);
});

test('decodeStakePoolAccount decodes paused=true and zeroed drip fields (pre-init pool)', () => {
  const decoded = decodeStakePoolAccount(
    syntheticPool({
      totalStaked: 1n,
      accRewardPerShare: 0n,
      lastRewardBalance: 0n,
      paused: true,
      rewardRate: 0n,
      periodFinish: 0n,
      lastUpdateTime: 0n,
      rewardDuration: 0n,
    }),
  );
  assert.equal(decoded.paused, true);
  assert.equal(decoded.rewardRate, 0n);
  assert.equal(decoded.periodFinish, 0n);
});

test('decodeStakePoolAccount rejects truncated accounts', () => {
  assert.throws(() => decodeStakePoolAccount(Buffer.alloc(200)), /too small/);
});

// ─── PDA derivation + sync instruction ────────────────────────────────────────

test('staking PDA derivations are deterministic and distinct', () => {
  const programId = new PublicKey(DEFAULT_STAKING_PROGRAM_ID);
  const pool = deriveStakePool(programId);
  assert.equal(pool.toBase58(), deriveStakePool(programId).toBase58());
  const all = new Set(
    [pool, derivePoolAuthority(programId), deriveStakeVault(programId), deriveRewardVault(programId)].map((k) =>
      k.toBase58(),
    ),
  );
  assert.equal(all.size, 4);
});

test('buildSyncInstruction encodes the anchor sync discriminator and [pool, reward_vault]', () => {
  const programId = new PublicKey(DEFAULT_STAKING_PROGRAM_ID);
  const ix = buildSyncInstruction(programId);
  assert.equal(ix.programId.toBase58(), programId.toBase58());
  assert.equal(ix.data.length, 8); // discriminator only, no args
  // sha256("global:sync")[0..8]
  assert.equal(ix.data.toString('hex'), '04db28a4159dbd58');
  assert.equal(ix.keys.length, 2);
  assert.equal(ix.keys[0].pubkey.toBase58(), deriveStakePool(programId).toBase58());
  assert.equal(ix.keys[0].isWritable, true);
  assert.equal(ix.keys[1].pubkey.toBase58(), deriveRewardVault(programId).toBase58());
  assert.equal(ix.keys[1].isWritable, false);
});
