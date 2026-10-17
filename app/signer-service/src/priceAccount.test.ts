import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  CHAINLINK_SOL_USD_DEVNET,
  CHAINLINK_SOL_USD_MAINNET,
  WSOL_MINT,
  executionPriceAccount,
} from './priceAccount.js';

const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

test('wSOL execute/withdraw uses the cluster Chainlink SOL/USD feed', () => {
  assert.ok(executionPriceAccount(WSOL_MINT, false).equals(CHAINLINK_SOL_USD_DEVNET));
  assert.ok(executionPriceAccount(WSOL_MINT, true).equals(CHAINLINK_SOL_USD_MAINNET));
});

test('an explicit price account wins over the wSOL default', () => {
  const explicit = USDC.toBase58();
  assert.ok(executionPriceAccount(WSOL_MINT, false, explicit).equals(USDC));
});

test('other mints keep the mint placeholder', () => {
  assert.ok(executionPriceAccount(USDC, false).equals(USDC));
  assert.ok(executionPriceAccount(USDC, true, '').equals(USDC));
});
