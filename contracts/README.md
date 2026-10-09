# Nave contracts

Product overview, deploy order, and agent operations are in the repository root [`README.md`](../README.md). This file is the contract layout.

## Chains

Solana programs are in `solana/`. EVM contracts share one Foundry codebase in `evm/` and are deployed per chain:

| Folder | Chain id | Network |
| --- | --- | --- |
| `ethereum/mainnet` | 1 | Ethereum |
| `ethereum/sepolia` | 11155111 | Ethereum Sepolia |
| `base/mainnet` | 8453 | Base |
| `base/sepolia` | 84532 | Base Sepolia |
| `robinhood/mainnet` | 4663 | Robinhood Chain |
| `robinhood/testnet` | 46630 | Robinhood Chain Testnet |

Each EVM chain folder holds that network's deployment JSON and broadcast logs. Do not copy private keys into those files.

## GenLayer

`genlayer/` holds the review contracts: `charter_adjudicator.py`, `venue_watch.py`, and `halt_appeal.py`. They judge a proposed move for Solana, Ethereum, Base, and Robinhood. They do not hold treasury tokens and they cannot call the programs in `solana/` or `evm/`.

The operator boundary, the member wording, and the env vars are in [`app/docs/GENLAYER.md`](../app/docs/GENLAYER.md). The three gate flags default off. A finished review can stop a signature. It cannot approve a transfer.

```bash
genvm-lint check genlayer/charter_adjudicator.py
genvm-lint check genlayer/venue_watch.py
genvm-lint check genlayer/halt_appeal.py
pytest genlayer/tests/direct -v
```

## Commands

From this directory:

```bash
npm ci
npm run test:unit
cd evm && forge test
```

`package.json` scripts call the Solana package in `solana/`.
