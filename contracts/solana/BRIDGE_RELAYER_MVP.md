# NAVE Bridge — Implementation Decision (Phase 1: Bridge Foundation)

This document records the bridge approach chosen for the `bridge-build` todo and
the rationale, fee handling, scope, and the components that were shipped.
It complements (does not replace) [`BRIDGE_NTT_FEE_VALIDATION.md`](./BRIDGE_NTT_FEE_VALIDATION.md),
which validated the fee math and set the Wormhole-vs-relayer decision gate.

## Decision: Nave-owned trusted relayer (MVP, testnet only)

**Chosen:** a Nave-controlled trusted relayer, scoped to testnet
(Solana devnet ↔ Ethereum Sepolia `11155111` ↔ Base Sepolia `84532`).

**Not chosen (deferred):** Wormhole NTT Executor route.

### Why

The foundation set an explicit decision gate (see `BRIDGE_NTT_FEE_VALIDATION.md`,
"Dependency Notes"): use Wormhole NTT *if* the installed SDK exposes the typed
referrer/payee fee path for NTT Executor transfers; otherwise ship the
trusted-relayer MVP and keep 2% fee capture in relayer-controlled logic.

Re-checking the actual installed dependencies before coding the fee path:

- **No Wormhole/NTT package is installed in any repo.** `@wormhole-foundation/sdk`,
  the NTT route package, `ntt-cli`, and `@wormhole-foundation/wormhole-connect`
  are absent from `solana/package.json`, the repo-root `package.json`,
  `evm` (Foundry submodules are only OpenZeppelin / forge-std /
  chainlink / pyth), and `nave-app` (`package.json` + lockfile).
- The foundation doc already found that the **bare** `@wormhole-foundation/sdk`
  NTT helper does **not** expose a typed referrer-fee argument; the 2% payee fee
  is only validated for the heavier **Connect/Executor** route.
- Standing up Wormhole NTT in lock mode on Solana additionally requires deploying
  the audited NTT manager program + custody/config PDAs via the `ntt` CLI and
  registering peer managers on each EVM chain — a live, multi-chain on-chain
  deployment that cannot be captured cleanly inside a single buildable todo, and
  whose Executor fee wiring still needs live validation.

So, per the gate, the installed stack "cannot capture a 2% payee fee cleanly"
today → we ship the trusted-relayer MVP. This captures the 2% fee under full
Nave control, works with the already-installed stack (web3.js/spl-token on
Solana, viem/wagmi on EVM, the existing `signer-service` relayer pattern, and the
`evm-indexer`), and adds **no new heavy dependencies**.

The Wormhole NTT path remains the intended production architecture; the fee math,
config keys, and wrapped-token shape here are deliberately NTT-compatible so the
relayer can later be swapped for an NTT manager without reworking the app/config.

## Architecture (trusted-relayer MVP)

Solana is the home chain. NAVE locks/releases on Solana; a wrapped ERC-20
(`WrappedNave`, 6 decimals to match the SPL mint) mints/burns on each EVM testnet.

```
Solana → EVM (lock):
  user --SPL transfer NAVE--> custody token account (Nave-owned)
  relayer verifies lock --> mint WrappedNave(net) to user on EVM
                        --> mint WrappedNave(fee=2%) to Nave EVM fee wallet

EVM → Solana (release):
  user --burn WrappedNave--> (BridgeBurn event)
  relayer verifies burn  --> transfer NAVE(net) from custody to user ATA
                         --> transfer NAVE(fee=2%) from custody to Nave Solana fee wallet
```

The relayer's security model is **independent on-chain verification of the source
transaction** (the lock transfer into custody, or the burn event on the wrapped
token) before it performs the destination mint/release. The `/bridge-relay`
endpoint is therefore callable by the public web app without holding a shared
secret; it never trusts client-supplied amounts.

## Fee handling

- Bridge fee: **2% = 200 bps = 2000 dbps** (`NAVE_BRIDGE_FEE_BPS` / `_DBPS`).
- The `dbps` form is retained for forward-compatibility with the Wormhole
  Executor `FeeArgs { uint16 dbps; address payee; }` shape.
- Fee is taken on every transfer and routed to a configured Nave fee wallet on
  the **destination** chain: the EVM fee wallet on Solana→EVM mints, the Solana
  fee wallet on EVM→Solana releases.
- `feeRaw = amountRaw * bps / 10000`, `netRaw = amountRaw − feeRaw`, computed in
  integer base units (6 decimals) on both the app and relayer.

**Status: implemented and active** in the trusted-relayer MVP (the relayer mints/
transfers `net` to the user and `fee` to the Nave fee wallet). It does not depend
on Wormhole Executor support.

## Components shipped

Contracts repo (`nave-contracts`):
- `solana/scripts/bridge-setup-relayer.mjs` — idempotent Solana custody
  setup; creates the NAVE custody token account + Nave fee-wallet ATA and writes
  a `bridge` block into `deployments/devnet.json`. `--dry-run` supported.
- `solana/package.json` + root `package.json` — `bridge:setup` /
  `bridge:setup:dry` scripts (alongside `bridge:validate-fee`).
- `evm/src/WrappedNave.sol` — relayer-controlled wrapped NAVE ERC-20
  (mint/burn gated to the bridge manager/minter), `+ DeployWrappedNave.s.sol`
  (testnet-only) `+ WrappedNave.t.sol`.
- This document.

App repo (`nave-app`):
- `src/lib/programConfig.ts` — namespaced `bridge.*` config (relayer URL, custody,
  fee wallets, fee math helper).
- `src/lib/bridge/*`, `src/hooks/useBridge.tsx`, `src/pages/Bridge.tsx`, `/bridge`
  route + nav item.
- `signer-service` — `POST /bridge-relay` endpoint + `bridgeRelayer` (verify
  source, fee split, destination mint/release, `bridge_transfers` recording).
- `evm-indexer` — `BridgeMint` / `BridgeBurn` event indexing.
- `supabase/migrations/*` — `bridge_transfers` history table.

## Scope and non-goals

- **Testnet only.** Sepolia + Base Sepolia + Solana devnet. No mainnet bridge is
  enabled and `scripts/mainnet-cutover.mjs` is intentionally **not** modified —
  there is no mainnet bridge authority/verification change in this MVP. A mainnet
  bridge (Wormhole NTT) would add a cutover phase at that time.
- No custom Anchor program is added: lock is a plain SPL transfer into custody,
  release is an SPL transfer out signed by the Nave custody authority.
- Ownership boundary: only `bridge.*` config and bridge-specific files were
  touched. DAO creation, governance, the creation wizard, homepage pricing, and
  the price oracle were not modified.
