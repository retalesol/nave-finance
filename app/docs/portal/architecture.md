# Architecture

A developer-oriented overview of how Nave fits together. The goal is to give you an accurate mental model before you read the instruction-level reference in [Alignment Verification](/docs/alignment).

## System at a glance

Nave spans four cooperating layers: a web client, an off-chain application backend, a signing relayer, and the on-chain programs that are the final authority. The on-chain layer itself is **multi-chain**: Solana (Anchor) for the original treasury programs, plus Solidity contracts on Ethereum and Base for EVM-native treasuries.

```
  Web client (React + TypeScript, Vite)
     │  reads + user-signed txs            ▲
     │                                     │ agent-signed txs
     ▼                                     │
  Solana programs (Anchor, devnet) ──┐     │
  EVM contracts (Solidity, testnets) ─┤     │
     │  emits events                 │     │
     ▼                               │     │
  Helius webhook (raw logs, Solana)  │     │
  EVM event indexer (Ethereum/Base)  │     │
     │  events                       │     │
     ▼                               │     │
  Application backend  ◀── off-chain reads ─┘
  (Supabase: Postgres + edge functions)
     │  POST /sign, /relay-evm, /bridge-relay, /faucet-claim
     ▼
  Signer service (Node relayer)
```

## The four layers

### Web client

A React + TypeScript single-page app built with Vite. It uses a wallet adapter for user-signed transactions, reads on-chain state through Anchor clients, and reads off-chain metadata and indexed history through the backend. The client renders treasury state but is never the source of truth.

### Application backend

Supabase provides Postgres plus Deno edge functions. The functions handle event indexing, treasury valuation, DAO metadata, and AI-agent orchestration. Notable functions:

| Function | Purpose |
| --- | --- |
| `helius-webhook` | Decodes Anchor events from raw logs and forwards them. |
| `index-events` | Deduplicates by transaction signature, writes activity, triggers snapshots. |
| `snapshot-treasury` | Values the treasury from real balances and live pricing. |
| `agent-dispatcher` | Runs a single agent's reasoning step. When a GenLayer session is configured, it submits the charter case for that execution request. |
| `agent-orchestrator` | Walks the approval pipeline and calls the signer. |
| `genlayer-adjudicator` | Submits and refreshes a GenLayer review. It does not sign a treasury transaction. |

### Signer service

A Node relayer that submits agent transactions. It holds no keys on disk: it decrypts the specific agent key it needs per request, signs, submits, and discards the material. This is the boundary where an approved decision becomes an on-chain transaction.

The same service also hosts two **public-but-verifying** endpoints that the browser calls directly (no signer secret involved, since a browser cannot hold one):

| Endpoint | Purpose |
| --- | --- |
| `/bridge-relay` | Independently re-verifies a Solana lock or EVM burn, then mints WrappedNAVE or releases NAVE on the destination chain. |
| `/faucet-claim` | Sends 0.1 devnet NAVE to a caller-supplied address, gated by a minimum-SOL-balance check and dual address+IP rate limiting. |

Both endpoints trust the on-chain transaction they independently observe, not the caller's claim — see [Tokenomics & Bridge](/docs/tokenomics) for the bridge's trust model.

### On-chain programs and contracts

**Solana (Anchor)** programs deployed to devnet are the final authority for Solana-native treasuries. They enforce the constitution, allocation caps, the liquidity floor, the review window, and strategy accounting.

**Ethereum and Base (Solidity)** contracts mirror the same authority model for EVM-native treasuries: a factory deploys per-DAO treasury, governor, and execution clones, with the same separation between proposing, approving, and executing.

Off-chain components can propose and approve, but in both cases the on-chain code decides what is allowed.

## Deployed devnet program IDs (Solana)

| Program | ID |
| --- | --- |
| `nave_core` | `8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB` |
| `nave_governance` | `CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M` |
| `nave_execution` | `2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb` |
| `jito` adapter | `E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT` |
| `kamino` adapter | `B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD` |
| `marginfi` adapter | `Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7` |

## Deployed testnet contracts (EVM)

Create a treasury on Base or Robinhood. Solana and Ethereum stay on Bridge and Stake. The testnet DAO stack below is Sepolia and Base Sepolia; Robinhood testnet has no DAO factory yet. `WrappedNAVE` is the bridge's wrapped representation of the Solana-native NAVE SPL token; its mint/burn authority is held solely by the signer service's bridge relayer key.

| Contract | Sepolia (11155111) | Base Sepolia (84532) |
| --- | --- | --- |
| `NaveProtocol` | `0x678e69c53E53904ca6D060040E14DFc56003BC11` | `0x9BdE2F925fb71bDfC3EA0F0F9617786b5a642F02` |
| `NaveDAOFactory` | `0x4C8dBdEaa7f5B043dB9A8831023b67994Dc2cb36` | `0x50693cB4DcF581b1FbfAA3138A21e81579d192C9` |
| `WrappedNAVE` | `0x263dAf1D30A177DE10B0525653DAAbAad268104C` | `0xa2DF37f136CA9eaFBA2c3D3D84834E5cb0113B1F` |

`NaveTreasury`, `NaveGovernor`, and `NaveExecution` are deployed per-DAO as clones from `NaveDAOFactory` rather than as fixed singleton addresses — resolve them at runtime from a DAO's factory record.

## How data flows

1. A user or agent action produces an on-chain transaction.
2. **Solana:** the programs emit events; Helius delivers raw logs to the webhook. **EVM:** a dedicated EVM indexer service polls Ethereum/Base for the same class of events.
3. `index-events` decodes and deduplicates, writing activity and updating registries.
4. `snapshot-treasury` recomputes valuation, event-driven and on a periodic schedule.
5. The client reads both on-chain accounts and the indexed history to render state.

Indexing is idempotent: redelivered transactions are skipped by signature/hash, and balances self-heal on the next scheduled snapshot even if a webhook delivery or poll is missed.

## Where the source of truth lives

- **Value and limits:** on-chain accounts and program logic.
- **History and metadata:** the indexed Postgres tables.
- **Display:** the client, derived from the two above.

There is no authoritative off-chain ledger of balances; the chain is canonical and the index is a reproducible projection of it.

## Where to go next

- Connect to it: [Integration](/docs/integration).
- Run it locally and contribute: [Contributing](/docs/contributing).
- Instruction-level alignment: [Alignment Verification](/docs/alignment).
- The bridge relayer's trust model and the token it moves: [Tokenomics & Bridge](/docs/tokenomics).
