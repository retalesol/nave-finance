use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

pub mod constants;
pub mod errors;
pub mod events;
pub mod fees;
pub mod state;

use constants::*;
use errors::BridgeError;
use events::*;
use fees::compute_fee_split;
use state::{BridgeConfig, ProcessedRelease, MAX_ALLOWED_DEST_CHAINS};

// Closed on Solana mainnet. This id cannot be redeployed (`solana program deploy`
// will not reopen it). A future mainnet bridge needs a new program id and keypair.
declare_id!("Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6");

/// # nave_bridge
///
/// On-chain custody + guardrails for the Nave NAVE <-> wNAVE trusted-relayer
/// bridge. This program does NOT itself verify EVM messages (that stays in the
/// off-chain relayer), but it moves all the *value* and enforces the safety
/// properties that a bare hot-key relayer cannot:
///
/// * Single-signature bridging: `lock` takes the destination `evm_recipient`
///   as instruction data, so the user's one source-tx signature authorizes the
///   exact payout address — no separate off-chain "sign this recipient" step.
/// * Bounded blast radius: `release` (relayer-only) is gated by a pause flag,
///   a per-transaction cap, and a rolling 24h cap, and every inbound message is
///   guarded by a `ProcessedRelease` PDA so the same source burn can never be
///   paid twice, even if the relayer key is compromised or the off-chain DB is
///   bypassed.
/// * Multisig ownership: config/relayer/pause/caps are administered by `owner`
///   (a Squads multisig on mainnet) via a two-step ownership handoff.
/// * Fee split resolved on Solana (2.5% on top by default): staking (1%),
///   protocol revenue (1%), auto-burn (0.5%) — in both directions.
#[program]
pub mod nave_bridge {
    use super::*;

