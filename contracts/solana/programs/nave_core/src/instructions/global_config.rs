use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::GLOBAL_CONFIG_SEED;
use crate::errors::NaveError;
use crate::events::GlobalConfigInitialized;
use crate::state::NaveGlobalConfig;

pub fn initialize_global_config_handler(
    ctx: Context<InitializeGlobalConfig>,
    formation_fee_lamports: u64,
) -> Result<()> {
    let global_config = &mut ctx.accounts.global_config;
    global_config.bump = ctx.bumps.global_config;
    global_config.authority = ctx.accounts.authority.key();
    global_config.treasury = ctx.accounts.treasury.key();
    global_config.paused = false;
    global_config.formation_fee_lamports = formation_fee_lamports;
    global_config.dao_count = 0;
    // NAVE creation-stake mint starts unset (zero pubkey); pinned later via
    // `set_nave_mint` once the canonical per-cluster mint is known.
    global_config.nave_mint = Pubkey::default();

    emit!(GlobalConfigInitialized {
        authority: global_config.authority,
        treasury: global_config.treasury,
        formation_fee_lamports,
    });

    Ok(())
}

pub fn update_global_config_handler(
    ctx: Context<UpdateGlobalConfig>,
    paused: bool,
    formation_fee_lamports: u64,
) -> Result<()> {
    let global_config = &mut ctx.accounts.global_config;
    require!(
        ctx.accounts.authority.key() == global_config.authority,
        NaveError::Unauthorized
    );

    global_config.paused = paused;
    global_config.formation_fee_lamports = formation_fee_lamports;

    emit!(crate::events::GlobalConfigUpdated {
        authority: global_config.authority,
        paused,
        formation_fee_lamports,
    });

    Ok(())
}

/// Admin-only: pin (or rotate) the canonical NAVE creation-stake mint for this
/// cluster. Once set (non-default), `stake_dao_creation` requires the staked
/// mint to match it; while unset, any mint is accepted (devnet bootstrap).
pub fn set_nave_mint_handler(ctx: Context<SetNaveMint>, nave_mint: Pubkey) -> Result<()> {
    let global_config = &mut ctx.accounts.global_config;
    require!(
        ctx.accounts.authority.key() == global_config.authority,
        NaveError::Unauthorized
    );
    require!(nave_mint != Pubkey::default(), NaveError::StakeMintMismatch);
    global_config.nave_mint = nave_mint;

    emit!(crate::events::NaveMintUpdated {
        authority: global_config.authority,
        nave_mint,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetNaveMint<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        has_one = authority @ NaveError::Unauthorized
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,
}

#[derive(Accounts)]
pub struct InitializeGlobalConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Protocol treasury receiving formation fees.
    pub treasury: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = NaveGlobalConfig::LEN,
        seeds = [GLOBAL_CONFIG_SEED],
        bump
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    // Gate global-config initialization to the program's deploy/upgrade
    // authority. This singleton mints the protocol admin authority, so leaving
    // it permissionless let anyone front-run the deployer and seize protocol
    // control. The two constraints below bind the caller to the on-chain
    // upgrade authority (the canonical Anchor "only upgrade authority" idiom),
    // which works on both devnet and mainnet without hardcoding a key.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ NaveError::Unauthorized
    )]
    pub program: Program<'info, crate::program::NaveCore>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ NaveError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateGlobalConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        has_one = authority @ NaveError::Unauthorized
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,
}
