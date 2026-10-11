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

These checks are manual. This repo does not use GitHub Actions. Run
`npm run typecheck` in `app/` before a deploy, and run `npm run beta:go-no-go`
against the live hosts before inviting testers. `npm run beta:health-report`
is the same kind of probe and is also run by hand.

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
- [x] Solana event delivery: QuickNode stream `nave-solana-devnet` (`d41f57ba-0909-417d-bbd3-81fcb6557b7a`) posts Solana devnet program logs to `helius-webhook` with header auth only. The Helius plan has ended and that webhook stays off.
- [ ] Worker running (`signer-service` `npm run worker`) or founder-gated orchestrator proxy
- [ ] `init_strategy_escrow` called per approved protocol before first execute
- [ ] `npm run beta:go-no-go` passes against **this** deployment (no blockers)
- [ ] Optional live `expire_request` tx recorded in [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md) §5 if you require devnet redundancy beyond localnet `beta-path`

## Product copy

Tester-facing status. The production deployment checklist above is still open.
Engineering and Ops sign-off below stays blank until that checklist is confirmed
on the live hosts.

- Public beta is Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet. Unaudited. No mainnet funds.
- Do not lock or redeem NAVE against the closed Solana bridge `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. Mainnet create stays refused while that bridge cannot redeem.
- Yield testers can use Solana Jito, Sepolia Compound, and Base Sepolia Aave. Sepolia Aave is over the pool supply cap. Robinhood and Arc can create a treasury, deposit, and govern. They have no lending venue.
- Agents watch. `NAVE_AUTOPROPOSE_ENABLED` stays false. A second guardian is required to close a proposal. New treasuries use a one-minute review window. Treasuries created before the timelock upgrade still have 24-hour delays.
- Four roles, in order: Executive, Financial, Operational (final signer; stored key oversight), Oversight (monitor, does not sign; stored key operational). Leave the stored key names as they are.
- Forming a treasury costs only network gas (and account rent) on every beta chain. There is no protocol formation fee and no NAVE or wNAVE creation stake. A founder may deposit their own assets as a seed. That deposit is their capital, not a fee. The only protocol treasury fee is 15% of realized yield on strategy withdrawal. Principal is not charged. Frozen treasuries use the same 15%. There is no annual management fee.
- Testnet gas comes from the site banner. **Network** selects the chain. **Faucet** opens QuickNode for Solana, Sepolia, Base Sepolia, and Robinhood. Arc uses Circle’s faucet.

### What testers can do

Create a treasury on any of the five testnets, deposit testnet assets, and govern with a second guardian. Place yield only at Solana Jito, Sepolia Compound, or Base Sepolia Aave. This note does not mark the host checklist complete.

## Public-beta dry run evidence (2026-10-10)

Signatures and what each chain proved are in [`DEVNET_E2E_GATE.md`](DEVNET_E2E_GATE.md), section "Public-beta live treasury dry run — 2026-10-10". Sepolia Compound, Base Sepolia Aave, Robinhood, and Arc completed on new treasuries. Solana completed create, stake, deposit, and a two-guardian close, then stopped: the deployed execution program cannot deserialize the new proposal, so Jito deposit and withdraw did not run. That evidence does not check the production deployment list above and does not mark GO.

## Sign-off

Replace placeholders after Engineering and Ops validate the **production
deployment checklist** (not only repo defaults).

| Role | Name | Date | GO / NO-GO |
|------|------|------|------------|
| Engineering | | | |
| Ops | | | |
