use anchor_lang::prelude::*;

#[error_code]
pub enum NaveError {
    #[msg("Global protocol is paused")]
    GlobalPaused,
    #[msg("DAO is frozen")]
    DaoFrozen,
    #[msg("Agents are disabled")]
    AgentsDisabled,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid bump")]
    InvalidBump,
    #[msg("DAO ownership mismatch")]
    DaoOwnershipMismatch,
    #[msg("Invalid guardian threshold")]
    InvalidGuardianThreshold,
    #[msg("Too many guardian wallets")]
    TooManyGuardianWallets,
    #[msg("Guardian wallet not found")]
    GuardianNotFound,
    #[msg("Too many constitution protocols")]
    TooManyProtocols,
    #[msg("Protocol not found")]
    ProtocolNotFound,
    #[msg("Protocol not approved")]
    ProtocolNotApproved,
    #[msg("Token registry full")]
    TokenRegistryFull,
    #[msg("Token not found")]
    TokenNotFound,
    #[msg("Invalid agent role")]
    InvalidAgentRole,
    #[msg("Agent is nullified")]
    AgentNullified,
    #[msg("Agent already nullified")]
    AgentAlreadyNullified,
    #[msg("Invalid name length")]
    InvalidNameLength,
    #[msg("Invalid protocol id length")]
    InvalidProtocolIdLength,
    #[msg("Invalid annotation length")]
    InvalidAnnotationLength,
    #[msg("Invalid URI length")]
    InvalidUriLength,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    #[msg("No performance fee due")]
    NoPerformanceFeeDue,
    #[msg("No management fee due")]
    NoManagementFeeDue,
    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,
    #[msg("Annotation not pending")]
    AnnotationNotPending,
    #[msg("Proposal count underflow")]
    ProposalCountUnderflow,
    #[msg("Invalid archive count")]
    InvalidArchiveCount,
    #[msg("Duplicate guardian wallet")]
    DuplicateGuardianWallet,
    #[msg("Duplicate protocol")]
    DuplicateProtocol,
    #[msg("Duplicate token mint")]
    DuplicateTokenMint,
    #[msg("Token mint authority already revoked")]
    AuthorityAlreadyRevoked,
    #[msg("Invalid privacy mode")]
    InvalidPrivacyMode,
    #[msg("Invalid annotation status")]
    InvalidAnnotationStatus,
    #[msg("Invalid BPS value")]
    InvalidBps,
    #[msg("Allocation limit exceeded")]
    AllocationLimitExceeded,
    #[msg("Guardian threshold not met")]
    GuardianThresholdNotMet,
    #[msg("Duplicate guardian signature")]
    DuplicateGuardianSignature,
    #[msg("Invalid vault token account")]
    InvalidVaultTokenAccount,
    #[msg("Agent rotation not ready")]
    AgentRotationNotReady,
    #[msg("No pending agent rotation")]
    NoPendingAgentRotation,
    #[msg("Invalid fee recipient")]
    InvalidFeeRecipient,
    #[msg("Execution request required")]
    ExecutionRequestRequired,
    #[msg("Invalid confidence threshold")]
    InvalidConfidenceThreshold,
    #[msg("Invalid review window")]
    InvalidReviewWindow,
    #[msg("Invalid agent status")]
    InvalidAgentStatus,
    #[msg("Invalid agent slot")]
    InvalidAgentSlot,
    #[msg("Invalid governance type")]
    InvalidGovernanceType,
    #[msg("Voting token must be registered before switching to token governance")]
    VotingTokenNotRegistered,
    #[msg("Insufficient protocol fee vault balance for reward")]
    InsufficientFeeVaultBalance,
    #[msg("Token authorities already revoked")]
    TokenAlreadyRevoked,
    #[msg("Token account mint does not match the vault mint")]
    MintMismatch,
    #[msg("Disabling agents requires guardian multisig")]
    AgentsDisableRequiresGuardians,
    #[msg("Invalid policy parameters")]
    InvalidPolicyParameters,
    #[msg("Global deployment cap exceeded")]
    DeploymentCapExceeded,
    #[msg("Liquidity floor breached")]
    LiquidityFloorBreached,
    #[msg("Asset already registered for this DAO")]
    AssetAlreadyRegistered,
    #[msg("Maximum treasury assets reached")]
    TreasuryAssetsFull,
    #[msg("Asset is not enabled")]
    AssetNotEnabled,
    #[msg("Invalid asset kind")]
    InvalidAssetKind,
    #[msg("Pyth price update account is not owned by the receiver program")]
    InvalidOracleAccount,
    #[msg("Pyth feed id mismatch for asset")]
    OracleFeedMismatch,
    #[msg("Pyth price is stale")]
    StaleOracle,
    #[msg("Pyth price is non-positive")]
    InvalidOraclePrice,
    #[msg("Stablecoin reserve floor breached")]
    StablecoinReserveBreached,
    #[msg("Insufficient fee asset balance")]
    InsufficientFeeAsset,
    #[msg("Fee asset is not a registered stablecoin")]
    InvalidFeeAsset,
    #[msg("Position external targets are not configured")]
    PositionTargetsUnset,
    #[msg("Account does not match the position's approved external target")]
    ExternalTargetMismatch,
    #[msg("External protocol program id is invalid")]
    InvalidExternalProgram,
    #[msg("Position receipt-token account mismatch")]
    InvalidPositionTokenAccount,
    #[msg("Insufficient escrow balance for deployment")]
    InsufficientEscrowBalance,
    #[msg("Insufficient receipt-token balance for redemption")]
    InsufficientReceiptBalance,
    #[msg("Guardian action is not yet stale enough to be cancelled")]
    GuardianActionNotStale,
    #[msg("Temporary token account is not empty")]
    TempAccountNotEmpty,
    #[msg("Deposit to legacy vault is restricted to registered stablecoins")]
    NonStablecoinVaultDeposit,
    #[msg("Governance proposal account could not be parsed")]
    InvalidGovernanceProposal,
    #[msg("Governance transfer payload does not match proposal hash")]
    GovernanceProposalPayloadMismatch,
    #[msg("Transfer proposal payload is malformed")]
    TransferProposalPayloadInvalid,
    #[msg("DAO bootstrap window has already been used")]
    BootstrapAlreadyUsed,
    #[msg("Swap consumed more input than authorized")]
    SwapInputExceeded,
    #[msg("Swap output below minimum")]
    SwapSlippageExceeded,
    #[msg("Creation stake amount is below the minimum")]
    StakeAmountTooLow,
    #[msg("Staked mint does not match the configured NAVE mint")]
    StakeMintMismatch,
    #[msg("DAO creation stake has already been released")]
    StakeAlreadyReleased,
    #[msg("DAO creation stake is not eligible for release")]
    StakeNotReleasable,
    #[msg("Escrow did not receive the full staked amount")]
    StakeNotFullyFunded,
    #[msg("Invalid moonlight lifecycle status for this action")]
    MoonlightInvalidStatus,
    #[msg("Moonlight proposal is missing, wrong type, or not passed")]
    MoonlightProposalInvalid,
    #[msg("Recipient does not match the approved moonlight distribution")]
    MoonlightRecipientMismatch,
    #[msg("DAO is moonlighting; new strategy/deposit activity is blocked")]
    DaoMoonlighting,
    #[msg("DAO is not in a moonlighted state")]
    DaoNotMoonlighted,
    #[msg("Position mark change exceeds the maximum allowed step for a single update")]
    PositionMarkStepExceeded,
    #[msg("Position has no deposited base to bound the mark against; deposit first")]
    PositionMarkNoBase,
    #[msg("Position mark was updated too recently; wait for the cooldown to elapse")]
    PositionMarkCooldownActive,
    #[msg("stake_dao_creation requires global_config.nave_mint to be pinned outside devnet/test builds")]
    StakeMintUnset,
    #[msg("Swap slippage exceeds the DAO's configured maximum")]
    MaxSlippageExceeded,
    #[msg("Invalid max_slippage_bps value")]
    InvalidMaxSlippageBps,
    #[msg("Swap amount exceeds the DAO's configured maximum single-swap size")]
    MaxSingleSwapExceeded,
    #[msg("Invalid max_single_swap_bps value")]
    InvalidMaxSingleSwapBps,
    #[msg("Governance transfer recipient does not match the account passed to the instruction")]
    RecipientMismatch,
    #[msg("switch_voting_system must be invoked via a passed nave_governance SwitchVotingSystem proposal")]
    SwitchVotingSystemProposalInvalid,
    #[msg("Switch-voting-system proposal payload does not match the proposal hash")]
    SwitchVotingSystemPayloadMismatch,
    #[msg("Jupiter swap route references a vault-owned token account other than the intended source/destination")]
    RouteAccountNotAllowed,
    #[msg("Treasury NAV is stale or never computed; revalue before deploying")]
    NavStale,
    #[msg("Treasury NAV is below the configured agent operating threshold")]
    AgentThresholdNotMet,
    #[msg("Founder one-shot guardian bootstrap already consumed; further changes require a passed Permission proposal")]
    GuardiansAlreadyBootstrapped,
    #[msg("apply_guardian_config_from_governance must be invoked via a passed nave_governance Permission proposal")]
    PermissionProposalInvalid,
    #[msg("Permission proposal payload does not match the proposal hash")]
    PermissionPayloadMismatch,
    #[msg("GuardianConfig account has an unexpected data length")]
    GuardianConfigLayoutInvalid,
}
