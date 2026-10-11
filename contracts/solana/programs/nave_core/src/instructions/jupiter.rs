use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{
    jupiter_lending_program, AgentRole, AGENT_SET_SEED, CONSTITUTION_SEED, DAO_REGISTRY_SEED,
    GLOBAL_CONFIG_SEED, NAV_MAX_STALENESS_SECS, STRATEGY_ESCROW_SEED, STRATEGY_POSITION_SEED,
    TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::state::{
    AgentSet, DaoRegistry, NaveGlobalConfig, StrategyPosition, TreasuryConstitution, TreasuryVault,
    VaultAuthority,
};
use crate::utils::{
    require_agent_authority, require_agents_enabled, require_dao_active, require_not_paused,
    transfer_escrow_to_account,
};

/// SOL-H3 (partial): gate a Jupiter Lend DEPLOYMENT on the same NAV-freshness
/// and agent-operating-threshold conditions the `nave_execution` pipeline
/// enforces before any Kamino/Jito/MarginFi deposit. `jupiter_deposit` is
/// Operational-agent-gated with NO prior execution-request/3-agent-approval
/// step, so at minimum a deployment must not run against a stale/never-computed
/// treasury NAV or below the configured operating threshold.
///
/// Capital reaches Jupiter only from the per-(dao, "jupiter", mint) escrow,
/// which `nave_execution::execute_strategy` fills after the full agent
/// pipeline and the allocation / max-deployed / reserve caps.
fn require_fresh_nav_and_threshold(
    constitution: &TreasuryConstitution,
    treasury_vault: &TreasuryVault,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        treasury_vault.last_revalued_at > 0
            && now.saturating_sub(treasury_vault.last_revalued_at) <= NAV_MAX_STALENESS_SECS,
        NaveError::NavStale
    );
    if constitution.agent_threshold_usd > 0 {
        require!(
            treasury_vault.current_nav >= constitution.agent_threshold_usd,
            NaveError::AgentThresholdNotMet
        );
    }
    Ok(())
}

/// Jupiter Lend (Earn) protocol id this module operates on.
const JUPITER_PROTOCOL_ID: &[u8] = b"jupiter";

// Jupiter Lend `lending` program Anchor instruction discriminators
// (`sha256("global:<name>")[..8]`).
const DISC_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const DISC_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];

// ── jupiter_deposit ──────────────────────────────────────────────────────────
// Operational-agent-gated. Supplies `amount` base units of the underlying asset
// that `execute_strategy` escrowed for "jupiter" (escrow -> vault-owned
// underlying ATA -> Jupiter Lend Earn vault), minting jlTokens (fTokens) into
// the vault-owned jlToken ATA. The vault_authority PDA is
// the Jupiter `signer` (token-transfer authority) and signs via invoke_signed.
//
// Unlike Kamino/Jito (which use PDA escrow / receipt accounts), Jupiter Lend
// derives its token accounts as ATAs of the signer; we therefore operate on the
// vault_authority's ATAs. Both ATAs are provisioned here (payer = the agent
// authority) so Jupiter's internal `init_if_needed` is a no-op — a program-owned
// PDA signer cannot fund rent.

