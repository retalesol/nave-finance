import { useState, useEffect, useCallback, useRef } from 'react';
import { type AgentRoleHealth } from '../lib/edgeFunctionClient';
import { isMockDaoAddress } from '../lib/mockData';
import { supabase } from '../lib/supabaseClient';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';

const POLL_INTERVAL_MS = 30_000; // 30 seconds

const AGENT_ROLES: AgentRoleHealth['role'][] = [
  'executive',
  'financial',
  'oversight',
  'operational',
];

/**
 * Compute per-DAO agent health from RLS-protected tables instead of the
 * server-only `agent-health` edge function (which now requires the agent
 * secret). Reads are governed by row-level security so the dashboard only
 * sees data it is authorized for.
 */
async function computeAgentHealth(daoAddress: string): Promise<{
  agents: AgentRoleHealth[];
  systemHealthy: boolean;
  checkedAt: string;
}> {
  const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);
  const now = Date.now();
  const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const [logsRes, sessionsRes] = await Promise.all([
    supabase
      .from('agent_action_logs')
      .select('agent_role, status, decision, confidence_score, created_at')
      .eq('dao_onchain_address', daoKey)
      .gte('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false }),
    supabase
      .from('agent_sessions')
      .select('agent_role, session_status')
      .eq('dao_onchain_address', daoKey)
      .eq('session_status', 'active'),
  ]);

  if (logsRes.error) throw new Error(logsRes.error.message);

  type LogRow = {
    agent_role: string;
    status: string;
    decision: string | null;
    confidence_score: number | null;
    created_at: string;
  };
  const logs = (logsRes.data ?? []) as LogRow[];
  const sessions = (sessionsRes.data ?? []) as { agent_role: string }[];

  const agents: AgentRoleHealth[] = AGENT_ROLES.map((role) => {
    const roleLogs = logs.filter((l) => l.agent_role === role);
    const latest = roleLogs[0] ?? null;
    const errorCount = roleLogs.filter(
      (l) => l.status === 'error' || l.status === 'guardrail_blocked',
    ).length;
    return {
      role,
      last_action_at: latest?.created_at ?? null,
      actions_24h: roleLogs.length,
      errors_24h: errorCount,
      last_decision: latest?.decision ?? null,
      last_confidence: latest?.confidence_score ?? null,
      active_sessions: sessions.filter((s) => s.agent_role === role).length,
    };
  });

  const systemHealthy = agents.every(
    (a) => a.errors_24h <= Math.max(1, a.actions_24h * 0.25),
  );

  return { agents, systemHealthy, checkedAt: new Date(now).toISOString() };
}

export interface AgentHealthData {
  agents: AgentRoleHealth[];
  systemHealthy: boolean;
  checkedAt: string | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

// ── Mock health data for demo mode ────────────────────────────────────────────

const MOCK_HEALTH: AgentRoleHealth[] = [
  {
    role: 'executive' as const,
    last_action_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    actions_24h: 6,
    errors_24h: 0,
    last_decision: 'approve',
    last_confidence: 94,
    active_sessions: 0,
  },
  {
    role: 'financial' as const,
    last_action_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    actions_24h: 12,
    errors_24h: 0,
    last_decision: 'approve',
    last_confidence: 92,
    active_sessions: 0,
  },
  {
    role: 'oversight' as const,
    last_action_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    actions_24h: 11,
    errors_24h: 0,
    last_decision: 'approve',
    last_confidence: 95,
    active_sessions: 0,
  },
  {
    role: 'operational' as const,
    last_action_at: new Date(Date.now() - 1 * 60_000).toISOString(),
    actions_24h: 24,
    errors_24h: 0,
    last_decision: 'continue',
    last_confidence: 88,
    active_sessions: 0,
  },
];

// ── Health status helpers ─────────────────────────────────────────────────────

export type HealthLevel = 'healthy' | 'degraded' | 'down';

/** Determine a traffic-light health level for a single agent */
export function getAgentHealthLevel(agent: AgentRoleHealth): HealthLevel {
  // Down: no actions in the last hour, or more errors than successes
  if (!agent.last_action_at) return 'down';
  const lastActionAge = Date.now() - new Date(agent.last_action_at).getTime();
  if (lastActionAge > 60 * 60_000) return 'down'; // >1h stale

  // Degraded: elevated error rate (>25% of actions)
  if (agent.actions_24h > 0 && agent.errors_24h > agent.actions_24h * 0.25) {
    return 'degraded';
  }

  return 'healthy';
}

/** Human-readable time-ago string */
export function timeAgo(isoString: string | null): string {
  if (!isoString) return 'Never';
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0) return 'Just now';
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAgentHealth(daoAddress: string | null): AgentHealthData {
  const [agents, setAgents] = useState<AgentRoleHealth[]>([]);
  const [systemHealthy, setSystemHealthy] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const isMock = isMockDaoAddress(daoAddress);

  const fetchData = useCallback(async () => {
    if (!daoAddress || isMock) {
      setAgents([]);
      setSystemHealthy(true);
      setCheckedAt(null);
      setLoading(false);
      return;
    }

    try {
      const { agents: nextAgents, systemHealthy: healthy, checkedAt: at } =
        await computeAgentHealth(daoAddress);
      setAgents(nextAgents);
      setSystemHealthy(healthy);
      setCheckedAt(at);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch agent health');
    } finally {
      setLoading(false);
    }
  }, [daoAddress, isMock]);

  useEffect(() => {
    fetchData();

    // Set up polling
    if (daoAddress && !isMock) {
      intervalRef.current = setInterval(fetchData, POLL_INTERVAL_MS);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData, daoAddress, isMock]);

  // Mock mode
  if (isMock) {
    return {
      agents: MOCK_HEALTH,
      systemHealthy: true,
      checkedAt: new Date().toISOString(),
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  return {
    agents,
    systemHealthy,
    checkedAt,
    loading,
    error,
    refetch: fetchData,
  };
}