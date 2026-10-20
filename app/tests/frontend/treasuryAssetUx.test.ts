import test from 'node:test';
import assert from 'node:assert/strict';
import { treasuryAssetLabel, WSOL_MINT } from '../../src/lib/treasuryAssetLabels';
import { isSendableTreasuryAsset, isSelectableTreasuryMint } from '../../src/lib/treasuryAssetEligibility';
import { projectedYieldFromApy } from '../../src/lib/projectedYield';

const dexWrapped = { symbol: 'SOL', name: 'Wrapped SOL' };

test('native SOL keeps its own label when market data describes wrapped SOL', () => {
  assert.deepEqual(treasuryAssetLabel('SOL', dexWrapped), { symbol: 'SOL', name: 'Solana' });
});

test('wrapped SOL is labeled wSOL even when the market symbol is SOL', () => {
  assert.deepEqual(treasuryAssetLabel(WSOL_MINT, dexWrapped), { symbol: 'wSOL', name: 'Wrapped SOL' });
});

test('unknown mints can use market metadata', () => {
  assert.deepEqual(
    treasuryAssetLabel('Mint111111111111111111111111111111111111111', { symbol: 'BONK', name: 'Bonk' }),
    { symbol: 'BONK', name: 'Bonk' },
  );
});

test('held assets are sendable without registration, including native SOL', () => {
  assert.equal(isSendableTreasuryAsset({
    mint: 'SOL', uiBalance: 0.0005, onChainRegistered: false, enabled: false,
  }), true);
  assert.equal(isSendableTreasuryAsset({
    mint: WSOL_MINT, uiBalance: 1, onChainRegistered: false, enabled: false,
  }), true);
  assert.equal(isSendableTreasuryAsset({
    mint: '0xabc', uiBalance: 2, onChainRegistered: false, enabled: false,
  }), true);
  assert.equal(isSendableTreasuryAsset({
    mint: WSOL_MINT, uiBalance: 1, onChainRegistered: true, enabled: false,
  }), false);
  assert.equal(isSendableTreasuryAsset({
    mint: 'ETH', uiBalance: 1, onChainRegistered: false, enabled: false,
  }), false);
  assert.equal(isSendableTreasuryAsset({
    mint: 'SOL', uiBalance: 0, onChainRegistered: false, enabled: true,
  }), false);
});

test('strategy pickers include held unregistered mints and skip native gas tokens', () => {
  assert.equal(isSelectableTreasuryMint({
    mint: WSOL_MINT, uiBalance: 1, onChainRegistered: false, enabled: false,
  }), true);
  assert.equal(isSelectableTreasuryMint({
    mint: 'SOL', uiBalance: 1, onChainRegistered: false, enabled: true,
  }), false);
});

test('blended APY projects daily, weekly, and annual yield', () => {
  const outlook = projectedYieldFromApy(10_000, 12);
  assert.equal(outlook.annual, 1200);
  assert.ok(Math.abs(outlook.weekly - 1200 / 52) < 1e-9);
  assert.ok(Math.abs(outlook.daily - 1200 / 365) < 1e-9);
});
