import { defineConfig, devices } from '@playwright/test';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local (gitignored dev secrets) so hasCoreViteEnv() guards work in
// the test-runner process, exactly as Vite sees them during dev server startup.
dotenvConfig({ path: path.resolve(__dirname, '.env.local'), override: false });
dotenvConfig({ path: path.resolve(__dirname, '.env'), override: false });

/**
 * E2E smoke tests. The dev server loads Vite env from `.env` / `.env.local` on
 * disk (see runbook). Override the served URL with PLAYWRIGHT_BASE_URL to point
 * at an already-running server (CI or manual).
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
