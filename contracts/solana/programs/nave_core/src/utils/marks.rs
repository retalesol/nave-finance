//! On-chain position marks. Each reader takes the raw venue account bytes and
//! returns the underlying value of `receipt_amount` receipt tokens. Layout
//! offsets are checked against the expected mints, so a wrong offset or a
//! substituted account fails closed instead of producing a bad mark.

use anchor_lang::prelude::*;

use crate::constants::MAX_POSITION_DRIFT_BPS_PER_DAY;
use crate::errors::NaveError;

const SECONDS_PER_DAY: u128 = 86_400;
const BPS: u128 = 10_000;

// klend `Reserve` (8-byte discriminator included).
const KAMINO_LIQUIDITY_MINT: usize = 128;
const KAMINO_AVAILABLE_AMOUNT: usize = 224;
const KAMINO_BORROWED_SF: usize = 232;
const KAMINO_PROTOCOL_FEES_SF: usize = 344;
const KAMINO_REFERRER_FEES_SF: usize = 360;
const KAMINO_PENDING_REFERRER_FEES_SF: usize = 376;
const KAMINO_COLLATERAL_MINT: usize = 2560;
const KAMINO_COLLATERAL_SUPPLY: usize = 2592;
const KAMINO_FRACTION_BITS: u32 = 60;

// Jupiter Lend `Lending`.
const JUPITER_MINT: usize = 8;
const JUPITER_F_TOKEN_MINT: usize = 40;
const JUPITER_TOKEN_EXCHANGE_PRICE: usize = 115;
const JUPITER_EXCHANGE_PRICE_PRECISION: u128 = 1_000_000_000_000;

// SPL stake pool `StakePool` (no discriminator; byte 0 is account_type).
const STAKE_POOL_MINT: usize = 162;
const STAKE_POOL_TOTAL_LAMPORTS: usize = 258;
const STAKE_POOL_TOKEN_SUPPLY: usize = 266;

fn read_pubkey(data: &[u8], off: usize) -> Result<Pubkey> {
    let bytes: [u8; 32] = data
        .get(off..off + 32)
        .ok_or(NaveError::PositionMarkSourceMismatch)?
        .try_into()
        .map_err(|_| NaveError::PositionMarkSourceMismatch)?;
    Ok(Pubkey::new_from_array(bytes))
}

fn read_u64(data: &[u8], off: usize) -> Result<u64> {
    let bytes: [u8; 8] = data
        .get(off..off + 8)
        .ok_or(NaveError::PositionMarkSourceMismatch)?
        .try_into()
        .map_err(|_| NaveError::PositionMarkSourceMismatch)?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_u128(data: &[u8], off: usize) -> Result<u128> {
    let bytes: [u8; 16] = data
        .get(off..off + 16)
        .ok_or(NaveError::PositionMarkSourceMismatch)?
        .try_into()
        .map_err(|_| NaveError::PositionMarkSourceMismatch)?;
    Ok(u128::from_le_bytes(bytes))
}

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(NaveError::MathOverflow))
}

/// Underlying value of `collateral` kTokens in a klend reserve.
pub fn kamino_collateral_value(
    reserve: &[u8],
    liquidity_mint: &Pubkey,
    collateral_mint: &Pubkey,
    collateral: u64,
) -> Result<u64> {
    require!(
        read_pubkey(reserve, KAMINO_LIQUIDITY_MINT)? == *liquidity_mint
            && read_pubkey(reserve, KAMINO_COLLATERAL_MINT)? == *collateral_mint,
        NaveError::PositionMarkSourceMismatch
    );
    if collateral == 0 {
        return Ok(0);
    }
    let supply = read_u64(reserve, KAMINO_COLLATERAL_SUPPLY)? as u128;
    require!(supply > 0, NaveError::PositionMarkSourceMismatch);
    let available_sf = (read_u64(reserve, KAMINO_AVAILABLE_AMOUNT)? as u128) << KAMINO_FRACTION_BITS;
    let fees_sf = read_u128(reserve, KAMINO_PROTOCOL_FEES_SF)?
        .saturating_add(read_u128(reserve, KAMINO_REFERRER_FEES_SF)?)
        .saturating_add(read_u128(reserve, KAMINO_PENDING_REFERRER_FEES_SF)?);
    let total_liquidity = available_sf
        .checked_add(read_u128(reserve, KAMINO_BORROWED_SF)?)
        .ok_or(NaveError::MathOverflow)?
        .saturating_sub(fees_sf)
        >> KAMINO_FRACTION_BITS;
    let value = (collateral as u128)
        .checked_mul(total_liquidity)
        .ok_or(NaveError::MathOverflow)?
        / supply;
    to_u64(value)
}

