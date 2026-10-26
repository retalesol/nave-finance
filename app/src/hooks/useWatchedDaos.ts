import { useState, useEffect, useCallback } from 'react';
import {
  supabase,
  setSupabaseWalletAddress,
  type WatchedDaoRow,
  type DaoRegistryRow,
} from '../lib/supabaseClient';
import { watchDaoWithAccessGate, type DaoAccessMessageSigner } from '../lib/edgeFunctionClient';
import { evmTarget, isEvmAddress, isEvmChainId } from '../lib/chain/types';
import { useChain } from './useChain';
import { recallDaoChainId } from '../lib/chain/daoChainMemory';
import {
  daoOnchainAddressEquals,
  normalizeDaoOnchainAddressForQuery,
  normalizeWalletAddress,
} from '../lib/chain/daoOnchainAddress';

export interface TreasuryChainChip {
  chainId: number | null;
  daoOnchainAddress: string;
  label: string;
}

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
  treasuryGroupId: string | null;
  /** One entry per activated chain. Present even when chain_id was missing. */
  chains: TreasuryChainChip[];
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

function chipLabel(chainId: number | null, address: string): string {
  if (typeof chainId === 'number' && isEvmChainId(chainId)) return evmTarget(chainId).label;
  if (isEvmAddress(address)) return 'EVM';
  return 'Solana';
}

function resolveChainId(address: string, registryChain: number | null | undefined): number | null {
  if (typeof registryChain === 'number' && isEvmChainId(registryChain)) return registryChain;
  if (isEvmAddress(address)) return recallDaoChainId(address);
  return null;
}

function rowToWatched(reg: DaoRegistryRow | undefined | null, address: string, label = '', addedAt = ''): WatchedDao {
  const chainId = resolveChainId(address, reg?.chain_id);
  const daoOnchainAddress = normalizeDaoOnchainAddressForQuery(address) || address;
  return {
    daoOnchainAddress,
    label,
    addedAt,
    name: reg?.name || 'Unknown DAO',
    slug: reg?.slug ?? null,
    description: reg?.description || '',
    logoUrl: reg?.logo_url || '',
    governanceType: reg?.governance_type || 'wallet',
    chainId,
    treasuryGroupId: reg?.treasury_group_id ?? null,
    chains: [{
      chainId,
      daoOnchainAddress,
      label: chipLabel(chainId, daoOnchainAddress),
    }],
  };
}

function groupKey(dao: WatchedDao): string {
  if (dao.treasuryGroupId) return `g:${dao.treasuryGroupId}`;
  if (dao.slug) return `s:${dao.slug}`;
  return `a:${normalizeDaoOnchainAddressForQuery(dao.daoOnchainAddress)}`;
}

/** One card per treasury group, with a chip for every chain row we found. */
export function groupWatchedDaos(rows: WatchedDao[]): WatchedDao[] {
  const groups = new Map<string, WatchedDao>();
  for (const row of rows) {
    const key = groupKey(row);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row, chains: [...row.chains] });
      continue;
    }
    for (const chip of row.chains) {
      const seen = existing.chains.some(
        (c) => c.chainId === chip.chainId && daoOnchainAddressEquals(c.daoOnchainAddress, chip.daoOnchainAddress),
      );
      if (!seen) existing.chains.push(chip);
    }
    if (!existing.slug && row.slug) existing.slug = row.slug;
    if (existing.name === 'Unknown DAO' && row.name !== 'Unknown DAO') existing.name = row.name;
  }
  return [...groups.values()];
}

async function registryRowsFor(addresses: string[]): Promise<DaoRegistryRow[]> {
  if (addresses.length === 0) return [];
  const { data } = await supabase.from('dao_registry').select('*').in('dao_onchain_address', addresses);
  return (data as DaoRegistryRow[] | null) ?? [];
}

