import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRESET_DEFAULTS,
  RISK_PRESETS,
  approvalsForPreset,
  rebalanceFreqToSecs,
  strategyChainFor,
  tierBoundedCaps,
} from '../../src/components/ConstitutionStep';
import { evmTokenSymbol, fitsOnchainName } from '../../src/components/create-dao/CreateDaoHelpers';

test('yield6 is a preset with a valid capital split', () => {
  assert.ok(RISK_PRESETS.some((p) => p.id === 'yield6'));
  const d = PRESET_DEFAULTS.yield6;
  assert.ok((d.minStablecoin ?? 0) + (d.maxDeployment ?? 0) <= 100);
});

test('presets approve dollar venues by tier and leave others alone', () => {
  const current = { aave: true, maple: false, 'maple-syrup': false, 'ethena-susde': true, cctp: true };
  const selectable = ['aave', 'maple-syrup', 'ethena-susde', 'cctp'];
  const conservative = approvalsForPreset('conservative', 'ethereum', current, selectable);
  assert.equal(conservative.aave, true);
  assert.equal(conservative['ethena-susde'], false);
  assert.equal(conservative.cctp, true);

  const yield6 = approvalsForPreset('yield6', 'ethereum', current, selectable);
  assert.equal(yield6['maple-syrup'], true);
  assert.equal(yield6['ethena-susde'], true);

  // Jito is SOL, not a dollar venue: presets keep whatever the user chose.
  assert.equal(approvalsForPreset('conservative', 'solana', { jito: false }, ['jito']).jito, false);
  assert.equal(approvalsForPreset('conservative', 'solana', { jito: true }, ['jito']).jito, true);
  // Keys outside `selectable` never turn on.
  assert.equal(approvalsForPreset('yield6', 'ethereum', {}, []).aave, undefined);
  // Custom leaves approvals untouched.
  assert.equal(approvalsForPreset('custom', 'ethereum', current, selectable), current);
});

test('rebalance under a day is raised to the on-chain minimum and symbols fit', () => {
  assert.equal(rebalanceFreqToSecs('Hourly'), 86_400);
  assert.equal(rebalanceFreqToSecs('Daily'), 86_400);
  assert.equal(rebalanceFreqToSecs('Weekly'), 604_800);
  assert.equal(rebalanceFreqToSecs('Manual'), 0);
  assert.equal(evmTokenSymbol('Governance Token'), 'GOVERNAN');
  assert.equal(evmTokenSymbol('HBR'), 'HBR');
  assert.equal(evmTokenSymbol('   '), 'DAO');
  assert.equal(fitsOnchainName('a'.repeat(32)), true);
  assert.equal(fitsOnchainName('a'.repeat(33)), false);
  assert.equal(fitsOnchainName(''), false);
});

test('tier-bounded caps keep Tier 3 inside 15% in total', () => {
  const capFor = tierBoundedCaps('evm', 1, {
    maxLending: 40,
    approvedProtocols: { aave: true, 'maple-syrup': true, 'ethena-susde': true, 'pendle-pt-susde': true },
  });
  assert.equal(capFor('aave'), 4000);
  assert.equal(capFor('maple-syrup') + capFor('ethena-susde') + capFor('pendle-pt-susde'), 1500);
  assert.equal(capFor('cctp'), 4000);
  assert.equal(strategyChainFor('evm', 84532), 'base');
  assert.equal(strategyChainFor('solana'), 'solana');
});
