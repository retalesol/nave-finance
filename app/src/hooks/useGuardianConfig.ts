import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { supabase, type SignerLabelRow } from '../lib/supabaseClient';
import { fetchGuardianConfig } from '../lib/onChainFetcher';
import { fetchGuardianConfigEvm } from '../lib/evm/readers';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress, type EvmChainId } from '../lib/chain/types';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';
import { useChain } from './useChain';
import type { GuardianConfig } from '../lib/onChainTypes';
import { isMockDaoAddress, MOCK_GUARDIANS, MOCK_GUARDIAN_CONFIG } from '../lib/mockData';

export interface GuardianInfo {
  wallet: string;
  label: string;
  isOnChain: boolean;
}

interface UseGuardianConfigResult {
  guardians: GuardianInfo[];
  threshold: number;
  walletCount: number;
  /** EVM: true after founder bootstrap (or first Permission apply). Solana: always false. */
  bootstrapped: boolean;
  onChainData: GuardianConfig | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface GuardianQueryData {
  guardians: GuardianInfo[];
  threshold: number;
  walletCount: number;
  bootstrapped: boolean;
  onChainData: GuardianConfig | null;
}

async function fetchGuardianData(
  daoAddress: string,
  evmChainId: EvmChainId | null,
): Promise<GuardianQueryData> {
  const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);
  const isEvm = chainKindFromAddress(daoAddress) === 'evm';

  let threshold = 0;
  let walletCount = 0;
  let bootstrapped = false;
  let onChainData: GuardianConfig | null = null;
  let walletAddresses: string[] = [];

  if (isEvm) {
    if (!evmChainId) {
      return {
        guardians: [],
        threshold: 0,
        walletCount: 0,
        bootstrapped: false,
        onChainData: null,
      };
    }
    const cfg = await fetchGuardianConfigEvm(evmChainId, daoAddress);
    threshold = cfg.threshold;
    walletCount = cfg.walletCount;
    walletAddresses = cfg.wallets;
    bootstrapped = cfg.bootstrapped;
    onChainData = {
      threshold: cfg.threshold,
      walletCount: cfg.walletCount,
      wallets: cfg.wallets,
    } as GuardianConfig;
  } else if (isProgramConfigured()) {
    const daoPubkey = new PublicKey(daoAddress);
    const config = await fetchGuardianConfig(daoPubkey);
    if (config) {
      onChainData = config;
      threshold = config.threshold;
      walletCount = config.walletCount;
      walletAddresses = config.wallets;
    }
  }

  const { data: labels, error: labelError } = await supabase
    .from('signer_labels')
    .select('*')
    .eq('dao_onchain_address', daoKey);

  if (labelError) {
    console.warn('Failed to fetch signer labels:', labelError);
  }

  const labelRows = (labels as SignerLabelRow[]) || [];

  const labelMap = new Map(labelRows.map((l) => [l.wallet_address.toLowerCase(), l.label]));

  if (isEvm) {
    const guardians: GuardianInfo[] = walletAddresses.map((wallet) => ({
      wallet,
      label: labelMap.get(wallet.toLowerCase()) || '',
      isOnChain: true,
    }));
    return {
      guardians,
      threshold,
      walletCount,
      bootstrapped,
      onChainData,
    };
  }

  const guardians: GuardianInfo[] = walletAddresses.map((wallet) => ({
    wallet,
    label: labelMap.get(wallet) || labelMap.get(wallet.toLowerCase()) || '',
    isOnChain: true,
  }));

  for (const labelRow of labelRows) {
    if (!walletAddresses.includes(labelRow.wallet_address)) {
      guardians.push({
        wallet: labelRow.wallet_address,
        label: labelRow.label,
        isOnChain: false,
      });
    }
  }

  return { guardians, threshold, walletCount, bootstrapped: false, onChainData };
}

/**
 * Guardian set for a DAO, backed by React Query so the several screens that
 * gate on membership (settings, dashboard, DAO membership resolver) share one
 * cached fetch per `daoAddress` instead of each independently re-fetching.
 */
export function useGuardianConfig(daoAddress: string | null): UseGuardianConfigResult {
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId } = useChain();

  const query = useQuery({
    queryKey: ['guardianConfig', daoAddress, evmChainId],
    queryFn: () => fetchGuardianData(daoAddress as string, evmChainId),
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
      guardians: MOCK_GUARDIANS,
      threshold: MOCK_GUARDIAN_CONFIG.threshold,
      walletCount: MOCK_GUARDIAN_CONFIG.walletCount,
      bootstrapped: true,
      onChainData: MOCK_GUARDIAN_CONFIG,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  if (!daoAddress) {
    return {
      guardians: [],
      threshold: 0,
      walletCount: 0,
      bootstrapped: false,
      onChainData: null,
      loading: false,
      error: null,
      refetch,
    };
  }

  return {
    guardians: query.data?.guardians ?? [],
    threshold: query.data?.threshold ?? 0,
    walletCount: query.data?.walletCount ?? 0,
    bootstrapped: query.data?.bootstrapped ?? false,
    onChainData: query.data?.onChainData ?? null,
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : 'Failed to fetch guardian config') : null,
    refetch,
  };
}
