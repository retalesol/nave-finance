import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { fetchConstitution } from '../lib/onChainFetcher';
import { fetchConstitutionEvm } from '../lib/evm/readers';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress, type EvmChainId } from '../lib/chain/types';
import { useChain } from './useChain';
import type { TreasuryConstitution, ProtocolEntry } from '../lib/onChainTypes';
import { isMockDaoAddress, MOCK_CONSTITUTION, MOCK_CONSTITUTION_ON_CHAIN } from '../lib/mockData';

export interface ConstitutionData {
  riskPreset: string;
  maxSingleAllocationBps: number;
  maxTotalDeployedBps: number;
  rebalanceFrequencySeconds: number;
  approvedProtocols: ProtocolEntry[];
  protocolCount: number;
  minReservesBps: number;
  /** Immediate-liquidity floor (bps). Set when the chain reported `minLiquidityBps`. */
  minLiquidityBps?: number;
  minStablecoinReserveBps?: number;
  reviewWindowSecs: number;
  confidenceThreshold?: number;
  /** Micro-USD agent floor. Preserved when a later constitution is ratified. */
  agentThresholdUsdMicro?: number;
}

interface UseConstitutionResult {
  constitution: ConstitutionData | null;
  onChainData: TreasuryConstitution | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface ConstitutionQueryData {
  constitution: ConstitutionData | null;
  onChainData: TreasuryConstitution | null;
}

async function fetchConstitutionData(
  daoAddress: string,
  evmChainId: EvmChainId | null,
): Promise<ConstitutionQueryData> {
  // EVM DAOs (0x…): read policy params from the treasury. approvedProtocols is
  // not enumerable on-chain, so it resolves to []. onChainData stays null (the
  // TreasuryConstitution type is Solana-shaped).
  if (chainKindFromAddress(daoAddress) === 'evm') {
    if (!evmChainId) {
      return { constitution: null, onChainData: null };
    }
    const evmConstitution = await fetchConstitutionEvm(evmChainId, daoAddress);
    return { constitution: evmConstitution, onChainData: null };
  }

  if (!isProgramConfigured()) {
    return { constitution: null, onChainData: null };
  }

  const daoPubkey = new PublicKey(daoAddress);
  const data = await fetchConstitution(daoPubkey);
  if (!data) {
    return { constitution: null, onChainData: null };
  }

  return {
    onChainData: data,
    constitution: {
      riskPreset: data.riskPreset,
      maxSingleAllocationBps: data.maxSingleAllocationBps,
      maxTotalDeployedBps: data.maxTotalDeployedBps,
      rebalanceFrequencySeconds: data.rebalanceFrequencySeconds,
      approvedProtocols: data.approvedProtocols,
      protocolCount: data.protocolCount,
      minReservesBps: data.minReservesBps,
      minLiquidityBps: data.minLiquidityBps,
      agentThresholdUsdMicro: data.agentThresholdUsd,
      minStablecoinReserveBps: data.minStablecoinReserveBps,
      reviewWindowSecs: data.reviewWindowSecs,
    },
  };
}

/**
 * DAO investment constitution, backed by React Query so the multiple screens
 * that read the same DAO's constitution (dashboard, policy engine, governance)
 * share one cached fetch instead of each mount re-issuing the RPC/API call.
 */
export function useConstitution(daoAddress: string | null): UseConstitutionResult {
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId } = useChain();

  const query = useQuery({
    queryKey: ['constitution', daoAddress, evmChainId],
    queryFn: () => fetchConstitutionData(daoAddress as string, evmChainId),
    enabled: !!daoAddress && !isMock,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  if (isMock) {
    return {
      constitution: MOCK_CONSTITUTION,
      onChainData: MOCK_CONSTITUTION_ON_CHAIN,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  if (!daoAddress) {
    return { constitution: null, onChainData: null, loading: false, error: null, refetch };
  }

  return {
    constitution: query.data?.constitution ?? null,
    onChainData: query.data?.onChainData ?? null,
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : 'Failed to fetch constitution') : null,
    refetch,
  };
}
