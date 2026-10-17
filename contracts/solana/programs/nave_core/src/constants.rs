use anchor_lang::prelude::*;

/// nave_execution program id for adapter CPI caller verification.
pub mod nave_execution_program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb");
}

/// nave_governance program id for governance CPI caller verification.
pub mod nave_governance_program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M");
}

pub const GLOBAL_CONFIG_SEED: &[u8] = b"global_config";
pub const DAO_REGISTRY_SEED: &[u8] = b"dao";
pub const TREASURY_VAULT_SEED: &[u8] = b"treasury_vault";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
pub const AGENT_SET_SEED: &[u8] = b"agent_set";
pub const GUARDIAN_CONFIG_SEED: &[u8] = b"guardian_config";
pub const CONSTITUTION_SEED: &[u8] = b"constitution";
pub const TOKEN_REGISTRY_SEED: &[u8] = b"token_registry";
pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
/// Per-DAO recoverable NAVE creation stake record (companion PDA to the
/// registry; appended capability, registry byte layout untouched).
pub const DAO_STAKE_LOCK_SEED: &[u8] = b"dao_stake_lock";
/// Per-DAO NAVE escrow token account holding the locked creation stake. Owned
/// (authority) by the `DaoStakeLock` PDA so release signs with its own seeds.
pub const STAKE_ESCROW_SEED: &[u8] = b"stake_escrow";
/// Per-DAO moonlighting lifecycle companion PDA. Kept separate from
/// `DaoRegistry` so the registry byte layout consumed by off-chain decoders /
/// IDL clients is preserved (the lifecycle is opt-in, created on first use).
pub const DAO_LIFECYCLE_SEED: &[u8] = b"dao_lifecycle";
pub const DAO_CONTROL_SEED: &[u8] = b"dao_control";
pub const STRATEGY_POSITION_SEED: &[u8] = b"strategy_position";
pub const STRATEGY_ESCROW_SEED: &[u8] = b"strategy_escrow";
pub const GUARDIAN_ACTION_SEED: &[u8] = b"guardian_action";
pub const HOLDER_ANNOTATION_SEED: &[u8] = b"holder_annotation";
pub const PROTOCOL_FEE_VAULT_SEED: &[u8] = b"protocol_fee_vault";

// ── Multi-asset treasury seeds ───────────────────────────────────────────────
/// Per-(dao, mint) asset configuration: Pyth feed id, decimals, classification.
pub const ASSET_CONFIG_SEED: &[u8] = b"asset_config";
/// Per-(dao, mint) treasury accounting record.
pub const TREASURY_ASSET_SEED: &[u8] = b"treasury_asset";
/// Per-(dao, mint) holding token account PDA, owned by vault_authority.
pub const ASSET_VAULT_SEED: &[u8] = b"asset_vault";
/// Per-(dao, nft_mint) record PDA for a held NFT. Kept separate from
/// `TreasuryAsset` so NFTs do not consume the fungible asset cap or require Pyth
/// pricing — they are custodied at $0 NAV and moved only via governance.
pub const NFT_VAULT_RECORD_SEED: &[u8] = b"nft_vault_record";
/// Per-(dao, nft_mint) holding token account PDA (owned by vault_authority).
pub const NFT_VAULT_SEED: &[u8] = b"nft_vault";
/// Per-(dao, protocol_id, mint) receipt-token account PDA (cTokens / poolSOL).
pub const POSITION_TOKEN_SEED: &[u8] = b"position_token";
/// Per-dao system-owned PDA used as the native-SOL funding signer for SPL
/// stake-pool DepositSol (the funding account must be a System account).
pub const SOL_FUNDING_SEED: &[u8] = b"sol_funding";

