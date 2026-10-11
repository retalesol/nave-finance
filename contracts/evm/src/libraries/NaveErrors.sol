// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NaveErrors
/// @notice Custom errors spanning the three program domains (core/governance/
/// execution). Grouped here so every contract surfaces consistent, gas-cheap
/// revert reasons that mirror the Solana `#[error_code]` variants.
library NaveErrors {
    // ── Global / shared ───────────────────────────────────────────────────
    error GlobalPaused();
    error DaoFrozen();
    error Unauthorized();
    error MathOverflow();
    error InvalidBps();
    error ZeroAddress();
    error MintMismatch();
    error AssetMintMismatch();
    error DaoOwnershipMismatch();

    // ── DAO lifecycle ─────────────────────────────────────────────────────
    error InvalidNameLength();
    error AlreadyInitialized();
    error InsufficientFormationFee();
    error InvalidPrivacyMode();
    error InvalidGovernanceType();
    error InvalidFeeRecipient();
    /// The configured treasury-seed carve-out exceeds the formation fee.
    error InvalidTreasurySeed();
    /// The DAO treasury has already been seeded (one-time at creation).
    error TreasuryAlreadySeeded();
    /// Protocol has no wrapped-native (WETH) configured; raw ETH cannot be
    /// custodied (would be NAV-blind and unspendable via ERC-20 exits).
    error WrappedNativeNotConfigured();

    // ── DAO creation stake + moonlighting (Phase 3 / Phase 5) ─────────────
    /// The creation stake amount is below the configured minimum.
    error StakeAmountTooLow();
    /// A creation stake already exists for this DAO.
    error StakeAlreadyExists();
    /// No creation stake record exists for this DAO.
    error StakeNotFound();
    /// The creation stake has already been released.
    error StakeAlreadyReleased();
    /// The moonlight lifecycle is in the wrong state for this action.
    error MoonlightInvalidStatus();
    /// DAO is in an active moonlight wind-down; new deposits/strategy blocked.
    error DaoMoonlighting();
    /// The bound moonlight proposal is missing, wrong type, or not passed.
    error MoonlightProposalInvalid();
    /// The recipient does not match the approved moonlight distribution.
    error MoonlightRecipientMismatch();

    // ── Guardians ─────────────────────────────────────────────────────────
    /// The action requires the DAO to be frozen (e.g. queuing a guardian
    /// recovery, force-unfreezing).
    error DaoNotFrozen();
    /// No guardian recovery is queued.
    error NoGuardianRecoveryPending();
    /// The recovery / force-unfreeze timelock has not elapsed yet.
    error RecoveryTimelockActive();
    error TooManyGuardianWallets();
    error InvalidGuardianThreshold();
    error DuplicateGuardianWallet();
    error GuardianNotFound();
    /// Founder one-shot guardian bootstrap already consumed; further changes
    /// require a passed Permission proposal via the governor.
    error GuardiansAlreadyBootstrapped();
    /// Sister / linked treasury for a destination chain is not registered.
    error LinkedTreasuryNotSet();
    /// Destination treasury does not match the allowlisted sister treasury.
    error LinkedTreasuryMismatch();
    /// Bridge adapter rejected the asset or destination chain.
    error UnsupportedBridgeRoute();
    error DuplicateGuardianSignature();
    error GuardianActionNotStale();
    error GuardianActionExpired();
    error InvalidGuardianSignature();
    error InvalidVotingPeriod();

    // ── Agents ────────────────────────────────────────────────────────────
    error InvalidAgentRole();
    error InvalidAgentSlot();
    error InvalidAgentStatus();
    error AgentNullified();
    error AgentAlreadyNullified();
    error AgentsDisabled();
    error AgentsDisableRequiresGuardians();
    error NoPendingAgentRotation();
    error AgentRotationNotReady();
    /// Guardians disabled the pipeline; only a guardian ENABLE_AGENTS quorum
    /// may re-enable it.
    error AgentsLockedByGuardians();
    /// Agent keys must be nonzero, pairwise distinct, and distinct from the
    /// founder and every guardian wallet.
    error AgentKeyConflict();
    /// Adapter position value grew by less than the deposit slippage floor.
    error DepositSlippageExceeded();
    /// A queued protocol adapter approval has not reached its effective time.
    error AdapterApprovalNotReady();

    // ── Constitution / policy ─────────────────────────────────────────────
    error TooManyProtocols();
    error InvalidProtocolIdLength();
    error InvalidConfidenceThreshold();
    error InvalidReviewWindow();
    error InvalidPolicyParameters();
    error ProtocolNotApproved();
    /// An adapter listed in a DAO constitution is not on the protocol-level
    /// adapter allowlist (`NaveProtocol.isApprovedAdapter`).
    error AdapterNotProtocolApproved();
    /// `setLinkedTreasury` target is not a protocol-registered sister treasury
    /// for that destination chain (`NaveProtocol.isRemoteTreasury`).
    error LinkedTreasuryNotRegistered();
    /// Remote-treasury registry: chain id is zero or the local chain.
    error InvalidChainId();
    error AllocationLimitExceeded();
    error DeploymentCapExceeded();
    error LiquidityFloorBreached();
    error StablecoinReserveBreached();
    /// Treasury NAV is below the agent-threshold floor set in the constitution.
    /// Agents may not deploy capital until NAV reaches agentThresholdUsd.
    error AgentThresholdNotMet();

    // ── Tokens ────────────────────────────────────────────────────────────
    error TokenRegistryFull();
    error DuplicateTokenMint();
    error TokenNotFound();
    error TokenNotInRegistry();
    error TokenMintNotRegistered();
    error AuthorityAlreadyRevoked();

    // ── Vault / assets / fees ─────────────────────────────────────────────
    error ExecutionRequestRequired();
    error InsufficientVaultBalance();
    error NonStablecoinVaultDeposit();
    error AssetAlreadyRegistered();
    error AssetNotRegistered();
    error AssetDisabled();
    error TooManyAssets();
    error NoManagementFeeDue();
    error InsufficientFeeAsset();
    error StaleNav();

    // ── Oracle ────────────────────────────────────────────────────────────
    error InvalidOracleAccount();
    error InvalidOraclePrice();
    error StaleOracle();
    error NoOracleConfigured();
    /// SEC-M5: an oracle-priced stablecoin deviates from $1 beyond the peg
    /// band — valuation refuses to proceed until the asset is disabled or the
    /// peg recovers.
    error StablecoinDepegged();
    /// SEC-M5: a manual strategy-position mark exceeds the max per-step change
    /// or violates the mark cooldown.
    error PositionMarkOutOfBounds();

    // ── Governance / proposals ────────────────────────────────────────────
    error MaxProposalsReached();
    error InvalidProposalType();
    error ProposalTypeNotImplemented();
    error WrongGovernanceMode();
    error InvalidVoteChoice();
    error ProposalNotActive();
    error VotingPeriodEnded();
    error VotingPeriodNotEnded();
    error QuorumNotMet();
    error GuardianRequired();
    error AlreadyVoted();
    error EscrowStillLocked();
    error EscrowNotLocked();
    error InvalidTitleLength();
    error InvalidPayloadLength();

    // ── Execution ─────────────────────────────────────────────────────────
    error ProposalDaoMismatch();
    error ProposalNotPassed();
    error PayloadHashMismatch();
    error ReasoningHashRequired();
    error InvalidStateTransition();
    error ReviewWindowActive();
    error DirectExecutionNotAllowed();
    /// Break-glass `executeDirect` only accepts Strategy requests; Transfer /
    /// Bridge requests (external recipients) must run through {execute}.
    error DirectExecutionKindNotAllowed();
    error WithdrawExceedsDeployed();
    error UnsupportedAdapter();
    error EscrowAccountMismatch();
    error AssetKindMismatch();
    error ExecutionRequestExists();
    /// The one-time founder bootstrap (zero-review-window) path was already used.
    error BootstrapAlreadyUsed();

    // ── WrappedNave bridge hardening (SEC-M5) ─────────────────────────────
    /// Minting is paused by the owner circuit breaker.
    error MintPaused();
    /// Minting would exceed the configured supply cap.
    error SupplyCapExceeded();
    /// Caller is not the pending minter of a two-step rotation.
    error NotPendingMinter();

    // ── Bridge lockbox + wNAVE controls (mainnet hardening) ───────────────
    /// The bridge (lock/mint path) is paused by the owner circuit breaker.
    error BridgePaused();
    /// The inbound source message (nonce) was already processed (replay).
    error AlreadyProcessed();
    /// Amount exceeds the per-transaction cap.
    error PerTxCapExceeded();
    /// Amount exceeds the rolling 24h cap.
    error DailyCapExceeded();
    /// Amount must be greater than zero.
    error ZeroAmount();
    /// The destination recipient is invalid (zero / malformed).
    error InvalidRecipient();
    /// A transfer touches a frozen account while control is still enabled.
    error AccountIsFrozen();
    /// Freeze/control has been permanently revoked; the action is no longer allowed.
    error ControlAlreadyRevoked();
    /// Caller is not the pending owner of a two-step ownership handoff.
    error NotPendingOwner();
    /// Privileged bridge/staking roles (owner vs relayer / rewarder) must be
    /// held by distinct addresses so a single key compromise cannot both mint
    /// and lift the guardrails.
    error PrivilegedRolesMustDiffer();

    // ── Adapters (slippage / share-inflation) ─────────────────────────────
    /// A slippage-bearing adapter (Balancer/Curve) was called with `minOut == 0`
    /// on a mainnet chain (1 / 8453), where unbounded join/exit is sandwichable.
    error SlippageBoundRequired();
    /// The protocol returned fewer underlying units than the caller's `minOut`.
    error SlippageExceeded();
    /// EVM-H2: a strategy withdrawal returned less underlying than requested
    /// beyond WITHDRAW_SHORTFALL_TOLERANCE_BPS — re-quote and retry.
    error WithdrawShortfallExceeded();
    /// The very first deposit into an adapter must exceed the locked dead-share
    /// floor (ERC-4626 first-depositor inflation guard).
    error DepositBelowMinimum();
    /// The venue pays out through a queue or cooldown: call
    /// `requestStrategyExit` first, then withdraw once the claim is ready.
    error ExitNotReady();
    /// Queued-exit adapters run one venue exit at a time; retry after the
    /// pending one is ready.
    error ExitInProgress();
    /// The adapter has no queued exit (its venue redeems synchronously).
    error ExitNotQueued();
    /// A Pendle PT position cannot exit before maturity without a guardian
    /// quorum approval for that DAO.
    error PtNotMatured();
    /// Guardian approval signatures are missing, duplicated, expired or below
    /// the DAO's guardian threshold.
    error InvalidGuardianApproval();
    /// The Pendle market's TWAP oracle lacks the cardinality or history for
    /// the adapter's TWAP window.
    error PendleOracleNotReady();
    /// Risk tier must be 1, 2 or 3.
    error InvalidRiskTier();
    /// An approved adapter's tier can only be raised; lowering it (loosening
    /// DAO caps) goes through revoke + the delayed re-approval.
    error RiskTierLowerRequiresReapproval();
    /// Approved Tier 2 caps may total at most 30% and Tier 3 caps 15%.
    error RiskTierCapExceeded();

    // ── Upgradeability ────────────────────────────────────────────────────
    /// Target implementation is not on the protocol approved list for that role.
    error ImplNotApproved();
    /// Latest implementation pointer must already be approved.
    error LatestImplNotApproved();
    /// Invalid DaoImplRole value.
    error InvalidImplRole();
    /// DAO proxies are already on the requested implementations.
    error AlreadyOnLatestImpl();
}
