pub mod authority;
pub mod constants;
pub mod errors;
pub mod events;
mod proposal_account;
pub mod state;

use std::ops::Deref;

use anchor_lang::prelude::*;
use solana_program::hash::hash;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use nave_core::{
    constants::{
        jupiter_lending_program, AgentRole, AssetKind, MoonlightStatus,
        ASSET_CONFIG_SEED, DAO_CONTROL_SEED, DAO_LIFECYCLE_SEED, FEE_CONFIG_SEED, GLOBAL_CONFIG_SEED,
        STRATEGY_ESCROW_SEED, TREASURY_ASSET_SEED, TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED,
    },
    state::{
        AgentSet, AssetConfig, DaoControl, DaoLifecycle, DaoRegistry, FeeConfig, NaveGlobalConfig,
        TreasuryAsset, TreasuryConstitution, TreasuryVault, VaultAuthority,
    },
    utils::{
        enforce_allocation_cap, nonstable_micro_usd, realized_yield_withdraw_cap, value_stable,
        EXECUTION_AUTHORITY_SEED,
    },
};

use nave_governance::constants::{ProposalStatus, ProposalType};

use crate::constants::{
    ExecutionStatus, EXECUTION_REQUEST_SEED, NAV_MAX_STALENESS_SECS, REVIEW_WINDOW_SECONDS,
};
use crate::errors::ExecutionError;
use crate::events::*;
use crate::proposal_account::ReadableProposal;
use crate::state::ExecutionRequest;

declare_id!("2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb");

#[program]
pub mod nave_execution {
    use super::*;

