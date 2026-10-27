/**
 * Logged session for the open treasury and its network.
 * Product switches read this back so Nave and Nave Pay stay on the same
 * wallet, network, and treasury.
 */

import { isEvmChainId, type ChainFamily, type EvmChainId } from './chain/types';

const SESSION_KEY = 'nave.session.v1';
const DAO_KEY = 'nave.activeDaoAddress';

export interface NaveSession {
  chainFamily: ChainFamily | null;
  evmChainId: EvmChainId | null;
  daoAddress: string | null;
}

const FAMILIES: readonly ChainFamily[] = ['solana', 'ethereum', 'base', 'robinhood', 'arc'];

function emptySession(): NaveSession {
  return { chainFamily: null, evmChainId: null, daoAddress: null };
}

export function readNaveSession(): NaveSession {
  if (typeof window === 'undefined') return emptySession();
  const session = emptySession();
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NaveSession>;
      if (typeof parsed.chainFamily === 'string' && FAMILIES.includes(parsed.chainFamily as ChainFamily)) {
        session.chainFamily = parsed.chainFamily as ChainFamily;
      }
      if (typeof parsed.evmChainId === 'number' && isEvmChainId(parsed.evmChainId)) {
        session.evmChainId = parsed.evmChainId;
      }
      if (typeof parsed.daoAddress === 'string' && parsed.daoAddress.trim()) {
        session.daoAddress = parsed.daoAddress.trim();
      }
    }
  } catch {
    /* ignore unreadable session */
  }
  if (!session.daoAddress) {
    try {
      const legacy = window.localStorage.getItem(DAO_KEY);
      if (legacy && legacy.trim()) session.daoAddress = legacy.trim();
    } catch {
      /* ignore */
    }
  }
  return session;
}

export function readPersistedDaoAddress(): string | null {
  return readNaveSession().daoAddress;
}

export function writeNaveSession(patch: Partial<NaveSession>): void {
  if (typeof window === 'undefined') return;
  const current = readNaveSession();
  const next: NaveSession = {
    chainFamily: patch.chainFamily === undefined ? current.chainFamily : patch.chainFamily,
    evmChainId: patch.evmChainId === undefined ? current.evmChainId : patch.evmChainId,
    daoAddress: patch.daoAddress === undefined ? current.daoAddress : patch.daoAddress,
  };
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    if (next.daoAddress) window.localStorage.setItem(DAO_KEY, next.daoAddress);
    else if (patch.daoAddress === null) window.localStorage.removeItem(DAO_KEY);
  } catch {
    /* ignore storage errors */
  }
}
