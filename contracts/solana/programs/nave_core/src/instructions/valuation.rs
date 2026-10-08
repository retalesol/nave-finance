use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::{
    pyth_receiver_program, AgentRole, AGENT_SET_SEED, DAO_REGISTRY_SEED, GLOBAL_CONFIG_SEED,
    PYTH_MAX_PRICE_AGE_SECS, TREASURY_VAULT_SEED,
};
use crate::errors::NaveError;
use crate::state::{
    AgentSet, AssetConfig, DaoRegistry, NaveGlobalConfig, TreasuryAsset, TreasuryVault,
};
use crate::utils::{value_stable, value_usd};

/// Recompute the portfolio's USD NAV from every registered asset and reseed the
/// performance high-water-mark. Each asset is supplied as a 4-account group in
/// `remaining_accounts`:
///
///   [AssetConfig, TreasuryAsset, asset_vault (TokenAccount), Pyth PriceUpdateV2]
///
/// The asset's total base-unit balance = idle (`asset_vault.amount`) + deployed
/// principal (`TreasuryAsset.deployed_capital`). Stablecoins are valued at $1;
/// other assets are valued via their Pyth feed (staleness + feed-id checked).
/// Deployed is summed separately so USD `deployed_capital` stays consistent with
/// the constitution's deployment cap / liquidity floor.
///
/// The Pyth account is ignored for stablecoins; callers may pass the same
/// `asset_vault` as a placeholder for the 4th slot.
pub fn revalue_treasury_handler(ctx: Context<RevalueTreasury>) -> Result<()> {
    // Authority gate: only the founder or an operational Operational agent may
    // revalue. A permissionless revalue lets any caller stamp a fresh
    // `last_revalued_at` and (combined with a partial asset set, below) deflate
    // NAV to loosen the constitution's USD-denominated allocation caps and
    // stablecoin-reserve floor.
    let signer = ctx.accounts.authority.key();
    let founder_ok = signer == ctx.accounts.dao_registry.founder;
    let operational = ctx.accounts.agent_set.get_agent(AgentRole::Operational);
    let operational_ok = signer == operational.authority && operational.is_operational();
    require!(founder_ok || operational_ok, NaveError::Unauthorized);

    let dao_key = ctx.accounts.dao_registry.key();
    let clock = Clock::get()?;
    let accs = ctx.remaining_accounts;
    require!(!accs.is_empty() && accs.len() % 4 == 0, NaveError::InvalidAssetKind);

    // Full-coverage gate: the caller must supply EVERY registered asset (one
    // 4-account group each), so NAV cannot be deflated by omitting holdings.
    // `asset_count` is incremented on register and never decremented (assets
    // cannot be disabled), so it equals the number of valuable assets.
    let expected_groups = ctx.accounts.treasury_vault.asset_count as usize;
    require!(accs.len() / 4 == expected_groups, NaveError::InvalidAssetKind);

    let mut nav_usd: u128 = 0;
    let mut deployed_usd: u128 = 0;
    // Reject duplicate assets so the count gate above cannot be satisfied by
    // repeating one asset while omitting others.
    let mut seen_assets: Vec<Pubkey> = Vec::with_capacity(expected_groups);

    for group in accs.chunks(4) {
        let cfg_ai = &group[0];
        let asset_ai = &group[1];
        let vault_ai = &group[2];
        let price_ai = &group[3];

        require!(cfg_ai.owner == &crate::ID, NaveError::InvalidOracleAccount);
        require!(asset_ai.owner == &crate::ID, NaveError::InvalidOracleAccount);
        require!(
            !seen_assets.contains(&asset_ai.key()),
            NaveError::InvalidAssetKind
        );
        seen_assets.push(asset_ai.key());

        let cfg: AssetConfig = {
            let data = cfg_ai.try_borrow_data()?;
            AssetConfig::try_deserialize(&mut &data[..])?
        };
        let asset: TreasuryAsset = {
            let data = asset_ai.try_borrow_data()?;
            TreasuryAsset::try_deserialize(&mut &data[..])?
        };
        require!(cfg.dao == dao_key, NaveError::DaoOwnershipMismatch);
        require!(asset.dao == dao_key, NaveError::DaoOwnershipMismatch);
        require!(cfg.mint == asset.mint, NaveError::MintMismatch);
        require!(vault_ai.key() == asset.token_account, NaveError::InvalidVaultTokenAccount);
        require!(cfg.enabled, NaveError::AssetNotEnabled);

        let vault_amount: u64 = {
            let data = vault_ai.try_borrow_data()?;
            TokenAccount::try_deserialize(&mut &data[..])?.amount
        };
        let total = vault_amount
            .checked_add(asset.deployed_capital)
            .ok_or(NaveError::MathOverflow)?;

        let (total_value, deployed_value) = if cfg.is_stablecoin {
            (
                value_stable(total, cfg.decimals)?,
                value_stable(asset.deployed_capital, cfg.decimals)?,
            )
        } else {
            require!(
                price_ai.owner == &pyth_receiver_program::ID,
                NaveError::InvalidOracleAccount
            );
            let price_update: PriceUpdateV2 = {
                let data = price_ai.try_borrow_data()?;
                PriceUpdateV2::try_deserialize(&mut &data[..])?
            };
            let p = price_update
                .get_price_no_older_than(&clock, PYTH_MAX_PRICE_AGE_SECS, &cfg.pyth_feed_id)
                .map_err(|_| error!(NaveError::StaleOracle))?;
            // Reject prices whose Pyth confidence band is too wide relative to
            // the price (>2%); a wide band must not be used to value the
            // treasury (StaleOracle, same as an over-age price).
            crate::utils::require_confidence(p.price, p.conf)?;
            (
                value_usd(total, cfg.decimals, p.price, p.exponent)?,
                value_usd(asset.deployed_capital, cfg.decimals, p.price, p.exponent)?,
            )
        };

        nav_usd = nav_usd
            .checked_add(total_value as u128)
            .ok_or(NaveError::MathOverflow)?;
        deployed_usd = deployed_usd
            .checked_add(deployed_value as u128)
            .ok_or(NaveError::MathOverflow)?;

        // Write back the per-asset USD snapshot for off-chain reconciliation.
        {
            let mut asset_mut = asset;
            asset_mut.last_valued_usd = total_value;
            asset_mut.last_valued_at = clock.unix_timestamp;
            let mut data = asset_ai.try_borrow_mut_data()?;
            asset_mut.try_serialize(&mut &mut data[..])?;
        }
    }

    let nav_u64 = u64::try_from(nav_usd).map_err(|_| error!(NaveError::MathOverflow))?;
    let deployed_u64 = u64::try_from(deployed_usd).map_err(|_| error!(NaveError::MathOverflow))?;

    let vault = &mut ctx.accounts.treasury_vault;
    vault.current_nav = nav_u64;
    vault.deployed_capital = deployed_u64;
    // Stamp the freshness marker the execution program checks before allowing a
    // strategy deploy (NAV-staleness hard block).
    vault.last_revalued_at = clock.unix_timestamp;
    if nav_u64 > vault.high_water_mark {
        vault.high_water_mark = nav_u64;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct RevalueTreasury<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,
}
