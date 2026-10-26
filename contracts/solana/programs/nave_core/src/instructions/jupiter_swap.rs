use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{
    jupiter_swap_program, AgentRole, AGENT_SET_SEED, ASSET_CONFIG_SEED, CONSTITUTION_SEED,
    DAO_REGISTRY_SEED, GLOBAL_CONFIG_SEED, TREASURY_ASSET_SEED, TREASURY_VAULT_SEED,
    VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::events::JupiterSwapEvent;
use crate::state::{
    AgentSet, AssetConfig, DaoRegistry, NaveGlobalConfig, TreasuryAsset, TreasuryConstitution,
    TreasuryVault, VaultAuthority,
};
use crate::utils::{
    require_agent_authority, require_agents_enabled, require_dao_active, require_not_paused,
    value_stable,
};

// ── jupiter_swap ─────────────────────────────────────────────────────────────
// Operational-agent-gated. Swaps `amount_in` base units of `mint_in` held in the
// treasury for `mint_out` via a direct CPI into the Jupiter v6 aggregator,
// signing as the `vault_authority` PDA. Routes are built off-chain: the app
// passes the Jupiter route instruction data (`route_data`) plus the route's
// accounts as `remaining_accounts` (forwarded verbatim). The handler verifies
// the actual on-chain balance deltas against the authorized input ceiling and
// the slippage floor, and enforces the stablecoin reserve guardrail when selling
// a stablecoin.
//
// Jupiter v6 is mainnet-only; this instruction compiles + deploys to devnet but
// is only exercisable on mainnet.
pub fn jupiter_swap_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, JupiterSwap<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    expected_amount_out: u64,
    route_data: Vec<u8>,
) -> Result<()> {
    // 1. Agent gating: global pause, DAO freeze, agents-enabled, and the
    //    Oversight agent (`AgentRole::Operational`) identity and active-status checks.
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agents_enabled(&ctx.accounts.agent_set)?;
    require_agent_authority(
        &ctx.accounts.operational_agent.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;

    // 2. Basic argument sanity.
    require!(amount_in > 0, NaveError::InsufficientVaultBalance);
    require!(
        ctx.accounts.mint_in.key() != ctx.accounts.mint_out.key(),
        NaveError::MintMismatch
    );

    // 2b. Constitution-level max-slippage guardrail. `min_amount_out` alone is
    // caller-supplied by the same Oversight agent (`AgentRole::Operational`) executing the swap, so a
    // compromised/rogue agent could pick an unbounded (near-zero) floor and
    // still pass every other check. Require the agent's `min_amount_out` to
    // be within `max_slippage_bps` of an off-chain-quoted `expected_amount_out`
    // (e.g. a fresh Jupiter quote), so the on-chain floor itself is bounded
    // independent of what the agent chooses to pass.
    //
    // SOL-C3: this guardrail is now unconditional. It used to only apply when
    // the founder had explicitly set `max_slippage_bps > 0`, which meant every
    // DAO was fully unprotected (a rogue agent could pass `min_amount_out = 0`)
    // until the founder remembered to opt in. `initialize_dao_governance`
    // seeds a conservative non-zero default (`DEFAULT_MAX_SLIPPAGE_BPS`) for
    // every new DAO, so `constitution.max_slippage_bps` should never be `0` in
    // practice; treating `0` as "0 bps tolerance" (rather than "disabled") for
    // any legacy account is the fail-safe direction for a guardrail.
    require!(expected_amount_out > 0, NaveError::MaxSlippageExceeded);
    // The expected output is chosen by the same agent that signs the swap, so
    // it is not an independent price. Stable pairs are priced at $1. Any other
    // pair stays disabled until a price account is wired into this instruction.
    require!(
        ctx.accounts.asset_config_in.is_stablecoin && ctx.accounts.asset_config_out.is_stablecoin,
        NaveError::SwapOracleRequired
    );
    {
        const BPS: u128 = 10_000;
        let tolerance_bps = BPS.saturating_sub(ctx.accounts.constitution.max_slippage_bps as u128);
        let in_usd = value_stable(amount_in, ctx.accounts.asset_config_in.decimals)? as u128;
        let min_out_usd =
            value_stable(min_amount_out, ctx.accounts.asset_config_out.decimals)? as u128;
        let floor_usd = in_usd
            .checked_mul(tolerance_bps)
            .ok_or(NaveError::MathOverflow)?
            .checked_div(BPS)
            .ok_or(NaveError::MathOverflow)?;
        require!(min_out_usd >= floor_usd, NaveError::MaxSlippageExceeded);
        // Keep the agent quote as a second ceiling on how loose min_out may be
        // relative to the quote they published, not as the price itself.
        let quote_floor = (expected_amount_out as u128)
            .checked_mul(tolerance_bps)
            .ok_or(NaveError::MathOverflow)?
            .checked_div(BPS)
            .ok_or(NaveError::MathOverflow)?;
        require!(
            min_amount_out as u128 >= quote_floor,
            NaveError::MaxSlippageExceeded
        );
    }

    // 3. Bind the token accounts to the treasury accounting records and confirm
    //    DAO ownership + mint coherence (most are also enforced as account
    //    constraints; re-checked here defensively).
    let dao_key = ctx.accounts.dao_registry.key();
    require!(
        ctx.accounts.source_token_account.key() == ctx.accounts.treasury_asset_in.token_account,
        NaveError::InvalidVaultTokenAccount
    );
    require!(
        ctx.accounts.destination_token_account.key()
            == ctx.accounts.treasury_asset_out.token_account,
        NaveError::InvalidVaultTokenAccount
    );
    require!(
        ctx.accounts.treasury_asset_in.dao == dao_key
            && ctx.accounts.treasury_asset_out.dao == dao_key,
        NaveError::DaoOwnershipMismatch
    );
    require!(
        ctx.accounts.asset_config_in.mint == ctx.accounts.mint_in.key()
            && ctx.accounts.asset_config_out.mint == ctx.accounts.mint_out.key(),
        NaveError::MintMismatch
    );

    // 4. Pre-swap balance snapshot (reload to read the live on-chain amounts).
    ctx.accounts.source_token_account.reload()?;
    ctx.accounts.destination_token_account.reload()?;
    let pre_src = ctx.accounts.source_token_account.amount;
    let pre_dst = ctx.accounts.destination_token_account.amount;

    // 4b. Constitution-level max-single-swap-size guardrail. Unlike deposits
    // into Kamino/Jito/MarginFi — which can only move funds already escrowed
    // via a governance-approved, multi-agent-reviewed `execute_strategy` —
    // `jupiter_swap` is gated by a single Oversight agent (`AgentRole::Operational`) signature with no
    // prior approval step. Bound `amount_in` to `max_single_swap_bps` of the
    // pre-swap balance of the asset being sold, so one compromised/rogue
    // agent signature cannot move more than the configured share of a given
    // holding in a single call.
    //
    // SOL-C3: unconditional for the same reason as the slippage guardrail
    // above — `initialize_dao_governance` seeds a conservative non-zero
    // default (`DEFAULT_MAX_SINGLE_SWAP_BPS`), so a DAO with `0` here is a
    // legacy account that should fail closed (block the swap) rather than
    // silently run uncapped.
    {
        const BPS: u128 = 10_000;
        let max_amount_in = (pre_src as u128)
            .checked_mul(ctx.accounts.constitution.max_single_swap_bps as u128)
            .ok_or(NaveError::MathOverflow)?
            .checked_div(BPS)
            .ok_or(NaveError::MathOverflow)?;
        require!(
            (amount_in as u128) <= max_amount_in,
            NaveError::MaxSingleSwapExceeded
        );
    }

    // 4c. SEC-H4: route-account containment. The Jupiter route accounts are
    // agent-supplied and forwarded verbatim to a CPI signed by the
    // `vault_authority` PDA, so the PDA's signature authorizes token moves out
    // of ANY `vault_authority`-owned token account referenced by the route —
    // not just the intended `source_token_account`. A rogue Oversight agent (`AgentRole::Operational`)
    // could otherwise craft a route that drains a different treasury holding
    // (a strategy escrow, another asset's vault, the legacy vault ATA, …),
    // sidestepping the single-swap-size and slippage guards which only bind
    // `source`/`destination`. Reject any forwarded account that is a token
    // account — SPL Token OR Token-2022 (a Token-2022 holding is just as
    // drainable by the PDA signature, and used to slip past this check because
    // only `spl_token`-owned accounts were inspected) — owned by this DAO's
    // `vault_authority` unless it is exactly the bound source or destination.
    // (Jupiter's own program-owned route state is owned by the Jupiter
    // program, not the vault_authority, so it passes.)
    let va_key = ctx.accounts.vault_authority.key();
    let src_key = ctx.accounts.source_token_account.key();
    let dst_key = ctx.accounts.destination_token_account.key();
    for acc in ctx.remaining_accounts.iter() {
        if !is_token_program_owned(acc.owner) {
            continue;
        }
        let data = acc.try_borrow_data()?;
        require!(
            !is_disallowed_vault_token_account(
                &acc.key(),
                acc.owner,
                &data,
                &va_key,
                &src_key,
                &dst_key,
            ),
            NaveError::RouteAccountNotAllowed
        );
    }

    // 5. Build + invoke the Jupiter route, signed by the vault_authority PDA.
    let vault_bump = [ctx.accounts.vault_authority.bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &vault_bump];
    let signer: &[&[&[u8]]] = &[seeds];

    let ix = Instruction {
        program_id: ctx.accounts.jupiter_program.key(),
        accounts: ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                // The vault PDA is not a signer on the outer transaction.
                // invoke_signed only grants the signature when this flag is set.
                is_signer: a.is_signer || a.key() == va_key,
                is_writable: a.is_writable,
            })
            .collect(),
        data: route_data,
    };
    invoke_signed(&ix, ctx.remaining_accounts, signer)?;

    // 6. Post-swap balance snapshot and actual deltas.
    ctx.accounts.source_token_account.reload()?;
    ctx.accounts.destination_token_account.reload()?;
    let post_src = ctx.accounts.source_token_account.amount;
    let post_dst = ctx.accounts.destination_token_account.amount;
    let actual_in = pre_src
        .checked_sub(post_src)
        .ok_or(NaveError::MathOverflow)?;
    let actual_out = post_dst
        .checked_sub(pre_dst)
        .ok_or(NaveError::MathOverflow)?;

    // 7. Security bounds: the route may not consume more than the authorized
    //    input, and must deliver at least the slippage-protected minimum output.
    require!(actual_in <= amount_in, NaveError::SwapInputExceeded);
    require!(
        actual_out >= min_amount_out,
        NaveError::SwapSlippageExceeded
    );

    // 8. Stablecoin reserve guardrail. If we sold a stablecoin and the DAO has a
    //    reserve floor configured, the idle stablecoin remaining (post_src) must
    //    still cover `min_stablecoin_reserve_bps` of treasury NAV. Mirrors
    //    nave_execution's `enforce_stablecoin_reserve`. NOTE: `current_nav` is
    //    slightly stale post-swap (the swap mutates holdings without recomputing
    //    NAV), but it is the best on-chain USD reference available here.
    if ctx.accounts.asset_config_in.is_stablecoin
        && ctx.accounts.constitution.min_stablecoin_reserve_bps > 0
    {
        const BPS: u128 = 10_000;
        let reserve_required_usd = (ctx.accounts.treasury_vault.current_nav as u128)
            .checked_mul(ctx.accounts.constitution.min_stablecoin_reserve_bps as u128)
            .ok_or(NaveError::MathOverflow)?
            .checked_div(BPS)
            .ok_or(NaveError::MathOverflow)?;
        let idle_after_usd = value_stable(post_src, ctx.accounts.asset_config_in.decimals)? as u128;
        require!(
            idle_after_usd >= reserve_required_usd,
            NaveError::StablecoinReserveBreached
        );
    }

    // 9. Per-asset accounting. We do NOT recompute portfolio NAV here — the
    //    emitted event signals that a `revalue_treasury` is required to reprice.
    let now = Clock::get()?.unix_timestamp;
    let treasury_asset_in = &mut ctx.accounts.treasury_asset_in;
    treasury_asset_in.deposited = treasury_asset_in
        .deposited
        .checked_sub(actual_in)
        .ok_or(NaveError::MathOverflow)?;
    treasury_asset_in.last_valued_at = now;

    let treasury_asset_out = &mut ctx.accounts.treasury_asset_out;
    treasury_asset_out.deposited = treasury_asset_out
        .deposited
        .checked_add(actual_out)
        .ok_or(NaveError::MathOverflow)?;
    treasury_asset_out.last_valued_at = now;

    // 10. Emit the swap event (actual deltas) for off-chain indexers / revalue.
    emit!(JupiterSwapEvent {
        dao: dao_key,
        mint_in: ctx.accounts.mint_in.key(),
        mint_out: ctx.accounts.mint_out.key(),
        amount_in: actual_in,
        amount_out: actual_out,
        timestamp: now,
    });

    Ok(())
}

