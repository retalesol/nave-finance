import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { fetchTreasuryVault, fetchTreasuryVaultBalance } from '../lib/onChainFetcher';
import { fetchNavEvm, fetchTreasuryHasBalanceEvm } from '../lib/evm/readers';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress, type EvmChainId } from '../lib/chain/types';
import { useChain } from './useChain';
import { isMockDaoAddress } from '../lib/mockData';

export interface TreasuryBalance {
  /** Net asset value (vault accounting) in base units. */
  currentNav: number;
  /** Total ever deposited (base units). */
  totalDeposited: number;
  /** Native SOL held by the vault PDA. */
  solLamports: number;
  /** True when the treasury holds any funds (NAV, deposits, or native SOL). */
  hasBalance: boolean;
  loading: boolean;
  /** True until we have actually resolved on-chain balance (avoids false "empty"). */
  resolved: boolean;
  /**
   * True when the last balance check failed (RPC error) rather than confirming
   * the treasury is empty. Distinguishes "we don't know" from "confirmed
   * empty" — callers gating on `hasBalance` should treat this as non-blocking,
   * never as "empty", since `resolved` is already false whenever this is true.
   */
  hasError: boolean;
  refetch: () => void;
}

interface TreasuryBalanceData {
  currentNav: number;
  totalDeposited: number;
  solLamports: number;
  hasBalance: boolean;
}

const EMPTY_DATA: TreasuryBalanceData = {
  currentNav: 0,
  totalDeposited: 0,
  solLamports: 0,
  hasBalance: false,
};

const UNBLOCKED_DATA: TreasuryBalanceData = {
  currentNav: 0,
  totalDeposited: 0,
  solLamports: 0,
  hasBalance: true,
};

async function fetchTreasuryBalanceData(
  daoAddress: string,
  isMock: boolean,
  evmChainId: EvmChainId | null,
): Promise<TreasuryBalanceData> {
  // EVM DAOs (0x…): read NAV (micro-USD) from the treasury. Funds gate on
  // currentNav > 0.
  if (!isMock && chainKindFromAddress(daoAddress) === 'evm') {
    if (!evmChainId) {
      return { currentNav: 0, totalDeposited: 0, solLamports: 0, hasBalance: false };
    }
    const [nav, hasHoldings] = await Promise.all([
      fetchNavEvm(evmChainId, daoAddress),
      fetchTreasuryHasBalanceEvm(evmChainId, daoAddress),
    ]);
    const currentNav = nav ?? 0;
    return {
      currentNav,
      totalDeposited: 0,
      solLamports: 0,
      hasBalance: currentNav > 0 || hasHoldings,
    };
  }

  if (isMock || !isProgramConfigured() || chainKindFromAddress(daoAddress) !== 'solana') {
    // Demo / unconfigured: do not block on balance.
    return UNBLOCKED_DATA;
  }

  const daoPubkey = new PublicKey(daoAddress);
  const [vault, native] = await Promise.all([
    fetchTreasuryVault(daoPubkey),
    fetchTreasuryVaultBalance(daoPubkey),
  ]);
  const currentNav = vault?.currentNav ?? 0;
  const totalDeposited = vault?.totalDeposited ?? 0;
  const solLamports = native?.lamports ?? 0;
  return {
    currentNav,
    totalDeposited,
    solLamports,
    hasBalance: currentNav > 0 || totalDeposited > 0 || solLamports > 0,
  };
}

/**
 * Reads the DAO treasury vault balance on-chain. Used to gate actions that must
 * not run on an empty treasury — proposing/ratifying the constitution and
 * starting the autonomous agents.
 *
 * Mock DAOs and environments without configured programs are treated as funded
 * so the demo experience and unconfigured local builds are not blocked.
 *
 * Backed by React Query so repeated mounts across the dashboard (multiple
 * components reading the same DAO's balance) share one in-flight request and
 * one cache entry instead of each firing its own RPC calls.
 */
export function useTreasuryBalance(daoAddress: string | null): TreasuryBalance {
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId } = useChain();

  const query = useQuery({
    queryKey: ['treasuryBalance', daoAddress, isMock, evmChainId],
    queryFn: () => fetchTreasuryBalanceData(daoAddress as string, isMock, evmChainId),
    enabled: !!daoAddress,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  if (!daoAddress) {
    return { ...EMPTY_DATA, loading: false, resolved: false, hasError: false, refetch };
  }

  return {
    ...(query.data ?? EMPTY_DATA),
    loading: query.isFetching,
    resolved: query.isSuccess,
    hasError: query.isError,
    refetch,
  };
}
