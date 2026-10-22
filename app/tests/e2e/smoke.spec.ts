import { test, expect } from '@playwright/test';

/**
 * Minimal smoke: no WalletConnect flows. Requires a bootable Vite env
 * (typically `.env.local` from `.env.example`); otherwise pages may error at
 * load — we skip when core vars are missing.
 */
function hasCoreViteEnv(): boolean {
  const coreOk =
    !!process.env.VITE_NAVE_CORE_PROGRAM_ID?.trim() &&
    !!process.env.VITE_SUPABASE_URL?.trim() &&
    !!process.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!coreOk) return false;

  // When any EVM factory is configured, the app requires VITE_WALLETCONNECT_PROJECT_ID
  // at boot-time (programConfig.ts hard throws). Treat this as a required env for any
  // test that hits a live app page in EVM mode.
  const evmFactory = !!(
    process.env.VITE_EVM_SEPOLIA_FACTORY_ADDRESS?.trim() ||
    process.env.VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS?.trim() ||
    process.env.VITE_EVM_ETHEREUM_FACTORY_ADDRESS?.trim() ||
    process.env.VITE_EVM_BASE_FACTORY_ADDRESS?.trim()
  );
  if (evmFactory && !process.env.VITE_WALLETCONNECT_PROJECT_ID?.trim()) return false;

  return true;
}

function evmUiLikelyEnabled(): boolean {
  const hasFactory = !!(
    process.env.VITE_EVM_SEPOLIA_FACTORY_ADDRESS?.trim() ||
    process.env.VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS?.trim()
  );
  const hasWc = !!process.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
  return hasFactory && hasWc;
}

test('home page responds', async ({ page }) => {
  test.skip(!hasCoreViteEnv(), 'Set VITE_NAVE_CORE_PROGRAM_ID, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (e.g. from .env.local)');
  const res = await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  expect(res?.ok() ?? false).toBeTruthy();
  await expect(page.getByRole('heading', { level: 1, name: /From treasury to treasure/i })).toBeVisible({
    timeout: 15_000,
  });
});

test('Create DAO shows chain family picker when EVM is configured', async ({ page }) => {
  test.skip(!hasCoreViteEnv(), 'Set core VITE_* vars (see .env.example)');
  test.skip(!evmUiLikelyEnabled(), 'Set VITE_EVM_*_FACTORY_ADDRESS and VITE_WALLETCONNECT_PROJECT_ID to assert ChainSelector');
  await page.goto('/create-dao', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Create a treasury' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Solana', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ethereum', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Base', exact: true }).first()).toBeVisible();
});

test('Create DAO review step requires connected wallet for selected chain', async ({ page }) => {
  test.skip(!hasCoreViteEnv(), 'Set core VITE_* vars (see .env.example)');
  await page.goto('/create-dao', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByPlaceholder('e.g. Solana Builders Collective').fill('E2E Review DAO');
  await expect(page.getByRole('button', { name: /Continue/i })).toBeDisabled();
});

test('Create DAO slug validation surfaces reserved names', async ({ page }) => {
  test.skip(!hasCoreViteEnv(), 'Set core VITE_* vars (see .env.example)');
  await page.goto('/create-dao', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByPlaceholder('nave').fill('admin');
  await expect(page.getByText(/reserved/i)).toBeVisible({ timeout: 8_000 });
});