    /// Create the singleton config + the custody token account. Callable once by
    /// the deploying `payer`; the passed `owner` becomes the administrator
    /// (intended to be a Squads multisig on mainnet).
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        owner: Pubkey,
        relayer: Pubkey,
        protocol_fee_owner: Pubkey,
        staking_pool_owner: Pubkey,
        fee_bps: u16,
        staking_bps: u16,
        protocol_bps: u16,
        burn_bps: u16,
        per_tx_cap: u64,
        daily_cap: u64,
    ) -> Result<()> {
        validate_fee_config(fee_bps, staking_bps, protocol_bps, burn_bps)?;
        require_keys_nonzero(owner)?;
        require_keys_nonzero(relayer)?;

        let cfg = &mut ctx.accounts.config;
        cfg.bump = ctx.bumps.config;
        cfg.owner = owner;
        cfg.pending_owner = Pubkey::default();
        cfg.relayer = relayer;
        cfg.nave_mint = ctx.accounts.nave_mint.key();
        cfg.custody = ctx.accounts.custody.key();
        cfg.custody_authority_bump = ctx.bumps.custody_authority;
        cfg.protocol_fee_owner = protocol_fee_owner;
        cfg.staking_pool_owner = staking_pool_owner;
        cfg.fee_bps = fee_bps;
        cfg.staking_bps = staking_bps;
        cfg.protocol_bps = protocol_bps;
        cfg.burn_bps = burn_bps;
        cfg.paused = false;
        cfg.per_tx_cap = per_tx_cap;
        cfg.daily_cap = daily_cap;
        cfg.daily_released = 0;
        cfg.window_start = Clock::get()?.unix_timestamp;
        cfg.outbound_nonce = 0;
        cfg.reserved = [0u8; 64];
        // Outbound guardrails start fail-closed on the allowlist (no destination
        // chain is servable until the owner calls `set_dest_chain_allowed`) and
        // unlimited on the outbound daily cap (`0`; set via `set_lock_daily_cap`).
        cfg.lock_daily_cap = 0;
        cfg.lock_daily_used = 0;
        cfg.lock_day_start = cfg.window_start;
        cfg.allowed_dest_chains = [0u64; MAX_ALLOWED_DEST_CHAINS];

        emit!(BridgeConfigUpdated {
            owner: cfg.owner,
            relayer: cfg.relayer,
            fee_bps,
            staking_bps,
            protocol_bps,
            burn_bps,
            per_tx_cap,
            daily_cap,
            paused: false,
        });
        Ok(())
    }

    /// Owner-only: update fee schedule, caps, and fee destinations.
    #[allow(clippy::too_many_arguments)]
    pub fn set_config(
        ctx: Context<OwnerOnly>,
        fee_bps: u16,
        staking_bps: u16,
        protocol_bps: u16,
        burn_bps: u16,
        per_tx_cap: u64,
        daily_cap: u64,
        protocol_fee_owner: Pubkey,
        staking_pool_owner: Pubkey,
    ) -> Result<()> {
        validate_fee_config(fee_bps, staking_bps, protocol_bps, burn_bps)?;
        let cfg = &mut ctx.accounts.config;
        cfg.fee_bps = fee_bps;
        cfg.staking_bps = staking_bps;
        cfg.protocol_bps = protocol_bps;
        cfg.burn_bps = burn_bps;
        cfg.per_tx_cap = per_tx_cap;
        cfg.daily_cap = daily_cap;
        cfg.protocol_fee_owner = protocol_fee_owner;
        cfg.staking_pool_owner = staking_pool_owner;

        emit!(BridgeConfigUpdated {
            owner: cfg.owner,
            relayer: cfg.relayer,
            fee_bps,
            staking_bps,
            protocol_bps,
            burn_bps,
            per_tx_cap,
            daily_cap,
            paused: cfg.paused,
        });
        Ok(())
    }

    /// Owner-only: set the rolling 24h cap on the NET amount locked (bridged
    /// OUT) via `lock`. `0` = unlimited. Independent of the inbound `release`
    /// `daily_cap` managed by `set_config`. Resets the current window so the
    /// new cap takes effect immediately from a clean slate.
    pub fn set_lock_daily_cap(ctx: Context<OwnerOnly>, lock_daily_cap: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.lock_daily_cap = lock_daily_cap;
        cfg.lock_daily_used = 0;
        cfg.lock_day_start = Clock::get()?.unix_timestamp;
        emit!(BridgeLockDailyCapUpdated { lock_daily_cap });
        Ok(())
    }

    /// Owner-only: add (`allowed = true`) or remove (`allowed = false`) an EVM
    /// destination chain id from the `lock` allowlist. `lock` rejects any
    /// `dest_chain_id` not on the list, so NAVE can never be locked against a
    /// destination the relayer does not serve.
    pub fn set_dest_chain_allowed(
        ctx: Context<OwnerOnly>,
        chain_id: u64,
        allowed: bool,
    ) -> Result<()> {
        ctx.accounts.config.set_dest_chain_allowed(chain_id, allowed)?;
        emit!(BridgeDestChainAllowlistUpdated { chain_id, allowed });
        Ok(())
    }

    /// Owner-only: rotate the relayer hot key.
    pub fn set_relayer(ctx: Context<OwnerOnly>, new_relayer: Pubkey) -> Result<()> {
        require_keys_nonzero(new_relayer)?;
        ctx.accounts.config.relayer = new_relayer;
        Ok(())
    }

    /// Owner-only circuit breaker: pause/unpause lock + release.
    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Owner-only step 1 of a two-step ownership handoff.
    pub fn transfer_ownership(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> {
        require_keys_nonzero(new_owner)?;
        ctx.accounts.config.pending_owner = new_owner;
        Ok(())
    }

    /// Step 2: the pending owner claims ownership.
    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        let previous = cfg.owner;
        cfg.owner = ctx.accounts.new_owner.key();
        cfg.pending_owner = Pubkey::default();
        emit!(BridgeOwnershipTransferred {
            previous,
            current: cfg.owner,
        });
        Ok(())
    }

    /// Lock NAVE to bridge OUT to an EVM chain. `net_amount` is the amount the
    /// user wants to bridge (received on the far side); the 2.5%-on-top fee is
    /// pulled additionally, so the user parts with `gross = net + fee`. The fee
    /// is resolved on Solana: burn (0.5%), staking (1%), protocol (1%). The net
    /// stays in custody, backing the wNAVE the relayer will mint to
    /// `evm_recipient` on `dest_chain_id`. Guarded by pause, the per-tx cap,
    /// the rolling 24h outbound cap (`lock_daily_cap`) and the destination
    /// chain allowlist (`allowed_dest_chains`).
    pub fn lock(
        ctx: Context<Lock>,
        net_amount: u64,
        dest_chain_id: u64,
        evm_recipient: [u8; EVM_ADDRESS_LEN],
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, BridgeError::BridgePaused);
        require!(net_amount > 0, BridgeError::ZeroAmount);
        require!(evm_recipient != [0u8; EVM_ADDRESS_LEN], BridgeError::InvalidEvmRecipient);
        require!(
            cfg.per_tx_cap == 0 || net_amount <= cfg.per_tx_cap,
            BridgeError::PerTxCapExceeded
        );
        // Destination allowlist: never lock against a chain the relayer does
        // not serve (the user's NAVE would sit in custody with no mint path).
        require!(
            cfg.is_dest_chain_allowed(dest_chain_id),
            BridgeError::UnsupportedChain
        );
        require_fee_destinations(
            cfg,
            &ctx.accounts.protocol_fee_account,
            &ctx.accounts.staking_pool_account,
        )?;

        let split = compute_fee_split(net_amount, cfg.fee_bps, cfg.staking_bps, cfg.burn_bps)?;
        let custody_authority_bump = cfg.custody_authority_bump;

        // Rolling daily cap on the NET locked (outbound) — mirrors the inbound
        // `release` cap: window resets after 24h, then the projected total for
        // the window must fit under the cap. Accounted BEFORE any token
        // movement so a rejected lock leaves no partial state.
        let now = Clock::get()?.unix_timestamp;
        {
            let cfg_mut = &mut ctx.accounts.config;
            let (used, day_start) = apply_rolling_cap(
                cfg_mut.lock_daily_cap,
                cfg_mut.lock_daily_used,
                cfg_mut.lock_day_start,
                now,
                net_amount,
            )
            .map_err(|e| match e {
                RollingCapError::Exceeded => error!(BridgeError::LockDailyCapExceeded),
                RollingCapError::Overflow => error!(BridgeError::MathOverflow),
            })?;
            cfg_mut.lock_daily_used = used;
            cfg_mut.lock_day_start = day_start;
        }

        // Pull the full gross (net + fee) from the sender into custody, then
        // verify custody actually received it (guards fee-on-transfer mints —
        // NAVE is a plain mint, but this keeps the accounting sound regardless).
        let custody_before = ctx.accounts.custody.amount;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender_nave_account.to_account_info(),
                    to: ctx.accounts.custody.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            split.gross,
        )?;
        ctx.accounts.custody.reload()?;
        require!(
            ctx.accounts.custody.amount >= custody_before.saturating_add(split.gross),
            BridgeError::LockNotFullyFunded
        );

        // Resolve the fee on Solana out of custody (custody authority signs).
        distribute_fee(
            &ctx.accounts.token_program,
            &ctx.accounts.nave_mint,
            &ctx.accounts.custody,
            &ctx.accounts.custody_authority,
            &ctx.accounts.protocol_fee_account,
            &ctx.accounts.staking_pool_account,
            custody_authority_bump,
            split.burn,
            split.staking,
            split.protocol,
        )?;

        let cfg_mut = &mut ctx.accounts.config;
        let nonce = cfg_mut.outbound_nonce;
        cfg_mut.outbound_nonce = nonce.checked_add(1).ok_or(BridgeError::MathOverflow)?;

        emit!(BridgeLock {
            sender: ctx.accounts.sender.key(),
            dest_chain_id,
            evm_recipient,
            gross_amount: split.gross,
            net_amount: split.net,
            fee_amount: split.fee,
            staking_amount: split.staking,
            protocol_amount: split.protocol,
            burn_amount: split.burn,
            nonce,
            timestamp: now,
        });
        Ok(())
    }

    /// Relayer-only: release NAVE from custody to satisfy a verified inbound EVM
    /// burn. `net_amount` is what the recipient receives; the fee (already
    /// burned in wNAVE on the source side as part of `gross`) is resolved on
    /// Solana here too ("claim the fee on the SOL side always"). Guarded by
    /// pause, per-tx + rolling daily caps, and a `ProcessedRelease` replay PDA.
    pub fn release(
        ctx: Context<Release>,
        source_chain_id: u64,
        source_message_id: [u8; 32],
        net_amount: u64,
        recipient: Pubkey,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, BridgeError::BridgePaused);
        require!(net_amount > 0, BridgeError::ZeroAmount);
        require!(
            cfg.per_tx_cap == 0 || net_amount <= cfg.per_tx_cap,
            BridgeError::PerTxCapExceeded
        );
        require!(
            ctx.accounts.recipient_nave_account.owner == recipient,
            BridgeError::InvalidDestination
        );
        require_fee_destinations(
            cfg,
            &ctx.accounts.protocol_fee_account,
            &ctx.accounts.staking_pool_account,
        )?;

        let split = compute_fee_split(net_amount, cfg.fee_bps, cfg.staking_bps, cfg.burn_bps)?;

        // Rolling daily cap on the NET released (window resets after 24h).
        let now = Clock::get()?.unix_timestamp;
        let cfg_mut = &mut ctx.accounts.config;
        if now.saturating_sub(cfg_mut.window_start) >= DAILY_WINDOW_SECS {
            cfg_mut.window_start = now;
            cfg_mut.daily_released = 0;
        }
        if cfg_mut.daily_cap != 0 {
            let projected = cfg_mut
                .daily_released
                .checked_add(net_amount)
                .ok_or(BridgeError::MathOverflow)?;
            require!(projected <= cfg_mut.daily_cap, BridgeError::DailyCapExceeded);
            cfg_mut.daily_released = projected;
        }

        let bump = cfg_mut.custody_authority_bump;

        // Pay the recipient their net out of custody (custody authority signs).
        transfer_from_custody(
            &ctx.accounts.token_program,
            &ctx.accounts.custody,
            &ctx.accounts.recipient_nave_account,
            &ctx.accounts.custody_authority,
            bump,
            split.net,
        )?;

        // Resolve the fee on Solana out of custody.
        distribute_fee(
            &ctx.accounts.token_program,
            &ctx.accounts.nave_mint,
            &ctx.accounts.custody,
            &ctx.accounts.custody_authority,
            &ctx.accounts.protocol_fee_account,
            &ctx.accounts.staking_pool_account,
            bump,
            split.burn,
            split.staking,
            split.protocol,
        )?;

        // Record the replay guard (fields only; account init enforces
        // uniqueness of (config, source_message_id)).
        let processed = &mut ctx.accounts.processed_release;
        processed.bump = ctx.bumps.processed_release;
        processed.source_chain_id = source_chain_id;
        processed.source_message_id = source_message_id;
        processed.amount = split.net;
        processed.recipient = recipient;
        processed.released_at = now;

        emit!(BridgeRelease {
            source_chain_id,
            source_message_id,
            recipient,
            gross_amount: split.gross,
            net_amount: split.net,
            fee_amount: split.fee,
            staking_amount: split.staking,
            protocol_amount: split.protocol,
            burn_amount: split.burn,
            timestamp: now,
        });
        Ok(())
    }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

