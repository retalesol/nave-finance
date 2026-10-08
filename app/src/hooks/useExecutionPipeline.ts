import { useState, useEffect, useCallback, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { fetchAllExecutionRequests } from '../lib/onChainFetcher';
import { fetchExecutionRequestsEvm } from '../lib/evm/readers';
import { getProposalPDA } from '../lib/pdaDerivation';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress } from '../lib/chain/types';
import { useChain } from './useChain';
import { ExecutionStatus } from '../lib/onChainTypes';
import type { ExecutionRequest } from '../lib/onChainTypes';
import { isMockDaoAddress, MOCK_EXECUTIONS } from '../lib/mockData';

export interface ExecutionInfo {
  proposal: string;
  protocolProgram: string;
  status: ExecutionStatus;
  executiveApprovedAt: number;
  financialApprovedAt: number;
  oversightApprovedAt: number;
  txPayloadHash: string;
  operationalHalt: boolean;
  operationalHaltReason: string;
  operationalCleared: boolean;
  reviewWindowEndsAt: number;
  executedAt: number;
  agentsBypassed: boolean;
  amount: number;
  protocolName: string;
  timeRemainingSeconds: number;
}

interface UseExecutionPipelineResult {
  executions: ExecutionInfo[];
  pendingExecutions: ExecutionInfo[];
  activeExecutions: ExecutionInfo[];
  completedExecutions: ExecutionInfo[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetches execution requests for a DAO.
 * Execution requests are keyed by proposal PDA, so we first derive all
 * proposal PDAs (0..proposalCount) then look up their execution requests.
 */
export function useExecutionPipeline(
  daoAddress: string | null,
  proposalCount: number,
): UseExecutionPipelineResult {
  const [executions, setExecutions] = useState<ExecutionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId } = useChain();
  const latestDaoRef = useRef<string | null>(null);
  latestDaoRef.current = daoAddress;

  const fetchData = useCallback(async () => {
    if (!daoAddress || isMock) {
      setExecutions([]);
      setLoading(false);
      setError(null);
      return;
    }

    const startedFor = daoAddress;
    setExecutions([]);
    setLoading(true);
    setError(null);

    // EVM DAOs (0x…): enumerate execution requests via the EVM reader.
    if (chainKindFromAddress(daoAddress) === 'evm') {
      try {
        if (!evmChainId) {
          if (startedFor !== latestDaoRef.current) return;
          setExecutions([]);
          return;
        }
        const evmExecutions = proposalCount > 0
          ? await fetchExecutionRequestsEvm(evmChainId, daoAddress, proposalCount)
          : [];
        if (startedFor !== latestDaoRef.current) return;
        setExecutions(evmExecutions);
      } catch (err) {
        if (startedFor !== latestDaoRef.current) return;
        setExecutions([]);
        setError(err instanceof Error ? err.message : 'Failed to fetch execution pipeline');
      } finally {
        if (startedFor === latestDaoRef.current) {
          setLoading(false);
        }
      }
      return;
    }

    if (!isProgramConfigured() || proposalCount === 0) {
      if (startedFor === latestDaoRef.current) {
        setExecutions([]);
        setLoading(false);
      }
      return;
    }

    try {
      const daoPubkey = new PublicKey(daoAddress);

      // Derive all proposal PDAs for this DAO, then fetch their execution requests
      const proposalPubkeys = Array.from({ length: proposalCount }, (_, i) => {
        const [pda] = getProposalPDA(daoPubkey, i);
        return pda;
      });
      const rawRequests = await fetchAllExecutionRequests(proposalPubkeys);

      if (startedFor !== latestDaoRef.current) return;

      const now = Math.floor(Date.now() / 1000);

      const parsed: ExecutionInfo[] = rawRequests
        .filter((r): r is ExecutionRequest => {
          if (r === null) return false;
          if (r.dao && r.dao !== daoAddress) {
            console.warn(
              '[useExecutionPipeline] Skipping execution request whose dao field does not match active treasury:',
              { expected: daoAddress, got: r.dao },
            );
            return false;
          }
          return true;
        })
        .map((r) => ({
          proposal: r.proposal,
          protocolProgram: r.protocolProgram,
          status: r.status,
          executiveApprovedAt: r.executiveApprovedAt,
          financialApprovedAt: r.financialApprovedAt,
          oversightApprovedAt: r.oversightApprovedAt,
          txPayloadHash: r.txPayloadHash,
          operationalHalt: r.operationalHalt,
          operationalHaltReason: r.operationalHaltReason,
          operationalCleared: r.operationalCleared,
          reviewWindowEndsAt: r.reviewWindowEndsAt,
          executedAt: r.executedAt,
          agentsBypassed: r.agentsBypassed,
          amount: r.amount,
          protocolName: r.protocolName,
          timeRemainingSeconds: Math.max(0, r.reviewWindowEndsAt - now),
        }));

      setExecutions(parsed);
    } catch (err) {
      if (startedFor !== latestDaoRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch execution pipeline');
    } finally {
      if (startedFor === latestDaoRef.current) {
        setLoading(false);
      }
    }
  }, [daoAddress, proposalCount, isMock, evmChainId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const pendingExecutions = executions.filter(
    (e) => e.status === ExecutionStatus.Pending || e.status === ExecutionStatus.ExecutiveApproved,
  );
  const activeExecutions = executions.filter(
    (e) =>
      e.status === ExecutionStatus.FinancialApproved ||
      e.status === ExecutionStatus.OversightApproved ||
      e.status === ExecutionStatus.InReview,
  );
  const completedExecutions = executions.filter(
    (e) => e.status === ExecutionStatus.Executed || e.status === ExecutionStatus.Halted || e.status === ExecutionStatus.Expired,
  );

  if (isMock) {
    const mockPending = MOCK_EXECUTIONS.filter(e => e.status === ExecutionStatus.Pending || e.status === ExecutionStatus.ExecutiveApproved);
    const mockActive = MOCK_EXECUTIONS.filter(e => e.status === ExecutionStatus.FinancialApproved || e.status === ExecutionStatus.OversightApproved || e.status === ExecutionStatus.InReview);
    const mockCompleted = MOCK_EXECUTIONS.filter(e => e.status === ExecutionStatus.Executed || e.status === ExecutionStatus.Halted || e.status === ExecutionStatus.Expired);
    return {
      executions: MOCK_EXECUTIONS,
      pendingExecutions: mockPending,
      activeExecutions: mockActive,
      completedExecutions: mockCompleted,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  return {
    executions,
    pendingExecutions,
    activeExecutions,
    completedExecutions,
    loading,
    error,
    refetch: fetchData,
  };
}
