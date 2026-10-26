use anchor_lang::prelude::*;
use chainlink_solana::v2::read_feed_v2;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::{
    chainlink_program, chainlink_sol_usd, pyth_receiver_program, wsol_mint,
    PYTH_MAX_CONFIDENCE_BPS, PYTH_MAX_PRICE_AGE_SECS,
};
use crate::errors::NaveError;

/// Deterministic Pyth confidence-interval guard.
///
/// Pyth reports each price with a 1-sigma confidence band `conf` (same scale and
/// exponent as `price`). A very wide band means the oracle is unsure of the
/// quote; valuing the treasury off such a price would let a momentarily
/// uncertain market be used to inflate NAV or slip a deployment past the
/// constitution's caps / reserve floors. We therefore reject any price whose
/// confidence exceeds `PYTH_MAX_CONFIDENCE_BPS` (2%) of the price.
///
/// Pure integer math, no floats and no division: returns `false` (reject) when
/// `price <= 0` or when `conf * 10_000 > price * PYTH_MAX_CONFIDENCE_BPS`.
/// `u128` intermediates make overflow impossible for any `i64`/`u64` input.
pub fn confidence_within_bounds(price: i64, conf: u64) -> bool {
    if price <= 0 {
        return false;
    }
    let lhs = (conf as u128) * 10_000u128;
    let rhs = (price as u128) * (PYTH_MAX_CONFIDENCE_BPS as u128);
    lhs <= rhs
}

/// Reject a Pyth price whose confidence band is too wide (see
/// [`confidence_within_bounds`]). Surfaces the existing `StaleOracle` error so
/// callers treat an unusable-confidence price exactly like an unusable-age one.
pub fn require_confidence(price: i64, conf: u64) -> Result<()> {
    require!(
        confidence_within_bounds(price, conf),
        NaveError::StaleOracle
    );
    Ok(())
}

/// Value a non-stable balance from the supplied price account.
///
/// Wrapped SOL uses the pinned Chainlink SOL/USD feed. Every other non-stable
/// still uses its Pyth feed. The two accounts are distinguished by owner, and
/// the Chainlink account must be the directory feed for this cluster.
pub fn nonstable_micro_usd(
    mint: &Pubkey,
    pyth_feed_id: &[u8; 32],
    decimals: u8,
    amount: u64,
    price_ai: &AccountInfo,
    clock: &Clock,
) -> Result<u64> {
    if *mint == wsol_mint::ID {
        require!(
            price_ai.key() == chainlink_sol_usd::FEED && price_ai.owner == &chainlink_program::ID,
            NaveError::InvalidOracleAccount
        );
        let data = price_ai.try_borrow_data()?;
        let feed = read_feed_v2(data, price_ai.owner.to_bytes())
            .map_err(|_| error!(NaveError::StaleOracle))?;
        let round = feed
            .latest_round_data()
            .ok_or(error!(NaveError::StaleOracle))?;
        let age = clock
            .unix_timestamp
            .saturating_sub(i64::from(round.timestamp));
        require!(
            round.timestamp > 0 && age >= 0 && age <= chainlink_sol_usd::MAX_AGE_SECS,
            NaveError::StaleOracle
        );
        require!(
            round.answer > 0 && round.answer <= i128::from(i64::MAX),
            NaveError::InvalidOraclePrice
        );
        let exponent = -i32::from(feed.decimals());
        return value_usd(amount, decimals, round.answer as i64, exponent);
    }

    require!(
        price_ai.owner == &pyth_receiver_program::ID,
        NaveError::InvalidOracleAccount
    );
    let data = price_ai.try_borrow_data()?;
    let price_update = PriceUpdateV2::try_deserialize(&mut &data[..])
        .map_err(|_| error!(NaveError::InvalidOracleAccount))?;
    let p = price_update
        .get_price_no_older_than(clock, PYTH_MAX_PRICE_AGE_SECS, pyth_feed_id)
        .map_err(|_| error!(NaveError::StaleOracle))?;
    require_confidence(p.price, p.conf)?;
    value_usd(amount, decimals, p.price, p.exponent)
}

/// Convert a token `balance` (base units) into micro-USD (1e6) given a Pyth
/// price and its exponent. Pyth prices are reported as `price * 10^exponent`
/// (exponent is typically negative, e.g. -8). The asset's own `decimals`
/// normalize base units to whole tokens. All intermediate math is done in
/// `i128`/`u128` to avoid overflow; the result is clamped to `u64`.
///
///   micro_usd = balance / 10^decimals * (price * 10^exponent) * 10^6
///             = balance * price * 10^(exponent + 6 - decimals)
pub fn value_usd(balance: u64, decimals: u8, price: i64, exponent: i32) -> Result<u64> {
    require!(price > 0, NaveError::InvalidOraclePrice);
    let base = (balance as u128)
        .checked_mul(price as u128)
        .ok_or(NaveError::MathOverflow)?;
    let exp: i32 = exponent + 6 - decimals as i32;
    let scaled: u128 = if exp >= 0 {
        let factor = pow10_u128(exp as u32)?;
        base.checked_mul(factor).ok_or(NaveError::MathOverflow)?
    } else {
        let factor = pow10_u128((-exp) as u32)?;
        base.checked_div(factor).ok_or(NaveError::MathOverflow)?
    };
    u64::try_from(scaled).map_err(|_| error!(NaveError::MathOverflow))
}