/// Whether `owner` is one of the two token programs whose accounts the SEC-H4
/// route-containment check must inspect.
#[inline]
pub fn is_token_program_owned(owner: &Pubkey) -> bool {
    *owner == anchor_spl::token::ID || *owner == anchor_spl::token_2022::ID
}

/// Read the `owner` (authority) field of a token account's raw data, for
/// either token program. SPL Token accounts are the fixed 165-byte layout;
/// Token-2022 accounts may carry TLV extensions after the base layout, so
/// they are parsed with `StateWithExtensions` (which also accepts the plain
/// 165-byte base). Returns `None` when the data is not a valid, initialized
/// token account for the given program (e.g. a mint, or program state).
pub fn token_account_owner(owner_program: &Pubkey, data: &[u8]) -> Option<Pubkey> {
    if *owner_program == anchor_spl::token::ID {
        TokenAccount::try_deserialize(&mut &data[..])
            .ok()
            .map(|acct| acct.owner)
    } else if *owner_program == anchor_spl::token_2022::ID {
        use anchor_lang::solana_program::program_pack::IsInitialized;
        use anchor_spl::token_2022::spl_token_2022::{
            extension::StateWithExtensions, state::Account as Account2022,
        };
        StateWithExtensions::<Account2022>::unpack(data)
            .ok()
            .filter(|state| state.base.is_initialized())
            .map(|state| state.base.owner)
    } else {
        None
    }
}

