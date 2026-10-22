import { useMemo, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
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
 * Canonical paths (/overview, /money, /agents, /decisions, /rules, /bridge, /stake, /settings, /tokens)
 * alongside legacy paths (/dashboard, /assets, /agent, /automation, /governance, /votes, /policy, /team)
 * which redirect to their canonical counterparts while preserving location.state and query strings.
 */
const APP_ROUTES = [
  '/overview',
  '/dashboard',
  '/money',
  '/assets',
  '/agents',
  '/agent',
  '/automation',
  '/decisions',
  '/governance',
  '/votes',
  '/rules',
  '/policy',
  '/bridge',
  '/stake',
  '/settings',
  '/team',
  '/tokens',
];

function LegacyRedirect({ to }: { to: string }) {
  const location = useLocation();
  const { proposalId } = useParams<{ proposalId?: string }>();
  const targetPath = proposalId ? `${to}/${proposalId}` : to;
  return <Navigate to={targetPath + location.search} state={location.state} replace />;
}

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
                  <Route path="/overview" element={<Dashboard />} />
                  <Route path="/dashboard" element={<LegacyRedirect to="/overview" />} />
                  <Route path="/money" element={<Assets />} />
                  <Route path="/assets" element={<LegacyRedirect to="/money" />} />
                  <Route path="/agents" element={<Agent />} />
                  <Route path="/agent" element={<LegacyRedirect to="/agents" />} />
                  <Route path="/automation" element={<LegacyRedirect to="/agents" />} />
                  <Route path="/decisions" element={<Governance />} />
                  <Route path="/decisions/:proposalId" element={<Governance />} />
                  <Route path="/governance" element={<LegacyRedirect to="/decisions" />} />
                  <Route path="/governance/:proposalId" element={<LegacyRedirect to="/decisions" />} />
                  <Route path="/votes" element={<LegacyRedirect to="/decisions" />} />
                  <Route path="/votes/:proposalId" element={<LegacyRedirect to="/decisions" />} />
                  <Route path="/rules" element={<PolicyEngine />} />
                  <Route path="/policy" element={<LegacyRedirect to="/rules" />} />
                  <Route path="/bridge" element={<BridgePage mode="bridge" />} />
                  <Route path="/stake" element={<BridgePage mode="stake" />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/team" element={<LegacyRedirect to="/settings" />} />
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