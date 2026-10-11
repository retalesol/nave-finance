use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB");

#[program]
pub mod nave_core {
    use super::*;

    pub fn initialize_global_config(
        ctx: Context<InitializeGlobalConfig>,
        formation_fee_lamports: u64,
    ) -> Result<()> {
        initialize_global_config_handler(ctx, formation_fee_lamports)
    }

    pub fn update_global_config(
        ctx: Context<UpdateGlobalConfig>,
        paused: bool,
        formation_fee_lamports: u64,
    ) -> Result<()> {
        update_global_config_handler(ctx, paused, formation_fee_lamports)
    }

    /// Admin-only: pin/rotate the canonical NAVE creation-stake mint (devnet
    /// replica / mainnet real mint). Stored in the global-config bytes that were
    /// previously `reserved` (layout unchanged).
    pub fn set_nave_mint(ctx: Context<SetNaveMint>, nave_mint: Pubkey) -> Result<()> {
        set_nave_mint_handler(ctx, nave_mint)
    }

    pub fn initialize_dao(ctx: Context<InitializeDao>, params: InitializeDaoParams) -> Result<()> {
        initialize_dao_handler(ctx, params)
    }

    pub fn initialize_dao_extensions(
        ctx: Context<InitializeDaoExtensions>,
        params: InitializeDaoParams,
    ) -> Result<()> {
        initialize_dao_extensions_handler(ctx, params)
    }

    pub fn initialize_dao_governance(
        ctx: Context<InitializeDaoGovernance>,
        params: InitializeDaoParams,
    ) -> Result<()> {
        initialize_dao_governance_handler(ctx, params)
    }

    // ── DAO creation stake (Phase 3) ─────────────────────────────────────────
    /// Lock the recoverable `$99`-of-NAVE creation stake into escrow. Called in
    /// the same creation flow, immediately after `initialize_dao_governance`.
    /// `amount` is the oracle-derived required NAVE (base units); the handler
    /// enforces the escrow receives the full, non-zero transfer. Formation
    /// itself charges NO protocol fee. `price_usd_micro` is recorded as
    /// price-snapshot metadata only.
    pub fn stake_dao_creation(
        ctx: Context<StakeDaoCreation>,
        amount: u64,
        price_usd_micro: u64,
    ) -> Result<()> {
        stake_dao_creation_handler(ctx, amount, price_usd_micro)
    }

    // ── DAO moonlighting lifecycle (Phase 5) ─────────────────────────────────
    /// Record an approved `MoonlightRequest`: halt agents + block new
    /// strategy/deposit, recording the proposal creator as distribution driver.
    pub fn record_moonlight_request(ctx: Context<RecordMoonlightRequest>) -> Result<()> {
        record_moonlight_request_handler(ctx)
    }

    /// Distribution wizard step 1: the proposal creator enters the recipient.
    pub fn set_moonlight_distribution(
        ctx: Context<SetMoonlightDistribution>,
        recipient: Pubkey,
    ) -> Result<()> {
        set_moonlight_distribution_handler(ctx, recipient)
    }

    /// Distribution wizard step 2: after the bound `MoonlightDistribution`
    /// proposal passes, release the staked NAVE to the approved recipient.
    pub fn execute_moonlight_distribution(
        ctx: Context<ExecuteMoonlightDistribution>,
    ) -> Result<()> {
        execute_moonlight_distribution_handler(ctx)
    }

    /// Final phase: mark the DAO moonlighted/hidden from participants.
    pub fn finalize_moonlight(ctx: Context<FinalizeMoonlight>) -> Result<()> {
        finalize_moonlight_handler(ctx)
    }

    /// Founder-only reopen: restake the current `$99` of NAVE and return the DAO
    /// to `Active`.
    pub fn restore_dao(
        ctx: Context<RestoreDao>,
        amount: u64,
        price_usd_micro: u64,
    ) -> Result<()> {
        restore_dao_handler(ctx, amount, price_usd_micro)
    }