/// Underlying value of `f_tokens` Jupiter Lend fTokens. Returns the fToken
/// mint so the caller can bind the receipt account to it.
pub fn jupiter_ftoken_value(lending: &[u8], mint: &Pubkey, f_tokens: u64) -> Result<(u64, Pubkey)> {
    require!(
        read_pubkey(lending, JUPITER_MINT)? == *mint,
        NaveError::PositionMarkSourceMismatch
    );
    let f_token_mint = read_pubkey(lending, JUPITER_F_TOKEN_MINT)?;
    let price = read_u64(lending, JUPITER_TOKEN_EXCHANGE_PRICE)? as u128;
    require!(price > 0, NaveError::PositionMarkSourceMismatch);
    let value = (f_tokens as u128)
        .checked_mul(price)
        .ok_or(NaveError::MathOverflow)?
        / JUPITER_EXCHANGE_PRICE_PRECISION;
    Ok((to_u64(value)?, f_token_mint))
}

/// Lamport value of `pool_tokens` in an SPL stake pool.
pub fn stake_pool_token_value(pool: &[u8], pool_mint: &Pubkey, pool_tokens: u64) -> Result<u64> {
    require!(
        read_pubkey(pool, STAKE_POOL_MINT)? == *pool_mint,
        NaveError::PositionMarkSourceMismatch
    );
    if pool_tokens == 0 {
        return Ok(0);
    }
    let supply = read_u64(pool, STAKE_POOL_TOKEN_SUPPLY)? as u128;
    require!(supply > 0, NaveError::PositionMarkSourceMismatch);
    let lamports = read_u64(pool, STAKE_POOL_TOTAL_LAMPORTS)? as u128;
    to_u64((pool_tokens as u128).checked_mul(lamports).ok_or(NaveError::MathOverflow)? / supply)
}

/// Apply the upward drift cap. Downward moves pass through unbounded; upward
/// moves are capped at `MAX_POSITION_DRIFT_BPS_PER_DAY` of
/// max(current, principal) per elapsed day since the last mark.
pub fn capped_mark(
    current_value: u64,
    principal: u64,
    last_updated: i64,
    now: i64,
    observed: u64,
) -> Result<u64> {
    if observed <= current_value {
        return Ok(observed);
    }
    let base = current_value.max(principal) as u128;
    require!(base > 0, NaveError::PositionMarkNoBase);
    let elapsed = now.saturating_sub(last_updated).max(0) as u128;
    let allowed = base
        .checked_mul(MAX_POSITION_DRIFT_BPS_PER_DAY)
        .and_then(|v| v.checked_mul(elapsed))
        .ok_or(NaveError::MathOverflow)?
        / (BPS * SECONDS_PER_DAY);
    let cap = (current_value as u128).max(base).saturating_add(allowed);
    to_u64((observed as u128).min(cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_pk(buf: &mut [u8], off: usize, pk: &Pubkey) {
        buf[off..off + 32].copy_from_slice(pk.as_ref());
    }

    #[test]
    fn kamino_value_uses_exchange_rate() {
        let mint = Pubkey::new_unique();
        let cmint = Pubkey::new_unique();
        let mut r = vec![0u8; 8624];
        put_pk(&mut r, KAMINO_LIQUIDITY_MINT, &mint);
        put_pk(&mut r, KAMINO_COLLATERAL_MINT, &cmint);
        r[KAMINO_AVAILABLE_AMOUNT..KAMINO_AVAILABLE_AMOUNT + 8].copy_from_slice(&900u64.to_le_bytes());
        r[KAMINO_BORROWED_SF..KAMINO_BORROWED_SF + 16].copy_from_slice(&((200u128) << 60).to_le_bytes());
        r[KAMINO_COLLATERAL_SUPPLY..KAMINO_COLLATERAL_SUPPLY + 8].copy_from_slice(&1000u64.to_le_bytes());
        assert_eq!(kamino_collateral_value(&r, &mint, &cmint, 100).unwrap(), 110);
        assert!(kamino_collateral_value(&r, &cmint, &mint, 100).is_err());
    }

    #[test]
    fn jupiter_value_uses_exchange_price() {
        let mint = Pubkey::new_unique();
        let fmint = Pubkey::new_unique();
        let mut l = vec![0u8; 196];
        put_pk(&mut l, JUPITER_MINT, &mint);
        put_pk(&mut l, JUPITER_F_TOKEN_MINT, &fmint);
        l[JUPITER_TOKEN_EXCHANGE_PRICE..JUPITER_TOKEN_EXCHANGE_PRICE + 8]
            .copy_from_slice(&1_050_000_000_000u64.to_le_bytes());
        let (v, f) = jupiter_ftoken_value(&l, &mint, 1_000_000).unwrap();
        assert_eq!(v, 1_050_000);
        assert_eq!(f, fmint);
        assert!(jupiter_ftoken_value(&l, &fmint, 1).is_err());
    }

    #[test]
    fn drift_cap_bounds_upward_only() {
        // 1 day at 100 bps on a 1_000_000 base allows +10_000.
        assert_eq!(capped_mark(1_000_000, 1_000_000, 0, 86_400, 2_000_000).unwrap(), 1_010_000);
        assert_eq!(capped_mark(1_000_000, 1_000_000, 0, 86_400, 400_000).unwrap(), 400_000);
        assert!(capped_mark(0, 0, 0, 86_400, 5).is_err());
    }
}