pub fn jupiter_deposit_handler(ctx: Context<JupiterDeposit>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;
    require_agents_enabled(&ctx.accounts.agent_set)?;
    // SOL-H3 (partial): refuse to deploy against a stale NAV or below the
    // agent operating threshold, matching the `nave_execution` pipeline gates.
    require_fresh_nav_and_threshold(&ctx.accounts.constitution, &ctx.accounts.treasury_vault)?;

    let sp = &ctx.accounts.strategy_position;
    require!(sp.protocol_id_slice() == JUPITER_PROTOCOL_ID, NaveError::ProtocolNotApproved);
    require!(sp.mint == ctx.accounts.mint.key(), NaveError::MintMismatch);
    require!(
        sp.ext_market != Pubkey::default() && sp.ext_reserve != Pubkey::default(),
        NaveError::PositionTargetsUnset
    );
    require!(sp.ext_market == ctx.accounts.lending.key(), NaveError::ExternalTargetMismatch);
    require!(sp.ext_reserve == ctx.accounts.vault.key(), NaveError::ExternalTargetMismatch);
    require!(
        ctx.accounts.jupiter_lending_program.key() == jupiter_lending_program::ID,
        NaveError::InvalidExternalProgram
    );
    require!(amount > 0, NaveError::MathOverflow);
    require!(
        ctx.accounts.strategy_escrow.amount >= amount,
        NaveError::VenueDepositRequiresEscrow
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let bump = [ctx.accounts.vault_authority.bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    // Jupiter debits the signer's ATA, so stage exactly `amount` from escrow.
    transfer_escrow_to_account(
        &ctx.accounts.vault_authority,
        &ctx.accounts.strategy_escrow,
        &ctx.accounts.depositor_token_account,
        &ctx.accounts.token_program,
        &dao_key,
        amount,
    )?;

    let mut data = DISC_DEPOSIT.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());

    let ix = Instruction {
        program_id: jupiter_lending_program::ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.vault_authority.key(), true),
            AccountMeta::new(ctx.accounts.depositor_token_account.key(), false),
            AccountMeta::new(ctx.accounts.recipient_token_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.lending_admin.key(), false),
            AccountMeta::new(ctx.accounts.lending.key(), false),
            AccountMeta::new(ctx.accounts.f_token_mint.key(), false),
            AccountMeta::new(ctx.accounts.supply_token_reserves_liquidity.key(), false),
            AccountMeta::new(ctx.accounts.lending_supply_position_on_liquidity.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rate_model.key(), false),
            AccountMeta::new(ctx.accounts.vault.key(), false),
            AccountMeta::new(ctx.accounts.liquidity.key(), false),
            AccountMeta::new(ctx.accounts.liquidity_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rewards_rate_model.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.depositor_token_account.to_account_info(),
            ctx.accounts.recipient_token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.lending_admin.to_account_info(),
            ctx.accounts.lending.to_account_info(),
            ctx.accounts.f_token_mint.to_account_info(),
            ctx.accounts.supply_token_reserves_liquidity.to_account_info(),
            ctx.accounts.lending_supply_position_on_liquidity.to_account_info(),
            ctx.accounts.rate_model.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.liquidity.to_account_info(),
            ctx.accounts.liquidity_program.to_account_info(),
            ctx.accounts.rewards_rate_model.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        signer,
    )?;
    Ok(())
}

// ── jupiter_withdraw ─────────────────────────────────────────────────────────
// Operational-agent-gated. Redeems `amount` base units of the underlying asset
// from the Jupiter Lend Earn vault (burning the requisite jlTokens from the
// vault-owned jlToken ATA) back into the vault-owned underlying ATA. Pass
// `u64::MAX` to withdraw the full position.

pub fn jupiter_withdraw_handler(ctx: Context<JupiterWithdraw>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;
    require_agents_enabled(&ctx.accounts.agent_set)?;

    let sp = &ctx.accounts.strategy_position;
    require!(sp.protocol_id_slice() == JUPITER_PROTOCOL_ID, NaveError::ProtocolNotApproved);
    require!(sp.mint == ctx.accounts.mint.key(), NaveError::MintMismatch);
    require!(sp.ext_market == ctx.accounts.lending.key(), NaveError::ExternalTargetMismatch);
    require!(sp.ext_reserve == ctx.accounts.vault.key(), NaveError::ExternalTargetMismatch);
    require!(
        ctx.accounts.jupiter_lending_program.key() == jupiter_lending_program::ID,
        NaveError::InvalidExternalProgram
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let bump = [ctx.accounts.vault_authority.bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    let underlying_before = ctx.accounts.recipient_token_account.amount;
    let mut data = DISC_WITHDRAW.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());

    let ix = Instruction {
        program_id: jupiter_lending_program::ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.vault_authority.key(), true),
            AccountMeta::new(ctx.accounts.owner_token_account.key(), false),
            AccountMeta::new(ctx.accounts.recipient_token_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.lending_admin.key(), false),
            AccountMeta::new(ctx.accounts.lending.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new(ctx.accounts.f_token_mint.key(), false),
            AccountMeta::new(ctx.accounts.supply_token_reserves_liquidity.key(), false),
            AccountMeta::new(ctx.accounts.lending_supply_position_on_liquidity.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rate_model.key(), false),
            AccountMeta::new(ctx.accounts.vault.key(), false),
            AccountMeta::new(ctx.accounts.claim_account.key(), false),
            AccountMeta::new(ctx.accounts.liquidity.key(), false),
            AccountMeta::new(ctx.accounts.liquidity_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rewards_rate_model.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.owner_token_account.to_account_info(),
            ctx.accounts.recipient_token_account.to_account_info(),
            ctx.accounts.lending_admin.to_account_info(),
            ctx.accounts.lending.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.f_token_mint.to_account_info(),
            ctx.accounts.supply_token_reserves_liquidity.to_account_info(),
            ctx.accounts.lending_supply_position_on_liquidity.to_account_info(),
            ctx.accounts.rate_model.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.claim_account.to_account_info(),
            ctx.accounts.liquidity.to_account_info(),
            ctx.accounts.liquidity_program.to_account_info(),
            ctx.accounts.rewards_rate_model.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        signer,
    )?;

    // Redeemed underlying goes back to the strategy escrow, where
    // `withdraw_from_strategy` settles it (fee skim + accounting).
    ctx.accounts.recipient_token_account.reload()?;
    let redeemed = ctx
        .accounts
        .recipient_token_account
        .amount
        .checked_sub(underlying_before)
        .ok_or(NaveError::MathOverflow)?;
    if redeemed > 0 {
        transfer_escrow_to_account(
            &ctx.accounts.vault_authority,
            &ctx.accounts.recipient_token_account,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.token_program,
            &dao_key,
            redeemed,
        )?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct JupiterDeposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,

    /// SOL-H3: supplies the agent operating threshold for the deploy gate.
    #[account(
        seeds = [CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        constraint = constitution.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub constitution: Box<Account<'info, TreasuryConstitution>>,

    /// SOL-H3: supplies the NAV freshness marker + current NAV for the deploy gate.
    #[account(
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    /// Underlying asset mint being supplied (e.g. wSOL / USDC).
    pub mint: Box<Account<'info, Mint>>,

    /// jlToken (fToken) mint minted by the Jupiter Lend vault for this asset.
    #[account(mut)]
    pub f_token_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), JUPITER_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub strategy_position: Box<Account<'info, StrategyPosition>>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), JUPITER_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Box<Account<'info, TokenAccount>>,

    /// Vault-owned underlying ATA (deposit source).
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub depositor_token_account: Box<Account<'info, TokenAccount>>,

    /// Vault-owned jlToken ATA (deposit destination).
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = f_token_mint,
        associated_token::authority = vault_authority
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: verified against `jupiter_lending_program::ID` in the handler.
    pub jupiter_lending_program: UncheckedAccount<'info>,

    // Jupiter Lend protocol accounts — validated internally by Jupiter against
    // its own PDA derivations / account relations. `lending` and `vault` are
    // additionally bound to the founder-approved strategy targets.
    /// CHECK: Jupiter lending_admin (singleton PDA).
    pub lending_admin: UncheckedAccount<'info>,
    /// CHECK: per-asset Jupiter `lending` PDA; bound to strategy_position.ext_market.
    #[account(mut)]
    pub lending: UncheckedAccount<'info>,
    /// CHECK: liquidity-layer token reserves for this asset.
    #[account(mut)]
    pub supply_token_reserves_liquidity: UncheckedAccount<'info>,
    /// CHECK: lending program's supply position in the liquidity layer.
    #[account(mut)]
    pub lending_supply_position_on_liquidity: UncheckedAccount<'info>,
    /// CHECK: interest-rate model.
    pub rate_model: UncheckedAccount<'info>,
    /// CHECK: liquidity-layer protocol vault (holds the underlying); bound to ext_reserve.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: main liquidity protocol PDA.
    #[account(mut)]
    pub liquidity: UncheckedAccount<'info>,
    /// CHECK: Jupiter liquidity program; forwarded (mainnet/devnet differ).
    #[account(mut)]
    pub liquidity_program: UncheckedAccount<'info>,
    /// CHECK: rewards rate model.
    pub rewards_rate_model: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JupiterWithdraw<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,

    /// Underlying asset mint being redeemed.
    pub mint: Box<Account<'info, Mint>>,

    /// jlToken (fToken) mint burned on redemption.
    #[account(mut)]
    pub f_token_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), JUPITER_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub strategy_position: Box<Account<'info, StrategyPosition>>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), JUPITER_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Box<Account<'info, TokenAccount>>,

    /// Vault-owned jlToken ATA (withdraw source, burned).
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = f_token_mint,
        associated_token::authority = vault_authority
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,

    /// Vault-owned underlying ATA (withdraw destination).
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: verified against `jupiter_lending_program::ID` in the handler.
    pub jupiter_lending_program: UncheckedAccount<'info>,

    /// CHECK: Jupiter lending_admin (singleton PDA).
    pub lending_admin: UncheckedAccount<'info>,
    /// CHECK: per-asset Jupiter `lending` PDA; bound to strategy_position.ext_market.
    #[account(mut)]
    pub lending: UncheckedAccount<'info>,
    /// CHECK: liquidity-layer token reserves for this asset.
    #[account(mut)]
    pub supply_token_reserves_liquidity: UncheckedAccount<'info>,
    /// CHECK: lending program's supply position in the liquidity layer.
    #[account(mut)]
    pub lending_supply_position_on_liquidity: UncheckedAccount<'info>,
    /// CHECK: interest-rate model.
    pub rate_model: UncheckedAccount<'info>,
    /// CHECK: liquidity-layer protocol vault (source of redeemed underlying); bound to ext_reserve.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: withdrawal claim-processing account.
    #[account(mut)]
    pub claim_account: UncheckedAccount<'info>,
    /// CHECK: main liquidity protocol PDA.
    #[account(mut)]
    pub liquidity: UncheckedAccount<'info>,
    /// CHECK: Jupiter liquidity program; forwarded (mainnet/devnet differ).
    #[account(mut)]
    pub liquidity_program: UncheckedAccount<'info>,
    /// CHECK: rewards rate model.
    pub rewards_rate_model: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