    pub fn update_constitution(
        ctx: Context<UpdateConstitution>,
        protocols: Vec<ProtocolInput>,
        confidence_threshold: Option<u8>,
        agent_threshold_usd: Option<u64>,
    ) -> Result<()> {
        update_constitution_handler(ctx, protocols, confidence_threshold, agent_threshold_usd)
    }

    pub fn set_review_window(
        ctx: Context<SetReviewWindow>,
        review_window_secs: i64,
    ) -> Result<()> {
        set_review_window_handler(ctx, review_window_secs)
    }

    /// Founder-gated: set the per-DAO `jupiter_swap` max-slippage guardrail
    /// (bps). `0` disables it (default).
    pub fn set_max_slippage_bps(
        ctx: Context<SetMaxSlippageBps>,
        max_slippage_bps: u16,
    ) -> Result<()> {
        set_max_slippage_bps_handler(ctx, max_slippage_bps)
    }

    /// Founder-gated: set the per-DAO `jupiter_swap` max single-call size
    /// guardrail (bps of the pre-swap balance of the asset sold). `0`
    /// disables it (default).
    pub fn set_max_single_swap_bps(
        ctx: Context<SetMaxSingleSwapBps>,
        max_single_swap_bps: u16,
    ) -> Result<()> {
        set_max_single_swap_bps_handler(ctx, max_single_swap_bps)
    }

    pub fn set_policy_parameters(
        ctx: Context<SetPolicyParameters>,
        min_stablecoin_reserve_bps: u16,
        max_total_deployed_bps: u16,
        min_liquidity_bps: u16,
        rebalance_frequency_secs: i64,
    ) -> Result<()> {
        set_policy_parameters_handler(
            ctx,
            min_stablecoin_reserve_bps,
            max_total_deployed_bps,
            min_liquidity_bps,
            rebalance_frequency_secs,
        )
    }

    /// Founder one-shot ActivationHub bootstrap. After `GuardianConfig.bootstrapped`
    /// is true, further changes require `apply_guardian_config_from_governance`
    /// via a passed Permission proposal.
    pub fn update_guardian_config(
        ctx: Context<UpdateGuardianConfig>,
        wallets: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        update_guardian_config_handler(ctx, wallets, threshold)
    }

    /// CPI-only from `nave_governance::execute_permission_proposal`. Applies
    /// wallets+threshold bound to a Passed Permission proposal payload.
    pub fn apply_guardian_config_from_governance(
        ctx: Context<ApplyGuardianConfigFromGovernance>,
    ) -> Result<()> {
        apply_guardian_config_from_governance_handler(ctx)
    }

    /// Permissionless one-byte layout migration for GuardianConfig accounts
    /// created before the `bootstrapped` latch field existed.
    pub fn resize_guardian_config(ctx: Context<ResizeGuardianConfig>) -> Result<()> {
        resize_guardian_config_handler(ctx)
    }

    pub fn update_agent_set(
        ctx: Context<UpdateAgentSet>,
        agent_authorities: Vec<Pubkey>,
    ) -> Result<()> {
        update_agent_set_handler(ctx, agent_authorities)
    }

    pub fn emergency_freeze(ctx: Context<EmergencyFreeze>, action_nonce: u64) -> Result<()> {
        emergency_freeze_handler(ctx, action_nonce)
    }

    pub fn emergency_unfreeze(ctx: Context<EmergencyUnfreeze>, action_nonce: u64) -> Result<()> {
        emergency_unfreeze_handler(ctx, action_nonce)
    }

    pub fn apply_agent_rotation(ctx: Context<ApplyAgentRotation>, role: u8) -> Result<()> {
        apply_agent_rotation_handler(ctx, role)
    }

    pub fn toggle_agents(ctx: Context<ToggleAgents>, enabled: bool) -> Result<()> {
        toggle_agents_handler(ctx, enabled)
    }

