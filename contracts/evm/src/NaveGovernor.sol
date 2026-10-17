// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {INaveGovernor} from "./interfaces/INaveGovernor.sol";
import {INaveTreasury} from "./interfaces/INaveTreasury.sol";
import {INaveProtocol} from "./interfaces/INaveProtocol.sol";
import {INaveExecution} from "./interfaces/INaveExecution.sol";
import {NaveConstants} from "./libraries/NaveConstants.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";
import {PayloadHash} from "./libraries/PayloadHash.sol";
import {
    ProposalType,
    ProposalStatus,
    VoteChoice,
    VoteMethod,
    GovernanceType,
    DaoImplRole
} from "./libraries/NaveEnums.sol";

/// @title NaveGovernor
/// @notice Per-DAO governance UUPS proxy. EVM port of `nave_governance`.
contract NaveGovernor is INaveGovernor, Initializable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Proposal {
        uint64 proposalIndex;
        address proposer;
        uint8 proposalType;
        uint8 status;
        address votingMint;
        bytes32 payloadHash;
        uint256 snapshotSupply;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 votesAbstain;
        uint256 votingEnd;
        uint256 createdAt;
        uint256 finalizedAt;
    }

    struct VoteRecord {
        bool voted;
        uint8 choice;
        uint8 method;
        uint256 weight;
    }

    struct VoteEscrow {
        address mint;
        uint256 lockedAmount;
        bool released;
    }

    struct CreateProposalParams {
        string title;
        string description;
        bytes payload;
        uint8 proposalType;
        uint256 votingPeriodSeconds;
        address votingMint; // governance token for token-weighted DAOs
    }

    INaveTreasury public treasuryContract;
    INaveProtocol public protocolContract;
    /// The single per-DAO `NaveExecution` proxy authorized to mark this DAO's
    /// proposals executed. Bound at {initialize}; gating to a global
    /// `isNaveExecution` check would let ANY DAO's execution contract mark ANY
    /// other DAO's proposals executed (C-1 cross-DAO griefing).
    address public executionContract;

    mapping(uint64 => Proposal) internal _proposals;
    mapping(uint64 => mapping(address => VoteRecord)) internal _voteRecords;
    mapping(uint64 => mapping(address => VoteEscrow)) internal _escrows;

    event ProposalCreated(
        uint64 indexed index, uint8 proposalType, uint256 snapshotSupply, bytes32 payloadHash
    );
    event VoteCast(uint64 indexed index, address voter, uint8 choice, uint8 method, uint256 weight);
    event VoteEscrowLocked(uint64 indexed index, address voter, uint256 amount);
    event VoteEscrowReleased(uint64 indexed index, address voter, uint256 amount);
    event ProposalFinalized(
        uint64 indexed index, uint8 status, uint256 votesFor, uint256 votesAgainst
    );
    event ExecutionRequestQueued(uint64 indexed index, bytes32 payloadHash);
    event ProposalCancelled(uint64 indexed index);
    event AdditionalTokensMinted(address mint, uint256 amount);
    event ContractUpgradeExecuted(
        uint64 indexed index, address treasuryImpl, address governorImpl, address executionImpl
    );
    /// A Passed moonlight proposal was consumed by the DaoStake module (P6-3).
    event MoonlightProposalConsumed(uint64 indexed index, uint8 proposalType);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address treasury_, address protocol_, address execution_)
        external
        initializer
    {
        if (execution_ == address(0)) revert NaveErrors.ZeroAddress();
        treasuryContract = INaveTreasury(treasury_);
        protocolContract = INaveProtocol(protocol_);
        executionContract = execution_;
    }

    function _authorizeUpgrade(address newImplementation) internal override {
        if (msg.sender != address(this)) revert NaveErrors.Unauthorized();
        if (
            !protocolContract.isApprovedImplementation(
                uint8(DaoImplRole.Governor), newImplementation
            )
        ) revert NaveErrors.ImplNotApproved();
    }

    function treasury() external view returns (address) {
        return address(treasuryContract);
    }

    function currentImplementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    modifier notPaused() {
        if (protocolContract.paused()) revert NaveErrors.GlobalPaused();
        _;
    }

    // ── Proposal lifecycle ────────────────────────────────────────────────
    function createProposal(CreateProposalParams calldata p)
        external
        notPaused
        returns (uint64 index)
    {
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        if (treasuryContract.proposalCount() >= NaveConstants.MAX_PROPOSALS_PER_DAO) {
            revert NaveErrors.MaxProposalsReached();
        }
        if (p.proposalType > uint8(ProposalType.ContractUpgrade)) {
            revert NaveErrors.InvalidProposalType();
        }
        if (
            p.votingPeriodSeconds < NaveConstants.minVotingPeriodSecs()
                || p.votingPeriodSeconds > NaveConstants.MAX_VOTING_PERIOD
        ) {
            revert NaveErrors.InvalidVotingPeriod();
        }
        if (
            bytes(p.title).length == 0
                || bytes(p.title).length > NaveConstants.MAX_PROPOSAL_TITLE_LEN
        ) {
            revert NaveErrors.InvalidTitleLength();
        }
        if (p.payload.length > NaveConstants.MAX_PROPOSAL_PAYLOAD_LEN) {
            revert NaveErrors.InvalidPayloadLength();
        }

        bool isTokenGov = treasuryContract.governanceType() == uint8(GovernanceType.Token);
        uint256 snapshotSupply;
        if (isTokenGov) {
            // The proposer does not get to pick a thin registered mint. Weight
            // is measured against the treasury's designated voting token only.
            if (p.votingMint != treasuryContract.votingToken()) {
                revert NaveErrors.VotingMintMismatch();
            }
            if (!treasuryContract.isTokenRegistered(p.votingMint)) {
                revert NaveErrors.TokenMintNotRegistered();
            }
            snapshotSupply = IERC20(p.votingMint).totalSupply();
            // Supply 0 would fall through to the guardian count and let a few
            // tokens pass a treasury transfer.
            if (snapshotSupply == 0) revert NaveErrors.ZeroVotingSupply();
        }

        index = treasuryContract.nextProposalIndex();
        Proposal storage prop = _proposals[index];
        prop.proposalIndex = index;
        prop.proposer = msg.sender;
        prop.proposalType = p.proposalType;
        prop.status = uint8(ProposalStatus.Active);
        prop.votingMint = p.votingMint;
        prop.payloadHash = keccak256(p.payload);
        prop.snapshotSupply = snapshotSupply;
        prop.votingEnd = block.timestamp + p.votingPeriodSeconds;
        prop.createdAt = block.timestamp;

        treasuryContract.recordProposalCreation();
        emit ProposalCreated(index, p.proposalType, snapshotSupply, prop.payloadHash);
    }

    function castVoteWallet(uint64 index, uint8 choice) external notPaused {
        if (treasuryContract.governanceType() != uint8(GovernanceType.Wallet)) {
            revert NaveErrors.WrongGovernanceMode();
        }
        if (choice > uint8(VoteChoice.Abstain)) revert NaveErrors.InvalidVoteChoice();
        Proposal storage prop = _proposals[index];
        _requireActiveVotable(prop);
        if (!treasuryContract.isGuardian(msg.sender)) revert NaveErrors.GuardianRequired();
        if (_voteRecords[index][msg.sender].voted) revert NaveErrors.AlreadyVoted();

        _voteRecords[index][msg.sender] =
            VoteRecord({voted: true, choice: choice, method: uint8(VoteMethod.Wallet), weight: 1});
        _applyVoteWeight(prop, choice, 1);
        emit VoteCast(index, msg.sender, choice, uint8(VoteMethod.Wallet), 1);
    }

    function lockTokensAndVote(uint64 index, uint256 amount, uint8 choice)
        external
        notPaused
        nonReentrant
    {
        if (treasuryContract.governanceType() != uint8(GovernanceType.Token)) {
            revert NaveErrors.WrongGovernanceMode();
        }
        if (amount == 0) revert NaveErrors.MathOverflow();
        if (choice > uint8(VoteChoice.Abstain)) revert NaveErrors.InvalidVoteChoice();
        Proposal storage prop = _proposals[index];
        _requireActiveVotable(prop);
        if (_voteRecords[index][msg.sender].voted) revert NaveErrors.AlreadyVoted();

        // Weight is tokens actually received, not the requested amount. A
        // no-op or fee-on-transfer `transferFrom` cannot mint voting power.
        uint256 beforeBal = IERC20(prop.votingMint).balanceOf(address(this));
        IERC20(prop.votingMint).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(prop.votingMint).balanceOf(address(this)) - beforeBal;
        if (received == 0) revert NaveErrors.MathOverflow();
        _escrows[index][msg.sender] =
            VoteEscrow({mint: prop.votingMint, lockedAmount: received, released: false});
        _voteRecords[index][msg.sender] = VoteRecord({
            voted: true, choice: choice, method: uint8(VoteMethod.Escrow), weight: received
        });
        _applyVoteWeight(prop, choice, received);

        emit VoteEscrowLocked(index, msg.sender, received);
        emit VoteCast(index, msg.sender, choice, uint8(VoteMethod.Escrow), received);
    }

    function releaseVoteEscrow(uint64 index) external notPaused nonReentrant {
        Proposal storage prop = _proposals[index];
        if (prop.status == uint8(ProposalStatus.Active)) revert NaveErrors.EscrowStillLocked();
        VoteEscrow storage esc = _escrows[index][msg.sender];
        if (esc.lockedAmount == 0 || esc.released) revert NaveErrors.EscrowNotLocked();
        esc.released = true;
        IERC20(esc.mint).safeTransfer(msg.sender, esc.lockedAmount);
        emit VoteEscrowReleased(index, msg.sender, esc.lockedAmount);
    }

    /// Finalize a proposal. Permitted even when globally paused (read-only tally)
    /// to allow in-flight proposals to conclude. Mirrors `finalize_proposal`.
    function finalizeProposal(uint64 index) external {
        Proposal storage prop = _proposals[index];
        if (prop.status != uint8(ProposalStatus.Active)) revert NaveErrors.ProposalNotActive();

        uint256 totalVotes = prop.votesFor + prop.votesAgainst;
        uint16 quorumBps_ = _quorumBps(prop.proposalType);
        uint256 eligibleTotal = prop.snapshotSupply > 0
            ? prop.snapshotSupply
            : uint256(treasuryContract.guardianCount());
        // EVM-C1: round the quorum requirement UP (not down). Floor division
        // let a small guardian set (e.g. 3 guardians, any quorumBps up to
        // 3333) round `required` to 0, so quorum was trivially always met and
        // a single guardian could pass ANY proposal — including TokenMint
        // (25%) and SwitchVotingSystem (70%). `required` is additionally
        // floored at 1 so a zero/negligible eligible set can never be
        // trivially satisfied by a single voter either.
        uint256 required = Math.ceilDiv(eligibleTotal * quorumBps_, NaveConstants.BPS_DENOMINATOR);
        if (required < 1) required = 1;
        bool quorumMet = totalVotes >= required;

        uint8 status;
        if (block.timestamp <= prop.votingEnd) {
            // Token weight can be borrowed and repaid in one transaction.
            // Early finalization would let that loan create, pass, execute,
            // and unlock before the next block. Wallet votes are one per
            // guardian and stay eligible for an undefeatable early pass.
            if (treasuryContract.governanceType() == uint8(GovernanceType.Token)) {
                revert NaveErrors.VotingPeriodNotEnded();
            }
            // Early finalization: quorum met AND the FOR lead exceeds all
            // remaining possible votes (outcome mathematically certain).
            uint256 remaining = eligibleTotal > totalVotes ? eligibleTotal - totalVotes : 0;
            uint256 lead = prop.votesFor > prop.votesAgainst ? prop.votesFor - prop.votesAgainst : 0;
            if (!(quorumMet && lead > remaining)) revert NaveErrors.VotingPeriodNotEnded();
            // An undefeatable FOR lead always passes; keep the explicit tally.
            status = prop.votesFor > prop.votesAgainst
                ? uint8(ProposalStatus.Passed)
                : uint8(ProposalStatus.Failed);
        } else if (!quorumMet) {
            // Parity with Solana FN-H4: a proposal whose voting window closed
            // WITHOUT reaching quorum must reach a TERMINAL state. Reverting
            // `QuorumNotMet` here left the proposal `Active` forever, which
            // permanently locked every token voter's escrow (`releaseVoteEscrow`
            // requires a non-Active status and only the proposer could cancel).
            status = uint8(ProposalStatus.Failed);
        } else {
            status = prop.votesFor > prop.votesAgainst
                ? uint8(ProposalStatus.Passed)
                : uint8(ProposalStatus.Failed);
        }
        prop.status = status;
        prop.finalizedAt = block.timestamp;

        if (status == uint8(ProposalStatus.Passed)) {
            emit ExecutionRequestQueued(index, prop.payloadHash);
        }
        emit ProposalFinalized(index, status, prop.votesFor, prop.votesAgainst);
    }

    function cancelProposal(uint64 index) external notPaused {
        Proposal storage prop = _proposals[index];
        if (prop.status != uint8(ProposalStatus.Active)) revert NaveErrors.ProposalNotActive();
        if (msg.sender != prop.proposer) revert NaveErrors.Unauthorized();
        prop.status = uint8(ProposalStatus.Cancelled);
        prop.finalizedAt = block.timestamp;
        emit ProposalCancelled(index);
    }

    /// Governance-gated additional minting of a registered, non-revoked token.
    /// H-1: minting now requires a PASSED `TokenMint` proposal (25% quorum) whose
    /// payload binds exactly `(mint, to, amount)` — the founder can no longer
    /// unilaterally inflate supply. The proposal is consumed (marked Executed) so
    /// a single approval cannot be replayed to mint repeatedly.
    function mintAdditionalTokens(uint64 proposalIndex, address mint, address to, uint256 amount)
        external
        notPaused
    {
        if (amount == 0) revert NaveErrors.MathOverflow();
        Proposal storage prop = _proposals[proposalIndex];
        if (prop.proposalType != uint8(ProposalType.TokenMint)) {
            revert NaveErrors.InvalidProposalType();
        }
        if (prop.status != uint8(ProposalStatus.Passed)) revert NaveErrors.ProposalNotPassed();
        if (prop.finalizedAt == 0) revert NaveErrors.ProposalNotPassed();
        if (prop.payloadHash != keccak256(abi.encode(mint, to, amount))) {
            revert NaveErrors.PayloadHashMismatch();
        }
        if (!treasuryContract.isTokenRegistered(mint)) revert NaveErrors.TokenNotInRegistry();
        if (treasuryContract.tokenAuthorityRevoked(mint)) {
            revert NaveErrors.AuthorityAlreadyRevoked();
        }
        // Consume the proposal to prevent replay.
        prop.status = uint8(ProposalStatus.Executed);
        treasuryContract.mintRegisteredToken(mint, to, amount);
        emit AdditionalTokensMinted(mint, amount);
    }

    /// Direct treasury transfer after a passed `ProposalType.Transfer` vote.
    /// Binds `(asset, recipient, amount)` to the proposal `payloadHash`; consumes
    /// the proposal (→ Executed). Does not use the `NaveExecution` agent pipeline.
    function executeTransferProposal(uint64 proposalIndex, address asset, address recipient, uint256 amount)
        external
        notPaused
        nonReentrant
    {
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        if (recipient == address(0)) revert NaveErrors.ZeroAddress();
        if (amount == 0) revert NaveErrors.MathOverflow();
        Proposal storage prop = _proposals[proposalIndex];
        if (prop.proposalType != uint8(ProposalType.Transfer)) revert NaveErrors.InvalidProposalType();
        if (prop.status != uint8(ProposalStatus.Passed)) revert NaveErrors.ProposalNotPassed();
        if (prop.finalizedAt == 0) revert NaveErrors.ProposalNotPassed();
        if (PayloadHash.transferHash(asset, recipient, amount) != prop.payloadHash) {
            revert NaveErrors.PayloadHashMismatch();
        }
        // Double-spend seal: a Transfer proposal disburses through EXACTLY ONE
        // path. If the agent pipeline already created an execution request for it,
        // the direct path must refuse — otherwise this transfer and the pipeline
        // execution would both move funds. The reverse ordering is sealed by
        // NaveExecution's _requireProposalPassed (which reverts once this path has
        // set the proposal Executed).
        if (INaveExecution(executionContract).requestExists(proposalIndex)) {
            revert NaveErrors.ExecutionRequestExists();
        }
        // Consume before external transfer (ERC-20 hooks cannot replay this vote).
        prop.status = uint8(ProposalStatus.Executed);
        treasuryContract.executeGovernanceTransfer(asset, recipient, amount);
    }

    /// EVM-M3: execution handler for passed `SwitchVotingSystem` (type 7)
    /// proposals — previously `NaveTreasury.switchVotingSystem` had NO call
    /// site, so a 70%-quorum-passed switch never took effect (a broken
    /// governance escape hatch, e.g. abandoning a captured token vote for
    /// wallet governance). Mirrors {executeTransferProposal}: binds
    /// (newGovernanceType, newVotingToken) to the approved payload hash and
    /// consumes the proposal (→ Executed) before the treasury call.
    function executeSwitchVotingSystem(
        uint64 proposalIndex,
        uint8 newGovernanceType,
        address newVotingToken
    ) external notPaused nonReentrant {
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        if (newGovernanceType > uint8(GovernanceType.Token)) {
            revert NaveErrors.InvalidGovernanceType();
        }
        // Switching TO token governance requires a registered voting token so
        // the DAO cannot strand itself in a mode where nobody can vote.
        if (newGovernanceType == uint8(GovernanceType.Token)) {
            if (!treasuryContract.isTokenRegistered(newVotingToken)) {
                revert NaveErrors.TokenMintNotRegistered();
            }
        }
        Proposal storage prop = _proposals[proposalIndex];
        if (prop.proposalType != uint8(ProposalType.SwitchVotingSystem)) {
            revert NaveErrors.InvalidProposalType();
        }
        if (prop.status != uint8(ProposalStatus.Passed)) revert NaveErrors.ProposalNotPassed();
        if (prop.finalizedAt == 0) revert NaveErrors.ProposalNotPassed();
        if (PayloadHash.switchVotingHash(newGovernanceType, newVotingToken) != prop.payloadHash) {
            revert NaveErrors.PayloadHashMismatch();
        }
        // Consume before the external call (no replay).
        prop.status = uint8(ProposalStatus.Executed);
        treasuryContract.switchVotingSystem(newGovernanceType, newVotingToken);
    }

    /// Apply a passed `Permission` (type 2) proposal: replace guardian wallets
    /// + threshold. Binds `(wallets, threshold)` to the proposal payload hash
    /// and consumes the proposal before the treasury call.
    function executePermissionProposal(
        uint64 proposalIndex,
        address[] calldata wallets,
        uint8 threshold
    ) external notPaused nonReentrant {
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        Proposal storage prop = _proposals[proposalIndex];
        if (prop.proposalType != uint8(ProposalType.Permission)) {
            revert NaveErrors.InvalidProposalType();
        }
        if (prop.status != uint8(ProposalStatus.Passed)) revert NaveErrors.ProposalNotPassed();
        if (prop.finalizedAt == 0) revert NaveErrors.ProposalNotPassed();
        if (PayloadHash.permissionHash(wallets, threshold) != prop.payloadHash) {
            revert NaveErrors.PayloadHashMismatch();
        }
        prop.status = uint8(ProposalStatus.Executed);
        treasuryContract.applyGuardianConfigFromGovernor(wallets, threshold);
    }

    /// Direct treasury NFT (ERC-721) transfer after a passed `Transfer` proposal
    /// whose payload binds (collection, recipient, tokenId) via
    /// PayloadHash.nftTransferHash. Mirrors {executeTransferProposal}: consumes
    /// the proposal (→ Executed) before the external call (checks-effects-
    /// interactions) and refuses if the agent pipeline already claimed it.
    function executeNftTransferProposal(uint64 proposalIndex, address collection, address recipient, uint256 tokenId)
        external
        notPaused
        nonReentrant
    {
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        if (recipient == address(0)) revert NaveErrors.ZeroAddress();
        Proposal storage prop = _proposals[proposalIndex];
        if (prop.proposalType != uint8(ProposalType.Transfer)) revert NaveErrors.InvalidProposalType();
        if (prop.status != uint8(ProposalStatus.Passed)) revert NaveErrors.ProposalNotPassed();
        if (prop.finalizedAt == 0) revert NaveErrors.ProposalNotPassed();
        if (PayloadHash.nftTransferHash(collection, recipient, tokenId) != prop.payloadHash) {
            revert NaveErrors.PayloadHashMismatch();
        }
        if (INaveExecution(executionContract).requestExists(proposalIndex)) {
            revert NaveErrors.ExecutionRequestExists();
        }
        prop.status = uint8(ProposalStatus.Executed);
        treasuryContract.executeGovernanceNftTransfer(collection, tokenId, recipient);
    }

    // ── Views ─────────────────────────────────────────────────────────────
    function proposalCore(uint64 index)
        external
        view
        returns (
            uint8 proposalType,
            uint8 status,
            bytes32 payloadHash,
            uint256 finalizedAt,
            address proposer
        )
    {
        Proposal storage prop = _proposals[index];
        return (prop.proposalType, prop.status, prop.payloadHash, prop.finalizedAt, prop.proposer);
    }

    function getProposal(uint64 index) external view returns (Proposal memory) {
        return _proposals[index];
    }

    function getVote(uint64 index, address voter) external view returns (VoteRecord memory) {
        return _voteRecords[index][voter];
    }

    /// Opt-in DAO upgrade: after a passed `ContractUpgrade` proposal whose
    /// payload binds explicit impl addresses, upgrade Treasury + Execution +
    /// this Governor to those protocol-approved implementations.
    ///
    /// The former `UPGRADE_TO_LATEST` sentinel path was removed: it consented to
    /// whatever `NaveProtocol.latestImplementations()` returned at EXECUTION
    /// time, so the protocol owner could swap the targets between the vote and
    /// the upgrade. Voters must now bind the concrete implementation triplet in
    /// the payload (`PayloadHash.contractUpgradeHash`).
    function executeContractUpgrade(
        uint64 proposalIndex,
        address treasuryImpl,
        address governorImpl,
        address executionImpl
    ) external notPaused nonReentrant {
        Proposal storage prop = _proposals[proposalIndex];
        if (prop.proposalType != uint8(ProposalType.ContractUpgrade)) {
            revert NaveErrors.InvalidProposalType();
        }
        if (prop.status != uint8(ProposalStatus.Passed)) revert NaveErrors.ProposalNotPassed();
        if (prop.finalizedAt == 0) revert NaveErrors.ProposalNotPassed();
        if (
            PayloadHash.contractUpgradeHash(treasuryImpl, governorImpl, executionImpl)
                != prop.payloadHash
        ) {
            revert NaveErrors.PayloadHashMismatch();
        }
        _applyContractUpgrade(prop, proposalIndex, treasuryImpl, governorImpl, executionImpl);
    }

    function _applyContractUpgrade(
        Proposal storage prop,
        uint64 proposalIndex,
        address treasuryImpl,
        address governorImpl,
        address executionImpl
    ) internal {
        if (
            !protocolContract.isApprovedImplementation(uint8(DaoImplRole.Treasury), treasuryImpl)
                || !protocolContract.isApprovedImplementation(uint8(DaoImplRole.Governor), governorImpl)
                || !protocolContract.isApprovedImplementation(
                    uint8(DaoImplRole.Execution), executionImpl
                )
        ) {
            revert NaveErrors.ImplNotApproved();
        }

        address tCur = INaveTreasury(address(treasuryContract)).currentImplementation();
        address eCur = INaveExecution(executionContract).currentImplementation();
        address gCur = ERC1967Utils.getImplementation();
        if (tCur == treasuryImpl && gCur == governorImpl && eCur == executionImpl) {
            revert NaveErrors.AlreadyOnLatestImpl();
        }

        // Consume before upgrades (no replay).
        prop.status = uint8(ProposalStatus.Executed);

        UUPSUpgradeable(payable(address(treasuryContract))).upgradeToAndCall(treasuryImpl, "");
        UUPSUpgradeable(payable(executionContract)).upgradeToAndCall(executionImpl, "");

        emit ContractUpgradeExecuted(proposalIndex, treasuryImpl, governorImpl, executionImpl);

        // Self-upgrade last so prior logic still runs for the emit above.
        this.upgradeToAndCall(governorImpl, "");
    }

    /// Execution-gated: mark a passed proposal Executed after its request runs.
    /// Restricted to THIS DAO's bound execution clone (C-1): a global
    /// `isNaveExecution` check would let any DAO's execution contract finalize
    /// another DAO's proposals.
    function markExecuted(uint64 index) external {
        if (msg.sender != executionContract) revert NaveErrors.Unauthorized();
        Proposal storage prop = _proposals[index];
        // Only a finalized, Passed proposal can be consumed — never an Active,
        // Failed, Cancelled, or already-Executed one.
        if (prop.status != uint8(ProposalStatus.Passed) || prop.finalizedAt == 0) {
            revert NaveErrors.ProposalNotPassed();
        }
        prop.status = uint8(ProposalStatus.Executed);
    }

    /// DaoStake-gated (P6-3 parity with Solana `mark_moonlight_proposal_executed`):
    /// consume a Passed `MoonlightRequest` / `MoonlightDistribution` proposal so
    /// the same approval can never drive a second moonlight cycle after a
    /// `restoreDao`. Callable only by the protocol's registered `NaveDaoStake`
    /// module, which invokes it right after validating the proposal and before
    /// advancing the moonlight lifecycle.
    function markMoonlightProposalExecuted(uint64 index) external {
        address stake = protocolContract.daoStake();
        if (stake == address(0) || msg.sender != stake) revert NaveErrors.Unauthorized();
        Proposal storage prop = _proposals[index];
        if (
            prop.proposalType != uint8(ProposalType.MoonlightRequest)
                && prop.proposalType != uint8(ProposalType.MoonlightDistribution)
        ) revert NaveErrors.InvalidProposalType();
        if (prop.status != uint8(ProposalStatus.Passed) || prop.finalizedAt == 0) {
            revert NaveErrors.ProposalNotPassed();
        }
        prop.status = uint8(ProposalStatus.Executed);
        emit MoonlightProposalConsumed(index, prop.proposalType);
    }

    // ── Internal ──────────────────────────────────────────────────────────
    function _requireActiveVotable(Proposal storage prop) internal view {
        if (prop.status != uint8(ProposalStatus.Active)) revert NaveErrors.ProposalNotActive();
        if (block.timestamp > prop.votingEnd) revert NaveErrors.VotingPeriodEnded();
    }

    function _applyVoteWeight(Proposal storage prop, uint8 choice, uint256 weight) internal {
        if (choice == uint8(VoteChoice.For)) {
            prop.votesFor += weight;
        } else if (choice == uint8(VoteChoice.Against)) {
            prop.votesAgainst += weight;
        } else {
            prop.votesAbstain += weight;
        }
    }

    function _quorumBps(uint8 proposalType) internal view returns (uint16) {
        if (proposalType == uint8(ProposalType.TokenMint)) {
            return NaveConstants.TOKEN_MINT_QUORUM_BPS;
        }
        if (proposalType == uint8(ProposalType.SwitchVotingSystem)) {
            return NaveConstants.SWITCH_VOTING_QUORUM_BPS;
        }
        // High-impact moonlighting / contract-upgrade proposals clear at least the minimum floor.
        if (
            proposalType == uint8(ProposalType.MoonlightRequest)
                || proposalType == uint8(ProposalType.MoonlightDistribution)
                || proposalType == uint8(ProposalType.ContractUpgrade)
        ) {
            uint16 daoQuorum = treasuryContract.quorumBps();
            return daoQuorum > NaveConstants.MOONLIGHT_MIN_QUORUM_BPS
                ? daoQuorum
                : NaveConstants.MOONLIGHT_MIN_QUORUM_BPS;
        }
        return treasuryContract.quorumBps();
    }

    uint256[45] private __gap;
}
