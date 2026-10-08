import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isMockDaoAddress } from '../lib/mockData';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentSession {
  id: string;
  daoAddress: string;
  agentRole: 'executive' | 'financial' | 'oversight' | 'operational';
  executionRequestAddress: string;
  sessionStatus: 'active' | 'completed' | 'failed' | 'expired';
  startedAt: string;
  completedAt: string | null;
  expiresAt: string;
  errorMessage: string | null;
}

export interface AgentSessionsData {
  sessions: AgentSession[];
  activeSessions: AgentSession[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

// ── Mock sessions for demo ───────────────────────────────────────────────────

const now = Date.now();

const MOCK_SESSIONS: AgentSession[] = [
  {
    id: 'sess-1',
    daoAddress: 'mock',
    agentRole: 'executive',
    executionRequestAddress: 'ExReq1111111111111111111111111111111111111',
    sessionStatus: 'completed',
    startedAt: new Date(now - 14 * 60_000).toISOString(),
    completedAt: new Date(now - 13 * 60_000).toISOString(),
    expiresAt: new Date(now - 9 * 60_000).toISOString(),
    errorMessage: null,
  },
  {
    id: 'sess-2',
    daoAddress: 'mock',
    agentRole: 'financial',
    executionRequestAddress: 'ExReq1111111111111111111111111111111111111',
    sessionStatus: 'completed',
    startedAt: new Date(now - 12 * 60_000).toISOString(),
    completedAt: new Date(now - 11 * 60_000).toISOString(),
    expiresAt: new Date(now - 7 * 60_000).toISOString(),
    errorMessage: null,
  },
  {
    id: 'sess-3',
    daoAddress: 'mock',
    agentRole: 'oversight',
    executionRequestAddress: 'ExReq1111111111111111111111111111111111111',
    sessionStatus: 'completed',
    startedAt: new Date(now - 10 * 60_000).toISOString(),
    completedAt: new Date(now - 9 * 60_000).toISOString(),
    expiresAt: new Date(now - 5 * 60_000).toISOString(),
    errorMessage: null,
  },
  {
    id: 'sess-4',
    daoAddress: 'mock',
    agentRole: 'operational',
    executionRequestAddress: 'ExReq2222222222222222222222222222222222222',
    sessionStatus: 'completed',
    startedAt: new Date(now - 5 * 60_000).toISOString(),
    completedAt: new Date(now - 4 * 60_000).toISOString(),
    expiresAt: new Date(now).toISOString(),
    errorMessage: null,
  },
  {
    id: 'sess-5',
    daoAddress: 'mock',
    agentRole: 'executive',
    executionRequestAddress: 'ExReq3333333333333333333333333333333333333',
    sessionStatus: 'failed',
    startedAt: new Date(now - 60 * 60_000).toISOString(),
    completedAt: new Date(now - 59 * 60_000).toISOString(),
    expiresAt: new Date(now - 55 * 60_000).toISOString(),
    errorMessage: 'Claude inference failed: Output failed schema validation',
  },
];

// ── Hook ─────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 15_000; // 15 seconds

export function useAgentSessions(daoAddress: string | null): AgentSessionsData {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const latestDaoRef = useRef<string | null>(null);
  const isMock = isMockDaoAddress(daoAddress);
  latestDaoRef.current = daoAddress;

  const fetchSessions = useCallback(async () => {
    if (!daoAddress || isMock) {
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }

    const startedFor = daoAddress;
    const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);
    setSessions([]);

    try {
      const { data, error: fetchErr } = await supabase
        .from('agent_sessions')
        .select('*')
        .eq('dao_onchain_address', daoKey)
        .order('started_at', { ascending: false })
        .limit(50);

      if (fetchErr) {
        if (startedFor !== latestDaoRef.current) return;
        setError(fetchErr.message);
        return;
      }

      if (data) {
        if (startedFor !== latestDaoRef.current) return;
        setSessions(
          data.map((row: Record<string, unknown>) => ({
            id: row.id as string,
            daoAddress: row.dao_onchain_address as string,
            agentRole: row.agent_role as AgentSession['agentRole'],
            executionRequestAddress: row.execution_request_address as string,
            sessionStatus: row.session_status as AgentSession['sessionStatus'],
            startedAt: row.started_at as string,
            completedAt: (row.completed_at as string) || null,
            expiresAt: row.expires_at as string,
            errorMessage: (row.error_message as string) || null,
          })),
        );
        setError(null);
      }
    } catch (err) {
      if (startedFor !== latestDaoRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
    } finally {
      if (startedFor === latestDaoRef.current) {
        setLoading(false);
      }
    }
  }, [daoAddress, isMock]);

  useEffect(() => {
    fetchSessions();

    if (daoAddress && !isMock) {
      intervalRef.current = setInterval(fetchSessions, POLL_INTERVAL_MS);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSessions, daoAddress, isMock]);

  // Mock mode
  if (isMock) {
    const mockActive = MOCK_SESSIONS.filter(s => s.sessionStatus === 'active');
    return {
      sessions: MOCK_SESSIONS,
      activeSessions: mockActive,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  const activeSessions = sessions.filter(s => s.sessionStatus === 'active');

  return {
    sessions,
    activeSessions,
    loading,
    error,
    refetch: fetchSessions,
  };
}