    pub fn guardian_disable_agents(
        ctx: Context<GuardianDisableAgents>,
        action_nonce: u64,
    ) -> Result<()> {
        guardian_disable_agents_handler(ctx, action_nonce)
    }

    pub fn emergency_pause_agents(ctx: Context<EmergencyPauseAgents>) -> Result<()> {
        emergency_pause_agents_handler(ctx)
    }

    /// Founder-callable: close a finished or stale `GuardianAction` PDA and
    /// reclaim its rent. See `cancel_guardian_action_handler` for the staleness
    /// gate that preserves guardian fail-closed behavior.
    pub fn cancel_guardian_action(ctx: Context<CancelGuardianAction>) -> Result<()> {
        cancel_guardian_action_handler(ctx)
    }

    /// SOL-H2: guardian M-of-N (not a single Executive) nullifies an agent slot
    /// and freezes the DAO. `action_nonce` keys the accumulating GuardianAction.
    pub fn nullify_agent(ctx: Context<NullifyAgent>, role: u8, action_nonce: u64) -> Result<()> {
        nullify_agent_handler(ctx, role, action_nonce)
    }

    pub fn restore_agent(ctx: Context<RestoreAgent>, role: u8, action_nonce: u64) -> Result<()> {
        restore_agent_handler(ctx, role, action_nonce)
    }

    pub fn guardian_enable_agents(
        ctx: Context<GuardianEnableAgents>,
        action_nonce: u64,
    ) -> Result<()> {
        guardian_enable_agents_handler(ctx, action_nonce)
    }

    pub fn cancel_agent_rotation(ctx: Context<CancelAgentRotation>, role: u8) -> Result<()> {
        cancel_agent_rotation_handler(ctx, role)
    }

    pub fn guardian_cancel_agent_rotation(
        ctx: Context<GuardianCancelAgentRotation>,
        role: u8,
        action_nonce: u64,
    ) -> Result<()> {
        guardian_cancel_agent_rotation_handler(ctx, role, action_nonce)
    }

    pub fn apply_guardian_agent_change(
        ctx: Context<ApplyGuardianAgentChange>,
        agent_slot: u8,
    ) -> Result<()> {
        apply_guardian_agent_change_handler(ctx, agent_slot)
    }

    pub fn cancel_guardian_agent_change(
        ctx: Context<CancelGuardianAgentChange>,
        agent_slot: u8,
    ) -> Result<()> {
        cancel_guardian_agent_change_handler(ctx, agent_slot)
    }

    pub fn apply_review_window(ctx: Context<ApplyReviewWindow>) -> Result<()> {
        apply_review_window_handler(ctx)
    }

    pub fn update_agent_status(
        ctx: Context<UpdateAgentStatus>,
        agent_slot: u8,
        new_status: u8,
        action_nonce: u64,
    ) -> Result<()> {
        update_agent_status_handler(ctx, agent_slot, new_status, action_nonce)
    }

    pub fn rotate_agent_key(
        ctx: Context<RotateAgentKey>,
        agent_slot: u8,
        new_pubkey: Pubkey,
        action_nonce: u64,
    ) -> Result<()> {
        rotate_agent_key_handler(ctx, agent_slot, new_pubkey, action_nonce)
    }

    pub fn deposit_to_vault(ctx: Context<DepositToVault>, amount: u64) -> Result<()> {
        deposit_to_vault_handler(ctx, amount)
    }

    pub fn withdraw_from_vault(ctx: Context<WithdrawFromVault>, amount: u64) -> Result<()> {
        withdraw_from_vault_handler(ctx, amount)
    }

    /// Collect the discrete annual management fee (0.65%/yr of idle balance) for
    /// one registered asset, paid in-kind to the protocol revenue wallet. Call
    /// once per mint. Replaces the prior continuous time-prorated model.
    ///
    /// NOTE: the performance fee is no longer a standalone instruction. It is an
    /// 8.5%-of-realized-yield skim taken inline on `record_strategy_withdrawal`
    /// (the audited strategy-withdrawal path); the old high-water-mark
    /// `collect_performance_fee` was inert (Finding C) and has been removed.
    pub fn collect_management_fee(ctx: Context<CollectManagementFee>) -> Result<()> {
        collect_management_fee_handler(ctx)
    }

