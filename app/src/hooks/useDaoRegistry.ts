import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { supabase, type DaoRegistryRow } from '../lib/supabaseClient';
import { fetchDaoRegistryByAddress } from '../lib/onChainFetcher';
import { fetchDaoRegistryEvm } from '../lib/evm/readers';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress, isEvmChainId, type EvmChainId } from '../lib/chain/types';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';
import { recallDaoChainId } from '../lib/chain/daoChainMemory';
import { useChain } from './useChain';
import type { DaoRegistry, GovernanceType } from '../lib/onChainTypes';
import { isMockDaoAddress, MOCK_DAO_DATA } from '../lib/mockData';

export interface DaoData {
  // Off-chain (Supabase)
  name: string;
  slug: string | null;
  description: string;
  logoUrl: string;
  governanceType: GovernanceType;
  privacyEnabled: boolean;
  creatorWallet: string;
  socialTwitter: string;
  socialDiscord: string;
  socialWebsite: string;
  createdAt: string;
  daoOnchainAddress: string;
  /** dao_registry.chain_id. Null for Solana rows and for rows that never stored one. */
  chainId: number | null;
  /** Shared by every chain deployment of this treasury. Books tenant key. */
  treasuryGroupId: string | null;

  // On-chain (when available)
  frozen: boolean;
  proposalCount: number;
  archivedProposalCount: number;
  /** Authoritative next proposal index for PDA seeds (from registry account). */
  nextProposalIndex?: number;
  executionRequestCount: number;
  agentsEnabled: boolean;
  onChainData: DaoRegistry | null;
}

interface UseDaoRegistryResult {
  dao: DaoData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

async function fetchDaoData(
  daoAddress: string,
  evmChainId: EvmChainId | null,
  rememberDaoChain: (daoAddress: string, chainId: EvmChainId) => void,
): Promise<DaoData> {
  const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);
  const { data: offChainRows, error: dbError } = await supabase
    .from('dao_registry')
    .select('*')
    .eq('dao_onchain_address', daoKey);

  if (dbError) {
    throw new Error(dbError.message);
  }

  const rows = (offChainRows as DaoRegistryRow[] | null) ?? [];
  const remembered = recallDaoChainId(daoAddress);
  const row =
    rows.find((candidate) => remembered != null && candidate.chain_id === remembered) ??
    rows.find((candidate) => evmChainId != null && candidate.chain_id === evmChainId) ??
    rows[0] ??
    null;

  // Fetch on-chain data if programs are configured. Fetch the registry
  // account DIRECTLY by its address (daoAddress IS the registry PDA), which
  // removes the dao_id-derived PDA desync that previously fetched the wrong
  // or empty account.
  let onChainData: DaoRegistry | null = null;
  if (chainKindFromAddress(daoAddress) === 'evm') {
    // EVM DAOs (Ethereum/Base): the specific chain (Ethereum vs Base) cannot
    // be inferred from the 0x address, so prefer the authoritative chain_id
    // from the registry row, then the active selection, then default. Persist
    // it (localStorage + active target) so every other hook reconciles to the
    // right chain on this and future loads (C4/M6).
    const rowChainId = row?.chain_id;
    const chainId =
      typeof rowChainId === 'number' && isEvmChainId(rowChainId)
        ? rowChainId
        : evmChainId;
    if (!chainId) {
      onChainData = null;
    } else {
      if (typeof rowChainId === 'number' && isEvmChainId(rowChainId)) {
        rememberDaoChain(daoAddress, rowChainId);
      }
      onChainData = await fetchDaoRegistryEvm(chainId, daoAddress);
    }
  } else if (isProgramConfigured()) {
    let daoPubkey: PublicKey;
    try {
      daoPubkey = new PublicKey(daoAddress);
    } catch {
      throw new Error(`Invalid DAO address: ${daoAddress}`);
    }
    onChainData = await fetchDaoRegistryByAddress(daoPubkey);
  }

  return {
    name: row?.name || 'Unknown DAO',
    slug: row?.slug ?? null,
    description: row?.description || '',
    logoUrl: row?.logo_url || '',
    governanceType:
      onChainData?.governanceType ||
      (row?.governance_type as GovernanceType) ||
      'wallet',
    privacyEnabled: onChainData ? onChainData.privacyMode !== 0 : row?.privacy_enabled || false,
    creatorWallet: row?.creator_wallet || '',
    socialTwitter: row?.social_twitter || '',
    socialDiscord: row?.social_discord || '',
    socialWebsite: row?.social_website || '',
    createdAt: row?.created_at || '',
    daoOnchainAddress: daoAddress,
    chainId: typeof row?.chain_id === 'number' ? row.chain_id : null,
    treasuryGroupId: row?.treasury_group_id ?? null,
    frozen: onChainData?.frozen || false,
    proposalCount: onChainData?.proposalCount || 0,
    archivedProposalCount: onChainData?.archivedProposalCount || 0,
    nextProposalIndex: onChainData?.nextProposalIndex,
    executionRequestCount: onChainData?.executionRequestCount || 0,
    agentsEnabled: onChainData?.agentsEnabled ?? true,
    onChainData,
  };
}

/**
 * DAO registry (off-chain metadata + on-chain registry account), backed by
 * React Query. Many independent components on the same page read this hook
 * for the same `daoAddress` (layout, dashboard, settings, etc.) — React Query
 * dedupes those into a single shared in-flight request and cache entry
 * instead of each mount firing its own Supabase + RPC calls.
 */
export function useDaoRegistry(daoAddress: string | null): UseDaoRegistryResult {
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId, rememberDaoChain } = useChain();

  const query = useQuery({
    queryKey: ['daoRegistry', daoAddress, evmChainId],
    queryFn: () => fetchDaoData(daoAddress as string, evmChainId, rememberDaoChain),
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
      dao: MOCK_DAO_DATA,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  if (!daoAddress) {
    return { dao: null, loading: false, error: null, refetch };
  }

  return {
    dao: query.data ?? null,
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : 'Failed to fetch DAO data') : null,
    refetch,
  };
}
