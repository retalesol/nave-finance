// "Your Transactions" merges DB-derived stake/claim rows with locally recorded
// entries (Solana actions, in-flight claims). These tests pin the dedupe rules
// (DB rows supersede the local entries that produced them), the newest-first
// ordering, and the staged claim status labels shown while the relayer wraps
// and delivers a claim.
import test from 'node:test';
import assert from 'node:assert/strict';

// Node has no localStorage/window — install minimal shims before the module
// under test touches them.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as Record<string, unknown>).window = {
  dispatchEvent: () => true,
};

const {
  activityStatusLabel,
  isActivityInFlight,
  mergeActivity,
  readLocalActivity,
  removeActivity,
  upsertActivity,
} = await import('../../src/lib/staking/activityFeed');
type ActivityEntry = import('../../src/lib/staking/activityFeed').ActivityEntry;

const WALLET = '0x1FA9d4AD76d53fBf1274D10acBa12463AE90bDCA';

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
    kind: 'claim',
    chainFamily: 'ethereum',
    wallet: WALLET,
    status: 'completed',
    createdAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  };
}

test('upsert inserts then updates in place, and reads are wallet-scoped case-insensitively', () => {
  store.clear();
  upsertActivity(entry({ id: 'a', status: 'signing' }));
  upsertActivity(entry({ id: 'a', status: 'wrapping' }));
  upsertActivity(entry({ id: 'b', wallet: '0xothersomeone' }));

  const mine = readLocalActivity([WALLET.toUpperCase()]);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, 'a');
  assert.equal(mine[0].status, 'wrapping');

  removeActivity('a');
  assert.equal(readLocalActivity([WALLET]).length, 0);
});

test('merge: DB row supersedes the local entry by claim id or tx hash, newest first', () => {
  const localClaim = entry({ id: 'local-1', claimId: 'db-1', status: 'delivering', createdAt: '2026-07-08T00:02:00Z' });
  const localStake = entry({ id: 'local-2', kind: 'stake', tx: '0xstake', createdAt: '2026-07-08T00:03:00Z' });
  const localOther = entry({ id: 'local-3', kind: 'stake', tx: '0xunrelated', createdAt: '2026-07-08T00:01:00Z' });

  const dbClaim = entry({ id: 'db-1', claimId: 'db-1', status: 'completed', createdAt: '2026-07-08T00:02:00Z' });
  const dbStake = entry({ id: 'db-2', kind: 'stake', tx: '0xstake', createdAt: '2026-07-08T00:03:00Z' });

  const merged = mergeActivity([localClaim, localStake, localOther], [dbClaim, dbStake]);
  // Local claim + stake replaced by their DB rows; unrelated local kept.
  assert.deepEqual(
    merged.map((e) => e.id),
    ['db-2', 'db-1', 'local-3'],
  );
  assert.equal(merged[1].status, 'completed');
});

test('claim status labels walk the staged pipeline; in-flight detection matches', () => {
  const chain = 'Sepolia';
  assert.equal(activityStatusLabel(entry({ status: 'signing' }), chain), 'Awaiting signature…');
  assert.equal(activityStatusLabel(entry({ status: 'submitted' }), chain), 'Claim submitted');
  assert.equal(activityStatusLabel(entry({ status: 'pending' }), chain), 'Claim submitted'); // legacy rows
  assert.equal(activityStatusLabel(entry({ status: 'wrapping' }), chain), 'Wrapping on Solana…');
  assert.equal(activityStatusLabel(entry({ status: 'delivering' }), chain), 'Delivering to Sepolia…');
  assert.equal(activityStatusLabel(entry({ status: 'completed' }), chain), 'completed');
  assert.equal(activityStatusLabel(entry({ status: 'failed' }), chain), 'failed');

  for (const status of ['signing', 'submitted', 'pending', 'wrapping', 'delivering']) {
    assert.equal(isActivityInFlight(entry({ status })), true, `${status} should be in flight`);
  }
  for (const status of ['completed', 'failed']) {
    assert.equal(isActivityInFlight(entry({ status })), false, `${status} should be terminal`);
  }
  // Stakes/unstakes are never "in flight" — they are recorded post-confirmation.
  assert.equal(isActivityInFlight(entry({ kind: 'stake', status: 'pending' })), false);
});
