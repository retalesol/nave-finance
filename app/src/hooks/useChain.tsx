import { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react';
import {
  type ChainKind,
  type ChainFamily,
  type ChainTarget,
  type EvmChainId,
  isEvmChainId,
  solanaTarget,
  evmTarget,
  chainKindFromAddress,
} from '../lib/chain/types';
import { rememberDaoChainId, recallDaoChainId } from '../lib/chain/daoChainMemory';
import { daoOnchainAddressEquals } from '../lib/chain/daoOnchainAddress';
import { activeTargetForFamily } from '../lib/programConfig';
import { readNaveSession, readPersistedDaoAddress, writeNaveSession } from '../lib/sessionPersistence';

function initialChainTarget(): ChainTarget {
  const dao = readPersistedDaoAddress();
  if (dao && chainKindFromAddress(dao) === 'solana') return solanaTarget();
  if (dao && chainKindFromAddress(dao) === 'evm') {
    const remembered = recallDaoChainId(dao);
    if (remembered) return evmTarget(remembered);
  }
  const session = readNaveSession();
  if (session.evmChainId && isEvmChainId(session.evmChainId)) return evmTarget(session.evmChainId);
  if (session.chainFamily) return activeTargetForFamily(session.chainFamily);
  return solanaTarget();
}

interface ChainContextValue {
  /** The currently active chain target (drives wallet gating + tx dispatch). */
  target: ChainTarget;
  /** Convenience: `target.kind`. */
  chainKind: ChainKind;
  /** Convenience: active chain family (solana/ethereum/base). */
  chainFamily: ChainFamily;
  /** Convenience: active EVM chain id, or null on Solana. */
  evmChainId: EvmChainId | null;
  /** Set the active chain by family; EVM chain id comes from the deployment profile. */
  setChainFamily: (family: ChainFamily) => void;
  /** Set the active chain to a specific EVM chain id (closed set). */
  setEvmChainId: (chainId: EvmChainId) => void;
  /**
   * Reconcile the active chain to match a DAO address's kind (0x… ⇒ EVM).
   * Passing `null` clears the synced-DAO pointer but does NOT change the
   * user's network selection (needed when leaving a treasury to switch chains).
   */
  syncFromAddress: (address: string | null) => void;
  /**
   * Persist the specific EVM chain for a DAO address. Activates that chain
   * only when `address` is the currently synced (active) DAO — lobby / watched
   * list hydration must not yank the network picker to another chain.
   */
  rememberDaoChain: (address: string | null, chainId: EvmChainId) => void;
}

const ChainContext = createContext<ChainContextValue>({
  target: solanaTarget(),
  chainKind: 'solana',
  chainFamily: 'solana',
  evmChainId: null,
  setChainFamily: () => {},
  setEvmChainId: () => {},
  syncFromAddress: () => {},
  rememberDaoChain: () => {},
});

export function ChainProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ChainTarget>(initialChainTarget);
  /** Address last passed to syncFromAddress — drives rememberDaoChain activation. */
  const syncedAddressRef = useRef<string | null>(readPersistedDaoAddress());

  useEffect(() => {
    writeNaveSession({
      chainFamily: target.family,
      evmChainId: target.evmChainId ?? null,
    });
  }, [target]);

  const setChainFamily = useCallback((family: ChainFamily) => {
    setTarget((prev) => {
      const synced = syncedAddressRef.current;
      // A product switch must not retarget a Solana treasury onto Base, or an
      // EVM treasury onto Solana. Explicit switches clear the synced treasury first.
      if (synced && chainKindFromAddress(synced) === 'solana' && family !== 'solana') {
        return prev.kind === 'solana' ? prev : solanaTarget();
      }
      if (synced && chainKindFromAddress(synced) === 'evm' && family === 'solana') {
        const remembered = recallDaoChainId(synced);
        return remembered ? evmTarget(remembered) : prev;
      }
      return activeTargetForFamily(family);
    });
  }, []);

  const setEvmChainId = useCallback((chainId: EvmChainId) => {
    setTarget((prev) => {
      const synced = syncedAddressRef.current;
      if (synced && chainKindFromAddress(synced) === 'solana') {
        return prev.kind === 'solana' ? prev : solanaTarget();
      }
      return evmTarget(chainId);
    });
  }, []);

  const syncFromAddress = useCallback((address: string | null) => {
    syncedAddressRef.current = address;
    // Clearing the active DAO (network switch confirm, lobby return) must keep
    // the user's selected network — do not snap to Solana/Base.
    if (!address) return;

    const kind = chainKindFromAddress(address);
    setTarget((prev) => {
      if (kind === 'solana') {
        return prev.kind === 'solana' ? prev : solanaTarget();
      }
      // EVM address: prefer a persisted chain id for THIS exact DAO address
      // (Ethereum vs Base cannot be inferred from the hex address itself).
      const remembered = recallDaoChainId(address);
      if (remembered) {
        if (prev.kind === 'evm' && prev.evmChainId === remembered) return prev;
        return evmTarget(remembered);
      }
      // No per-DAO chain memory yet: do NOT inherit the previous wallet's EVM
      // chain (e.g. Base vs Ethereum) — that caused cross-DAO mis-reads until
      // dao_registry.chain_id resolved. Default to the configured primary
      // Ethereum target until rememberDaoChain runs for this treasury.
      return activeTargetForFamily('ethereum');
    });
  }, []);

  const rememberDaoChain = useCallback((address: string | null, chainId: EvmChainId) => {
    rememberDaoChainId(address, chainId);
    // Activate only for the DAO currently synced via syncFromAddress. Watched-
    // list hydration must persist chain ids without overriding the picker.
    setTarget((prev) => {
      if (prev.kind === 'evm' && prev.evmChainId === chainId) return prev;
      if (!address || !daoOnchainAddressEquals(address, syncedAddressRef.current)) {
        return prev;
      }
      return chainKindFromAddress(address) === 'evm' ? evmTarget(chainId) : prev;
    });
  }, []);

  const value = useMemo<ChainContextValue>(
    () => ({
      target,
      chainKind: target.kind,
      chainFamily: target.family,
      evmChainId: target.evmChainId ?? null,
      setChainFamily,
      setEvmChainId,
      syncFromAddress,
      rememberDaoChain,
    }),
    [target, setChainFamily, setEvmChainId, syncFromAddress, rememberDaoChain],
  );

  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

export function useChain(): ChainContextValue {
  return useContext(ChainContext);
}
