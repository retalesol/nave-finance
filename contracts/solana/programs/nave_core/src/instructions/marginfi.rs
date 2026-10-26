use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{
    marginfi_program, AgentRole, AGENT_SET_SEED, DAO_REGISTRY_SEED, GLOBAL_CONFIG_SEED,
    STRATEGY_ESCROW_SEED, STRATEGY_POSITION_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::state::{AgentSet, DaoRegistry, NaveGlobalConfig, StrategyPosition, VaultAuthority};
use crate::utils::{
    require_agent_authority, require_agents_enabled, require_dao_active, require_founder,
    require_not_paused,
};

/// MarginFi protocol id this module operates on.
const MARGINFI_PROTOCOL_ID: &[u8] = b"marginfi";

// marginfi-v2 Anchor instruction discriminators (`sha256("global:<name>")[..8]`),
// computed from the exact `#[program]` entry-point names in
// `mrgnlabs/marginfi-v2` `programs/marginfi/src/lib.rs` — standard Anchor
// discriminator convention, no custom encoding. `marginfi_account_initialize`
// (NOT the newer `_pda` variant) is used deliberately: it is supported by
// every marginfi-v2 deployment observed (including the pinned devnet build,
// which does not yet expose `marginfi_account_initialize_pda` — confirmed via
// a live devnet probe), whereas the PDA variant is a newer addition not
// universally deployed yet.
const DISC_ACCOUNT_INITIALIZE: [u8; 8] = [43, 78, 61, 255, 148, 52, 249, 154];
const DISC_LENDING_ACCOUNT_DEPOSIT: [u8; 8] = [171, 94, 235, 103, 82, 64, 212, 140];
const DISC_LENDING_ACCOUNT_WITHDRAW: [u8; 8] = [36, 72, 74, 19, 210, 210, 192, 192];

// ── configure_marginfi_position ──────────────────────────────────────────────
// Founder-gated: binds the approved MarginFi group + bank to a strategy
// position (mirroring `configure_position_targets` for Kamino/Jito) and
// provisions the DAO's single cross-margin `MarginfiAccount` ledger via the
// permissionless `marginfi_account_initialize` CPI, signed by the
// `vault_authority` PDA as the ledger's `authority`.
//
// Unlike Kamino/Jito's receipt token accounts, a MarginfiAccount is a
// non-PDA data account owned by the marginfi program: `marginfi_account` must
// be a FRESH keypair supplied (and co-signed) by the caller at this one-time
// setup call — there is no seed formula nave_core can derive it from. Its
// address is therefore persisted into `strategy_position.position_token_account`
// (reusing that field's "opaque receipt/position pointer" role — MarginFi has
// no SPL receipt token, so it never held a literal token account here) so
// later `marginfi_deposit`/`marginfi_withdraw` calls can validate against it
// without re-deriving anything. One ledger is created per DAO and reused
// across every marginfi-protocol `StrategyPosition` (different mints, same
// underlying group) — subsequent calls for a different mint pass the SAME
// `marginfi_account` pubkey again (idempotent: skipped if already recorded).

pub fn configure_marginfi_position_handler(
    ctx: Context<ConfigureMarginfiPosition>,
    ext_market: Pubkey,
    ext_reserve: Pubkey,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;
    require!(
        ext_market != Pubkey::default() && ext_reserve != Pubkey::default(),
        NaveError::ExternalTargetMismatch
    );
    require!(
        ctx.accounts.marginfi_group.key() == ext_market,
        NaveError::ExternalTargetMismatch
    );

    let sp = &mut ctx.accounts.strategy_position;
    sp.ext_market = ext_market;
    sp.ext_reserve = ext_reserve;

    let already_provisioned = sp.position_token_account != Pubkey::default();
    require!(
        !already_provisioned || sp.position_token_account == ctx.accounts.marginfi_account.key(),
        NaveError::InvalidPositionTokenAccount
    );

    if !already_provisioned {
        require!(
            ctx.accounts.marginfi_account.data_is_empty(),
            NaveError::InvalidPositionTokenAccount
        );
        let dao_key = ctx.accounts.dao_registry.key();
        let bump = [ctx.accounts.vault_authority.bump];
        let va_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &bump];
        let signer: &[&[&[u8]]] = &[va_seeds];

        let ix = Instruction {
            program_id: marginfi_program::ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.marginfi_group.key(), false),
                AccountMeta::new(ctx.accounts.marginfi_account.key(), true),
                AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
                AccountMeta::new(ctx.accounts.authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: DISC_ACCOUNT_INITIALIZE.to_vec(),
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.marginfi_group.to_account_info(),
                ctx.accounts.marginfi_account.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer,
        )?;
        sp.position_token_account = ctx.accounts.marginfi_account.key();
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ConfigureMarginfiPosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// Asset mint this position deploys (keys the per-mint `StrategyPosition`
    /// even though the underlying MarginFi ledger is shared across mints).
    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        mut,
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized,
        constraint = strategy_position.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    /// CHECK: MarginFi `MarginfiGroup`; equality with `ext_market` enforced in
    /// the handler, internal layout validated by the marginfi program.
    pub marginfi_group: UncheckedAccount<'info>,

    /// The DAO's single cross-margin ledger. Not a PDA — MarginFi's classic
    /// `marginfi_account_initialize` (used for maximum compatibility across
    /// marginfi-v2 deployments; see discriminator comment above) requires a
    /// FRESH keypair that co-signs this call and becomes the permanent ledger
    /// address, recorded into `strategy_position.position_token_account`.
    /// Must be empty (uninitialized) the first time; idempotent thereafter.
    #[account(mut)]
    pub marginfi_account: Signer<'info>,

    /// CHECK: verified against `marginfi_program::ID` in the handler.
    pub marginfi_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ── marginfi_deposit ─────────────────────────────────────────────────────────
// Operational-agent-gated. Deposits `amount` base units of the asset from the
// per-(dao, marginfi, mint) escrow into the configured MarginFi bank via
// `lending_account_deposit`, crediting the DAO's shared ledger. Unlike Kamino,
// MarginFi accrues interest internally on every deposit/withdraw call — no
// separate "refresh" CPI is required.

pub fn marginfi_deposit_handler(ctx: Context<MarginfiDeposit>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;
    require_agents_enabled(&ctx.accounts.agent_set)?;

    let sp = &ctx.accounts.strategy_position;
    require!(
        sp.protocol_id_slice() == MARGINFI_PROTOCOL_ID,
        NaveError::ProtocolNotApproved
    );
    require!(sp.mint == ctx.accounts.mint.key(), NaveError::MintMismatch);
    require!(
        sp.ext_market != Pubkey::default() && sp.ext_reserve != Pubkey::default(),
        NaveError::PositionTargetsUnset
    );
    require!(
        sp.ext_market == ctx.accounts.marginfi_group.key(),
        NaveError::ExternalTargetMismatch
    );
    require!(
        sp.ext_reserve == ctx.accounts.bank.key(),
        NaveError::ExternalTargetMismatch
    );
    require!(
        sp.position_token_account == ctx.accounts.marginfi_account.key(),
        NaveError::InvalidPositionTokenAccount
    );
    require!(
        ctx.accounts.marginfi_program.key() == marginfi_program::ID,
        NaveError::InvalidExternalProgram
    );
    require!(
        ctx.accounts.strategy_escrow.amount >= amount,
        NaveError::InsufficientEscrowBalance
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let bump = [ctx.accounts.vault_authority.bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    let mut data = DISC_LENDING_ACCOUNT_DEPOSIT.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(0); // Option<bool> deposit_up_to_limit = None

    let ix = Instruction {
        program_id: marginfi_program::ID,
        accounts: vec![
            AccountMeta::new_readonly(ctx.accounts.marginfi_group.key(), false),
            AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
            AccountMeta::new(ctx.accounts.bank.key(), false),
            AccountMeta::new(ctx.accounts.strategy_escrow.key(), false),
            AccountMeta::new(ctx.accounts.bank_liquidity_vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            ctx.accounts.marginfi_group.to_account_info(),
            ctx.accounts.marginfi_account.to_account_info(),
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.bank.to_account_info(),
            ctx.accounts.strategy_escrow.to_account_info(),
            ctx.accounts.bank_liquidity_vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        signer,
    )?;
    Ok(())
}

// ── marginfi_withdraw ────────────────────────────────────────────────────────
// Operational-agent-gated. Withdraws `amount` base units from the configured
// MarginFi bank back into the per-(dao, marginfi, mint) escrow via
// `lending_account_withdraw`. MarginFi runs a risk-engine health check after
// every withdrawal, so `remaining_accounts` must supply, for EVERY active
// balance in the ledger, a `(bank, oracle_account(s)...)` tuple — confirmed
// live against the deployed devnet program (it explicitly errors
// `MissingPythOrBankAccount` / "Expecting N remaining accounts" otherwise).
// nave_core's ledger only ever holds the single bank bound to this
// StrategyPosition, so the caller forwards exactly `[bank, oracle...]` (the
// bank pubkey itself, THEN its oracle account(s) — not oracle-only).

pub fn marginfi_withdraw_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, MarginfiWithdraw<'info>>,
    amount: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;
    require_agents_enabled(&ctx.accounts.agent_set)?;

    let sp = &ctx.accounts.strategy_position;
    require!(
        sp.protocol_id_slice() == MARGINFI_PROTOCOL_ID,
        NaveError::ProtocolNotApproved
    );
    require!(sp.mint == ctx.accounts.mint.key(), NaveError::MintMismatch);
    require!(
        sp.ext_market == ctx.accounts.marginfi_group.key(),
        NaveError::ExternalTargetMismatch
    );
    require!(
        sp.ext_reserve == ctx.accounts.bank.key(),
        NaveError::ExternalTargetMismatch
    );
    require!(
        sp.position_token_account == ctx.accounts.marginfi_account.key(),
        NaveError::InvalidPositionTokenAccount
    );
    require!(
        ctx.accounts.marginfi_program.key() == marginfi_program::ID,
        NaveError::InvalidExternalProgram
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let bump = [ctx.accounts.vault_authority.bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    let mut data = DISC_LENDING_ACCOUNT_WITHDRAW.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(0); // Option<bool> withdraw_all = None

    let mut metas = vec![
        AccountMeta::new_readonly(ctx.accounts.marginfi_group.key(), false),
        AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
        AccountMeta::new(ctx.accounts.bank.key(), false),
        AccountMeta::new(ctx.accounts.strategy_escrow.key(), false),
        // Writable: empirically required by the deployed devnet program (this
        // differs from the `bank_liquidity_vault_authority` field's `mut`-less
        // declaration in the current `main`-branch source, consistent with
        // this devnet build predating that branch — see marginfi.rs module
        // header notes on cross-deployment drift).
        AccountMeta::new(ctx.accounts.bank_liquidity_vault_authority.key(), false),
        AccountMeta::new(ctx.accounts.bank_liquidity_vault.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
    ];
    let mut infos = vec![
        ctx.accounts.marginfi_group.to_account_info(),
        ctx.accounts.marginfi_account.to_account_info(),
        ctx.accounts.vault_authority.to_account_info(),
        ctx.accounts.bank.to_account_info(),
        ctx.accounts.strategy_escrow.to_account_info(),
        ctx.accounts
            .bank_liquidity_vault_authority
            .to_account_info(),
        ctx.accounts.bank_liquidity_vault.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
    ];
    // Health-check remaining accounts: [bank, oracle(s)...] per active balance.
    // A DAO's marginfi ledger only ever holds the single bank bound to this
    // StrategyPosition, so the caller forwards exactly that bank's oracle set.
    for acc in ctx.remaining_accounts.iter() {
        metas.push(AccountMeta::new_readonly(acc.key(), false));
        infos.push(acc.clone());
    }

    let ix = Instruction {
        program_id: marginfi_program::ID,
        accounts: metas,
        data,
    };
    invoke_signed(&ix, &infos, signer)?;
    Ok(())
}

#[derive(Accounts)]
pub struct MarginfiDeposit<'info> {
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

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    /// CHECK: bound to `strategy_position.ext_market`.
    pub marginfi_group: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.position_token_account` (the
    /// non-PDA ledger address recorded at `configure_marginfi_position` time).
    #[account(mut)]
    pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_reserve`; marginfi validates internally.
    #[account(mut)]
    pub bank: UncheckedAccount<'info>,
    /// CHECK: bank's underlying liquidity vault; validated by marginfi.
    #[account(mut)]
    pub bank_liquidity_vault: UncheckedAccount<'info>,
    /// CHECK: verified against `marginfi_program::ID` in the handler.
    pub marginfi_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MarginfiWithdraw<'info> {
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

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    /// CHECK: bound to `strategy_position.ext_market`.
    pub marginfi_group: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.position_token_account`.
    #[account(mut)]
    pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_reserve`.
    #[account(mut)]
    pub bank: UncheckedAccount<'info>,
    /// CHECK: bank liquidity-vault authority PDA; validated by marginfi.
    /// `mut` here (even though it is a PDA authority, not a balance-holding
    /// account) matches the writable requirement empirically observed on the
    /// deployed devnet program — see the CPI-side comment in the handler.
    #[account(mut)]
    pub bank_liquidity_vault_authority: UncheckedAccount<'info>,
    /// CHECK: bank's underlying liquidity vault; validated by marginfi.
    #[account(mut)]
    pub bank_liquidity_vault: UncheckedAccount<'info>,
    /// CHECK: verified against `marginfi_program::ID` in the handler.
    pub marginfi_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}