pub const MAX_GUARDIAN_WALLETS: usize = 10;
pub const MAX_GUARDIAN_THRESHOLD: u8 = 7;
/// Wire length of a `ProposalType::Permission` payload:
/// `threshold(1) ‖ wallet_count(1) ‖ wallets(MAX_GUARDIAN_WALLETS × 32)`.
pub const PERMISSION_PAYLOAD_LEN: usize = 1 + 1 + (MAX_GUARDIAN_WALLETS * 32);
pub const MAX_CONSTITUTION_PROTOCOLS: usize = 10;
/// `ProtocolEntry::max_allocation_bps` packs the venue risk tier into its two
/// high bits (bps never exceed 10_000 < 2^14): `bps | (tier - 1) << 14`.
/// Legacy entries read as Tier 1.
pub const RISK_TIER_SHIFT: u16 = 14;
pub const ALLOCATION_BPS_MASK: u16 = (1 << RISK_TIER_SHIFT) - 1;
pub const MAX_RISK_TIER: u8 = 3;
/// Sum of approved per-protocol caps allowed within Tier 2 / Tier 3.
pub const MAX_TIER2_TOTAL_BPS: u32 = 3_000;
pub const MAX_TIER3_TOTAL_BPS: u32 = 1_500;
pub const MAX_TOKEN_REGISTRY: usize = 3;
/// Maximum number of distinct treasury assets a DAO may register.
pub const MAX_TREASURY_ASSETS: usize = 8;
pub const AGENT_COUNT: usize = 4;

/// USD aggregates (vault NAV / high-water-mark / deployed) are stored in
/// micro-USD: 1 USD = 1_000_000 units. This keeps stablecoin parity exact and
/// gives sub-cent precision for non-stable assets.
pub const USD_SCALE: u128 = 1_000_000;
/// Maximum staleness (seconds) accepted for a Pyth price update consumed by the
/// on-chain valuation. Mirrors the off-chain Hermes refresh cadence.
pub const PYTH_MAX_PRICE_AGE_SECS: u64 = 60;
/// Maximum accepted Pyth confidence-to-price ratio, in basis points
/// (10_000 = 100%). A price update whose 1-sigma confidence band `conf` exceeds
/// this fraction of the absolute price is rejected (treated like a stale price)
/// so a wide-band / uncertain quote cannot be used to inflate NAV or slip past
/// deployment caps and reserve floors. 200 bps = 2%. Enforced with pure integer
/// math (`conf * 10_000 <= price * PYTH_MAX_CONFIDENCE_BPS`); see
/// `utils::oracle::confidence_within_bounds`.
pub const PYTH_MAX_CONFIDENCE_BPS: u64 = 200;

/// Pyth Solana Receiver pull-oracle program (PriceUpdateV2 owner). Same address
/// on mainnet and devnet.
pub mod pyth_receiver_program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
}

/// Chainlink Data Feeds OCR2 program. Same address on devnet and mainnet.
/// https://docs.chain.link/data-feeds/solana/using-data-feeds-solana
pub mod chainlink_program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
}

/// SOL/USD transmissions account from the Chainlink feed directory.
/// Devnet `sol-usd`: 99B2bTij… Mainnet `sol-usd`: CH31Xn… (heartbeat 180s).
pub mod chainlink_sol_usd {
    use anchor_lang::prelude::*;
    #[cfg(not(feature = "mainnet"))]
    pub const FEED: Pubkey = pubkey!("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
    #[cfg(feature = "mainnet")]
    pub const FEED: Pubkey = pubkey!("CH31Xns5z3M1cTAbKW34jcxPPciazARpijcHj9rxtemt");
    #[cfg(not(feature = "mainnet"))]
    pub const MAX_AGE_SECS: i64 = 86_400;
    #[cfg(feature = "mainnet")]
    pub const MAX_AGE_SECS: i64 = 180;
}

/// Kamino Lending (klend) program. The on-chain Kamino CPIs verify the passed
/// `klend_program` account equals this id before invoking.
pub mod kamino_lending_program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
}

/// SPL Stake Pool program (Jito's stake pool runs on this program). The on-chain
/// Jito CPIs verify the passed `stake_pool_program` account equals this id.
pub mod spl_stake_pool_program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
}