fn require_keys_nonzero(key: Pubkey) -> Result<()> {
    require!(key != Pubkey::default(), BridgeError::Unauthorized);
    Ok(())
}

/// Failure modes of [`apply_rolling_cap`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollingCapError {
    /// Projected window total would exceed the cap.
    Exceeded,
    /// `used + amount` overflowed `u64`.
    Overflow,
}

/// Pure rolling-24h-window cap accounting (used by `lock`; mirrors the inline
/// logic in `release` and the EVM `NaveBridge` mint cap). Given the current
/// `(used, window_start)` state, returns the NEW `(used, window_start)` after
/// admitting `amount` at time `now`:
///   * if `now - window_start >= DAILY_WINDOW_SECS` the window is reset first
///     (`used = 0`, `window_start = now`);
///   * `cap == 0` means unlimited — the window still rolls but nothing is
///     rejected and usage is still tracked;
///   * otherwise `used + amount` must be `<= cap`.
pub fn apply_rolling_cap(
    cap: u64,
    used: u64,
    window_start: i64,
    now: i64,
    amount: u64,
) -> std::result::Result<(u64, i64), RollingCapError> {
    let (mut used, mut window_start) = (used, window_start);
    if now.saturating_sub(window_start) >= DAILY_WINDOW_SECS {
        window_start = now;
        used = 0;
    }
    let projected = used.checked_add(amount).ok_or(RollingCapError::Overflow)?;
    if cap != 0 && projected > cap {
        return Err(RollingCapError::Exceeded);
    }
    Ok((projected, window_start))
}

