# Introduction

Welcome to the Nave documentation portal. Nave is an autonomous treasury operating system for on-chain organizations: a treasury ratifies a constitution, an AI agent layer proposes and reviews actions, and on-chain programs enforce the rules and execute. This page orients you and points you to the right track.

## What Nave is

Nave lets a DAO or fund run an actively managed treasury without surrendering control to a model or an operator. Three ideas define it:

1. **A constitution sets the rules.** Approved protocols, allocation caps, liquidity floors, confidence thresholds, and cadences are ratified on-chain.
2. **Agents are advisory.** Four AI roles — Executive, Financial, Oversight, and Operational — propose and review treasury actions, but hold no unilateral authority.
3. **The chain is the authority.** Deterministic guardrails and program invariants decide what is permitted, so the model can be wrong without the treasury being harmed.

Nave is multi-chain: a treasury can be created on **Solana**, **Ethereum**, or **Base**, and the protocol token (`$NAVE`, "Nave Shares") can move between Solana and the supported EVM testnets through a dedicated bridge. See [Tokenomics & Bridge](/docs/tokenomics) for the token model and bridge mechanics.

## Who this portal is for

This documentation is organized into tracks so each reader can start where it matters to them:

| You are a... | Start here |
| --- | --- |
| New or curious user | [Getting Started](/docs/getting-started) |
| Fund manager or DAO operator | [Treasury Operations](/docs/treasury-operations) |
| Developer or integrator | [Architecture](/docs/architecture) |
| Investor or venture firm | [Investment Overview](/docs/investment-overview) |

Beyond the tracks, a technical reference section covers architecture alignment, security, operations, the AI decision contract, and launch evidence.

## How the system works at a glance

```
Constitution (on-chain rules)
   ──▶ AI agents (propose + review)
   ──▶ Deterministic guardrails
   ──▶ On-chain programs (enforce + execute)
   ──▶ Treasury (real on-chain value)
   ↺  feeds back to agents
```

A proposal only becomes a signed transaction after it clears the guardrails and the programs' invariants. Treasury value is computed from real on-chain balances priced with live market data, and every figure reconciles to on-chain state.

## Current status

Nave is a **devnet beta**. It runs entirely on Solana devnet, no mainnet funds are involved, and the on-chain programs have not completed a formal third-party audit. The product core is functional end-to-end. For a candid readiness assessment, see [Product Maturity](/docs/product-maturity).

## Principles this portal follows

1. Models are advisory; deterministic checks decide signing eligibility.
2. Treasury accounting must reconcile at every checkpoint.
3. Privileged actions are tightly scoped and auditable.
4. Documentation reflects the live system, not aspirational behavior.

## Where to go next

Pick your track from the table above, jump to [Tokenomics & Bridge](/docs/tokenomics) for the token model, or go to the [FAQ & Glossary](/docs/faq) if you want definitions first.
