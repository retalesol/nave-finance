/**
 * Tiny module-scoped pub/sub for the "last wallet connection error", shared
 * between the top-level `WalletProvider.onError` handler (set in App.tsx,
 * which is the only place the Solana wallet adapter's `error` event can be
 * observed app-wide) and `NaveWalletModal` (which surfaces it to the user).
 *
 * A dedicated store avoids threading an error prop through the wallet-adapter
 * context, since `useWallet()` itself does not expose the adapter's error
 * state (see @solana/wallet-adapter-react's `WalletContextState`).
 */
type Listener = (error: string | null) => void;

let currentError: string | null = null;
const listeners = new Set<Listener>();

export function getWalletConnectionError(): string | null {
  return currentError;
}

export function setWalletConnectionError(error: string | null): void {
  currentError = error;
  listeners.forEach((listener) => listener(error));
}

export function subscribeWalletConnectionError(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Maps a Solana wallet-adapter `WalletError` (by class name) to a short, human-readable message. */
export function describeWalletError(error: { name?: string; message?: string } | null | undefined): string {
  switch (error?.name) {
    case 'WalletNotReadyError':
      return "This wallet isn't installed or isn't ready. Install it and try again, or choose another wallet.";
    case 'WalletConnectionError':
      return 'Connection was rejected or failed. Please try again.';
    case 'WalletTimeoutError':
      return 'Connection timed out. Please try again.';
    case 'WalletWindowBlockedError':
      return 'The wallet popup was blocked by your browser. Allow popups for this site and try again.';
    case 'WalletWindowClosedError':
      return 'The wallet popup was closed before connecting. Please try again.';
    case 'WalletDisconnectedError':
      return 'The wallet disconnected unexpectedly. Please reconnect.';
    case 'WalletLoadError':
      return 'The wallet failed to load. Refresh the page and try again.';
    case 'WalletAccountError':
    case 'WalletPublicKeyError':
      return "Couldn't read an account from this wallet. Unlock it and try again. For Ethereum/Base/Robinhood use MetaMask via Connect on that network; for Solana use Phantom or Solflare.";
    default:
      return error?.message || 'Failed to connect wallet. Please try again.';
  }
}
