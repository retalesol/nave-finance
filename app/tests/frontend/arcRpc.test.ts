import test from 'node:test';
import assert from 'node:assert/strict';
import { arcTestnet } from '../../src/lib/evm/arcChains';
import { ARC_TESTNET_RPC_URL, resolveArcTestnetRpc } from '../../src/lib/evm/arcRpc';
import { explainEvmSendError } from '../../src/lib/evm/walletRpcError';

test('Arc uses the resolving public RPC and ignores the retired host', () => {
  assert.equal(ARC_TESTNET_RPC_URL, 'https://rpc.testnet.arc.io');
  assert.equal(arcTestnet.rpcUrls.default.http[0], ARC_TESTNET_RPC_URL);
  assert.equal(resolveArcTestnetRpc(undefined), ARC_TESTNET_RPC_URL);
  assert.equal(resolveArcTestnetRpc('https://rpc.testnet.arc.network'), ARC_TESTNET_RPC_URL);
  assert.equal(resolveArcTestnetRpc('https://rpc.testnet.arc.network/'), ARC_TESTNET_RPC_URL);
  assert.equal(resolveArcTestnetRpc('https://custom-arc.example/rpc'), 'https://custom-arc.example/rpc');
});

test('a nameless-chain resource error tells the user which RPC to set', () => {
  const err = new Error(
    'ContractFunctionExecutionError: Requested resource not available.\n\nRequest Arguments:\n  chain: undefined (id: 5042002)',
  );
  const message = explainEvmSendError(err, 5042002);
  assert.match(message ?? '', /Arc Testnet/);
  assert.match(message ?? '', /https:\/\/rpc\.testnet\.arc\.io/);
});

test('an already-pending wallet request is not described as a dead RPC', () => {
  const err = {
    shortMessage: 'Requested resource not available.',
    cause: { message: "Request of type 'wallet_switchEthereumChain' already pending" },
  };
  assert.match(explainEvmSendError(err, 11155111) ?? '', /already open in your wallet/);
});
