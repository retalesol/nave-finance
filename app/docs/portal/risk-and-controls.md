# Risk & Controls

Nave's central design claim is that the AI layer can be advisory without being dangerous, because the authority to sign a transaction is decided by deterministic rules and on-chain invariants rather than by the model. This page explains the layered controls that make that true.

## Defense in depth

```
AI model (advisory recommendation)
      ↓
Deterministic guardrails (outside the model)
      ↓
Governance (proposal + review window)
      ↓
On-chain invariants (final authority)
      ↓
Signed transaction
```

Each layer can independently stop an action. The model never has the last word.

## Layer 1 — Deterministic guardrails

Before any signing, a guardrail evaluation runs outside the model over the agent context and the model's structured output. Representative checks:

- **Role validity** — the acting role is recognized and permitted to sign.
- **Confidence threshold** — the model's confidence meets the constitution's minimum.
- **Decision consistency** — the decision is internally coherent (no approve-without-intent, no contradictory halt instructions).
- **Risk severity** — no severe, constitution-violating, payload-mismatch, or stale-state flags are present.
- **Snapshot freshness** — the treasury snapshot the decision relies on is recent enough.
- **Protocol allowlist** — the target protocol is constitution-approved.
- **Allocation cap** — the proposed deployment keeps the protocol within its cap.
- **Payload-hash equality** — the model's payload hash matches the hash bound on-chain.

A transaction is signed only when the evaluation passes **and** the role is a signing role **and** the model intended to sign. Any single failure blocks signing.

GenLayer stays off for this beta. The review runs only when `NAVE_GENLAYER_GATE` is the literal `true`, which it is not. A finished pass would not approve a transfer, and the review is not written back onto the treasury chain. The operator boundary is [`GENLAYER.md`](../GENLAYER.md).

## Layer 2 — Fail-closed posture

Guardrails can be configured to fail closed: if the context needed for a critical check is missing, the check fails and blocks signing rather than waving the action through. The mainnet end-state runs fully fail-closed, with the off-chain guardrails mirroring the on-chain invariants as redundant defense.

## Layer 3 — Governance and the review window

Proposals move through the DAO's governance model. A second guardian is required to close a proposal. New treasuries use a one-minute review window before execution. Treasuries created before the timelock upgrade still have 24-hour delays. During that window a proposal can be examined and, where applicable, halted.

The four roles, in order, are Executive, Financial, Operational, and Oversight. Operational is the final signer. Its stored key is named oversight. Oversight monitors and does not sign. Its stored key is named operational. Leave those stored names as they are. `NAVE_AUTOPROPOSE_ENABLED` stays false, so agents watch and do not create proposals.

## Layer 4 — On-chain invariants

The programs themselves enforce the limits, independent of anything off-chain:

- Per-protocol allocation caps.
- Global deployment cap.
- Liquidity floor.
- Strategy execution and withdrawal accounting.

Because these are enforced in the programs, they hold even if the off-chain stack misbehaves. An over-confident or compromised agent still cannot exceed a cap or breach a floor.

## Custody model

Agent keys are encrypted at rest and the signer service holds no keys on disk — it decrypts the specific key it needs per request, signs, and submits. Key material is never exposed to the browser. The access boundaries for every data table are documented in [Row-Level Security](/docs/rls), and secret ownership and rotation in [Secrets Inventory](/docs/secrets).

## Emergency controls

Operators retain break-glass controls — including the ability to pause activity — and program upgrade authority is intended to sit behind a multisig. The operational procedures for incidents, pausing, and key rotation are in [Operational Runbooks](/docs/runbooks).

## Integrity and auditability

Every agent decision produces a deterministic reasoning hash that is committed on-chain. Because the hash can be recomputed from the stored reasoning artifacts, any drift between what was decided and what was committed is detectable — useful for audit, replay, and post-incident review.

## What is still open

Public beta is Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet. The programs and contracts have no published third-party audit, and no mainnet funds are involved. Do not lock or redeem NAVE against the closed Solana bridge `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. MarginFi, swaps, and autonomous proposing stay off. Multisig upgrade rollout and CI coverage are tracked toward mainnet. Honest status is part of the control model; see [Product Maturity](/docs/product-maturity) and [Security & Trust](/docs/security-and-trust).

## Where to go next

- The rulebook these controls enforce: [Constitution & Policy](/docs/constitution-and-policy).
- The AI decision contract and eval harness: [Agent Fine-Tuning](/docs/fine-tuning).
- Operational procedures: [Operational Runbooks](/docs/runbooks).
