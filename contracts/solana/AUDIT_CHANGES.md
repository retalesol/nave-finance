# Contract Revision — Audit-Ready Changes (Phase 2)

This revision bundles the on-chain security and validation fixes for the
external audit. The full workspace builds (`anchor build`) and the new
`enforce_allocation_cap` unit tests pass (`cargo test -p nave_core`).

---

## Fee model redesign (supersedes Findings B & C)

The treasury fee model was redesigned. The old high-water-mark performance fee
was inert (Finding C: `revalue_treasury` ratchets the HWM up to NAV before
`collect_performance_fee` runs), and NE-8 forbade realized gains from returning
through the audited withdrawal path (Finding B). Both are addressed here.

### Performance fee — 8.5% of realized yield, skimmed on withdrawal
- The standalone `collect_performance_fee` instruction (+ `CollectPerformanceFee`
  accounts + `PerformanceFeeCollected` event + `calculate_performance_fee`) is
  **removed**. It is replaced by an inline skim on the audited
  strategy-withdrawal path.
- `nave_core::record_strategy_withdrawal` now computes the realized-yield portion
  of each withdrawal from the position's PRE-withdrawal mark and skims
  `fee_config.performance_fee_bps` (default **850 = 8.5%**) of it
  (`utils::fees::calculate_performance_skim`). Gain is attributed proportionally:
  for an `amount` unwound from a position with `deposited_amount` principal and
  `current_value` mark, `gain = amount * (current_value − deposited_amount) /
  current_value`; principal is never taxed. The skim is transferred in the
  withdrawn asset straight from the strategy escrow to the protocol revenue
  wallet's ATA **before** the remainder credits the treasury; the position/USD
  counters are then reduced by the full `amount`. Emits `PerformanceFeeSkimmed`.
- New required accounts on `RecordStrategyWithdrawal` (nave_core) and
  `WithdrawFromStrategy` (nave_execution): `fee_config` (PDA) and
  `revenue_token_account` (token account owned by
  `fee_config.protocol_revenue_wallet`, for the withdrawn mint).

### Management fee — discrete annual 0.65% of each asset balance
- `collect_management_fee` no longer accrues a continuous time-prorated USD fee
  paid in stablecoin. It is now a **discrete annual, per-asset, in-kind** fee:
  when due (`now >= treasury_asset.last_management_fee_at + SECONDS_PER_YEAR`),
  it transfers `fee_config.management_fee_bps` (default **65 = 0.65%**) of the
  asset's idle `asset_vault` balance to the protocol revenue wallet's ATA for
  that mint, then advances the per-asset anchor.
- **Anchoring choice (documented):** the accounting anchor is floored to the
  **UTC-midnight** boundary (`utils::fees::floor_to_utc_midnight`). A fee year is
  exactly 365 whole days, so successive periods stay midnight-aligned. The first
  period is anchored at (the UTC midnight of) asset-registration time. The anchor
  is **per-asset** (new `TreasuryAsset.last_management_fee_at` field), so each
  registered asset has an independent annual cycle — multi-asset DAOs call
  `collect_management_fee` once per mint. The on-chain check uses unix time; the
  off-chain worker triggers collection at/after the midnight boundary once due.
- Still permissionless-but-validated: anyone may call, but rate, destination, and
  due-window are enforced on-chain. A zero-balance window cannot advance the
  anchor (`require!(fee > 0)`), preventing a griefer from skipping a year.

### NE-8 invariant adjustment (changes a documented invariant — be explicit)
- **Old NE-8:** `withdraw_from_strategy` capped cumulative withdrawals at the
  deployed principal (`request.withdrawn_amount + amount <= request.amount`).
  RECONCILIATION.md previously stated "do not relax NE-8".
- **New NE-8:** cumulative withdrawals for a request are capped at the deployed
  principal **plus the position's marked realized gain**
  (`request.amount + (current_value − deposited_amount)`), computed by the shared
  `nave_core::utils::realized_yield_withdraw_cap`. This lets realized gains flow
  back (so the skim can take its 8.5%).
