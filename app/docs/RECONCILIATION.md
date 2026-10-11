# Treasury Reconciliation Invariants & Alerts (Phase 6)

This is the reference for the invariants that must hold for every Nave treasury,
where each value comes from, the alert thresholds, and where the checks are
wired. It backs the Phase 5 gate (`docs/DEVNET_E2E_GATE.md`) and the mainnet
exit criteria.

## Invariants

Let, per DAO (per vault mint, in base units):

- `vault_balance` = SPL balance of the vault token account (ATA of
  `vault_authority` for the vault mint).
- `escrow_balance(p)` = SPL balance of the strategy escrow PDA token account for
  protocol `p` (seeds `[STRATEGY_ESCROW_SEED, dao, protocol_id]`).
- `current_nav` = `treasury_vault.current_nav`.
- `deployed_capital` = `treasury_vault.deployed_capital`.
- `position_value(p)` = `strategy_position(p).current_value`.

Invariants:

1. **NAV conservation**
   `vault_balance + Σ escrow_balance(p) == current_nav` (± `EPSILON`).
2. **Deployed conservation**
   `Σ position_value(p) == deployed_capital` (± `EPSILON`).
3. **Per-protocol cap** (also enforced on-chain by `enforce_allocation_cap`)
   `position_value(p) ≤ maxAllocationBps(p) * current_nav / 10_000`.
4. **Round-trip** (E2E gate): after `execute_strategy` then
   `withdraw_from_strategy`, all balances return to pre-execute values.
5. **Global deployment cap** (enforced on-chain by
   `enforce_constitution_global_limits`, and off-chain by the
   `global_deployment_cap` guardrail)
   `deployed_capital ≤ maxTotalDeployedBps * current_nav / 10_000`
   (when `maxTotalDeployedBps > 0`).
6. **Liquidity floor** (enforced on-chain + `liquidity_floor` guardrail)
   `current_nav − deployed_capital ≥ minLiquidityBps * current_nav / 10_000`
   (when `minLiquidityBps > 0`).
7. **Stablecoin reserve floor** (constitution `minStablecoinReserveBps`):
   reserved share must remain ≥ floor. **Currently off-chain only** — the
   single-mint vault model cannot prove multi-asset composition on-chain, so the
   `reserve_floor` guardrail surfaces a WARNING (non-blocking) when the
   stablecoin balance is unmeasurable, and a hard block once measurable. Enforce
   strictly at the multi-asset treasury milestone.
8. **Rebalance cadence** (constitution `rebalanceFrequencySecs` /
   `lastRebalanceAt`): a rebalance action is only eligible once
   `now − lastRebalanceAt ≥ rebalanceFrequencySecs`. Gated by the
   `rebalance_interval` guardrail.

`EPSILON` accounts for integer rounding only (recommend `0` for SPL base units;
allow a tiny tolerance once USD pricing is involved).

## Full-cycle yield reconciliation (deploy → yield → withdraw)

This section makes the yield-return loop auditable end-to-end: an operator can
assert how much of a NAV change is **realized yield** versus principal movement
versus fees, across a full `execute_strategy → (accrue) → withdraw_from_strategy`
cycle. It is the doc-side companion to the on-chain accounting unit tests in
`nave_core` (`utils/strategy.rs`, `utils/fees.rs`).

### Where the numbers live (authoritative on-chain sources)

Base-unit (per asset mint) accounting:

- `treasury_asset.deposited` — cumulative external deposits into the asset's
  holding vault via `deposit_to_asset` (monotonic inflow counter; **not**
  decremented by withdrawals and **not** touched by strategy deploy/withdraw).
- `treasury_asset.deployed_capital` — principal **currently** deployed to
  strategies for this mint, in base units. `+= amount` on
  `record_strategy_deposit`, `-= min(amount, deployed_capital)` on
  `record_strategy_withdrawal`.
- `strategy_position(p).deposited_amount` — principal currently deployed to
  `(protocol p, mint)`.
