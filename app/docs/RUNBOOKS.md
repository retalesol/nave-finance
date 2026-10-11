# Nave Operational Runbooks (Phase 6)

Operational procedures for production. Pair with `docs/SECRETS.md` (secret
inventory + rotation), `docs/RLS.md` (data-plane access), and
`docs/RECONCILIATION.md` (invariants + alerts).

---

## 1. Program upgrade authority — multisig (Squads)

**Goal:** no single key can upgrade any of the six programs on mainnet.

Programs: `nave_core`, `nave_governance`, `nave_execution`, `nave_kamino_adapter`,
`nave_jito_adapter`, `nave_marginfi_adapter`.

Procedure (per program):
1. Create/confirm the Squads multisig (recommend ≥ 3 signers, threshold ≥ 2).
   Record the multisig address and member set.
2. Transfer each program's upgrade authority to the multisig vault:
   `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT>`.
   Verify with `solana program show <PROGRAM_ID>` (Authority == Squads vault).
3. Record the posture table below and commit it.

| Program | Devnet authority | Mainnet authority (Squads) | Verified |
|---------|------------------|----------------------------|----------|
| nave_core | `____` | `____` | ☐ |
| nave_governance | `____` | `____` | ☐ |
| nave_execution | `____` | `____` | ☐ |
| nave_kamino_adapter | `____` | `____` | ☐ |
| nave_jito_adapter | `____` | `____` | ☐ |
| nave_marginfi_adapter | `____` | `____` | ☐ |

Deploy runbook (mainnet upgrade): build verifiable → propose the
`bpf_loader_upgradeable` upgrade through Squads → collect M-of-N approvals →
execute → verify program hash → smoke-test read paths.

> Squads transfer + approvals are an on-chain ceremony performed with the
> multisig members' wallets; it is not automatable from this repo.

---

## 2. Break-glass (pause / emergency)

Agent autonomy and direct execution are gated by the Executive agent key today;
the guardian-multisig gating of `toggle_agents(false)` / `execute_strategy_direct`
is specified in `contracts/solana/AUDIT_CHANGES.md` (deferred) and should be
deployed before mainnet.

Pause autonomous agents:
1. Founder/guardian disables agents (`toggle_agents(false)`) — via the Agent
   admin path / orchestrator proxy once guardian gating ships.
2. Stop the worker (`signer-service` `npm run worker`) so no new dispatches,
   policy evaluations, or proposal creations occur.
3. Confirm no pending `InReview` requests will auto-execute (let them expire via
   `expire_request`, or halt with `operational_halt`).
4. To stop only autonomous *proposing* without halting the whole pipeline, set
   `NAVE_AUTOPROPOSE_ENABLED=false` (proposal-creator reverts to observe-only).
   See §7 for the full continuous-loop kill switches.

Emergency freeze (treasury): `emergency_freeze` (guardian) halts treasury ops;
`emergency_unfreeze` reverses. Record nonce + tx signatures.

---

## 3. Key rotation

See `docs/SECRETS.md` for the full inventory. Quick reference:

- **Bearer secrets** (`NAVE_AGENT_SECRET`, `NAVE_SIGNER_SECRET`,
  `NAVE_INDEXER_SECRET`): rotate by setting the new value in every consumer's
  env (`supabase secrets set`, signer host, worker host) then redeploy. These
  are fail-closed — a missing value stops the service.
- **`NAVE_MASTER_KEK`** (envelope encryption): rotate by re-wrapping every DEK.
  Generate a new KEK, decrypt each `encrypted_agent_keys.wrapped_dek` with the
  old KEK, re-wrap with the new KEK, write back, then swap the env. Do this in a
  maintenance window with the worker paused.
- **Agent keypairs**: `rotate_agent_key` (guardian) on-chain; regenerate via
  `generate-agent-keys` (persists a fresh wrapped DEK) and deactivate the old row.
- **Supabase anon / service-role keys**: rotate in the Supabase dashboard;
  update `VITE_SUPABASE_ANON_KEY` (frontend redeploy) and
  `SUPABASE_SERVICE_ROLE_KEY` (edge + worker env).

---

## 4. Incident response

1. **Detect**: `reconciliation_alert` in `activity_logs`, `ALERT_WEBHOOK_URL`
   page, signer/worker error logs, or failed `agent_action_logs` rows.
2. **Contain**: pause the worker; break-glass disable agents if funds are at
   risk; freeze treasury if a vault invariant is broken.
3. **Diagnose**: pull the affected `execution_request` on-chain status
   (`scripts/verify-e2e-gate.mjs`), the `agent_action_logs` trail, and recent
   signer logs. Check reconciliation deltas.