/// SEC-H4 containment classifier (pure, unit-tested). `true` when the
/// forwarded route account is a token account (SPL Token or Token-2022) whose
/// authority is this DAO's `vault_authority` AND it is neither the bound swap
/// `source` nor `destination` — i.e. an account the PDA signature would let the
/// route drain. Anything that is not a `vault_authority`-owned token account
/// is allowed (`false`).
pub fn is_disallowed_vault_token_account(
    account_key: &Pubkey,
    account_owner_program: &Pubkey,
    data: &[u8],
    vault_authority: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
) -> bool {
    if account_key == source || account_key == destination {
        return false;
    }
    matches!(
        token_account_owner(account_owner_program, data),
        Some(authority) if authority == *vault_authority
    )
}

#[cfg(test)]
mod route_containment_tests {
    use super::*;
    use anchor_lang::solana_program::program_option::COption;
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::spl_token;
    use anchor_spl::token_2022::spl_token_2022;
    use anchor_spl::token_2022::spl_token_2022::extension::{
        immutable_owner::ImmutableOwner, BaseStateWithExtensionsMut, ExtensionType,
        StateWithExtensionsMut,
    };

    fn legacy_token_account(owner: Pubkey) -> Vec<u8> {
        let acct = spl_token::state::Account {
            mint: Pubkey::new_unique(),
            owner,
            amount: 1_000,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut buf = vec![0u8; spl_token::state::Account::LEN];
        acct.pack_into_slice(&mut buf);
        buf
    }

    fn token_2022_base_account(owner: Pubkey) -> Vec<u8> {
        let acct = spl_token_2022::state::Account {
            mint: Pubkey::new_unique(),
            owner,
            amount: 1_000,
            delegate: COption::None,
            state: spl_token_2022::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut buf = vec![0u8; spl_token_2022::state::Account::LEN];
        acct.pack_into_slice(&mut buf);
        buf
    }

    /// Token-2022 account carrying an `ImmutableOwner` TLV extension (so the
    /// data is longer than the 165-byte base and has the account-type byte).
    fn token_2022_extended_account(owner: Pubkey) -> Vec<u8> {
        let len = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[
            ExtensionType::ImmutableOwner,
        ])
        .unwrap();
        let mut buf = vec![0u8; len];
        let mut state =
            StateWithExtensionsMut::<spl_token_2022::state::Account>::unpack_uninitialized(
                &mut buf,
            )
            .unwrap();
        state.init_extension::<ImmutableOwner>(true).unwrap();
        state.base = spl_token_2022::state::Account {
            mint: Pubkey::new_unique(),
            owner,
            amount: 5,
            delegate: COption::None,
            state: spl_token_2022::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        state.pack_base();
        state.init_account_type().unwrap();
        assert!(buf.len() > spl_token_2022::state::Account::LEN);
        buf
    }

    struct Fixture {
        va: Pubkey,
        src: Pubkey,
        dst: Pubkey,
        other: Pubkey,
    }

    fn fx() -> Fixture {
        Fixture {
            va: Pubkey::new_unique(),
            src: Pubkey::new_unique(),
            dst: Pubkey::new_unique(),
            other: Pubkey::new_unique(),
        }
    }

    #[test]
    fn legacy_vault_owned_stray_account_is_rejected() {
        let f = fx();
        let data = legacy_token_account(f.va);
        assert!(is_disallowed_vault_token_account(
            &f.other,
            &anchor_spl::token::ID,
            &data,
            &f.va,
            &f.src,
            &f.dst
        ));
    }

    #[test]
    fn token_2022_vault_owned_stray_account_is_rejected() {
        // The SEC-H4 escape: a Token-2022 treasury holding used to pass because
        // only spl_token-owned accounts were inspected.
        let f = fx();
        let base = token_2022_base_account(f.va);
        assert!(is_disallowed_vault_token_account(
            &f.other,
            &anchor_spl::token_2022::ID,
            &base,
            &f.va,
            &f.src,
            &f.dst
        ));
        let extended = token_2022_extended_account(f.va);
        assert!(is_disallowed_vault_token_account(
            &f.other,
            &anchor_spl::token_2022::ID,
            &extended,
            &f.va,
            &f.src,
            &f.dst
        ));
    }

    #[test]
    fn bound_source_and_destination_are_allowed_for_both_programs() {
        let f = fx();
        for (program, data) in [
            (anchor_spl::token::ID, legacy_token_account(f.va)),
            (anchor_spl::token_2022::ID, token_2022_base_account(f.va)),
            (
                anchor_spl::token_2022::ID,
                token_2022_extended_account(f.va),
            ),
        ] {
            assert!(!is_disallowed_vault_token_account(
                &f.src, &program, &data, &f.va, &f.src, &f.dst
            ));
            assert!(!is_disallowed_vault_token_account(
                &f.dst, &program, &data, &f.va, &f.src, &f.dst
            ));
        }
    }

    #[test]
    fn token_accounts_owned_by_others_are_allowed() {
        // Jupiter/AMM pool vaults are owned by their own authorities, not the
        // DAO vault_authority — they must keep passing for either program.
        let f = fx();
        let stranger = Pubkey::new_unique();
        assert!(!is_disallowed_vault_token_account(
            &f.other,
            &anchor_spl::token::ID,
            &legacy_token_account(stranger),
            &f.va,
            &f.src,
            &f.dst
        ));
        assert!(!is_disallowed_vault_token_account(
            &f.other,
            &anchor_spl::token_2022::ID,
            &token_2022_extended_account(stranger),
            &f.va,
            &f.src,
            &f.dst
        ));
    }

    #[test]
    fn non_token_accounts_and_mismatched_programs_are_allowed() {
        let f = fx();
        // Garbage / program state under a token program id is not a token account.
        assert!(!is_disallowed_vault_token_account(
            &f.other,
            &anchor_spl::token_2022::ID,
            &[0u8; 40],
            &f.va,
            &f.src,
            &f.dst
        ));
        // A token-shaped byte layout under a NON-token owner program is inert.
        assert!(!is_disallowed_vault_token_account(
            &f.other,
            &Pubkey::new_unique(),
            &legacy_token_account(f.va),
            &f.va,
            &f.src,
            &f.dst
        ));
        // Mint-sized data (82 bytes) never parses as a token account.
        assert!(token_account_owner(&anchor_spl::token::ID, &[0u8; 82]).is_none());
        assert!(token_account_owner(&anchor_spl::token_2022::ID, &[0u8; 82]).is_none());
    }

    #[test]
    fn uninitialized_token_2022_account_is_not_a_vault_holding() {
        let f = fx();
        let mut data = token_2022_base_account(f.va);
        // Zero the `state` byte (offset 108) → AccountState::Uninitialized.
        data[108] = 0;
        assert!(token_account_owner(&anchor_spl::token_2022::ID, &data).is_none());
    }

    #[test]
    fn owner_program_classifier() {
        assert!(is_token_program_owned(&anchor_spl::token::ID));
        assert!(is_token_program_owned(&anchor_spl::token_2022::ID));
        assert!(!is_token_program_owned(&Pubkey::new_unique()));
    }
}

#[derive(Accounts)]
pub struct JupiterSwap<'info> {
    #[account(mut)]
    pub operational_agent: Signer<'info>,

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

    #[account(
        seeds = [CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        constraint = constitution.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub constitution: Box<Account<'info, TreasuryConstitution>>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    /// Asset being sold.
    pub mint_in: Box<Account<'info, Mint>>,

    /// Asset being acquired.
    pub mint_out: Box<Account<'info, Mint>>,

    #[account(
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint_in.key().as_ref()],
        bump = asset_config_in.bump,
        constraint = asset_config_in.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = asset_config_in.mint == mint_in.key() @ NaveError::MintMismatch
    )]
    pub asset_config_in: Box<Account<'info, AssetConfig>>,

    #[account(
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint_out.key().as_ref()],
        bump = asset_config_out.bump,
        constraint = asset_config_out.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = asset_config_out.mint == mint_out.key() @ NaveError::MintMismatch
    )]
    pub asset_config_out: Box<Account<'info, AssetConfig>>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint_in.key().as_ref()],
        bump = treasury_asset_in.bump,
        constraint = treasury_asset_in.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = treasury_asset_in.mint == mint_in.key() @ NaveError::MintMismatch
    )]
    pub treasury_asset_in: Box<Account<'info, TreasuryAsset>>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint_out.key().as_ref()],
        bump = treasury_asset_out.bump,
        constraint = treasury_asset_out.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = treasury_asset_out.mint == mint_out.key() @ NaveError::MintMismatch
    )]
    pub treasury_asset_out: Box<Account<'info, TreasuryAsset>>,

    /// Vault-owned holding account for `mint_in` (the `asset_vault` PDA bound to
    /// `treasury_asset_in.token_account`). Swap source.
    #[account(
        mut,
        token::mint = mint_in,
        token::authority = vault_authority
    )]
    pub source_token_account: Box<Account<'info, TokenAccount>>,

    /// Vault-owned holding account for `mint_out` (the `asset_vault` PDA bound to
    /// `treasury_asset_out.token_account`). Swap destination.
    #[account(
        mut,
        token::mint = mint_out,
        token::authority = vault_authority
    )]
    pub destination_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: verified against `jupiter_swap_program::ID`; invoked via CPI with
    /// the route accounts forwarded as `remaining_accounts`.
    #[account(address = jupiter_swap_program::ID)]
    pub jupiter_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}
