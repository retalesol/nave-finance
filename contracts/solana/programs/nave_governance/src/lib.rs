use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_program::hash::hash;
use solana_program::pubkey::Pubkey;

pub mod constants;
pub mod errors;
pub mod events;
pub mod state;

use nave_core::{
    constants::{
        ASSET_CONFIG_SEED, ASSET_VAULT_SEED, GovernanceType, GLOBAL_CONFIG_SEED,
        GUARDIAN_CONFIG_SEED, NFT_VAULT_RECORD_SEED, NFT_VAULT_SEED, TREASURY_ASSET_SEED,
        TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED,
    },
    state::{
        AssetConfig, DaoRegistry, GuardianConfig, NaveGlobalConfig, NftVaultRecord, TokenRegistry,
        TreasuryAsset, TreasuryVault, VaultAuthority,
    },
};

use crate::constants::{
    ProposalStatus, ProposalType, VoteChoice, VoteMethod, MAX_PROPOSALS_PER_DAO,
    MAX_VOTING_PERIOD_SECONDS, PROPOSAL_SEED, TOKEN_GENESIS_SEED, VOTE_ESCROW_SEED, VOTE_RECORD_SEED,
};
use crate::errors::GovernanceError;
use crate::events::*;
use crate::state::{Proposal, TokenGenesisRecord, VoteEscrow, VoteRecord};

declare_id!("CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M");

const DEFAULT_VOTING_PERIOD: i64 = 604_800;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateProposalParams {
    pub title: String,
    pub description: String,
    pub payload: Vec<u8>,
    pub proposal_type: u8,
    pub voting_period_seconds: i64,
}

