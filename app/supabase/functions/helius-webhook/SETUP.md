# Solana event delivery

The `helius-webhook` function decodes Anchor program events from raw transaction
logs and forwards them to `index-events`. The function name is historical. Live
delivery is a QuickNode Stream, not a Helius webhook.

## Live path — QuickNode Streams

Stream `nave-solana-devnet` (`d41f57ba-0909-417d-bbd3-81fcb6557b7a`) is active on
`solana-devnet`, dataset `programs_with_logs`, region `usa_east`. It posts to
`https://suiivgqwxvqjuxqsrdnu.supabase.co/functions/v1/helius-webhook` with
`Authorization: Bearer <NAVE_INDEXER_SECRET>`, compression off, and a filter
that forwards only transactions whose logs mention the six program IDs below.
The body is an array of `{ signature, slot, blockTime, logs }`.

Do not put the secret in the URL. The QuickNode platform API key stays in the
QuickNode dashboard; it is not a repo secret.

## Fallback — Helius raw webhook

The Helius plan has ended. Keep this only if a raw webhook is turned back on.
Enhanced webhooks do not expose `Program data:` log lines for custom programs.

## Option A — Helius Dashboard (manual)

In the **Configure Webhook** dialog:

| Field | Value |
| --- | --- |
| Network | `devnet` (or `mainnet` in production) |
| Webhook Type | **`raw`** (NOT enhanced) |
| Transaction Type(s) | `Any` |
| Webhook URL | `https://<project-ref>.supabase.co/functions/v1/helius-webhook` |
| Authentication Header | `Authorization: Bearer <NAVE_INDEXER_SECRET>` (or `X-Indexer-Secret`) |
| Account Addresses | all six program IDs below (core + adapters) |

Account addresses (Manage Addresses):

- `8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB` — nave_core
- `CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M` — nave_governance
- `2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb` — nave_execution
- `E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT` — nave_jito_adapter
- `B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD` — nave_kamino_adapter
- `Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7` — nave_marginfi_adapter

The handler accepts the secret via the `Authorization: Bearer` header or
`X-Indexer-Secret` only. Do **not** put the secret in the URL query string — it
leaks into access logs.

## Option B — Registration script

```bash
HELIUS_API_KEY=... \
WEBHOOK_URL=https://<project-ref>.supabase.co/functions/v1/helius-webhook \
NAVE_INDEXER_SECRET=... \
HELIUS_NETWORK=devnet \
node scripts/register-helius-webhook.mjs
```

## Required edge-function secrets

Set on the Supabase project (Functions → secrets):

- `NAVE_INDEXER_SECRET` — must match the value used in the webhook URL/header
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — for forwarding to `index-events`

## Verifying

After a Nave transaction lands, check the Helius dashboard webhook logs for a
`200` response, then confirm rows appear in `activity_logs`. The function
response includes `{ decoded, forwarded }` counts for quick debugging.

Canonical app-level setup guidance lives in `README.md` under "Helius webhook setup (raw logs)".
