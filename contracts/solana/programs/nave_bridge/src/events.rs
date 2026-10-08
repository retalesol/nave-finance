use anchor_lang::prelude::*;

/// Emitted when a user locks NAVE to bridge OUT to an EVM chain. The relayer /
/// indexer keys the destination mint on `(outbound_nonce, dest_chain_id,
/// evm_recipient, net_amount)`. `evm_recipient` is embedded in the lock
/// instruction data, so this single signed transaction fully authorizes the
/// EVM-side payout address (no separate off-chain message signature needed).
#[event]
pub struct BridgeLock {
    /// The Solana wallet that locked (source-chain sender).
    pub sender: Pubkey,
    /// Destination EVM chain id.
    pub dest_chain_id: u64,
    /// 20-byte EVM recipient address (authorized by this tx's signature).
    pub evm_recipient: [u8; 20],
    /// Gross amount pulled from the user (net + fee).
    pub gross_amount: u64,
    /// Net amount to be minted on the destination chain.
    pub net_amount: u64,
    /// Total fee taken (staking + protocol + burn).
    pub fee_amount: u64,
    /// Fee legs (in NAVE base units) resolved on Solana.
    pub staking_amount: u64,
    pub protocol_amount: u64,
    pub burn_amount: u64,
    /// Monotonic outbound nonce (unique per lock).
    pub nonce: u64,
    pub timestamp: i64,
}

/// Emitted when the relayer releases NAVE from custody to satisfy a verified
/// inbound EVM burn (bridge IN to Solana). The fee is resolved on Solana here
/// too ("claim the fee on the SOL side always").
#[event]
pub struct BridgeRelease {
    /// Source EVM chain id the burn happened on.
    pub source_chain_id: u64,
    /// 32-byte source message id that was paid (EVM burn tx hash; replay key).
    pub source_message_id: [u8; 32],
    /// Solana recipient paid.
    pub recipient: Pubkey,
    /// Gross amount burned on the source chain (net + fee).
    pub gross_amount: u64,
    /// Net NAVE amount released to the recipient.
    pub net_amount: u64,
    pub fee_amount: u64,
    pub staking_amount: u64,
    pub protocol_amount: u64,
    pub burn_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct BridgeConfigUpdated {
    pub owner: Pubkey,
    pub relayer: Pubkey,
    pub fee_bps: u16,
    pub staking_bps: u16,
    pub protocol_bps: u16,
    pub burn_bps: u16,
    pub per_tx_cap: u64,
    pub daily_cap: u64,
    pub paused: bool,
}

#[event]
pub struct BridgeOwnershipTransferred {
    pub previous: Pubkey,
    pub current: Pubkey,
}

/// Emitted when the owner changes the outbound (`lock`) rolling daily cap.
#[event]
pub struct BridgeLockDailyCapUpdated {
    pub lock_daily_cap: u64,
}

/// Emitted when the owner adds/removes a destination chain from the `lock`
/// allowlist.
#[event]
pub struct BridgeDestChainAllowlistUpdated {
    pub chain_id: u64,
    pub allowed: bool,
}
