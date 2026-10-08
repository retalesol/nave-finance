# Nave Final System Status (2026-05-31)

This document is the final cross-repo status snapshot for:

- `nave-app` (frontend + application backend)
- `nave-contracts` (on-chain Anchor programs)

It reflects current code and documentation as of 2026-05-31.

## Executive status

- Overall posture: **devnet beta**, not production-ready.
- Product core is functional end-to-end (UI, Supabase indexing, signer relay, Anchor programs).
- Real protocol CPI paths are present in `nave_core` for Kamino/Jito/Jupiter on devnet.
- Main blockers are audit/hardening, escrow E2E closure, CI coverage, and doc drift cleanup.

## System readiness by domain

### 1) Frontend + app backend (`nave-app`)

- **Ready:** DAO flows, treasury views, governance flows, agent pipeline surfaces, Supabase integrations.
- **Ready:** Helius raw-webhook decode/index path and scheduled treasury snapshots.
- **Ready:** Signer service + worker orchestration model with keyed secret boundaries.
- **Open:** Human launch sign-off on **deployed** hosts (see `docs/BETA_LAUNCH.md`
  deployment checklist). Escrow-path **documentation** and §5 exit criteria are
  closed in `docs/DEVNET_E2E_GATE.md` (run records + localnet `expire_request`).
- **Open:** CI and frontend test automation (guardrails eval exists, but no full FE test suite).
- **Open:** Final runbook hardening and production rollout controls.

### 2) On-chain contracts (`nave-contracts`)

- **Ready:** Six-program Anchor workspace with broad scenario and integration test harness.
- **Ready:** Governance and multi-agent execution pipeline, guardian emergency controls, allocation cap enforcement.
- **Ready:** Real CPI instruction paths in `nave_core` for Kamino/Jito/Jupiter (devnet validation path exists).
- **Open:** IDL drift risk if `contracts/solana/idl` is not refreshed after program edits.
- **Open:** `anchor test` can unintentionally include devnet scripts if not separated from integration suite.
- **Open:** Pre-audit hardening backlog before mainnet posture.

## Known blockers to mainnet/hardening

1. External audit completion and issue closure.
2. **Done (docs):** Escrow movement + withdraw + reconciliation + `expire_request`
   (localnet) — see `docs/DEVNET_E2E_GATE.md` §5 and run records; optional live
   devnet `expire_request` signature remains a deployment nicety.
3. CI baseline for contracts and app gates (typecheck/build/tests/evals).
4. Canonical docs kept in sync with current CPI/test/IDL realities.
5. Operational governance controls (guardian/multisig rollout, fail-closed defaults) completed per runbooks.

## What this cleanup pass updates

- Removes clearly unused or stale local artifacts/files under moderate cleanup policy.
- Consolidates and updates canonical docs to remove conflicting guidance.
- Aligns app and contracts messaging on CPI reality, testing posture, and launch/readiness language.

## Canonical document ownership

- App architecture/setup: `nave-app/README.md`
- App devnet gate evidence: `nave-app/docs/DEVNET_E2E_GATE.md`
- App launch checklist: `nave-app/docs/BETA_LAUNCH.md`
- Contract architecture/readiness: `nave-contracts/README.md`
- Contract test operations: `contracts/solana/tests/TESTING.md`
- Contract security delta tracking: `contracts/solana/AUDIT_CHANGES.md`

## Next recommended sequence

1. Refresh committed contract IDLs from current Anchor build.
2. Isolate devnet-only test scripts from the default localnet test glob.
3. Re-run and record canonical escrow-enabled E2E gate.
4. Add CI gates for app + contracts.
5. Lock release sign-off with explicit GO/NO-GO owners.
