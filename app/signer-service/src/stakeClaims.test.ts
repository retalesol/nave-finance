// Claim-on-demand reward accounting: these pure functions decide how much
// wNAVE the relayer mints to a staker, so their math is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimableRaw,
  claimMessage,
  computeOwedDeltaRaw,
  DEFAULT_STAKE_CLAIM_SRC_CHAIN_ID,
  elapsedWithinWindow,
  readStakeClaimConfig,
  SOLANA_RATE_SCALE,
} from './stakeClaims.js';
import { DEFAULT_STAKING_MIRROR_SRC_CHAIN_ID } from './stakingMirror.js';

test('computeOwedDeltaRaw: share of the Solana drip, all-integer', () => {
  // Rate 10 base-units/sec (scaled by 1e12), user holds 25% of global TVL,
  // 100 seconds elapsed → 10 × 100 × 0.25 = 250 base units.
  const rateScaled = 10n * SOLANA_RATE_SCALE;
  assert.equal(computeOwedDeltaRaw(25n, 100n, rateScaled, 100n), 250n);

  // Rounding floors (never over-credits): 1/3 share of 10 u/s over 1s = 3.33 → 3.
  assert.equal(computeOwedDeltaRaw(1n, 3n, rateScaled, 1n), 3n);

  // Degenerate inputs never accrue.
  assert.equal(computeOwedDeltaRaw(0n, 100n, rateScaled, 100n), 0n);
  assert.equal(computeOwedDeltaRaw(25n, 0n, rateScaled, 100n), 0n);
  assert.equal(computeOwedDeltaRaw(25n, 100n, 0n, 100n), 0n);
  assert.equal(computeOwedDeltaRaw(25n, 100n, rateScaled, 0n), 0n);
});

test('computeOwedDeltaRaw matches the UI counter for realistic magnitudes', () => {
  // Solana pool: 12.798 u/s (the live devnet rate), user 2.05 NAVE of a
  // 6.101 NAVE global TVL, one hour elapsed.
  const rateScaled = 12_798_491_565_195n; // 12.798... × 1e12
  const owed = computeOwedDeltaRaw(2_050_000n, 6_101_000n, rateScaled, 3_600n);
  // 12.798 × 3600 × (2.05/6.101) ≈ 15_480 base units ≈ 0.0155 NAVE.
  assert.ok(owed > 15_000n && owed < 16_000n, `owed=${owed}`);
});

test('elapsedWithinWindow caps accrual at periodFinish', () => {
  assert.equal(elapsedWithinWindow(100n, 200n, 1_000n), 100n); // fully inside
  assert.equal(elapsedWithinWindow(100n, 200n, 150n), 50n); // clipped at finish
  assert.equal(elapsedWithinWindow(100n, 200n, 100n), 0n); // window already over
  assert.equal(elapsedWithinWindow(200n, 100n, 1_000n), 0n); // clock skew → never negative
});

test('claimableRaw is accrued minus claimed, floored at zero', () => {
  const base = { chainId: 1, staker: '0xabc', stakedRaw: 0n, anchorSec: 0 };
  assert.equal(claimableRaw({ ...base, accruedRaw: 100n, claimedRaw: 40n }), 60n);
  assert.equal(claimableRaw({ ...base, accruedRaw: 100n, claimedRaw: 100n }), 0n);
  // Defensive: ledger corruption can never yield a negative payout.
  assert.equal(claimableRaw({ ...base, accruedRaw: 100n, claimedRaw: 150n }), 0n);
});

test('claim replay partition is distinct from bridge (900) and mirror (901)', () => {
  assert.equal(DEFAULT_STAKE_CLAIM_SRC_CHAIN_ID, 902);
  assert.notEqual(DEFAULT_STAKE_CLAIM_SRC_CHAIN_ID, DEFAULT_STAKING_MIRROR_SRC_CHAIN_ID);
});

test('claimMessage is stable and lowercases the staker (signature preimage)', () => {
  assert.equal(
    claimMessage(11155111, '0xAbCdEF0000000000000000000000000000000001', 1_700_000_000),
    'nave-stake-claim\nchain:11155111\nstaker:0xabcdef0000000000000000000000000000000001\nissued:1700000000',
  );
});

test('min/max claim knobs parse defensively (dust-floor griefing guard)', () => {
  const prevMin = process.env.STAKE_CLAIM_MIN_RAW;
  const prevMax = process.env.STAKE_CLAIM_MAX_RAW;
  try {
    process.env.STAKE_CLAIM_MIN_RAW = '1000000';
    process.env.STAKE_CLAIM_MAX_RAW = '5000000';
    let cfg = readStakeClaimConfig();
    assert.equal(cfg.minClaimRaw, 1_000_000n);
    assert.equal(cfg.maxClaimRaw, 5_000_000n);

    // Garbage / negative / unset all collapse to 0 (= disabled), never throw.
    process.env.STAKE_CLAIM_MIN_RAW = 'not-a-number';
    process.env.STAKE_CLAIM_MAX_RAW = '-5';
    cfg = readStakeClaimConfig();
    assert.equal(cfg.minClaimRaw, 0n);
    assert.equal(cfg.maxClaimRaw, 0n);

    delete process.env.STAKE_CLAIM_MIN_RAW;
    delete process.env.STAKE_CLAIM_MAX_RAW;
    cfg = readStakeClaimConfig();
    assert.equal(cfg.minClaimRaw, 0n);
    assert.equal(cfg.maxClaimRaw, 0n);
  } finally {
    if (prevMin === undefined) delete process.env.STAKE_CLAIM_MIN_RAW;
    else process.env.STAKE_CLAIM_MIN_RAW = prevMin;
    if (prevMax === undefined) delete process.env.STAKE_CLAIM_MAX_RAW;
    else process.env.STAKE_CLAIM_MAX_RAW = prevMax;
  }
});