#[program]
pub mod nave_governance {
    use super::*;

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        params: CreateProposalParams,
    ) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
        require!(!ctx.accounts.dao_registry.frozen, GovernanceError::DaoFrozen);
        require!(
            ctx.accounts.dao_registry.proposal_count < MAX_PROPOSALS_PER_DAO,
            GovernanceError::MaxProposalsReached
        );
        require!(
            ProposalType::from_u8(params.proposal_type).is_some(),
            GovernanceError::InvalidProposalType
        );
        require!(params.voting_period_seconds > 0, GovernanceError::InvalidVotingPeriod);
        require!(
            params.voting_period_seconds <= MAX_VOTING_PERIOD_SECONDS,
            GovernanceError::InvalidVotingPeriod
        );

        // Token-weighted DAOs snapshot the registered governance token's supply and
        // require the supplied mint to be registered. Wallet-governed DAOs vote 1-per
        // -guardian and never register a token, so the mint/registry checks do not
        // apply — gate them on governance_type instead of requiring them for everyone.
        let is_token_gov =
            ctx.accounts.dao_registry.governance_type == GovernanceType::Token as u8;
        if is_token_gov {
            require!(
                ctx.accounts.token_registry
                    .find_token_index(&ctx.accounts.dao_token_mint.key())
                    .is_some(),
                GovernanceError::TokenMintNotRegistered
            );
            // The proposal's voting mint is pinned to the DAO's designated
            // `voting_token` (set by nave_core at token registration / on
            // `switch_voting_system`), not to whatever registered mint the
            // proposer chose. Any other mint would let a proposer pick a
            // low-supply registered token to trivialise quorum, and the mint
            // snapshotted here is what `lock_tokens_and_vote` enforces below.
            let voting_token = ctx.accounts.dao_registry.voting_token;
            require!(
                voting_token != Pubkey::default(),
                GovernanceError::TokenMintNotRegistered
            );
            require!(
                ctx.accounts.dao_token_mint.key() == voting_token,
                GovernanceError::VotingMintMismatch
            );
            // A zero supply falls through to the guardian count at finalize,
            // so a handful of tokens minted afterward can pass a transfer.
            require!(ctx.accounts.dao_token_mint.supply > 0, GovernanceError::ZeroVotingSupply);
        }

        // Use the DAO's monotonic `next_proposal_index` (never decremented by
        // archiving) for both the PDA seed and the stored index, so an archived
        // proposal's slot can never collide with a new one. The
        // `MAX_PROPOSALS_PER_DAO` limit above is checked against the active
        // `proposal_count` (which archiving DOES decrement).
        let proposal_index = ctx.accounts.dao_registry.next_proposal_index;
        let clock = Clock::get()?;
        let mint = &ctx.accounts.dao_token_mint;

        let proposal = &mut ctx.accounts.proposal;
        proposal.bump = ctx.bumps.proposal;
        proposal.dao = ctx.accounts.dao_registry.key();
        proposal.proposal_index = proposal_index;
        proposal.proposer = ctx.accounts.proposer.key();
        proposal.proposal_type = params.proposal_type;
        proposal.status = ProposalStatus::Active as u8;
        proposal.set_title(params.title.as_bytes())?;
        proposal.set_description(params.description.as_bytes())?;
        proposal.set_payload(&params.payload)?;
        proposal.payload_hash = hash(&params.payload).to_bytes();
        proposal.snapshot_slot = clock.slot;
        // Only meaningful for token-weighted quorum; wallet votes are counted 1-each.
        proposal.snapshot_supply = if is_token_gov { mint.supply } else { 0 };
        proposal.votes_for = 0;
        proposal.votes_against = 0;
        proposal.votes_abstain = 0;
        proposal.voting_end = clock
            .unix_timestamp
            .checked_add(params.voting_period_seconds)
            .ok_or(GovernanceError::MathOverflow)?;
        proposal.created_at = clock.unix_timestamp;
        proposal.finalized_at = 0;
        // Persist the voting mint so every token vote on this proposal is bound
        // to it (wallet-governed DAOs never lock tokens: default/zero).
        proposal.token_mint = if is_token_gov { mint.key() } else { Pubkey::default() };

        nave_core::cpi::record_proposal_creation(
            CpiContext::new(
                ctx.accounts.nave_core_program.to_account_info(),
                nave_core::cpi::accounts::RecordProposalCreation {
                    dao_registry: ctx.accounts.dao_registry.to_account_info(),
                    governance_program: ctx.accounts.governance_program.to_account_info(),
                    instructions: ctx.accounts.instructions.to_account_info(),
                },
            ),
        )?;

        emit!(ProposalCreated {
            dao: ctx.accounts.dao_registry.key(),
            proposal: proposal.key(),
            proposal_index,
            proposal_type: params.proposal_type,
            snapshot_slot: proposal.snapshot_slot,
            snapshot_supply: proposal.snapshot_supply,
        });

        Ok(())
    }

    pub fn cast_vote_wallet(ctx: Context<CastVoteWallet>, choice: u8) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
        require!(
            ctx.accounts.dao_registry.governance_type == GovernanceType::Wallet as u8,
            GovernanceError::WrongGovernanceMode
        );
        require!(VoteChoice::from_u8(choice).is_some(), GovernanceError::InvalidVoteChoice);
        require!(ctx.accounts.proposal.is_active(), GovernanceError::ProposalNotActive);
        require!(
            Clock::get()?.unix_timestamp <= ctx.accounts.proposal.voting_end,
            GovernanceError::VotingPeriodEnded
        );
        require!(
            ctx.accounts.guardian_config.is_guardian(&ctx.accounts.voter.key()),
            GovernanceError::GuardianRequired
        );

        let vote_record = &mut ctx.accounts.vote_record;
        vote_record.bump = ctx.bumps.vote_record;
        vote_record.proposal = ctx.accounts.proposal.key();
        vote_record.voter = ctx.accounts.voter.key();
        vote_record.choice = choice;
        vote_record.method = VoteMethod::Wallet as u8;
        vote_record.weight = 1;
        vote_record.voted_at = Clock::get()?.unix_timestamp;

        apply_vote_weight(&mut ctx.accounts.proposal, choice, 1)?;

        emit!(VoteCast {
            proposal: ctx.accounts.proposal.key(),
            voter: ctx.accounts.voter.key(),
            choice,
            method: VoteMethod::Wallet as u8,
            weight: 1,
        });

        Ok(())
    }

    pub fn lock_tokens_and_vote(
        ctx: Context<LockTokensAndVote>,
        amount: u64,
        choice: u8,
    ) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
        require!(
            ctx.accounts.dao_registry.governance_type == GovernanceType::Token as u8,
            GovernanceError::WrongGovernanceMode
        );
        require!(amount > 0, GovernanceError::MathOverflow);
        require!(VoteChoice::from_u8(choice).is_some(), GovernanceError::InvalidVoteChoice);
        require!(ctx.accounts.proposal.is_active(), GovernanceError::ProposalNotActive);
        require!(
            Clock::get()?.unix_timestamp <= ctx.accounts.proposal.voting_end,
            GovernanceError::VotingPeriodEnded
        );
        // The voting mint is the one snapshotted on the proposal at creation
        // (also enforced as an account constraint on `dao_token_mint`); the
        // escrow/voter token accounts below are then bound to that same mint,
        // so weight can only be bought with the DAO's real governance token.
        require!(
            ctx.accounts.proposal.token_mint != Pubkey::default()
                && ctx.accounts.dao_token_mint.key() == ctx.accounts.proposal.token_mint,
            GovernanceError::VotingMintMismatch
        );
        require!(
            ctx.accounts.escrow_token_account.mint == ctx.accounts.dao_token_mint.key(),
            GovernanceError::DaoOwnershipMismatch
        );
        require!(
            ctx.accounts.escrow_token_account.owner == ctx.accounts.vote_escrow.key(),
            GovernanceError::Unauthorized
        );
        require!(
            ctx.accounts.voter_token_account.mint == ctx.accounts.dao_token_mint.key(),
            GovernanceError::Unauthorized
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.voter_token_account.to_account_info(),
                    to: ctx.accounts.escrow_token_account.to_account_info(),
                    authority: ctx.accounts.voter.to_account_info(),
                },
            ),
            amount,
        )?;

        let vote_escrow = &mut ctx.accounts.vote_escrow;
        vote_escrow.bump = ctx.bumps.vote_escrow;
        vote_escrow.proposal = ctx.accounts.proposal.key();
        vote_escrow.voter = ctx.accounts.voter.key();
        vote_escrow.mint = ctx.accounts.dao_token_mint.key();
        vote_escrow.escrow_token_account = ctx.accounts.escrow_token_account.key();
        vote_escrow.locked_amount = amount;
        vote_escrow.released = false;
        vote_escrow.locked_at = Clock::get()?.unix_timestamp;
        vote_escrow.released_at = 0;

        let vote_record = &mut ctx.accounts.vote_record;
        vote_record.bump = ctx.bumps.vote_record;
        vote_record.proposal = ctx.accounts.proposal.key();
        vote_record.voter = ctx.accounts.voter.key();
        vote_record.choice = choice;
        vote_record.method = VoteMethod::Escrow as u8;
        vote_record.weight = amount;
        vote_record.voted_at = Clock::get()?.unix_timestamp;

        apply_vote_weight(&mut ctx.accounts.proposal, choice, amount)?;

        emit!(VoteEscrowLocked {
            proposal: ctx.accounts.proposal.key(),
            voter: ctx.accounts.voter.key(),
            amount,
        });

        emit!(VoteCast {
            proposal: ctx.accounts.proposal.key(),
            voter: ctx.accounts.voter.key(),
            choice,
            method: VoteMethod::Escrow as u8,
            weight: amount,
        });

        Ok(())
    }

    pub fn release_vote_escrow(ctx: Context<ReleaseVoteEscrow>) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
        require!(
            ctx.accounts.proposal.status != ProposalStatus::Active as u8,
            GovernanceError::EscrowStillLocked
        );
        require!(!ctx.accounts.vote_escrow.released, GovernanceError::EscrowNotLocked);

        require!(
            ctx.accounts.escrow_token_account.key() == ctx.accounts.vote_escrow.escrow_token_account,
            GovernanceError::Unauthorized
        );
        require!(
            ctx.accounts.voter_token_account.mint == ctx.accounts.escrow_token_account.mint,
            GovernanceError::Unauthorized
        );

        let amount = ctx.accounts.vote_escrow.locked_amount;
        let proposal_key = ctx.accounts.proposal.key();
        let voter_key = ctx.accounts.voter.key();
        let bump = ctx.accounts.vote_escrow.bump;
        let seeds = &[
            VOTE_ESCROW_SEED,
            proposal_key.as_ref(),
            voter_key.as_ref(),
            &[bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_token_account.to_account_info(),
                    to: ctx.accounts.voter_token_account.to_account_info(),
                    authority: ctx.accounts.vote_escrow.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount,
        )?;

        let vote_escrow = &mut ctx.accounts.vote_escrow;
        vote_escrow.released = true;
        vote_escrow.released_at = Clock::get()?.unix_timestamp;

        emit!(VoteEscrowReleased {
            proposal: ctx.accounts.proposal.key(),
            voter: ctx.accounts.voter.key(),
            amount,
        });

        Ok(())
    }

    pub fn finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
        // Finalizing is a read-only tally operation — it is permitted even when the
        // protocol is globally paused so that in-flight proposals can be concluded.
        require!(ctx.accounts.proposal.is_active(), GovernanceError::ProposalNotActive);

        // Read all immutable proposal fields before taking the mutable borrow.
        let now = Clock::get()?.unix_timestamp;
        let voting_closed = now > ctx.accounts.proposal.voting_end;
        let snapshot_supply = ctx.accounts.proposal.snapshot_supply;
        let votes_for = ctx.accounts.proposal.votes_for;
        let votes_against = ctx.accounts.proposal.votes_against;
        let proposal_type = ctx.accounts.proposal.proposal_type;

        let total_votes = votes_for
            .checked_add(votes_against)
            .ok_or(GovernanceError::MathOverflow)?;

        // Per-proposal-type quorum: token mint requires 25%, switching the voting
        // system requires 70%, everything else uses the DAO's configured quorum.
        let quorum_bps = ProposalType::from_u8(proposal_type)
            .ok_or(GovernanceError::InvalidProposalType)?
            .quorum_bps(ctx.accounts.dao_registry.quorum_bps);

        // Eligible voter total:
        //   • Token governance: snapshot_supply (token supply at proposal creation).
        //   • Wallet governance: snapshot_supply == 0, so use the current guardian
        //     count from guardian_config instead. This ensures the early-finalization
        //     math is always based on real eligible voter counts.
        let eligible_total: u64 = if snapshot_supply > 0 {
            snapshot_supply
        } else {
            ctx.accounts.guardian_config.wallet_count as u64
        };

        let required = (eligible_total as u128)
            .checked_mul(quorum_bps as u128)
            .ok_or(GovernanceError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(GovernanceError::MathOverflow)?;
        let quorum_met = (total_votes as u128) >= required;

        // FN-H4: a proposal whose voting window has closed without reaching
        // quorum must reach a TERMINAL state (Failed), not revert forever. The
        // old code did `require!(quorum_met, QuorumNotMet)` here, so a
        // no-quorum proposal stayed `Active` indefinitely — permanently locking
        // every token voter's escrow (only the proposer could `cancel_proposal`,
        // and wallet votes had no exit at all). Resolving it to `Failed` lets
        // `release_vote_escrow` (which only requires `status != Active`) return
        // the locked tokens.
        let status = if !voting_closed {
            // Token weight can be borrowed for one transaction. Early
            // finalization would let that loan pass a transfer before the
            // next slot. Wallet votes (snapshot_supply == 0) stay eligible.
            require!(snapshot_supply == 0, GovernanceError::VotingPeriodNotEnded);
            // Early finalization: allowed only when the outcome is
            // mathematically certain — quorum is met AND the FOR lead exceeds
            // ALL remaining possible votes, so no future vote can change it.
            //
            // Example: 3 guardians, 2 voted FOR, 1 remaining.
            //   lead = 2 - 0 = 2; remaining = 3 - 2 = 1; 2 > 1 → undefeatable.
            let remaining = eligible_total.saturating_sub(total_votes);
            let lead = votes_for.saturating_sub(votes_against);
            require!(
                quorum_met && lead > remaining,
                GovernanceError::VotingPeriodNotEnded
            );
            // An early finalization only happens on an undefeatable FOR lead, so
            // this branch is always a pass; keep the explicit tally for clarity.
            if votes_for > votes_against {
                ProposalStatus::Passed
            } else {
                ProposalStatus::Failed
            }
        } else if !quorum_met {
            // Window closed without quorum → terminal Failed (escrows releasable).
            ProposalStatus::Failed
        } else if votes_for > votes_against {
            ProposalStatus::Passed
        } else {
            ProposalStatus::Failed
        };

        let proposal = &mut ctx.accounts.proposal;
        proposal.status = status as u8;
        proposal.finalized_at = now;

        if status == ProposalStatus::Passed {
            emit!(ExecutionRequestQueued {
                proposal: proposal.key(),
                dao: proposal.dao,
                payload_hash: proposal.payload_hash,
            });
        }

        emit!(ProposalFinalized {
            proposal: proposal.key(),
            status: proposal.status,
            votes_for: proposal.votes_for,
            votes_against: proposal.votes_against,
        });

        Ok(())
    }

    pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
        require!(ctx.accounts.proposal.is_active(), GovernanceError::ProposalNotActive);
        require!(
            ctx.accounts.proposer.key() == ctx.accounts.proposal.proposer,
            GovernanceError::Unauthorized
        );

        ctx.accounts.proposal.status = ProposalStatus::Cancelled as u8;
        ctx.accounts.proposal.finalized_at = Clock::get()?.unix_timestamp;

        emit!(ProposalCancelled {
            proposal: ctx.accounts.proposal.key(),
        });

        Ok(())
    }

    pub fn mint_additional_tokens(ctx: Context<MintAdditionalTokens>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
        // A frozen DAO is in an emergency state; the founder must not be able to
        // dilute outstanding voting power (mint new governance tokens) while
        // guardians have the DAO frozen. Mirrors the frozen gate on
        // create_proposal and the treasury-transfer execution handlers.
        require!(!ctx.accounts.dao_registry.frozen, GovernanceError::DaoFrozen);
        require!(amount > 0, GovernanceError::MathOverflow);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.dao_registry.founder,
            GovernanceError::Unauthorized
        );

        // Bind to a PASSED TokenMint proposal (audit M11). Without this the
        // founder could mint arbitrary supply outside the governance vote. The
        // ONLY exception is the one-time genesis supply mint (no governance
        // token exists to vote with yet).
        //
        // SEC-M3: genesis was previously identified purely by `mint.supply == 0`,
        // re-evaluated on every call. A founder holding 100% of supply could
        // burn it all to zero and repeat the ungated genesis mint. The genesis
        // exception is now ALSO gated by a persistent per-(dao, mint)
        // `TokenGenesisRecord.minted` latch: genesis is permitted only while the
        // latch is unset, and ANY successful mint (genesis or proposal path)
        // sets it — so a later burn-to-zero can never re-open the ungated path.
        let genesis_record = &mut ctx.accounts.genesis_record;
        if genesis_record.dao == Pubkey::default() {
            // Freshly created record (init_if_needed): bind it to this token.
            genesis_record.bump = ctx.bumps.genesis_record;
            genesis_record.dao = ctx.accounts.dao_registry.key();
            genesis_record.mint = ctx.accounts.mint.key();
            genesis_record.minted = false;
        } else {
            require!(
                genesis_record.dao == ctx.accounts.dao_registry.key()
                    && genesis_record.mint == ctx.accounts.mint.key(),
                GovernanceError::DaoOwnershipMismatch
            );
        }

        let is_genesis = ctx.accounts.mint.supply == 0 && !genesis_record.minted;
        if !is_genesis {
            verify_token_mint_proposal(
                ctx.accounts.proposal.as_deref().map(|p| &**p),
                &ctx.accounts.dao_registry.key(),
                &ctx.accounts.mint.key(),
                &ctx.accounts.destination.key(),
                amount,
            )?;
        }

        let idx = ctx
            .accounts
            .token_registry
            .find_token_index(&ctx.accounts.mint.key())
            .ok_or(GovernanceError::TokenNotInRegistry)?;
        require!(
            !ctx.accounts.token_registry.tokens[idx].authority_revoked,
            GovernanceError::AuthorityAlreadyRevoked
        );

        // The DAO-registry PDA (mint authority) belongs to nave_core, so this
        // program cannot `invoke_signed` for it — the previous in-program
        // `token::mint_to` with dao_registry seeds always failed with "Provided
        // seeds do not result in a valid address" (latent defect surfaced by
        // the SEC-M3 tests). Mint via nave_core's CPI-only `mint_dao_token`,
        // which verifies (instructions sysvar) that nave_governance is the
        // top-level caller before PDA-signing the SPL mint.
        nave_core::cpi::mint_dao_token(
            CpiContext::new(
                ctx.accounts.nave_core_program.to_account_info(),
                nave_core::cpi::accounts::MintDaoToken {
                    instructions_sysvar: ctx.accounts.instructions.to_account_info(),
                    global_config: ctx.accounts.global_config.to_account_info(),
                    dao_registry: ctx.accounts.dao_registry.to_account_info(),
                    token_registry: ctx.accounts.token_registry.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    destination: ctx.accounts.destination.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ),
            amount,
        )?;

        // SEC-M3: latch the genesis window closed on ANY successful mint, so a
        // future burn-to-zero can never re-trigger the ungated genesis path.
        ctx.accounts.genesis_record.minted = true;

        // Consume the proposal so the same ratified vote cannot mint twice.
        if let Some(prop) = ctx.accounts.proposal.as_mut() {
            prop.status = ProposalStatus::Executed as u8;
        }

        emit!(AdditionalTokensMinted {
            dao: ctx.accounts.dao_registry.key(),
            mint: ctx.accounts.mint.key(),
            amount,
        });

        Ok(())
    }

    /// Execute a passed native-SOL transfer proposal (payload mint = 32 zero bytes).
    pub fn execute_treasury_transfer_native_sol(
        ctx: Context<ExecuteTreasuryTransferNativeSol>,
    ) -> Result<()> {
        require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
        require!(!ctx.accounts.dao_registry.frozen, GovernanceError::DaoFrozen);
        let prop = &ctx.accounts.proposal;
        require!(
            prop.status == ProposalStatus::Passed as u8,
            GovernanceError::InvalidProposalStatus
        );
        require!(
            prop.proposal_type == ProposalType::Transfer as u8,
            GovernanceError::InvalidProposalType
        );
        require!(prop.finalized_at > 0, GovernanceError::InvalidProposalStatus);
        let plen = prop.payload_len as usize;
        require!(plen == 72, GovernanceError::InvalidPayloadLength);
        let mint = Pubkey::new_from_array(prop.payload[32..64].try_into().unwrap());
        require!(mint == Pubkey::default(), GovernanceError::InvalidProposalType);

        nave_core::cpi::execute_governance_transfer_native_sol(CpiContext::new(
            ctx.accounts.nave_core_program.to_account_info(),
            nave_core::cpi::accounts::ExecuteGovernanceTransferNativeSol {
                instructions_sysvar: ctx.accounts.instructions.to_account_info(),
                global_config: ctx.accounts.global_config.to_account_info(),
                dao_registry: ctx.accounts.dao_registry.to_account_info(),
                proposal: ctx.accounts.proposal.to_account_info(),
                vault_authority: ctx.accounts.vault_authority.to_account_info(),
                treasury_vault: ctx.accounts.treasury_vault.to_account_info(),
                recipient: ctx.accounts.recipient.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        ))?;

        ctx.accounts.proposal.status = ProposalStatus::Executed as u8;
        Ok(())
    }

    /// Execute a passed SPL transfer proposal (registered treasury asset mint).
    pub fn execute_treasury_transfer_spl(ctx: Context<ExecuteTreasuryTransferSpl>) -> Result<()> {
        cpi_execute_treasury_transfer_spl(&ctx)?;
        ctx.accounts.proposal.status = ProposalStatus::Executed as u8;
        Ok(())
    }

    /// Execute a passed NFT transfer proposal (registered `NftVaultRecord` mint).
    pub fn execute_treasury_transfer_nft(ctx: Context<ExecuteTreasuryTransferNft>) -> Result<()> {
        cpi_execute_treasury_transfer_nft(&ctx)?;
        ctx.accounts.proposal.status = ProposalStatus::Executed as u8;
        Ok(())
    }

    /// Execute a passed `SwitchVotingSystem` proposal (SOL-C2). CPIs into
    /// `nave_core::switch_voting_system`, which itself decodes the target
    /// governance configuration straight from this proposal's payload
    /// (verified via `nave_core`'s instructions-sysvar CPI-caller check) —
    /// mirrors `execute_treasury_transfer_*` above. Marks the proposal
    /// `Executed` immediately after the CPI so it can never be replayed.
    pub fn execute_switch_voting_system(ctx: Context<ExecuteSwitchVotingSystem>) -> Result<()> {
        cpi_execute_switch_voting_system(&ctx)?;
        ctx.accounts.proposal.status = ProposalStatus::Executed as u8;
        Ok(())
    }

    /// Execute a passed `Permission` proposal: replace guardian wallets +
    /// threshold. CPIs into `nave_core::apply_guardian_config_from_governance`,
    /// which decodes `(threshold, wallets)` from this proposal's bound payload
    /// and latches `GuardianConfig.bootstrapped`. Marks the proposal `Executed`
    /// immediately after the CPI so it cannot be replayed.
    pub fn execute_permission_proposal(ctx: Context<ExecutePermissionProposal>) -> Result<()> {
        cpi_execute_permission_proposal(&ctx)?;
        ctx.accounts.proposal.status = ProposalStatus::Executed as u8;
        Ok(())
    }

    /// Mark a `MoonlightRequest`/`MoonlightDistribution` proposal `Executed` so
    /// it can never be replayed. Unlike `Transfer`/`TokenMint` proposals — whose
    /// SOLE entry point is a `nave_governance` instruction that flips
    /// `status = Executed` itself right after the CPI — moonlighting's entry
    /// point is `nave_core`'s own instructions (`record_moonlight_request`,
    /// `execute_moonlight_distribution`), which only ever READ this proposal's
    /// raw account bytes and have no way to mutate a `nave_governance`-owned
    /// account directly. Without this, the exact same `Passed` proposal pair
    /// could be fed into those handlers again after a `restore_dao` cycle,
    /// re-triggering moonlighting without a fresh vote (P6-3 in
    /// `docs/AUDIT_FINDINGS.md`). Callable ONLY as a CPI from `nave_core`
    /// (verified via the instructions-sysvar top-level-caller check, the same
    /// pattern `nave_core::verify_governance_caller` uses in the other
    /// direction) — `nave_core`'s moonlight handlers call this immediately
    /// after validating each proposal, before advancing the lifecycle.
    pub fn mark_moonlight_proposal_executed(
        ctx: Context<MarkMoonlightProposalExecuted>,
    ) -> Result<()> {
        verify_core_caller(&ctx.accounts.instructions)?;
        let prop = &mut ctx.accounts.proposal;
        require!(
            prop.proposal_type == ProposalType::MoonlightRequest as u8
                || prop.proposal_type == ProposalType::MoonlightDistribution as u8,
            GovernanceError::InvalidProposalType
        );
        // Idempotent: nave_core's execute_moonlight_distribution handler is
        // itself documented idempotent (a second call after release is a
        // token-leg no-op), so allow re-marking an already-Executed proposal
        // rather than erroring — only require it isn't Active/Failed/Cancelled.
        require!(
            prop.status == ProposalStatus::Passed as u8
                || prop.status == ProposalStatus::Executed as u8,
            GovernanceError::InvalidProposalStatus
        );
        prop.status = ProposalStatus::Executed as u8;
        Ok(())
    }
}

