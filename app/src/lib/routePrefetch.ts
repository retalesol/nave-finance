const loaders: Record<string, () => Promise<unknown>> = {
  '/overview': () => import('../pages/Dashboard'),
  '/money': () => import('../pages/Assets'),
  '/agents': () => import('../pages/Agent'),
  '/decisions': () => import('../pages/Governance'),
  '/rules': () => import('../pages/PolicyEngine'),
  '/bridge': () => import('../pages/BridgePage'),
  '/stake': () => import('../pages/BridgePage'),
  '/settings': () => import('../pages/Settings'),
  '/tokens': () => import('../pages/Tokens'),
  '/pay': () => import('../pages/pay/PaySection'),
  '/treasuries': () => import('../pages/TreasuryLobby'),
  '/create-dao': () => import('../pages/CreateDAO'),
  '/docs': () => import('../pages/DocsIndex'),
  '/compass': () => import('../pages/compass/CompassPage'),
};

const started = new Set<string>();

function prefetchKey(path: string): string {
  const clean = (path.split('?')[0].replace(/\/+$/, '') || '/');
  if (clean === '/pay' || clean.startsWith('/pay/')) return '/pay';
  if (clean === '/decisions' || clean.startsWith('/decisions/')) return '/decisions';
  if (clean === '/docs' || clean.startsWith('/docs/')) return '/docs';
  if (clean === '/dashboard') return '/overview';
  if (clean === '/assets') return '/money';
  if (clean === '/agent' || clean === '/automation') return '/agents';
  if (clean === '/governance' || clean === '/votes') return '/decisions';
  if (clean === '/policy') return '/rules';
  if (clean === '/team') return '/settings';
  return clean;
}

/** Load a route's code before the click so the page can paint without a spinner. */
export function prefetchAppRoute(path: string) {
  const key = prefetchKey(path);
  const load = loaders[key];
  if (!load || started.has(key)) return;
  started.add(key);
  void load().catch(() => {
    started.delete(key);
  });
}

export function prefetchAppRoutes(paths: readonly string[]) {
  for (const path of paths) prefetchAppRoute(path);
}
