/** Pure helpers for agent key rotation (pending wait, apply skip rules, UX copy). */

export interface PendingRotationSlot {
  role: number;
  pendingAuthority: string;
  effectiveAt: number;
}

export const APPLY_READY_BUFFER_MS = 2_500;

export function maxPendingEffectiveAt(pending: readonly PendingRotationSlot[]): number {
  return pending.reduce((max, slot) => Math.max(max, slot.effectiveAt || 0), 0);
}

export async function sleepUntilEffectiveAt(
  effectiveAtSecs: number,
  bufferMs = APPLY_READY_BUFFER_MS,
): Promise<void> {
  const waitMs = Math.max(0, effectiveAtSecs * 1000 - Date.now()) + bufferMs;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export function formatSecondsRemaining(secs: number): string {
  if (secs <= 0) return '0s';
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

export function isNoPendingRotationError(message: string): boolean {
  return /NoPendingAgentRotation|no.?pending.?agent.?rotation/i.test(message);
}

export function isRotationNotReadyError(message: string): boolean {
  return /AgentRotationNotReady|rotation.?not.?ready/i.test(message);
}

/**
 * Decide whether a reassign click should mint new custody keys or only finish
 * an already-queued on-chain rotation.
 */
export function shouldFinishPendingOnly(pending: readonly PendingRotationSlot[]): boolean {
  return pending.length > 0;
}

/**
 * Roles that still need applyAgentRotation — empty / zero authority slots are skipped.
 */
export function rolesToApply(pending: readonly PendingRotationSlot[]): number[] {
  return pending
    .filter((slot) => Boolean(slot.pendingAuthority) && slot.effectiveAt >= 0)
    .map((slot) => slot.role);
}

/**
 * After applying a subset of roles, whether the rotation is fully finished.
 */
export function rotationFullyApplied(
  before: readonly PendingRotationSlot[],
  after: readonly PendingRotationSlot[],
): boolean {
  if (before.length === 0) return true;
  return after.length === 0;
}
