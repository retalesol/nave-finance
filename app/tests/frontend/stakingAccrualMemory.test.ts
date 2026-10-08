// EVM share-of-Solana reward projection is display-side (the EVM contract has
// no record of it), so useStaking persists the accrual per (chain, wallet) in
// localStorage via accrualMemory. These tests pin the fold/continue/clear
// behavior that keeps the claimable counter from restarting at zero on refresh.
import test from 'node:test';
import assert from 'node:assert/strict';

// Node has no localStorage — install a minimal in-memory shim before the
// module under test touches it.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { foldAccrual, clearAccrual } = await import('../../src/lib/staking/accrualMemory');

const CHAIN = 11155111;
const WALLET = '0xAbCd000000000000000000000000000000000001';
const STAKED = 25_000_000n;

test('accrual folds rate × elapsed across syncs and survives a fresh session', () => {
  store.clear();
  const t0 = 1_000_000;

  // First sync: nothing stored yet — starts at zero and anchors the rate.
  assert.equal(foldAccrual(CHAIN, WALLET, STAKED, 2, t0), 0n);

  // 30s later at 2 units/sec → 60 units folded in.
  assert.equal(foldAccrual(CHAIN, WALLET, STAKED, 2, t0 + 30_000), 60n);

  // "Page refresh": a brand-new fold call (new hook instance) continues from
  // the stored total instead of restarting — 10 more seconds → 80.
  assert.equal(foldAccrual(CHAIN, WALLET, STAKED, 2, t0 + 40_000), 80n);

  // Rate change is applied from its own anchor: 20s at the NEW rate of 5.
  assert.equal(foldAccrual(CHAIN, WALLET, STAKED, 5, t0 + 40_000), 80n); // re-anchor at same instant
  assert.equal(foldAccrual(CHAIN, WALLET, STAKED, 5, t0 + 60_000), 180n); // 80 + 5×20
});

test('clock skew (anchor in the future) never subtracts from the total', () => {
  store.clear();
  const t0 = 5_000_000;
  foldAccrual(CHAIN, WALLET, STAKED, 3, t0);
  assert.equal(foldAccrual(CHAIN, WALLET, STAKED, 3, t0 - 10_000), 0n);
});

test('records are scoped per (chain, wallet) and cleared independently', () => {
  store.clear();
  const t0 = 9_000_000;
  foldAccrual(CHAIN, WALLET, STAKED, 4, t0);
  foldAccrual(8453, WALLET, STAKED, 4, t0);
  assert.equal(foldAccrual(CHAIN, WALLET, STAKED, 4, t0 + 10_000), 40n);
  assert.equal(foldAccrual(8453, WALLET, STAKED, 4, t0 + 20_000), 80n);

  // Claim on one chain clears only that chain's record.
  clearAccrual(CHAIN, WALLET);
  assert.equal(foldAccrual(CHAIN, WALLET, STAKED, 4, t0 + 30_000), 0n);
  assert.equal(foldAccrual(8453, WALLET, STAKED, 4, t0 + 30_000), 120n);
});

test('wallet key is case-insensitive (checksummed vs lowercase address)', () => {
  store.clear();
  const t0 = 12_000_000;
  foldAccrual(CHAIN, WALLET.toLowerCase(), STAKED, 1, t0);
  assert.equal(foldAccrual(CHAIN, WALLET.toUpperCase().replace('0X', '0x'), STAKED, 1, t0 + 5_000), 5n);
});
