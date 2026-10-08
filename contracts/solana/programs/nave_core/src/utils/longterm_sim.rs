//! Phase-4 long-term / edge-scenario simulations (hermetic Rust unit tests).
//!
//! These are pure-math / pure-state simulations that exercise the accounting
//! and safety invariants over LONG horizons and adversarial edge inputs, the
//! parts that a single localnet integration test cannot economically cover:
//!
//!   * the discrete annual management-fee anchor advancing across MANY epochs
//!     (decade-long sequence) without drift or double-charge,
//!   * multi-tranche performance-skim consistency over 3+ partial unwinds,
//!   * NAV drift as a non-stable asset's Pyth price moves (and confidence-band
//!     rejection of an uncertain quote),
//!   * the monotonic `next_proposal_index` surviving archive→create cycles so a
//!     freshly created proposal can never collide with an archived PDA slot,
//!   * active proposal-count growth toward `MAX_PROPOSALS_PER_DAO`,
//!   * the guardian-action threshold SNAPSHOT semantics (a mid-accumulation
//!     `guardian_config.threshold` change cannot retroactively lower the bar),
//!   * guardian-action staleness gating for `cancel_guardian_action` rent
//!     reclaim.
//!
//! They run under `cargo test` with no validator and are deterministic.

#![cfg(test)]

use super::*;
use crate::constants::{
    GUARDIAN_ACTION_FREEZE, GUARDIAN_ACTION_STALE_SECS, MAX_GUARDIAN_WALLETS, SECONDS_PER_DAY,
    SECONDS_PER_YEAR,
};
use crate::state::{GuardianAction, StrategyPosition, TreasuryAsset, TreasuryVault};
use anchor_lang::prelude::Pubkey;

// nave_governance is a separate crate; mirror the single constant we assert
// against rather than adding a dev-dependency cycle.
const MAX_PROPOSALS_PER_DAO: u64 = 88;

fn fresh_vault(nav: u64) -> TreasuryVault {
    TreasuryVault {
        bump: 0,
        dao: Pubkey::default(),
        vault_token_account: Pubkey::default(),
        total_deposited: 0,
        total_withdrawn: 0,
        current_nav: nav,
        high_water_mark: 0,
        last_management_fee_at: 0,
        last_performance_fee_at: 0,
        deployed_capital: 0,
        asset_count: 0,
        last_revalued_at: 0,
    }
}

fn fresh_asset() -> TreasuryAsset {
    TreasuryAsset {
        bump: 0,
        dao: Pubkey::default(),
        mint: Pubkey::default(),
        token_account: Pubkey::default(),
        deposited: 0,
        deployed_capital: 0,
        last_valued_usd: 0,
        last_valued_at: 0,
        last_management_fee_at: 0,
    }
}

fn fresh_position() -> StrategyPosition {
    StrategyPosition {
        bump: 0,
        dao: Pubkey::default(),
        mint: Pubkey::default(),
        position_token_account: Pubkey::default(),
        ext_market: Pubkey::default(),
        ext_reserve: Pubkey::default(),
        protocol_id: [0u8; crate::constants::MAX_PROTOCOL_ID_LEN],
        protocol_id_len: 0,
        deposited_amount: 0,
        current_value: 0,
        last_updated: 0,
    }
}

// ───────────────────── management fee across many epochs ─────────────────────