    pub fn create_execution_request(
        ctx: Context<CreateExecutionRequest>,
        amount: u64,
        protocol_program: Pubkey,
        mint: Pubkey,
        bootstrap: bool,
    ) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, ExecutionError::GlobalPaused);
        // A frozen DAO must not queue new capital movements. Guardians freeze to
        // stop the pipeline; allowing new requests while frozen would let work
        // accumulate that auto-executes the moment the freeze is lifted.
        require!(!ctx.accounts.dao_registry.frozen, ExecutionError::DaoFrozen);
        // A moonlighting DAO (approved wind-down in progress) must not queue new
        // deployments either; only controlled unwind/distribution may proceed.
        require_not_moonlighting(&ctx.accounts.dao_lifecycle)?;
        require!(amount > 0, ExecutionError::MathOverflow);
        require!(
            ctx.accounts.proposal.dao == ctx.accounts.dao_registry.key(),
            ExecutionError::ProposalDaoMismatch
        );
        require!(
            ctx.accounts.proposal.status == ProposalStatus::Passed as u8,
            ExecutionError::ProposalNotPassed
        );
        require!(
            ctx.accounts.proposal.finalized_at > 0,
            ExecutionError::ProposalNotPassed
        );
        require!(
            ctx.accounts.proposal.proposal_type == ProposalType::Strategy as u8,
            ExecutionError::InvalidProposalType
        );
        require!(
            ctx.accounts.constitution.is_protocol_approved(&protocol_program),
            ExecutionError::ProtocolNotApproved
        );
        // NE-7: bind `amount`, `protocol_program`, and `mint` to the
        // governance-approved payload. The proposal commits to
        // sha256(protocol_program(32) ‖ amount_le(8) ‖ mint(32)), so a
        // permissionless request creator cannot substitute values that were never
        // voted on. Off-chain builders must construct the Strategy proposal payload
        // as exactly these 72 bytes.
        let mut payload_preimage = [0u8; 72];
        payload_preimage[..32].copy_from_slice(protocol_program.as_ref());
        payload_preimage[32..40].copy_from_slice(&amount.to_le_bytes());
        payload_preimage[40..].copy_from_slice(mint.as_ref());
        require!(
            hash(&payload_preimage).to_bytes() == ctx.accounts.proposal.payload_hash,
            ExecutionError::PayloadHashMismatch
        );
        // Multi-asset caps are denominated in USD and depend on a live Pyth price,
        // so the authoritative allocation / deployment-cap / liquidity-floor /
        // stablecoin-reserve checks run at execution time (see
        // `validate_execution_preconditions`). At creation we only bind the payload
        // and confirm the protocol is approved (checked above).

        let request = &mut ctx.accounts.execution_request;
        let now = Clock::get()?.unix_timestamp;
        request.bump = ctx.bumps.execution_request;
        request.dao = ctx.accounts.dao_registry.key();
        // Tie the request index to the governance proposal's monotonic index
        // (not the mutable active `proposal_count`) so it stays stable/unique
        // even after proposals are archived.
        request.request_index = ctx.accounts.proposal.proposal_index;
        request.proposal = ctx.accounts.proposal.key();
        request.protocol_program = protocol_program;
        request.mint = mint;
        request.status = ExecutionStatus::Pending as u8;
        request.tx_payload_hash = ctx.accounts.proposal.payload_hash;
        request.amount = amount;
        request.review_end = 0;
        request.created_at = now;
        request.updated_at = now;
        request.executed_at = 0;
        request.executive_reasoning_hash = [0u8; 32];
        request.financial_reasoning_hash = [0u8; 32];
        request.oversight_reasoning_hash = [0u8; 32];
        request.operational_halt_reason_hash = [0u8; 32];
        request.withdrawn_amount = 0;

        if bootstrap {
            // One-time founder bootstrap path: the FIRST execution request for a
            // DAO may snapshot a zero review window for immediate execution. This
            // is gated to the founder and consumes the DAO's one-time
            // `dao_registry.bootstrap_used` latch (flipped via a nave_core CPI;
            // `DaoRegistry` is owned by nave_core so only it may mutate the flag).
            require!(
                ctx.accounts.creator.key() == ctx.accounts.dao_registry.founder,
                ExecutionError::Unauthorized
            );
            nave_core::cpi::record_bootstrap_usage(CpiContext::new(
                ctx.accounts.nave_core_program.to_account_info(),
                nave_core::cpi::accounts::RecordBootstrapUsage {
                    founder: ctx.accounts.creator.to_account_info(),
                    dao_registry: ctx.accounts.dao_registry.to_account_info(),
                    execution_program: ctx.accounts.execution_program.to_account_info(),
                    // SEC-M4: forward the instructions sysvar so nave_core can
                    // verify this is a genuine CPI from nave_execution.
                    instructions: ctx.accounts.instructions.to_account_info(),
                },
            ))?;
            // Snapshot 0; the immediate window is driven by `request.bootstrap`
            // in `oversight_approve` (so the legacy `review_window == 0 -> 24h`
            // fallback is not triggered for this request).
            request.review_window = 0;
            request.bootstrap = true;

            emit!(BootstrapExecutionRequestCreated {
                dao: request.dao,
                request: request.key(),
                request_index: request.request_index,
                protocol_program,
                founder: ctx.accounts.creator.key(),
            });
        } else {
            // Snapshot the DAO's configured review window so a later constitution
            // change cannot shorten the human-oversight delay for this request.
            request.review_window = ctx.accounts.constitution.review_window_secs;
            request.bootstrap = false;

            emit!(ExecutionRequestCreated {
                dao: request.dao,
                request: request.key(),
                request_index: request.request_index,
                protocol_program,
            });
        }

        Ok(())
    }

    pub fn executive_approve(
        ctx: Context<ExecutiveApprove>,
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        validate_agent_signer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.global_config,
            &ctx.accounts.dao_registry,
            &ctx.accounts.agent_set,
            AgentRole::Executive,
        )?;
        require!(
            reasoning_hash != [0u8; 32],
            ExecutionError::ReasoningHashRequired
        );
        transition_status(
            &mut ctx.accounts.execution_request,
            ExecutionStatus::Pending,
            ExecutionStatus::ExecutiveApproved,
        )?;
        ctx.accounts.execution_request.executive_reasoning_hash = reasoning_hash;

        emit!(ExecutiveApprovedEvent {
            request: ctx.accounts.execution_request.key(),
            approver: ctx.accounts.authority.key(),
        });
        emit!(AgentApprovalEvent {
            dao: ctx.accounts.execution_request.dao,
            agent_role: AgentRole::Executive as u8,
            execution_request: ctx.accounts.execution_request.key(),
            reasoning_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn financial_approve(
        ctx: Context<FinancialApprove>,
        tx_payload_hash: [u8; 32],
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        validate_agent_signer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.global_config,
            &ctx.accounts.dao_registry,
            &ctx.accounts.agent_set,
            AgentRole::Financial,
        )?;
        require!(
            reasoning_hash != [0u8; 32],
            ExecutionError::ReasoningHashRequired
        );
        transition_status(
            &mut ctx.accounts.execution_request,
            ExecutionStatus::ExecutiveApproved,
            ExecutionStatus::FinancialApproved,
        )?;
        // Bind to the hash captured from the proposal at request creation. The
        // financial agent must reproduce it exactly and may not substitute a
        // different payload. (Previously this overwrote the stored hash.)
        require!(
            tx_payload_hash != [0u8; 32],
            ExecutionError::PayloadHashMismatch
        );
        require!(
            tx_payload_hash == ctx.accounts.execution_request.tx_payload_hash,
            ExecutionError::PayloadHashMismatch
        );
        ctx.accounts.execution_request.financial_reasoning_hash = reasoning_hash;

        emit!(FinancialApprovedEvent {
            request: ctx.accounts.execution_request.key(),
            approver: ctx.accounts.authority.key(),
            tx_payload_hash,
        });
        emit!(AgentApprovalEvent {
            dao: ctx.accounts.execution_request.dao,
            agent_role: AgentRole::Financial as u8,
            execution_request: ctx.accounts.execution_request.key(),
            reasoning_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn oversight_approve(
        ctx: Context<OversightApprove>,
        tx_payload_hash: [u8; 32],
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        validate_agent_signer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.global_config,
            &ctx.accounts.dao_registry,
            &ctx.accounts.agent_set,
            AgentRole::Oversight,
        )?;
        require!(
            reasoning_hash != [0u8; 32],
            ExecutionError::ReasoningHashRequired
        );
        require!(
            tx_payload_hash != [0u8; 32]
                && tx_payload_hash == ctx.accounts.execution_request.tx_payload_hash,
            ExecutionError::PayloadHashMismatch
        );
        transition_status(
            &mut ctx.accounts.execution_request,
            ExecutionStatus::FinancialApproved,
            ExecutionStatus::OversightApproved,
        )?;

        let now = Clock::get()?.unix_timestamp;
        // Bootstrap requests execute immediately (zero review window). Otherwise
        // use the window snapshotted at request creation; fall back to the
        // historical 24h constant for any non-bootstrap request created before
        // the `review_window` field existed (review_window == 0).
        let window = if ctx.accounts.execution_request.bootstrap {
            0
        } else if ctx.accounts.execution_request.review_window > 0 {
            ctx.accounts.execution_request.review_window
        } else {
            REVIEW_WINDOW_SECONDS
        };
        ctx.accounts.execution_request.status = ExecutionStatus::InReview as u8;
        ctx.accounts.execution_request.review_end = now
            .checked_add(window)
            .ok_or(ExecutionError::MathOverflow)?;
        ctx.accounts.execution_request.updated_at = now;
        ctx.accounts.execution_request.oversight_reasoning_hash = reasoning_hash;

        emit!(OversightApprovedEvent {
            request: ctx.accounts.execution_request.key(),
            approver: ctx.accounts.authority.key(),
        });
        emit!(AgentApprovalEvent {
            dao: ctx.accounts.execution_request.dao,
            agent_role: AgentRole::Oversight as u8,
            execution_request: ctx.accounts.execution_request.key(),
            reasoning_hash,
            timestamp: now,
        });
        Ok(())
    }

    pub fn operational_halt(
        ctx: Context<OperationalHalt>,
        reason_hash: [u8; 32],
    ) -> Result<()> {
        validate_agent_signer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.global_config,
            &ctx.accounts.dao_registry,
            &ctx.accounts.agent_set,
            AgentRole::Operational,
        )?;
        require!(
            reason_hash != [0u8; 32],
            ExecutionError::ReasoningHashRequired
        );
        let status = ctx.accounts.execution_request.status;
        require!(
            status == ExecutionStatus::InReview as u8
                || status == ExecutionStatus::OversightApproved as u8,
            ExecutionError::InvalidStateTransition
        );
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.execution_request.status = ExecutionStatus::Halted as u8;
        ctx.accounts.execution_request.updated_at = now;
        ctx.accounts.execution_request.operational_halt_reason_hash = reason_hash;

        emit!(OperationalHaltEvent {
            dao: ctx.accounts.execution_request.dao,
            execution_request: ctx.accounts.execution_request.key(),
            reason_hash,
            timestamp: now,
        });
        Ok(())
    }

    pub fn operational_clear(ctx: Context<OperationalClear>, reason_hash: [u8; 32]) -> Result<()> {
        validate_agent_signer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.global_config,
            &ctx.accounts.dao_registry,
            &ctx.accounts.agent_set,
            AgentRole::Operational,
        )?;
        require!(reason_hash != [0u8; 32], ExecutionError::ReasoningHashRequired);
        require!(
            ctx.accounts.execution_request.status == ExecutionStatus::Halted as u8,
            ExecutionError::InvalidStateTransition
        );
        ctx.accounts.execution_request.status = ExecutionStatus::InReview as u8;
        ctx.accounts.execution_request.updated_at = Clock::get()?.unix_timestamp;

        emit!(OperationalClearEvent {
            request: ctx.accounts.execution_request.key(),
            agent: ctx.accounts.authority.key(),
            reason_hash,
        });
        Ok(())
    }

    /// Transition an in-review request to Expired once its review window has
    /// elapsed without execution. Gated to the Oversight agent (`AgentRole::Operational`,
    /// the monitoring role) so it cannot be used to grief a legitimately approved request.
    pub fn expire_request(ctx: Context<ExpireRequest>) -> Result<()> {
        validate_agent_signer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.global_config,
            &ctx.accounts.dao_registry,
            &ctx.accounts.agent_set,
            AgentRole::Operational,
        )?;
        let request = &ctx.accounts.execution_request;
        require!(
            request.status == ExecutionStatus::InReview as u8,
            ExecutionError::InvalidStateTransition
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now >= request.review_end, ExecutionError::ReviewWindowActive);

        let request = &mut ctx.accounts.execution_request;
        request.status = ExecutionStatus::Expired as u8;
        request.updated_at = now;

        emit!(ExecutionExpiredEvent {
            dao: request.dao,
            execution_request: request.key(),
            timestamp: now,
        });
        Ok(())
    }

    pub fn execute_strategy(ctx: Context<ExecuteStrategy>) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, ExecutionError::GlobalPaused);
        // H1: the normal execution path must respect an emergency freeze. A
        // guardian M-of-N freeze during the review window previously did NOT
        // block the permissionless post-review `execute_strategy`, so capital
        // could still move after guardians intervened. Frozen DAOs may only
        // move funds through the Executive break-glass `execute_strategy_direct`.
        require!(!ctx.accounts.dao_registry.frozen, ExecutionError::DaoFrozen);
        // Moonlighting halts new deployments: an in-review request must not be
        // able to deploy capital after the DAO voted to wind down. (This path
        // is permissionless, so the agent halt is checked explicitly below.)
        require_not_moonlighting(&ctx.accounts.dao_lifecycle)?;
        require!(ctx.accounts.agent_set.agents_enabled, ExecutionError::AgentsDisabled);
        let request = &ctx.accounts.execution_request;
        require!(
            request.status == ExecutionStatus::InReview as u8
                || request.status == ExecutionStatus::OversightApproved as u8,
            ExecutionError::InvalidStateTransition
        );
        if request.status == ExecutionStatus::InReview as u8 {
            require!(
                Clock::get()?.unix_timestamp >= request.review_end,
                ExecutionError::ReviewWindowActive
            );
        }
        require!(
            request.tx_payload_hash != [0u8; 32],
            ExecutionError::PayloadHashMismatch
        );
        // NE-7 mint binding: the governance-approved payload commits to a
        // specific asset mint (stored as `request.mint` at creation). The
        // permissionless executor must deploy THAT asset — not substitute
        // another registered asset's accounts to deploy `request.amount` of a
        // mint the proposal never authorized. (`withdraw_from_strategy` already
        // enforces this; the deposit paths previously did not.)
        require!(
            request.mint == ctx.accounts.mint.key(),
            ExecutionError::AssetMintMismatch
        );
        let protocol = request.protocol_program;
        let request_amount = request.amount;
        let amount_usd = prepare_strategy_deposit(
            &ctx.accounts.constitution,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.asset_config,
            &ctx.accounts.treasury_asset,
            &ctx.accounts.mint,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_position,
            &ctx.accounts.price_update,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.dao_registry.key(),
            protocol,
            request_amount,
        )?;

        let dao_key = ctx.accounts.dao_registry.key();
        let bump = ctx.bumps.execution_authority;
        let bump_seed = [bump];
        let seeds = [EXECUTION_AUTHORITY_SEED, dao_key.as_ref(), &bump_seed];
        let signer = &[&seeds[..]];

        cpi_adapter_deposit(
            protocol,
            request_amount,
            &ctx.accounts.adapter_program,
            &ctx.accounts.execution_authority,
            &ctx.accounts.dao_registry,
            &ctx.accounts.vault_authority,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.strategy_position,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.executor,
            &ctx.accounts.token_program,
            &ctx.accounts.system_program,
            &ctx.accounts.instructions,
            signer,
        )?;
        finalize_strategy_deposit(
            &ctx.accounts.nave_core_program,
            &ctx.accounts.execution_authority,
            &ctx.accounts.dao_registry,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.treasury_vault,
            &ctx.accounts.treasury_asset,
            &ctx.accounts.strategy_position,
            &ctx.accounts.instructions,
            &ctx.accounts.vault_authority,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.token_program,
            protocol,
            request_amount,
            amount_usd,
            signer,
        )?;

        let request = &mut ctx.accounts.execution_request;
        request.status = ExecutionStatus::Executed as u8;
        request.executed_at = Clock::get()?.unix_timestamp;
        request.updated_at = request.executed_at;

        emit!(StrategyExecutedEvent {
            request: request.key(),
            amount: request.amount,
        });
        Ok(())
    }

    pub fn execute_strategy_direct(ctx: Context<ExecuteStrategyDirect>) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, ExecutionError::GlobalPaused);
        // Break-glass opens only on a guardian-quorum state: a freeze, or a
        // guardian-locked disable. A single-actor `emergency_pause_agents`
        // leaves `guardian_locked` unset and does not open it.
        let guardian_locked = DaoControl::is_guardian_locked(&ctx.accounts.dao_control)?;
        require!(
            ctx.accounts.dao_registry.frozen
                || (!ctx.accounts.agent_set.agents_enabled && guardian_locked),
            ExecutionError::DirectExecutionNotAllowed
        );
        // The moonlight halt disables the agents, which is exactly the
        // precondition that opens this break-glass path — so it must be closed
        // explicitly while the DAO is moonlighting or the Executive could keep
        // deploying capital that governance voted to wind down.
        require_not_moonlighting(&ctx.accounts.dao_lifecycle)?;
        validate_direct_execute_authority(
            &ctx.accounts.authority.key(),
            &ctx.accounts.global_config,
            &ctx.accounts.agent_set,
        )?;

        let request = &ctx.accounts.execution_request;
        // Break-glass must still respect request lifecycle: an already-Executed,
        // operator-Halted, or Expired request can never be force-executed.
        //
        // SECURITY: Restrict break-glass to requests that have already completed
        // the full three-agent approval pipeline (InReview or OversightApproved).
        // This prevents a rogue Executive agent from calling nullify_agent to
        // self-create the `frozen` condition and then executing a still-Pending
        // request that bypassed all other agent reviews. If the DAO is frozen
        // before Oversight approval, the Executive can file a new governance
        // proposal once the DAO is unfrozen by guardians.
        require!(
            request.status == ExecutionStatus::InReview as u8,
            ExecutionError::InvalidStateTransition
        );
        // Break-glass never skips the human review window.
        require!(
            Clock::get()?.unix_timestamp >= request.review_end,
            ExecutionError::ReviewWindowActive
        );
        require!(
            request.tx_payload_hash != [0u8; 32],
            ExecutionError::PayloadHashMismatch
        );
        // NE-7 mint binding (break-glass path): even the Executive override must
        // deploy the governance-bound `request.mint`, never substitute another
        // registered asset's accounts. Mirrors the check now in `execute_strategy`
        // and the long-standing one in `withdraw_from_strategy`.
        require!(
            request.mint == ctx.accounts.mint.key(),
            ExecutionError::AssetMintMismatch
        );
        let protocol = request.protocol_program;
        let request_amount = request.amount;
        let amount_usd = prepare_strategy_deposit(
            &ctx.accounts.constitution,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.asset_config,
            &ctx.accounts.treasury_asset,
            &ctx.accounts.mint,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_position,
            &ctx.accounts.price_update,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.dao_registry.key(),
            protocol,
            request_amount,
        )?;

        let dao_key = ctx.accounts.dao_registry.key();
        let bump = ctx.bumps.execution_authority;
        let bump_seed = [bump];
        let seeds = [EXECUTION_AUTHORITY_SEED, dao_key.as_ref(), &bump_seed];
        let signer = &[&seeds[..]];

        cpi_adapter_deposit(
            protocol,
            request_amount,
            &ctx.accounts.adapter_program,
            &ctx.accounts.execution_authority,
            &ctx.accounts.dao_registry,
            &ctx.accounts.vault_authority,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.strategy_position,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.authority,
            &ctx.accounts.token_program,
            &ctx.accounts.system_program,
            &ctx.accounts.instructions,
            signer,
        )?;
        finalize_strategy_deposit(
            &ctx.accounts.nave_core_program,
            &ctx.accounts.execution_authority,
            &ctx.accounts.dao_registry,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.treasury_vault,
            &ctx.accounts.treasury_asset,
            &ctx.accounts.strategy_position,
            &ctx.accounts.instructions,
            &ctx.accounts.vault_authority,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.token_program,
            protocol,
            request_amount,
            amount_usd,
            signer,
        )?;

        let request = &mut ctx.accounts.execution_request;
        request.status = ExecutionStatus::Executed as u8;
        request.executed_at = Clock::get()?.unix_timestamp;
        request.updated_at = request.executed_at;

        emit!(DirectStrategyExecutedEvent {
            request: request.key(),
            amount: request.amount,
        });
        Ok(())
    }

    pub fn withdraw_from_strategy(ctx: Context<WithdrawFromStrategy>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, ExecutionError::GlobalPaused);
        // Gate withdrawals behind the Executive agent signer (previously any
        // signer could trigger a strategy unwind).
        validate_agent_signer(
            &ctx.accounts.executor.key(),
            &ctx.accounts.global_config,
            &ctx.accounts.dao_registry,
            &ctx.accounts.agent_set,
            AgentRole::Executive,
        )?;
        let request = &ctx.accounts.execution_request;
        require!(
            request.status == ExecutionStatus::Executed as u8,
            ExecutionError::InvalidStateTransition
        );
        require!(amount > 0, ExecutionError::MathOverflow);
        // NE-8 (revised for the realized-yield path): cap cumulative withdrawals
        // for this request at the deployed principal PLUS the position's marked
        // realized gain (`current_value - deposited_amount`). This lets realized
        // GAINS flow back (the 15% performance skim is taken in nave_core on the
        // way out), which the original `<= request.amount` cap forbade
        // (Finding B). The anti-drain guarantee is preserved by nave_core's
        // per-call `current_value >= amount` floor in `record_strategy_withdrawal`:
        // a position can never return more than its marked value across ALL
        // requests, so cumulative withdrawals are hard-bounded by the marked
        // position value regardless of this softer per-request ceiling.
        let new_withdrawn = request
            .withdrawn_amount
            .checked_add(amount)
            .ok_or(ExecutionError::MathOverflow)?;
        let (pos_principal, pos_value) = read_position_marks(&ctx.accounts.strategy_position);
        let withdraw_cap =
            realized_yield_withdraw_cap(request.amount, pos_principal, pos_value)
                .map_err(|_| ExecutionError::MathOverflow)?;
        require!(
            new_withdrawn <= withdraw_cap,
            ExecutionError::WithdrawExceedsDeployed
        );
        require!(
            request.mint == ctx.accounts.mint.key(),
            ExecutionError::AssetMintMismatch
        );
        require!(
            ctx.accounts.asset_config.mint == ctx.accounts.mint.key(),
            ExecutionError::AssetMintMismatch
        );
        require_escrow_pda(
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.dao_registry.key(),
            request.protocol_program,
            &ctx.accounts.mint.key(),
        )?;

        let protocol_program = request.protocol_program;
        let request_key = request.key();
        let amount_usd =
            value_amount_usd(&ctx.accounts.asset_config, &ctx.accounts.price_update, amount)?;
        let dao_key = ctx.accounts.dao_registry.key();
        let bump = ctx.bumps.execution_authority;
        let bump_seed = [bump];
        let seeds = [EXECUTION_AUTHORITY_SEED, dao_key.as_ref(), &bump_seed];
        let signer = &[&seeds[..]];

        cpi_adapter_withdraw(
            protocol_program,
            amount,
            &ctx.accounts.adapter_program,
            &ctx.accounts.execution_authority,
            &ctx.accounts.dao_registry,
            &ctx.accounts.vault_authority,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.strategy_position,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.token_program,
            &ctx.accounts.instructions,
            signer,
        )?;
        finalize_strategy_withdrawal(
            &ctx.accounts.nave_core_program,
            &ctx.accounts.execution_authority,
            &ctx.accounts.dao_registry,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.treasury_vault,
            &ctx.accounts.treasury_asset,
            &ctx.accounts.strategy_position,
            &ctx.accounts.instructions,
            &ctx.accounts.vault_authority,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.fee_config,
            &ctx.accounts.revenue_token_account,
            &ctx.accounts.token_program,
            protocol_program,
            amount,
            amount_usd,
            signer,
        )?;

        let request = &mut ctx.accounts.execution_request;
        request.withdrawn_amount = new_withdrawn;
        request.updated_at = Clock::get()?.unix_timestamp;

        emit!(StrategyWithdrawnEvent {
            request: request_key,
            amount,
        });
        Ok(())
    }
}