4. **Recover**: reverse with `withdraw_from_strategy` if a deployment is wrong;
   `expire_request` stuck requests; rotate any exposed secret.
5. **Post-mortem**: record timeline, root cause, and the guardrail/eval fixture
   added to prevent recurrence (feeds Phase 7).

---

## 5. Scheduler / worker recovery

- The worker (`signer-service` `npm run worker`) polls the orchestrator and
  triggers snapshots. It is fail-closed (exits if required env is missing) and
  guards against overlapping runs.
- **`index-events`** also POSTs **`agent-orchestrator`** `{ mode: "poll" }` after
  batches that include governance/agent-relevant `event_type`s (same hints the
  orchestrator uses for discovery), so the pipeline can advance when Helius is
  delivering txs even if the Railway worker is down. The Edge runtime must have
  **`NAVE_AGENT_SECRET`** set (same as other agent functions).
- If it dies: the platform should auto-restart it. On restart it re-reads
  on-chain status (authoritative), so transitions are idempotent and safe to
  re-run. No state is lost.
- If the orchestrator backs up: it is idempotent per execution request
  (re-reads status, only acts on actionable states), so catch-up is safe.
- Verify recovery: confirm a fresh `treasury_snapshot` and that any eligible
  `InReview`-past-`review_end` request executes on the next tick.
- The worker also runs agent-wallet replenishment (see 5a). It does not collect
  an annual management fee. Replenishment is idempotent and safe to re-run on restart.

---

## 5a. Yield skim and protocol revenue wallet

The only protocol treasury fee is **15% of realized yield**
(`performance_fee_bps = 1500`), paid in-kind to a single **protocol revenue
wallet** (`fee_config.protocol_revenue_wallet`, bound at DAO creation from
`VITE_NAVE_PROTOCOL_FEE_WALLET`).

- **Yield fee** — taken *inline* on every strategy withdrawal
  (`withdraw_from_strategy` → `record_strategy_withdrawal`). Realized yield is
  the gain above principal. Principal is not charged. Yield that is still
  deployed is charged when it is withdrawn. Frozen treasuries use the same 15%.
  No operator action: the signer derives `fee_config` + the revenue wallet's ATA
  for the withdrawn mint automatically. There is no standalone
  `collect_performance_fee` instruction.
- **No annual management fee.** `management_fee_bps` is 0 in both the normal and
  frozen state. Do not run a collector for it. `collect_management_fee` transfers
  nothing. `NAVE_OPS_WALLET_SECRET` is the payer for agent-wallet replenishment.
  It is not a management-fee collector. If it is unset, replenishment is skipped.

Ops:

- **Revenue-wallet fee ATAs**: the yield skim pays the revenue wallet's
  associated token account for each mint. **Provision an ATA for every held
  mint** (USDC, wSOL, …) on the revenue wallet, and keep the wallet funded for
  ATA rent — otherwise the skim fails.
  Run the provisioning script before launch and whenever a new asset mint is
  registered to a DAO:
  ```bash
  # Dry-run first to see what will be created
  SOLANA_RPC_URL=... NAVE_PROTOCOL_REVENUE_WALLET=... NAVE_PAYER_SECRET=... \
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
    npm run provision:revenue-atas:dry

  # Then provision for real
  npm run provision:revenue-atas
  ```
  The script discovers mints from all registered DAOs in the DB; pass
  `NAVE_MINTS=<mint1>,<mint2>` to override or supplement. It is idempotent —
  existing ATAs are skipped.
- **Verification**: after a withdrawal that realizes yield, confirm a
  `PerformanceFeeSkimmed` event for 15% of the gain and a balance increase on
  the revenue-wallet ATA. Do not expect a management-fee transfer.
- **Recovery**: the skim happens on the withdrawal itself. There is no annual
  boundary to catch up after a worker restart.

---

## 6. Monitoring & rate limiting

- **Rate limiting**: `supabase/functions/_shared/rateLimit.ts` provides a
  best-effort per-instance limiter; the browser-reachable `orchestrator-proxy`
  is capped at 10 req/min/IP. For strict global limits, back the limiter with a
  shared store (Upstash/Postgres).