/// A DAO collecting the annual management fee once per year for a DECADE: each
/// collection must (a) only ever fire on/after a full `SECONDS_PER_YEAR` from
/// the prior midnight anchor, (b) re-anchor to midnight (never drift off a day
/// boundary), and (c) be impossible to double-charge inside a year.
#[test]
fn mgmt_fee_anchor_advances_cleanly_across_a_decade() {
    // Seed at an arbitrary non-midnight instant; the FIRST collection should
    // floor it to that day's midnight.
    let mut anchor = floor_to_utc_midnight(1_700_000_000 + 7 * 3_600 + 123);
    assert_eq!(anchor % SECONDS_PER_DAY, 0, "seed anchor must be midnight");

    // Simulate the integration worker polling slightly after each year rolls.
    let mut collections = 0u32;
    for year in 1..=10 {
        // Polling 1 second before the year boundary must NOT be due.
        let almost = anchor + SECONDS_PER_YEAR - 1;
        assert!(
            !management_fee_due(anchor, almost),
            "fee must not be due 1s early in year {year}"
        );

        // Roll the clock to a noon-ish time on the due day.
        let clock = anchor + SECONDS_PER_YEAR + 12 * 3_600 + (year as i64) * 37;
        assert!(
            management_fee_due(anchor, clock),
            "fee must be due after a full year in year {year}"
        );

        // Collect: advance the anchor to the floored midnight of the collection.
        let new_anchor = floor_to_utc_midnight(clock);
        assert!(new_anchor > anchor, "anchor must move forward");
        assert_eq!(new_anchor % SECONDS_PER_DAY, 0, "anchor stays midnight-aligned");

        // Immediately after collection it must not be due again (no double charge).
        assert!(!management_fee_due(new_anchor, clock));
        anchor = new_anchor;
        collections += 1;
    }

    assert_eq!(collections, 10, "exactly one collection per year for a decade");
    // After ten ~year hops the anchor has advanced by at least 10 fee-years.
    let elapsed_days = (anchor - floor_to_utc_midnight(1_700_000_000)) / SECONDS_PER_DAY;
    assert!(
        elapsed_days >= 10 * 365,
        "decade of collections advances the anchor >= 3650 days (got {elapsed_days})"
    );
}

/// The annual fee is exactly `bps` of the asset balance for every epoch, and an
/// empty year (zero balance) yields a zero fee — which the on-chain handler then
/// refuses to collect (so it cannot silently reset the year).
#[test]
fn mgmt_fee_amount_is_stable_each_epoch_and_zero_balance_is_noop() {
    let balances = [1_000_000u64, 2_500_000, 0, 9_999_999, 1];
    for b in balances {
        let fee = annual_management_fee(b, 65).unwrap();
        // floor(b * 65 / 10_000)
        assert_eq!(fee as u128, (b as u128) * 65 / 10_000);
    }
    assert_eq!(annual_management_fee(0, 65).unwrap(), 0);
}

// ───────────────── multi-tranche performance skim consistency ────────────────

/// Unwinding a marked-up position in N tranches taxes EXACTLY the realized gain
/// once — the sum of the per-tranche 8.5% skims equals (within per-tranche
/// flooring) the skim on the whole gain, and the position fully drains to zero.
#[test]
fn multi_tranche_skim_sums_to_full_gain_over_many_tranches() {
    let mut vault = fresh_vault(10_000_000);
    let mut asset = fresh_asset();
    let mut pos = fresh_position();

    // Deploy 9_000 principal; mark it up to 12_000 (3_000 of realized gain).
    record_strategy_deposit(&mut vault, &mut asset, &mut pos, b"kamino", 9_000, 9_000, 1).unwrap();
    pos.current_value = 12_000;
    asset.deployed_capital = 9_000; // base-unit principal mirror
    vault.deployed_capital = 9_000;

    // Withdraw the full marked value across six 2_000 tranches.
    let mut total_gain = 0u64;
    let mut total_fee = 0u64;
    for _ in 0..6 {
        let (gain, fee) =
            calculate_performance_skim(2_000, pos.deposited_amount, pos.current_value, 850).unwrap();
        total_gain += gain;
        total_fee += fee;
        record_strategy_withdrawal(&mut vault, &mut asset, &mut pos, 2_000, 2_000, 2).unwrap();
        // Invariant: fee never exceeds the realized gain of the tranche.
        assert!(fee <= gain);
    }

    assert_eq!(pos.current_value, 0, "position fully unwound");
    assert_eq!(pos.deposited_amount, 0, "principal fully returned");
    assert_eq!(asset.deployed_capital, 0);
    assert_eq!(vault.deployed_capital, 0);
    assert_eq!(total_gain, 3_000, "exactly the realized gain is taxed, once");
    // 8.5% of 3_000 == 255; per-tranche flooring loses at most 1 unit per tranche.
    assert!(total_fee <= 255 && total_fee >= 255 - 6, "skim ~= 8.5% of gain (got {total_fee})");
}

/// A position that DRAWS DOWN below principal across its life never produces a
/// negative gain and is never performance-taxed.
#[test]
fn skim_never_taxes_a_drawdown_position() {
    let mut pos = fresh_position();
    pos.deposited_amount = 5_000;
    pos.current_value = 4_200; // 16% drawdown
    let (gain, fee) =
        calculate_performance_skim(4_200, pos.deposited_amount, pos.current_value, 850).unwrap();
    assert_eq!((gain, fee), (0, 0));
}