/// Reject when the DAO's moonlighting lifecycle is anything other than
/// `Active`. The `DaoLifecycle` companion PDA (`nave_core`, seeds
/// `["dao_lifecycle", dao_registry]`) is created lazily on the first moonlight
/// action, so an account with no data means the DAO has never moonlighted and
/// is fine. The address is pinned by the `seeds`/`seeds::program` constraints
/// on the account, so a caller cannot substitute a different account; and the
/// PDA can only ever be allocated by `nave_core`, so an initialized account
/// here is guaranteed to be a genuine `DaoLifecycle`. Mirrors how `nave_core`
/// gates its own moonlight transitions on `dao_lifecycle.status`.
fn require_not_moonlighting(dao_lifecycle: &UncheckedAccount) -> Result<()> {
    if dao_lifecycle.data_is_empty() {
        return Ok(());
    }
    require!(
        dao_lifecycle.owner == &nave_core::ID,
        ExecutionError::DaoMoonlighting
    );
    let data = dao_lifecycle.try_borrow_data()?;
    let lifecycle = DaoLifecycle::try_deserialize(&mut &data[..])?;
    require!(
        lifecycle.status == MoonlightStatus::Active as u8,
        ExecutionError::DaoMoonlighting
    );
    Ok(())
}

fn validate_agent_signer(
    signer: &Pubkey,
    global_config: &Account<NaveGlobalConfig>,
    dao_registry: &Account<DaoRegistry>,
    agent_set: &Account<AgentSet>,
    role: AgentRole,
) -> Result<()> {
    require!(!global_config.paused, ExecutionError::GlobalPaused);
    require!(!dao_registry.frozen, ExecutionError::DaoFrozen);
    require!(agent_set.agents_enabled, ExecutionError::AgentsDisabled);
    let slot = agent_set.get_agent(role);
    require!(slot.is_operational(), ExecutionError::Unauthorized);
    require!(signer == &slot.authority, ExecutionError::Unauthorized);
    Ok(())
}

