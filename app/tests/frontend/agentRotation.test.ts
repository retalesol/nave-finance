import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatSecondsRemaining,
  isNoPendingRotationError,
  isRotationNotReadyError,
  maxPendingEffectiveAt,
  rolesToApply,
  rotationFullyApplied,
  shouldFinishPendingOnly,
  type PendingRotationSlot,
} from '../../src/lib/agentRotation.ts';

const slot = (role: number, effectiveAt = 1_700_000_000): PendingRotationSlot => ({
  role,
  pendingAuthority: `0x${role.toString().padStart(40, 'a')}`,
  effectiveAt,
});

describe('agentRotation helpers', () => {
  it('shouldFinishPendingOnly blocks minting when any role is queued', () => {
    assert.equal(shouldFinishPendingOnly([]), false);
    assert.equal(shouldFinishPendingOnly([slot(0)]), true);
    assert.equal(shouldFinishPendingOnly([slot(1), slot(3)]), true);
  });

  it('maxPendingEffectiveAt drives wait-until-ready (not a fixed 75s)', () => {
    assert.equal(maxPendingEffectiveAt([]), 0);
    assert.equal(maxPendingEffectiveAt([slot(0, 100), slot(2, 250), slot(1, 180)]), 250);
  });

  it('rolesToApply skips empty authority slots', () => {
    const pending: PendingRotationSlot[] = [
      slot(0),
      { role: 1, pendingAuthority: '', effectiveAt: 100 },
      slot(2),
      { role: 3, pendingAuthority: '', effectiveAt: 0 },
    ];
    assert.deepEqual(rolesToApply(pending), [0, 2]);
  });

  it('treats NoPendingAgentRotation as skip-safe, not fatal', () => {
    assert.equal(isNoPendingRotationError('NoPendingAgentRotation()'), true);
    assert.equal(isNoPendingRotationError('execution reverted: NoPendingAgentRotation'), true);
    assert.equal(isNoPendingRotationError('AgentRotationNotReady()'), false);
  });

  it('detects AgentRotationNotReady for retry messaging', () => {
    assert.equal(isRotationNotReadyError('AgentRotationNotReady()'), true);
    assert.equal(isRotationNotReadyError('rotation not ready yet'), true);
    assert.equal(isRotationNotReadyError('NoPendingAgentRotation()'), false);
  });

  it('rotationFullyApplied: partial pending is not done until after is empty', () => {
    const before = [slot(0), slot(1), slot(2), slot(3)];
    // Activity: 1 scheduled + 3 applied → one role still pending
    const afterPartial = [slot(3)];
    assert.equal(rotationFullyApplied(before, afterPartial), false);
    assert.equal(rotationFullyApplied(before, []), true);
    assert.equal(rotationFullyApplied([], []), true);
  });

  it('formatSecondsRemaining for countdown copy', () => {
    assert.equal(formatSecondsRemaining(0), '0s');
    assert.equal(formatSecondsRemaining(45), '45s');
    assert.equal(formatSecondsRemaining(60), '1m');
    assert.equal(formatSecondsRemaining(75), '1m 15s');
    assert.equal(formatSecondsRemaining(3600), '1h');
    assert.equal(formatSecondsRemaining(3660), '1h 1m');
  });
});