    pub fn set_dao_privacy(ctx: Context<SetDaoPrivacy>, privacy_mode: u8) -> Result<()> {
        set_dao_privacy_handler(ctx, privacy_mode)
    }

    pub fn set_holder_annotation(
        ctx: Context<SetHolderAnnotation>,
        annotation: String,
    ) -> Result<()> {
        set_holder_annotation_handler(ctx, annotation)
    }

    pub fn approve_holder_annotation(ctx: Context<ReviewHolderAnnotation>) -> Result<()> {
        approve_holder_annotation_handler(ctx)
    }

    pub fn deny_holder_annotation(ctx: Context<ReviewHolderAnnotation>) -> Result<()> {
        deny_holder_annotation_handler(ctx)
    }

    pub fn archive_proposals(ctx: Context<ArchiveProposals>, count: u64) -> Result<()> {
        archive_proposals_handler(ctx, count)
    }

    pub fn register_dao_token(
        ctx: Context<RegisterDaoToken>,
        name: String,
        symbol: String,
        decimals: u8,
        charge_mint_fee: bool,
        initial_supply: u64,
    ) -> Result<()> {
        register_dao_token_handler(ctx, name, symbol, decimals, charge_mint_fee, initial_supply)
    }

    pub fn initialize_protocol_fee_vault(
        ctx: Context<InitializeProtocolFeeVault>,
    ) -> Result<()> {
        initialize_protocol_fee_vault_handler(ctx)
    }

    /// CPI-only from `nave_governance::mint_additional_tokens` (verified via
    /// the instructions sysvar): PDA-signed mint of a registered DAO token.
    /// The DAO-registry PDA (mint authority) belongs to this program, so only
    /// nave_core can `invoke_signed` for it.
    pub fn mint_dao_token(ctx: Context<MintDaoToken>, amount: u64) -> Result<()> {
        mint_dao_token_handler(ctx, amount)
    }

    /// SOL-C2: CPI-only from `nave_governance::execute_switch_voting_system`
    /// (verified via the instructions sysvar). The target governance
    /// configuration is decoded from the passed, Passed+finalized
    /// `SwitchVotingSystem` proposal's payload, not a caller-supplied
    /// argument — see `switch_voting_system_handler` for the full rationale.
    pub fn switch_voting_system(ctx: Context<SwitchVotingSystem>) -> Result<()> {
        switch_voting_system_handler(ctx)
    }

    pub fn revoke_token_authority(ctx: Context<RevokeTokenAuthority>) -> Result<()> {
        revoke_token_authority_handler(ctx)
    }

    pub fn update_token_metadata(
        ctx: Context<UpdateTokenMetadata>,
        name: String,
        symbol: String,
    ) -> Result<()> {
        update_token_metadata_handler(ctx, name, symbol)
    }

    pub fn record_proposal_creation(ctx: Context<RecordProposalCreation>) -> Result<()> {
        record_proposal_creation_handler(ctx)
    }

    /// Consume the DAO's one-time founder bootstrap latch. CPI-only from
    /// `nave_execution` (see `record_bootstrap_usage_handler`).
    pub fn record_bootstrap_usage(ctx: Context<RecordBootstrapUsage>) -> Result<()> {
        record_bootstrap_usage_handler(ctx)
    }

    /// Native SOL disbursement for a passed `ProposalType::Transfer` vote.
    /// CPI-only: the current instruction must be `nave_governance` (see
    /// `verify_governance_caller`).
    pub fn execute_governance_transfer_native_sol(
        ctx: Context<ExecuteGovernanceTransferNativeSol>,
    ) -> Result<()> {
        execute_governance_transfer_native_sol_handler(ctx)
    }

