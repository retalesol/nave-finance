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

## Layer 2 — Fail-closed posture

Guardrails can be configured to fail closed: if the context needed for a critical check is missing, the check fails and blocks signing rather than waving the action through. The mainnet end-state runs fully fail-closed, with the off-chain guardrails mirroring the on-chain invariants as redundant defense.

## Layer 3 — Governance and the review window

Proposals move through the DAO's governance model, including a review window during which they can be examined and, where applicable, halted. Proposing, approving, and executing are separated roles, so no single actor drives an action end-to-end.

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

Nave is a devnet beta. The on-chain programs have not completed a formal third-party audit, and some hardening items (full fail-closed context threading end-to-end, multisig upgrade rollout, CI coverage) are tracked toward mainnet. Honest status is part of the control model; see [Product Maturity](/docs/product-maturity) and [Security & Trust](/docs/security-and-trust).

## Where to go next

- The rulebook these controls enforce: [Constitution & Policy](/docs/constitution-and-policy).
- The AI decision contract and eval harness: [Agent Fine-Tuning](/docs/fine-tuning).
- Operational procedures: [Operational Runbooks](/docs/runbooks).