/// Enforce `staking + protocol + burn == fee` and the fee ceiling.
fn validate_fee_config(fee_bps: u16, staking_bps: u16, protocol_bps: u16, burn_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, BridgeError::FeeTooHigh);
    let sum = (staking_bps as u32) + (protocol_bps as u32) + (burn_bps as u32);
    require!(sum == fee_bps as u32, BridgeError::FeeSplitMismatch);
    Ok(())
}

/// Validate the passed protocol/staking token accounts match the configured
/// owners and the NAVE mint (so fees can only flow to the sanctioned wallets).
fn require_fee_destinations(
    cfg: &BridgeConfig,
    protocol_fee_account: &Account<TokenAccount>,
    staking_pool_account: &Account<TokenAccount>,
) -> Result<()> {
    require!(protocol_fee_account.mint == cfg.nave_mint, BridgeError::MintMismatch);
    require!(staking_pool_account.mint == cfg.nave_mint, BridgeError::MintMismatch);
    require!(
        protocol_fee_account.owner == cfg.protocol_fee_owner,
        BridgeError::InvalidDestination
    );
    require!(
        staking_pool_account.owner == cfg.staking_pool_owner,
        BridgeError::InvalidDestination
    );
    Ok(())
}

/// Transfer `amount` out of custody to `dest`, signed by the custody authority PDA.
fn transfer_from_custody<'info>(
    token_program: &Program<'info, Token>,
    custody: &Account<'info, TokenAccount>,
    dest: &Account<'info, TokenAccount>,
    custody_authority: &UncheckedAccount<'info>,
    bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[CUSTODY_AUTHORITY_SEED, &[bump]];
    let signer: &[&[&[u8]]] = &[seeds];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: custody.to_account_info(),
                to: dest.to_account_info(),
                authority: custody_authority.to_account_info(),
            },
            signer,
        ),
        amount,
    )
}