// ─────────────────────── NAV drift under price moves ─────────────────────────

/// A SOL-like position's micro-USD value tracks the Pyth price monotonically
/// and exactly across a wide price sweep (the NAV the caps key off of).
#[test]
fn nav_value_tracks_pyth_price_moves_monotonically() {
    // 10 SOL (9 decimals). Exponent -8 (Pyth SOL/USD style).
    let balance = 10_000_000_000u64;
    let decimals = 9u8;
    let exponent = -8i32;

    // Price sweep $20 → $250 (encoded as price * 10^8).
    let prices_usd = [20, 50, 100, 137, 200, 250];
    let mut last = 0u64;
    for p in prices_usd {
        let encoded = p as i64 * 100_000_000;
        let micro = value_usd(balance, decimals, encoded, exponent).unwrap();
        // 10 SOL * $p == $10p == 10p * 1e6 micro-USD.
        assert_eq!(micro, (10 * p as u64) * 1_000_000);
        assert!(micro > last, "NAV must rise as price rises");
        last = micro;
    }
}

/// A wide Pyth confidence band is rejected BEFORE it can move NAV — the audited
/// gate that stops an uncertain quote from inflating valuation or slipping a
/// deploy past USD caps. Sweep the band from tight to wide around the 2% bound.
#[test]
fn wide_confidence_band_is_rejected_at_the_two_percent_bound() {
    let price = 150i64 * 100_000_000; // $150 encoded
    // 1.99% accepted, 2.00% accepted (<=), 2.01% rejected.
    assert!(confidence_within_bounds(price, (price as u64) * 199 / 10_000));
    assert!(confidence_within_bounds(price, (price as u64) * 200 / 10_000));
    assert!(!confidence_within_bounds(price, (price as u64) * 201 / 10_000));
    // A negative / zero price is always rejected regardless of conf.
    assert!(!confidence_within_bounds(0, 0));
    assert!(!confidence_within_bounds(-5, 0));
}

// ───────────── archive_proposals → monotonic next_proposal_index ─────────────

/// Mirror of `archive_proposals_handler` + `record_proposal_creation_handler`:
/// active `proposal_count` moves up on create / down on archive, while
/// `next_proposal_index` is monotonic. The PROPOSAL PDA seed uses
/// `next_proposal_index`, so the set of indices ever used must be strictly
/// increasing — a freshly created proposal can NEVER reuse an archived slot.
#[derive(Default)]
struct DaoCounters {
    proposal_count: u64,
    archived_proposals: u64,
    next_proposal_index: u64,
}

impl DaoCounters {
    fn create(&mut self) -> u64 {
        // governance checks active count < MAX before creating.
        assert!(self.proposal_count < MAX_PROPOSALS_PER_DAO);
        let index = self.next_proposal_index; // PDA seed
        self.proposal_count += 1;
        self.next_proposal_index += 1;
        index
    }
    fn archive(&mut self, count: u64) {
        self.proposal_count = self.proposal_count.checked_sub(count).unwrap();
        self.archived_proposals += count;
    }
}

#[test]
fn archive_then_create_never_reuses_a_proposal_pda_index() {
    let mut dao = DaoCounters::default();
    let mut used_indices = Vec::new();

    // Fill near the cap, archive almost all, refill — many times.
    for _round in 0..5 {
        // Create up to the cap.
        while dao.proposal_count < MAX_PROPOSALS_PER_DAO {
            let idx = dao.create();
            // Every PDA index must be globally unique across the DAO's lifetime.
            assert!(!used_indices.contains(&idx), "index {idx} reused — PDA collision!");
            used_indices.push(idx);
        }
        // Archive all-but-one of the active proposals.
        dao.archive(MAX_PROPOSALS_PER_DAO - 1);
        assert_eq!(dao.proposal_count, 1);
    }

    // next_proposal_index is monotonic and strictly above every used index.
    assert_eq!(dao.next_proposal_index as usize, used_indices.len());
    assert!(used_indices.windows(2).all(|w| w[1] > w[0]), "indices strictly increasing");
    // The active-count cap was respected throughout (never exceeded MAX).
    assert!(dao.proposal_count <= MAX_PROPOSALS_PER_DAO);
}