/// Native SOL wrapped-mint (wSOL). Jito-eligible SolLike assets deploy from a
/// wSOL holding account which is unwrapped to native SOL for `DepositSol`.
pub mod wsol_mint {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
}

/// Native Stake program (required by SPL stake-pool `WithdrawSol`).
pub mod stake_program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("Stake11111111111111111111111111111111111111");
}

/// Jupiter Lend (Earn) lending program. The on-chain Jupiter CPIs verify the
/// passed `jupiter_lending_program` account equals this id before invoking.
/// Mainnet-portable: build with `--features mainnet` to target the mainnet
/// deployment; the default (devnet) id is used otherwise. The liquidity program
/// is forwarded as an account (not pinned) so no second const is required.
pub mod jupiter_lending_program {
    use anchor_lang::prelude::*;
    #[cfg(feature = "mainnet")]
    pub const ID: Pubkey = pubkey!("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
    #[cfg(not(feature = "mainnet"))]
    pub const ID: Pubkey = pubkey!("7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3");
}

/// Jupiter v6 swap aggregator program (mainnet). Routes are built off-chain and
/// invoked via CPI from `jupiter_swap`, signed by the `vault_authority` PDA. The
/// on-chain handler verifies the passed `jupiter_program` account equals this id.
/// Mainnet-only: the instruction compiles + deploys to devnet but is only
/// exercisable on mainnet where this program exists.
pub mod jupiter_swap_program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
}

