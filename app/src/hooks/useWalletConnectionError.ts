import { useCallback, useSyncExternalStore } from 'react';
import {
  getWalletConnectionError,
  setWalletConnectionError,
  subscribeWalletConnectionError,
} from '../lib/walletErrorStore';

/** Reactive view over the last Solana wallet-connection error (see `walletErrorStore`). */
export function useWalletConnectionError(): {
  error: string | null;
  setError: (message: string | null) => void;
  clearError: () => void;
} {
  const error = useSyncExternalStore(
    subscribeWalletConnectionError,
    getWalletConnectionError,
    () => null,
  );

  const clearError = useCallback(() => setWalletConnectionError(null), []);

  return { error, setError: setWalletConnectionError, clearError };
}