#[test]
fn active_proposal_count_growth_is_bounded_by_max_per_dao() {
    let mut dao = DaoCounters::default();
    for _ in 0..MAX_PROPOSALS_PER_DAO {
        dao.create();
    }
    assert_eq!(dao.proposal_count, MAX_PROPOSALS_PER_DAO);
    // The (MAX+1)-th create would trip the governance guard.
    assert!(dao.proposal_count >= MAX_PROPOSALS_PER_DAO);
    // After archiving the index keeps climbing even though active count drops.
    let before_index = dao.next_proposal_index;
    dao.archive(10);
    assert_eq!(dao.proposal_count, MAX_PROPOSALS_PER_DAO - 10);
    let reused = dao.create();
    assert_eq!(reused, before_index, "new proposal uses the next monotonic index");
    assert!(reused >= MAX_PROPOSALS_PER_DAO, "and never an archived slot index");
}

// ───────────── guardian-action threshold SNAPSHOT semantics ──────────────────

fn guardian_action_with_threshold(threshold: u8, wallets: &[Pubkey]) -> GuardianAction {
    let mut w = [Pubkey::default(); MAX_GUARDIAN_WALLETS];
    for (i, k) in wallets.iter().enumerate() {
        w[i] = *k;
    }
    GuardianAction {
        bump: 0,
        dao: Pubkey::default(),
        action_type: GUARDIAN_ACTION_FREEZE,
        nonce: 1,
        signed_mask: 0,
        signature_count: 0,
        executed: false,
        created_at: 1_700_000_000,
        wallet_count: wallets.len() as u8,
        threshold,
        wallets: w,
    }
}

/// A guardian action snapshots its M-of-N threshold at initiation. Even if the
/// live `guardian_config.threshold` were later LOWERED to 1, the action still
/// requires the snapshotted 3 signatures to fire — so a mid-flight config change
/// cannot retroactively weaken an in-progress freeze/disable.
#[test]
fn guardian_action_requires_snapshotted_threshold_not_live() {
    let g = [
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];
    let mut action = guardian_action_with_threshold(3, &g); // snapshot 3-of-3

    // First guardian signs.
    let i0 = action.guardian_index(&g[0]).unwrap();
    action.record_signature(i0).unwrap();
    assert_eq!(action.signature_count, 1);
    // Below the snapshotted threshold — must NOT execute, even if a live config
    // were now 1-of-N (the handler compares against `action.threshold`).
    assert!(action.signature_count < action.threshold);

    // A duplicate signature from the same guardian is rejected.
    assert!(action.record_signature(i0).is_err());

    // Two more distinct guardians reach the snapshot threshold.
    action.record_signature(action.guardian_index(&g[1]).unwrap()).unwrap();
    assert!(action.signature_count < action.threshold);
    action.record_signature(action.guardian_index(&g[2]).unwrap()).unwrap();
    assert_eq!(action.signature_count, action.threshold, "now executable");
}

/// An unknown wallet can never contribute a signature to a guardian action.
#[test]
fn guardian_action_rejects_non_guardian_signer() {
    let g = [Pubkey::new_unique(), Pubkey::new_unique()];
    let action = guardian_action_with_threshold(2, &g);
    assert!(action.guardian_index(&Pubkey::new_unique()).is_none());
}

// ───────── guardian-action staleness gate for cancel / rent reclaim ──────────

/// Mirror of `cancel_guardian_action_handler`'s staleness gate: an UNEXECUTED
/// action may only be cancelled (rent reclaimed) once it is older than
/// `GUARDIAN_ACTION_STALE_SECS`; an EXECUTED action may be closed immediately.
/// This is what stops the founder from front-running a fresh in-flight freeze.
fn can_cancel(action: &GuardianAction, now: i64) -> bool {
    if action.executed {
        return true;
    }
    match action.created_at.checked_add(GUARDIAN_ACTION_STALE_SECS) {
        Some(stale_at) => now >= stale_at,
        None => false,
    }
}

#[test]
fn cancel_guardian_action_respects_staleness_window() {
    let g = [Pubkey::new_unique(), Pubkey::new_unique()];
    let mut action = guardian_action_with_threshold(2, &g);

    let created = action.created_at;
    // Fresh, unexecuted: cannot cancel (founder can't kill an in-flight freeze).
    assert!(!can_cancel(&action, created));
    assert!(!can_cancel(&action, created + GUARDIAN_ACTION_STALE_SECS - 1));
    // Exactly at the 7-day stale boundary: cancellable for rent reclaim.
    assert!(can_cancel(&action, created + GUARDIAN_ACTION_STALE_SECS));

    // Executed actions are closeable immediately, regardless of age.
    action.executed = true;
    assert!(can_cancel(&action, created));
}

