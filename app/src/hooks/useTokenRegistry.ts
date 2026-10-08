import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { fetchTokenRegistry } from '../lib/onChainFetcher';
import { fetchTokenRegistryEvm } from '../lib/evm/readers';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress, isEvmChainId, type EvmChainId } from '../lib/chain/types';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';
import { useChain } from './useChain';
import type { TokenRegistry, TokenSlot } from '../lib/onChainTypes';
import { isMockDaoAddress, MOCK_TOKENS, MOCK_TOKEN_REGISTRY } from '../lib/mockData';
import { supabase } from '../lib/supabaseClient';

export interface TokenInfo {
  slotIndex: number;
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  isMinted: boolean;
  isNaveManaged: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  metadataAuthorityRevoked: boolean;
  canReceiveProposals: boolean;
  createdAt: number;
  imageUri?: string;
}

interface UseTokenRegistryResult {
  tokens: TokenInfo[];
  tokenCount: number;
  hasMintedToken: boolean;
  onChainData: TokenRegistry | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface TokenRegistryQueryData {
  tokens: TokenInfo[];
  tokenCount: number;
  onChainData: TokenRegistry | null;
}

async function fetchTokenRegistryData(
  daoAddress: string,
  evmChainId: EvmChainId | null,
  rememberDaoChain: (daoAddress: string, chainId: EvmChainId) => void,
): Promise<TokenRegistryQueryData> {
  const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);

  if (chainKindFromAddress(daoAddress) === 'evm') {
    const { data: row } = await supabase
      .from('dao_registry')
      .select('voting_token_mint, chain_id')
      .eq('dao_onchain_address', daoKey)
      .maybeSingle();

    const rowChainId = (row as { chain_id?: number | null } | null)?.chain_id;
    const rememberedChainId = typeof rowChainId === 'number' && isEvmChainId(rowChainId) ? rowChainId : null;
    const chainId = rememberedChainId
      ? rememberedChainId
      : evmChainId;
    if (!chainId) {
      return {
        onChainData: null,
        tokenCount: 0,
        tokens: [],
      };
    }
    if (rememberedChainId) {
      rememberDaoChain(daoAddress, rememberedChainId);
    }

    const registry = await fetchTokenRegistryEvm(
      chainId,
      daoAddress,
      (row as { voting_token_mint?: string | null } | null)?.voting_token_mint,
    );

    return {
      onChainData: registry,
      tokenCount: registry?.tokenCount ?? 0,
      tokens: (registry?.tokens ?? []).map((t, i) => ({
        slotIndex: i,
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        decimals: t.decimals,
        supply: t.supply,
        isMinted: t.isMinted,
        isNaveManaged: t.isNaveManaged,
        mintAuthorityRevoked: t.mintAuthorityRevoked,
        freezeAuthorityRevoked: t.freezeAuthorityRevoked,
        metadataAuthorityRevoked: t.metadataAuthorityRevoked,
        canReceiveProposals: t.canReceiveProposals,
        createdAt: t.createdAt,
      })),
    };
  }

  if (!isProgramConfigured()) {
    return { tokens: [], tokenCount: 0, onChainData: null };
  }

  const daoPubkey = new PublicKey(daoAddress);
  const registry = await fetchTokenRegistry(daoPubkey);
  if (!registry) {
    return { tokens: [], tokenCount: 0, onChainData: null };
  }

  const minted = registry.tokens.filter((t: TokenSlot) => t.mint !== '' && t.isMinted);

  // Fetch off-chain image URIs for this DAO's tokens.
  let imageMap: Record<string, string> = {};
  try {
    const { data: imgRows } = await supabase
      .from('dao_token_images')
      .select('mint, image_uri')
      .eq('dao_address', daoKey);
    if (imgRows) {
      imageMap = Object.fromEntries(imgRows.map((r: { mint: string; image_uri: string }) => [r.mint, r.image_uri]));
    }
  } catch { /* non-fatal — images are optional */ }

  const tokens: TokenInfo[] = minted.map((t: TokenSlot, i: number) => ({
    slotIndex: i,
    mint: t.mint,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    supply: t.supply,
    isMinted: t.isMinted,
    isNaveManaged: t.isNaveManaged,
    mintAuthorityRevoked: t.mintAuthorityRevoked,
    freezeAuthorityRevoked: t.freezeAuthorityRevoked,
    metadataAuthorityRevoked: t.metadataAuthorityRevoked,
    canReceiveProposals: t.canReceiveProposals,
    createdAt: t.createdAt,
    imageUri: imageMap[t.mint],
  }));

  return { tokens, tokenCount: registry.tokenCount, onChainData: registry };
}

/** DAO token registry, backed by React Query so repeated mounts share one cached fetch. */
export function useTokenRegistry(daoAddress: string | null): UseTokenRegistryResult {
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId, rememberDaoChain } = useChain();

  const query = useQuery({
    queryKey: ['tokenRegistry', daoAddress, evmChainId],
    queryFn: () => fetchTokenRegistryData(daoAddress as string, evmChainId, rememberDaoChain),
    enabled: !!daoAddress && !isMock,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  const tokens = isMock ? MOCK_TOKENS : query.data?.tokens ?? [];
  const hasMintedToken = tokens.some((t) => t.isMinted);

  if (isMock) {
    return {
      tokens: MOCK_TOKENS,
      tokenCount: MOCK_TOKEN_REGISTRY.tokenCount,
      hasMintedToken,
      onChainData: MOCK_TOKEN_REGISTRY,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  if (!daoAddress) {
    return { tokens: [], tokenCount: 0, hasMintedToken: false, onChainData: null, loading: false, error: null, refetch };
  }

  return {
    tokens,
    tokenCount: query.data?.tokenCount ?? 0,
    hasMintedToken,
    onChainData: query.data?.onChainData ?? null,
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : 'Failed to fetch token registry') : null,
    refetch,
  };
}