/// Ensure this nave_governance instruction is executing as a CPI child of
/// `nave_core` (mirrors `nave_core::verify_governance_caller`, same pattern in
/// the opposite direction).
fn verify_core_caller(instructions_sysvar: &AccountInfo) -> Result<()> {
    use anchor_lang::solana_program::sysvar::instructions::{
        load_current_index_checked, load_instruction_at_checked,
    };
    let idx = load_current_index_checked(instructions_sysvar)?;
    let current = load_instruction_at_checked(idx as usize, instructions_sysvar)?;
    require!(current.program_id == nave_core::ID, GovernanceError::Unauthorized);
    Ok(())
}

/// Verify a passed TokenMint proposal binds the requested mint/destination/amount.
/// Isolated (and the large Proposal is boxed) to stay under the BPF stack limit.
#[inline(never)]
fn verify_token_mint_proposal(
    proposal: Option<&Proposal>,
    dao_key: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    amount: u64,
) -> Result<()> {
    let prop = proposal.ok_or(GovernanceError::Unauthorized)?;
    // Anchor already guarantees `prop` is a program-owned Proposal account (only
    // ever created as a PDA via create_proposal); binding its `dao` field to this
    // DAO is sufficient to ensure it is one of this DAO's real proposals.
    require!(prop.dao == *dao_key, GovernanceError::Unauthorized);
    require!(
        prop.proposal_type == ProposalType::TokenMint as u8,
        GovernanceError::InvalidProposalType
    );
    require!(
        prop.status == ProposalStatus::Passed as u8,
        GovernanceError::InvalidProposalStatus
    );
    require!(prop.finalized_at > 0, GovernanceError::InvalidProposalStatus);
    require!(prop.payload_len as usize == 72, GovernanceError::InvalidPayloadLength);
    let dest_p = Pubkey::new_from_array(prop.payload[0..32].try_into().unwrap());
    let mint_p = Pubkey::new_from_array(prop.payload[32..64].try_into().unwrap());
    let amount_p = u64::from_le_bytes(prop.payload[64..72].try_into().unwrap());
    require!(mint_p == *mint, GovernanceError::PayloadMismatch);
    require!(dest_p == *destination, GovernanceError::PayloadMismatch);
    require!(amount_p == amount, GovernanceError::PayloadMismatch);
    Ok(())
}

