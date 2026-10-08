# Nave EVM Indexer

A viem-based polling worker that reads Nave contract logs on **Ethereum and
Base** (mainnets `1` / `8453` and testnets **Sepolia** `11155111` / **Base
Sepolia** `84532`), normalizes them to the canonical Nave event names, and
forwards batches to the shared **`index-events`** Supabase edge function — the
same pipeline Helius feeds for Solana.

> Scope: **Ethereum + Base only.** There is no BSC/Polygon/Arbitrum pipeline.
> Helius remains the Solana indexer; this worker is EVM-only.

## Why polling (and not a provider webhook)

`getLogs` polling is:

- **Provider-agnostic** — works with Alchemy, Ankr, or any JSON-RPC. No vendor
  webhook lock-in and no public ingress to secure.
- **Resumable** — the last processed block is persisted per chain in the
  `evm_indexer_cursors` table, so restarts/crashes resume cleanly.
- **Idempotent** — `index-events` dedups by `tx_signature = ${txHash}:${logIndex}`,
  so a small re-scan overlap on restart inserts nothing twice.

An Alchemy/Ankr webhook handler could be added later for lower latency, but the
poller is the simplest robust default and is what ships here.

## How it works

1. For each chain with an RPC URL configured, read the cursor (`evm_indexer_cursors`).
   First run seeds at the chain head (set `NAVE_EVM_START_BLOCK_<id>` to backfill).
2. `getLogs` from `cursor+1` to `head - EVM_CONFIRMATIONS`, in `EVM_LOG_CHUNK_BLOCKS`
   spans, **topic-filtered** by the Nave event signatures (see `src/events.ts`).
   Optionally restrict to a contract allowlist via `NAVE_EVM_WATCH_ADDRESSES_<id>`.
3. Decode each log, map its Solidity event name → the canonical Nave event name
   (`EVENT_META` in `src/events.ts`), extract the DAO address / actor / agent role.
4. POST batches (≤500) to `index-events` with `{ chain, chain_id }`.
5. Advance the cursor only after a successful forward.

## Event ABI

`src/events.ts` ships default event signatures mirroring the intended
`NaveDAOFactory` / `NaveTreasury` / `NaveGovernor` / `NaveExecution` events.
**Once the Solidity contract events are finalized, set `NAVE_EVM_ABI_PATH`** to a
synced ABI JSON (array of ABI items) to override the defaults without code
changes. Keep `EVENT_META` in sync with the canonical names the `index-events`
function routes on (`TREASURY_EVENTS` / `AGENT_EVENTS` sets).

## Run

```bash
cp .env.example .env   # fill Supabase + NAVE_INDEXER_SECRET + RPC URLs in `.env` (gitignored)
npm install
npm run typecheck
npm start              # or: npm run dev
```

Do **not** put production secrets in the tracked `.env.example` — keep that file
as a template only. Real values belong in **`evm-indexer/.env`** (ignored by the
repo root `.gitignore`).

From the repo root, run read-only multichain checks with merged indexer + Vite
env:

`node scripts/merge-evm-indexer-env.mjs -- npm run verify:devnet-multichain`

Deploy as a long-running worker (Railway Dockerfile included). It is independent
of `signer-service`; run both.
