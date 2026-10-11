# FAQ & Glossary

Common questions and a plain-language glossary of the terms used throughout Nave and this portal.

## Frequently asked questions

### Is Nave live on mainnet?

No. Public beta runs on Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet. No mainnet funds are involved. The programs and contracts have no published third-party audit. Mainnet create stays refused while the closed Solana bridge cannot redeem locked NAVE for wNAVE. Do not lock or redeem against program `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`.

### Does connecting my wallet move any funds?

No. Connecting shares only your public address so the app can read your watchlist and show wallet-scoped views. Moving funds always requires an explicit, separate signature that you approve in your wallet.

### Who actually controls the treasury — the AI or the DAO?

The DAO. The on-chain programs and the ratified constitution are the final authority. Agents watch and review. A transaction is signed only when it passes deterministic guardrails, and a second guardian is required to close a proposal. See [Risk & Controls](/docs/risk-and-controls).

### What happens if an AI agent makes a bad recommendation?

It is blocked before it can act. Every agent decision is checked against deterministic guardrails (confidence thresholds, allocation caps, liquidity floors, protocol allowlists, payload-hash matching) outside the model. A failing check stops signing regardless of what the model concluded. `NAVE_AUTOPROPOSE_ENABLED` stays false, so agents do not create proposals on their own.

### How are treasury values calculated?

From real on-chain balances priced with live market data. Values are not hand-entered. The accounting invariants that must hold for every treasury are documented in [Treasury Reconciliation](/docs/reconciliation).

### Can I build on top of Nave?

The programs are deployed on the five beta networks, and the application reads state through documented patterns. Start with [Architecture](/docs/architecture) and [Integration](/docs/integration). Treat every deployment as unaudited testnet software.

### Is there a token?