/// Executive signer for break-glass direct execution (DAO may be frozen; agents may be disabled).
fn validate_direct_execute_authority(
    signer: &Pubkey,
    global_config: &Account<NaveGlobalConfig>,
    agent_set: &Account<AgentSet>,
) -> Result<()> {
    require!(!global_config.paused, ExecutionError::GlobalPaused);
    let slot = agent_set.get_agent(AgentRole::Executive);
    require!(slot.is_operational(), ExecutionError::Unauthorized);
    require!(signer == &slot.authority, ExecutionError::Unauthorized);
    Ok(())
}

fn transition_status(
    request: &mut Account<ExecutionRequest>,
    expected: ExecutionStatus,
    next: ExecutionStatus,
) -> Result<()> {
    require!(
        request.status == expected as u8,
        ExecutionError::InvalidStateTransition
    );
    request.status = next as u8;
    request.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}

/// The asset class a protocol accepts. Stables route to lending (Kamino /
/// MarginFi); SOL-like assets route to liquid staking (Jito).
fn required_asset_kind(protocol_program: Pubkey) -> Option<AssetKind> {
    if protocol_program == nave_kamino_adapter::ID
        || protocol_program == nave_marginfi_adapter::ID
        || protocol_program == jupiter_lending_program::ID
    {
        Some(AssetKind::Stable)
    } else if protocol_program == nave_jito_adapter::ID {
        Some(AssetKind::SolLike)
    } else {
        None
    }
}

/// Value `amount` base units of `asset_config`'s mint in micro-USD. Stablecoins
/// are valued at $1. Wrapped SOL uses the pinned Chainlink SOL/USD feed.
/// Other assets use their Pyth feed.
fn value_amount_usd(
    asset_config: &AssetConfig,
    price_ai: &AccountInfo,
    amount: u64,
) -> Result<u64> {
    if asset_config.is_stablecoin {
        return value_stable(amount, asset_config.decimals)
            .map_err(|_| error!(ExecutionError::MathOverflow));
    }
    let clock = Clock::get()?;
    nonstable_micro_usd(
        &asset_config.mint,
        &asset_config.pyth_feed_id,
        asset_config.decimals,
        amount,
        price_ai,
        &clock,
    )
}

/// When deploying a stablecoin, ensure the idle stablecoin remaining in its
/// holding account after this deployment still covers the constitution's
/// `min_stablecoin_reserve_bps` of USD NAV. This is a per-asset enforcement of
/// the reserve floor (sufficient for the common single-stablecoin DAO); the
/// off-chain guardrails aggregate the floor across all stable holdings.
fn enforce_stablecoin_reserve(
    constitution: &TreasuryConstitution,
    treasury_vault: &TreasuryVault,
    asset_config: &AssetConfig,
    idle_after_base: u64,
) -> Result<()> {
    if !asset_config.is_stablecoin || constitution.min_stablecoin_reserve_bps == 0 {
        return Ok(());
    }
    const BPS: u128 = 10_000;
    let reserve_required_usd = (treasury_vault.current_nav as u128)
        .checked_mul(constitution.min_stablecoin_reserve_bps as u128)
        .ok_or(ExecutionError::MathOverflow)?
        .checked_div(BPS)
        .ok_or(ExecutionError::MathOverflow)?;
    let idle_after_usd =
        value_stable(idle_after_base, asset_config.decimals).map_err(|_| error!(ExecutionError::MathOverflow))? as u128;
    require!(
        idle_after_usd >= reserve_required_usd,
        ExecutionError::StablecoinReserveBreached
    );
    Ok(())
}