/// MarginFi v2 lending program. The on-chain MarginFi CPIs verify the passed
/// `marginfi_program` account equals this id before invoking. Mainnet-portable:
/// build with `--features mainnet` to target the mainnet deployment; the
/// default (devnet) id is used otherwise. Devnet note: the program is live and
/// has real, permissionlessly-created `Bank` accounts, but there is no single
/// canonical "well-known" devnet group/bank the way there is a canonical Kamino
/// devnet market — `ext_market` (group) / `ext_reserve` (bank) must be
/// discovered or bootstrapped and are bound per-DAO via
/// `configure_marginfi_position`, exactly like Kamino's market/reserve.
pub mod marginfi_program {
    use anchor_lang::prelude::*;
    #[cfg(feature = "mainnet")]
    pub const ID: Pubkey = pubkey!("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
    #[cfg(not(feature = "mainnet"))]
    pub const ID: Pubkey = pubkey!("A7vUDErNPCTt9qrB6SSM4F6GkxzUe9d8P3cXSmRg4eY4");
}

/// SPL Stake Pool `DepositSol` Borsh enum tag.
pub const SPL_STAKE_POOL_DEPOSIT_SOL_TAG: u8 = 14;
/// SPL Stake Pool `WithdrawSol` Borsh enum tag.
pub const SPL_STAKE_POOL_WITHDRAW_SOL_TAG: u8 = 16;

/// DAO formation charges no SOL profit fee and does not require a NAVE stake.
/// This constant is retained as `0` on every network so any lingering
/// references compile, and `initialize_dao_handler` performs NO SOL transfer.
/// `stake_dao_creation` is no longer part of creation; it remains only so a
/// treasury that already locked NAVE can still be released on moonlight.
pub const FORMATION_FEE_LAMPORTS: u64 = 0;

/// SEC-M2: durable on-chain minimum for the DAO creation stake, in NAVE base
/// units (6 decimals ⇒ this is 1.0 NAVE). Previously `1` (a single base unit),
/// which made the "$99 stake" gate trivially bypassable on-chain — the USD
/// value was metadata only, so a founder could create a DAO with dust. This
/// floor is the always-enforced anti-dust/sybil backstop; it is intentionally
/// set below the devnet quote (fixed $10 ⇒ 9.9 NAVE = 9_900_000 base units) so
/// legitimate stakes are unaffected while dust is rejected.
///
/// The USD-accurate `$99` enforcement is a SEPARATE optional Pyth NAVE/USD
/// check (see `stake.rs` and `NAVE_USD_PYTH_FEED_ID` below) that activates only
/// once a trusted NAVE/USD feed id is pinned. Until then this floor is the
/// on-chain gate and the off-chain price-oracle worker owns the exact `$99`
/// amount.
pub const MIN_DAO_STAKE_NAVE_BASE_UNITS: u64 = 1_000_000;

/// SEC-M2 (optional USD leg): Pyth NAVE/USD price-feed id used to verify the
/// creation stake is worth at least `DAO_STAKE_TARGET_USD_MICRO` on-chain.
///
/// All-zero means "no feed configured" (mirrors the unset-`nave_mint`
/// convention on `NaveGlobalConfig`): the USD verification is skipped entirely
/// and only the NAVE floor above is enforced. This is deliberate — no Pyth
/// NAVE/USD feed exists yet on any cluster (this env's devnet NAVE oracle is
/// known-stale, see `deployments/devnet.json`), so a hard requirement would
/// break DAO creation everywhere. When a trusted feed id is pinned here (a
/// program upgrade), `stake_dao_creation` starts requiring a fresh,
/// confidence-bounded `PriceUpdateV2` for that feed as the first remaining
/// account, and rejects stakes worth < `$99`. Chosen as a hardcoded constant
/// rather than a new `global_config` field because the config account's
/// reserved bytes were already consumed by `nave_mint` — appending a field
/// would force a live-account resize migration.
pub const NAVE_USD_PYTH_FEED_ID: [u8; 32] = [0u8; 32];

/// Target USD value (micro-USD) of the DAO creation stake: `$99`. Stored as
/// price-snapshot metadata on `DaoStakeLock` so the stake amount used can be
/// audited against the accepted oracle quote. Enforced on-chain only when
/// `NAVE_USD_PYTH_FEED_ID` is configured (see `stake.rs`); otherwise the
/// oracle service owns price and the minimum enforced is the NAVE floor.
pub const DAO_STAKE_TARGET_USD_MICRO: u64 = 99_000_000;

/// Treasury-seed carve-out from the formation fee. Set to 0: the full formation
/// fee now goes to the protocol treasury. Users supply their own treasury seed
/// as a separate input in the creation wizard (not part of the fee). Kept as a
/// named constant (zero) so existing references compile without changes.
#[cfg(feature = "mainnet")]
pub const TREASURY_SEED_LAMPORTS: u64 = 0;
#[cfg(not(feature = "mainnet"))]
pub const TREASURY_SEED_LAMPORTS: u64 = 0;
/// Cost (in lamports) charged from the DAO treasury when minting a new token.
/// Mainnet: 0.5 SOL. Devnet: 0.01 SOL (minimized for testing).
#[cfg(feature = "mainnet")]
pub const TOKEN_MINT_FEE_LAMPORTS: u64 = 500_000_000;
#[cfg(not(feature = "mainnet"))]
pub const TOKEN_MINT_FEE_LAMPORTS: u64 = 10_000_000;
/// Reward (in lamports) paid back to the DAO treasury when it revokes all
/// authorities. Mainnet: 0.2 SOL. Devnet: 0.001 SOL (minimized for testing).
#[cfg(feature = "mainnet")]
pub const TOKEN_REVOKE_REWARD_LAMPORTS: u64 = 200_000_000;
#[cfg(not(feature = "mainnet"))]
pub const TOKEN_REVOKE_REWARD_LAMPORTS: u64 = 1_000_000;
pub const BPS_DENOMINATOR: u128 = 10_000;

pub const MAX_DAO_NAME_LEN: usize = 32;
pub const MAX_PROTOCOL_ID_LEN: usize = 16;
pub const MAX_TOKEN_NAME_LEN: usize = 32;
pub const MAX_TOKEN_SYMBOL_LEN: usize = 8;
pub const MAX_ANNOTATION_LEN: usize = 256;
pub const MAX_URI_LEN: usize = 128;

/// One UTC day in seconds. Used to floor the management-fee accounting anchor to
/// a midnight-UTC boundary (see `utils::fees::floor_to_utc_midnight`).
pub const SECONDS_PER_DAY: i64 = 86_400;
/// 365-day fee year (365 * 86_400). The discrete annual management fee becomes
/// due once `now >= last_management_fee_at + SECONDS_PER_YEAR`. Equals 365 whole
/// UTC days, so a midnight-aligned anchor stays midnight-aligned after a period.
pub const SECONDS_PER_YEAR: i64 = 365 * SECONDS_PER_DAY;
/// Every timelock below is its production value only in a `mainnet` build;
/// devnet/localnet builds use this instead so the flows can be exercised.
pub const DEV_DELAY_SECS: i64 = 60;

#[cfg(feature = "mainnet")]
pub const AGENT_ROTATION_DELAY_SECONDS: i64 = 172_800;
#[cfg(not(feature = "mainnet"))]
pub const AGENT_ROTATION_DELAY_SECONDS: i64 = DEV_DELAY_SECS;

/// Performance fee: 15% (1500 bps) of realized yield, skimmed on the
/// strategy-withdrawal path before the gain reaches the treasury balance.
/// Normal and frozen treasuries use this same rate. Creation must write it,
/// and `record_strategy_withdrawal` charges it even when `FeeConfig` still
/// stores an older value.
pub const DEFAULT_PERFORMANCE_FEE_BPS: u16 = 1500;
/// Management fee is not charged. The field stays on `FeeConfig` so the
/// account layout does not move; `collect_management_fee` transfers nothing
/// and clears any stored non-zero rate back to this value. Frozen treasuries
/// use the same rate.
pub const DEFAULT_MANAGEMENT_FEE_BPS: u16 = 0;
pub const DEFAULT_QUORUM_BPS: u16 = 1_000;

/// Default minimum Claude reasoning confidence (0-100) for agent signing.
pub const DEFAULT_CONFIDENCE_THRESHOLD: u8 = 70;
/// Maximum confidence threshold value.
pub const MAX_CONFIDENCE_THRESHOLD: u8 = 100;

/// Default mandatory review window (24h) between Oversight approval and
/// `execute_strategy`. Mirrors `nave_execution`'s historical constant.
#[cfg(feature = "mainnet")]
pub const DEFAULT_REVIEW_WINDOW_SECONDS: i64 = 86_400;
#[cfg(not(feature = "mainnet"))]
pub const DEFAULT_REVIEW_WINDOW_SECONDS: i64 = DEV_DELAY_SECS;
/// Minimum review window a DAO may configure (1 minute). Bounded so a DAO
/// cannot disable the human-oversight delay entirely.
pub const MIN_REVIEW_WINDOW_SECONDS: i64 = 60;
/// Maximum review window a DAO may configure (7 days).
pub const MAX_REVIEW_WINDOW_SECONDS: i64 = 7 * 86_400;

// ── Continuous treasury policy bounds ────────────────────────────────────────
// All *_BPS values are basis points (10_000 = 100%). A value of 0 for any of
// the policy floors/caps means "unset" and disables that particular constraint,
// which keeps legacy constitution accounts (created before these fields) safe.

/// Maximum configurable stablecoin reserve floor (100%).
pub const MAX_RESERVE_BPS: u16 = 10_000;
/// Maximum configurable global deployment cap (100%).
pub const MAX_DEPLOYMENT_BPS: u16 = 10_000;
/// Maximum configurable liquidity floor (100%).
pub const MAX_LIQUIDITY_BPS: u16 = 10_000;
/// Maximum configurable `jupiter_swap` slippage guardrail (100%; `0` disables
/// the guardrail entirely, see `TreasuryConstitution::max_slippage_bps`).
pub const MAX_SLIPPAGE_BPS: u16 = 10_000;
/// Maximum configurable `jupiter_swap` single-call size guardrail (100%; `0`
/// disables the cap entirely, see `TreasuryConstitution::max_single_swap_bps`).
pub const MAX_SINGLE_SWAP_BPS: u16 = 10_000;
/// Minimum non-zero rebalance cadence a DAO may configure (1 day).
pub const MIN_REBALANCE_FREQUENCY_SECONDS: i64 = 86_400;
/// Maximum rebalance cadence a DAO may configure (1 year).
pub const MAX_REBALANCE_FREQUENCY_SECONDS: i64 = 365 * 86_400;

/// Default stablecoin reserve floor applied at DAO creation (35%).
pub const DEFAULT_MIN_STABLECOIN_RESERVE_BPS: u16 = 3_500;
/// Default global deployment cap applied at DAO creation (50%).
pub const DEFAULT_MAX_TOTAL_DEPLOYED_BPS: u16 = 5_000;
/// Default liquidity floor applied at DAO creation (20%).
pub const DEFAULT_MIN_LIQUIDITY_BPS: u16 = 2_000;
/// Default rebalance cadence applied at DAO creation (30 days).
pub const DEFAULT_REBALANCE_FREQUENCY_SECONDS: i64 = 30 * 86_400;

/// Default `jupiter_swap` slippage guardrail seeded at DAO creation (1.5%).
/// SOL-C3: `jupiter_swap`'s slippage/size guardrails used to default to `0`
/// (disabled) until the founder explicitly opted in via
/// `set_max_slippage_bps`/`set_max_single_swap_bps`, leaving newly-created
/// DAOs unprotected against a compromised/rogue Oversight agent (`AgentRole::Operational`) until the
/// founder remembered to configure them. Seeding a conservative non-zero
/// default here closes that window; the founder can still retune via the
/// existing setter instructions (including raising or lowering it).
pub const DEFAULT_MAX_SLIPPAGE_BPS: u16 = 150;
/// Default `jupiter_swap` single-call size guardrail seeded at DAO creation
/// (20% of the pre-swap balance of the asset being sold). See
/// `DEFAULT_MAX_SLIPPAGE_BPS` for why this is now seeded non-zero by default.
pub const DEFAULT_MAX_SINGLE_SWAP_BPS: u16 = 2_000;

/// Minimum age (seconds) an UNEXECUTED `GuardianAction` must reach before the
/// founder may `cancel_guardian_action` it to reclaim rent. This delay prevents
/// the founder from front-running / cancelling a *fresh* in-flight guardian
/// action (e.g. an emergency freeze still accumulating signatures); executed
/// actions can be closed immediately. 7 days.
pub const GUARDIAN_ACTION_STALE_SECS: i64 = 7 * SECONDS_PER_DAY;

/// Maximum single-call change to a `StrategyPosition.current_value` manual
/// mark (`update_strategy_position_value`), expressed in bps of the position's
/// PRE-update value (or `deposited_amount` if never marked/zero). Bounds how
/// far the operational agent (or founder) can move the mark in one call, since
/// this value feeds the per-protocol allocation cap (deposit path), the
/// anti-drain withdrawal floor, the realized-yield withdrawal cap, and the
/// performance-fee gain/principal split — an unbounded mark could be set low
/// to hide deployed capital from the allocation cap, or set high to inflate
/// the withdrawal/fee-skim ceiling on fictitious gains. 50%: generous enough
/// for real yield/loss reporting between `revalue_treasury` ticks, tight
/// enough that reaching an extreme mark requires several cooldown-spaced
/// calls rather than one, giving guardians/founder time to notice and freeze.
pub const MAX_POSITION_MARK_STEP_BPS: u128 = 5_000;

/// Minimum seconds between manual `update_strategy_position_value` marks for
/// the same position. Paired with `MAX_POSITION_MARK_STEP_BPS` to bound the
/// total drift achievable over any given time window, not just per call.
pub const POSITION_MARK_COOLDOWN_SECS: i64 = 5 * 60;

/// Maximum age (seconds) of a treasury NAV revaluation before agent-driven
/// deploys are refused. Mirrors `nave_execution`'s `NAV_MAX_STALENESS_SECS`
/// (15 min); referenced by the `jupiter_deposit`/`jupiter_withdraw` NAV-freshness
/// gate (SOL-H3) so a stale/never-computed NAV can't be used to slip a Jupiter
/// Lend deployment past the treasury's freshness expectations.
pub const NAV_MAX_STALENESS_SECS: i64 = 900;

pub const GUARDIAN_ACTION_FREEZE: u8 = 0;
pub const GUARDIAN_ACTION_UNFREEZE: u8 = 1;
pub const GUARDIAN_ACTION_UPDATE_AGENT_STATUS: u8 = 2;
pub const GUARDIAN_ACTION_ROTATE_AGENT_KEY: u8 = 3;
/// Break-glass: disable the autonomous agent pipeline. Requires guardian M-of-N
/// rather than a single Executive key (re-enabling stays a founder/Executive op).
pub const GUARDIAN_ACTION_DISABLE_AGENTS: u8 = 4;
/// SOL-H2: nullify (permanently retire) an agent slot and freeze the DAO.
/// Requires guardian M-of-N — previously a single Executive key could nullify
/// any agent and thereby unilaterally set `dao_registry.frozen = true`, which a
/// compromised Executive could combine with `execute_strategy_direct` to skip
/// the mandatory review window on an already-approved request.
pub const GUARDIAN_ACTION_NULLIFY_AGENT: u8 = 5;
/// Re-enable the agent pipeline after a guardian-quorum disable. The Executive
/// cannot lift a guardian lock on its own.
pub const GUARDIAN_ACTION_ENABLE_AGENTS: u8 = 6;
/// Restore a nullified agent slot (guardian quorum, mirrors nullify).
pub const GUARDIAN_ACTION_RESTORE_AGENT: u8 = 7;
/// Cancel a founder-scheduled agent rotation during its 48h delay.
pub const GUARDIAN_ACTION_CANCEL_AGENT_ROTATION: u8 = 8;

/// Guardian key rotations and agent re-activations wait this long before they
/// can be applied, giving the founder a veto window. Pause/revoke are immediate.
#[cfg(feature = "mainnet")]
pub const GUARDIAN_AGENT_CHANGE_DELAY_SECS: i64 = 86_400;
#[cfg(not(feature = "mainnet"))]
pub const GUARDIAN_AGENT_CHANGE_DELAY_SECS: i64 = DEV_DELAY_SECS;
/// A review-window REDUCTION is queued this long (increases apply immediately).
#[cfg(feature = "mainnet")]
pub const REVIEW_WINDOW_DECREASE_DELAY_SECS: i64 = 86_400;
#[cfg(not(feature = "mainnet"))]
pub const REVIEW_WINDOW_DECREASE_DELAY_SECS: i64 = DEV_DELAY_SECS;
/// Upward position-mark drift allowed per elapsed day, in bps of
/// max(current_value, deposited_amount). Downward marks are unbounded.
pub const MAX_POSITION_DRIFT_BPS_PER_DAY: u128 = 100;

/// Role index stored on-chain. Do not reorder: existing agent sets, instructions,
/// and key slots depend on these discriminants.
///
/// Product language is Executive → Financial → Operational → Oversight.
/// Variant 2 (`Oversight`) is the Operational agent, the final signer.
/// Variant 3 (`Operational`) is the Oversight agent, the monitor that can halt.
/// The variant identifiers stay aligned with instruction and key-slot names.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentRole {
    Executive = 0,
    Financial = 1,
    Oversight = 2,
    Operational = 3,
}