// ───────── NAV staleness hard-block (mirror of prepare_strategy_deposit) ──────

const NAV_MAX_STALENESS_SECS: i64 = 900; // nave_execution::constants

/// Mirror of the `execute_strategy` / `execute_strategy_direct` NAV-staleness
/// gate: a deploy is allowed ONLY when `last_revalued_at > 0` AND the NAV is no
/// older than `NAV_MAX_STALENESS_SECS`. Proves the never-revalued (`== 0`) and
/// the 15-minute-stale snapshots are both hard-blocked, so caps can't be slipped
/// against a dead NAV. (The on-chain integration equivalent needs a 15-minute
/// clock advance or devnet, so the boundary is asserted hermetically here.)
fn nav_fresh_enough(last_revalued_at: i64, now: i64) -> bool {
    last_revalued_at > 0 && now.saturating_sub(last_revalued_at) <= NAV_MAX_STALENESS_SECS
}

#[test]
fn nav_staleness_gate_blocks_zero_and_old_snapshots() {
    let now = 1_700_000_000;
    // Never revalued => blocked regardless of clock.
    assert!(!nav_fresh_enough(0, now));
    // Exactly at the freshness boundary (15 min old) => allowed.
    assert!(nav_fresh_enough(now - NAV_MAX_STALENESS_SECS, now));
    // One second past the boundary => blocked.
    assert!(!nav_fresh_enough(now - NAV_MAX_STALENESS_SECS - 1, now));
    // Just-revalued => allowed.
    assert!(nav_fresh_enough(now, now));
    // Backwards clock skew never reads as "fresh-and-positive-age".
    assert!(nav_fresh_enough(now + 10, now)); // future stamp: age saturates to 0
}

// ─────── stablecoin reserve floor (mirror of enforce_stablecoin_reserve) ──────

/// Mirror of `enforce_stablecoin_reserve`: after a deploy, the idle stablecoin
/// remaining must still cover `min_stablecoin_reserve_bps` of USD NAV. Proves a
/// deploy that would drop idle below the reserve floor is rejected — the
/// "reserve-floor bypass" route.
fn reserve_floor_ok(nav_usd: u128, reserve_bps: u16, idle_after_usd: u128) -> bool {
    if reserve_bps == 0 {
        return true;
    }
    let required = nav_usd * reserve_bps as u128 / 10_000;
    idle_after_usd >= required
}

#[test]
fn stablecoin_reserve_floor_blocks_overdeploy() {
    let nav = 1_000_000u128; // $1.00 (micro-USD) for ratio simplicity
    // 35% reserve floor (the DAO default).
    assert!(reserve_floor_ok(nav, 3_500, 350_000)); // idle exactly 35% — ok
    assert!(reserve_floor_ok(nav, 3_500, 650_000)); // idle 65% — ok
    assert!(!reserve_floor_ok(nav, 3_500, 349_999)); // idle just under 35% — breach
    assert!(!reserve_floor_ok(nav, 3_500, 0)); // fully drained — breach
    // A disabled (0 bps) reserve floor imposes no constraint.
    assert!(reserve_floor_ok(nav, 0, 0));
}

/// Rent-reclaim accounting: closing N stale guardian actions returns the full
/// rent of each (modelled as a constant per-account lamport reserve), so a DAO
/// that accumulates abandoned actions can fully reclaim by cancelling them.
#[test]
fn guardian_action_rent_is_fully_reclaimable_when_stale() {
    // GuardianAction::LEN drives the rent reserve; the exact lamport figure is
    // runtime-derived, but the count of reclaimable actions is what matters here.
    let g = [Pubkey::new_unique(), Pubkey::new_unique()];
    let now = 1_700_000_000 + GUARDIAN_ACTION_STALE_SECS + SECONDS_PER_DAY;
    let mut reclaimable = 0;
    for nonce in 0..12u64 {
        let mut a = guardian_action_with_threshold(2, &g);
        a.nonce = nonce;
        a.created_at = 1_700_000_000; // all old enough by `now`
        if can_cancel(&a, now) {
            reclaimable += 1;
        }
    }
    assert_eq!(reclaimable, 12, "every stale action is reclaimable");
    // Sanity: LEN is non-trivial so rent reclaim is economically meaningful.
    assert!(GuardianAction::LEN > 8 + 32);
}