/// Shared deposit precondition pipeline used by both the normal and break-glass
/// execution paths. Verifies mint consistency, asset_kind↔protocol routing,
/// USD-denominated allocation / deployment / liquidity caps, the stablecoin
/// reserve floor, and the canonical escrow PDA. Returns the micro-USD value of
/// the deployment so it can be threaded into the nave_core accounting CPI.
#[allow(clippy::too_many_arguments)]
fn prepare_strategy_deposit<'info>(
    constitution: &TreasuryConstitution,
    treasury_vault: &TreasuryVault,
    asset_config: &Account<'info, AssetConfig>,
    treasury_asset: &Account<'info, TreasuryAsset>,
    mint: &Account<'info, Mint>,
    vault_token_account: &Account<'info, TokenAccount>,
    strategy_position: &AccountInfo<'info>,
    price_update: &AccountInfo<'info>,
    strategy_escrow: &Account<'info, TokenAccount>,
    dao_key: &Pubkey,
    protocol: Pubkey,
    amount: u64,
) -> Result<u64> {
    require!(asset_config.mint == mint.key(), ExecutionError::AssetMintMismatch);
    require!(treasury_asset.mint == mint.key(), ExecutionError::AssetMintMismatch);

    // NAV-staleness hard block: the USD-denominated allocation / deployment-cap
    // / liquidity-floor / reserve checks below all key off `treasury_vault`'s
    // micro-USD NAV. Refuse to deploy against a NAV that was never computed
    // (`last_revalued_at == 0`) or is older than `NAV_MAX_STALENESS_SECS`, so a
    // stale snapshot can't be used to slip capital past those caps. Shared by
    // both `execute_strategy` and the break-glass `execute_strategy_direct`.
    let now = Clock::get()?.unix_timestamp;
    require!(
        treasury_vault.last_revalued_at > 0
            && now.saturating_sub(treasury_vault.last_revalued_at) <= NAV_MAX_STALENESS_SECS,
        ExecutionError::StaleNav
    );

    // Agent operating-threshold gate (USD, all-asset). The agents may not deploy
    // or swap until the treasury's aggregate NAV (micro-USD, freshly revalued
    // above) reaches the configured floor. 0 disables the gate (legacy/unset).
    if constitution.agent_threshold_usd > 0 {
        require!(
            treasury_vault.current_nav >= constitution.agent_threshold_usd,
            ExecutionError::AgentThresholdNotMet
        );
    }

    let req_kind = required_asset_kind(protocol).ok_or(ExecutionError::UnsupportedAdapter)?;
    require!(
        asset_config.asset_kind == req_kind as u8,
        ExecutionError::AssetKindMismatch
    );

    let amount_usd = value_amount_usd(asset_config, price_update, amount)?;
    let already_deployed_usd =
        value_amount_usd(asset_config, price_update, deployed_to_protocol(strategy_position))?;
    validate_execution_preconditions(
        constitution,
        treasury_vault,
        protocol,
        already_deployed_usd,
        amount_usd,
    )?;

    let idle_after = vault_token_account
        .amount
        .checked_sub(amount)
        .ok_or(ExecutionError::InsufficientVaultBalance)?;
    enforce_stablecoin_reserve(constitution, treasury_vault, asset_config, idle_after)?;

    require_escrow_pda(strategy_escrow, dao_key, protocol, &mint.key())?;
    Ok(amount_usd)
}

/// Jupiter Lend has no nave adapter program: `execute_strategy` escrows the
/// funds and the Oversight agent (`AgentRole::Operational`) supplies them with `nave_core::jupiter_deposit`.
const JUPITER_PROTOCOL_ID: &[u8] = b"jupiter";