impl AgentRole {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Executive),
            1 => Some(Self::Financial),
            2 => Some(Self::Oversight),
            3 => Some(Self::Operational),
            _ => None,
        }
    }
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentStatus {
    Active = 0,
    Paused = 1,
    Revoked = 2,
    Rotating = 3,
}

impl AgentStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Active),
            1 => Some(Self::Paused),
            2 => Some(Self::Revoked),
            3 => Some(Self::Rotating),
            _ => None,
        }
    }
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum GovernanceType {
    /// Authorized-wallet (guardian) voting: each guardian wallet casts one vote.
    Wallet = 0,
    /// Token-weighted voting: holders of the designated voting token vote by locked amount.
    Token = 1,
}

impl GovernanceType {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Wallet),
            1 => Some(Self::Token),
            _ => None,
        }
    }
}

/// Classifies a treasury asset so the pipeline can route it to a compatible
/// protocol (e.g. stablecoins -> lending, SOL-like -> liquid staking).
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AssetKind {
    /// USD-pegged stablecoin (USDC, USDT, ...). Valued at $1 on-chain.
    Stable = 0,
    /// SOL or a SOL liquid-staking token (wSOL, jitoSOL, ...).
    SolLike = 1,
    /// Any other oracle-priced asset.
    Other = 2,
}

