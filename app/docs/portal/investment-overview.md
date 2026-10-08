# Investment Overview

Written for investors and venture firms evaluating Nave. This page states the thesis, the market, and what is differentiated, in plain terms and without overstating maturity. For current readiness and the security posture, pair this with [Product Maturity](/docs/product-maturity) and [Security & Trust](/docs/security-and-trust).

## The thesis in one sentence

On-chain treasuries are growing in number and size, the work of managing them is largely manual and undifferentiated, and a system that automates that work while keeping authority on-chain captures a durable position between idle capital and risky discretion.

## The problem

DAOs and on-chain organizations increasingly hold substantial treasuries, but operating them well is hard:

- **Idle by default.** Treasuries often sit unproductive because active management requires trusted, attentive operators.
- **Risky when active.** Granting discretion to operators or bots reintroduces the custody and judgment risks that on-chain systems were meant to reduce.
- **Opaque and manual.** Reporting, reconciliation, and policy enforcement are frequently spreadsheet-and-trust exercises rather than verifiable processes.

The unmet need is management that is both active and trustworthy.

## Nave's approach

Nave is an autonomous treasury operating system. A treasury ratifies a constitution; an AI agent layer proposes and reviews actions; and on-chain programs enforce the rules and execute. The defining choice is the separation of intelligence from authority:

- **Intelligence is advisory.** AI agents recommend; they cannot unilaterally act.
- **Authority is on-chain.** Deterministic guardrails and program invariants decide what is permitted.

This lets a treasury be actively managed without handing discretion to a model or an operator. The model can be wrong without the treasury being harmed.

## Why this is differentiated

- **Verifiable safety, not promised safety.** Limits are enforced in the programs, so they hold regardless of off-chain behavior. See [Risk & Controls](/docs/risk-and-controls).
- **Reproducible accounting.** Value derives from on-chain balances and live pricing, with reconciliation invariants that must hold at every checkpoint. See [Treasury Reconciliation](/docs/reconciliation).
- **Auditable AI.** Every agent decision commits a reasoning hash on-chain, making the decision layer reviewable and replayable rather than a black box.
- **Real protocol integration.** The system exercises real cross-program paths to established Solana DeFi protocols rather than mocked stubs.

## Market context

The opportunity scales with on-chain treasury value and with the number of organizations that need to manage it under rules they can prove. Nave targets that intersection: organizations that want yield and active management but are unwilling to trade away the transparency and control that brought them on-chain in the first place.

## Business surface

The platform model includes a formation step for new treasuries and ongoing operation under each treasury's constitution. As the system moves from devnet beta toward mainnet, the monetization and go-to-market surface should be evaluated alongside the maturity milestones rather than assumed; this portal does not overstate revenue mechanics that are still being finalized.

## What to diligence next

- Honest current state and the path to mainnet: [Product Maturity](/docs/product-maturity).
- The trust and custody model: [Security & Trust](/docs/security-and-trust).
- How autonomy is bounded in practice: [Risk & Controls](/docs/risk-and-controls).