/// Isolate CPI account bundle from the instruction frame to stay under the BPF 4KiB stack limit.
#[inline(never)]
fn cpi_execute_switch_voting_system(ctx: &Context<ExecuteSwitchVotingSystem>) -> Result<()> {
    require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
    require!(!ctx.accounts.dao_registry.frozen, GovernanceError::DaoFrozen);
    let prop = ctx.accounts.proposal.as_ref();
    require!(
        prop.status == ProposalStatus::Passed as u8,
        GovernanceError::InvalidProposalStatus
    );
    require!(
        prop.proposal_type == ProposalType::SwitchVotingSystem as u8,
        GovernanceError::InvalidProposalType
    );
    require!(prop.finalized_at > 0, GovernanceError::InvalidProposalStatus);

    nave_core::cpi::switch_voting_system(CpiContext::new(
        ctx.accounts.nave_core_program.to_account_info(),
        nave_core::cpi::accounts::SwitchVotingSystem {
            instructions_sysvar: ctx.accounts.instructions.to_account_info(),
            global_config: ctx.accounts.global_config.to_account_info(),
            dao_registry: ctx.accounts.dao_registry.to_account_info(),
            guardian_config: ctx.accounts.guardian_config.to_account_info(),
            token_registry: ctx.accounts.token_registry.to_account_info(),
            proposal: ctx.accounts.proposal.to_account_info(),
        },
    ))?;
    Ok(())
}

