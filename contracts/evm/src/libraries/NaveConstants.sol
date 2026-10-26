// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NaveConstants
/// @notice Protocol-wide constants ported 1:1 from the Solana programs
/// (`nave_core::constants`, `nave_governance::constants`,
/// `nave_execution::constants`). Values are preserved exactly to keep the EVM
/// port at feature parity with the on-chain Solana semantics.
library NaveConstants {
    // ── Accounting ────────────────────────────────────────────────────────
    /// USD aggregates (NAV / HWM / deployed) are stored in micro-USD (1e6).
    uint256 internal constant USD_SCALE = 1_000_000;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    // ── Set sizes ─────────────────────────────────────────────────────────
    uint256 internal constant MAX_GUARDIAN_WALLETS = 10;
    uint8 internal constant MAX_GUARDIAN_THRESHOLD = 7;
    uint256 internal constant MAX_CONSTITUTION_PROTOCOLS = 10;
    uint256 internal constant MAX_TOKEN_REGISTRY = 3;
    uint256 internal constant MAX_TREASURY_ASSETS = 8;
    uint256 internal constant AGENT_COUNT = 4;
    uint64 internal constant MAX_PROPOSALS_PER_DAO = 88;

    // ── Time ──────────────────────────────────────────────────────────────
    /// The delays below are production values. Off the production chains
    /// (testnets, local) every one of them is DEV_DELAY_SECS instead; read
    /// them through the functions at the end of this library.
    uint256 internal constant DEV_DELAY_SECS = 60;
    int64 internal constant SECONDS_PER_DAY = 86_400;
    int64 internal constant SECONDS_PER_YEAR = 365 * 86_400;
    /// 48-hour agent-rotation timelock.
    int64 internal constant AGENT_ROTATION_DELAY_SECONDS = 172_800;
    /// Default 24h review window between Oversight approval and execution.
    int64 internal constant DEFAULT_REVIEW_WINDOW_SECONDS = 86_400;
    /// Floor for a founder-configured review window (1 hour). Was 60s, which
    /// let a founder collapse the post-Oversight review to a single minute.
    /// Reductions below the CURRENT window are additionally timelocked by the
    /// current window (see `NaveTreasury.setReviewWindow`).
    int64 internal constant MIN_REVIEW_WINDOW_SECONDS = 3_600;
    int64 internal constant MAX_REVIEW_WINDOW_SECONDS = 7 * 86_400;
    /// Max NAV staleness accepted when deploying capital (15 min).
    int64 internal constant NAV_MAX_STALENESS_SECS = 900;
    /// Stale-guardian-action garbage-collection window (7 days).
    int64 internal constant GUARDIAN_ACTION_STALE_SECS = 7 * 86_400;
    /// EVM-H1: timelock before a founder-initiated guardian recovery (queued
    /// while the DAO is frozen) can be executed. Long enough for a live,
    /// honest guardian quorum to veto publicly via {cancelGuardianRecovery}.
    uint256 internal constant GUARDIAN_RECOVERY_TIMELOCK_SECS = 7 * 86_400;
    /// EVM-H1: minimum continuous frozen duration before the protocol owner may
    /// force-unfreeze a DAO as the documented last resort (hostile guardian
    /// quorum griefing / founder + guardians both lost).
    uint256 internal constant PROTOCOL_FORCE_UNFREEZE_TIMELOCK_SECS = 30 * 86_400;
    /// EVM-H2: max tolerated shortfall (bps of the requested amount) between a
    /// strategy withdrawal request and the underlying actually returned by the
    /// adapter. Beyond this the withdrawal reverts (caller must re-quote).
    uint256 internal constant WITHDRAW_SHORTFALL_TOLERANCE_BPS = 100;
    /// SEC-M5: max deviation (bps) of an oracle-priced stablecoin from its $1
    /// par before valuation reverts (depeg guard). Within the band the ORACLE
    /// price is used (no more hardcoded $1 when a feed is configured).
    uint256 internal constant STABLECOIN_PEG_BAND_BPS = 200;
    /// SEC-M5 (parity with the Solana M8 fix): max relative step (bps) a single
    /// manual strategy-position mark may move the value, and the cooldown
    /// between marks on the same position.
    uint256 internal constant MAX_POSITION_MARK_STEP_BPS = 5000;
    uint256 internal constant POSITION_MARK_COOLDOWN_SECS = 5 * 60;
    /// Max upward drift (bps of max(currentValue, principal) per day) an
    /// adapter-read position mark may apply. Downward marks are unbounded.
    uint256 internal constant MAX_POSITION_DRIFT_BPS_PER_DAY = 100;
    /// Floor on the adapter position-value delta a strategy deposit must book,
    /// as bps of the deposited amount (independent of the caller's `minOut`).
    uint256 internal constant DEPOSIT_SLIPPAGE_BPS = 50;
    /// Delay before a guardian key rotation or agent re-activation applies.
    /// The founder can cancel during the window.
    uint256 internal constant GUARDIAN_AGENT_CHANGE_DELAY_SECS = 86_400;
    /// Delay before a protocol-level adapter approval applies once any DAO
    /// exists. Revocation is immediate.
    uint256 internal constant ADAPTER_APPROVAL_DELAY_SECS = 86_400;
    /// Venue risk tiers (set per adapter on NaveProtocol; unset reads as 1).
    uint8 internal constant MAX_RISK_TIER = 3;
    /// Sum of a constitution's approved per-adapter caps within Tier 2 / 3.
    uint256 internal constant MAX_TIER2_TOTAL_BPS = 3_000;
    uint256 internal constant MAX_TIER3_TOTAL_BPS = 1_500;

    // ── Fees ──────────────────────────────────────────────────────────────
    /// 15% of realized yield, skimmed on the strategy-withdrawal path.
    /// Frozen treasuries use the same rate.
    uint16 internal constant DEFAULT_PERFORMANCE_FEE_BPS = 1500;
    /// Management fee is not charged. The storage field stays so existing
    /// treasury slots do not move. `collectManagementFee` transfers nothing.
    uint16 internal constant DEFAULT_MANAGEMENT_FEE_BPS = 0;

    // ── Formation-fee split (treasury-seed carve-out) ─────────────────────
    // The formation fee a founder pays at DAO creation is split into a protocol
    // portion (forwarded to `protocolTreasury`) and a treasury-seed portion
    // (deposited into the new DAO treasury as its starting balance). The active
    // split is configured at runtime on `NaveProtocol` (`formationFee` /
    // `treasurySeed`); the constants below document the canonical per-network
    // values used by the deploy/cutover scripts.
    //
    /// Devnet (Sepolia / Base Sepolia): no native formation fee. Any `msg.value`
    /// on `createDao` is the founder's own treasury seed, not a protocol charge.
    /// Kept at 0 so a cutover script cannot reintroduce a formation fee by
    /// reading this constant.
    uint256 internal constant DEVNET_FORMATION_FEE_WEI = 0;
    uint256 internal constant DEVNET_TREASURY_SEED_WEI = 0;
    /// Mainnet treasury-seed fraction of the formation fee (bps). NOT FINALIZED:
    /// mirrors the Solana mainnet carve-out ratio (0.3 SOL seed / 1.8 SOL fee =
    /// 1/6 ≈ 1667 bps). The absolute mainnet formation fee + seed (in wei) are
    /// set on `NaveProtocol` at cutover; confirm before mainnet launch.
    uint16 internal constant MAINNET_TREASURY_SEED_BPS = 1667;

    // ── Governance ────────────────────────────────────────────────────────
    uint16 internal constant DEFAULT_QUORUM_BPS = 1000;
    /// Quorum required to mint a new token (25%).
    uint16 internal constant TOKEN_MINT_QUORUM_BPS = 2500;
    /// Quorum required to switch the voting system (70%).
    uint16 internal constant SWITCH_VOTING_QUORUM_BPS = 7000;
    /// Minimum quorum for the high-impact moonlighting proposals (25%), mirroring
    /// the Solana `MOONLIGHT_MIN_QUORUM_BPS`.
    uint16 internal constant MOONLIGHT_MIN_QUORUM_BPS = 2500;
    int64 internal constant DEFAULT_VOTING_PERIOD = 604_800; // 7 days
    /// Minimum proposal voting period (1 hour). Prevents a 1-second proposal
    /// that a colluding minority finalizes before others can react (audit M-2).
    uint256 internal constant MIN_VOTING_PERIOD = 3_600;
    /// Maximum proposal voting period (30 days). Prevents locking a proposal
    /// open effectively forever.
    uint256 internal constant MAX_VOTING_PERIOD = 30 * 86_400;

    // ── Continuous treasury policy defaults ───────────────────────────────
    uint16 internal constant MAX_RESERVE_BPS = 10_000;
    uint16 internal constant MAX_DEPLOYMENT_BPS = 10_000;
    uint16 internal constant MAX_LIQUIDITY_BPS = 10_000;
    int64 internal constant MIN_REBALANCE_FREQUENCY_SECONDS = 86_400;
    int64 internal constant MAX_REBALANCE_FREQUENCY_SECONDS = 365 * 86_400;
    uint16 internal constant DEFAULT_MIN_STABLECOIN_RESERVE_BPS = 3500;
    uint16 internal constant DEFAULT_MAX_TOTAL_DEPLOYED_BPS = 5000;
    uint16 internal constant DEFAULT_MIN_LIQUIDITY_BPS = 2000;
    int64 internal constant DEFAULT_REBALANCE_FREQUENCY_SECONDS = 30 * 86_400;

    // ── Confidence threshold ──────────────────────────────────────────────
    uint8 internal constant DEFAULT_CONFIDENCE_THRESHOLD = 70;
    uint8 internal constant MAX_CONFIDENCE_THRESHOLD = 100;

    // ── Oracle (Pyth) ─────────────────────────────────────────────────────
    /// Max staleness (seconds) accepted for a Pyth price update.
    uint256 internal constant PYTH_MAX_PRICE_AGE_SECS = 60;
    /// Max accepted Pyth confidence-to-price ratio in bps (2%).
    uint256 internal constant PYTH_MAX_CONFIDENCE_BPS = 200;
    /// Canonical Pyth ETH/USD price feed id (Crypto.ETH/USD). Used when the
    /// treasury auto-registers WETH after wrapping native seed / top-ups.
    bytes32 internal constant PYTH_ETH_USD_FEED_ID =
        0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    // ── Text bounds (mirrors Solana fixed-byte buffers) ───────────────────
    uint256 internal constant MAX_DAO_NAME_LEN = 32;
    uint256 internal constant MAX_TOKEN_NAME_LEN = 32;
    uint256 internal constant MAX_TOKEN_SYMBOL_LEN = 8;
    uint256 internal constant MAX_ANNOTATION_LEN = 256;
    uint256 internal constant MAX_PROPOSAL_TITLE_LEN = 64;
    uint256 internal constant MAX_PROPOSAL_DESCRIPTION_LEN = 512;
    uint256 internal constant MAX_PROPOSAL_PAYLOAD_LEN = 512;

    // ── Same-address activation, outbound relayer fee, relayer sweep ──────
    /// Native fee {NaveDAOFactory.activateDao} forwards to the protocol
    /// revenue wallet. Gas is extra. Arc pays the USDC value of this amount.
    uint256 internal constant ACTIVATION_FEE_WEI = 0.001 ether;
    /// Native fee the treasury pays the protocol relayer on governance
    /// transfers out and on strategy withdrawals. Deposits do not pay it.
    uint256 internal constant OUTBOUND_RELAYER_FEE_WEI = 0.0005 ether;
    /// The relayer sweep leaves this much native gas and sends the excess
    /// to the protocol revenue wallet.
    uint256 internal constant RELAYER_SWEEP_RESERVE_WEI = 0.05 ether;
    /// Arc Testnet. Native gas is 18-decimal USDC. Arc mainnet (5042) is not
    /// a supported Nave chain.
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    /// Arc Testnet ERC-20 USDC (6 decimals). The activation fee on Arc is
    /// paid in this token. It is not the 18-decimal native gas balance.
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    /// Documented Arc testnet ETH price used when the oracle has no fresh
    /// WETH price: $2,500.00 per ETH, in micro-USD (1e6).
    /// 0.001 ETH = $2.50 = 2_500_000 USDC (6 decimals).
    /// 0.0005 ETH = $1.25 = 1_250_000 USDC.
    /// 0.05 ETH = $125 = 125_000_000 USDC, or 125e18 native gas units.
    uint256 internal constant ARC_TESTNET_ETH_USD_MICRO = 2_500_000_000;

    // ── Chain-dependent delays ────────────────────────────────────────────
    /// Ethereum, Base, Robinhood Chain, and Arc mainnet (unsupported, listed so
    /// an accidental deploy there still gets full delays).
    function isProductionChain() internal view returns (bool) {
        uint256 id = block.chainid;
        return id == 1 || id == 8453 || id == 4663 || id == 5042;
    }

    function _delay(uint256 production) private view returns (uint256) {
        return isProductionChain() ? production : DEV_DELAY_SECS;
    }

    function agentRotationDelaySecs() internal view returns (uint256) {
        return _delay(uint256(int256(AGENT_ROTATION_DELAY_SECONDS)));
    }

    function defaultReviewWindowSecs() internal view returns (int64) {
        return int64(int256(_delay(uint256(int256(DEFAULT_REVIEW_WINDOW_SECONDS)))));
    }

    function minReviewWindowSecs() internal view returns (int64) {
        return int64(int256(_delay(uint256(int256(MIN_REVIEW_WINDOW_SECONDS)))));
    }

    function guardianRecoveryTimelockSecs() internal view returns (uint256) {
        return _delay(GUARDIAN_RECOVERY_TIMELOCK_SECS);
    }

    function protocolForceUnfreezeTimelockSecs() internal view returns (uint256) {
        return _delay(PROTOCOL_FORCE_UNFREEZE_TIMELOCK_SECS);
    }

    function guardianAgentChangeDelaySecs() internal view returns (uint256) {
        return _delay(GUARDIAN_AGENT_CHANGE_DELAY_SECS);
    }

    function adapterApprovalDelaySecs() internal view returns (uint256) {
        return _delay(ADAPTER_APPROVAL_DELAY_SECS);
    }

    function minVotingPeriodSecs() internal view returns (uint256) {
        return _delay(MIN_VOTING_PERIOD);
    }
}
