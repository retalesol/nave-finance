import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { MOCK_DAO_ADDRESS, isMockDaoAddress, normalizeMockDaoAddress } from '../lib/mockData';
import { useChain } from './useChain';
import { chainKindFromAddress, type ChainKind } from '../lib/chain/types';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';

interface DaoContextValue {
  daoAddress: string | null;
  setDaoAddress: (address: string | null) => void;

  /** Chain kind of the active DAO, inferred from its address (0x… ⇒ EVM). */
  chainKind: ChainKind;

  /** True when the user selected "Explore Nave Treasury (Demo)" */
  isMockMode: boolean;

  /** Activate mock mode — sets daoAddress to the mock sentinel value */
  enableMockMode: () => void;

  /** Exit mock mode and clear daoAddress */
  disableMockMode: () => void;
}

const DaoContext = createContext<DaoContextValue>({
  daoAddress: null,
  setDaoAddress: () => {},
  chainKind: 'solana',
  isMockMode: false,
  enableMockMode: () => {},
  disableMockMode: () => {},
});

const STORAGE_KEY = 'nave.activeDaoAddress';

/** Canonical active treasury: mock sentinel preserved; EVM lowercased; Solana trimmed. */
function canonicalActiveDaoAddress(addr: string | null): string | null {
  if (addr == null) return null;
  const m = normalizeMockDaoAddress(addr);
  if (!m) return null;
  if (isMockDaoAddress(m)) return m;
  if (chainKindFromAddress(m) === 'evm') {
    const q = normalizeDaoOnchainAddressForQuery(m);
    return q || m;
  }
  return m.trim();
}

function readStoredAddress(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return canonicalActiveDaoAddress(normalizeMockDaoAddress(raw));
  } catch {
    return null;
  }
}

function writeStoredAddress(address: string | null) {
  if (typeof window === 'undefined') return;
  try {
    const next =
      address == null ? null : canonicalActiveDaoAddress(normalizeMockDaoAddress(address));
    if (next && !isMockDaoAddress(next)) {
      window.localStorage.setItem(STORAGE_KEY, next);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore storage errors */
  }
}

export function DaoProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { syncFromAddress } = useChain();
  // Read from route state if navigated from lobby/selector, else fall back to
  // the last selected DAO persisted in localStorage so a new/joined DAO stays
  // selected across navigation and reloads.
  const routeState = location.state as { treasuryAddress?: string } | null;
  const initialAddress = canonicalActiveDaoAddress(
    normalizeMockDaoAddress(routeState?.treasuryAddress || readStoredAddress()),
  );

  const [daoAddress, setDaoAddressState] = useState<string | null>(initialAddress);

  // Sync daoAddress when navigating to a new treasury via route state
  useEffect(() => {
    const incomingAddr = canonicalActiveDaoAddress(
      normalizeMockDaoAddress(routeState?.treasuryAddress || null),
    );
    if (incomingAddr && incomingAddr !== daoAddress) {
      setDaoAddressState(incomingAddr);
      writeStoredAddress(incomingAddr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeState?.treasuryAddress]);

  const isMockMode = isMockDaoAddress(daoAddress);
  const chainKind = chainKindFromAddress(daoAddress);

  // Keep the active chain (wallet gating + tx dispatch) reconciled with the
  // selected DAO. An EVM (0x…) address activates the EVM path; a base58 Solana
  // address (or the mock sentinel) activates the Solana path.
  useEffect(() => {
    syncFromAddress(daoAddress);
  }, [daoAddress, syncFromAddress]);

  const setDaoAddress = useCallback((address: string | null) => {
    const next = canonicalActiveDaoAddress(normalizeMockDaoAddress(address));
    setDaoAddressState(next);
    writeStoredAddress(next);
  }, []);

  const enableMockMode = useCallback(() => {
    setDaoAddressState(MOCK_DAO_ADDRESS);
  }, []);

  const disableMockMode = useCallback(() => {
    setDaoAddressState(null);
    writeStoredAddress(null);
  }, []);

  return (
    <DaoContext.Provider value={{ daoAddress, setDaoAddress, chainKind, isMockMode, enableMockMode, disableMockMode }}>
      {children}
    </DaoContext.Provider>
  );
}

export function useDaoContext(): DaoContextValue {
  return useContext(DaoContext);
}