async function siblingRows(groupIds: string[]): Promise<DaoRegistryRow[]> {
  if (groupIds.length === 0) return [];
  const { data, error } = await supabase.from('dao_registry').select('*').in('treasury_group_id', groupIds);
  if (error || !data) return [];
  return data as DaoRegistryRow[];
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
  const wallet = normalizeWalletAddress(walletAddress);

  const rememberRegistryChain = useCallback((reg: DaoRegistryRow | undefined | null) => {
    if (reg && typeof reg.chain_id === 'number' && isEvmChainId(reg.chain_id)) {
      rememberDaoChain(reg.dao_onchain_address, reg.chain_id);
    }
  }, [rememberDaoChain]);

  // Keep the Supabase wallet header in sync so wallet-scoped RLS resolves.
  // EVM addresses are lowercased; Solana stays base58.
  useEffect(() => {
    setSupabaseWalletAddress(wallet);
  }, [wallet]);

  const fetchData = useCallback(async () => {
    if (!wallet) {
      const localAddresses = getLocalWatchedDaos(null);
      if (localAddresses.length > 0) {
        const registries = await registryRowsFor(localAddresses);
        const watchedDaos = groupWatchedDaos(localAddresses.map((addr) => {
          const reg = registries.find((r) => daoOnchainAddressEquals(r.dao_onchain_address, addr));
          rememberRegistryChain(reg);
          return rowToWatched(reg, addr);
        }));
        setDaos(watchedDaos);
      } else {
        setDaos([]);
      }
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const cachedAddresses = getLocalWatchedDaos(wallet);
    if (cachedAddresses.length > 0) {
      const cachedRegs = await registryRowsFor(cachedAddresses);
      setDaos(groupWatchedDaos(cachedAddresses.map((addr) => {
        const reg = cachedRegs.find((r) => daoOnchainAddressEquals(r.dao_onchain_address, addr));
        rememberRegistryChain(reg);
        return rowToWatched(reg, addr);
      })));
      setLoading(false);
    }

    try {
      const { data: watched, error: watchError } = await supabase
        .from('watched_daos')
        .select('*')
        .eq('wallet_address', wallet)
        .order('added_at', { ascending: false });

      if (watchError) {
        setError(watchError.message);
        setLoading(false);
        return;
      }

      const watchedRows = (watched as WatchedDaoRow[]) || [];
      const daoAddresses = watchedRows.map((w) => normalizeDaoOnchainAddressForQuery(w.dao_onchain_address));

      const { data: founded } = await supabase
        .from('dao_registry')
        .select('*')
        .eq('creator_wallet', wallet);

      let registries = await registryRowsFor(daoAddresses);
      const founderRows = (founded as DaoRegistryRow[] | null) ?? [];
      registries = [...registries, ...founderRows];

      const groupIds = [...new Set(registries.map((r) => r.treasury_group_id).filter((id): id is string => !!id))];
      registries = [...registries, ...await siblingRows(groupIds)];

      for (const reg of registries) rememberRegistryChain(reg);

      const byAddress = new Map<string, DaoRegistryRow[]>();
      for (const reg of registries) {
        const key = normalizeDaoOnchainAddressForQuery(reg.dao_onchain_address);
        const list = byAddress.get(key) ?? [];
        list.push(reg);
        byAddress.set(key, list);
      }

      const flat: WatchedDao[] = [];
      const pushReg = (reg: DaoRegistryRow, label = '', addedAt = '') => {
        flat.push(rowToWatched(reg, reg.dao_onchain_address, label, addedAt));
      };

      if (watchedRows.length === 0 && founderRows.length === 0) {
        setDaos([]);
        setLocalWatchedDaos([], wallet);
        return;
      }

      for (const w of watchedRows) {
        const key = normalizeDaoOnchainAddressForQuery(w.dao_onchain_address);
        const regs = byAddress.get(key);
        if (regs && regs.length > 0) {
          for (const reg of regs) pushReg(reg, w.label, w.added_at);
        } else {
          flat.push(rowToWatched(null, w.dao_onchain_address, w.label, w.added_at));
        }
      }
      for (const reg of founderRows) pushReg(reg);
      for (const reg of registries) {
        if (reg.treasury_group_id && groupIds.includes(reg.treasury_group_id)) pushReg(reg);
      }

      const grouped = groupWatchedDaos(flat);
      setDaos(grouped);
      setLocalWatchedDaos(
        grouped.flatMap((g) => g.chains.map((c) => c.daoOnchainAddress)),
        wallet,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch watched DAOs');
    } finally {
      setLoading(false);
    }
  }, [wallet, rememberRegistryChain]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const watchDao = useCallback(
    async (daoAddress: string, label = '') => {
      const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress) || daoAddress.trim();
      if (wallet && signWatchMessage) {
        const { data, error: watchError } = await watchDaoWithAccessGate(
          daoKey,
          wallet,
          label,
          signWatchMessage,
        );
        if (watchError || !data?.allowed) {
          throw new Error(watchError || 'Access denied for this DAO.');
        }
      } else if (wallet) {
        console.warn('[useWatchedDaos] wallet cannot sign; watch-dao sync skipped (local only).');
      }

      const local = getLocalWatchedDaos(wallet);
      if (!local.some((a) => daoOnchainAddressEquals(a, daoKey))) {
        setLocalWatchedDaos([...local, daoKey], wallet);
      }

      await fetchData();
    },
    [wallet, signWatchMessage, fetchData],
  );

  const unwatchDao = useCallback(
    async (daoAddress: string) => {
      const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress) || daoAddress.trim();
      if (wallet) {
        await supabase
          .from('watched_daos')
          .delete()
          .eq('wallet_address', wallet)
          .eq('dao_onchain_address', daoKey);
      }

      const local = getLocalWatchedDaos(wallet);
      setLocalWatchedDaos(local.filter((a) => !daoOnchainAddressEquals(a, daoKey)), wallet);

      await fetchData();
    },
    [wallet, fetchData],
  );

  const isWatching = useCallback(
    (daoAddress: string) => daos.some((d) =>
      daoOnchainAddressEquals(d.daoOnchainAddress, daoAddress)
      || d.chains.some((c) => daoOnchainAddressEquals(c.daoOnchainAddress, daoAddress)),
    ),
    [daos],
  );

  return { daos, loading, error, watchDao, unwatchDao, isWatching, refetch: fetchData };
}
