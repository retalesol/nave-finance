import { useState, useEffect, useCallback } from 'react';
import {
  supabase,
  setSupabaseWalletAddress,
  type WatchedDaoRow,
  type DaoRegistryRow,
} from '../lib/supabaseClient';
import { watchDaoWithAccessGate, type DaoAccessMessageSigner } from '../lib/edgeFunctionClient';
import { isEvmChainId } from '../lib/chain/types';
import { useChain } from './useChain';
import { daoOnchainAddressEquals, normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';

export interface WatchedDao {
  daoOnchainAddress: string;
  label: string;
  addedAt: string;
  // Joined from dao_registry
  name: string;
  slug: string | null;
  description: string;
  logoUrl: string;
  governanceType: string;
  chainId: number | null;
}

interface UseWatchedDaosResult {
  daos: WatchedDao[];
  loading: boolean;
  error: string | null;
  watchDao: (daoAddress: string, label?: string) => Promise<void>;
  unwatchDao: (daoAddress: string) => Promise<void>;
  isWatching: (daoAddress: string) => boolean;
  refetch: () => void;
}

const GLOBAL_LOCAL_STORAGE_KEY = 'nave_watched_daos';

function getLocalStorageKey(walletAddress: string | null): string {
  return walletAddress ? `nave_watched_daos_${walletAddress}` : GLOBAL_LOCAL_STORAGE_KEY;
}

function getLocalWatchedDaos(walletAddress: string | null): string[] {
  try {
    const stored = localStorage.getItem(getLocalStorageKey(walletAddress));
    const raw = stored ? JSON.parse(stored) : [];
    if (!Array.isArray(raw)) return [];
    return raw.map((a: unknown) =>
      typeof a === 'string' ? normalizeDaoOnchainAddressForQuery(a) || a.trim() : '',
    ).filter(Boolean);
  } catch {
    return [];
  }
}

function setLocalWatchedDaos(addresses: string[], walletAddress: string | null) {
  localStorage.setItem(getLocalStorageKey(walletAddress), JSON.stringify(addresses));
}

/**
 * @param walletAddress  Connected wallet for the active chain (null when disconnected).
 * @param signWatchMessage  Signer used ONLY inside `watchDao` (explicit user
 *   action) — `watch-dao` now requires a signed `nave-watch|…` challenge.
 *   Reads/unwatch never prompt the wallet.
 */
export function useWatchedDaos(
  walletAddress: string | null,
  signWatchMessage?: DaoAccessMessageSigner,
): UseWatchedDaosResult {
  const [daos, setDaos] = useState<WatchedDao[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { rememberDaoChain } = useChain();

  const rememberRegistryChain = useCallback((reg: DaoRegistryRow | undefined | null) => {
    if (reg && typeof reg.chain_id === 'number' && isEvmChainId(reg.chain_id)) {
      rememberDaoChain(reg.dao_onchain_address, reg.chain_id);
    }
  }, [rememberDaoChain]);

  // Keep the Supabase wallet header in sync so wallet-scoped RLS resolves.
  useEffect(() => {
    setSupabaseWalletAddress(walletAddress);
  }, [walletAddress]);

  const fetchData = useCallback(async () => {
    if (!walletAddress) {
      // Fall back to global localStorage when no wallet connected
      const localAddresses = getLocalWatchedDaos(null);
      if (localAddresses.length > 0) {
        const { data: registries } = await supabase
          .from('dao_registry')
          .select('*')
          .in('dao_onchain_address', localAddresses);

        const watchedDaos: WatchedDao[] = localAddresses.map((addr) => {
          const reg = (registries as DaoRegistryRow[] | null)?.find(
            (r) => daoOnchainAddressEquals(r.dao_onchain_address, addr),
          );
          rememberRegistryChain(reg);
          return {
            daoOnchainAddress: addr,
            label: '',
            addedAt: '',
            name: reg?.name || 'Unknown DAO',
            slug: reg?.slug ?? null,
            description: reg?.description || '',
            logoUrl: reg?.logo_url || '',
            governanceType: reg?.governance_type || 'wallet',
            chainId: reg?.chain_id ?? null,
          };
        });

        setDaos(watchedDaos);
      } else {
        setDaos([]);
      }
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Immediately show cached data for this wallet while Supabase fetches
    const cachedAddresses = getLocalWatchedDaos(walletAddress);
    if (cachedAddresses.length > 0) {
      const { data: cachedRegs } = await supabase
        .from('dao_registry')
        .select('*')
        .in('dao_onchain_address', cachedAddresses);
      const cachedDaos: WatchedDao[] = cachedAddresses.map((addr) => {
        const reg = (cachedRegs as DaoRegistryRow[] | null)?.find(
          (r) => daoOnchainAddressEquals(r.dao_onchain_address, addr),
        );
        rememberRegistryChain(reg);
        return {
          daoOnchainAddress: addr,
          label: '',
          addedAt: '',
          name: reg?.name || 'Unknown DAO',
          slug: reg?.slug ?? null,
          description: reg?.description || '',
          logoUrl: reg?.logo_url || '',
          governanceType: reg?.governance_type || 'wallet',
          chainId: reg?.chain_id ?? null,
        };
      });
      setDaos(cachedDaos);
      setLoading(false);
    }

    try {
      // Fetch from Supabase for authoritative, up-to-date list
      const { data: watched, error: watchError } = await supabase
        .from('watched_daos')
        .select('*')
        .eq('wallet_address', walletAddress)
        .order('added_at', { ascending: false });

      if (watchError) {
        setError(watchError.message);
        setLoading(false);
        return;
      }

      const watchedRows = (watched as WatchedDaoRow[]) || [];
      const daoAddresses = watchedRows.map((w) => normalizeDaoOnchainAddressForQuery(w.dao_onchain_address));

      // Fetch DAO metadata
      let registries: DaoRegistryRow[] = [];
      if (daoAddresses.length > 0) {
        const { data: regData } = await supabase
          .from('dao_registry')
          .select('*')
          .in('dao_onchain_address', daoAddresses);
        registries = (regData as DaoRegistryRow[]) || [];
      }

      const result: WatchedDao[] = watchedRows.map((w) => {
        const reg = registries.find(
          (r) => daoOnchainAddressEquals(r.dao_onchain_address, w.dao_onchain_address),
        );
        rememberRegistryChain(reg);
        return {
          daoOnchainAddress: w.dao_onchain_address,
          label: w.label,
          addedAt: w.added_at,
          name: reg?.name || 'Unknown DAO',
          slug: reg?.slug ?? null,
          description: reg?.description || '',
          logoUrl: reg?.logo_url || '',
          governanceType: reg?.governance_type || 'wallet',
          chainId: reg?.chain_id ?? null,
        };
      });

      setDaos(result);

      // Sync to wallet-scoped localStorage as backup
      setLocalWatchedDaos(daoAddresses, walletAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch watched DAOs');
    } finally {
      setLoading(false);
    }
  }, [walletAddress, rememberRegistryChain]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const watchDao = useCallback(
    async (daoAddress: string, label = '') => {
      const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress) || daoAddress.trim();
      if (walletAddress && signWatchMessage) {
        // One wallet prompt per explicit watch action (signed single-use challenge).
        const { data, error: watchError } = await watchDaoWithAccessGate(
          daoKey,
          walletAddress,
          label,
          signWatchMessage,
        );
        if (watchError || !data?.allowed) {
          throw new Error(watchError || 'Access denied for this DAO.');
        }
      } else if (walletAddress) {
        // Wallet cannot sign messages: keep the watch local-only (non-fatal).
        console.warn('[useWatchedDaos] wallet cannot sign; watch-dao sync skipped (local only).');
      }

      // Also persist to wallet-scoped localStorage
      const local = getLocalWatchedDaos(walletAddress);
      if (!local.some((a) => daoOnchainAddressEquals(a, daoKey))) {
        setLocalWatchedDaos([...local, daoKey], walletAddress);
      }

      await fetchData();
    },
    [walletAddress, signWatchMessage, fetchData],
  );

  const unwatchDao = useCallback(
    async (daoAddress: string) => {
      const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress) || daoAddress.trim();
      if (walletAddress) {
        await supabase
          .from('watched_daos')
          .delete()
          .eq('wallet_address', walletAddress)
          .eq('dao_onchain_address', daoKey);
      }

      const local = getLocalWatchedDaos(walletAddress);
      setLocalWatchedDaos(local.filter((a) => !daoOnchainAddressEquals(a, daoKey)), walletAddress);

      await fetchData();
    },
    [walletAddress, fetchData],
  );

  const isWatching = useCallback(
    (daoAddress: string) => daos.some((d) => daoOnchainAddressEquals(d.daoOnchainAddress, daoAddress)),
    [daos],
  );

  return { daos, loading, error, watchDao, unwatchDao, isWatching, refetch: fetchData };
}
