import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeConstitutionPayload,
  encodeConstitutionPayload,
  MAX_PROPOSAL_PAYLOAD_LEN,
} from '../../src/lib/constitutionPayload';

const ADAPTER = '0x1111111111111111111111111111111111111111';

test('three approved protocols with adapter addresses fit under the 512-byte cap', () => {
  const bytes = encodeConstitutionPayload({
    v: 1,
    protocols: [
      { id: 'aave', approved: true, maxAllocationBps: 7000, adapter: ADAPTER },
      { id: 'compound', approved: true, maxAllocationBps: 7000, adapter: ADAPTER },
      { id: 'cctp', approved: true, maxAllocationBps: 7000, adapter: ADAPTER },
    ],
    confidenceThreshold: 70,
    riskPreset: 'aggressive',
    minStablecoin: 15,
    maxDeployment: 85,
    maxLending: 70,
    liquidityReserve: 15,
    rebalanceFreq: 'Weekly',
  });
  assert.ok(bytes.length <= MAX_PROPOSAL_PAYLOAD_LEN, `payload is ${bytes.length} bytes`);
  const decoded = decodeConstitutionPayload(bytes);
  assert.equal(decoded?.protocols.length, 3);
  assert.equal(decoded?.protocols[0]?.id, 'aave');
  assert.equal(decoded?.protocols[0]?.approved, true);
  assert.equal(decoded?.protocols[0]?.maxAllocationBps, 7000);
  assert.equal(decoded?.protocols[0]?.adapter, undefined);
  assert.equal(decoded?.riskPreset, 'aggressive');
  assert.equal(decoded?.minStablecoin, 15);
  assert.equal(decoded?.maxDeployment, 85);
  assert.equal(decoded?.rebalanceFreq, 'Weekly');
  assert.equal(decoded?.confidenceThreshold, 70);
});

test('unapproved protocols are omitted and version-1 payloads still decode', () => {
  const bytes = encodeConstitutionPayload({
    v: 1,
    protocols: [
      { id: 'aave', approved: true, maxAllocationBps: 4000 },
      { id: 'compound', approved: false, maxAllocationBps: 1000 },
    ],
    confidenceThreshold: null,
  });
  const decoded = decodeConstitutionPayload(bytes);
  assert.deepEqual(decoded?.protocols.map((p) => p.id), ['aave']);

  const legacy = JSON.stringify({
    k: 'nave-constitution',
    v: 1,
    protocols: [{ id: 'aave', approved: true, maxAllocationBps: 2500, adapter: ADAPTER }],
    confidenceThreshold: 70,
    rebalanceFreq: 'Daily',
  });
  const old = decodeConstitutionPayload(legacy);
  assert.equal(old?.protocols[0]?.adapter, ADAPTER);
  assert.equal(old?.rebalanceFreq, 'Daily');
});
