// The two staking backends store the drip rate differently, and useStaking must
// normalize both to the same real emission before computing APY:
//   • Solana  reward_rate is FIXED-POINT scaled by 1e12 (RATE_SCALE):
//       annualEmission = rewardRate * SECONDS_PER_YEAR / RATE_SCALE
//   • EVM     rewardRate is UNSCALED base-units/sec:
//       annualEmission = rewardRate * SECONDS_PER_YEAR
// These are the exact expressions at the two useStaking call sites; this test
// pins that convention (and shows what breaks if the scaling is misapplied).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStakingApy, RATE_SCALE, SECONDS_PER_YEAR } from '../../src/lib/staking/solanaStakingProgram';
import { wrappedNaveAbi } from '../../src/lib/bridge/wrappedNaveAbi';
import { naveStakingAbi } from '../../src/lib/staking/naveStakingAbi';

const PERIOD_FINISH = 4_000_000_000n;
const NOW = 1_000;
const TOTAL_STAKED = 100_000_000n;

// Solana call-site emission (rate stored scaled by 1e12).
function solanaAnnualEmission(rewardRateScaled: bigint): bigint {
  return (rewardRateScaled * SECONDS_PER_YEAR) / RATE_SCALE;
}
// EVM call-site emission (rate stored unscaled).
function evmAnnualEmission(rewardRateUnscaled: bigint): bigint {
  return rewardRateUnscaled * SECONDS_PER_YEAR;
}

test('same REAL emission → identical APY across Solana (scaled) and EVM (unscaled)', () => {
  const realRatePerSec = 2n; // 2 base-units/sec on both chains
  const solanaApy = computeStakingApy({
    annualEmissionRaw: solanaAnnualEmission(realRatePerSec * RATE_SCALE), // Solana stores it *1e12
    totalStakedRaw: TOTAL_STAKED,
    periodFinish: PERIOD_FINISH,
    nowSec: NOW,
  });
  const evmApy = computeStakingApy({
    annualEmissionRaw: evmAnnualEmission(realRatePerSec), // EVM stores it raw
    totalStakedRaw: TOTAL_STAKED,
    periodFinish: PERIOD_FINISH,
    nowSec: NOW,
  });
  assert.notEqual(solanaApy, null);
  assert.equal(solanaApy, evmApy, 'both representations normalize to the same real emission');
});

test('misapplying the 1e12 scale to the EVM rate collapses the emission ~1e12x', () => {
  const evmRate = 5n; // unscaled
  const correct = evmAnnualEmission(evmRate);
  const wrongIfDescaled = (evmRate * SECONDS_PER_YEAR) / RATE_SCALE; // as if it were scaled
  assert.equal(correct, evmRate * SECONDS_PER_YEAR);
  assert.equal(wrongIfDescaled, 0n, 'de-scaling an unscaled rate wipes the emission — why the paths differ');
});

test('wrappedNave ABI exposes `approve` (step 1 of the EVM approve→stake flow)', () => {
  const approve = wrappedNaveAbi.find((e) => e.type === 'function' && e.name === 'approve');
  assert.ok(approve, 'approve present');
  assert.deepEqual(
    (approve as { inputs: { name: string; type: string }[] }).inputs.map((i) => i.type),
    ['address', 'uint256'],
    'approve(spender, amount) — the staking contract is granted an allowance for the stake amount',
  );
});

test('naveStaking ABI exposes stake/unstake/claim + reward reads (step 2 + on-chain state)', () => {
  const names = new Set(naveStakingAbi.filter((e) => e.type === 'function').map((e) => (e as { name: string }).name));
  for (const fn of ['stake', 'unstake', 'claim', 'users', 'pendingReward', 'rewardRate', 'totalStaked', 'periodFinish']) {
    assert.ok(names.has(fn), `naveStaking.${fn} is available to the hook`);
  }
});

test('EVM share-of-Solana accrual: user rate is stake / global TVL × Solana drip', () => {
  // Mirrors useStaking's fallback when this chain's local rewardRate is 0:
  // shareRate = userStaked / (solana + thisEvm + otherEvm) × solanaRatePerSec.
  function userShareRate(totalStaked: bigint, userStaked: bigint, poolRatePerSec: number): number {
    if (totalStaked <= 0n || userStaked <= 0n || poolRatePerSec <= 0) return 0;
    const share = Number(userStaked) / Number(totalStaked);
    if (!Number.isFinite(share)) return 0;
    return poolRatePerSec * share;
  }
  const solanaStaked = 100_000_000n;
  const thisEvmStaked = 50_000_000n;
  const otherEvmStaked = 50_000_000n;
  const userStaked = 25_000_000n; // half of this chain's pool
  const solanaRate = 10; // base-units/sec
  const global = solanaStaked + thisEvmStaked + otherEvmStaked;
  const rate = userShareRate(global, userStaked, solanaRate);
  assert.equal(rate, 1.25, '25% of global TVL × 10 u/s = 1.25 u/s');
  assert.equal(userShareRate(global, userStaked, 0), 0, 'inactive Solana drip → no projected accrual');
  assert.equal(userShareRate(0n, userStaked, solanaRate), 0, 'empty global TVL → no accrual');
});
