import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readInvoiceSettleConfig,
  runSettleTick,
  selectSettleWork,
  type SettleCandidate,
} from './invoiceSettlePlan.js';

function candidate(overrides: Partial<SettleCandidate> = {}): SettleCandidate {
  return {
    chain: 'solana',
    chainId: null,
    kind: 'solana_vault',
    address: 'vault',
    asset: 'native',
    invoiceId: 'inv',
    invoiceIdHex: '11'.repeat(32),
    dao: 'dao',
    balance: 1n,
    ...overrides,
  };
}

test('missing router and program config does not plan or broadcast', async () => {
  assert.equal(readInvoiceSettleConfig({}), null);
  assert.equal(readInvoiceSettleConfig({ NAVE_PAY_ROUTERS: 'not-json' }), null);
  assert.deepEqual(selectSettleWork(null, [candidate()]), []);

  let sent = false;
  const result = await runSettleTick({}, async () => {
    sent = true;
    return 'broadcast';
  });
  assert.deepEqual(result, { status: 'noop', reason: 'config_absent' });
  assert.equal(sent, false);
});

test('a configured chain plans only invoices with a balance', () => {
  const config = readInvoiceSettleConfig({
    NAVE_PAY_SOLANA_PROGRAM_ID: '8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB',
    NAVE_PAY_ROUTERS: '{"1":"0x3333333333333333333333333333333333333333"}',
  });
  const planned = selectSettleWork(config, [
    candidate({ balance: 5n }),
    candidate({ balance: 0n, invoiceId: 'empty' }),
    candidate({
      chain: 'ethereum',
      chainId: 1,
      kind: 'evm_forwarder',
      invoiceId: 'eth',
      balance: 2n,
    }),
    candidate({
      chain: 'base',
      chainId: 8453,
      kind: 'evm_forwarder',
      invoiceId: 'base',
      balance: 9n,
    }),
  ]);
  assert.deepEqual(planned.map((row) => row.invoiceId), ['inv', 'eth']);
});
