# FAQ & Glossary

Common questions and a plain-language glossary of the terms used throughout Nave and this portal.

## Frequently asked questions

### Is Nave live on mainnet?

No. Nave is currently a devnet beta. All activity runs against Solana devnet and no mainnet funds are involved. The on-chain programs have not completed a formal third-party audit, so treat every deployment as pre-mainnet hardening.

### Does connecting my wallet move any funds?

No. Connecting shares only your public address so the app can read your watchlist and show wallet-scoped views. Moving funds always requires an explicit, separate signature that you approve in your wallet.

### Who actually controls the treasury — the AI or the DAO?

The DAO. The on-chain programs and the ratified constitution are the final authority. AI agents are advisory: they can propose and review, but a transaction is only signed when it passes deterministic, on-chain-enforced guardrails. See [Risk & Controls](/docs/risk-and-controls).

### What happens if an AI agent makes a bad recommendation?

It is blocked before it can act. Every agent decision is checked against deterministic guardrails (confidence thresholds, allocation caps, liquidity floors, protocol allowlists, payload-hash matching) outside the model. A failing check stops signing regardless of what the model concluded.

### How are treasury values calculated?

From real on-chain balances priced with live market data. Values are not hand-entered. The accounting invariants that must hold for every treasury are documented in [Treasury Reconciliation](/docs/reconciliation).

### Can I build on top of Nave?

Yes. The on-chain programs are deployed to devnet with published program IDs, and the application reads state through documented patterns. Start with [Architecture](/docs/architecture) and [Integration](/docs/integration).

### Is there a token?

Yes — `$NAVE` ("Nave Shares"), fixed at a maximum supply of 500,000 and fully fair launched with no team allocation. It is staked (a recoverable $99-equivalent amount) to form a DAO, and used as voting weight where a DAO enables token governance. See [Tokenomics & Bridge](/docs/tokenomics).

### Does Nave only run on Solana?

No. Treasuries can be created on Solana, Ethereum, or Base. `$NAVE` is native to Solana and is represented on the supported EVM testnets (Sepolia, Base Sepolia) as WrappedNAVE, an ERC-20 moved by a dedicated bridge.

### How do I get test NAVE to try the bridge?

The Bridge page has a small devnet faucet: enter a Solana address that already holds at least 0.01 devnet SOL, and claim 0.1 NAVE. Limited to one claim per address, and separately one claim per IP address, every 24 hours.

### Is the bridge audited or mainnet-ready?

No. The bridge is a testnet-only "trusted-relayer" design: a relayer independently re-verifies every lock/burn before minting or releasing funds, but it has not been extended to mainnet or independently audited. Treat it with the same caution as the rest of the devnet beta — see [Product Maturity](/docs/product-maturity).

### Is my personal data exposed to other users?

No. Public, non-private DAO data is readable by anyone, but personal data such as watchlists is scoped to your wallet, and sensitive material such as agent keys is never client-readable. See [Row-Level Security](/docs/rls).

## Glossary

**Agent** — One of the AI roles (Executive, Financial, Operational, Oversight) that participates in proposing, reviewing, and executing treasury actions. Agents are advisory and cannot override on-chain rules.

**Allocation cap** — A constitution limit on how much of NAV may be deployed into a single protocol or strategy.

**Constitution** — The ratified, on-chain set of rules that bound what a treasury and its agents may do: approved protocols, caps, floors, thresholds, and cadences.

**CPI (Cross-Program Invocation)** — A Solana mechanism by which one program calls another. Nave uses CPIs to interact with external DeFi protocols.

**Bridge** — The mechanism that moves `$NAVE` between Solana and the supported EVM testnets, locking/burning on the source chain and minting/releasing on the destination chain via a trusted relayer.

**Deployed capital** — The portion of NAV currently working in strategies, as opposed to held as a liquid reserve.

**Devnet** — Solana's development network (and, by extension, Ethereum Sepolia / Base Sepolia for EVM treasuries). Tokens have no real-world value; it is used for testing and beta operation.

**DAO** — Decentralized Autonomous Organization. In Nave, the membership and governance model that owns and directs a treasury.

**Faucet** — The Bridge page's devnet utility that sends a small amount of test `$NAVE` (0.1 per claim) to a qualifying address, rate-limited per address and per IP.

**Guardrail** — A deterministic check, run outside the AI model, that must pass before a transaction is signed.

**Liquidity floor** — A constitution rule requiring a minimum share of NAV to remain liquid and undeployed.

**Moonlighting** — The governed wind-down lifecycle for a treasury: a passed proposal halts agents, a second bound proposal authorizes distribution to a recipient, and the DAO is then hidden until the founder restakes to reopen it.

**NAV (Net Asset Value)** — The total value of everything a treasury holds.

**$NAVE (Nave Shares)** — The protocol token. Fixed maximum supply of 500,000, fully fair launched with no team allocation, used for the recoverable DAO-formation stake and as voting weight where token governance is enabled.

**PDA (Program Derived Address)** — A deterministic on-chain account address controlled by a program rather than a private key. Nave uses PDAs for vaults and strategy escrows.

**Reasoning hash** — A deterministic fingerprint of an agent's decision artifacts, committed on-chain so reasoning can be audited and replayed.

**Reconciliation** — The process of verifying that a treasury's reported NAV and deployed capital match the underlying on-chain balances.

**Signer service** — The relayer that decrypts an agent key per request and submits the approved on-chain transaction. It holds no keys on disk. It also hosts the public-but-verifying bridge and faucet endpoints.

**Vault** — The on-chain account that custodies a treasury's primary assets.

**WrappedNAVE** — The ERC-20 representation of `$NAVE` on Ethereum/Base, minted and burned exclusively by the bridge relayer's key.

## Where to go next

- A guided first session: [Getting Started](/docs/getting-started).
- The full screen tour: [Using Nave](/docs/using-nave).
- The token, the bridge, and the faucet: [Tokenomics & Bridge](/docs/tokenomics).
