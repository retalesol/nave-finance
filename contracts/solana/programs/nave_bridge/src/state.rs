use anchor_lang::prelude::*;

/// Singleton bridge configuration. Owned/administered by the `owner` (intended
/// to be a Squads multisig on mainnet). The `relayer` is the single hot key
/// permitted to call `release` (pay out a verified inbound bridge message); it
/// is bounded on-chain by the pause flag, per-tx cap, rolling daily cap, and
/// per-message replay guards so a compromised relayer key cannot drain custody
/// or double-pay.
#[account]
pub struct BridgeConfig {
    /// PDA bump.
    pub bump: u8,
    /// Administrative owner (multisig on mainnet): rotates config/relayer/pause.
    pub owner: Pubkey,
    /// Pending owner for two-step ownership handoff (zero = none).
    pub pending_owner: Pubkey,
    /// The single relayer hot key allowed to call `release`.
    pub relayer: Pubkey,
    /// Canonical NAVE SPL mint this bridge custodies.
    pub nave_mint: Pubkey,
    /// Custody token account (holds locked NAVE). Authority = custody PDA.
    pub custody: Pubkey,
    /// Bump for the custody-authority PDA (signs token movements out of custody).
    pub custody_authority_bump: u8,
    /// Owner pubkey of the protocol-revenue NAVE account (fee: protocol share).
    pub protocol_fee_owner: Pubkey,
    /// Owner pubkey of the staking-pool NAVE account (fee: staking share). This
    /// is the central Solana staking reward vault's owner (the nave_staking
    /// RewardPool authority PDA).
    pub staking_pool_owner: Pubkey,
    /// Total fee (bps) charged ON TOP of the bridged amount (e.g. 250 = 2.5%).
    pub fee_bps: u16,
    /// Staking share of the bridged amount (bps).
    pub staking_bps: u16,
    /// Protocol-revenue share of the bridged amount (bps).
    pub protocol_bps: u16,
    /// Auto-burn share of the bridged amount (bps).
    pub burn_bps: u16,
    /// Whether the bridge is paused (blocks lock + release).
    pub paused: bool,
    /// Per-transaction cap on the net bridged amount (0 = unlimited).
    pub per_tx_cap: u64,
    /// Rolling 24h cap on total released net amount (0 = unlimited).
    pub daily_cap: u64,
    /// Net amount released so far in the current rolling window.
    pub daily_released: u64,
    /// Unix timestamp marking the start of the current rolling window.
    pub window_start: i64,
    /// Monotonic outbound nonce assigned to each `lock` (for the relayer/indexer
    /// to key inbound EVM mints on; guarantees a unique per-lock identifier).
    pub outbound_nonce: u64,
    /// Reserved for future fields without a layout migration.
    pub reserved: [u8; 64],
    // ── Outbound (`lock`) guardrails — appended AFTER `reserved` so every
    // pre-existing field keeps its byte offset for off-chain decoders. ──────
    /// Rolling 24h cap on total NET amount locked (bridged OUT); 0 = unlimited.
    /// Independent of `daily_cap`, which bounds inbound `release`.
    pub lock_daily_cap: u64,
    /// Net amount locked so far in the current outbound rolling window.
    pub lock_daily_used: u64,
    /// Unix timestamp marking the start of the current outbound rolling window.
    pub lock_day_start: i64,
    /// Destination-chain allowlist for `lock`: fixed slots of EVM chain ids,
    /// `0` = empty slot. A `lock` whose `dest_chain_id` is not present is
    /// rejected (`UnsupportedChain`), so funds can never be locked against a
    /// destination the relayer does not serve (they would be unrecoverable
    /// without owner intervention). Empty allowlist ⇒ all locks rejected.
    pub allowed_dest_chains: [u64; MAX_ALLOWED_DEST_CHAINS],
}

/// Number of destination-chain allowlist slots on `BridgeConfig`.
pub const MAX_ALLOWED_DEST_CHAINS: usize = 8;

impl BridgeConfig {
    pub const LEN: usize = 8   // discriminator
        + 1                    // bump
        + 32                   // owner
        + 32                   // pending_owner
        + 32                   // relayer
        + 32                   // nave_mint
        + 32                   // custody
        + 1                    // custody_authority_bump
        + 32                   // protocol_fee_owner
        + 32                   // staking_pool_owner
        + 2 + 2 + 2 + 2        // fee_bps, staking_bps, protocol_bps, burn_bps
        + 1                    // paused
        + 8                    // per_tx_cap
        + 8                    // daily_cap
        + 8                    // daily_released
        + 8                    // window_start
        + 8                    // outbound_nonce
        + 64                   // reserved
        + 8                    // lock_daily_cap
        + 8                    // lock_daily_used
        + 8                    // lock_day_start
        + 8 * MAX_ALLOWED_DEST_CHAINS; // allowed_dest_chains

    /// Whether `chain_id` is on the destination allowlist. `0` is never a
    /// valid chain id (it is the empty-slot marker).
    pub fn is_dest_chain_allowed(&self, chain_id: u64) -> bool {
        chain_id != 0 && self.allowed_dest_chains.contains(&chain_id)
    }

    /// Add (`allowed = true`) or remove (`allowed = false`) `chain_id` from the
    /// allowlist. Idempotent. Errors with `AllowlistFull` when adding to a full
    /// list and `InvalidChainId` for `chain_id == 0`.
    pub fn set_dest_chain_allowed(&mut self, chain_id: u64, allowed: bool) -> Result<()> {
        require!(chain_id != 0, crate::errors::BridgeError::InvalidChainId);
        if allowed {
            if self.allowed_dest_chains.contains(&chain_id) {
                return Ok(());
            }
            let slot = self
                .allowed_dest_chains
                .iter_mut()
                .find(|slot| **slot == 0)
                .ok_or(crate::errors::BridgeError::AllowlistFull)?;
            *slot = chain_id;
        } else {
            for slot in self.allowed_dest_chains.iter_mut() {
                if *slot == chain_id {
                    *slot = 0;
                }
            }
        }
        Ok(())
    }
}

/// Replay-guard PDA created on each successful `release`. Its existence (keyed
/// by the 32-byte source message id — the EVM burn tx hash) makes a second
/// release of the same inbound message fail at account init, which is the
/// on-chain primary replay protection (independent of any off-chain database).
#[account]
pub struct ProcessedRelease {
    pub bump: u8,
    /// Source chain id the inbound message came from (e.g. EVM chain id).
    pub source_chain_id: u64,
    /// 32-byte source message id that was paid (the EVM burn transaction hash).
    pub source_message_id: [u8; 32],
    /// Net NAVE amount released.
    pub amount: u64,
    /// Recipient that was paid.
    pub recipient: Pubkey,
    /// Unix timestamp of the release.
    pub released_at: i64,
}

impl ProcessedRelease {
    pub const LEN: usize = 8 + 1 + 8 + 32 + 8 + 32 + 8;
}