/// Resolve the fee out of custody: burn `burn_amount` NAVE, transfer `staking`
/// to the staking pool, and `protocol` to the protocol-revenue account. All
/// signed by the custody authority PDA.
#[allow(clippy::too_many_arguments)]
fn distribute_fee<'info>(
    token_program: &Program<'info, Token>,
    nave_mint: &Account<'info, Mint>,
    custody: &Account<'info, TokenAccount>,
    custody_authority: &UncheckedAccount<'info>,
    protocol_fee_account: &Account<'info, TokenAccount>,
    staking_pool_account: &Account<'info, TokenAccount>,
    bump: u8,
    burn_amount: u64,
    staking_amount: u64,
    protocol_amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[CUSTODY_AUTHORITY_SEED, &[bump]];
    let signer: &[&[&[u8]]] = &[seeds];

    if burn_amount > 0 {
        token::burn(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Burn {
                    mint: nave_mint.to_account_info(),
                    from: custody.to_account_info(),
                    authority: custody_authority.to_account_info(),
                },
                signer,
            ),
            burn_amount,
        )?;
    }
    transfer_from_custody(token_program, custody, staking_pool_account, custody_authority, bump, staking_amount)?;
    transfer_from_custody(token_program, custody, protocol_fee_account, custody_authority, bump, protocol_amount)?;
    Ok(())
}