    /// SPL disbursement for a passed `ProposalType::Transfer` vote.
    /// CPI-only from `nave_governance`.
    pub fn execute_governance_transfer_spl(
        ctx: Context<ExecuteGovernanceTransferSpl>,
    ) -> Result<()> {
        execute_governance_transfer_spl_handler(ctx)
    }

    /// NFT (ERC-721-equivalent SPL: decimals 0, supply 1) disbursement for a
    /// passed `ProposalType::Transfer` vote whose payload binds (recipient, mint, 1).
    pub fn execute_governance_transfer_nft(
        ctx: Context<ExecuteGovernanceTransferNft>,
    ) -> Result<()> {
        execute_governance_transfer_nft_handler(ctx)
    }

    pub fn register_asset(
        ctx: Context<RegisterAsset>,
        pyth_feed_id: [u8; 32],
        is_stablecoin: bool,
        asset_kind: u8,
    ) -> Result<()> {
        register_asset_handler(ctx, pyth_feed_id, is_stablecoin, asset_kind)
    }

    /// Register an NFT (decimals-0, supply-1 SPL mint) for treasury custody.
    /// Creates the NftVaultRecord + vault-owned holding account; held at $0 NAV.
    pub fn register_nft_asset(ctx: Context<RegisterNftAsset>) -> Result<()> {
        register_nft_asset_handler(ctx)
    }

    pub fn deposit_to_asset(ctx: Context<DepositToAsset>, amount: u64) -> Result<()> {
        deposit_to_asset_handler(ctx, amount)
    }

