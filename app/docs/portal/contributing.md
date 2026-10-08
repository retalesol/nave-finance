# Contributing

How to run Nave locally and the conventions to follow when changing it. This page covers the application repository (frontend plus application backend); the on-chain programs live in a separate workspace.

## Prerequisites

- Node.js 20+.
- A Solana wallet (Phantom or Solflare) set to devnet.
- A devnet RPC endpoint.
- Access to a Supabase project for the backend pieces.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the required values
npm run dev                  # start the Vite dev server
```

All client-exposed environment variables are prefixed for the build tool. The required values and their meaning are described in the application README and in [Secrets Inventory](/docs/secrets). Never commit real secrets; the example file documents the shape, not the values.

## Build and type-check

```bash
npm run typecheck   # type-check only
npm run build       # type-check, then production build
```

The production build is gated on the type-check, so a type regression fails the build. This keeps the deployable artifact honest.

## Project layout

This portal's repository is the **application** (frontend + application backend + signer). The Solana programs and the EVM Solidity contracts each live in their own workspace.

```
src/                React frontend
  lib/              program config, Supabase/edge-function clients, chain/bridge/faucet clients
  lib/bridge/       bridge route resolution, Solana lock helper, relayer client
  lib/evm/          EVM address resolution, wagmi config, writers/readers
  hooks/            on-chain and Supabase data hooks (incl. useBridge)
  components/       shared UI (incl. NaveWalletModal, NaveFaucetModal, DevnetBanner, BridgeFaucetBanner)
  pages/            application screens (Dashboard, Agent, Governance, Bridge, Settings, ...)
  idl/              Anchor IDLs (source of truth for Solana clients)
supabase/
  functions/        Deno edge functions
  migrations/       SQL migrations (incl. bridge_transfers, faucet_claims)
signer-service/     Node signer/relayer (hosted separately)
  src/bridgeRelayer.ts    Bridge verify + mint/release logic
  src/faucetRelayer.ts    Faucet send + balance-check logic
  src/solanaTxUtils.ts    Shared Solana keypair parsing + confirmation helpers
  src/rateLimit.ts        Distributed rate limiter (Redis/in-memory) + circuit breaker
contracts/evm/      Solidity contracts (Ethereum/Base) — separate Foundry workspace
contracts/solana/    Anchor programs (Solana) — separate workspace
docs/               design, alignment, and portal content
```

## Conventions

- **IDLs are canonical for clients.** After any on-chain program change, refresh the committed IDLs so decoders stay in sync. Stale IDLs are a leading cause of subtle decode bugs.
- **Keep the index idempotent.** Anything that ingests on-chain events must deduplicate by transaction signature.
- **Respect the trust boundary.** Browser code reads; privileged writes happen server-side. Do not move secret-bearing logic into the client.
- **Mocks off for anything public.** Demo data must be disabled in public builds so a treasury never shows bundled placeholder values.
- **Keep docs in sync with reality.** Canonical docs describe the system as it is, not as planned. If behavior changes, update the relevant reference page.

## Testing and gates

A guardrails evaluation harness exercises known-good and known-bad agent scenarios and must reject the bad ones before signing. Broader app-level test automation and CI gates are part of the path to mainnet rather than complete today; see [Product Maturity](/docs/product-maturity) for honest status.

## The on-chain workspaces

The Anchor programs are developed and tested in their own workspace, with a scenario and integration test harness and separate localnet and devnet paths. The instruction surface that this application depends on is documented in [Alignment Verification](/docs/alignment).

The EVM contracts (Ethereum/Base) live in a separate Foundry workspace with their own deploy scripts and test suite. Both program-upgrade rules and EVM-contract changes follow the same discipline: an existing deployed program/contract is **upgraded in place** with its existing ID/address preserved — never silently redeployed under a new identity.

## Where to go next

- The big picture: [Architecture](/docs/architecture).
- Connect external code: [Integration](/docs/integration).
- Operational procedures: [Operational Runbooks](/docs/runbooks).