#[cfg(test)]
mod config_guard_tests {
    use super::*;

    #[test]
    fn valid_default_split_passes() {
        // 2.5% total = 1% staking + 1% protocol + 0.5% burn.
        assert!(validate_fee_config(250, 100, 100, 50).is_ok());
    }

    #[test]
    fn zero_fee_split_passes() {
        assert!(validate_fee_config(0, 0, 0, 0).is_ok());
    }

    #[test]
    fn split_must_sum_to_fee() {
        // staking + protocol + burn (100+100+50=250) must equal fee_bps.
        assert!(validate_fee_config(250, 100, 100, 50).is_ok());
        // Under-sum and over-sum both rejected.
        assert!(validate_fee_config(250, 100, 100, 49).is_err());
        assert!(validate_fee_config(250, 100, 100, 51).is_err());
        assert!(validate_fee_config(200, 100, 100, 50).is_err());
    }

    #[test]
    fn fee_above_ceiling_rejected() {
        // MAX_FEE_BPS = 1000 (10%). Exactly the ceiling is allowed if the split
        // matches; one over is rejected regardless of split.
        assert!(validate_fee_config(MAX_FEE_BPS, MAX_FEE_BPS, 0, 0).is_ok());
        assert!(validate_fee_config(MAX_FEE_BPS + 1, MAX_FEE_BPS + 1, 0, 0).is_err());
    }

    #[test]
    fn nonzero_key_guard() {
        assert!(require_keys_nonzero(Pubkey::default()).is_err());
        assert!(require_keys_nonzero(Pubkey::new_unique()).is_ok());
    }

    // ── lock daily cap (rolling window) ─────────────────────────────────────

    #[test]
    fn rolling_cap_admits_up_to_cap_within_window() {
        let t0 = 1_700_000_000;
        let (used, start) = apply_rolling_cap(1_000, 0, t0, t0, 600).unwrap();
        assert_eq!((used, start), (600, t0));
        // Exactly reaching the cap is allowed.
        let (used, start) = apply_rolling_cap(1_000, used, start, t0 + 100, 400).unwrap();
        assert_eq!((used, start), (1_000, t0));
        // One more unit over the cap inside the same window is rejected.
        assert_eq!(
            apply_rolling_cap(1_000, used, start, t0 + 200, 1),
            Err(RollingCapError::Exceeded)
        );
    }

    #[test]
    fn rolling_cap_resets_after_24h() {
        let t0 = 1_700_000_000;
        let (used, start) = apply_rolling_cap(1_000, 0, t0, t0, 1_000).unwrap();
        // Just before the window boundary: still saturated.
        assert_eq!(
            apply_rolling_cap(1_000, used, start, t0 + DAILY_WINDOW_SECS - 1, 1),
            Err(RollingCapError::Exceeded)
        );
        // At exactly 24h the window rolls: usage resets and the new window
        // starts at `now`.
        let (used, start) =
            apply_rolling_cap(1_000, used, start, t0 + DAILY_WINDOW_SECS, 700).unwrap();
        assert_eq!((used, start), (700, t0 + DAILY_WINDOW_SECS));
    }

