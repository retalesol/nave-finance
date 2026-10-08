import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_EVM_CHAINS,
  DEFAULT_EVM_CONFIRMATIONS,
  evmConfirmationsForChain,
  resolveEvmChainId,
} from './bridgeRelayer.js';
import { STAKING_EVM_CHAINS } from './stakingMirror.js';
import { robinhood, robinhoodTestnet } from './evmChains.js';

// Coverage for multi-network EVM wiring: chain-name / chain-id resolution
// (family names resolve ONLY via the explicit NAVE_EVM_NETWORK, never via the
// Solana cluster — audit CRITICAL #2), chain-aware confirmation depths with
// per-chain overrides, and the relayer/mirror chain maps staying in lockstep.

const PREV_CLUSTER = process.env.NAVE_CLUSTER;
const PREV_RPC = process.env.SOLANA_RPC_URL;
const PREV_EVM_NETWORK = process.env.NAVE_EVM_NETWORK;
const PREV_GLOBAL_CONF = process.env.BRIDGE_EVM_CONFIRMATIONS;

function withEnv(env: { cluster?: string; evmNetwork?: string }, fn: () => void): void {
  if (env.cluster === undefined) delete process.env.NAVE_CLUSTER;
  else process.env.NAVE_CLUSTER = env.cluster;
  if (env.evmNetwork === undefined) delete process.env.NAVE_EVM_NETWORK;
  else process.env.NAVE_EVM_NETWORK = env.evmNetwork;
  // Avoid RPC sniff overriding the explicit cluster in these unit tests.
  delete process.env.SOLANA_RPC_URL;
  try {
    fn();
  } finally {
    if (PREV_CLUSTER === undefined) delete process.env.NAVE_CLUSTER;
    else process.env.NAVE_CLUSTER = PREV_CLUSTER;
    if (PREV_RPC === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = PREV_RPC;
    if (PREV_EVM_NETWORK === undefined) delete process.env.NAVE_EVM_NETWORK;
    else process.env.NAVE_EVM_NETWORK = PREV_EVM_NETWORK;
  }
}
const withCluster = (cluster: string | undefined, fn: () => void) => withEnv({ cluster }, fn);

test('resolveEvmChainId: accepts all supported testnet ids as numbers and numeric strings', () => {
  for (const id of [11155111, 84532, 46630]) {
    assert.equal(resolveEvmChainId(id), id);
    assert.equal(resolveEvmChainId(String(id)), id);
  }
});

test('resolveEvmChainId: accepts all supported mainnet ids as numbers and numeric strings', () => {
  for (const id of [1, 8453, 4663]) {
    assert.equal(resolveEvmChainId(id), id);
    assert.equal(resolveEvmChainId(String(id)), id);
  }
});

test('resolveEvmChainId: explicit testnet aliases always pin testnets', () => {
  withCluster('mainnet', () => {
    assert.equal(resolveEvmChainId('sepolia'), 11155111);
    assert.equal(resolveEvmChainId('base-sepolia'), 84532);
    assert.equal(resolveEvmChainId('robinhood-testnet'), 46630);
  });
});

test('resolveEvmChainId: explicit mainnet aliases always pin mainnets', () => {
  withCluster('devnet', () => {
    assert.equal(resolveEvmChainId('ethereum-mainnet'), 1);
    assert.equal(resolveEvmChainId('base-mainnet'), 8453);
    assert.equal(resolveEvmChainId('robinhood-mainnet'), 4663);
  });
});

test('resolveEvmChainId: family names resolve to testnets when NAVE_EVM_NETWORK=testnet (regardless of cluster)', () => {
  // Even on a mainnet Solana cluster the EVM side is pinned by NAVE_EVM_NETWORK.
  withEnv({ cluster: 'mainnet', evmNetwork: 'testnet' }, () => {
    assert.equal(resolveEvmChainId('ethereum'), 11155111);
    assert.equal(resolveEvmChainId('eth'), 11155111);
    assert.equal(resolveEvmChainId('base'), 84532);
    assert.equal(resolveEvmChainId('robinhood'), 46630);
    assert.equal(resolveEvmChainId('ROBINHOOD'), 46630);
  });
});

test('resolveEvmChainId: family names resolve to mainnets when NAVE_EVM_NETWORK=mainnet (regardless of cluster)', () => {
  withEnv({ cluster: 'devnet', evmNetwork: 'mainnet' }, () => {
    assert.equal(resolveEvmChainId('ethereum'), 1);
    assert.equal(resolveEvmChainId('eth'), 1);
    assert.equal(resolveEvmChainId('base'), 8453);
    assert.equal(resolveEvmChainId('robinhood'), 4663);
  });
});

test('resolveEvmChainId: family names fail closed when NAVE_EVM_NETWORK is unset — the Solana cluster is never consulted', () => {
  for (const cluster of ['mainnet', 'devnet', undefined]) {
    withEnv({ cluster, evmNetwork: undefined }, () => {
      assert.throws(() => resolveEvmChainId('ethereum'), /Ambiguous EVM chain 'ethereum'/);
      assert.throws(() => resolveEvmChainId('base'), /NAVE_EVM_NETWORK/);
      // Numeric ids and explicit network aliases keep working without it.
      assert.equal(resolveEvmChainId(8453), 8453);
      assert.equal(resolveEvmChainId('base-sepolia'), 84532);
    });
  }
});

test('resolveEvmChainId: rejects unknown names and unsupported ids', () => {
  assert.throws(() => resolveEvmChainId(56), /Unsupported EVM chain/);
  assert.throws(() => resolveEvmChainId('polygon'), /Unsupported EVM chain/);
});

function withGlobalConfirmations(value: string | undefined, fn: () => void): void {
  if (value === undefined) delete process.env.BRIDGE_EVM_CONFIRMATIONS;
  else process.env.BRIDGE_EVM_CONFIRMATIONS = value;
  try {
    fn();
  } finally {
    if (PREV_GLOBAL_CONF === undefined) delete process.env.BRIDGE_EVM_CONFIRMATIONS;
    else process.env.BRIDGE_EVM_CONFIRMATIONS = PREV_GLOBAL_CONF;
  }
}

test('evmConfirmationsForChain: chain-aware safe defaults (Ethereum 12, Base 30, Robinhood 60)', () => {
  withGlobalConfirmations(undefined, () => {
    for (const id of [1, 8453, 4663, 11155111, 84532, 46630]) delete process.env[`BRIDGE_EVM_CONFIRMATIONS_${id}`];
    assert.equal(evmConfirmationsForChain(1), 12);
    assert.equal(evmConfirmationsForChain(11155111), 12);
    assert.equal(evmConfirmationsForChain(8453), 30);
    assert.equal(evmConfirmationsForChain(84532), 30);
    assert.equal(evmConfirmationsForChain(4663), 60);
    assert.equal(evmConfirmationsForChain(46630), 60);
    // Unknown chain: legacy global default.
    assert.equal(evmConfirmationsForChain(999999), DEFAULT_EVM_CONFIRMATIONS);
  });
});

test('evmConfirmationsForChain: per-chain env override wins; the global value is only a floor', () => {
  withGlobalConfirmations(undefined, () => {
    delete process.env.BRIDGE_EVM_CONFIRMATIONS_46630;
    // A shallow global count (5 blocks ≈ 1s on Robinhood) can NOT lower the chain default…
    assert.equal(evmConfirmationsForChain(46630, 5), 60);
    // …but a deeper one raises it.
    assert.equal(evmConfirmationsForChain(46630, 90), 90);

    process.env.BRIDGE_EVM_CONFIRMATIONS_46630 = '20';
    try {
      // Explicit per-chain operator value is authoritative (even below the default).
      assert.equal(evmConfirmationsForChain(46630, 5), 20);
      // Other chains are untouched by a 46630-specific override.
      assert.equal(evmConfirmationsForChain(11155111, 5), 12);
    } finally {
      delete process.env.BRIDGE_EVM_CONFIRMATIONS_46630;
    }
  });
});

test('evmConfirmationsForChain: garbage / negative overrides fall back to the chain default', () => {
  withGlobalConfirmations(undefined, () => {
    for (const bad of ['abc', '-3', '']) {
      process.env.BRIDGE_EVM_CONFIRMATIONS_46630 = bad;
      try {
        assert.equal(evmConfirmationsForChain(46630, 5), 60);
      } finally {
        delete process.env.BRIDGE_EVM_CONFIRMATIONS_46630;
      }
    }
  });
});

test('bridge relayer and staking mirror support the same EVM chain ids', () => {
  assert.deepEqual(
    Object.keys(BRIDGE_EVM_CHAINS).map(Number).sort((a, b) => a - b),
    Object.keys(STAKING_EVM_CHAINS).map(Number).sort((a, b) => a - b),
  );
  assert.deepEqual(
    Object.keys(BRIDGE_EVM_CHAINS).map(Number).sort((a, b) => a - b),
    [1, 8453, 4663, 84532, 46630, 11155111].sort((a, b) => a - b),
  );
});

test('staking mirror labels Robinhood events with the robinhood source_chain name', () => {
  assert.equal(STAKING_EVM_CHAINS[46630].name, 'robinhood');
  assert.equal(STAKING_EVM_CHAINS[46630].rpcEnv, 'EVM_ROBINHOOD_TESTNET_RPC_URL');
  assert.equal(STAKING_EVM_CHAINS[4663].name, 'robinhood');
  assert.equal(STAKING_EVM_CHAINS[4663].rpcEnv, 'EVM_ROBINHOOD_RPC_URL');
});

test('robinhood viem chain definitions carry the right ids and explorers', () => {
  assert.equal(robinhood.id, 4663);
  assert.equal(robinhood.blockExplorers?.default.url, 'https://robinhoodchain.blockscout.com');
  assert.equal(robinhoodTestnet.id, 46630);
  assert.equal(robinhoodTestnet.blockExplorers?.default.url, 'https://explorer.testnet.chain.robinhood.com');
  assert.equal(robinhoodTestnet.testnet, true);
  assert.equal(robinhoodTestnet.nativeCurrency.symbol, 'ETH');
});
