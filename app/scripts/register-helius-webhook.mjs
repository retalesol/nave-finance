#!/usr/bin/env node
/**
 * Register (or update) a Helius webhook that streams RAW transactions for the
 * all six Nave program IDs (core + adapters) to the `helius-webhook` Supabase edge function.
 *
 * RAW (not enhanced) is required: the handler decodes Anchor `Program data:`
 * lines from `meta.logMessages`, which enhanced payloads do not expose for
 * custom programs.
 *
 * Required env:
 *   HELIUS_API_KEY        Helius API key
 *   WEBHOOK_URL           Public URL of the helius-webhook function
 *                         e.g. https://<project>.supabase.co/functions/v1/helius-webhook
 *   NAVE_INDEXER_SECRET   Shared secret; sent as the webhook Authorization header
 *
 * Optional env:
 *   HELIUS_NETWORK        'devnet' (default) | 'mainnet'
 *   NAVE_CORE_PROGRAM_ID, NAVE_GOVERNANCE_PROGRAM_ID, NAVE_EXECUTION_PROGRAM_ID
 *   NAVE_JITO_ADAPTER_PROGRAM_ID, NAVE_KAMINO_ADAPTER_PROGRAM_ID, NAVE_MARGINFI_ADAPTER_PROGRAM_ID
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const NAVE_INDEXER_SECRET = process.env.NAVE_INDEXER_SECRET;
const HELIUS_NETWORK = (process.env.HELIUS_NETWORK || 'devnet').toLowerCase();

if (!HELIUS_API_KEY || !WEBHOOK_URL || !NAVE_INDEXER_SECRET) {
  console.error('Missing env: HELIUS_API_KEY, WEBHOOK_URL, NAVE_INDEXER_SECRET are required.');
  process.exit(1);
}

const programIds = [
  process.env.NAVE_CORE_PROGRAM_ID || '8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB',
  process.env.NAVE_GOVERNANCE_PROGRAM_ID || 'CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M',
  process.env.NAVE_EXECUTION_PROGRAM_ID || '2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb',
  process.env.NAVE_JITO_ADAPTER_PROGRAM_ID || 'E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT',
  process.env.NAVE_KAMINO_ADAPTER_PROGRAM_ID || 'B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD',
  process.env.NAVE_MARGINFI_ADAPTER_PROGRAM_ID || 'Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7',
];

// Devnet raw webhooks use the `rawDevnet` type; mainnet uses `raw`.
const webhookType = HELIUS_NETWORK === 'mainnet' ? 'raw' : 'rawDevnet';

const body = {
  // Header-only auth: the function no longer accepts a ?secret= query param
  // (query strings leak into access logs). Helius sends `authHeader` as the
  // Authorization header, which the function validates constant-time.
  webhookURL: WEBHOOK_URL,
  transactionTypes: ['Any'],
  accountAddresses: programIds,
  webhookType,
  authHeader: NAVE_INDEXER_SECRET,
};

const endpoint = `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;

const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const data = await res.json();
if (!res.ok) {
  console.error('Failed to create webhook:', data);
  process.exit(1);
}

console.log('Helius webhook registered:');
console.log(`  webhookID: ${data.webhookID}`);
console.log(`  network: ${HELIUS_NETWORK} (type: ${webhookType})`);
console.log(`  accountAddresses: ${programIds.join(', ')}`);
