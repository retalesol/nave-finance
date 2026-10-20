import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChainSwitchError } from '../../src/lib/evm/chainSwitchError';

test('a pending switch is not treated as a missing chain', () => {
  const err = {
    code: 4902,
    message: "SwitchChainError: code 4902: An error occurred when attempting to switch chain.",
    cause: {
      code: -32002,
      message: "Request of type 'wallet_switchEthereumChain' already pending for origin https://www.nave.finance.",
    },
  };
  assert.equal(classifyChainSwitchError(err), 'pending');
});

test('an unrecognized chain asks to be added', () => {
  assert.equal(
    classifyChainSwitchError({ code: 4902, message: 'Unrecognized chain ID 0xb626. Try adding the chain using wallet_addEthereumChain first.' }),
    'missing',
  );
});

test('a user rejection is distinct from a failed switch', () => {
  assert.equal(classifyChainSwitchError({ code: 4001, message: 'User rejected the request.' }), 'rejected');
});