    /// Deposit native SOL into the DAO's vault authority PDA (native-SOL custody
    /// for governance transfers). Resets NAV staleness so caps re-check against a
    /// fresh revaluation.
    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        deposit_sol_handler(ctx, amount)
    }

    pub fn set_fee_asset(ctx: Context<SetFeeAsset>) -> Result<()> {
        set_fee_asset_handler(ctx)
    }

    pub fn revalue_treasury<'info>(
        ctx: Context<'_, '_, '_, 'info, RevalueTreasury<'info>>,
    ) -> Result<()> {
        revalue_treasury_handler(ctx)
    }

    pub fn init_strategy_position(
        ctx: Context<InitStrategyPosition>,
        protocol_id: String,
    ) -> Result<()> {
        init_strategy_position_handler(ctx, protocol_id)
    }

    /// Founder-gated: bind the approved Kamino market + reserve to a position and
    /// provision its vault-owned receipt-token (cToken) account.
    pub fn configure_position_targets(
        ctx: Context<ConfigurePositionTargets>,
        protocol_id: String,
        ext_market: Pubkey,
        ext_reserve: Pubkey,
    ) -> Result<()> {
        configure_position_targets_handler(ctx, protocol_id, ext_market, ext_reserve)
    }

    /// Operational-agent-gated: deploy escrowed liquidity into the configured
    /// Kamino reserve, receiving cTokens into the vault-owned position account.
    pub fn kamino_deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, KaminoDeposit<'info>>,
        amount: u64,
    ) -> Result<()> {
        kamino_deposit_handler(ctx, amount)
    }

    /// Operational-agent-gated: redeem cTokens from the configured Kamino reserve
    /// back into the position escrow as the underlying liquidity.
    pub fn kamino_withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, KaminoWithdraw<'info>>,
        collateral_amount: u64,
    ) -> Result<()> {
        kamino_withdraw_handler(ctx, collateral_amount)
    }

    /// Operational-agent-gated: unwrap escrowed wSOL and `DepositSol` into the
    /// configured SPL stake pool, receiving pool tokens into the position account.
    pub fn jito_deposit(ctx: Context<JitoDeposit>, amount: u64) -> Result<()> {
        jito_deposit_handler(ctx, amount)
    }

    /// Operational-agent-gated: `WithdrawSol` from the stake pool and re-wrap the
    /// redeemed lamports into the wSOL escrow.
    pub fn jito_withdraw(ctx: Context<JitoWithdraw>, pool_tokens: u64) -> Result<()> {
        jito_withdraw_handler(ctx, pool_tokens)
    }

    /// Founder-gated: bind the approved MarginFi group + bank to a position and
    /// (once per DAO) provision its shared cross-margin `MarginfiAccount` ledger
    /// via the real `marginfi_account_initialize_pda` CPI.
    pub fn configure_marginfi_position(
        ctx: Context<ConfigureMarginfiPosition>,
        ext_market: Pubkey,
        ext_reserve: Pubkey,
    ) -> Result<()> {
        configure_marginfi_position_handler(ctx, ext_market, ext_reserve)
    }

    /// Operational-agent-gated: deploy escrowed liquidity into the configured
    /// MarginFi bank via a real `lending_account_deposit` CPI.
    pub fn marginfi_deposit(ctx: Context<MarginfiDeposit>, amount: u64) -> Result<()> {
        marginfi_deposit_handler(ctx, amount)
    }

    /// Operational-agent-gated: redeem liquidity from the configured MarginFi
    /// bank back into the position escrow via a real `lending_account_withdraw`
    /// CPI. `remaining_accounts` must forward the bank's oracle account(s) for
    /// MarginFi's post-withdrawal health check.
    pub fn marginfi_withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, MarginfiWithdraw<'info>>,
        amount: u64,
    ) -> Result<()> {
        marginfi_withdraw_handler(ctx, amount)
    }

    /// Operational-agent-gated: supply escrowed liquidity into the Jupiter Lend
    /// Earn vault, minting jlTokens into the vault-owned jlToken ATA.
    pub fn jupiter_deposit(ctx: Context<JupiterDeposit>, amount: u64) -> Result<()> {
        jupiter_deposit_handler(ctx, amount)
    }

    /// Operational-agent-gated: redeem `amount` underlying base units (or
    /// `u64::MAX` for the full position) from the Jupiter Lend Earn vault back
    /// into the vault-owned underlying ATA.
    pub fn jupiter_withdraw(ctx: Context<JupiterWithdraw>, amount: u64) -> Result<()> {
        jupiter_withdraw_handler(ctx, amount)
    }

    /// Operational-agent-gated: swap one treasury asset for another via a direct
    /// CPI into the Jupiter v6 aggregator, signing as the `vault_authority` PDA.
    /// The route is built off-chain and forwarded as `route_data` +
    /// `remaining_accounts`. Mainnet-only (Jupiter v6 is mainnet-deployed).
    pub fn jupiter_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, JupiterSwap<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        expected_amount_out: u64,
        route_data: Vec<u8>,
    ) -> Result<()> {
        jupiter_swap_handler(ctx, amount_in, min_amount_out, expected_amount_out, route_data)
    }

    pub fn init_strategy_escrow(
        ctx: Context<InitStrategyEscrow>,
        protocol_id: String,
    ) -> Result<()> {
        init_strategy_escrow_handler(ctx, protocol_id)
    }

    pub fn record_strategy_deposit(
        ctx: Context<RecordStrategyDeposit>,
        protocol_id: String,
        amount: u64,
        amount_usd: u64,
    ) -> Result<()> {
        record_strategy_deposit_handler(ctx, protocol_id, amount, amount_usd)
    }

    pub fn record_strategy_withdrawal(
        ctx: Context<RecordStrategyWithdrawal>,
        amount: u64,
        amount_usd: u64,
        protocol_id: String,
    ) -> Result<()> {
        record_strategy_withdrawal_handler(ctx, amount, amount_usd, protocol_id)
    }

    pub fn update_strategy_position_value(
        ctx: Context<UpdateStrategyPositionValue>,
        protocol_id: String,
    ) -> Result<()> {
        update_strategy_position_value_handler(ctx, protocol_id)
    }
}
