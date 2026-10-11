# Security & Trust

A consolidated view of how Nave earns trust, written for investors and decision-makers who need the security posture without reading every engineering reference. The deep technical pages are linked throughout.

## The core guarantee

Authority to move a treasury is decided by deterministic rules and on-chain invariants, not by an AI model or any single operator. The intelligence layer is advisory; the programs are authoritative. This is what lets an autonomous system be trusted with capital: being wrong is survivable because being wrong does not grant authority.

## Layers of protection

| Layer | What it protects against |
| --- | --- |
| Deterministic guardrails | An over-confident or manipulated model attempting an unsafe action. |
| Governance and review window | Unilateral or unreviewed actions. |
| On-chain invariants | Any off-chain component, compromised or buggy, exceeding policy. |
| Encrypted custody | Exposure or theft of signing keys. |

Each layer is independent; defeating one does not defeat the others. The mechanics are detailed in [Risk & Controls](/docs/risk-and-controls).

## Custody

Signing keys are encrypted at rest, and the signer service holds no keys on disk — it decrypts only the key it needs for a specific request, signs, submits, and discards the material. Key material is never exposed to the browser. Secret ownership, storage boundaries, and rotation procedures are documented in [Secrets Inventory](/docs/secrets).

## Data access

Public, non-private treasury data is readable by anyone, reinforcing transparency. Personal data such as watchlists is scoped to the owning wallet, and sensitive material is restricted to privileged server roles. The complete access matrix is in [Row-Level Security](/docs/rls).

## Auditability

Trust is reinforced by reproducibility:

- **Reconcilable value.** NAV and deployed capital must match underlying on-chain balances under defined invariants. See [Treasury Reconciliation](/docs/reconciliation).
- **Auditable decisions.** Each agent decision commits a reasoning hash on-chain, so reasoning can be recomputed and verified rather than taken on faith. See [Agent Fine-Tuning](/docs/fine-tuning).
- **Linkable history.** Activity is indexed from on-chain logs and linkable to transactions on a block explorer.

## Operational resilience

Operators retain break-glass controls including the ability to pause activity, and program upgrade authority is intended to sit behind a multisig. Incident response, key rotation, and recovery procedures are captured in [Operational Runbooks](/docs/runbooks).

## The bridge is a different trust model

The cross-chain bridge between Solana and EVM is deliberately called out separately because it does not share the same on-chain-invariant guarantee as the rest of the system. The design is a **trusted relayer**: a single relayer re-verifies a lock or burn before minting or releasing funds, and that relayer is a centralized component. The Solana program that accepted locks, `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`, is closed. Do not lock or redeem against it. Mainnet redeem is not live. See [Tokenomics & Bridge](/docs/tokenomics).

## Honest limitations

Trust requires candor about what is not yet done:

- **No completed third-party audit.** The on-chain programs, the EVM contracts, and the bridge relayer are unaudited. Public beta is Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet. No mainnet funds.
- **Hardening in progress.** CI coverage and the multisig and alerting rollout are tracked toward mainnet. Capital moves already fail closed through the constitution verdict before the signer. That gate is not an audit. GenLayer stays off.
- **Closed Solana bridge.** Do not lock or redeem NAVE against `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. The relayer design is a single trusted operator, not a program-enforced guarantee, and redeem on that program is not available.

These are stated openly because a security posture that hides its gaps is not a security posture. The full readiness picture is in [Product Maturity](/docs/product-maturity).

## Where to go next

- The mechanics: [Risk & Controls](/docs/risk-and-controls).
- Access boundaries: [Row-Level Security](/docs/rls).
- Readiness and roadmap: [Product Maturity](/docs/product-maturity).
