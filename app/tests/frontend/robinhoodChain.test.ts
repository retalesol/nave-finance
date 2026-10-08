// Robinhood Chain (Arbitrum Nitro L2) wiring — chain-id mapping, viem chain
// definitions (ids, currency, Blockscout explorers), config plumbing, and DAO
// chain inclusion (robinhood is a full USER_CHAINS option).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVM_CHAIN_IDS,
  USER_CHAINS,
  WALLET_CHAINS,
  CHAIN_COLORS,
  isEvmChainId,
  isEvmTestnet,
  evmTarget,
  evmChainIdFor,
  chainFamilyLabel,
  chainFamilyLabelWithNetwork,
} from '../../src/lib/chain/types';
import { robinhood, robinhoodTestnet } from '../../src/lib/evm/robinhoodChains';
import {
  ACTIVE_EVM_CHAIN_IDS,
  EVM_WRAPPED_NAVE_ADDRESSES,
  EVM_STAKING_ADDRESSES,
  EVM_RPC_URLS,
} from '../../src/lib/programConfig';

test('chain-id mapping: robinhood family resolves to 4663 (mainnet) / 46630 (testnet)', () => {
  assert.equal(evmChainIdFor('robinhood', 'mainnet'), 4663);
  assert.equal(evmChainIdFor('robinhood', 'testnet'), 46630);
  assert.equal(isEvmChainId(4663), true);
  assert.equal(isEvmChainId(46630), true);
  assert.equal(isEvmTestnet(46630), true);
  assert.equal(isEvmTestnet(4663), false);
  assert.equal(evmTarget(46630).label, 'Robinhood Testnet');
  assert.equal(evmTarget(4663).label, 'Robinhood Chain');
});

test('viem chain definitions: ids, ETH currency, Blockscout explorer URLs', () => {
  assert.equal(robinhood.id, 4663);
  assert.equal(robinhoodTestnet.id, 46630);
  assert.equal(robinhood.nativeCurrency.symbol, 'ETH');
  assert.equal(robinhoodTestnet.nativeCurrency.symbol, 'ETH');
  assert.equal(robinhoodTestnet.testnet, true);
  // Blockscout tx links are `<explorer>/tx/<hash>` — same shape the Bridge
  // history + toast links build.
  assert.equal(robinhood.blockExplorers?.default.url, 'https://robinhoodchain.blockscout.com');
  assert.equal(
    robinhoodTestnet.blockExplorers?.default.url,
    'https://explorer.testnet.chain.robinhood.com',
  );
  // Default RPCs are the chain's PUBLIC endpoints — a keyed provider URL must
  // never be baked into the bundle.
  for (const c of [robinhood, robinhoodTestnet]) {
    for (const url of c.rpcUrls.default.http) {
      assert.doesNotMatch(url, /alchemy|api-key|apikey/i, 'no keyed RPC in chain defaults');
    }
  }
});

test('testnet deployment activates 46630 (and never a mainnet id)', () => {
  assert.deepEqual([...ACTIVE_EVM_CHAIN_IDS].sort((a, b) => a - b), [84532, 46630, 11155111].sort((a, b) => a - b));
  assert.equal(ACTIVE_EVM_CHAIN_IDS.includes(4663), false, 'mainnet Robinhood inactive on testnet');
});

test('config plumbing: robinhood address/RPC env slots exist in the closed maps', () => {
  // The default test profile configures the Robinhood testnet triple slots.
  assert.ok(EVM_WRAPPED_NAVE_ADDRESSES[46630], 'wNAVE slot populated from env');
  assert.ok(EVM_STAKING_ADDRESSES[46630], 'staking slot populated from env');
  assert.ok(EVM_RPC_URLS[46630], 'RPC override slot populated from env');
  // Mainnet slots exist but stay empty until cutover.
  assert.equal(EVM_WRAPPED_NAVE_ADDRESSES[4663], undefined);
});

test('wallet switcher: Bridge keeps all chains; app surfaces are Base+RH', () => {
  // Bridge & Stake keep the full four-family switcher.
  assert.deepEqual([...WALLET_CHAINS], ['solana', 'ethereum', 'base', 'robinhood']);
  // Homepage / lobby / DAO app use APP_WALLET_CHAINS (= USER_CHAINS).
  assert.deepEqual([...USER_CHAINS], ['base', 'robinhood']);
  // Solana purple, Ethereum grey, Base blue, Robinhood green.
  assert.equal(CHAIN_COLORS.solana, '#9945FF');
  assert.equal(CHAIN_COLORS.ethereum, '#8C8C8C');
  assert.equal(CHAIN_COLORS.base, '#0052FF');
  assert.equal(CHAIN_COLORS.robinhood, '#00C805');
});

test('DAO chains: robinhood is selectable for treasury creation', () => {
  assert.equal(USER_CHAINS.includes('robinhood'), true, 'DAO creation offers robinhood');
  assert.deepEqual([...USER_CHAINS], ['base', 'robinhood']);
  assert.equal(USER_CHAINS.includes('solana'), false, 'Solana DAO create disabled');
  assert.equal(USER_CHAINS.includes('ethereum'), false, 'Ethereum DAO create disabled');
  assert.equal(chainFamilyLabel('robinhood'), 'Robinhood Chain');
  assert.equal(chainFamilyLabelWithNetwork('robinhood', 'testnet'), 'Robinhood Chain (Testnet)');
  assert.equal(chainFamilyLabelWithNetwork('robinhood', 'mainnet'), 'Robinhood Chain (Mainnet)');
  // The closed chain-id set now has exactly six entries.
  assert.deepEqual([...EVM_CHAIN_IDS].sort((a, b) => a - b), [1, 4663, 8453, 46630, 84532, 11155111].sort((a, b) => a - b));
});
