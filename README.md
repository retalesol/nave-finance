# Nave Finance

Monorepo for the Nave Finance application and its on-chain contracts.

## Layout

| Path | What it is |
| --- | --- |
| `app/` | Web app, signer service, Supabase edge functions, and the EVM indexer |
| `contracts/solana/` | Anchor programs (Solana) |
| `contracts/evm/` | Shared Foundry project: Solidity source, tests, and deploy scripts |
| `contracts/ethereum/` | Ethereum mainnet and Sepolia deployment records |
| `contracts/base/` | Base mainnet and Base Sepolia deployment records |
| `contracts/robinhood/` | Robinhood Chain mainnet and testnet deployment records |

EVM address manifests and Foundry broadcast logs live in the chain folder they belong to. `contracts/evm/deployments` and `contracts/evm/broadcast` symlink to those folders so Forge still runs from one project.

## Secrets

Signing keys, mnemonics, service-role keys, and RPC URLs that contain API keys are not in this repository. Put them in gitignored `.env` files or the host's secret store.

- Copy `app/.env.example` to `app/.env.local`.
- Solana deploy wallets stay in gitignored files next to `contracts/solana/` (`.deploy-wallet*`, `.staking-collector*`).
- Foundry RPC endpoints are read from environment variables (`ETH_MAINNET_RPC_URL`, `BASE_MAINNET_RPC_URL`, and the rest listed in `contracts/evm/foundry.toml`).

## Build

```bash
# App
cd app && npm ci && npm run typecheck

# Solana programs
cd contracts && npm ci
cd solana && cargo test --workspace

# EVM contracts
cd contracts/evm && forge test
```

Vercel should use `app` as the project root. GitHub Actions workflows live in `.github/workflows` at the repository root.