impl AssetKind {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Stable),
            1 => Some(Self::SolLike),
            2 => Some(Self::Other),
            _ => None,
        }
    }
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PrivacyMode {
    Public = 0,
    Private = 1,
}

impl PrivacyMode {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Public),
            1 => Some(Self::Private),
            _ => None,
        }
    }
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AnnotationStatus {
    Pending = 0,
    Approved = 1,
    Denied = 2,
}

impl AnnotationStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Pending),
            1 => Some(Self::Approved),
            2 => Some(Self::Denied),
            _ => None,
        }
    }
}

/// Lifecycle of the recoverable DAO creation stake held in escrow.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum StakeStatus {
    /// NAVE is locked in escrow; the DAO is operating normally.
    Locked = 0,
    /// NAVE has been released out of escrow (moonlight distribution or wind-down).
    Released = 1,
}

impl StakeStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Locked),
            1 => Some(Self::Released),
            _ => None,
        }
    }
}

/// DAO moonlighting lifecycle state machine (see `DaoLifecycle`).
///
/// `Active → Requested → DistributionPending → Distributing → Moonlighted`,
/// with `Moonlighted → Active` only via founder `restore_dao` (no new stake).
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MoonlightStatus {
    /// Normal operation; no moonlight request in flight.
    Active = 0,
    /// An approved `MoonlightRequest` halted the agents and blocks new
    /// strategy/deposit activity while controlled unwind/distribution proceeds.
    Requested = 1,
    /// The proposal creator entered the recipient wallet and bound a second
    /// `MoonlightDistribution` proposal.
    DistributionPending = 2,
    /// The distribution proposal passed and asset/stake release is underway.
    Distributing = 3,
    /// Distribution complete: the DAO is moonlighted/hidden from participants.
    /// Only the founder can restore it, and reopening does not lock new NAVE.
    Moonlighted = 4,
}

impl MoonlightStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Active),
            1 => Some(Self::Requested),
            2 => Some(Self::DistributionPending),
            3 => Some(Self::Distributing),
            4 => Some(Self::Moonlighted),
            _ => None,
        }
    }
}

/// Wire mirror of `nave_governance::constants::ProposalType` discriminants that
/// nave_core reads off a passed proposal account when advancing the moonlight
/// lifecycle. Keep in sync with nave_governance.
pub mod gov_proposal_type {
    /// `ProposalType::Permission`
    pub const PERMISSION: u8 = 2;
    /// `ProposalType::SwitchVotingSystem`
    pub const SWITCH_VOTING_SYSTEM: u8 = 7;
    /// `ProposalType::Transfer`
    pub const TRANSFER: u8 = 8;
    /// `ProposalType::MoonlightRequest`
    pub const MOONLIGHT_REQUEST: u8 = 9;
    /// `ProposalType::MoonlightDistribution`
    pub const MOONLIGHT_DISTRIBUTION: u8 = 10;
    /// `ProposalStatus::Passed`
    pub const STATUS_PASSED: u8 = 1;
    /// `ProposalStatus::Executed`
    pub const STATUS_EXECUTED: u8 = 4;
}