/// Isolate CPI for Permission → guardian config apply (stack budget).
#[inline(never)]
fn cpi_execute_permission_proposal(ctx: &Context<ExecutePermissionProposal>) -> Result<()> {
    require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
    require!(!ctx.accounts.dao_registry.frozen, GovernanceError::DaoFrozen);
    let prop = ctx.accounts.proposal.as_ref();
    require!(
        prop.status == ProposalStatus::Passed as u8,
        GovernanceError::InvalidProposalStatus
    );
    require!(
        prop.proposal_type == ProposalType::Permission as u8,
        GovernanceError::InvalidProposalType
    );
    require!(prop.finalized_at > 0, GovernanceError::InvalidProposalStatus);
    // Fixed Permission payload: threshold(1) ‖ count(1) ‖ wallets(MAX×32).
    require!(
        prop.payload_len as usize == nave_core::constants::PERMISSION_PAYLOAD_LEN,
        GovernanceError::InvalidPayloadLength
    );

    nave_core::cpi::apply_guardian_config_from_governance(CpiContext::new(
        ctx.accounts.nave_core_program.to_account_info(),
        nave_core::cpi::accounts::ApplyGuardianConfigFromGovernance {
            instructions_sysvar: ctx.accounts.instructions.to_account_info(),
            global_config: ctx.accounts.global_config.to_account_info(),
            dao_registry: ctx.accounts.dao_registry.to_account_info(),
            guardian_config: ctx.accounts.guardian_config.to_account_info(),
            proposal: ctx.accounts.proposal.to_account_info(),
        },
    ))?;
    Ok(())
}