/// Value a USD-pegged stablecoin `balance` at exactly $1, in micro-USD.
///
///   micro_usd = balance * 10^(6 - decimals)
pub fn value_stable(balance: u64, decimals: u8) -> Result<u64> {
    let exp: i32 = 6 - decimals as i32;
    let scaled: u128 = if exp >= 0 {
        (balance as u128)
            .checked_mul(pow10_u128(exp as u32)?)
            .ok_or(NaveError::MathOverflow)?
    } else {
        (balance as u128)
            .checked_div(pow10_u128((-exp) as u32)?)
            .ok_or(NaveError::MathOverflow)?
    };
    u64::try_from(scaled).map_err(|_| error!(NaveError::MathOverflow))
}

/// Inverse of [`value_stable`]: convert a micro-USD amount into stablecoin base
/// units. `base = usd_micro * 10^(decimals - 6)`.
pub fn usd_to_stable_base(usd_micro: u64, decimals: u8) -> Result<u64> {
    let exp: i32 = decimals as i32 - 6;
    let scaled: u128 = if exp >= 0 {
        (usd_micro as u128)
            .checked_mul(pow10_u128(exp as u32)?)
            .ok_or(NaveError::MathOverflow)?
    } else {
        (usd_micro as u128)
            .checked_div(pow10_u128((-exp) as u32)?)
            .ok_or(NaveError::MathOverflow)?
    };
    u64::try_from(scaled).map_err(|_| error!(NaveError::MathOverflow))
}

fn pow10_u128(exp: u32) -> Result<u128> {
    // 10^38 is the largest power of ten that fits in u128; reject anything that
    // could overflow rather than silently saturating.
    require!(exp <= 38, NaveError::MathOverflow);
    10u128
        .checked_pow(exp)
        .ok_or(error!(NaveError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sol_at_150_usd() {
        // 1 SOL (9 decimals) at price 150 with exponent -8 => $150.000000
        // price encoded = 150 * 10^8 = 15_000_000_000
        let micro = value_usd(1_000_000_000, 9, 15_000_000_000, -8).unwrap();
        assert_eq!(micro, 150_000_000);
    }

    #[test]
    fn usdc_stable_six_decimals() {
        // 1 USDC (6 decimals) == $1.000000
        assert_eq!(value_stable(1_000_000, 6).unwrap(), 1_000_000);
        // 1234.560000 USDC
        assert_eq!(value_stable(1_234_560_000, 6).unwrap(), 1_234_560_000);
    }

    #[test]
    fn usdt_eight_decimals_stable() {
        // 1 token with 8 decimals == $1.000000 -> divide by 100
        assert_eq!(value_stable(100_000_000, 8).unwrap(), 1_000_000);
    }

    #[test]
    fn rejects_non_positive_price() {
        assert!(value_usd(1, 9, 0, -8).is_err());
        assert!(value_usd(1, 9, -1, -8).is_err());
    }

    #[test]
    fn confidence_accepts_tight_band() {
        // price 150 (encoded 150e8), conf = 1% of price -> well under the 2% cap.
        let price = 15_000_000_000i64;
        let conf = (price as u64) / 100; // 1%
        assert!(confidence_within_bounds(price, conf));
        assert!(require_confidence(price, conf).is_ok());
    }

    #[test]
    fn confidence_accepts_exactly_at_cap() {
        // conf == 2% of price is the boundary and must be accepted (<=).
        let price = 15_000_000_000i64;
        let conf = (price as u64) * 200 / 10_000; // exactly 2%
        assert!(confidence_within_bounds(price, conf));
    }

    #[test]
    fn confidence_rejects_wide_band() {
        // conf > 2% of price -> reject.
        let price = 15_000_000_000i64;
        let conf = (price as u64) * 300 / 10_000; // 3%
        assert!(!confidence_within_bounds(price, conf));
        assert!(require_confidence(price, conf).is_err());
    }

    #[test]
    fn confidence_rejects_non_positive_price() {
        assert!(!confidence_within_bounds(0, 0));
        assert!(!confidence_within_bounds(-1, 0));
        assert!(require_confidence(0, 0).is_err());
    }

    #[test]
    fn confidence_handles_extremes_without_overflow() {
        // Max conf with max price must not panic and is far over 2%.
        assert!(!confidence_within_bounds(i64::MAX, u64::MAX));
        // Zero conf is always acceptable for any positive price.
        assert!(confidence_within_bounds(i64::MAX, 0));
    }
}
