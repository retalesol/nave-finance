# Devnet Public Beta — Go/No-Go Checklist

Use this after completing the code paths in the beta readiness plan. Pair with
[`docs/DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) for full E2E evidence and exit
criteria.

## E2E gate status (documentation)

| Gate | Doc | Status |
|------|-----|--------|
| Core devnet gate (autonomous agents, escrow SPL, withdraw, reconciliation, `agent_action_logs`, `expire_request` via localnet beta-path) | [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) §5 | **Documented complete** — run records 2026-05-31 + `beta-path-scenarios.ts` |
| Extended autopolicy / auto-propose loop | [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) §6 | **Deferred** — not required for minimal public devnet beta |

## Automated checks

```bash
# Distinct bearer secrets (copy output into Supabase / Railway — do not commit)
npm run secrets:generate

# Local contract beta-path tests (requires localnet validator)
cd ../contracts/solana && npm run test:localnet -- --grep "beta-path"

# Live devnet gate verifier (after indexing; uses Supabase service role)
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SOLANA_RPC_URL=… \
DAO_ADDRESS=<dao> npm run verify:e2e-gate

# Ops probe (edge health, signer, optional DAO gate) — run manually before launch
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
NAVE_SIGNER_URL=… npm run beta:go-no-go
```

CI does not run `beta:go-no-go` today (there is no `preflight.yml`; an earlier
version of this doc referenced one that was never added — corrected here
rather than left dangling). What actually runs automatically:
- `.github/workflows/app-ci.yml` — `npm run typecheck` (blocking) + `npm run
  lint` (visible, not yet blocking — see the workflow's comment) on every
  push/PR, plus `npm run eval:ci` and a Playwright smoke test.
- `.github/workflows/beta-health-report.yml` — runs `npm run beta:health-report`
  (a related but distinct script from `beta:go-no-go`) hourly via cron against
  the live `SUPABASE_URL`/`NAVE_SIGNER_URL` secrets, posting results to the
  job summary and failing the run if an endpoint is unhealthy.

`beta:go-no-go` itself remains a manual, run-before-launch check (per the
command above) — it is not wired into any workflow. If you want it gated in
CI, add a job that supplies `SUPABASE_SERVICE_ROLE_KEY` (already available as
a repo secret per `beta-health-report.yml`'s usage of sibling secrets) and
runs it on a schedule or `workflow_dispatch`, not on every PR (it's a launch
readiness probe, not a per-change gate).

## Repository & build defaults (verified in source)

These are **true in this repo**; production deploys must still confirm env vars on
the **host**.

- [x] **`VITE_USE_MOCKS=false`** in [`.env.example`](../.env.example) — public beta
  builds must keep mocks off or every treasury shows bundled demo data.
- [x] **Demo treasury CTAs** — hidden in production Vite builds (`import.meta.env.PROD`);
  optional `VITE_DEMO_TREASURY_NAV=true` for preview; see `DEMO_TREASURY_NAV_ENABLED`
  in `src/lib/mockData.ts`.
- [x] **Escrow PDA defaults** — [`.env.example`](../.env.example) documents
  `VITE_ESCROW_PDA_ENABLED=true`; `scripts/beta-go-no-go.mjs` warns if
  `VITE_ESCROW_PDA_ENABLED` or `NAVE_ESCROW_PDA_ENABLED` is explicitly `false`.

## Production deployment checklist (verify on each host)

Check each item on the **deployed** Supabase project, signer service, worker, and
frontend CDN/host. Do not check these off until values are confirmed live.

- [ ] `VITE_USE_MOCKS=false` on the **public** frontend build
- [ ] `VITE_ESCROW_PDA_ENABLED=true` and `NAVE_ESCROW_PDA_ENABLED=true` (or unset → signer default on)
- [ ] Three **distinct** `NAVE_*_SECRET` values set in Supabase + signer (see [`docs/SECRETS.md`](SECRETS.md))
- [ ] `NAVE_ALLOWED_ORIGINS` set for the deployed app origin
- [ ] `NAVE_SIGNER_URL` explicitly set (no implicit default host)
- [ ] Helius webhook: **raw** devnet, header auth only (see [`supabase/functions/helius-webhook/SETUP.md`](../supabase/functions/helius-webhook/SETUP.md))
- [ ] Worker running (`signer-service` `npm run worker`) or founder-gated orchestrator proxy
- [ ] `init_strategy_escrow` called per approved protocol before first execute
- [ ] `npm run beta:go-no-go` passes against **this** deployment (no blockers)
- [ ] Optional live `expire_request` tx recorded in [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) §5 if you require devnet redundancy beyond localnet `beta-path`

## Product copy

- Devnet beta only — no mainnet funds
- On-chain programs unaudited; treat all deployments as pre-mainnet hardening
- Token-governance DAOs recommended for beta (wallet-mode quorum is under review)

## Sign-off

Replace placeholders after Engineering and Ops validate the **production
deployment checklist** (not only repo defaults).

| Role | Name | Date | GO / NO-GO |
|------|------|------|------------|
| Engineering | | | |
| Ops | | | |
