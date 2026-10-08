use crate::constants::BPS_DENOMINATOR;
use crate::errors::BridgeError;
use anchor_lang::prelude::*;

/// Resolved fee split for a bridge transfer. All amounts are NAVE base units.
/// The fee is charged ON TOP of `net`: the user parts with `gross = net + fee`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeSplit {
    /// The amount the user actually bridges (received on the far side).
    pub net: u64,
    /// gross = net + fee (what the user parts with on the source side).
    pub gross: u64,
    /// Total fee = net * fee_bps / 10_000.
    pub fee: u64,
    /// Staking-pool share.
    pub staking: u64,
    /// Protocol-revenue share (absorbs integer rounding remainder).
    pub protocol: u64,
    /// Auto-burn share.
    pub burn: u64,
}

/// Compute the fee split for a `net` amount, charging `fee_bps` ON TOP.
///
/// - `fee   = net * fee_bps / 10_000`
/// - `staking = net * staking_bps / 10_000`
/// - `burn    = net * burn_bps / 10_000`
/// - `protocol = fee - staking - burn` (remainder-safe: any integer-division
///   dust lands in protocol revenue, guaranteeing `staking + protocol + burn ==
///   fee` exactly).
/// - `gross = net + fee`
///
/// Caller must have already validated `staking_bps + protocol_bps + burn_bps ==
/// fee_bps` (enforced when the config is written), which guarantees
/// `staking + burn <= fee` so `protocol` never underflows.
pub fn compute_fee_split(
    net: u64,
    fee_bps: u16,
    staking_bps: u16,
    burn_bps: u16,
) -> Result<FeeSplit> {
    let net_u = net as u128;
    let fee = net_u
        .checked_mul(fee_bps as u128)
        .ok_or(BridgeError::MathOverflow)?
        / BPS_DENOMINATOR;
    let staking = net_u
        .checked_mul(staking_bps as u128)
        .ok_or(BridgeError::MathOverflow)?
        / BPS_DENOMINATOR;
    let burn = net_u
        .checked_mul(burn_bps as u128)
        .ok_or(BridgeError::MathOverflow)?
        / BPS_DENOMINATOR;
    let protocol = fee
        .checked_sub(staking)
        .ok_or(BridgeError::MathOverflow)?
        .checked_sub(burn)
        .ok_or(BridgeError::MathOverflow)?;
    let gross = net_u.checked_add(fee).ok_or(BridgeError::MathOverflow)?;

    // Everything is bounded by `net + fee` which fits in u128; assert it fits
    // back into u64 (a NAVE amount) before narrowing.
    let to_u64 = |v: u128| -> Result<u64> {
        u64::try_from(v).map_err(|_| error!(BridgeError::MathOverflow))
    };

    Ok(FeeSplit {
        net,
        gross: to_u64(gross)?,
        fee: to_u64(fee)?,
        staking: to_u64(staking)?,
        protocol: to_u64(protocol)?,
        burn: to_u64(burn)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_2_5_percent_on_top() {
        // 1 NAVE (6 decimals) net, 2.5% fee split 1% / 1% / 0.5%.
        let s = compute_fee_split(1_000_000, 250, 100, 50).unwrap();
        assert_eq!(s.net, 1_000_000);
        assert_eq!(s.fee, 25_000);
        assert_eq!(s.gross, 1_025_000);
        assert_eq!(s.staking, 10_000);
        assert_eq!(s.protocol, 10_000);
        assert_eq!(s.burn, 5_000);
        assert_eq!(s.staking + s.protocol + s.burn, s.fee);
    }

    #[test]
    fn rounding_dust_lands_in_protocol() {
        // A net amount whose bps products truncate: legs must still sum to fee.
        let s = compute_fee_split(333, 250, 100, 50).unwrap();
        assert_eq!(s.staking + s.protocol + s.burn, s.fee);
        assert_eq!(s.gross, s.net + s.fee);
    }

    #[test]
    fn zero_fee_is_valid() {
        let s = compute_fee_split(1_000_000, 0, 0, 0).unwrap();
        assert_eq!(s.fee, 0);
        assert_eq!(s.gross, s.net);
        assert_eq!(s.staking + s.protocol + s.burn, 0);
    }

    /// The burn leg must equal exactly `net * burn_bps / 10_000` (it is the
    /// deflationary leg; a rounding drift here would silently over/under-burn
    /// supply). Cross-checks the smoke-script's expected 0.5% burn on 1 NAVE.
    #[test]
    fn burn_leg_is_exact_and_matches_smoke() {
        let s = compute_fee_split(1_000_000, 250, 100, 50).unwrap();
        assert_eq!(s.burn, 1_000_000u64 * 50 / 10_000); // 5_000
        assert_eq!(s.staking, 1_000_000u64 * 100 / 10_000); // 10_000
        // Protocol absorbs the remainder so the identity always holds.
        assert_eq!(s.protocol, s.fee - s.staking - s.burn);
    }

    /// Property: across a wide range of net amounts the three legs always sum to
    /// the fee exactly, gross == net + fee, and each leg equals its bps product
    /// (protocol being the remainder), i.e. NO value is created or lost.
    #[test]
    fn legs_sum_to_fee_for_many_amounts() {
        let bps = [(250u16, 100u16, 50u16), (1000, 500, 250), (1, 1, 0), (999, 333, 333)];
        for net in [0u64, 1, 7, 333, 1_000, 999_999, 1_000_000, 123_456_789, u64::MAX / 2_000] {
            for &(fee_bps, staking_bps, burn_bps) in &bps {
                let s = compute_fee_split(net, fee_bps, staking_bps, burn_bps).unwrap();
                assert_eq!(s.net, net);
                assert_eq!(s.gross, s.net + s.fee, "gross==net+fee net={net}");
                assert_eq!(s.staking + s.protocol + s.burn, s.fee, "legs sum net={net}");
                assert_eq!(s.staking, (net as u128 * staking_bps as u128 / 10_000) as u64);
                assert_eq!(s.burn, (net as u128 * burn_bps as u128 / 10_000) as u64);
                // Protocol never underflows (validated split guarantees this).
                assert_eq!(s.protocol, s.fee - s.staking - s.burn);
            }
        }
    }

    /// A net amount so large that `net * fee_bps` overflows u64 (but not the u128
    /// intermediate) still computes; a gross that would exceed u64 must error
    /// rather than wrap.
    #[test]
    fn overflow_is_rejected_not_wrapped() {
        // net near u64::MAX: net + fee overflows u64 → MathOverflow.
        let err = compute_fee_split(u64::MAX - 10, 250, 100, 50);
        assert!(err.is_err(), "gross overflow must be rejected");

        // A large-but-safe net computes with the u128 intermediates intact.
        let big = 1_000_000_000_000_000u64; // 1e15 base units
        let s = compute_fee_split(big, 250, 100, 50).unwrap();
        assert_eq!(s.staking + s.protocol + s.burn, s.fee);
        assert_eq!(s.gross, big + s.fee);
    }

    /// Dust-in-protocol invariant under asymmetric bps where staking/burn both
    /// truncate: the protocol leg absorbs the combined remainder so the identity
    /// holds to the base unit.
    #[test]
    fn protocol_absorbs_combined_truncation_dust() {
        // net=101, fee 3% (303 → fee=3), staking 1% (1), burn 1% (1): protocol=1.
        let s = compute_fee_split(101, 300, 100, 100).unwrap();
        assert_eq!(s.fee, 101 * 300 / 10_000); // 3
        assert_eq!(s.staking, 101 * 100 / 10_000); // 1
        assert_eq!(s.burn, 101 * 100 / 10_000); // 1
        assert_eq!(s.protocol, s.fee - s.staking - s.burn); // 1
        assert_eq!(s.staking + s.protocol + s.burn, s.fee);
    }
}
