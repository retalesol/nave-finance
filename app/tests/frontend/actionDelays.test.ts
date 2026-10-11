import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAINNET_DEFAULT_VOTING_PERIOD_SECONDS,
  MAINNET_MIN_MANUAL_VOTING_SECONDS,
  TESTNET_ACTION_DELAY_SECONDS,
  defaultReviewPeriodSeconds,
  resolveSubmittedVotingPeriod,
  reviewWindowMinSeconds,
  votingPeriodForNetwork,
  type ActionDelayContext,
} from '../../src/lib/actionDelays';
import { formatVotingTimeLeft } from '../../src/components/governance/voteActionHelpers';

const sepolia: ActionDelayContext = { kind: 'evm', chainId: 11155111 };
const baseSepolia: ActionDelayContext = { kind: 'evm', chainId: 84532 };
const robinhoodTestnet: ActionDelayContext = { kind: 'evm', chainId: 46630 };
const arcTestnet: ActionDelayContext = { kind: 'evm', chainId: 5042002 };
const ethereum: ActionDelayContext = { kind: 'evm', chainId: 1 };
const base: ActionDelayContext = { kind: 'evm', chainId: 8453 };
const robinhood: ActionDelayContext = { kind: 'evm', chainId: 4663 };
const solDevnet: ActionDelayContext = { kind: 'solana', network: 'devnet' };
const solLocal: ActionDelayContext = { kind: 'solana', network: 'localnet' };
const solMainnet: ActionDelayContext = { kind: 'solana', network: 'mainnet' };

test('testnet proposal voting period of 60 seconds is accepted', () => {
  for (const ctx of [sepolia, baseSepolia, robinhoodTestnet, arcTestnet, solDevnet, solLocal]) {
    assert.equal(
      resolveSubmittedVotingPeriod({ ctx, isReview: true, reviewPeriodSecs: 60, votingDays: 7 }),
      TESTNET_ACTION_DELAY_SECONDS,
      JSON.stringify(ctx),
    );
    assert.equal(
      resolveSubmittedVotingPeriod({ ctx, isReview: false, reviewPeriodSecs: 86_400, votingDays: 7 }),
      TESTNET_ACTION_DELAY_SECONDS,
      JSON.stringify(ctx),
    );
    assert.equal(defaultReviewPeriodSeconds('policy', ctx), 60);
    assert.equal(defaultReviewPeriodSeconds('strategy', ctx), 60);
    assert.equal(votingPeriodForNetwork(MAINNET_DEFAULT_VOTING_PERIOD_SECONDS, ctx), 60);
    assert.equal(reviewWindowMinSeconds('evm', ctx), 60);
  }
});

test('mainnet manual proposals refuse a voting period under one day and default to the long window', () => {
  for (const ctx of [ethereum, base, robinhood, solMainnet, { kind: 'deployment', mode: 'mainnet' } as const]) {
    assert.equal(
      resolveSubmittedVotingPeriod({ ctx, isReview: false, reviewPeriodSecs: 60, votingDays: 0.5 }),
      MAINNET_MIN_MANUAL_VOTING_SECONDS,
      JSON.stringify(ctx),
    );
    assert.equal(
      resolveSubmittedVotingPeriod({ ctx, isReview: false, reviewPeriodSecs: 60, votingDays: 7 }),
      MAINNET_DEFAULT_VOTING_PERIOD_SECONDS,
      JSON.stringify(ctx),
    );
    assert.equal(
      votingPeriodForNetwork(MAINNET_DEFAULT_VOTING_PERIOD_SECONDS, ctx),
      MAINNET_DEFAULT_VOTING_PERIOD_SECONDS,
      JSON.stringify(ctx),
    );
  }
  assert.equal(defaultReviewPeriodSeconds('policy', ethereum), 86_400);
  assert.equal(defaultReviewPeriodSeconds('strategy', base), 259_200);
  assert.equal(
    resolveSubmittedVotingPeriod({ ctx: ethereum, isReview: true, reviewPeriodSecs: 3600, votingDays: 7 }),
    3600,
  );
  assert.equal(reviewWindowMinSeconds('evm', ethereum), 3600);
  assert.equal(reviewWindowMinSeconds('solana', solMainnet), 60);
  assert.equal(
    votingPeriodForNetwork(MAINNET_DEFAULT_VOTING_PERIOD_SECONDS, { kind: 'deployment', mode: 'mixed' }),
    MAINNET_DEFAULT_VOTING_PERIOD_SECONDS,
  );
});

test('a one-minute vote is not labeled as a full day', () => {
  assert.equal(formatVotingTimeLeft(60), '1m');
  assert.equal(formatVotingTimeLeft(7 * 86_400), '7d');
});
