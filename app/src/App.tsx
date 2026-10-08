import { useMemo, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WalletError } from '@solana/wallet-adapter-base';

import '@solana/wallet-adapter-react-ui/styles.css';
import '@rainbow-me/rainbowkit/styles.css';
import { describeWalletError, setWalletConnectionError } from './lib/walletErrorStore';

import NaveLayout from './components/NaveLayout';
import WalletGate from './components/WalletGate';
import NaveWalletModal from './components/NaveWalletModal';
import ErrorBoundary from './components/ErrorBoundary';
import { PageTransition } from './components/PageTransition';
import { DaoProvider } from './hooks/useDaoContext';
import { ChainProvider } from './hooks/useChain';
import { SOLANA_RPC_URL } from './lib/programConfig';
import { wagmiConfig } from './lib/evm/wagmi';

// Shared React Query client for the EVM (wagmi) data layer.
const queryClient = new QueryClient();

/* ── Lazy-loaded pages (route-level code splitting) ──── */
const Index = lazy(() => import('./pages/Index'));
const NotFound = lazy(() => import('./pages/NotFound'));
const CreateDAO = lazy(() => import('./pages/CreateDAO'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Agent = lazy(() => import('./pages/Agent'));
const PolicyEngine = lazy(() => import('./pages/PolicyEngine'));
const Governance = lazy(() => import('./pages/Governance'));
const Settings = lazy(() => import('./pages/Settings'));
const TreasuryLobby = lazy(() => import('./pages/TreasuryLobby'));
const Tokens = lazy(() => import('./pages/Tokens'));
const BridgePage = lazy(() => import('./pages/BridgePage'));
const Assets = lazy(() => import('./pages/Assets'));
const DaoCreated = lazy(() => import('./pages/DaoCreated'));
const DaoSlugPage = lazy(() => import('./pages/DaoSlugPage'));
const DocsIndex = lazy(() => import('./pages/DocsIndex'));
const DocsPage = lazy(() => import('./pages/DocsPage'));
const Simulation = lazy(() => import('./pages/Simulation'));

/* ── Loading fallback ──────────────────────────────────── */
function PageLoader() {
  return (
    <div
      className="flex items-center justify-center"
      style={{ minHeight: '100vh', backgroundColor: 'hsl(var(--background))' }}
    >
      <div className="text-center">
        <div
          className="mx-auto mb-4 h-8 w-8 rounded-full border-2 animate-spin"
          style={{
            borderColor: 'hsl(var(--border))',
            borderTopColor: 'hsl(var(--foreground))',
          }}
        />
        <p
          style={{
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            fontFamily: 'var(--font-body)',
          }}
        >
          Loading…
        </p>
      </div>
    </div>
  );
}

/*
 * Routes that use the app shell (sidebar + top bar).
 * IA aliases (/votes, /rules, /automation, /team) preserve bookmarks while canonical
 * paths (/governance, /policy, /agent, /settings) remain primary — full rename deferred.
 */
const APP_ROUTES = [
  '/dashboard',
  '/assets',
  '/agent',
  '/automation',
  '/policy',
  '/rules',
  '/governance',
  '/votes',
  '/settings',
  '/team',
  '/tokens',
];

function AppRoutes() {
  const location = useLocation();
  const isAppRoute = APP_ROUTES.some(r => location.pathname.startsWith(r));

  if (isAppRoute) {
    return (
      <WalletGate>
        <NaveLayout>
            <Suspense fallback={<PageLoader />}>
              <PageTransition layoutChild>
                <Routes location={location}>
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/assets" element={<Assets />} />
                  <Route path="/agent" element={<Agent />} />
                  <Route path="/automation" element={<Agent />} />
                  <Route path="/policy" element={<PolicyEngine />} />
                  <Route path="/rules" element={<PolicyEngine />} />
                  <Route path="/governance" element={<Governance />} />
                  <Route path="/governance/:proposalId" element={<Governance />} />
                  <Route path="/votes" element={<Governance />} />
                  <Route path="/votes/:proposalId" element={<Governance />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/team" element={<Settings />} />
                  <Route path="/tokens" element={<Tokens />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </PageTransition>
            </Suspense>
          </NaveLayout>
      </WalletGate>
    );
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <PageTransition>
        <Routes location={location}>
          <Route path="/" element={<Index />} />
          <Route path="/bridge" element={<BridgePage />} />
          {/* Staking now lives on the unified Bridge & Stake page. */}
          <Route path="/stake" element={<Navigate to="/bridge" replace />} />
          <Route path="/treasuries" element={<TreasuryLobby />} />
          <Route path="/create-dao" element={<CreateDAO />} />
          <Route path="/dao-created" element={<DaoCreated />} />
          <Route path="/dao/:slug" element={<DaoSlugPage />} />
          <Route path="/docs" element={<DocsIndex />} />
          <Route path="/docs/:slug" element={<DocsPage />} />
          <Route path="/simulation" element={<Simulation />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </PageTransition>
    </Suspense>
  );
}

/**
 * Surfaces wallet-adapter connection failures (wallet not installed, rejected
 * connection, popup blocked, timeout, etc.) to `NaveWalletModal` via the
 * shared `walletErrorStore` — this is the only place the adapter's `error`
 * event can be observed app-wide (`useWallet()` does not expose it).
 */
function handleWalletError(error: WalletError) {
  console.error('[wallet]', error);
  setWalletConnectionError(describeWalletError(error));
}

const App = () => {
  const endpoint = useMemo(() => SOLANA_RPC_URL, []);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ErrorBoundary>
      {/* EVM (Ethereum + Base) provider stack wraps the Solana stack. Both run
          side-by-side; the active chain is selected via ChainProvider, and each
          path's hooks only activate for their chain kind. */}
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider>
            <ConnectionProvider endpoint={endpoint}>
              <WalletProvider wallets={wallets} autoConnect onError={handleWalletError}>
                <WalletModalProvider>
                  <ChainProvider>
                    <DaoProvider>
                      <AppRoutes />
                      <NaveWalletModal />
                      <Toaster />
                    </DaoProvider>
                  </ChainProvider>
                </WalletModalProvider>
              </WalletProvider>
            </ConnectionProvider>
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ErrorBoundary>
  );
};

export default App;