- **Why this does not reopen a drain vector:** the absolute anti-drain ceiling is
  *unchanged* — `record_strategy_withdrawal` still enforces, per call,
  `strategy_position.current_value >= amount` and reduces `current_value` by the
  withdrawn amount. Across ALL requests a position can therefore never return
  more than its marked value; the revised per-request cap is a strictly softer
  bound sitting under that hard floor. The position marks are read defensively
  in nave_execution (`read_position_marks`, owner-checked; `(0,0)` on failure
  collapses the cap back to the principal-only bound).

### New on-chain config the integration worker MUST wire (cutover)
- `FeeConfig.protocol_revenue_wallet` (new `Pubkey`): destination owner for BOTH
  fees and source of off-chain agent-wallet replenishment. Set at DAO creation
  via the new `InitializeDaoParams.protocol_revenue_wallet` (validated non-zero).
- `FeeConfig.performance_fee_bps` = **850**, `FeeConfig.management_fee_bps` = **65**
  (defaults `DEFAULT_PERFORMANCE_FEE_BPS` / `DEFAULT_MANAGEMENT_FEE_BPS`). These
  remain governance-configurable per DAO via `InitializeDaoParams`.
- For each registered mint, an ATA of `protocol_revenue_wallet` must exist (or be
  created by the caller) to receive both the skim and the management fee.
- Legacy fields `FeeConfig.fee_recipient` and `FeeConfig.fee_asset_mint` are
  retained for layout stability but are no longer read by the fee instructions.

### Tests
- `utils/fees.rs`: performance skim (gain-only / principal-untaxed, zero-yield,
  bps/amount zero, proportional partial, multi-tranche sums to full gain,
  full-rate, pure-yield) and discrete annual management fee (not-yet-due,
  exactly-due, backwards-clock, 65-bps math, per-asset balances, midnight anchor
  advance / no double-charge, floor idempotency + negative).
- `utils/strategy.rs`: revised NE-8 cap (`realized_yield_withdraw_cap`) —
  principal-only when no gain, admits marked gain, underflow/overflow-safe — plus
  the pre-existing position-level over-withdraw/saturation invariants.
- `cargo test -p nave_core --lib`: 36 passed.

## Implemented (build-verified)

### nave_execution
- **financial_approve payload-hash binding** — now requires the supplied
  `tx_payload_hash` to equal the hash stored at request creation (sourced from
  `proposal.payload_hash`). It no longer overwrites the stored hash, closing the
  malicious-payload-substitution path. (`oversight_approve` already enforced
  equality; the chain is now consistent.)
- **Cumulative allocation cap** — `enforce_allocation_cap` takes
  `already_deployed` and checks `already_deployed + amount <= cap`. At execution
  time (`execute_strategy` / `execute_strategy_direct`) the current per-protocol
  deployment is read from the `strategy_position` PDA (`deployed_to_protocol`,
  owner-checked + defensive deserialize), so multiple individually-compliant
  requests cannot together breach a protocol's cap. At request creation the
  single-amount check is retained (no position context yet).
- **withdraw_from_strategy role gate** — now calls `validate_agent_signer(..,
  Executive)` and the `WithdrawFromStrategy` accounts gained the `agent_set`
  PDA. Previously any signer could trigger a strategy unwind.
- **Expired transition** — new `expire_request` instruction (gated to the
  Operational agent) moves an `InReview` request to `Expired` once `review_end`
  has passed, so the `ExecutionStatus::Expired` variant is actually assigned.
  Emits `ExecutionExpiredEvent`.

### nave_core
- **Deposit mint equality** — `DepositToVault` now constrains
  `vault_token_account.mint == depositor_token_account.mint`
  (`NaveError::MintMismatch`), preventing deposits of a mismatched mint.
- **init_strategy_position authority** — handler now requires
  `authority == dao_registry.founder`, removing permissionless position init.
