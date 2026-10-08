import { useState, useEffect, useCallback, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { supabase, AGENT_ACTION_LOG_PUBLIC_COLUMNS, type AgentActionLogPublicRow } from '../lib/supabaseClient';
import { fetchAgentSet } from '../lib/onChainFetcher';
import { fetchAgentSetEvm } from '../lib/evm/readers';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress } from '../lib/chain/types';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';
import { useChain } from './useChain';
import { AgentStatus, type AgentSet } from '../lib/onChainTypes';
import { isMockDaoAddress, MOCK_AGENTS, MOCK_AGENT_SET, MOCK_ACTION_LOGS } from '../lib/mockData';

const ROLE_NAMES = ['executive', 'financial', 'oversight', 'operational'] as const;
type RoleName = typeof ROLE_NAMES[number];

export interface AgentStatusInfo {
  role: 'executive' | 'financial' | 'oversight' | 'operational';
  pubkey: string;
  active: boolean;
  nullified: boolean;
  canSign: boolean;
  /** On-chain lifecycle status: Active | Paused | Revoked | Rotating */
  status: AgentStatus;
  actionsCount: number;
  lastActionAt: number;
}

export interface AgentActionLog {
  id: string;
  agentRole: string;
  actionType: string;
  reasoning: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  // Claude AI fields
  confidenceScore: number | null;
  riskFlags: string[];
  decision: string | null;
  claudeModel: string | null;
  constitutionCheck: Record<string, unknown>;
  payloadHash: string;
  executionRequestAddress: string;
  errorMessage: string;
  retryCount: number;
  reasoningHash?: string;
  txSignature?: string;
}

interface UseAgentStatusResult {
  agents: AgentStatusInfo[];
  agentsEnabled: boolean;
  reviewWindowSeconds: number;
  actionLogs: AgentActionLog[];
  onChainData: AgentSet | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAgentStatus(daoAddress: string | null): UseAgentStatusResult {
  const [agents, setAgents] = useState<AgentStatusInfo[]>([]);
  const [agentsEnabled, setAgentsEnabled] = useState(true);
  const [reviewWindowSeconds, setReviewWindowSeconds] = useState(0);
  const [actionLogs, setActionLogs] = useState<AgentActionLog[]>([]);
  const [onChainData, setOnChainData] = useState<AgentSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId } = useChain();
  const latestDaoRef = useRef<string | null>(null);
  latestDaoRef.current = daoAddress;

  const fetchData = useCallback(async () => {
    if (!daoAddress || isMock) {
      setAgents([]);
      setAgentsEnabled(true);
      setReviewWindowSeconds(0);
      setActionLogs([]);
      setOnChainData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const startedFor = daoAddress;
    const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);

    setAgents([]);
    setAgentsEnabled(true);
    setReviewWindowSeconds(0);
    setActionLogs([]);
    setOnChainData(null);
    setLoading(true);
    setError(null);

    try {
      if (chainKindFromAddress(daoAddress) === 'evm') {
        if (!evmChainId) {
          if (startedFor !== latestDaoRef.current) return;
          setAgents([]);
          setAgentsEnabled(true);
          setReviewWindowSeconds(0);
          return;
        }
        const evmAgents = await fetchAgentSetEvm(evmChainId, daoAddress);
        if (startedFor !== latestDaoRef.current) return;
        if (evmAgents) {
          setAgentsEnabled(evmAgents.agentsEnabled);
          setReviewWindowSeconds(evmAgents.reviewWindowSeconds);
          setAgents(evmAgents.agents);
        } else {
          setAgents([]);
          setAgentsEnabled(true);
          setReviewWindowSeconds(0);
        }
      } else if (isProgramConfigured() && chainKindFromAddress(daoAddress) === 'solana') {
        const daoPubkey = new PublicKey(daoAddress);
        const agentSetData = await fetchAgentSet(daoPubkey);
        if (startedFor !== latestDaoRef.current) return;

        if (agentSetData) {
          setOnChainData(agentSetData);
          setAgentsEnabled(agentSetData.agentsEnabled);
          setReviewWindowSeconds(agentSetData.reviewWindowSeconds);

          const slotEntries = [
            agentSetData.executive,
            agentSetData.financial,
            agentSetData.oversight,
            agentSetData.operational,
          ];

          setAgents(
            slotEntries.map((s, i) => ({
              role: ROLE_NAMES[i] as RoleName,
              pubkey: s.pubkey,
              active: s.canSign && !s.nullified,
              nullified: s.nullified,
              canSign: s.canSign,
              status: s.status,
              actionsCount: s.actionsCount,
              lastActionAt: s.lastActionAt,
            })),
          );
        } else {
          setAgents([]);
          setAgentsEnabled(true);
          setReviewWindowSeconds(0);
        }
      }

      const { data: logs, error: logError } = await supabase
        .from('agent_action_logs')
        // Explicit column list — never `*` — so `raw_claude_response` can be
        // REVOKEd from the browser role without breaking this read.
        .select(AGENT_ACTION_LOG_PUBLIC_COLUMNS)
        .eq('dao_onchain_address', daoKey)
        .order('created_at', { ascending: false })
        .limit(50);

      if (startedFor !== latestDaoRef.current) return;

      if (logError) {
        console.warn('Failed to fetch agent logs:', logError);
      } else {
        const logRows = (logs as unknown as AgentActionLogPublicRow[]) || [];
        setActionLogs(
          logRows.map((l) => ({
            id: l.id,
            agentRole: l.agent_role,
            actionType: l.action_type,
            reasoning: l.reasoning,
            status: l.status,
            createdAt: l.created_at,
            completedAt: l.completed_at,
            confidenceScore: l.confidence_score ?? null,
            riskFlags: l.risk_flags ?? [],
            decision: l.decision ?? null,
            claudeModel: l.claude_model ?? null,
            constitutionCheck: l.constitution_check ?? {},
            payloadHash: l.payload_hash ?? '',
            executionRequestAddress: l.execution_request_address ?? '',
            errorMessage: l.error_message ?? '',
            retryCount: l.retry_count ?? 0,
            reasoningHash: l.reasoning_hash ?? '',
            txSignature: l.tx_signature ?? '',
          })),
        );
      }
    } catch (err) {
      if (startedFor !== latestDaoRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch agent status');
    } finally {
      if (startedFor === latestDaoRef.current) {
        setLoading(false);
      }
    }
  }, [daoAddress, isMock, evmChainId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (isMock) {
    return {
      agents: MOCK_AGENTS,
      agentsEnabled: true,
      reviewWindowSeconds: 172800,
      actionLogs: MOCK_ACTION_LOGS,
      onChainData: MOCK_AGENT_SET,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  return {
    agents,
    agentsEnabled,
    reviewWindowSeconds,
    actionLogs,
    onChainData,
    loading,
    error,
    refetch: fetchData,
  };
}