/// Isolate CPI account bundle from the instruction frame to stay under the BPF 4KiB stack limit.
#[inline(never)]
fn cpi_execute_treasury_transfer_spl(ctx: &Context<ExecuteTreasuryTransferSpl>) -> Result<()> {
    require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
    require!(!ctx.accounts.dao_registry.frozen, GovernanceError::DaoFrozen);
    let prop = ctx.accounts.proposal.as_ref();
    require!(
        prop.status == ProposalStatus::Passed as u8,
        GovernanceError::InvalidProposalStatus
    );
    require!(
        prop.proposal_type == ProposalType::Transfer as u8,
        GovernanceError::InvalidProposalType
    );
    require!(prop.finalized_at > 0, GovernanceError::InvalidProposalStatus);
    let plen = prop.payload_len as usize;
    require!(plen == 72, GovernanceError::InvalidPayloadLength);
    let mint = Pubkey::new_from_array(prop.payload[32..64].try_into().unwrap());
    require!(mint != Pubkey::default(), GovernanceError::InvalidProposalType);
    require!(mint == ctx.accounts.mint.key(), GovernanceError::DaoOwnershipMismatch);

    nave_core::cpi::execute_governance_transfer_spl(CpiContext::new(
        ctx.accounts.nave_core_program.to_account_info(),
        nave_core::cpi::accounts::ExecuteGovernanceTransferSpl {
            instructions_sysvar: ctx.accounts.instructions.to_account_info(),
            global_config: ctx.accounts.global_config.to_account_info(),
            dao_registry: ctx.accounts.dao_registry.to_account_info(),
            proposal: ctx.accounts.proposal.to_account_info(),
            vault_authority: ctx.accounts.vault_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            asset_config: ctx.accounts.asset_config.to_account_info(),
            treasury_asset: ctx.accounts.treasury_asset.to_account_info(),
            treasury_vault: ctx.accounts.treasury_vault.to_account_info(),
            asset_vault: ctx.accounts.asset_vault.to_account_info(),
            recipient: ctx.accounts.recipient.to_account_info(),
            recipient_token: ctx.accounts.recipient_token.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    ))?;
    Ok(())
}

/// Isolate CPI account bundle for NFT treasury transfers.
#[inline(never)]
fn cpi_execute_treasury_transfer_nft(ctx: &Context<ExecuteTreasuryTransferNft>) -> Result<()> {
    require!(!ctx.accounts.global_config.paused, GovernanceError::GlobalPaused);
    require!(!ctx.accounts.dao_registry.frozen, GovernanceError::DaoFrozen);
    let prop = ctx.accounts.proposal.as_ref();
    require!(
        prop.status == ProposalStatus::Passed as u8,
        GovernanceError::InvalidProposalStatus
    );
    require!(
        prop.proposal_type == ProposalType::Transfer as u8,
        GovernanceError::InvalidProposalType
    );
    require!(prop.finalized_at > 0, GovernanceError::InvalidProposalStatus);
    let plen = prop.payload_len as usize;
    require!(plen == 72, GovernanceError::InvalidPayloadLength);
    let mint = Pubkey::new_from_array(prop.payload[32..64].try_into().unwrap());
    require!(mint != Pubkey::default(), GovernanceError::InvalidProposalType);
    require!(mint == ctx.accounts.mint.key(), GovernanceError::DaoOwnershipMismatch);
    let amount = u64::from_le_bytes(prop.payload[64..72].try_into().unwrap());
    require!(amount == 1, GovernanceError::InvalidProposalType);

    nave_core::cpi::execute_governance_transfer_nft(CpiContext::new(
        ctx.accounts.nave_core_program.to_account_info(),
        nave_core::cpi::accounts::ExecuteGovernanceTransferNft {
            instructions_sysvar: ctx.accounts.instructions.to_account_info(),
            global_config: ctx.accounts.global_config.to_account_info(),
            dao_registry: ctx.accounts.dao_registry.to_account_info(),
            proposal: ctx.accounts.proposal.to_account_info(),
            vault_authority: ctx.accounts.vault_authority.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            nft_record: ctx.accounts.nft_record.to_account_info(),
            nft_vault: ctx.accounts.nft_vault.to_account_info(),
            recipient: ctx.accounts.recipient.to_account_info(),
            recipient_token: ctx.accounts.recipient_token.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    ))?;
    Ok(())
}

fn apply_vote_weight(proposal: &mut Account<Proposal>, choice: u8, weight: u64) -> Result<()> {
    match VoteChoice::from_u8(choice).ok_or(GovernanceError::InvalidVoteChoice)? {
        VoteChoice::For => {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(weight)
                .ok_or(GovernanceError::MathOverflow)?;
        }
        VoteChoice::Against => {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(weight)
                .ok_or(GovernanceError::MathOverflow)?;
        }
        VoteChoice::Abstain => {
            proposal.votes_abstain = proposal
                .votes_abstain
                .checked_add(weight)
                .ok_or(GovernanceError::MathOverflow)?;
        }
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: CreateProposalParams)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        mut,
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        init,
        payer = proposer,
        space = Proposal::LEN,
        seeds = [PROPOSAL_SEED, dao_registry.key().as_ref(), &dao_registry.next_proposal_index.to_le_bytes()],
        bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    pub dao_token_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [nave_core::constants::TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump = token_registry.bump,
        seeds::program = nave_core::ID,
        constraint = token_registry.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    /// CHECK: Nave core program for proposal count CPI.
    #[account(address = nave_core::ID)]
    pub nave_core_program: UncheckedAccount<'info>,

    /// CHECK: This governance program id, passed to core CPI auth.
    #[account(address = crate::ID)]
    pub governance_program: UncheckedAccount<'info>,

    /// CHECK: Instructions sysvar — forwarded to nave_core's `record_proposal_creation`
    /// for CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastVoteWallet<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,

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
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = guardian_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub guardian_config: Box<Account<'info, GuardianConfig>>,

    #[account(
        mut,
        constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        init,
        payer = voter,
        space = VoteRecord::LEN,
        seeds = [VOTE_RECORD_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_record: Box<Account<'info, VoteRecord>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockTokensAndVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,

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

    #[account(mut, constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch)]
    pub proposal: Box<Account<'info, Proposal>>,

    /// Must be the governance mint snapshotted on the proposal at creation —
    /// a caller-supplied arbitrary mint could otherwise buy unbounded weight.
    #[account(constraint = dao_token_mint.key() == proposal.token_mint @ GovernanceError::VotingMintMismatch)]
    pub dao_token_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub voter_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = voter,
        space = VoteEscrow::LEN,
        seeds = [VOTE_ESCROW_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_escrow: Box<Account<'info, VoteEscrow>>,

    #[account(
        init,
        payer = voter,
        space = VoteRecord::LEN,
        seeds = [VOTE_RECORD_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_record: Box<Account<'info, VoteRecord>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseVoteEscrow<'info> {
    pub voter: Signer<'info>,

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

    #[account(constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch)]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        mut,
        seeds = [VOTE_ESCROW_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump = vote_escrow.bump,
        constraint = vote_escrow.voter == voter.key() @ GovernanceError::Unauthorized
    )]
    pub vote_escrow: Box<Account<'info, VoteEscrow>>,

    #[account(mut)]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub voter_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeProposal<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// Used for early-finalization eligible-voter calculation in wallet-governance
    /// DAOs (where snapshot_supply == 0). For token governance, this account is
    /// still required but guardian_config.wallet_count is not used.
    #[account(
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = guardian_config.bump,
        seeds::program = nave_core::ID,
        constraint = guardian_config.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub guardian_config: Account<'info, GuardianConfig>,

    #[account(mut, constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct CancelProposal<'info> {
    pub proposer: Signer<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(mut, constraint = proposal.proposer == proposer.key() @ GovernanceError::Unauthorized)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct MintAdditionalTokens<'info> {
    #[account(mut)]
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
        mut,
        seeds = [nave_core::constants::TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump = token_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// The passed TokenMint proposal authorizing this mint. REQUIRED for every
    /// post-genesis mint (audit M11) so a founder cannot mint outside a ratified
    /// governance vote. It is omitted ONLY for the one-time genesis supply mint
    /// (when the mint currently has zero supply and no governance exists yet).
    /// Boxed to keep the large Proposal payload off the BPF stack.
    #[account(mut)]
    pub proposal: Option<Box<Account<'info, Proposal>>>,

    /// SEC-M3: persistent per-(dao, mint) genesis latch. `init_if_needed` so the
    /// first-ever mint for a token creates it; once `minted` is set, the ungated
    /// genesis path can never re-open (even after a burn-to-zero).
    #[account(
        init_if_needed,
        payer = authority,
        space = TokenGenesisRecord::LEN,
        seeds = [TOKEN_GENESIS_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub genesis_record: Box<Account<'info, TokenGenesisRecord>>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    /// CHECK: instructions sysvar, forwarded into nave_core's `mint_dao_token`
    /// CPI so it can verify nave_governance is the top-level caller.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    /// CHECK: nave_core program id (mint executes there via CPI: the DAO PDA
    /// mint authority belongs to nave_core).
    #[account(address = nave_core::ID)]
    pub nave_core_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteSwitchVotingSystem<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,

    /// CHECK: instructions sysvar for `nave_core` CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump,
        seeds::program = nave_core::ID,
    )]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        mut,
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        mut,
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = guardian_config.bump,
        seeds::program = nave_core::ID,
        constraint = guardian_config.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub guardian_config: Box<Account<'info, GuardianConfig>>,

    #[account(
        seeds = [nave_core::constants::TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump = token_registry.bump,
        seeds::program = nave_core::ID,
        constraint = token_registry.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, dao_registry.key().as_ref(), &proposal.proposal_index.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    /// CHECK: nave_core program id.
    #[account(address = nave_core::ID)]
    pub nave_core_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ExecutePermissionProposal<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,

    /// CHECK: instructions sysvar for `nave_core` CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

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
        mut,
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = guardian_config.bump,
        seeds::program = nave_core::ID,
        constraint = guardian_config.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub guardian_config: Box<Account<'info, GuardianConfig>>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, dao_registry.key().as_ref(), &proposal.proposal_index.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    /// CHECK: nave_core program id.
    #[account(address = nave_core::ID)]
    pub nave_core_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MarkMoonlightProposalExecuted<'info> {
    /// CHECK: instructions sysvar for `nave_core` CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    #[account(
        seeds = [nave_core::constants::DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = nave_core::ID,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, dao_registry.key().as_ref(), &proposal.proposal_index.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct ExecuteTreasuryTransferNativeSol<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,

    /// CHECK: instructions sysvar for `nave_core` CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

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
        mut,
        seeds = [PROPOSAL_SEED, dao_registry.key().as_ref(), &proposal.proposal_index.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        seeds::program = nave_core::ID,
        constraint = vault_authority.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    /// Passed through to nave_core so it can invalidate last_revalued_at after
    /// the transfer, forcing a fresh revaluation before the next deploy.
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        seeds::program = nave_core::ID,
        constraint = treasury_vault.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    /// CHECK: recipient system account (validated in nave_core against proposal payload).
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: nave_core program id.
    #[account(address = nave_core::ID)]
    pub nave_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteTreasuryTransferSpl<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,

    /// CHECK: instructions sysvar for `nave_core` CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

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
        mut,
        seeds = [PROPOSAL_SEED, dao_registry.key().as_ref(), &proposal.proposal_index.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        seeds::program = nave_core::ID,
        constraint = vault_authority.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = asset_config.bump,
        seeds::program = nave_core::ID,
        constraint = asset_config.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch,
        constraint = asset_config.mint == mint.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub asset_config: Box<Account<'info, AssetConfig>>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        seeds::program = nave_core::ID,
        constraint = treasury_asset.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch,
        constraint = treasury_asset.mint == mint.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub treasury_asset: Box<Account<'info, TreasuryAsset>>,

    /// Passed through to nave_core so it can invalidate last_revalued_at after
    /// the transfer, forcing a fresh revaluation before the next deploy.
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        seeds::program = nave_core::ID,
        constraint = treasury_vault.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    #[account(
        mut,
        seeds = [ASSET_VAULT_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = nave_core::ID,
        constraint = asset_vault.key() == treasury_asset.token_account @ GovernanceError::DaoOwnershipMismatch,
        constraint = asset_vault.owner == vault_authority.key() @ GovernanceError::Unauthorized
    )]
    pub asset_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: recipient wallet owner (must match proposal payload recipient).
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = executor,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub recipient_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: nave_core program id.
    #[account(address = nave_core::ID)]
    pub nave_core_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteTreasuryTransferNft<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,

    /// CHECK: instructions sysvar for `nave_core` CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

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
        mut,
        seeds = [PROPOSAL_SEED, dao_registry.key().as_ref(), &proposal.proposal_index.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub proposal: Box<Account<'info, Proposal>>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        seeds::program = nave_core::ID,
        constraint = vault_authority.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [NFT_VAULT_RECORD_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = nft_record.bump,
        seeds::program = nave_core::ID,
        constraint = nft_record.dao == dao_registry.key() @ GovernanceError::DaoOwnershipMismatch,
        constraint = nft_record.mint == mint.key() @ GovernanceError::DaoOwnershipMismatch,
        constraint = !nft_record.transferred @ GovernanceError::InvalidProposalType
    )]
    pub nft_record: Box<Account<'info, NftVaultRecord>>,

    #[account(
        mut,
        seeds = [NFT_VAULT_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = nave_core::ID,
        constraint = nft_vault.key() == nft_record.token_account @ GovernanceError::DaoOwnershipMismatch,
        constraint = nft_vault.owner == vault_authority.key() @ GovernanceError::Unauthorized
    )]
    pub nft_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: recipient wallet owner (must match proposal payload recipient).
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = executor,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub recipient_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: nave_core program id.
    #[account(address = nave_core::ID)]
    pub nave_core_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