- **Monitoring**: alert on (a) reconciliation breaches, (b) snapshot staleness,
  (c) signer 5xx rate, (d) `agent_action_logs.status='failed'` rate, (e) worker
  liveness, (f) policy breaches (`rebalance_recommendations.flags` containing
  `deployment_cap_breached` / `liquidity_floor_breached` / `reserve_floor_breached`),
  (g) repeated deterministic-guardrail blocks (`guardrail_failures` on
  `agent_action_logs`), (h) failed autonomous proposal creation
  (`agent_proposals.status='failed'` or `proposal-creator` errors), (i)
  yield-skim failures (missing revenue-wallet ATA — see 5a). Wire
  `ALERT_WEBHOOK_URL`.

---

## 7. Continuous policy loop & autonomous proposing (Phases 2–4)

Components (all additive; each independently disable-able):

- **policy-evaluator** (edge fn, observe-only): reads authoritative on-chain
  constitution + vault + positions, scans approved-protocol yield, and writes
  deterministic `rebalance_recommendations` (+ `yield_opportunities`). NEVER
  signs. Gated by `NAVE_POLICY_SECRET`; the worker tick is skipped if unset.
- **proposal-creator** (edge fn): turns `deploy` recommendations into on-chain
  **Strategy proposals** via the signer's `create_proposal` action. Gated TWICE:
  (1) the worker tick needs `NAVE_PROPOSER_SECRET`; (2) the function itself is
  **observe-only unless `NAVE_AUTOPROPOSE_ENABLED=true`** — without it, it only
  reports candidates and changes nothing.
- **signer `create_proposal`**: builds the canonical 72-byte NE-7 binding payload
  (`sha256(protocol_program(32) ‖ amount_le(8) ‖ mint(32))`, byte-identical to the
  preimage `create_execution_request` recomputes) and submits `create_proposal` as the
  `NAVE_PROPOSER_ROLE` key (default `planner`). Idempotent: an `agent_proposals`
  row keyed on `(dao, idempotency_key)` is reserved BEFORE submission, so a
  recommendation can never spawn two proposals (concurrency/retry safe). On
  failure the reservation is removed so a later cycle can retry.

Authority ordering is unchanged: **on-chain invariants > deterministic
guardrails > model output.** A proposed action still has to win governance and
clear the full 4-agent + guardrail + review-window pipeline before any funds
move. The planner can ONLY create Strategy proposals — never Policy proposals
(constitution amendments stay human-governed) and never approvals/execution.

Staged rollout (matches Phase 6 acceptance):
1. **Observe-only**: `NAVE_POLICY_SECRET` set, `NAVE_PROPOSER_SECRET` unset (or
   `NAVE_AUTOPROPOSE_ENABLED` unset). Recommendations accrue; nothing is created.
2. **Auto-propose**: set `NAVE_PROPOSER_SECRET` + `NAVE_AUTOPROPOSE_ENABLED=true`
   and provision a funded `planner` key (`encrypted_agent_keys`, role `planner`).
   Proposals are created but governance + the pipeline still gate execution.
3. **Tighter autonomy**: only after sustained clean runs and reconciliation.

Pause autonomous proposing (least-disruptive first):
- Set `NAVE_AUTOPROPOSE_ENABLED=false` (proposal-creator reverts to observe-only) → redeploy.
- Or unset `NAVE_PROPOSER_SECRET` and restart the worker (tick disabled).
- Or deactivate the `planner` key row in `encrypted_agent_keys` (signer can't
  load it → `create_proposal` fails closed).

Post-halt recovery: a `Halted` ExecutionRequest is no longer a dead-end — the
orchestrator re-evaluates it and, when the Oversight agent (key role `operational`) returns
`clear_halt` with no guardrail failures, submits `operational_clear` (Halted →
InReview). To prevent automatic recovery, break-glass disable agents.

---

## 8. Real-CPI vs Nave-escrow decision (confirm before mainnet)

The Phase 2 escrow milestone proves real on-chain movement into a
**Nave-controlled escrow** PDA. Advertising live third-party yield
(Jito/Kamino/Marginfi) requires a separate CPI integration workstream against
those protocols' real programs. **Do not market live yield until that ships.**
Record the decision and, if doing real CPIs, treat it as a new audited revision.

---

## 9. Unified DAO creation flow (gas, optional seed, bootstrap)

DAO creation is a single guided flow. The founder pays only network gas (and
account rent). There is no protocol formation fee and no NAVE or wNAVE creation
stake on any chain. A founder may deposit their own assets into the treasury as
a seed. That deposit is their capital, not a fee. The flow can then ratify the
constitution, start the agents, and fire ONE bootstrap action that bypasses the
review window so the agents deploy immediately.

**Formation.** `initialize_dao` charges no SOL.
`global_config.formation_fee_lamports` is `0` on every network. Do not write a
non-zero formation fee. EVM `formationFee` stays `0`. Any `msg.value` the
founder sends with creation is their own treasury seed, not a protocol charge.
Token-mint fees (0.5 SOL / 0.05 ETH) are unchanged and are not a cost of
forming a treasury.

