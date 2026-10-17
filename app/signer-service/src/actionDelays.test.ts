import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAINNET_VOTING_PERIOD_SECONDS,
  TESTNET_VOTING_PERIOD_SECONDS,
  evmStrategyVotingPeriodSeconds,
  solanaVotingPeriodSeconds,
} from './actionDelays';

test('devnet signer accepts a 60-second vote and defaults to it when the request omits one', () => {
  assert.equal(solanaVotingPeriodSeconds(undefined, false), TESTNET_VOTING_PERIOD_SECONDS);
  assert.equal(solanaVotingPeriodSeconds(0, false), TESTNET_VOTING_PERIOD_SECONDS);
  assert.equal(solanaVotingPeriodSeconds(60, false), 60);
  for (const chainId of [11155111, 84532, 46630, 5042002]) {
    assert.equal(evmStrategyVotingPeriodSeconds(chainId), 60n, String(chainId));
  }
});

test('planner proposals on testnet stay open for a day; mainnet stays at 7 days', () => {
  assert.equal(solanaVotingPeriodSeconds(undefined, false, true), 86_400);
  assert.equal(solanaVotingPeriodSeconds(undefined, true, true), MAINNET_VOTING_PERIOD_SECONDS);
  assert.equal(evmStrategyVotingPeriodSeconds(11155111, true), 86_400n);
  assert.equal(evmStrategyVotingPeriodSeconds(1, true), 604_800n);
});

test('mainnet signer defaults to the 7-day voting period', () => {
  assert.equal(solanaVotingPeriodSeconds(undefined, true), MAINNET_VOTING_PERIOD_SECONDS);
  assert.equal(solanaVotingPeriodSeconds(0, true), MAINNET_VOTING_PERIOD_SECONDS);
  assert.equal(MAINNET_VOTING_PERIOD_SECONDS, 604_800);
  for (const chainId of [1, 8453, 4663]) {
    assert.equal(evmStrategyVotingPeriodSeconds(chainId), 604_800n, String(chainId));
  }
});
