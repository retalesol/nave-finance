import { AgentStatus as OnChainAgentStatus } from './onChainTypes';
import { type AgentRoleHealth } from './edgeFunctionClient';

// ═══════════════════════════════════════════════════════════════════════════════
// Unified agent status model
//
// Agent status is shown in three places (Dashboard, Agents tab, Settings). Each
// page previously derived its own notion of "status" — some from activity logs
// only (which marked an enabled-but-idle agent as "Offline"), and the Agents tab
// card just echoed the global `agents_enabled` flag for every role. This module
// is the single source of truth so all three surfaces agree.
//
// The authoritative signal is the on-chain `AgentSet`:
//   - DAO frozen                       → Frozen
//   - slot nullified / status Revoked  → Revoked
//   - slot status Rotating             → Rotating
//   - agents globally disabled, slot   → Paused
//     Paused, or slot cannot sign
//   - otherwise (enabled & can sign)   → Active, refined to Degraded by the
//                                        activity-derived error rate
//
// When on-chain data cannot be read we fall back to the activity-derived health
// signal (Active / Degraded / Offline) so environments without RPC still show
// something meaningful.
// ═══════════════════════════════════════════════════════════════════════════════

export type AgentStatusLevel =
  | 'active'
  | 'degraded'
  | 'rotating'
  | 'paused'
  | 'revoked'
  | 'frozen'
  | 'offline'
  | 'unknown';

export interface AgentStatusDisplay {
  level: AgentStatusLevel;
  label: string;
  /** foreground / dot color token */
  color: string;
  /** muted badge background token */
  bg: string;
  /** true when the agent is enabled on-chain and authorized to sign */
  enabled: boolean;
}

/** Minimal on-chain slot shape needed to derive status. */
export interface OnChainAgentState {
  active: boolean; // canSign && !nullified
  nullified: boolean;
  status: OnChainAgentStatus;
}

export interface AgentStatusInputs {
  /** global agents_enabled flag from the AgentSet */
  agentsEnabled: boolean;
  /** DAO emergency-freeze flag */
  frozen: boolean;
  /** whether on-chain AgentSet data was successfully loaded for this DAO */
  hasOnChain: boolean;
  /** per-slot on-chain state, when available */
  onChain?: OnChainAgentState | null;
  /** activity-derived health, when available */
  health?: AgentRoleHealth | null;
}

type Tone = 'success' | 'warning' | 'destructive' | 'muted';

const TONES: Record<Tone, { color: string; bg: string }> = {
  success: { color: 'hsl(var(--success))', bg: 'hsl(var(--success-muted))' },
  warning: { color: 'hsl(var(--warning))', bg: 'hsl(var(--warning-muted))' },
  destructive: { color: 'hsl(var(--destructive))', bg: 'hsl(var(--destructive-muted))' },
  muted: { color: 'hsl(var(--muted-foreground))', bg: 'hsl(var(--surface-2))' },
};

function mk(
  level: AgentStatusLevel,
  label: string,
  tone: Tone,
  enabled: boolean,
): AgentStatusDisplay {
  return { level, label, color: TONES[tone].color, bg: TONES[tone].bg, enabled };
}

/** True when an agent's recent error rate is elevated (>25% of its actions). */
function hasElevatedErrors(health: AgentRoleHealth): boolean {
  return health.actions_24h > 0 && health.errors_24h > health.actions_24h * 0.25;
}

/**
 * Resolve the effective, display-ready status for a single agent role by
 * combining authoritative on-chain enablement with activity-derived health.
 */
export function computeAgentStatus(input: AgentStatusInputs): AgentStatusDisplay {
  const { agentsEnabled, frozen, hasOnChain, onChain, health } = input;

  // 1. Emergency freeze halts every agent regardless of other state.
  if (frozen) return mk('frozen', 'Frozen', 'destructive', false);

  // 2. On-chain state is authoritative when we have it.
  if (hasOnChain && onChain) {
    if (onChain.nullified || onChain.status === OnChainAgentStatus.Revoked) {
      return mk('revoked', 'Revoked', 'destructive', false);
    }
    if (onChain.status === OnChainAgentStatus.Rotating) {
      return mk('rotating', 'Rotating', 'warning', false);
    }
    if (!agentsEnabled || onChain.status === OnChainAgentStatus.Paused || !onChain.active) {
      return mk('paused', 'Paused', 'muted', false);
    }
    // Enabled and authorized to sign. Only the activity error rate can knock it
    // down to Degraded — an idle (but enabled) agent stays Active.
    if (health && hasElevatedErrors(health)) {
      return mk('degraded', 'Degraded', 'warning', true);
    }
    return mk('active', 'Active', 'success', true);
  }

  // 3. No on-chain data — fall back to the activity-derived health signal.
  if (health) {
    if (hasElevatedErrors(health)) return mk('degraded', 'Degraded', 'warning', true);
    if (!health.last_action_at) return mk('offline', 'Offline', 'destructive', false);
    const staleMs = Date.now() - new Date(health.last_action_at).getTime();
    if (staleMs > 60 * 60_000) return mk('offline', 'Offline', 'destructive', false);
    return mk('active', 'Active', 'success', true);
  }

  return mk('unknown', 'Unknown', 'muted', false);
}

/**
 * Roll a set of per-agent statuses up into a single system-level summary used
 * for the headline badges/lines on the Dashboard and Settings pages.
 */
export function summarizeAgentStatuses(statuses: AgentStatusDisplay[]): {
  level: AgentStatusLevel;
  label: string;
  color: string;
} {
  if (statuses.length === 0) {
    return { level: 'unknown', label: 'No agents configured', color: TONES.muted.color };
  }
  if (statuses.some(s => s.level === 'frozen')) {
    return { level: 'frozen', label: 'Agents frozen — emergency halt active', color: TONES.destructive.color };
  }
  if (statuses.some(s => s.level === 'revoked')) {
    return { level: 'revoked', label: 'An agent key has been revoked', color: TONES.destructive.color };
  }
  if (statuses.some(s => s.level === 'degraded' || s.level === 'offline')) {
    return { level: 'degraded', label: 'Elevated error rate on some agents', color: TONES.warning.color };
  }
  if (statuses.some(s => s.level === 'paused')) {
    return { level: 'paused', label: 'Agents paused', color: TONES.muted.color };
  }
  if (statuses.some(s => s.level === 'rotating')) {
    return { level: 'rotating', label: 'Agent key rotation in progress', color: TONES.warning.color };
  }
  if (statuses.every(s => s.level === 'active')) {
    return { level: 'active', label: '3-key multisig: all agents operational', color: TONES.success.color };
  }
  return { level: 'unknown', label: 'Agent status unavailable', color: TONES.muted.color };
}