    #[test]
    fn rolling_cap_zero_means_unlimited_but_still_tracks() {
        let t0 = 1_700_000_000;
        let (used, _) = apply_rolling_cap(0, 0, t0, t0, u64::MAX / 2).unwrap();
        let (used, _) = apply_rolling_cap(0, used, t0, t0 + 1, u64::MAX / 2).unwrap();
        assert_eq!(used, (u64::MAX / 2) * 2);
        // Even unlimited must not silently wrap.
        assert_eq!(
            apply_rolling_cap(0, u64::MAX, t0, t0 + 2, 1),
            Err(RollingCapError::Overflow)
        );
    }

    #[test]
    fn rolling_cap_rejects_single_lock_over_cap_on_fresh_window() {
        let t0 = 1_700_000_000;
        assert_eq!(
            apply_rolling_cap(500, 0, t0, t0, 501),
            Err(RollingCapError::Exceeded)
        );
    }

    // ── destination-chain allowlist ─────────────────────────────────────────

    fn empty_config() -> BridgeConfig {
        BridgeConfig {
            bump: 0,
            owner: Pubkey::default(),
            pending_owner: Pubkey::default(),
            relayer: Pubkey::default(),
            nave_mint: Pubkey::default(),
            custody: Pubkey::default(),
            custody_authority_bump: 0,
            protocol_fee_owner: Pubkey::default(),
            staking_pool_owner: Pubkey::default(),
            fee_bps: 0,
            staking_bps: 0,
            protocol_bps: 0,
            burn_bps: 0,
            paused: false,
            per_tx_cap: 0,
            daily_cap: 0,
            daily_released: 0,
            window_start: 0,
            outbound_nonce: 0,
            reserved: [0u8; 64],
            lock_daily_cap: 0,
            lock_daily_used: 0,
            lock_day_start: 0,
            allowed_dest_chains: [0u64; MAX_ALLOWED_DEST_CHAINS],
        }
    }

    #[test]
    fn allowlist_starts_empty_and_rejects_everything() {
        let cfg = empty_config();
        assert!(!cfg.is_dest_chain_allowed(1));
        assert!(!cfg.is_dest_chain_allowed(8453));
        // 0 is the empty-slot marker and is never a valid destination.
        assert!(!cfg.is_dest_chain_allowed(0));
    }

    #[test]
    fn allowlist_add_remove_is_idempotent() {
        let mut cfg = empty_config();
        cfg.set_dest_chain_allowed(8453, true).unwrap();
        cfg.set_dest_chain_allowed(8453, true).unwrap(); // no duplicate slot
        assert!(cfg.is_dest_chain_allowed(8453));
        assert_eq!(cfg.allowed_dest_chains.iter().filter(|c| **c == 8453).count(), 1);
        assert!(!cfg.is_dest_chain_allowed(1));

        cfg.set_dest_chain_allowed(8453, false).unwrap();
        assert!(!cfg.is_dest_chain_allowed(8453));
        cfg.set_dest_chain_allowed(8453, false).unwrap(); // removing absent is a no-op
        assert!(cfg.allowed_dest_chains.iter().all(|c| *c == 0));
    }

    #[test]
    fn allowlist_full_and_zero_chain_id_rejected() {
        let mut cfg = empty_config();
        for id in 1..=(MAX_ALLOWED_DEST_CHAINS as u64) {
            cfg.set_dest_chain_allowed(id, true).unwrap();
        }
        assert!(cfg.set_dest_chain_allowed(999, true).is_err());
        // Freeing a slot makes room again.
        cfg.set_dest_chain_allowed(1, false).unwrap();
        cfg.set_dest_chain_allowed(999, true).unwrap();
        assert!(cfg.is_dest_chain_allowed(999));
        assert!(cfg.set_dest_chain_allowed(0, true).is_err());
        assert!(cfg.set_dest_chain_allowed(0, false).is_err());
    }

    #[test]
    fn bridge_config_len_matches_serialized_size() {
        // Anchor `space = BridgeConfig::LEN` must equal discriminator + Borsh body.
        let cfg = empty_config();
        let body = cfg.try_to_vec().unwrap();
        assert_eq!(BridgeConfig::LEN, 8 + body.len());
    }
}

