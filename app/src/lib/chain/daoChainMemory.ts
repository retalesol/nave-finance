// ─── Per-DAO EVM chain memory ─────────────────────────────────────────────────
// An EVM DAO address is a bare 0x… hex string — it carries NO information about
// WHICH EVM chain it lives on (Ethereum vs Base both use 20-byte addresses). So
// the active-chain reconciliation cannot infer the chain id from the address
// alone; defaulting every EVM DAO to Ethereum would query Base DAOs on the wrong
// chain (C4/M6). We therefore persist the resolved chain id alongside each DAO
// address in localStorage (mirrored from dao_registry.chain_id / the create
// flow) and look it up on sync. Supabase remains the source of truth; this cache
// just survives reloads so the active chain reconciles before the registry loads.

import { chainKindFromAddress, isEvmChainId, type EvmChainId } from './types';

const DAO_CHAIN_KEY = 'nave.daoChainById';

function readDaoChainMap(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DAO_CHAIN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeDaoChainMap(map: Record<string, number>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DAO_CHAIN_KEY, JSON.stringify(map));
  } catch {
    /* ignore storage errors */
  }
}

/** Persist the EVM chain id for a DAO (treasury) address (localStorage cache). */
export function rememberDaoChainId(address: string | null | undefined, chainId: EvmChainId): void {
  if (!address || chainKindFromAddress(address) !== 'evm' || !isEvmChainId(chainId)) return;
  const key = address.trim().toLowerCase();
  const map = readDaoChainMap();
  if (map[key] === chainId) return;
  map[key] = chainId;
  writeDaoChainMap(map);
}

/** Recall a previously-persisted EVM chain id for a DAO address, or null. */
export function recallDaoChainId(address: string | null | undefined): EvmChainId | null {
  if (!address || chainKindFromAddress(address) !== 'evm') return null;
  const stored = readDaoChainMap()[address.trim().toLowerCase()];
  return typeof stored === 'number' && isEvmChainId(stored) ? stored : null;
}