fn protocol_id_for_program(program: Pubkey) -> Option<&'static [u8]> {
    if program == nave_kamino_adapter::ID {
        Some(nave_kamino_adapter::KAMINO_PROTOCOL_ID)
    } else if program == nave_jito_adapter::ID {
        Some(nave_jito_adapter::JITO_PROTOCOL_ID)
    } else if program == nave_marginfi_adapter::ID {
        Some(nave_marginfi_adapter::MARGINFI_PROTOCOL_ID)
    } else if program == jupiter_lending_program::ID {
        Some(JUPITER_PROTOCOL_ID)
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
fn finalize_strategy_deposit<'info>(
    nave_core_program: &AccountInfo<'info>,
    execution_authority: &AccountInfo<'info>,
    dao_registry: &Account<'info, DaoRegistry>,
    mint: &AccountInfo<'info>,
    treasury_vault: &Account<'info, TreasuryVault>,
    treasury_asset: &Account<'info, TreasuryAsset>,
    strategy_position: &AccountInfo<'info>,
    instructions: &AccountInfo<'info>,
    vault_authority: &Account<'info, VaultAuthority>,
    vault_token_account: &Account<'info, TokenAccount>,
    strategy_escrow: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    protocol_program: Pubkey,
    amount: u64,
    amount_usd: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let protocol_id = protocol_id_for_program(protocol_program)
        .ok_or(ExecutionError::UnsupportedAdapter)?;
    let protocol_id_str = std::str::from_utf8(protocol_id)
        .map_err(|_| ExecutionError::UnsupportedAdapter)?
        .to_string();
    nave_core::cpi::record_strategy_deposit(
        CpiContext::new_with_signer(
            nave_core_program.clone(),
            nave_core::cpi::accounts::RecordStrategyDeposit {
                execution_authority: execution_authority.clone(),
                dao_registry: dao_registry.to_account_info(),
                mint: mint.clone(),
                treasury_vault: treasury_vault.to_account_info(),
                treasury_asset: treasury_asset.to_account_info(),
                strategy_position: strategy_position.clone(),
                vault_authority: vault_authority.to_account_info(),
                vault_token_account: vault_token_account.to_account_info(),
                strategy_escrow: strategy_escrow.to_account_info(),
                token_program: token_program.to_account_info(),
                instructions: instructions.clone(),
            },
            signer_seeds,
        ),
        protocol_id_str,
        amount,
        amount_usd,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_strategy_withdrawal<'info>(
    nave_core_program: &AccountInfo<'info>,
    execution_authority: &AccountInfo<'info>,
    dao_registry: &Account<'info, DaoRegistry>,
    mint: &AccountInfo<'info>,
    treasury_vault: &Account<'info, TreasuryVault>,
    treasury_asset: &Account<'info, TreasuryAsset>,
    strategy_position: &AccountInfo<'info>,
    instructions: &AccountInfo<'info>,
    vault_authority: &Account<'info, VaultAuthority>,
    vault_token_account: &Account<'info, TokenAccount>,
    strategy_escrow: &Account<'info, TokenAccount>,
    fee_config: &Account<'info, FeeConfig>,
    revenue_token_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    protocol_program: Pubkey,
    amount: u64,
    amount_usd: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let protocol_id = protocol_id_for_program(protocol_program)
        .ok_or(ExecutionError::UnsupportedAdapter)?;
    let protocol_id_str = std::str::from_utf8(protocol_id)
        .map_err(|_| ExecutionError::UnsupportedAdapter)?
        .to_string();
    nave_core::cpi::record_strategy_withdrawal(
        CpiContext::new_with_signer(
            nave_core_program.clone(),
            nave_core::cpi::accounts::RecordStrategyWithdrawal {
                execution_authority: execution_authority.clone(),
                dao_registry: dao_registry.to_account_info(),
                mint: mint.clone(),
                treasury_vault: treasury_vault.to_account_info(),
                treasury_asset: treasury_asset.to_account_info(),
                strategy_position: strategy_position.clone(),
                vault_authority: vault_authority.to_account_info(),
                vault_token_account: vault_token_account.to_account_info(),
                strategy_escrow: strategy_escrow.to_account_info(),
                fee_config: fee_config.to_account_info(),
                revenue_token_account: revenue_token_account.to_account_info(),
                token_program: token_program.to_account_info(),
                instructions: instructions.clone(),
            },
            signer_seeds,
        ),
        amount,
        amount_usd,
        protocol_id_str,
    )
}

/// NE-9: defense-in-depth check that the supplied `strategy_escrow` is the
/// canonical per-protocol escrow PDA owned by nave_core. The adapter CPI also
/// enforces this via seeds, but constraining it here prevents routing a deposit
/// or withdrawal through an attacker-substituted token account.
fn require_escrow_pda(
    strategy_escrow: &Account<TokenAccount>,
    dao_key: &Pubkey,
    protocol_program: Pubkey,
    mint: &Pubkey,
) -> Result<()> {
    let protocol_id =
        protocol_id_for_program(protocol_program).ok_or(ExecutionError::UnsupportedAdapter)?;
    let (expected, _bump) = Pubkey::find_program_address(
        &[STRATEGY_ESCROW_SEED, dao_key.as_ref(), protocol_id, mint.as_ref()],
        &nave_core::ID,
    );
    require!(
        strategy_escrow.key() == expected,
        ExecutionError::EscrowAccountMismatch
    );
    Ok(())
}

fn validate_execution_preconditions(
    constitution: &TreasuryConstitution,
    treasury_vault: &TreasuryVault,
    program_id: Pubkey,
    already_deployed: u64,
    amount: u64,
) -> Result<()> {
    require!(
        constitution.is_protocol_approved(&program_id),
        ExecutionError::ProtocolNotApproved
    );
    require!(amount > 0, ExecutionError::AllocationLimitExceeded);
    enforce_allocation_cap(constitution, treasury_vault, &program_id, already_deployed, amount)
        .map_err(|_| ExecutionError::AllocationLimitExceeded)?;
    enforce_constitution_global_limits(constitution, treasury_vault, amount)?;
    Ok(())
}

/// Enforce the constitution's continuous-policy global deployment cap and
/// liquidity floor against the vault's *global* deployed capital (not the
/// per-protocol position). Mirrors `nave_core::utils::enforce_global_deployment_limits`
/// but maps to distinct `ExecutionError`s for precise on-chain diagnostics.
///
/// A `0` value for either bps disables that ceiling (legacy constitution
/// accounts created before these fields existed remain safe).
fn enforce_constitution_global_limits(
    constitution: &TreasuryConstitution,
    treasury_vault: &TreasuryVault,
    amount: u64,
) -> Result<()> {
    const BPS: u128 = 10_000;
    let nav = treasury_vault.current_nav as u128;
    let projected = (treasury_vault.deployed_capital as u128)
        .checked_add(amount as u128)
        .ok_or(ExecutionError::MathOverflow)?;

    if constitution.max_total_deployed_bps > 0 {
        let cap = nav
            .checked_mul(constitution.max_total_deployed_bps as u128)
            .ok_or(ExecutionError::MathOverflow)?
            .checked_div(BPS)
            .ok_or(ExecutionError::MathOverflow)?;
        require!(projected <= cap, ExecutionError::DeploymentCapExceeded);
    }

    if constitution.min_liquidity_bps > 0 {
        let deployable_bps = 10_000u16.saturating_sub(constitution.min_liquidity_bps);
        let max_deployable = nav
            .checked_mul(deployable_bps as u128)
            .ok_or(ExecutionError::MathOverflow)?
            .checked_div(BPS)
            .ok_or(ExecutionError::MathOverflow)?;
        require!(
            projected <= max_deployable,
            ExecutionError::LiquidityFloorBreached
        );
    }

    Ok(())
}

/// Read the amount currently deployed to this protocol from the strategy
/// position PDA (owned by nave_core). Returns 0 if the position is not yet
/// initialized.
fn deployed_to_protocol(strategy_position: &AccountInfo) -> u64 {
    // Only trust positions owned by nave_core; deserialize defensively.
    if strategy_position.owner != &nave_core::ID {
        return 0;
    }
    let data = match strategy_position.try_borrow_data() {
        Ok(d) => d,
        Err(_) => return 0,
    };
    nave_core::state::StrategyPosition::try_deserialize(&mut &data[..])
        .map(|sp| sp.current_value)
        .unwrap_or(0)
}

/// Read `(deposited_amount, current_value)` (base-unit principal and marked
/// value) from the nave_core-owned strategy position PDA, deserializing
/// defensively. Returns `(0, 0)` if the account is missing/foreign/undecodable
/// — which collapses the revised NE-8 cap back to the deployed principal, the
/// conservative (no-gain) bound. Used to size the realized-yield withdrawal cap.
fn read_position_marks(strategy_position: &AccountInfo) -> (u64, u64) {
    if strategy_position.owner != &nave_core::ID {
        return (0, 0);
    }
    let data = match strategy_position.try_borrow_data() {
        Ok(d) => d,
        Err(_) => return (0, 0),
    };
    nave_core::state::StrategyPosition::try_deserialize(&mut &data[..])
        .map(|sp| (sp.deposited_amount, sp.current_value))
        .unwrap_or((0, 0))
}

#[allow(clippy::too_many_arguments)]
fn cpi_adapter_deposit<'info>(
    protocol_program: Pubkey,
    amount: u64,
    adapter_program: &AccountInfo<'info>,
    execution_authority: &AccountInfo<'info>,
    dao_registry: &Account<'info, DaoRegistry>,
    vault_authority: &Account<'info, VaultAuthority>,
    treasury_vault: &Account<'info, TreasuryVault>,
    vault_token_account: &Account<'info, TokenAccount>,
    strategy_escrow: &Account<'info, TokenAccount>,
    strategy_position: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    payer: &Signer<'info>,
    token_program: &Program<'info, Token>,
    system_program: &Program<'info, System>,
    instructions: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if protocol_program == jupiter_lending_program::ID {
        require!(
            adapter_program.key() == jupiter_lending_program::ID,
            ExecutionError::UnsupportedAdapter
        );
        require!(amount > 0, ExecutionError::MathOverflow);
        require!(vault_token_account.amount >= amount, ExecutionError::InsufficientVaultBalance);
        require!(
            strategy_escrow.owner == vault_authority.key()
                && strategy_escrow.mint == vault_token_account.mint
                && strategy_escrow.key() != vault_token_account.key(),
            ExecutionError::EscrowAccountMismatch
        );
        let _ = (execution_authority, dao_registry, treasury_vault, strategy_position, mint);
        let _ = (payer, token_program, system_program, instructions, signer_seeds);
        return Ok(());
    }
    if protocol_program == nave_kamino_adapter::ID {
        require!(
            adapter_program.key() == nave_kamino_adapter::ID,
            ExecutionError::UnsupportedAdapter
        );
        nave_kamino_adapter::cpi::deposit_to_kamino(
            CpiContext::new_with_signer(
                adapter_program.clone(),
                nave_kamino_adapter::cpi::accounts::DepositToKamino {
                    execution_authority: execution_authority.clone(),
                    dao_registry: dao_registry.to_account_info(),
                    vault_authority: vault_authority.to_account_info(),
                    treasury_vault: treasury_vault.to_account_info(),
                    vault_token_account: vault_token_account.to_account_info(),
                    strategy_escrow: strategy_escrow.to_account_info(),
                    strategy_position: strategy_position.to_account_info(),
                    mint: mint.clone(),
                    payer: payer.to_account_info(),
                    token_program: token_program.to_account_info(),
                    system_program: system_program.to_account_info(),
                    instructions: instructions.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    } else if protocol_program == nave_jito_adapter::ID {
        require!(
            adapter_program.key() == nave_jito_adapter::ID,
            ExecutionError::UnsupportedAdapter
        );
        nave_jito_adapter::cpi::deposit_to_jito(
            CpiContext::new_with_signer(
                adapter_program.clone(),
                nave_jito_adapter::cpi::accounts::DepositToJito {
                    execution_authority: execution_authority.clone(),
                    dao_registry: dao_registry.to_account_info(),
                    vault_authority: vault_authority.to_account_info(),
                    treasury_vault: treasury_vault.to_account_info(),
                    vault_token_account: vault_token_account.to_account_info(),
                    strategy_escrow: strategy_escrow.to_account_info(),
                    strategy_position: strategy_position.to_account_info(),
                    mint: mint.clone(),
                    payer: payer.to_account_info(),
                    token_program: token_program.to_account_info(),
                    system_program: system_program.to_account_info(),
                    instructions: instructions.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    } else if protocol_program == nave_marginfi_adapter::ID {
        require!(
            adapter_program.key() == nave_marginfi_adapter::ID,
            ExecutionError::UnsupportedAdapter
        );
        nave_marginfi_adapter::cpi::deposit_to_marginfi(
            CpiContext::new_with_signer(
                adapter_program.clone(),
                nave_marginfi_adapter::cpi::accounts::DepositToMarginfi {
                    execution_authority: execution_authority.clone(),
                    dao_registry: dao_registry.to_account_info(),
                    vault_authority: vault_authority.to_account_info(),
                    treasury_vault: treasury_vault.to_account_info(),
                    vault_token_account: vault_token_account.to_account_info(),
                    strategy_escrow: strategy_escrow.to_account_info(),
                    strategy_position: strategy_position.to_account_info(),
                    mint: mint.clone(),
                    payer: payer.to_account_info(),
                    token_program: token_program.to_account_info(),
                    system_program: system_program.to_account_info(),
                    instructions: instructions.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    } else {
        return err!(ExecutionError::UnsupportedAdapter);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cpi_adapter_withdraw<'info>(
    protocol_program: Pubkey,
    amount: u64,
    adapter_program: &AccountInfo<'info>,
    execution_authority: &AccountInfo<'info>,
    dao_registry: &Account<'info, DaoRegistry>,
    vault_authority: &Account<'info, VaultAuthority>,
    treasury_vault: &Account<'info, TreasuryVault>,
    vault_token_account: &Account<'info, TokenAccount>,
    strategy_escrow: &Account<'info, TokenAccount>,
    strategy_position: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    instructions: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if protocol_program == jupiter_lending_program::ID {
        require!(
            adapter_program.key() == jupiter_lending_program::ID,
            ExecutionError::UnsupportedAdapter
        );
        require!(amount > 0, ExecutionError::MathOverflow);
        require!(
            strategy_escrow.owner == vault_authority.key()
                && strategy_escrow.mint == vault_token_account.mint
                && strategy_escrow.amount >= amount,
            ExecutionError::EscrowAccountMismatch
        );
        let _ = (execution_authority, dao_registry, treasury_vault, strategy_position, mint);
        let _ = (token_program, instructions, signer_seeds);
        return Ok(());
    }
    if protocol_program == nave_kamino_adapter::ID {
        require!(
            adapter_program.key() == nave_kamino_adapter::ID,
            ExecutionError::UnsupportedAdapter
        );
        nave_kamino_adapter::cpi::withdraw_from_kamino(
            CpiContext::new_with_signer(
                adapter_program.clone(),
                nave_kamino_adapter::cpi::accounts::WithdrawFromKamino {
                    execution_authority: execution_authority.clone(),
                    dao_registry: dao_registry.to_account_info(),
                    vault_authority: vault_authority.to_account_info(),
                    treasury_vault: treasury_vault.to_account_info(),
                    vault_token_account: vault_token_account.to_account_info(),
                    strategy_escrow: strategy_escrow.to_account_info(),
                    strategy_position: strategy_position.to_account_info(),
                    mint: mint.clone(),
                    token_program: token_program.to_account_info(),
                    instructions: instructions.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    } else if protocol_program == nave_jito_adapter::ID {
        require!(
            adapter_program.key() == nave_jito_adapter::ID,
            ExecutionError::UnsupportedAdapter
        );
        nave_jito_adapter::cpi::withdraw_from_jito(
            CpiContext::new_with_signer(
                adapter_program.clone(),
                nave_jito_adapter::cpi::accounts::WithdrawFromJito {
                    execution_authority: execution_authority.clone(),
                    dao_registry: dao_registry.to_account_info(),
                    vault_authority: vault_authority.to_account_info(),
                    treasury_vault: treasury_vault.to_account_info(),
                    vault_token_account: vault_token_account.to_account_info(),
                    strategy_escrow: strategy_escrow.to_account_info(),
                    strategy_position: strategy_position.to_account_info(),
                    mint: mint.clone(),
                    token_program: token_program.to_account_info(),
                    instructions: instructions.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    } else if protocol_program == nave_marginfi_adapter::ID {
        require!(
            adapter_program.key() == nave_marginfi_adapter::ID,
            ExecutionError::UnsupportedAdapter
        );
        nave_marginfi_adapter::cpi::withdraw_from_marginfi(
            CpiContext::new_with_signer(
                adapter_program.clone(),
                nave_marginfi_adapter::cpi::accounts::WithdrawFromMarginfi {
                    execution_authority: execution_authority.clone(),
                    dao_registry: dao_registry.to_account_info(),
                    vault_authority: vault_authority.to_account_info(),
                    treasury_vault: treasury_vault.to_account_info(),
                    vault_token_account: vault_token_account.to_account_info(),
                    strategy_escrow: strategy_escrow.to_account_info(),
                    strategy_position: strategy_position.to_account_info(),
                    mint: mint.clone(),
                    token_program: token_program.to_account_info(),
                    instructions: instructions.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    } else {
        return err!(ExecutionError::UnsupportedAdapter);
    }
    Ok(())
}

#[derive(Accounts)]
pub struct CreateExecutionRequest<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    // Mutable: the bootstrap path flips `dao_registry.bootstrap_used` via the
    // nave_core `record_bootstrap_usage` CPI. Non-bootstrap requests do not
    // mutate it.
    #[account(
        mut,
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    /// CHECK: nave_core `DaoLifecycle` PDA (moonlight state). Address pinned by
    /// seeds; may be uninitialized (never moonlighted) — validated in handler.
    #[account(
        seeds = [DAO_LIFECYCLE_SEED, dao_registry.key().as_ref()],
        bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_lifecycle: UncheckedAccount<'info>,

    #[account(
        constraint = proposal.dao == dao_registry.key() @ ExecutionError::ProposalDaoMismatch
    )]
    pub proposal: Box<Account<'info, ReadableProposal>>,

    #[account(
        seeds = [nave_core::constants::CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        seeds::program = nave_core::ID,
    )]
    pub constitution: Box<Account<'info, TreasuryConstitution>>,

    #[account(
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        seeds::program = nave_core::ID,
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    #[account(
        init,
        payer = creator,
        space = ExecutionRequest::LEN,
        seeds = [EXECUTION_REQUEST_SEED, proposal.key().as_ref()],
        bump
    )]
    pub execution_request: Box<Account<'info, ExecutionRequest>>,

    /// CHECK: nave_core program, target of the bootstrap-latch CPI. Address
    /// pinned to nave_core::ID. Required for `bootstrap = true`; pass for all
    /// calls (ignored when `bootstrap = false`).
    #[account(address = nave_core::ID)]
    pub nave_core_program: UncheckedAccount<'info>,

    /// CHECK: This execution program id, forwarded to the nave_core CPI for
    /// caller verification (mirrors the governance `record_proposal_creation`
    /// pattern). Address pinned to crate::ID.
    #[account(address = crate::ID)]
    pub execution_program: UncheckedAccount<'info>,

    /// CHECK: instructions sysvar, forwarded into the `record_bootstrap_usage`
    /// CPI so nave_core can verify (SEC-M4) that nave_execution is the top-level
    /// caller. Required for all calls; only consumed on the bootstrap path.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecutiveApprove<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(mut, constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized)]
    pub execution_request: Account<'info, ExecutionRequest>,
}

#[derive(Accounts)]
pub struct FinancialApprove<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(mut, constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized)]
    pub execution_request: Account<'info, ExecutionRequest>,
}

#[derive(Accounts)]
pub struct OversightApprove<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(mut, constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized)]
    pub execution_request: Account<'info, ExecutionRequest>,
}

#[derive(Accounts)]
pub struct OperationalHalt<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(mut, constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized)]
    pub execution_request: Account<'info, ExecutionRequest>,
}

#[derive(Accounts)]
pub struct OperationalClear<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(mut, constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized)]
    pub execution_request: Account<'info, ExecutionRequest>,
}

#[derive(Accounts)]
pub struct ExpireRequest<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(mut, constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized)]
    pub execution_request: Account<'info, ExecutionRequest>,
}

#[derive(Accounts)]
pub struct ExecuteStrategy<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    /// CHECK: nave_core `DaoLifecycle` PDA (moonlight state). Address pinned by
    /// seeds; may be uninitialized (never moonlighted) — validated in handler.
    #[account(
        seeds = [DAO_LIFECYCLE_SEED, dao_registry.key().as_ref()],
        bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_lifecycle: UncheckedAccount<'info>,

    #[account(
        seeds = [nave_core::constants::CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        seeds::program = nave_core::ID,
    )]
    pub constitution: Box<Account<'info, TreasuryConstitution>>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        seeds::program = nave_core::ID,
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        seeds::program = nave_core::ID,
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    /// Asset mint being deployed/withdrawn; keys the per-asset accounts.
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = asset_config.bump,
        seeds::program = nave_core::ID,
        constraint = asset_config.dao == dao_registry.key() @ ExecutionError::Unauthorized,
    )]
    pub asset_config: Box<Account<'info, AssetConfig>>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        seeds::program = nave_core::ID,
        constraint = treasury_asset.dao == dao_registry.key() @ ExecutionError::Unauthorized,
    )]
    pub treasury_asset: Box<Account<'info, TreasuryAsset>>,

    /// CHECK: Pyth PriceUpdateV2 for the asset; owner + staleness + feed-id
    /// verified in the handler. Ignored for stablecoins (pass any account).
    pub price_update: AccountInfo<'info>,

    #[account(
        mut,
        constraint = vault_token_account.key() == treasury_asset.token_account @ ExecutionError::InsufficientVaultBalance
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA signer for adapter CPI authorization.
    #[account(
        seeds = [EXECUTION_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub execution_authority: AccountInfo<'info>,

    /// CHECK: Must match execution request protocol program id.
    pub adapter_program: AccountInfo<'info>,

    #[account(
        mut,
        constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized
    )]
    pub execution_request: Box<Account<'info, ExecutionRequest>>,

    #[account(mut)]
    pub strategy_escrow: Box<Account<'info, TokenAccount>>,

    /// CHECK: Adapter-owned strategy position PDA; validated in adapter CPI.
    #[account(mut)]
    pub strategy_position: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: Instructions sysvar for adapter CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,

    /// CHECK: nave_core program for accounting CPI.
    #[account(address = nave_core::ID)]
    pub nave_core_program: AccountInfo<'info>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,
}

