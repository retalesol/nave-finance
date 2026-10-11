// Route enumeration + quoting. A route is only "supported" when its EVM leg has
// a WrappedNave contract configured (nothing to mint/burn otherwise), and both
// directions (solana_to_evm lock / evm_to_solana burn) are produced per chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSupportedBridgeRoutes,
  quoteBridge,
  hasWrappedNave,
} from '../../src/lib/bridge/routes';
import { computeBridgeFee, NAVE_BRIDGE_FEE_BPS } from '../../src/lib/programConfig';

test('getSupportedBridgeRoutes: both directions for each configured testnet chain', () => {
  const routes = getSupportedBridgeRoutes();
  // Sepolia (11155111) + Base Sepolia (84532) + Robinhood Testnet (46630) all
  // have wNAVE configured → 6 routes.
  assert.equal(routes.length, 6);

  const sepoliaOut = routes.find((r) => r.evmChainId === 11155111 && r.direction === 'solana_to_evm');
  const sepoliaIn = routes.find((r) => r.evmChainId === 11155111 && r.direction === 'evm_to_solana');
  assert.ok(sepoliaOut && sepoliaIn, 'both Sepolia directions present');
  assert.deepEqual(
    { from: sepoliaOut!.from, to: sepoliaOut!.to },
    { from: 'solana', to: 'ethereum' },
    'solana_to_evm goes solana -> ethereum family',
  );
  assert.deepEqual(
    { from: sepoliaIn!.from, to: sepoliaIn!.to },
    { from: 'ethereum', to: 'solana' },
    'evm_to_solana goes ethereum family -> solana',
  );

  const baseOut = routes.find((r) => r.evmChainId === 84532 && r.direction === 'solana_to_evm');
  assert.equal(baseOut?.to, 'base', 'Base Sepolia route uses the base family');

  // Robinhood Testnet (Arbitrum Nitro L2) appears once its wNAVE is configured,
  // in both directions, under the robinhood family.
  const rhOut = routes.find((r) => r.evmChainId === 46630 && r.direction === 'solana_to_evm');
  const rhIn = routes.find((r) => r.evmChainId === 46630 && r.direction === 'evm_to_solana');
  assert.ok(rhOut && rhIn, 'both Robinhood Testnet directions present');
  assert.deepEqual({ from: rhOut!.from, to: rhOut!.to }, { from: 'solana', to: 'robinhood' });
  assert.deepEqual({ from: rhIn!.from, to: rhIn!.to }, { from: 'robinhood', to: 'solana' });
});

test('hasWrappedNave: true for configured testnets, false for unconfigured mainnets', () => {
  assert.equal(hasWrappedNave(11155111), true, 'Sepolia wNAVE configured');
  assert.equal(hasWrappedNave(84532), true, 'Base Sepolia wNAVE configured');
  assert.equal(hasWrappedNave(46630), true, 'Robinhood Testnet wNAVE configured');
  // Mainnet legs are NOT wired in this deployment — routes for them stay hidden,
  // which is exactly how "no supported routes" arises when nothing is configured.
  assert.equal(hasWrappedNave(1), false, 'Ethereum mainnet wNAVE unconfigured');
  assert.equal(hasWrappedNave(8453), false, 'Base mainnet wNAVE unconfigured');
  assert.equal(hasWrappedNave(4663), false, 'Robinhood mainnet wNAVE unconfigured');
});

test('getSupportedBridgeRoutes: never emits a route for an unconfigured (mainnet) chain', () => {
  const routes = getSupportedBridgeRoutes();
  assert.equal(routes.some((r) => r.evmChainId === 1 || r.evmChainId === 8453 || r.evmChainId === 4663), false);
  assert.equal(routes.some((r) => r.evmChainId === 5042002), false, 'Arc has no wNAVE route');
  assert.equal(hasWrappedNave(5042002), false);
});

test('quoteBridge: mirrors computeBridgeFee and reports the total fee bps', () => {
  const net = 5_000_000n;
  const q = quoteBridge(net);
  const fee = computeBridgeFee(net);
  assert.equal(q.grossRaw, fee.grossRaw);
  assert.equal(q.feeRaw, fee.feeRaw);
  assert.equal(q.stakingRaw, fee.stakingRaw);
  assert.equal(q.protocolRaw, fee.protocolRaw);
  assert.equal(q.burnRaw, fee.burnRaw);
  assert.equal(q.feeBps, NAVE_BRIDGE_FEE_BPS);
});