// ─── Account contexts ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // SECURITY (init race): only the program's upgrade authority may bootstrap
    // the singleton config. Without this, whoever calls `initialize_config`
    // first — between the program deploy/upgrade and the cutover init tx —
    // could set themselves as owner/relayer and point the fee accounts at
    // themselves, then the real init would fail (PDA already in use). Binding
    // the payer to the on-chain upgrade authority makes the bootstrap
    // unspoofable and lets init be run safely (idempotently) post-deploy.
    #[account(constraint = bridge_program.programdata_address()? == Some(program_data.key()) @ BridgeError::Unauthorized)]
    pub bridge_program: Program<'info, crate::program::NaveBridge>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ BridgeError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    #[account(
        init,
        payer = payer,
        space = BridgeConfig::LEN,
        seeds = [BRIDGE_CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, BridgeConfig>>,

    pub nave_mint: Box<Account<'info, Mint>>,

    /// CHECK: PDA that owns the custody token account; validated by seeds.
    #[account(seeds = [CUSTODY_AUTHORITY_SEED], bump)]
    pub custody_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        seeds = [CUSTODY_SEED],
        bump,
        token::mint = nave_mint,
        token::authority = custody_authority,
    )]
    pub custody: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [BRIDGE_CONFIG_SEED],
        bump = config.bump,
        has_one = owner @ BridgeError::Unauthorized
    )]
    pub config: Box<Account<'info, BridgeConfig>>,
}

#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    pub new_owner: Signer<'info>,

    #[account(
        mut,
        seeds = [BRIDGE_CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_owner == new_owner.key() @ BridgeError::Unauthorized
    )]
    pub config: Box<Account<'info, BridgeConfig>>,
}

#[derive(Accounts)]
pub struct Lock<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(mut, seeds = [BRIDGE_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, BridgeConfig>>,

    #[account(mut, address = config.nave_mint @ BridgeError::MintMismatch)]
    pub nave_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = sender_nave_account.mint == config.nave_mint @ BridgeError::MintMismatch,
        constraint = sender_nave_account.owner == sender.key() @ BridgeError::InvalidTokenAccount
    )]
    pub sender_nave_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = config.custody @ BridgeError::InvalidTokenAccount)]
    pub custody: Box<Account<'info, TokenAccount>>,

    /// CHECK: custody authority PDA; validated by seeds + config bump.
    #[account(seeds = [CUSTODY_AUTHORITY_SEED], bump = config.custody_authority_bump)]
    pub custody_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub protocol_fee_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub staking_pool_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(source_chain_id: u64, source_message_id: [u8; 32])]
pub struct Release<'info> {
    #[account(mut, address = config.relayer @ BridgeError::Unauthorized)]
    pub relayer: Signer<'info>,

    #[account(mut, seeds = [BRIDGE_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, BridgeConfig>>,

    #[account(mut, address = config.nave_mint @ BridgeError::MintMismatch)]
    pub nave_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = config.custody @ BridgeError::InvalidTokenAccount)]
    pub custody: Box<Account<'info, TokenAccount>>,

    /// CHECK: custody authority PDA; validated by seeds + config bump.
    #[account(seeds = [CUSTODY_AUTHORITY_SEED], bump = config.custody_authority_bump)]
    pub custody_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = recipient_nave_account.mint == config.nave_mint @ BridgeError::MintMismatch
    )]
    pub recipient_nave_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub protocol_fee_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub staking_pool_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = relayer,
        space = ProcessedRelease::LEN,
        seeds = [
            PROCESSED_RELEASE_SEED,
            config.key().as_ref(),
            &source_chain_id.to_le_bytes(),
            source_message_id.as_ref(),
        ],
        bump
    )]
    pub processed_release: Box<Account<'info, ProcessedRelease>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
