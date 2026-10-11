# Nave app

This directory is the application half of the Nave Finance monorepo (frontend,
Supabase edge functions, signer service, and EVM indexer). Product overview,
deploy order, and agent operations are in the repository root
[`README.md`](../README.md).

Nave is an AI-agent-governed DAO treasury platform. DAOs deposit a treasury,
ratify a constitution, and four AI agents (Executive, Financial, Operational,
Oversight) propose, review, and execute on-chain treasury actions under hard
on-chain guardrails.

Solana DAO program ids checked in here are the devnet stack. DAO creation in
the app is wired for **Base** and **Robinhood Chain**. Ethereum, Base, and
Robinhood contracts are **unaudited**.

> **Status: unaudited, mixed networks.** Base and Robinhood Chain can create
> treasuries. Solana DAO programs in the checked-in IDs are devnet. The Solana
> mainnet `nave_bridge` / `nave_staking` deployment that locked NAVE is closed;
> wNAVE redeem is not available until a new bridge is paused-in and configured.
> Do not treat any chain as production-ready. A formal third-party audit has
> **not** been completed — see [Security & audit](#security--audit).

---

## Architecture

```
┌──────────────┐     deploy DAO / vote / deposit      ┌────────────────────┐
│  React app   │ ───────────────────────────────────▶ │  Solana devnet      │
│  (Vite/TS)   │ ◀─────────── reads state ──────────── │  Anchor programs    │
└──────┬───────┘                                        └─────────┬──────────┘
       │ off-chain metadata, reads                                │ emits events
       ▼                                                          ▼
┌──────────────────────────────────────────┐          ┌────────────────────┐
│  Supabase (Postgres + Deno edge funcs)    │ ◀──────── │  Helius webhook     │
│  • register-dao   • index-events          │  events   │  (raw logs)         │
│  • snapshot-treasury (pg_cron daily UTC)  │          └────────────────────┘
│  • agent-dispatcher / -orchestrator       │
│  • generate-agent-keys / agent-health     │
└──────┬─────────────────────────────────────┘
       │ POST /sign (X-Signer-Secret)
       ▼
┌──────────────────────────────────────────┐
│  Signer service (Node, hosted separately) │  decrypts agent keys, submits
│  signer-service/                          │  Anchor approval/halt/execute txs
└──────────────────────────────────────────┘
```

- **Frontend** (`src/`): React + TypeScript + Vite. Wallet adapter for
  signing, Supabase client for off-chain reads, Anchor clients for on-chain
  reads/writes.
- **Supabase edge functions** (`supabase/functions/`): Deno. Indexing, treasury
  valuation, DAO metadata registration, and AI-agent orchestration.
- **Signer service** (`signer-service/`): Node relayer that holds no keys on
  disk; it decrypts each agent's key from the DB per request and submits the
  on-chain transaction. See `signer-service/README.md`.

### Deployed devnet program IDs

| Program | ID |
| --- | --- |
| `nave_core` | `8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB` |
| `nave_governance` | `CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M` |
| `nave_execution` | `2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb` |
| `jito` adapter | `E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT` |
| `kamino` adapter | `B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD` |
| `marginfi` adapter | `Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7` |

---

## Prerequisites

- Node.js 20+
- A Solana wallet (Phantom/Solflare) set to **devnet**
- A Helius devnet RPC URL (used by the frontend, edge functions, and signer)
- A Supabase project (already provisioned for the beta)

---

## Frontend — local development

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev                  # Vite dev server
```

### Environment variables

All client-exposed vars must be prefixed with `VITE_`. See `.env.example`.

| Var | Required | Notes |
| --- | --- | --- |
| `VITE_SOLANA_RPC_URL` | yes | devnet Helius endpoint |
| `VITE_SUPABASE_URL` | yes | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | **not** hardcoded in source — must be set |
| `VITE_USE_MOCKS` | no | `true` renders the demo lobby with mock data |
| `VITE_NAVE_*_PROGRAM_ID` | no | override the canonical IDs above |
| `VITE_NAVE_PROTOCOL_FEE_WALLET` | yes (prod) | protocol revenue wallet. Receives the 15% yield skim. Forming a treasury does not pay this wallet a formation fee. |
| `NAVE_PROTOCOL_FEE_WALLET` | yes (deploy) | same wallet used by deploy/server-side tooling |

> The Supabase anon key is public by design, but it is intentionally read from
> the environment (not baked into `programConfig.ts`) so each deployment ships
> its own credentials. If it's missing, the app logs a warning and edge-function
> calls will be unauthenticated.

### Build & type-check

```bash
npm run typecheck   # tsc against tsconfig.typecheck.json
npm run build       # runs typecheck, then vite build (CI-safe)
```

`npm run build` is gated on `npm run typecheck`, so a type regression fails the
build. Use `npm run build:no-typecheck` only for quick local iteration.

---

## Supabase backend

Edge functions live in `supabase/functions/`. They use **custom auth**
(`verify_jwt` is disabled) — callers present a shared secret, so all functions
validate `NAVE_INDEXER_SECRET` / `NAVE_AGENT_SECRET` / signature proofs
themselves.

| Function | Purpose | Auth |
| --- | --- | --- |
| `helius-webhook` | Decodes Anchor events from Helius raw logs, forwards to `index-events` | `NAVE_INDEXER_SECRET` (header or `?secret=`) |
| `index-events` | Dedupes & inserts `activity_logs`, upserts `dao_registry`, triggers snapshots; on governance/agent events also POSTs `agent-orchestrator` `{ mode: "poll" }` | `NAVE_INDEXER_SECRET`, `NAVE_AGENT_SECRET` (poll hook) |
| `snapshot-treasury` | Real treasury valuation (SOL+USDC balances × live SOL price) | `NAVE_INDEXER_SECRET` |
| `register-dao` | Upserts off-chain DAO metadata after on-chain creation | wallet signature |
| `generate-agent-keys` | Creates & encrypts the 4 agent keypairs | wallet signature |
| `agent-dispatcher` | Runs one agent's reasoning step | `NAVE_AGENT_SECRET` |
| `agent-orchestrator` | Walks the approval pipeline and calls the signer | `NAVE_AGENT_SECRET` |
| `agent-health` | Agent status for the dashboard | — |

### Required edge-function secrets (Supabase dashboard → Edge Functions → Secrets)

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
NAVE_INDEXER_SECRET
NAVE_AGENT_SECRET
SOLANA_RPC_URL                 # devnet Helius
NAVE_USDC_MINT                 # devnet USDC mint for valuation
NAVE_SIGNER_URL                # public URL of the hosted signer service
NAVE_SIGNER_SECRET             # shared secret with the signer service
NAVE_EXEC_AES_KEY              # per-agent AES keys (from generate-agent-keys)
NAVE_FIN_AES_KEY
NAVE_OVER_AES_KEY
NAVE_OPS_AES_KEY
NAVE_PROTOCOL_FEE_WALLET       # protocol revenue wallet for the 15% yield skim (not a formation fee)
```

**Agent keys & signer crypto:** The supported layout is **`NAVE_MASTER_KEK`** on the signer plus rows in **`encrypted_agent_keys`** (see [`docs/SECRETS.md`](docs/SECRETS.md)). The per-role `NAVE_*_AES_KEY` names above are a legacy path; prefer the runbook in **SECRETS.md** when wiring new environments.

**Orchestration cadence:** **`agent-orchestrator`** is **not** on `pg_cron`. It runs when something POSTs it with `mode: "poll"` or `manual`: the **signer-service worker** on `ORCHESTRATOR_INTERVAL_MS` (see [`signer-service/README.md`](signer-service/README.md)), **`index-events`** (after indexing a batch that includes governance/agent pipeline hints — same event names as poll discovery, e.g. `ProposalFinalized`, `ExecutiveApprovedEvent`, `ConstitutionUpdated`), `orchestrator-proxy`, or app manual dispatch. Poll mode reads **Helius/index-events** `activity_logs.event_type` values, merges DAO hints from recent `agent_action_logs`, and the Governance UI triggers a **best-effort founder-gated poll** after a successful Solana constitution ratify. Constitution ratification alone still does not create execution requests — you need a strategy (or other) path that creates an ER for agents to advance.

### Treasury snapshots (scheduled)

`snapshot-treasury` is invoked two ways:

1. **Event-driven** — `index-events` calls it whenever a treasury-affecting
   event lands.
2. **Scheduled** — a `pg_cron` job runs it **once per 24 hours** (00:00 UTC) via `pg_net`,
   reading its secrets from Supabase Vault.

SOL price is fetched from CoinGecko and cached in `price_cache`; if the live
fetch fails, the last cached price is used so a snapshot never collapses to $0.

---

## Helius webhook setup (raw logs)

Create one webhook in the [Helius dashboard](https://dashboard.helius.dev/)
pointed at the deployed edge function:

- **Webhook URL:** `https://<project>.supabase.co/functions/v1/helius-webhook`
- **Webhook type:** `Raw`
- **Network:** `Devnet`
- **Authorization Header:** set this to the value of `NAVE_INDEXER_SECRET`.
  The function accepts the secret as an `Authorization` / `X-Indexer-Secret`
  header **or** a `?secret=` query param. **Prefer the header** — a `?secret=`
  query param is recorded in Supabase request logs.
- **Account addresses (watch all program IDs):**
  ```
  8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB   # nave_core
  CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M   # nave_governance
  2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb   # nave_execution
  E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT   # jito adapter
  B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD   # kamino adapter
  Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7   # marginfi adapter
  ```

Verify the function is reachable:

```bash
curl "https://<project>.supabase.co/functions/v1/helius-webhook?selftest=1"
```

### Idempotency & retries

Helius retries failed deliveries. `index-events` **deduplicates by
`tx_signature`** before inserting, so redelivered transactions are skipped
(`{"inserted":0,"skipped":N,"message":"All events already indexed"}`). If Helius
can't reach the webhook, balances still self-heal on the next scheduled
`snapshot-treasury` run.

---

## Signer service

The Node relayer that submits agent transactions is documented in
[`signer-service/README.md`](signer-service/README.md), including the Dockerfile
/ Railway config, required env vars, and how to verify the
`agent-orchestrator → signer` loop end-to-end on devnet.

---

## Monitoring

Lightweight, no-auth health checks (do not leak secrets) for uptime monitors:

```bash
curl "https://<project>.supabase.co/functions/v1/index-events?health=1"
curl "https://<project>.supabase.co/functions/v1/snapshot-treasury?health=1"
curl "https://<signer-host>/health"
```

Helius webhook auth is header-only (`Authorization: Bearer <NAVE_INDEXER_SECRET>`).
Do not put the secret in the URL query string.

### Devnet beta launch

See [`docs/BETA_LAUNCH.md`](docs/BETA_LAUNCH.md) (repo defaults vs **deployment**
checklist), [`docs/DEVNET_E2E_GATE.md`](docs/DEVNET_E2E_GATE.md), and the
consolidated status snapshot
[`docs/FINAL_SYSTEM_STATUS_2026-05-31.md`](docs/FINAL_SYSTEM_STATUS_2026-05-31.md).

```bash
npm run secrets:generate          # distinct NAVE_*_SECRET values
cd ../contracts/solana && npm run test:localnet -- --grep "beta-path"  # expire + escrow paths (localnet)
npm run beta:go-no-go             # ops readiness probe
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… DAO_ADDRESS=<dao> npm run verify:e2e-gate   # gate evidence verifier
```

For deeper debugging, read edge-function logs in the Supabase dashboard (Edge Functions → Logs).

---

## Security & audit

- **On-chain guardrails are the source of truth.** Off-chain agents can only
  propose/approve; the programs enforce thresholds, the constitution, and the
  review window. The signer holds no keys on disk — agent keys are encrypted at
  rest (AES-256-GCM) and decrypted per request.
- **No formal third-party audit has been completed.** Base and Robinhood Chain
  DAO creation is live and unaudited. Solana DAO programs shipped from this
  repo are devnet. The previous Solana mainnet NAVE bridge is closed, so locked
  NAVE cannot be redeemed for wNAVE until a replacement bridge is configured.
  Treat all program behavior as unaudited until a published audit says otherwise.

---

## Project layout

```
src/                      React frontend
  lib/                    program config, supabase + edge-function clients
  hooks/                  on-chain & Supabase data hooks
  pages/                  app screens (Dashboard, Agent, Governance, …)
  idl/                    Anchor IDLs (source of truth for clients)
supabase/
  functions/              Deno edge functions
  migrations/             SQL migrations
signer-service/           Node signer/relayer (hosted separately)
docs/                     additional design / alignment notes
```
