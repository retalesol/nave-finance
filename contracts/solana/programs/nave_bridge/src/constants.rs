use anchor_lang::prelude::*;

/// Singleton bridge configuration PDA.
pub const BRIDGE_CONFIG_SEED: &[u8] = b"bridge_config";
/// Custody authority PDA that owns the locked-NAVE custody token account and
/// signs all fee/burn/release token movements out of custody.
pub const CUSTODY_AUTHORITY_SEED: &[u8] = b"bridge_custody_authority";
/// The custody token account PDA (holds the NAVE backing all minted wNAVE).
pub const CUSTODY_SEED: &[u8] = b"bridge_custody";
/// Per-inbound-message replay guard PDA. Seeded by
/// (PROCESSED_RELEASE_SEED, config, source_chain_id (u64 LE), source_message_id)
/// — the 32-byte source message id is the source-chain burn transaction hash.
/// Its existence marks a release as already processed, so a relayer bug or
/// compromise cannot pay the same source message twice.
///
/// The `source_chain_id` is included in the seed (defense-in-depth, audit P6):
/// the same 32-byte message id arriving from two different source chains derives
/// two distinct PDAs, so there is no cross-chain collision even in the
/// astronomically unlikely event of a tx-hash collision across chains. The
/// off-chain relayer derivation must encode `source_chain_id` little-endian to
/// match `to_le_bytes()` here.
pub const PROCESSED_RELEASE_SEED: &[u8] = b"bridge_processed";

/// Basis-point denominator (10_000 = 100%).
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Default total bridge fee charged ON TOP of the bridged amount: 2.5%.
pub const DEFAULT_FEE_BPS: u16 = 250;
/// Default staking-pool share of the bridged amount: 1%.
pub const DEFAULT_STAKING_BPS: u16 = 100;
/// Default protocol-revenue share of the bridged amount: 1%.
pub const DEFAULT_PROTOCOL_BPS: u16 = 100;
/// Default auto-burn share of the bridged amount: 0.5%.
pub const DEFAULT_BURN_BPS: u16 = 50;

/// Upper bound on the total fee an owner may configure (10% — a sanity ceiling
/// so a misconfiguration/compromised-owner cannot set a confiscatory fee).
pub const MAX_FEE_BPS: u16 = 1_000;

/// Rolling window length for the daily release cap (24h).
pub const DAILY_WINDOW_SECS: i64 = 86_400;

/// EVM addresses are 20 bytes; recipients on EVM destinations are carried as a
/// fixed 20-byte array embedded in the `lock` instruction data (so the user's
/// single source-tx signature authorizes the exact payout address — no separate
/// off-chain message signature is required).
pub const EVM_ADDRESS_LEN: usize = 20;