- `enforce_allocation_cap` signature updated (see above) + unit tests added.
- New error: `NaveError::MintMismatch`.

### nave_governance
- **Governance mode enforcement** — `cast_vote_wallet` requires
  `governance_type == Wallet`; `lock_tokens_and_vote` requires
  `governance_type == Token`. New error `GovernanceError::WrongGovernanceMode`.

### Client impact (handled in Phase 4)
- `withdraw_from_strategy` callers must now pass the `agent_set` PDA and sign
  with the Executive agent key.
- A new `expire_request` instruction is available to the orchestrator.

## Larger account-graph changes (status tracked per item)

These required larger account-graph changes and full integration testing. Item 1
(escrow real-movement) is **now implemented and live on-chain**; items 2–4 remain
deferred / specified below.

### 1. Escrow real-movement (the central unblocker) — NOW LIVE ✅
**Status: IMPLEMENTED and enforced on-chain (no longer deferred, no longer a
dead branch).** SPL now physically leaves the vault into the per-(dao,protocol)
escrow PDA on deposit and returns on withdraw. This was previously gated off; it
is now the only path.

What is live on-chain:
- `nave_core::record_strategy_deposit_handler` runs
  `transfer_vault_to_escrow(...)` (`programs/nave_core/src/instructions/strategy.rs`),
  moving the deployed amount from the vault token account to the escrow PDA at
  seeds `[STRATEGY_ESCROW_SEED, dao, protocol_id]` (`token::authority =
  vault_authority`). The withdraw path reverses it via `transfer_escrow_to_vault`.
- All three adapters (`nave_kamino_adapter`, `nave_jito_adapter`,
  `nave_marginfi_adapter`) bind `strategy_escrow` by the PDA seeds
  (`seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), PROTOCOL_ID]`,
  `seeds::program = nave_core::ID`, `token::authority = vault_authority`) and
  **reject `escrow == vault`** — the old equality constraint and the
  `escrow != vault` "dead branch" in `adapter_common.rs` are gone, so the SPL
  transfer always runs.
- `execute_strategy` / `withdraw_from_strategy` pass the escrow PDA (not the vault
  token account).
- Off-chain seam (signer + frontend) derives the escrow PDA
  (`pdas.strategyEscrow`, `getStrategyEscrowPDA`, `resolveStrategyEscrow`).
  Because the on-chain side now REQUIRES the PDA, the escrow flags
  (`NAVE_ESCROW_PDA_ENABLED` / `VITE_ESCROW_PDA_ENABLED`) **must be `true`** on
  mainnet — the cutover preflight enforces this (they are no longer an optional
  gate; passing `vault_token_account` would be rejected on-chain).

Remaining verification (Phase 5 integration test): full Pending→Executed with
real SPL leaving the vault ATA into the distinct escrow PDA and a clean withdraw
reversal; reconcile `deployed_capital` + `strategy_position.current_value` to the
escrow balance.

### 2. Break-glass guardian multisig
`toggle_agents(false)` (nave_core) and `execute_strategy_direct` (nave_execution)
are gated by the Executive agent key only. Add an M-of-N guardian multisig check
(reuse `GuardianConfig` threshold logic already used for emergency flows) so a
single compromised Executive key cannot unilaterally disable agents or
break-glass execute.

### 3. Transfer proposal type (8)
`ProposalType::Transfer` has no on-chain execution handler;
`create_execution_request` only accepts `Strategy`, so Transfer proposals are
inert (not exploitable). Either add a treasury-transfer execution handler in
`nave_execution` or remove the type from the IDL + UI to avoid dead UX.

### 4. request_index cleanup (cosmetic)
`create_execution_request` sets `request.request_index =
dao_registry.proposal_count`. The ExecutionRequest PDA is keyed by
`proposal.key()`, so accounts are unique; the index is merely a label. Replace
with a dedicated monotonic execution counter if a stable per-DAO execution index
is desired.