#[derive(Accounts)]
pub struct ExecuteStrategyDirect<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    /// CHECK: nave_core `DaoLifecycle` PDA (moonlight state). Address pinned by
    /// seeds; may be uninitialized (never moonlighted) — validated in handler.
    #[account(
        seeds = [DAO_LIFECYCLE_SEED, dao_registry.key().as_ref()],
        bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_lifecycle: UncheckedAccount<'info>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,

    #[account(
        seeds = [nave_core::constants::CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        seeds::program = nave_core::ID,
    )]
    pub constitution: Box<Account<'info, TreasuryConstitution>>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        seeds::program = nave_core::ID,
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        seeds::program = nave_core::ID,
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    /// Asset mint being deployed; keys the per-asset accounts.
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = asset_config.bump,
        seeds::program = nave_core::ID,
        constraint = asset_config.dao == dao_registry.key() @ ExecutionError::Unauthorized,
    )]
    pub asset_config: Box<Account<'info, AssetConfig>>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        seeds::program = nave_core::ID,
        constraint = treasury_asset.dao == dao_registry.key() @ ExecutionError::Unauthorized,
    )]
    pub treasury_asset: Box<Account<'info, TreasuryAsset>>,

    /// CHECK: Pyth PriceUpdateV2 for the asset; verified in the handler.
    pub price_update: AccountInfo<'info>,

    #[account(
        mut,
        constraint = vault_token_account.key() == treasury_asset.token_account @ ExecutionError::InsufficientVaultBalance
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA signer for adapter CPI authorization.
    #[account(
        seeds = [EXECUTION_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub execution_authority: AccountInfo<'info>,

    /// CHECK: Must match execution request protocol program id.
    pub adapter_program: AccountInfo<'info>,

    #[account(mut, constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized)]
    pub execution_request: Account<'info, ExecutionRequest>,

    #[account(mut)]
    pub strategy_escrow: Account<'info, TokenAccount>,

    /// CHECK: Adapter-owned strategy position PDA; validated in adapter CPI.
    #[account(mut)]
    pub strategy_position: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: Instructions sysvar for adapter CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,

    /// CHECK: nave_core program for accounting CPI.
    #[account(address = nave_core::ID)]
    pub nave_core_program: AccountInfo<'info>,

    /// CHECK: nave_core `DaoControl` PDA; may be uninitialized (reads as not
    /// guardian-locked). Owner checked by `DaoControl::is_guardian_locked`.
    #[account(
        seeds = [DAO_CONTROL_SEED, dao_registry.key().as_ref()],
        bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_control: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawFromStrategy<'info> {
    pub executor: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        seeds = [nave_core::constants::AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        seeds::program = nave_core::ID,
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        seeds::program = nave_core::ID,
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        seeds::program = nave_core::ID,
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    /// Asset mint being deployed/withdrawn; keys the per-asset accounts.
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = asset_config.bump,
        seeds::program = nave_core::ID,
        constraint = asset_config.dao == dao_registry.key() @ ExecutionError::Unauthorized,
    )]
    pub asset_config: Box<Account<'info, AssetConfig>>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        seeds::program = nave_core::ID,
        constraint = treasury_asset.dao == dao_registry.key() @ ExecutionError::Unauthorized,
    )]
    pub treasury_asset: Box<Account<'info, TreasuryAsset>>,

    /// CHECK: Pyth PriceUpdateV2 for the asset; owner + staleness + feed-id
    /// verified in the handler. Ignored for stablecoins (pass any account).
    pub price_update: AccountInfo<'info>,

    #[account(
        mut,
        constraint = vault_token_account.key() == treasury_asset.token_account @ ExecutionError::InsufficientVaultBalance
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA signer for adapter CPI authorization.
    #[account(
        seeds = [EXECUTION_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub execution_authority: AccountInfo<'info>,

    /// CHECK: Must match execution request protocol program id.
    pub adapter_program: AccountInfo<'info>,

    #[account(
        mut,
        constraint = execution_request.dao == dao_registry.key() @ ExecutionError::Unauthorized
    )]
    pub execution_request: Box<Account<'info, ExecutionRequest>>,

    #[account(mut)]
    pub strategy_escrow: Box<Account<'info, TokenAccount>>,

    /// CHECK: Adapter-owned strategy position PDA; validated in adapter CPI.
    #[account(mut)]
    pub strategy_position: AccountInfo<'info>,

    /// Fee configuration (nave_core) — forwarded writable to
    /// `record_strategy_withdrawal` so the 15% performance-fee skim can correct
    /// a stale stored rate after it is taken on the realized yield.
    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = fee_config.bump,
        seeds::program = nave_core::ID,
        constraint = fee_config.dao == dao_registry.key() @ ExecutionError::Unauthorized,
    )]
    pub fee_config: Box<Account<'info, FeeConfig>>,

    /// Destination for the performance-fee skim: a token account owned by the
    /// configured protocol revenue wallet, for the withdrawn mint. Validated
    /// fully in nave_core; mint-checked here for early failure.
    #[account(
        mut,
        constraint = revenue_token_account.owner == fee_config.protocol_revenue_wallet @ ExecutionError::Unauthorized,
        constraint = revenue_token_account.mint == mint.key() @ ExecutionError::AssetMintMismatch
    )]
    pub revenue_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Instructions sysvar for adapter CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,

    /// CHECK: nave_core program for accounting CPI.
    #[account(address = nave_core::ID)]
    pub nave_core_program: AccountInfo<'info>,
}
