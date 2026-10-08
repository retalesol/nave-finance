# Integration

How to connect to Nave's on-chain and off-chain surfaces as a developer. This page assumes you have read [Architecture](/docs/architecture).

## Networks and program IDs

Nave runs on Solana devnet, plus Ethereum Sepolia and Base Sepolia for EVM-native treasuries and the bridge — no other EVM chain is supported. The canonical program/contract addresses are listed under "Deployed devnet program IDs" and "Deployed testnet contracts" in [Architecture](/docs/architecture); they can be overridden per deployment through environment variables when you run your own instance.

## Reading on-chain state

The application reads treasury state directly from Solana accounts using Anchor clients generated from the published IDLs. The IDLs are the source of truth for clients — if a program changes, the IDLs must be refreshed so clients decode accounts and events correctly. The instruction and account decode matrix used by the frontend and signer is documented in [Alignment Verification](/docs/alignment).

To read state you generally:

1. Resolve the relevant program-derived addresses (vaults, strategy escrows, treasury and position accounts) from their seeds.
2. Fetch the accounts over RPC.
3. Decode them with the matching IDL.

## Reading indexed history

For activity, valuations, and metadata you read the backend rather than replaying the chain yourself. The edge functions expose a small, purpose-built surface:

| Function | Use |
| --- | --- |
| `index-events` | Source of the activity feed; deduplicates by transaction signature. |
| `snapshot-treasury` | Treasury valuation, event-driven and scheduled. |
| `agent-health` | Agent status for dashboards. |

These functions use custom auth: callers present a shared secret rather than a user JWT. Public, no-auth health endpoints exist for uptime monitoring and never return secrets.

## Authentication model

- **Browser clients** act as an anonymous role and pass the connected wallet address as a soft scoping header. They can read public, non-private DAO data and their own wallet-scoped rows.
- **Server components** (edge functions, signer) use a privileged service role for writes.
- **Sensitive material** (agent keys) is never client-readable.

The complete access matrix by table and role is in [Row-Level Security](/docs/rls).

## The signing path

Agent transactions are not signed in the browser. The orchestrator evaluates a proposal, and only after guardrails pass does it call the signer service, which decrypts the needed key per request and submits the transaction. If you are integrating an automated actor, the same principle applies: signing authority is gated by deterministic checks, not by possession of a key alone. See [Risk & Controls](/docs/risk-and-controls).

## Public-but-verifying endpoints (bridge and faucet)

Two signer-service endpoints are deliberately callable directly by the browser, with no signer secret involved at all:

| Endpoint | Body | Behavior |
| --- | --- | --- |
| `POST /bridge-relay` | `{ direction, sourceChain, destChain, sourceTx, recipient, amountRaw? }` | Independently re-verifies `sourceTx` on-chain before minting WrappedNAVE or releasing NAVE — never trusts the caller's claim. A unique constraint on `sourceTx` makes replays idempotent. |
| `POST /faucet-claim` | `{ address }` | Checks the address holds a minimum devnet SOL balance, dual rate-limits by address and by caller IP (both must independently pass), then sends 0.1 devnet NAVE. |

Both are rate-limited and CORS-restricted to the configured frontend origins; neither requires nor accepts a privileged header. See [Tokenomics & Bridge](/docs/tokenomics) for the full mechanics and fee model.

## Event indexing contract

If you operate your own indexing:

- Configure a raw-logs webhook over the program IDs you care about.
- Authenticate via header, not a query string, so the secret is not recorded in request logs.
- Make ingestion idempotent — deduplicate by transaction signature — because deliveries can be retried.
- Treat scheduled snapshots as the self-healing backstop for any missed delivery.

## Configuration

Client-exposed configuration is environment-driven and prefixed for the build tool; server secrets live in the relevant runtime's secret store and are never shipped to the browser. The inventory of secrets, who consumes them, and how to rotate them is in [Secrets Inventory](/docs/secrets).

## Where to go next

- Run it locally: [Contributing](/docs/contributing).
- Instruction and account matrix: [Alignment Verification](/docs/alignment).
- Access boundaries: [Row-Level Security](/docs/rls).
- The bridge and faucet's trust model: [Tokenomics & Bridge](/docs/tokenomics).