**Moonlight.** An existing locked creation stake, from a treasury formed before
this change, is still released on moonlight. New treasuries have no lock to
release. Reopening (`restore_dao` / EVM restore) does not require a new stake.

**Bootstrap activation (immediate first action).** The first founder-gated
`create_execution_request(…, bootstrap=true)` snapshots `review_window = 0` so the
FIRST action deploys immediately (no 24h Oversight wait). The
`dao_registry.bootstrap_used` latch (flipped via a nave_core CPI;
`record_bootstrap_usage`) blocks reuse — all later requests use the configured
window. Emits `DaoBootstrapUsed` + `BootstrapExecutionRequestCreated`, indexed by
`index-events` and discoverable by `agent-orchestrator`. EVM `NaveExecution` has
the equivalent zero-review-window first-action mechanism.

- The bootstrap first action is **SOL→Jito** and does NOT depend on swaps. The
  `jupiter_swap` agent capability (wSOL→USDC) is fail-closed behind
  `NAVE_SWAP_ENABLED` (default `false`); `NAVE_SWAP_MAX_SLIPPAGE_BPS` (default
  `1000`) caps per-swap slippage when enabled.
- The reserve-floor guardrail no longer hard-blocks a SOL-seeded (no-stablecoin)
  treasury, so the immediate Jito deploy can pass.

**Review window (editable).** Post-creation, the window is editable via
`set_review_window` (Solana) / EVM equivalent, bounded `60s..7d` (default
`86400s`), surfaced in DAO Settings. The bootstrap path is the only way to reach
a true `0s` window, and only for the one-time first action.

---

## 10. Bridge & faucet operations (testnet)

Both run on `signer-service` (Railway) and are independent of treasury agent
operations — pausing one does not affect the other or the rest of the pipeline.

**Pause/resume:**
- Bridge: set `BRIDGE_RELAYER_ENABLED=false` → redeploy. `/bridge-relay` returns
  503 immediately; in-flight locks/burns are unaffected on-chain (funds stay in
  custody until the relayer is re-enabled and the same `sourceTx` is resubmitted).
- Faucet: set `FAUCET_ENABLED=false` → redeploy. `/faucet-claim` (NAVE) and
  `/faucet-claim-sol` (SOL) both return 503 — one flag gates both assets.

**Monitor wallet balances (devnet):**
- Bridge custody (Solana token account) holds locked NAVE awaiting EVM mint
  confirmations — balance should track net inbound locks minus completed
  releases. Check via `spl-token accounts --owner <custody-authority-pubkey>`.
- Bridge EVM minter EOA needs ETH for gas on both Sepolia and Base Sepolia —
  top up from a funded testnet wallet if mints start failing with gas errors.
- Faucet wallet needs both a NAVE balance (drains 0.1 per successful NAVE
  claim) and a SOL balance that now serves double duty: transaction fees AND
  the SOL faucet itself (drains 0.05 per successful SOL claim; the sender
  refuses to dip below a 0.02 SOL reserve so fees for NAVE claims are never
  starved). Top up both independently; they are unrelated to the bridge's
  custody/minter balances (separate keys, see `docs/SECRETS.md`).

**Rate-limit dimensions (faucet):** `faucet:addr:<address>` + `faucet:ip:<ip>`
for NAVE claims, and independently `faucet-sol:addr:<address>` +
`faucet-sol:ip:<ip>` for SOL claims — all 1-per-`FAUCET_CLAIM_COOLDOWN_HOURS`
(default 24h). Claiming one asset never consumes the other's cooldown. A
failed claim past the rate-limit checks (insufficient balance, faucet out of
NAVE/SOL, on-chain send failure) releases both consumed slots via
`releaseLimit()` so a legitimate retry is never blocked by an unrelated
failure — see `signer-service/src/rateLimit.ts`.

**Reconcile a stuck "failed" bridge transfer:** check whether the underlying
lock/burn actually landed (Solscan/Etherscan on the `sourceTx`). A `failed`
row with no `dest_tx` and a genuinely-failed `sourceTx` is safe — nothing was
sent. A `failed` row where `sourceTx` actually succeeded on-chain (e.g. a
Solana confirmation timeout that lands anyway) means the destination
mint/release likely also already happened — verify before manually
re-running anything, since the relay endpoint does not currently re-execute
a request whose `source_tx` row already exists (idempotent by design; it
returns the existing row rather than risking a double-payout).
