import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { isMockDaoAddress } from '../lib/mockData';
import { useChain } from '../hooks/useChain';

/**
 * WalletGate wraps app-level routes and shows a connect prompt
 * when no wallet is connected. Prevents unauthenticated access
 * to treasury dashboards.
 *
 * The required wallet depends on the active chain: Solana DAOs need a connected
 * Solana wallet-adapter wallet; Ethereum/Base DAOs need a connected EVM wallet
 * (wagmi/RainbowKit).
 */
export default function WalletGate({ children }: { children: React.ReactNode }) {
  const { connected: solanaConnected } = useWallet();
  const { isConnected: evmConnected } = useAccount();
  const { chainKind } = useChain();
  const navigate = useNavigate();
  const location = useLocation();

  const connected = chainKind === 'evm' ? evmConnected : solanaConnected;

  // Allow demo mode through without a wallet connection (includes legacy mock sentinel)
  const demoTreasury = (location.state as { treasuryAddress?: string } | null)?.treasuryAddress;
  const isDemoRoute = demoTreasury != null && isMockDaoAddress(demoTreasury);

  useEffect(() => {
    if (!connected && !isDemoRoute) {
      navigate('/treasuries', { replace: true, state: { from: location.pathname } });
    }
  }, [connected, isDemoRoute, navigate, location.pathname]);

  if (!connected && !isDemoRoute) {
    // Render a minimal spinner while the redirect effect fires
    return (
      <div
        className="flex items-center justify-center"
        style={{ minHeight: '100vh', backgroundColor: 'hsl(var(--background))' }}
      >
        <div
          className="h-7 w-7 rounded-full border-2 animate-spin"
          style={{
            borderColor: 'hsl(var(--border))',
            borderTopColor: 'hsl(var(--foreground))',
          }}
        />
      </div>
    );
  }

  // Connected or demo mode — render children
  return <>{children}</>;
}