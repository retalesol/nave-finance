# Nave Finance Security Model

## Overview

Nave Finance is a multi-program Solana treasury system where DAO governance authorizes strategy execution through a four-agent approval pipeline before funds move on-chain.

## Program Trust Boundaries

| Actor | Trust Level | On-Chain Powers |
|-------|-------------|-----------------|
| Global Admin | High | Pause protocol, set formation fee |
| DAO Founder | Medium | Schedule agent rotations, update constitution/guardians, mint tokens |
| Guardians | Medium | M-of-N emergency freeze/unfreeze |
| Executive Agent | High (ops) | First approval, emergency direct execute when frozen |
| Financial Agent | High (ops) | Sets transaction payload hash |
| Oversight Agent | High (ops) | Verifies payload hash, starts review window |
| Operational Agent | High (ops) | Halt/clear execution during review |
| Token Holders | Governance | Escrow-weighted voting with quorum |
| Anyone | Low | Permissionless fee collection to configured recipient only |

## Execution Pipeline

1. Passed strategy proposal required to create execution request
2. Executive → Financial → Oversight approvals (sequential)
3. 24-hour review window (Operational agent may halt)
4. `execute_strategy` CPIs to adapter with `execution_authority` PDA signer
5. Adapters verify execution authority and move SPL from vault to strategy escrow

## Key Security Properties

- **No founder vault withdraw**: Treasury exits require the agent pipeline
- **Allocation caps**: `max_allocation_bps` enforced against NAV at request creation and execution
- **Payload binding**: Financial/Oversight hash chain enforced; proposal hash seeded at request creation
- **Adapter auth**: Only `nave_execution` execution_authority PDA can invoke adapter deposits/withdrawals
- **Guardian threshold**: Emergency actions require M-of-N signatures via `GuardianAction` PDAs
- **Agent rotation timelock**: 48-hour delay before scheduled agent key changes apply
- **Fee recipient**: Hardcoded per-DAO in `FeeConfig`; fee collection validates recipient ATA

## Upgrade Strategy

Programs are configured as **upgradeable on devnet** (`Anchor.toml`). Production deployments should use a multisig upgrade authority (e.g., Squads) and complete an external audit before mainnet.

## Known Limitations

- Adapter programs use strategy escrow accounts; production Kamino/Jito/Marginfi CPIs should replace escrow bookkeeping
- NAV does not auto-update from external protocol yields; off-chain agents must reconcile and propose NAV updates
- Wallet voting remains guardian-only (weight=1); token escrow voting is the primary holder path

## Security Invariants Checklist

These invariants MUST hold at all times. Each is a hard gate for mainnet; a
violation is treated as a release blocker. (See `nave-app/docs/AUDIT_FINDINGS.md`
for the full severity-ranked ledger and remediation status.)

- [ ] **No single env secret authorizes all DAOs.** No environment variable,
      shared key, or service credential grants signing/authority across multiple
      DAOs; authority is per-DAO and derived on-chain.
- [ ] **No off-chain DB field can replace on-chain authority.** Founder,
      guardian, and agent authority are resolved from chain state; DB values
      (e.g. `dao_registry.creator_wallet`) are hints only and never the source of
      truth. (Tracked: H5 orchestrator-proxy, H6 generate-agent-keys.)
- [ ] **No agent action signs without deterministic policy checks.** Every
      signer-submitted action passes fail-closed, deterministic guardrails first;
      the model is advisory only and can never authorize a fund move.
- [ ] **No mainnet signer boots with dev controls.** A mainnet env/binary cannot
      boot with devnet program IDs or dev fallbacks (e.g. Jupiter program-id
      assertion at startup). No RPC ⇒ fail closed, never fail open. (Tracked: H7,
      H6.)
- [ ] **No strategy execution proceeds with stale/indeterminate NAV.** Caps and
      deploys are gated on fresh NAV (`treasury_vault.last_revalued_at` /
      `revalue_treasury`); the off-chain reserve floor is a hard block, not a
      warning. Pyth prices with an out-of-band confidence interval are rejected.
      (Tracked: H4 oracle conf, M1 NAV staleness, M2 non-stablecoin NAV.)
- [ ] **Anon callers cannot read other DAOs' financial data.** RLS forbids
      anonymous reads of per-DAO financials; no `USING (true)` SELECT policy on
      tables holding private/financial data. (Tracked: C1 monthly_reports,
      H1 dao_token_images, H2 dao-logos, H3 table sweep.)

Supporting invariants already enforced on-chain (regression-guard, do not break):

- No founder vault withdraw; treasury exits require the 3-of-3 + review-window
  agent pipeline.
- Only `nave_execution`'s `execution_authority` PDA can invoke adapter
  deposits/withdrawals; the strategy escrow is a distinct per-(protocol, mint)
  PDA and can never equal the vault token account.
- Emergency actions require M-of-N guardian signatures over a coordinated nonce
  (a per-signer `Date.now()` nonce defeats M-of-N — tracked: H8).

## Audit findings summary (Full Product Audit, Phase 0)

Consolidated count by severity (full ledger: `nave-app/docs/AUDIT_FINDINGS.md`):

| Severity | Count | Highlights |
|----------|-------|------------|
| Critical | 1 | C1: `monthly_reports` `USING (true)` exposes all DAO financials to anon (confirmed live). |
| High | 8 | RLS open writes (`dao_token_images`, `dao-logos`), Pyth confidence ignored, founder-from-DB, generate-agent-keys fail-open, Jupiter devnet default, M-of-N freeze nonce. |
| Medium | 14 | NAV staleness/reserve-floor, non-stablecoin deposit NAV, `archive_proposals` index, global-config front-run, GuardianAction threshold snapshot/cancel, direct-execute status, jito temp-wSOL, compound cooldown/gate freshness, cosmetic constitution controls, unrestricted token mint, raw SOL deposit, distributed rate limits, pre-sign simulation. |
| Low | 10 | Hardcoded/mocked UI (homepage, dashboard, agents, governance, settings), dead code (client-bundled tx builders, inert `Transfer`), eval fixture drift. |
| Info/Process | 5 | CI gaps, cutover maintenance, high-load + adversarial sim, long-term/edge sim, cosmetic `request_index`. |

**Deployed-state snapshot (Phase 0, read-only):**

- `monthly_reports` permissive `USING (true)` SELECT policy is **still present and
  live** — anon can read every DAO's `yield_earned`/`capital_*`/`fees_collected`.
  Remediation pending (no migration drops it yet).
- Vault → escrow on-chain token movement is **live and enforced**:
  `record_strategy_deposit` runs `transfer_vault_to_escrow`, adapters bind the
  escrow as a distinct per-(protocol, mint) PDA and reject `escrow == vault`, and
  the signer/frontend escrow flags default ON. Note: `AUDIT_CHANGES.md` still
  describes this as "deferred/gated off" and is stale documentation.

## Reporting

Report vulnerabilities to the Nave Finance security team before public disclosure.