- `strategy_position(p).current_value` — last **marked** value of the position
  (base units), written by `update_strategy_position_value`. See caveat C: this
  mark is *not* read by `revalue_treasury`.

Portfolio USD (micro-USD) accounting on `treasury_vault`, recomputed by
`revalue_treasury` from each asset's `idle_balance + deployed_capital` priced via
Pyth (stablecoins at $1):

- `current_nav` — Σ over assets of `value_usd(idle_balance + deployed_capital)`.
- `deployed_capital` (USD) — Σ over assets of `value_usd(deployed_capital)`.
  Also incremented/decremented by the executor's `amount_usd` on each
  deploy/withdraw so caps stay live between revalue ticks.
- `high_water_mark` — ratcheted up to `current_nav` by `revalue_treasury`; seeded
  by the first `deposit_to_vault`. **Vestigial** under the redesigned fee model:
  the high-water-mark performance fee was removed (it was inert — see caveat C),
  so the HWM no longer gates any fee. Retained for layout stability / diagnostics.
- `total_deposited` / `total_withdrawn` — **legacy single-mint** external-flow
  counters; only `deposit_to_vault` writes `total_deposited`. In the multi-asset
  model external deposits arrive via `deposit_to_asset` (which updates
  `treasury_asset.deposited`, not these), so treat these two fields as
  vestigial for multi-asset DAOs and reconcile flows from per-asset counters +
  emitted events instead.

