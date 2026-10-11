use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{BPS_DENOMINATOR, STRATEGY_ESCROW_SEED, VAULT_AUTHORITY_SEED};
use crate::errors::NaveError;
use crate::state::{
    StrategyPosition, TreasuryAsset, TreasuryConstitution, TreasuryVault, VaultAuthority,
};

/// Bound check for a manual `update_strategy_position_value` mark (M8): the
/// new value must land within `max_step_bps` of `base` (the position's
/// pre-update `current_value`, or `deposited_amount` if never marked). When
/// `base` is `0` (a freshly created, undeposited position — or one whose value
/// was marked down to zero) there is nothing to bound against, so the mark is
/// REJECTED: an unbounded first mark would let the operational agent conjure
/// an arbitrary `current_value` (and therefore withdrawal / fee-skim ceiling)
/// for a position that never received a deposit. The base is (re)established
/// only by a real deposit through `record_strategy_deposit`.
pub fn position_mark_within_step(base: u64, new_value: u64, max_step_bps: u128) -> bool {
    if base == 0 {
        return false;
    }
    let max_delta = match (base as u128)
        .checked_mul(max_step_bps)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
    {
        Some(v) => v as u64,
        None => return false,
    };
    let lower = base.saturating_sub(max_delta);
    let upper = match base.checked_add(max_delta) {
        Some(v) => v,
        None => return true, // overflow means the upper bound is effectively unbounded
    };
    new_value >= lower && new_value <= upper
}

/// Transfer SPL tokens from the DAO vault to a strategy escrow account.
pub fn transfer_vault_to_escrow<'info>(
    vault_authority: &Account<'info, VaultAuthority>,
    vault_token_account: &Account<'info, TokenAccount>,
    escrow_token_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    dao_key: &Pubkey,
    amount: u64,
) -> Result<()> {
    let seeds = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &[vault_authority.bump]];
    let signer = &[&seeds[..]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault_token_account.to_account_info(),
                to: escrow_token_account.to_account_info(),
                authority: vault_authority.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;
    Ok(())
}

/// Transfer SPL tokens from strategy escrow back to the DAO vault.
pub fn transfer_escrow_to_vault<'info>(
    vault_authority: &Account<'info, VaultAuthority>,
    escrow_token_account: &Account<'info, TokenAccount>,
    vault_token_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    dao_key: &Pubkey,
    amount: u64,
) -> Result<()> {
    transfer_escrow_to_account(
        vault_authority,
        escrow_token_account,
        vault_token_account,
        token_program,
        dao_key,
        amount,
    )
}

/// Transfer SPL tokens out of a `vault_authority`-owned source token account
/// (strategy escrow or asset_vault) to an arbitrary destination, signed by the
/// DAO `vault_authority` PDA. Used for the performance-fee skim (escrow →
/// protocol-revenue ATA) and the annual management fee (asset_vault → revenue
/// ATA), as well as the escrow→vault unwind via [`transfer_escrow_to_vault`].
pub fn transfer_escrow_to_account<'info>(
    vault_authority: &Account<'info, VaultAuthority>,
    source_token_account: &Account<'info, TokenAccount>,
    destination_token_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    dao_key: &Pubkey,
    amount: u64,
) -> Result<()> {
    let seeds = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &[vault_authority.bump]];
    let signer = &[&seeds[..]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: source_token_account.to_account_info(),
                to: destination_token_account.to_account_info(),
                authority: vault_authority.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;
    Ok(())
}