Yes — `$NAVE` ("Nave Shares"), fixed at a maximum supply of 500,000 and fully fair launched with no team allocation. Forming a treasury does not require `$NAVE`. There is no protocol formation fee and no NAVE or wNAVE creation stake on any chain. Where a DAO enables token governance, `$NAVE` (or that DAO's own governance token) is the voting weight. See [Tokenomics & Bridge](/docs/tokenomics).

### What does forming a treasury cost?

Network gas (and account rent) only. There is no protocol formation fee and no NAVE or wNAVE creation stake. A founder may deposit their own assets as a seed. That deposit is their capital, not a fee.

### What fee does the protocol take from a treasury?

The only protocol treasury fee is **15% of realized yield**: the gain above principal when a strategy position is withdrawn. Principal is not charged. Yield that is still deployed is charged when it is withdrawn. Frozen treasuries use the same 15%. There is no annual management fee. The bridge fee and token-mint fees are separate and are not a cost of forming a treasury.

### Which networks can create a treasury?

Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet. Yield a tester can use is Solana Jito, Sepolia Compound, and Base Sepolia Aave. Sepolia Aave is over the pool supply cap. Robinhood and Arc can create a treasury, deposit, and govern. They have no lending venue.

### How do I get testnet gas?

Use the site banner. **Network** selects the chain. **Faucet** opens a QuickNode faucet for Solana devnet SOL, Ethereum Sepolia ETH, Base Sepolia ETH, or Robinhood Testnet ETH. Arc gas is native USDC from Circle’s faucet. Arc treasury USDC is a separate 6-decimal token.

### Where can I earn yield?

Solana devnet: Jito. Ethereum Sepolia: Compound. Base Sepolia: Aave. Sepolia Aave is over the pool supply cap, so a Sepolia deposit does not go there. Robinhood Testnet and Arc Testnet have no lending venue. MarginFi, swaps, and autonomous compounding are not on.

### What do the four agents do?

In order: Executive, Financial, Operational, Oversight. Operational is the final signer. Its stored key is named oversight. Oversight monitors and does not sign. Its stored key is named operational. Leave those stored names as they are. Agents watch. They do not propose while `NAVE_AUTOPROPOSE_ENABLED` is false. New treasuries use a one-minute review window. Treasuries created before the timelock upgrade still have 24-hour delays. A second guardian is required to close a proposal.

### Is the bridge audited or mainnet-ready?

No. Do not lock or redeem NAVE against the closed Solana bridge `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. That program cannot redeem locked NAVE for wNAVE. The bridge design is a testnet trusted relayer and has no independent audit. See [Product Maturity](/docs/product-maturity).

### Is my personal data exposed to other users?

No. Public, non-private DAO data is readable by anyone, but personal data such as watchlists is scoped to your wallet, and sensitive material such as agent keys is never client-readable. See [Row-Level Security](/docs/rls).

## Glossary

**Agent** — One of four roles, in order: Executive, Financial, Operational, Oversight. Operational is the final signer (stored key oversight). Oversight monitors and does not sign (stored key operational). Agents are advisory and cannot override on-chain rules.

**Allocation cap** — A constitution limit on how much of NAV may be deployed into a single protocol or strategy.

**Constitution** — The ratified, on-chain set of rules that bound what a treasury and its agents may do: approved protocols, caps, floors, thresholds, and cadences. Quick setup writes Conservative: 60% stable, 40% deployed, 20% per venue, 25% liquid.

**CPI (Cross-Program Invocation)** — A Solana mechanism by which one program calls another. Nave uses CPIs to interact with external DeFi protocols.

**Bridge** — The designed mechanism that would move `$NAVE` between Solana and supported EVM chains by locking or burning on the source and minting or releasing on the destination through a trusted relayer. The Solana program `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6` is closed. Do not lock or redeem against it.

**Deployed capital** — The portion of NAV currently working in strategies, as opposed to held as a liquid reserve.

**Devnet / testnet** — The public beta networks: Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet. Tokens have no mainnet value.

**DAO** — Decentralized Autonomous Organization. In Nave, the membership and governance model that owns and directs a treasury.

**Faucet** — The **Faucet** menu on the site banner. It opens QuickNode for Solana devnet SOL, Ethereum Sepolia ETH, Base Sepolia ETH, and Robinhood Testnet ETH, and Circle’s faucet for Arc testnet USDC.

**Guardrail** — A deterministic check, run outside the AI model, that must pass before a transaction is signed.

**Liquidity floor** — A constitution rule requiring a minimum share of NAV to remain liquid and undeployed.

**Moonlighting** — The governed wind-down lifecycle for a treasury: a passed proposal halts agents, a second bound proposal authorizes distribution to a recipient, and the DAO is then hidden until the founder reopens it. Reopening does not require a new stake. An existing locked creation stake, from a treasury formed before this change, is still returned. New treasuries have nothing to return.

**NAV (Net Asset Value)** — The total value of everything a treasury holds.

**$NAVE (Nave Shares)** — The protocol token. Fixed maximum supply of 500,000, fully fair launched with no team allocation. It is not required to form a treasury. Where a DAO enables token governance, it can be the voting weight.

**PDA (Program Derived Address)** — A deterministic on-chain account address controlled by a program rather than a private key. Nave uses PDAs for vaults and strategy escrows.

**Reasoning hash** — A deterministic fingerprint of an agent's decision artifacts, committed on-chain so reasoning can be audited and replayed.

**Reconciliation** — The process of verifying that a treasury's reported NAV and deployed capital match the underlying on-chain balances.

**Review window** — The wait between approval and execution. New treasuries use one minute. Treasuries created before the timelock upgrade still use 24 hours.

**Signer service** — The relayer that decrypts an agent key per request and submits the approved on-chain transaction. It holds no keys on disk.

**Vault** — The on-chain account that custodies a treasury's primary assets.

**WrappedNAVE** — The ERC-20 representation of `$NAVE` on Ethereum and Base. Forming a treasury does not stake it. Do not mint it by locking NAVE in the closed Solana bridge.

## Where to go next

- A guided first session: [Getting Started](/docs/getting-started).
- The full screen tour: [Using Nave](/docs/using-nave).
- The token and the closed bridge: [Tokenomics & Bridge](/docs/tokenomics).
