// Chain/network correctness (direction ↔ family ↔ chain-id) and the EIP-55
// checksum handling behind the bridge destination-address warning (audit M2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, isAddress } from 'viem';
import {
  isEvmChainId,
  isEvmTestnet,
  evmTarget,
  evmChainIdFor,
  chainKindFromAddress,
  isEvmAddress,
  chainFamilyLabelWithNetwork,
} from '../../src/lib/chain/types';
import { toAddress } from '../../src/lib/evm/addresses';

test('closed EVM chain-id set: only 1 / 8453 / 4663 / 11155111 / 84532 / 46630 are in scope', () => {
  for (const id of [1, 8453, 4663, 11155111, 84532, 46630]) assert.equal(isEvmChainId(id), true);
  for (const id of [56, 137, 42161, 10, 0]) assert.equal(isEvmChainId(id), false, `chain ${id} is out of scope`);
});

test('evmTarget: resolves the right family + testnet flag; throws on out-of-scope ids', () => {
  assert.deepEqual(
    { family: evmTarget(11155111).family, testnet: evmTarget(11155111).isTestnet },
    { family: 'ethereum', testnet: true },
  );
  assert.deepEqual(
    { family: evmTarget(84532).family, testnet: evmTarget(84532).isTestnet },
    { family: 'base', testnet: true },
  );
  assert.equal(evmTarget(1).isTestnet, false);
  assert.equal(evmTarget(8453).family, 'base');
  // Robinhood Chain (Arbitrum Nitro L2): testnet 46630, mainnet 4663.
  assert.deepEqual(
    { family: evmTarget(46630).family, testnet: evmTarget(46630).isTestnet },
    { family: 'robinhood', testnet: true },
  );
  assert.deepEqual(
    { family: evmTarget(4663).family, testnet: evmTarget(4663).isTestnet },
    { family: 'robinhood', testnet: false },
  );
  assert.throws(() => evmTarget(56 as never), /Unsupported EVM chain id/);
});

test('evmChainIdFor / isEvmTestnet: family+network maps to the correct chain id', () => {
  assert.equal(evmChainIdFor('ethereum', 'testnet'), 11155111);
  assert.equal(evmChainIdFor('ethereum', 'mainnet'), 1);
  assert.equal(evmChainIdFor('base', 'testnet'), 84532);
  assert.equal(evmChainIdFor('base', 'mainnet'), 8453);
  assert.equal(evmChainIdFor('robinhood', 'testnet'), 46630);
  assert.equal(evmChainIdFor('robinhood', 'mainnet'), 4663);
  assert.equal(isEvmTestnet(11155111), true);
  assert.equal(isEvmTestnet(1), false);
  assert.equal(isEvmTestnet(46630), true);
  assert.equal(isEvmTestnet(4663), false);
});

test('chainFamilyLabelWithNetwork: discloses Devnet/Sepolia/Mainnet per family', () => {
  const byFamily = { ethereum: 'testnet', base: 'mainnet', robinhood: 'mainnet' } as const;
  assert.equal(chainFamilyLabelWithNetwork('solana', byFamily, 'devnet'), 'Solana (Devnet)');
  assert.equal(chainFamilyLabelWithNetwork('ethereum', byFamily, 'devnet'), 'Ethereum (Sepolia)');
  assert.equal(chainFamilyLabelWithNetwork('base', byFamily, 'devnet'), 'Base (Mainnet)');
  assert.equal(chainFamilyLabelWithNetwork('robinhood', byFamily, 'devnet'), 'Robinhood Chain (Mainnet)');
});

test('address discriminator: EVM (0x…40 hex) vs Solana (base58), used to gate direction', () => {
  const evm = '0x1111111111111111111111111111111111111111';
  const sol = '9KTuzRJdDs59KU5UXNXdTQrPznEiiz4URk29NC3PkK5Q';
  assert.equal(chainKindFromAddress(evm), 'evm');
  assert.equal(chainKindFromAddress(sol), 'solana');
  assert.equal(isEvmAddress(evm), true);
  assert.equal(isEvmAddress(sol), false);
  // A Solana address must NOT validate as an EVM destination (wrong-chain guard).
  assert.equal(isEvmAddress('not-an-address'), false);
  assert.equal(isEvmAddress(null), false);
});

test('toAddress: returns the EIP-55 checksummed form (basis of the non-blocking warning)', () => {
  const lower = '0x1d1d988e8ffe542f1f8f7932de3a634251d4a042';
  const checksummed = toAddress(lower);
  assert.ok(checksummed);
  assert.equal(checksummed, getAddress(lower));
  // The UI compares the user's input to this checksummed value; when they differ
  // (e.g. an all-lowercase paste) it surfaces a non-blocking EIP-55 warning.
  assert.notEqual(checksummed, lower);
});

test('toAddress: rejects malformed / empty addresses (no silent coercion)', () => {
  assert.equal(toAddress('0x123'), null, 'too short');
  assert.equal(toAddress('deadbeef'), null, 'missing 0x + wrong length');
  assert.equal(toAddress(''), null);
  assert.equal(toAddress(null), null);
  assert.equal(toAddress(undefined), null);
});

test('EIP-55: a wrong-checksum mixed-case address fails strict isAddress and is rejected by toAddress', () => {
  const lower = '0x1d1d988e8ffe542f1f8f7932de3a634251d4a042';
  const checksummed = getAddress(lower); // canonical EIP-55 form
  // Corrupt one hex letter the checksum keeps lowercase by uppercasing it → the
  // address is now mixed-case but violates EIP-55.
  const chars = checksummed.split('');
  const idx = chars.findIndex((c, i) => i >= 2 && c >= 'a' && c <= 'f');
  assert.notEqual(idx, -1, 'address has at least one lowercase hex letter to corrupt');
  chars[idx] = chars[idx].toUpperCase();
  const badChecksum = chars.join('');
  assert.notEqual(badChecksum, checksummed);

  // Strict isAddress (viem default) enforces EIP-55 — a mistyped-case address is
  // flagged; format-only (strict:false) still passes. This is the signal behind
  // the bridge's non-blocking checksum warning (audit M2).
  assert.equal(isAddress(badChecksum), false, 'strict EIP-55 check fails');
  assert.equal(isAddress(badChecksum, { strict: false }), true, 'but the hex format is valid');
  // toAddress uses strict isAddress, so it rejects the mistyped-case address.
  assert.equal(toAddress(badChecksum), null, 'toAddress refuses a bad-checksum address');
  // A canonically-checksummed address round-trips cleanly.
  assert.equal(toAddress(checksummed), checksummed);
});