/// Record a strategy deposit across position, per-asset, and USD accounting.
///
/// `amount` is in the asset's base units (tracked on `StrategyPosition` and
/// `TreasuryAsset`); `amount_usd` is the Pyth-derived micro-USD value of that
/// amount at execution time, applied to the portfolio-level USD
/// `deployed_capital` so the constitution's USD caps stay live between
/// `revalue_treasury` ticks. `mint` is set at position init and not overwritten
/// here.
pub fn record_strategy_deposit(
    treasury_vault: &mut TreasuryVault,
    treasury_asset: &mut TreasuryAsset,
    strategy_position: &mut StrategyPosition,
    protocol_id: &[u8],
    amount: u64,
    amount_usd: u64,
    now: i64,
) -> Result<()> {
    strategy_position.protocol_id = [0u8; crate::constants::MAX_PROTOCOL_ID_LEN];
    strategy_position.protocol_id[..protocol_id.len()].copy_from_slice(protocol_id);
    strategy_position.protocol_id_len = protocol_id.len() as u8;
    strategy_position.deposited_amount = strategy_position
        .deposited_amount
        .checked_add(amount)
        .ok_or(NaveError::MathOverflow)?;
    strategy_position.current_value = strategy_position
        .current_value
        .checked_add(amount)
        .ok_or(NaveError::MathOverflow)?;
    strategy_position.last_updated = now;

    treasury_asset.deployed_capital = treasury_asset
        .deployed_capital
        .checked_add(amount)
        .ok_or(NaveError::MathOverflow)?;

    treasury_vault.deployed_capital = treasury_vault
        .deployed_capital
        .checked_add(amount_usd)
        .ok_or(NaveError::MathOverflow)?;

    Ok(())
}

/// Record a strategy withdrawal across position, per-asset, and USD accounting.
///
/// `amount` is in base units; `amount_usd` is the micro-USD value unwound,
/// subtracted from portfolio-level USD `deployed_capital` (saturating so a
/// post-yield withdrawal larger than the recorded USD principal cannot
/// underflow).
pub fn record_strategy_withdrawal(
    treasury_vault: &mut TreasuryVault,
    treasury_asset: &mut TreasuryAsset,
    strategy_position: &mut StrategyPosition,
    amount: u64,
    amount_usd: u64,
    now: i64,
) -> Result<()> {
    // Anti-drain floor (the hard ceiling backing the revised NE-8 cap): a
    // position can never give back more than its marked value.
    require!(
        strategy_position.current_value >= amount,
        NaveError::InsufficientVaultBalance
    );

    // Reduce principal PROPORTIONALLY to the marked value being unwound, rather
    // than by the full `amount`. This is what keeps the realized-gain
    // attribution (and therefore the 8.5% performance skim) consistent across
    // multiple partial withdrawals of a marked-up position: a withdrawal of
    // `amount` out of `current_value` returns `amount * deposited / current_value`
    // of principal and the remainder as realized gain. With full-`amount`
    // reduction the remaining position would look artificially gain-heavy and the
    // skim would over-tax later tranches. `principal_unwound <= deposited_amount`
    // always (since `amount <= current_value`), so this never underflows; it
    // equals the full principal on a complete unwind (`amount == current_value`).
    let principal_unwound = if strategy_position.current_value == 0 {
        0
    } else {
        u64::try_from(
            (amount as u128)
                .checked_mul(strategy_position.deposited_amount as u128)
                .ok_or(NaveError::MathOverflow)?
                .checked_div(strategy_position.current_value as u128)
                .ok_or(NaveError::MathOverflow)?,
        )
        .map_err(|_| NaveError::MathOverflow)?
    };

    strategy_position.deposited_amount = strategy_position
        .deposited_amount
        .checked_sub(principal_unwound.min(strategy_position.deposited_amount))
        .ok_or(NaveError::InsufficientVaultBalance)?;
    strategy_position.current_value = strategy_position
        .current_value
        .checked_sub(amount)
        .ok_or(NaveError::InsufficientVaultBalance)?;
    strategy_position.last_updated = now;

    // Keep the per-asset base-unit principal counter consistent with the sum of
    // position principals (reconciliation invariant 9): decrement by the same
    // proportional principal that left the position (saturating for safety).
    treasury_asset.deployed_capital = treasury_asset
        .deployed_capital
        .checked_sub(principal_unwound.min(treasury_asset.deployed_capital))
        .ok_or(NaveError::InsufficientVaultBalance)?;

    treasury_vault.deployed_capital = treasury_vault
        .deployed_capital
        .saturating_sub(amount_usd);

    Ok(())
}