Fees (from emitted events, in the relevant asset's base units):

The fee model was redesigned (supersedes the prior "inert performance fee"
caveat). The yield skim pays **in-kind** to the protocol revenue wallet's ATA
for the relevant mint (`fee_config.protocol_revenue_wallet`); there is no longer
a USD-denominated stablecoin fee path, and there is no standalone
`collect_performance_fee` instruction.

- **Yield fee = 15% of realized yield, skimmed on withdrawal.**
  `PerformanceFeeSkimmed { mint, withdrawn, gain, fee }` is emitted by
  `record_strategy_withdrawal`. For an `amount` unwound from a position with
  `deposited_amount` principal and `current_value` mark, the realized
  `gain = amount * (current_value − deposited_amount) / current_value` (principal
  is not charged) and `fee = gain * performance_fee_bps / 10_000` (1500 bps).
  Frozen treasuries use the same 1500 bps. The `fee` base units are moved
  straight from the strategy escrow to the revenue ATA **before** the remainder
  credits the treasury, so the skim never enters `current_nav`. Net treasury
  credit on a withdrawal = `amount − fee`.
- **No annual management fee.** `management_fee_bps` is 0.
  `collect_management_fee` transfers nothing, including on a frozen treasury.
  Do not subtract a management-fee transfer from NAV.

### Yield recognition semantics (read this before asserting yield)

**Yield is recognized into NAV only when it physically returns to an
`asset_vault` as idle balance.** While capital is deployed, `revalue_treasury`
values the deployed portion at its **recorded base-unit principal**
(`treasury_asset.deployed_capital`), *not* the live receipt-token value. So
receipt-token appreciation (Kamino cToken growth, Jito poolSOL appreciation) does
**not** move NAV while deployed; it is realized the moment the underlying lands
back in the idle vault and the next `revalue_treasury` reprices the larger idle
balance. This is conservative, realized-on-return accounting — gains are never
booked before they are in hand.

### Full-cycle invariants

For one asset mint over a reconciliation window, with everything priced at the
window's Pyth marks (use `EPSILON` for USD rounding):

9. **Principal conservation across a deploy/withdraw cycle.** For each protocol
   `p`, `strategy_position(p).deposited_amount` equals the cumulative deployed
   base units minus cumulative withdrawn base units routed back to the vault:

   ```
   deposited_amount(p) == Σ execute_strategy.amount(p) − Σ withdraw_from_strategy.amount(p)
   ```

   and `treasury_asset.deployed_capital == Σ_p deposited_amount(p)`.

10. **No principal underflow on a post-yield unwind.** A withdrawal whose
    `amount` exceeds recorded principal (a marked-up position) must drive
    `deposited_amount`, `treasury_asset.deployed_capital`, and the USD
    `treasury_vault.deployed_capital` to **zero by saturation**, never below.
    (Locked in by `realized_yield_withdrawal_saturates_principal_without_underflow`.)

11. **Realized-yield → NAV identity.** Let, over the window:
    - `idle_returned` = base units credited back to the asset_vault by
      `withdraw_from_strategy` (escrow→vault transfers),
    - `principal_out` = base units that left the vault on `execute_strategy`,
    - `Δidle_usd` = `value_usd` of the net idle change attributable to strategy
      flow = `value_usd(idle_returned) − value_usd(principal_out)`,
    - `realized_yield_usd` = `value_usd(idle_returned) − value_usd(returned principal)`.

    Then, holding price constant and ignoring external deposits/withdrawals in
    the window:

    ```
    Δcurrent_nav (from strategy activity) == realized_yield_usd
    ```

    Equivalently, **NAV grows by exactly the realized yield that returned to the
    vault.** The 15% skim is taken at the escrow on the way out and never enters
    the vault, so what returns to idle is already net of that yield fee:

    ```
    idle_returned == amount − performance_skim   (per withdrawal)
    Δcurrent_nav (from strategy activity) == realized_yield_usd − performance_skim_usd
    ```

    where `performance_skim_usd = Σ value_usd(PerformanceFeeSkimmed.fee)` and the
    skim is 15% of the gain. There is no annual management fee to subtract.

12. **Performance skim consistency.** For every `PerformanceFeeSkimmed`,
    `fee ≤ gain ≤ withdrawn`, and `gain == withdrawn * (current_value −
    deposited_amount) / current_value` evaluated at the pre-withdrawal mark
    (principal is never taxed). `high_water_mark` is no longer a fee gate; the
    only HWM property still asserted is monotonic non-decrease across
    `revalue_treasury`.

### Operator assertion recipe

To assert "treasury NAV grew by exactly realized yield minus fees" for a cycle:

1. Snapshot `current_nav` and `high_water_mark` at `t0` (after a revalue).
2. Record every `execute_strategy.amount` (principal_out) and
   `withdraw_from_strategy.amount` (idle_returned) for the window from events.
3. Revalue at `t1` and snapshot `current_nav` again.
4. Compute `realized_yield_usd = value_usd(idle_returned) − value_usd(min(idle_returned, principal_out))`
   (the portion of what came back that exceeds returned principal).
5. Sum `fees_collected_usd` = `Σ value_usd(PerformanceFeeSkimmed.fee)` over the
   window (15% of each realized gain). The skim already reduced `idle_returned`.
   There is no management-fee transfer to add.
6. Assert `current_nav(t1) − current_nav(t0) == realized_yield_usd − fees_collected_usd ± EPSILON`,
   after backing out any `deposit_to_asset` / external flow in the window.
   Note `realized_yield_usd` here is the gross gain that returned; the
   performance skim is part of `fees_collected_usd`.

### Known caveats / open gaps (must be understood when reconciling)

These are current-implementation realities surfaced while verifying the
yield-return path. They do **not** indicate lost funds (escrow + vault remain
DAO-custodied), but they bound what the on-chain NAV can currently express:

- **(A) Deployed positions are valued at principal, not live value.**
  `revalue_treasury` reads `treasury_asset.deployed_capital` (base-unit
  principal), so accrued-but-not-withdrawn yield is invisible to NAV until it
  returns to idle (see "Yield recognition semantics"). Closing this requires
  pricing the live receipt-token position — tracked under the escrow
  real-movement milestone (`contracts/solana/AUDIT_CHANGES.md`, deferred item 1).

- **(B) RESOLVED — NE-8 now admits realized gains.** `withdraw_from_strategy`
  previously capped cumulative withdrawals at the deployed principal
  (`request.amount`), so realized yield **above** principal could not return
  through the audited path. NE-8 was revised to cap at `request.amount +
  (current_value − deposited_amount)` (the position's marked realized gain), via
  the shared `nave_core::utils::realized_yield_withdraw_cap`. Realized yield now
  flows back, and the 15% yield skim takes its cut at the escrow.
  This did **not** reopen the drain vector: the hard ceiling is unchanged —
  `record_strategy_withdrawal` still enforces `current_value ≥ amount` per call
  and decrements `current_value`, so a position can never return more than its
  marked value across all requests. The revised per-request cap is a strictly
  softer bound under that floor. (Invariant 10's underflow-safety is unchanged.)

- **(C) RESOLVED — performance fee is no longer inert.** The high-water-mark
  `collect_performance_fee` (which observed `current_nav ≤ high_water_mark` right
  after every `revalue_treasury` ratchet and charged `0`) has been **removed**.
  The yield fee is a 15%-of-realized-yield skim taken inline on
  `record_strategy_withdrawal`, computed from the position's marked gain at
  withdrawal time — it does not depend on the NAV/HWM relationship at all, so the
  revalue ratchet can no longer zero it out. Frozen treasuries use the same 15%.
  `high_water_mark` is now vestigial (see the field note above). There is no
  annual management fee (see the Fees section).

## Where each value comes from

| Value | Source |
|-------|--------|
| `vault_balance` | RPC `getTokenAccountBalance` on the vault ATA (snapshot-treasury already reads vault balances). |
| `escrow_balance(p)` | RPC `getTokenAccountBalance` on the escrow PDA (valid once escrow re-arch ships). |
| `current_nav`, `deployed_capital` | Deserialize `treasury_vault` (nave_core) via RPC `getAccountInfo`. |
| `position_value(p)` | Deserialize `strategy_position(p)` (nave_core) — same decode the signer/frontend use. |

## Wiring (where the checks run)

- **Snapshot path** (`supabase/functions/snapshot-treasury`): today it records
  `vault_balance` (SOL + USDC). Once the escrow re-architecture is deployed and
  `strategy_positions`/`treasury_vault` are read on-chain here, compute
  invariants (1)–(3) per snapshot and, on breach, (a) insert an
  `activity_logs` row with `event_type='reconciliation_alert'` and the deltas,
  and (b) POST to `ALERT_WEBHOOK_URL` if set (see Alerting).
- **E2E verifier** (`scripts/verify-e2e-gate.mjs`): dumps the snapshot inputs so
  invariants can be checked manually during the gate.
- **Worker** (`signer-service` `npm run worker`): drives `snapshot-treasury` on a
  cadence, so reconciliation runs continuously in production.

## Alerting

- Set `ALERT_WEBHOOK_URL` (Slack/Discord/PagerDuty-compatible incoming webhook)
  in the edge + worker env. On any invariant breach, POST a JSON payload:
  `{ dao, invariant, expected, actual, delta, snapshot_at }`.
- Always also write an `activity_logs` `reconciliation_alert` row so the breach
  is visible in-app and queryable, even if the webhook is down.
- Page on: invariant (1) or (2) breach beyond `EPSILON`, or invariant (3)/(5)/(6)
  breach (cap or floor exceeded), or a snapshot age exceeding `2 ×` the snapshot
  cadence (staleness = the agents may be acting on stale state).
- The `policy-evaluator` also emits best-effort alerts (`source:
  "policy-evaluator"`) when a recommendation's drift flags include
  `deployment_cap_breached`, `liquidity_floor_breached`, or
  `reserve_floor_breached` — these are continuous-policy breaches detected from
  authoritative on-chain reads, independent of the snapshot path.

## Mainnet exit criteria (reconciliation)

- [ ] Invariants (1)–(3) computed every snapshot for every DAO.
- [ ] Breaches raise both an `activity_logs` alert row and an `ALERT_WEBHOOK_URL`
      page.
- [ ] Snapshot staleness alert in place.
- [ ] Gate run (`docs/DEVNET_E2E_GATE.md`) shows invariants holding at every
      checkpoint, including the withdraw round-trip.
