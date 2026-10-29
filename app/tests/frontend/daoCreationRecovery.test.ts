import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPendingDaoCreation,
  daoCreationFailureMessage,
  findPendingDaoCreationForWallet,
  savePendingDaoCreation,
  type PendingDaoCreation,
} from '../../src/lib/daoCreationRecovery.ts';

const memory = new Map<string, string>();

test.before(() => {
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
});

test.afterEach(() => {
  memory.clear();
});

function checkpoint(failedError: string): PendingDaoCreation {
  return {
    chain: 'solana',
    daoAddress: 'Dao111111111111111111111111111111111111111',
    daoId: 4,
    founder: 'Founder1111111111111111111111111111111111',
    name: 'Harbor',
    slug: 'harbor',
    description: '',
    governanceType: 'wallets',
    tokenMode: null,
    existingTokenCA: '',
    newTokenName: '',
    newTokenSupply: '',
    votingTokenMint: null,
    guardianWallets: [],
    seedAmount: '0',
    policy: {
      riskPreset: 'balanced',
      minStablecoin: 20,
      maxDeployment: 60,
      maxLending: 30,
      liquidityReserve: 10,
      rebalanceFreq: 'Weekly',
      approvedProtocols: { kamino: true },
      confidenceThreshold: 70,
    },
    website: '',
    twitter: '',
    discord: '',
    logoUrl: '',
    failedStep: 'Setting up DAO governance & extensions',
    failedError,
    failedAt: new Date().toISOString(),
  };
}

test('an in-progress governance checkpoint is saved but is not a failure', () => {
  const record = checkpoint('');
  savePendingDaoCreation(record);
  const pending = findPendingDaoCreationForWallet(record.founder);
  assert.equal(pending?.daoAddress, record.daoAddress);
  assert.equal(daoCreationFailureMessage(pending), null);
  assert.equal(daoCreationFailureMessage({ failedError: '   ' }), null);
});

test('a wallet error is the resume banner failure', () => {
  const record = checkpoint('User rejected the request');
  savePendingDaoCreation(record);
  const pending = findPendingDaoCreationForWallet(record.founder);
  assert.equal(daoCreationFailureMessage(pending), 'User rejected the request');
  clearPendingDaoCreation(record.chain, record.founder);
  assert.equal(findPendingDaoCreationForWallet(record.founder), null);
});