/// Enforce constitution allocation cap against total NAV, cumulatively.
///
/// `already_deployed` is the amount currently allocated to this protocol; the
/// check compares `already_deployed + amount` against the cap so that multiple
/// individually-compliant requests cannot together breach the protocol's
/// max allocation.
pub fn enforce_allocation_cap(
    constitution: &TreasuryConstitution,
    treasury_vault: &TreasuryVault,
    program_id: &Pubkey,
    already_deployed: u64,
    amount: u64,
) -> Result<()> {
    let entry = constitution
        .protocols
        .iter()
        .find(|p| p.approved && p.program_id == *program_id)
        .ok_or(NaveError::ProtocolNotApproved)?;

    let cap = (treasury_vault.current_nav as u128)
        .checked_mul(entry.allocation_bps() as u128)
        .ok_or(NaveError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(NaveError::MathOverflow)?;

    let projected = (already_deployed as u128)
        .checked_add(amount as u128)
        .ok_or(NaveError::MathOverflow)?;

    require!(projected <= cap, NaveError::AllocationLimitExceeded);
    Ok(())
}

/// Enforce the constitution's global deployment cap and liquidity floor against
/// total NAV using vault accounting.
///
/// Two independent ceilings, both expressed against `current_nav`:
///   - global deployment cap: `deployed + amount <= max_total_deployed_bps * NAV`
///   - liquidity floor:        `deployed + amount <= (10000 - min_liquidity_bps) * NAV`
///
/// A value of `0` for either bps disables that ceiling, which keeps legacy
/// constitution accounts (created before these fields existed) safe.
///
/// NOTE: the stablecoin-reserve floor is intentionally NOT enforced here. The
/// current single-mint vault accounting cannot prove multi-asset composition;
/// the reserve floor is stored on-chain (governance-set and auditable) and
/// enforced by the off-chain deterministic guardrails until the multi-asset
/// treasury milestone lands.
pub fn enforce_global_deployment_limits(
    constitution: &TreasuryConstitution,
    treasury_vault: &TreasuryVault,
    amount: u64,
) -> Result<()> {
    let nav = treasury_vault.current_nav as u128;
    let projected = (treasury_vault.deployed_capital as u128)
        .checked_add(amount as u128)
        .ok_or(NaveError::MathOverflow)?;

    if constitution.max_total_deployed_bps > 0 {
        let cap = nav
            .checked_mul(constitution.max_total_deployed_bps as u128)
            .ok_or(NaveError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(NaveError::MathOverflow)?;
        require!(projected <= cap, NaveError::DeploymentCapExceeded);
    }

    if constitution.min_liquidity_bps > 0 {
        let deployable_bps = 10_000u16.saturating_sub(constitution.min_liquidity_bps);
        let max_deployable = nav
            .checked_mul(deployable_bps as u128)
            .ok_or(NaveError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(NaveError::MathOverflow)?;
        require!(projected <= max_deployable, NaveError::LiquidityFloorBreached);
    }

    Ok(())
}

/// Revised NE-8 cap (realized-yield path). The maximum cumulative base units a
/// single execution request may withdraw is its deployed principal
/// (`request_principal`) PLUS the position's marked realized gain
/// (`position_value - position_deposited`, saturating at 0 for a drawdown).
///
/// This loosens the historical `<= request_principal` cap so realized GAINS can
/// flow back through the audited withdrawal path (the 8.5% skim is taken on the
/// way out). It does NOT reopen a drain vector: the absolute anti-drain ceiling
/// remains nave_core's per-call `current_value >= amount` floor in
/// `record_strategy_withdrawal`, which guarantees a position can never return
/// more than its marked value across ALL requests, regardless of this softer
/// per-request bound.
pub fn realized_yield_withdraw_cap(
    request_principal: u64,
    position_deposited: u64,
    position_value: u64,
) -> Result<u64> {
    let gain = position_value.saturating_sub(position_deposited);
    request_principal
        .checked_add(gain)
        .ok_or(NaveError::MathOverflow.into())
}

/// Derive strategy escrow token account PDA seeds.
pub fn strategy_escrow_seeds<'a>(
    dao_key: &'a Pubkey,
    protocol_id: &'a [u8],
) -> [&'a [u8]; 3] {
    [STRATEGY_ESCROW_SEED, dao_key.as_ref(), protocol_id]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MAX_CONSTITUTION_PROTOCOLS, MAX_PROTOCOL_ID_LEN};
    use crate::state::ProtocolEntry;

    /// Fixed timestamp used for the accounting tests; `record_strategy_*` simply
    /// stamps `last_updated` with whatever the caller passes.
    const NOW: i64 = 1_700_000_000;

    fn make_vault(current_nav: u64) -> TreasuryVault {
        TreasuryVault {
            bump: 0,
            dao: Pubkey::default(),
            vault_token_account: Pubkey::default(),
            total_deposited: 0,
            total_withdrawn: 0,
            current_nav,
            high_water_mark: 0,
            last_management_fee_at: 0,
            last_performance_fee_at: 0,
            deployed_capital: 0,
            asset_count: 0,
            last_revalued_at: 0,
        }
    }

    fn make_constitution(program_id: Pubkey, max_allocation_bps: u16) -> TreasuryConstitution {
        let mut protocols = [ProtocolEntry::default(); MAX_CONSTITUTION_PROTOCOLS];
        protocols[0] = ProtocolEntry {
            protocol_id: [0u8; MAX_PROTOCOL_ID_LEN],
            protocol_id_len: 0,
            program_id,
            max_allocation_bps,
            approved: true,
        };
        TreasuryConstitution {
            bump: 0,
            dao: Pubkey::default(),
            protocol_count: 1,
            protocols,
            confidence_threshold: 0,
            review_window_secs: crate::constants::DEFAULT_REVIEW_WINDOW_SECONDS,
            min_stablecoin_reserve_bps: 0,
            max_total_deployed_bps: 0,
            min_liquidity_bps: 0,
            rebalance_frequency_secs: 0,
            last_rebalance_at: 0,
            agent_threshold_usd: 0,
            max_slippage_bps: 0,
            max_single_swap_bps: 0,
        }
    }

    fn make_policy_constitution(
        max_total_deployed_bps: u16,
        min_liquidity_bps: u16,
    ) -> TreasuryConstitution {
        let mut c = make_constitution(Pubkey::new_unique(), 10_000);
        c.max_total_deployed_bps = max_total_deployed_bps;
        c.min_liquidity_bps = min_liquidity_bps;
        c
    }

    fn make_vault_with_deployed(current_nav: u64, deployed: u64) -> TreasuryVault {
        let mut v = make_vault(current_nav);
        v.deployed_capital = deployed;
        v
    }

    fn make_asset() -> TreasuryAsset {
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

    fn make_position() -> StrategyPosition {
        StrategyPosition {
            bump: 0,
            dao: Pubkey::default(),
            mint: Pubkey::default(),
            position_token_account: Pubkey::default(),
            ext_market: Pubkey::default(),
            ext_reserve: Pubkey::default(),
            protocol_id: [0u8; MAX_PROTOCOL_ID_LEN],
            protocol_id_len: 0,
            deposited_amount: 0,
            current_value: 0,
            last_updated: 0,
        }
    }

    // ----- strategy deposit / withdrawal accounting invariants -----
    //
    // These lock in the on-chain accounting that backs the yield-return loop:
    // base-unit principal is tracked on the position + per-asset record, while
    // the USD `deployed_capital` aggregate on the vault tracks the Pyth value
    // unwound. They mirror the RECONCILIATION.md full-cycle invariants.

    #[test]
    fn deposit_then_full_withdraw_is_balance_neutral() {
        let mut vault = make_vault_with_deployed(1_000_000, 0);
        let mut asset = make_asset();
        let mut pos = make_position();

        // Deploy 100 base units valued at 100 USD (micro-USD here for brevity).
        record_strategy_deposit(&mut vault, &mut asset, &mut pos, b"kamino", 100, 100, NOW).unwrap();
        assert_eq!(pos.deposited_amount, 100);
        assert_eq!(pos.current_value, 100);
        assert_eq!(asset.deployed_capital, 100);
        assert_eq!(vault.deployed_capital, 100);

        // Withdraw exactly the principal: every figure returns to zero.
        record_strategy_withdrawal(&mut vault, &mut asset, &mut pos, 100, 100, NOW).unwrap();
        assert_eq!(pos.deposited_amount, 0);
        assert_eq!(pos.current_value, 0);
        assert_eq!(asset.deployed_capital, 0);
        assert_eq!(vault.deployed_capital, 0);
    }

    #[test]
    fn realized_yield_withdrawal_saturates_principal_without_underflow() {
        // Deploy 100 base units; the position is later marked up to 105 (5 of
        // realized yield) before unwinding. A withdrawal of the full 105 must NOT
        // underflow the principal-denominated counters, which saturate to zero.
        let mut vault = make_vault_with_deployed(1_000_000, 0);
        let mut asset = make_asset();
        let mut pos = make_position();

        record_strategy_deposit(&mut vault, &mut asset, &mut pos, b"kamino", 100, 100, NOW).unwrap();
        // Simulate `update_strategy_position_value` marking the position up.
        pos.current_value = 105;

        record_strategy_withdrawal(&mut vault, &mut asset, &mut pos, 105, 105, NOW).unwrap();
        // Principal counters saturate at zero (the 5 of yield is not principal).
        assert_eq!(pos.deposited_amount, 0);
        assert_eq!(pos.current_value, 0);
        assert_eq!(asset.deployed_capital, 0);
        // USD deployed_capital saturates rather than underflowing past zero.
        assert_eq!(vault.deployed_capital, 0);
    }

    #[test]
    fn withdrawal_exceeding_marked_value_is_rejected() {
        // The position can never give back more than its marked `current_value`;
        // this is the floor that prevents draining un-accrued value.
        let mut vault = make_vault_with_deployed(1_000_000, 100);
        let mut asset = make_asset();
        asset.deployed_capital = 100;
        let mut pos = make_position();
        pos.deposited_amount = 100;
        pos.current_value = 100;

        assert!(record_strategy_withdrawal(&mut vault, &mut asset, &mut pos, 101, 101, NOW).is_err());
        // State is unchanged on the rejected path (require! short-circuits first).
        assert_eq!(pos.current_value, 100);
    }

    #[test]
    fn marked_up_partial_withdrawal_reduces_principal_proportionally() {
        // Deploy 1_000 principal, mark the position up to 1_200 (200 gain), then
        // withdraw half the marked value (600). Principal must drop
        // proportionally (600 * 1000/1200 = 500), NOT by the full 600 — otherwise
        // the remaining position looks gain-heavy and over-taxes later tranches.
        let mut vault = make_vault_with_deployed(1_000_000, 1_000);
        let mut asset = make_asset();
        asset.deployed_capital = 1_000;
        let mut pos = make_position();
        pos.deposited_amount = 1_000;
        pos.current_value = 1_200;

        record_strategy_withdrawal(&mut vault, &mut asset, &mut pos, 600, 600, NOW).unwrap();
        assert_eq!(pos.deposited_amount, 500); // proportional, not 400
        assert_eq!(pos.current_value, 600);
        assert_eq!(asset.deployed_capital, 500);
    }

    #[test]
    fn multi_tranche_skim_matches_total_realized_gain() {
        use crate::utils::calculate_performance_skim;
        // Full marked-up position unwound in two tranches; the sum of the per-
        // tranche 8.5% skims must equal the skim on the whole realized gain
        // (no over-/under-tax), which proportional principal reduction guarantees.
        let mut vault = make_vault_with_deployed(1_000_000, 1_000);
        let mut asset = make_asset();
        asset.deployed_capital = 1_000;
        let mut pos = make_position();
        pos.deposited_amount = 1_000;
        pos.current_value = 1_200; // 200 realized gain

        // Tranche A: withdraw 600.
        let (gain_a, fee_a) =
            calculate_performance_skim(600, pos.deposited_amount, pos.current_value, 850).unwrap();
        record_strategy_withdrawal(&mut vault, &mut asset, &mut pos, 600, 600, NOW).unwrap();
        // Tranche B: withdraw the rest (600).
        let (gain_b, fee_b) =
            calculate_performance_skim(600, pos.deposited_amount, pos.current_value, 850).unwrap();
        record_strategy_withdrawal(&mut vault, &mut asset, &mut pos, 600, 600, NOW).unwrap();

        assert_eq!(gain_a + gain_b, 200); // exactly the realized gain, taxed once
        assert_eq!(fee_a + fee_b, 16); // 8 + 8 (8.5% of 200, floored per tranche)
        assert_eq!(pos.deposited_amount, 0);
        assert_eq!(pos.current_value, 0);
        assert_eq!(asset.deployed_capital, 0);
    }

    #[test]
    fn partial_withdrawal_keeps_remaining_principal_consistent() {
        let mut vault = make_vault_with_deployed(1_000_000, 0);
        let mut asset = make_asset();
        let mut pos = make_position();

        record_strategy_deposit(&mut vault, &mut asset, &mut pos, b"kamino", 100, 100, NOW).unwrap();
        record_strategy_withdrawal(&mut vault, &mut asset, &mut pos, 40, 40, NOW).unwrap();

        assert_eq!(pos.deposited_amount, 60);
        assert_eq!(pos.current_value, 60);
        assert_eq!(asset.deployed_capital, 60);
        assert_eq!(vault.deployed_capital, 60);
    }

    #[test]
    fn deposit_accumulates_across_multiple_tranches() {
        let mut vault = make_vault_with_deployed(1_000_000, 0);
        let mut asset = make_asset();
        let mut pos = make_position();

        record_strategy_deposit(&mut vault, &mut asset, &mut pos, b"kamino", 100, 100, NOW).unwrap();
        record_strategy_deposit(&mut vault, &mut asset, &mut pos, b"kamino", 50, 50, NOW).unwrap();

        assert_eq!(pos.deposited_amount, 150);
        assert_eq!(pos.current_value, 150);
        assert_eq!(asset.deployed_capital, 150);
        assert_eq!(vault.deployed_capital, 150);
    }

    #[test]
    fn single_amount_within_cap_passes() {
        let p = Pubkey::new_unique();
        let c = make_constitution(p, 5000); // 50%
        let v = make_vault(1_000); // cap = 500
        assert!(enforce_allocation_cap(&c, &v, &p, 0, 400).is_ok());
        assert!(enforce_allocation_cap(&c, &v, &p, 0, 500).is_ok());
    }

    #[test]
    fn cumulative_overflow_is_rejected() {
        let p = Pubkey::new_unique();
        let c = make_constitution(p, 5000);
        let v = make_vault(1_000); // cap = 500
        // 400 already deployed + 200 new = 600 > 500 -> reject
        assert!(enforce_allocation_cap(&c, &v, &p, 400, 200).is_err());
        // 400 + 100 = 500 == cap -> ok
        assert!(enforce_allocation_cap(&c, &v, &p, 400, 100).is_ok());
    }

    #[test]
    fn unapproved_protocol_is_rejected() {
        let p = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let c = make_constitution(p, 5000);
        let v = make_vault(1_000);
        assert!(enforce_allocation_cap(&c, &v, &other, 0, 1).is_err());
    }

    #[test]
    fn unset_policy_imposes_no_global_limit() {
        let c = make_policy_constitution(0, 0);
        let v = make_vault_with_deployed(1_000, 0);
        // Deploying the entire NAV is allowed when neither cap nor floor is set.
        assert!(enforce_global_deployment_limits(&c, &v, 1_000).is_ok());
    }

    #[test]
    fn global_deployment_cap_is_enforced() {
        let c = make_policy_constitution(5_000, 0); // 50% cap
        let v = make_vault_with_deployed(1_000, 0); // cap = 500
        assert!(enforce_global_deployment_limits(&c, &v, 500).is_ok());
        assert!(enforce_global_deployment_limits(&c, &v, 501).is_err());
    }

    #[test]
    fn global_deployment_cap_is_cumulative() {
        let c = make_policy_constitution(5_000, 0);
        let v = make_vault_with_deployed(1_000, 400); // 400 already deployed
        assert!(enforce_global_deployment_limits(&c, &v, 100).is_ok()); // 500 == cap
        assert!(enforce_global_deployment_limits(&c, &v, 101).is_err()); // 501 > cap
    }

    #[test]
    fn liquidity_floor_is_enforced() {
        let c = make_policy_constitution(0, 2_000); // keep 20% liquid -> deploy <= 80%
        let v = make_vault_with_deployed(1_000, 0); // max deployable = 800
        assert!(enforce_global_deployment_limits(&c, &v, 800).is_ok());
        assert!(enforce_global_deployment_limits(&c, &v, 801).is_err());
    }

    #[test]
    fn tightest_of_cap_and_liquidity_wins() {
        // 50% cap but only 20% liquidity floor (=> 80% deployable): cap wins (500).
        let c = make_policy_constitution(5_000, 2_000);
        let v = make_vault_with_deployed(1_000, 0);
        assert!(enforce_global_deployment_limits(&c, &v, 500).is_ok());
        assert!(enforce_global_deployment_limits(&c, &v, 501).is_err());
        assert_eq!(c.effective_max_deployed_bps(), 5_000);
    }

    // ----- revised NE-8 realized-yield withdrawal cap -----

    #[test]
    fn withdraw_cap_equals_principal_when_no_gain() {
        // Position at principal (or in drawdown): cap collapses to the deployed
        // principal — identical to the historical NE-8 behaviour.
        assert_eq!(realized_yield_withdraw_cap(100, 100, 100).unwrap(), 100);
        assert_eq!(realized_yield_withdraw_cap(100, 100, 90).unwrap(), 100); // drawdown saturates
        assert_eq!(realized_yield_withdraw_cap(100, 0, 0).unwrap(), 100); // unreadable position
    }

    #[test]
    fn withdraw_cap_admits_marked_gain() {
        // 100 principal, position marked to 110 (10 gain): cap is 110, so the
        // realized gain can now flow back (the skim is taken downstream).
        assert_eq!(realized_yield_withdraw_cap(100, 100, 110).unwrap(), 110);
        // A withdrawal of 111 would exceed the cap and be rejected by the caller.
        assert!(111 > realized_yield_withdraw_cap(100, 100, 110).unwrap());
    }

    #[test]
    fn withdraw_cap_is_underflow_and_overflow_safe() {
        // Drawdown never produces a negative gain (saturates).
        assert_eq!(realized_yield_withdraw_cap(50, 100, 10).unwrap(), 50);
        // Overflow on principal + gain is rejected rather than wrapping.
        assert!(realized_yield_withdraw_cap(u64::MAX, 0, 10).is_err());
    }

    #[test]
    fn rebalance_due_respects_cadence() {
        let mut c = make_policy_constitution(0, 0);
        // Unset cadence never forces a rebalance.
        assert!(!c.rebalance_due(1_000_000));
        c.rebalance_frequency_secs = 100;
        c.last_rebalance_at = 1_000;
        assert!(!c.rebalance_due(1_099));
        assert!(c.rebalance_due(1_100));
    }

    // ----- M8: position_mark_within_step (manual mark bound) -----

    #[test]
    fn position_mark_rejected_when_base_is_zero() {
        // A freshly created, undeposited position has nothing to bound against,
        // so ANY mark — including a zero no-op and the u64::MAX inflation the
        // old "unbounded" behaviour allowed — must be rejected until a real
        // deposit establishes a base.
        assert!(!position_mark_within_step(0, 0, 5_000));
        assert!(!position_mark_within_step(0, 1, 5_000));
        assert!(!position_mark_within_step(0, u64::MAX, 5_000));
    }

    #[test]
    fn position_mark_allowed_once_base_is_nonzero() {
        // The smallest possible base still yields a bounded (not rejected) window.
        assert!(position_mark_within_step(1, 1, 5_000));
        assert!(!position_mark_within_step(1, 2, 5_000));
    }

    #[test]
    fn position_mark_within_50pct_step_accepted() {
        // base = 1_000, 50% step bps => [500, 1_500] accepted.
        assert!(position_mark_within_step(1_000, 500, 5_000));
        assert!(position_mark_within_step(1_000, 1_000, 5_000));
        assert!(position_mark_within_step(1_000, 1_500, 5_000));
    }

    #[test]
    fn position_mark_beyond_step_rejected() {
        // Just outside the [500, 1_500] window is rejected either direction —
        // this is exactly the attack: understating to hide deployed capital
        // from the allocation cap, or overstating to inflate the withdrawal /
        // fee-skim ceiling on fictitious gains.
        assert!(!position_mark_within_step(1_000, 499, 5_000));
        assert!(!position_mark_within_step(1_000, 1_501, 5_000));
        assert!(!position_mark_within_step(1_000, 0, 5_000));
    }

    #[test]
    fn position_mark_step_is_overflow_safe() {
        // A huge base with a huge step must not panic; saturating/checked math
        // either rejects or treats the upper bound as unbounded, never wraps.
        assert!(position_mark_within_step(u64::MAX, u64::MAX, 5_000));
    }
}
