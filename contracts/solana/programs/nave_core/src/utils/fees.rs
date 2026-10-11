use anchor_lang::prelude::*;

use crate::constants::{BPS_DENOMINATOR, SECONDS_PER_DAY, SECONDS_PER_YEAR};
use crate::errors::NaveError;

// ─── Performance fee: 15% of realized yield, skimmed on withdrawal ───────────
//
// The performance fee is no longer a separate high-water-mark instruction (that
// model was inert — Finding C). Instead, every strategy withdrawal computes the
// realized-yield portion of the unwound `amount` and skims `fee_bps` of it
// straight to the protocol revenue wallet, in the withdrawn asset, before the
// remainder credits the treasury vault.
//
// Gain attribution is proportional to the position's current mark: of an
// `amount` withdrawn from a position with `deposited_amount` principal and
// `current_value` marked value (`current_value >= amount`, enforced by the
// caller), the principal being unwound is `amount * deposited_amount /
// current_value` and the realized gain is the remainder. Principal is never
// taxed; only the gain is.

/// Compute the realized-yield (gain) portion of a `amount`-unit withdrawal and
/// the performance-fee skim taken from that gain.
///
/// Returns `(gain_base, fee_base)` in the withdrawn asset's base units, where
/// `gain_base` is the realized yield in the withdrawal and `fee_base =
/// gain_base * fee_bps / 10_000`. Both are `0` when the position is at or below
/// principal (no realized gain), when `fee_bps == 0`, or when `amount == 0`.
///
/// Invariants (all upheld here): `fee_base <= gain_base <= amount`. The caller
/// must guarantee `amount <= current_value`.
pub fn calculate_performance_skim(
    amount: u64,
    deposited_amount: u64,
    current_value: u64,
    fee_bps: u16,
) -> Result<(u64, u64)> {
    if amount == 0 || fee_bps == 0 || current_value == 0 || current_value <= deposited_amount {
        return Ok((0, 0));
    }

    // Proportional realized gain: amount * (current_value - deposited_amount) / current_value.
    let unrealized_excess = (current_value as u128)
        .checked_sub(deposited_amount as u128)
        .ok_or(NaveError::MathOverflow)?;
    let gain = (amount as u128)
        .checked_mul(unrealized_excess)
        .ok_or(NaveError::MathOverflow)?
        .checked_div(current_value as u128)
        .ok_or(NaveError::MathOverflow)?;

    let fee = gain
        .checked_mul(fee_bps as u128)
        .ok_or(NaveError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(NaveError::MathOverflow)?;

    let gain_u64 = u64::try_from(gain).map_err(|_| NaveError::MathOverflow)?;
    let fee_u64 = u64::try_from(fee).map_err(|_| NaveError::MathOverflow)?;
    // Defensive: the skim can never exceed the gain, and the gain can never
    // exceed the withdrawn amount (since (cv - dep) <= cv when dep >= 0).
    debug_assert!(fee_u64 <= gain_u64 && gain_u64 <= amount);
    Ok((gain_u64, fee_u64))
}

// ─── Management fee: canonical rate is 0 ─────────────────────────────────────
//
// The annual-due window and the `balance * bps / 10_000` helper remain so
// older call sites compile. The charged rate is 0, including after a full
// year, so `collect_management_fee` transfers nothing and does not advance
// the anchor.

/// Floor a unix timestamp to the start of its UTC day (00:00:00 UTC). Used to
/// anchor the annual management-fee cycle to a midnight boundary so that
/// successive periods stay midnight-aligned (a fee year is exactly 365 whole
/// days). `rem_euclid` keeps the floor correct for any (incl. negative) input.
pub fn floor_to_utc_midnight(ts: i64) -> i64 {
    ts - ts.rem_euclid(SECONDS_PER_DAY)
}

/// Whether the discrete annual management fee is due: at least one full
/// `SECONDS_PER_YEAR` has elapsed since the anchor. Returns `false` on backwards
/// clock skew (`now < last_collected_at`).
pub fn management_fee_due(last_collected_at: i64, now: i64) -> bool {
    match last_collected_at.checked_add(SECONDS_PER_YEAR) {
        Some(due_at) => now >= due_at,
        None => false,
    }
}

/// Compute the annual management fee on a treasury asset `balance` (base units)
/// at `fee_bps`. This is `balance * fee_bps / 10_000`; the due-window check is a
/// separate gate (`management_fee_due`).
pub fn annual_management_fee(balance: u64, fee_bps: u16) -> Result<u64> {
    if balance == 0 || fee_bps == 0 {
        return Ok(0);
    }
    let fee = (balance as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(NaveError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(NaveError::MathOverflow)?;
    u64::try_from(fee).map_err(|_| NaveError::MathOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{DEFAULT_MANAGEMENT_FEE_BPS, DEFAULT_PERFORMANCE_FEE_BPS};

    // ───── performance fee: 15% (1500 bps) of realized yield ─────────────────

    #[test]
    fn perf_skim_taxes_only_the_gain_not_principal() {
        // Position: 1_000 principal marked up to 1_100 (100 of gain). Fully
        // withdrawing 1_100: gain = 1_100 * (1_100 - 1_000) / 1_100 = 100.
        // fee = 100 * 1500 / 10_000 = 15.
        let (gain, fee) =
            calculate_performance_skim(1_100, 1_000, 1_100, DEFAULT_PERFORMANCE_FEE_BPS).unwrap();
        assert_eq!(gain, 100);
        assert_eq!(fee, 15);
    }

    #[test]
    fn perf_skim_zero_when_no_yield() {
        // current_value == deposited_amount -> no realized gain -> no fee.
        let (gain, fee) =
            calculate_performance_skim(1_000, 1_000, 1_000, DEFAULT_PERFORMANCE_FEE_BPS).unwrap();
        assert_eq!((gain, fee), (0, 0));
        // current_value below principal (drawdown) is likewise untaxed.
        let (gain, fee) =
            calculate_performance_skim(900, 1_000, 900, DEFAULT_PERFORMANCE_FEE_BPS).unwrap();
        assert_eq!((gain, fee), (0, 0));
    }

    #[test]
    fn perf_skim_zero_when_bps_or_amount_zero() {
        assert_eq!(
            calculate_performance_skim(1_100, 1_000, 1_100, 0).unwrap(),
            (0, 0)
        );
        assert_eq!(
            calculate_performance_skim(0, 1_000, 1_100, DEFAULT_PERFORMANCE_FEE_BPS).unwrap(),
            (0, 0)
        );
    }

    #[test]
    fn perf_skim_is_proportional_on_partial_withdrawal() {
        // Position 1_000 principal marked to 1_200 (200 gain). Withdraw half the
        // marked value (600): gain = 600 * 200 / 1_200 = 100; fee = 100*1500/10000 = 15.
        let (gain, fee) =
            calculate_performance_skim(600, 1_000, 1_200, DEFAULT_PERFORMANCE_FEE_BPS).unwrap();
        assert_eq!(gain, 100);
        assert_eq!(fee, 15);
    }

    #[test]
    fn perf_skim_multi_tranche_sums_to_full_gain() {
        // Withdrawing the marked value in two tranches taxes the same total gain
        // as a single full withdrawal would. Position 1_000 -> 1_200 (200 gain).
        // Tranche A: withdraw 600 of 1_200 -> gain 100.
        let (gain_a, fee_a) =
            calculate_performance_skim(600, 1_000, 1_200, DEFAULT_PERFORMANCE_FEE_BPS).unwrap();
        // After A the position is marked 600 with principal 500 (proportional
        // unwind: 600 * 1000/1200 = 500 principal left). Tranche B withdraws the
        // remaining 600 -> gain 600 * (600-500)/600 = 100.
        let (gain_b, fee_b) =
            calculate_performance_skim(600, 500, 600, DEFAULT_PERFORMANCE_FEE_BPS).unwrap();
        assert_eq!(gain_a + gain_b, 200); // entire realized gain taxed once
        assert_eq!(fee_a + fee_b, 30); // 15 + 15
    }

    #[test]
    fn perf_skim_full_rate_takes_entire_gain() {
        // 10_000 bps == 100% skim: the whole gain is taken, principal untouched.
        let (gain, fee) = calculate_performance_skim(1_100, 1_000, 1_100, 10_000).unwrap();
        assert_eq!(gain, 100);
        assert_eq!(fee, 100);
        assert!(fee <= gain && gain <= 1_100);
    }

    #[test]
    fn perf_skim_pure_yield_position() {
        // Degenerate position with zero recorded principal (all marked value is
        // gain): the entire withdrawal is gain.
        let (gain, fee) =
            calculate_performance_skim(500, 0, 500, DEFAULT_PERFORMANCE_FEE_BPS).unwrap();
        assert_eq!(gain, 500);
        assert_eq!(fee, 75); // 500 * 1500 / 10_000 = 75
    }

    // ───── management fee: canonical 0 bps, including after a full year ──────

    #[test]
    fn mgmt_fee_not_due_before_a_full_year() {
        let anchor = floor_to_utc_midnight(1_700_000_000);
        assert!(!management_fee_due(anchor, anchor)); // same instant
        assert!(!management_fee_due(anchor, anchor + SECONDS_PER_YEAR - 1)); // 1s short
    }

    #[test]
    fn mgmt_fee_due_exactly_at_one_year() {
        let anchor = floor_to_utc_midnight(1_700_000_000);
        assert!(management_fee_due(anchor, anchor + SECONDS_PER_YEAR));
        assert!(management_fee_due(
            anchor,
            anchor + SECONDS_PER_YEAR + 86_400
        ));
    }

    #[test]
    fn mgmt_fee_not_due_on_backwards_clock() {
        let anchor = 1_700_000_000;
        assert!(!management_fee_due(anchor, anchor - 100));
    }

    #[test]
    fn mgmt_fee_is_zero_even_after_a_year() {
        let anchor = floor_to_utc_midnight(1_700_000_000);
        assert!(management_fee_due(anchor, anchor + SECONDS_PER_YEAR));
        assert_eq!(DEFAULT_MANAGEMENT_FEE_BPS, 0);
        assert_eq!(DEFAULT_PERFORMANCE_FEE_BPS, 1500);
        // A full year does not create a charge at the canonical rate.
        assert_eq!(
            annual_management_fee(1_000_000, DEFAULT_MANAGEMENT_FEE_BPS).unwrap(),
            0
        );
        assert_eq!(
            annual_management_fee(500_000_000, DEFAULT_MANAGEMENT_FEE_BPS).unwrap(),
            0
        );
        assert_eq!(
            annual_management_fee(0, DEFAULT_MANAGEMENT_FEE_BPS).unwrap(),
            0
        );
    }

    #[test]
    fn mgmt_fee_anchor_advances_to_midnight_and_blocks_double_charge() {
        // A noon-UTC collection time floors to that day's midnight, so the next
        // period is due exactly one year (365 whole days) later at midnight.
        let day0_midnight = 1_700_000_000 - (1_700_000_000 % 86_400); // 1_699_920_000
        let collected_at = day0_midnight + 12 * 3_600; // noon
        let new_anchor = floor_to_utc_midnight(collected_at);
        assert_eq!(new_anchor, day0_midnight);
        assert_eq!(new_anchor % SECONDS_PER_DAY, 0); // midnight-aligned
                                                     // Immediately after collection the fee is not due again (no double-charge
                                                     // within the year) until a full year passes from the new anchor.
        assert!(!management_fee_due(new_anchor, collected_at));
        assert!(!management_fee_due(
            new_anchor,
            new_anchor + SECONDS_PER_YEAR - 1
        ));
        assert!(management_fee_due(
            new_anchor,
            new_anchor + SECONDS_PER_YEAR
        ));
    }

    #[test]
    fn floor_to_utc_midnight_is_idempotent_and_handles_negative() {
        let m = floor_to_utc_midnight(1_700_050_000);
        assert_eq!(m % SECONDS_PER_DAY, 0);
        assert_eq!(floor_to_utc_midnight(m), m);
        // Negative timestamps floor downward (toward -inf), staying day-aligned.
        assert_eq!(floor_to_utc_midnight(-1) % SECONDS_PER_DAY, 0);
        assert!(floor_to_utc_midnight(-1) <= -1);
    }
}
