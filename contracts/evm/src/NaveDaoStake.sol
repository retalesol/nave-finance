// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {INaveProtocol} from "./interfaces/INaveProtocol.sol";
import {INaveGovernor} from "./interfaces/INaveGovernor.sol";
import {INaveTreasury} from "./interfaces/INaveTreasury.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";
import {ProposalStatus, ProposalType, MoonlightStatus} from "./libraries/NaveEnums.sol";

/// @title NaveDaoStake
/// @notice Per-chain UUPS singleton for an optional legacy wrapped-NAVE lock
/// and the moonlight lifecycle. New treasuries are not locked at creation.
/// Moonlight releases a lock that already exists and does not require one.
/// Restoring a moonlighted treasury does not lock new NAVE.
contract NaveDaoStake is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    INaveProtocol public protocol;

    struct StakeRecord {
        address founder;
        address token;
        uint256 amount;
        bool released;
        uint256 priceUsdMicro;
        uint8 moonlightStatus;
        address recipient;
        address initiatedBy;
        uint64 requestProposal;
        uint64 distributionProposal;
    }

    mapping(address => StakeRecord) public stakes;

    event StakeLocked(
        address indexed treasury, address founder, address token, uint256 amount, uint256 priceUsdMicro
    );
    event StakeReleased(address indexed treasury, address recipient, uint256 amount);
    event MoonlightRequested(address indexed treasury, uint64 requestProposal, address requestedBy);
    event MoonlightRecipientSet(address indexed treasury, address recipient, address initiatedBy);
    event MoonlightDistributed(
        address indexed treasury, uint64 distributionProposal, address recipient, uint256 stakeAmount
    );
    event DaoMoonlighted(address indexed treasury, address recipient);
    event DaoRestored(address indexed treasury, address founder, uint256 restakedAmount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address protocol_) external initializer {
        if (owner_ == address(0) || protocol_ == address(0)) revert NaveErrors.ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        protocol = INaveProtocol(protocol_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function lockStake(
        address treasury,
        address founder,
        address token,
        uint256 amount,
        uint256 priceUsdMicro
    ) external nonReentrant {
        if (msg.sender != protocol.factory()) revert NaveErrors.Unauthorized();
        if (token == address(0) || treasury == address(0)) revert NaveErrors.ZeroAddress();
        if (amount == 0) revert NaveErrors.StakeAmountTooLow();
        StakeRecord storage s = stakes[treasury];
        if (s.token != address(0)) revert NaveErrors.StakeAlreadyExists();

        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(founder, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - beforeBal;
        if (received < amount) revert NaveErrors.StakeAmountTooLow();

        s.founder = founder;
        s.token = token;
        s.amount = amount;
        s.released = false;
        s.priceUsdMicro = priceUsdMicro;
        s.moonlightStatus = uint8(MoonlightStatus.Active);
        emit StakeLocked(treasury, founder, token, amount, priceUsdMicro);
    }

    function recordMoonlightRequest(address treasury, address governor, uint64 proposalIndex)
        external
    {
        _requireBoundGovernor(treasury, governor);
        StakeRecord storage s = stakes[treasury];
        // A treasury that never locked NAVE still needs a lifecycle record.
        if (s.founder == address(0) && s.token == address(0)) {
            address founder_ = INaveTreasury(treasury).founder();
            if (founder_ == address(0)) revert NaveErrors.StakeNotFound();
            s.founder = founder_;
            s.moonlightStatus = uint8(MoonlightStatus.Active);
        }
        if (s.moonlightStatus != uint8(MoonlightStatus.Active)) {
            revert NaveErrors.MoonlightInvalidStatus();
        }
        (uint8 pType, uint8 status,, uint256 finalizedAt, address proposer) =
            INaveGovernor(governor).proposalCore(proposalIndex);
        if (
            pType != uint8(ProposalType.MoonlightRequest) || status != uint8(ProposalStatus.Passed)
                || finalizedAt == 0
        ) revert NaveErrors.MoonlightProposalInvalid();
        // P6-3: consume the approval (Passed -> Executed) so the same proposal
        // cannot re-trigger a moonlight cycle after `restoreDao`.
        INaveGovernor(governor).markMoonlightProposalExecuted(proposalIndex);

        s.moonlightStatus = uint8(MoonlightStatus.Requested);
        s.initiatedBy = proposer;
        s.requestProposal = proposalIndex;
        emit MoonlightRequested(treasury, proposalIndex, proposer);
    }

    function setMoonlightRecipient(address treasury, address recipient) external {
        StakeRecord storage s = stakes[treasury];
        if (s.founder == address(0) && s.token == address(0)) revert NaveErrors.StakeNotFound();
        if (s.moonlightStatus != uint8(MoonlightStatus.Requested)) {
            revert NaveErrors.MoonlightInvalidStatus();
        }
        if (msg.sender != s.initiatedBy) revert NaveErrors.Unauthorized();
        if (recipient == address(0)) revert NaveErrors.MoonlightRecipientMismatch();
        s.recipient = recipient;
        s.moonlightStatus = uint8(MoonlightStatus.DistributionPending);
        emit MoonlightRecipientSet(treasury, recipient, msg.sender);
    }

    function executeMoonlightDistribution(address treasury, address governor, uint64 proposalIndex)
        external
        nonReentrant
    {
        StakeRecord storage s = _bind(treasury, governor);
        if (
            s.moonlightStatus != uint8(MoonlightStatus.DistributionPending)
                && s.moonlightStatus != uint8(MoonlightStatus.Distributing)
        ) revert NaveErrors.MoonlightInvalidStatus();

        (uint8 pType, uint8 status, bytes32 payloadHash, uint256 finalizedAt, address proposer) =
            INaveGovernor(governor).proposalCore(proposalIndex);
        if (
            pType != uint8(ProposalType.MoonlightDistribution)
                || status != uint8(ProposalStatus.Passed) || finalizedAt == 0
        ) revert NaveErrors.MoonlightProposalInvalid();
        if (proposer != s.initiatedBy) revert NaveErrors.Unauthorized();
        if (payloadHash != keccak256(abi.encode(s.recipient))) {
            revert NaveErrors.MoonlightRecipientMismatch();
        }
        // P6-3: consume the distribution approval before moving the stake.
        INaveGovernor(governor).markMoonlightProposalExecuted(proposalIndex);

        s.moonlightStatus = uint8(MoonlightStatus.Distributing);
        s.distributionProposal = proposalIndex;

        uint256 amount = s.amount;
        if (!s.released && amount > 0) {
            s.released = true;
            s.amount = 0;
            IERC20(s.token).safeTransfer(s.recipient, amount);
            emit StakeReleased(treasury, s.recipient, amount);
        }
        emit MoonlightDistributed(treasury, proposalIndex, s.recipient, amount);
    }

    function finalizeMoonlight(address treasury) external {
        StakeRecord storage s = stakes[treasury];
        if (s.founder == address(0) && s.token == address(0)) revert NaveErrors.StakeNotFound();
        if (s.moonlightStatus != uint8(MoonlightStatus.Distributing)) {
            revert NaveErrors.MoonlightInvalidStatus();
        }
        if (msg.sender != s.founder && msg.sender != s.initiatedBy) revert NaveErrors.Unauthorized();
        s.moonlightStatus = uint8(MoonlightStatus.Moonlighted);
        emit DaoMoonlighted(treasury, s.recipient);
    }

    /// Reopen a moonlighted treasury. `amount` and `priceUsdMicro` stay in the
    /// signature so existing calldata still decodes; they are not applied.
    /// Does not pull a new NAVE lock. An existing released lock stays released.
    function restoreDao(address treasury, uint256, uint256) external nonReentrant {
        StakeRecord storage s = stakes[treasury];
        if (s.founder == address(0) && s.token == address(0)) revert NaveErrors.StakeNotFound();
        if (s.moonlightStatus != uint8(MoonlightStatus.Moonlighted)) {
            revert NaveErrors.MoonlightInvalidStatus();
        }
        if (msg.sender != s.founder) revert NaveErrors.Unauthorized();

        s.moonlightStatus = uint8(MoonlightStatus.Active);
        s.recipient = address(0);
        s.initiatedBy = address(0);
        s.requestProposal = 0;
        s.distributionProposal = 0;
        emit DaoRestored(treasury, msg.sender, 0);
    }

    function isMoonlighting(address treasury) external view returns (bool) {
        uint8 st = stakes[treasury].moonlightStatus;
        return st != uint8(MoonlightStatus.Active);
    }

    function moonlightStatus(address treasury) external view returns (uint8) {
        return stakes[treasury].moonlightStatus;
    }

    function _requireBoundGovernor(address treasury, address governor) internal view {
        if (!protocol.isNaveGovernor(governor)) revert NaveErrors.Unauthorized();
        if (INaveGovernor(governor).treasury() != treasury) revert NaveErrors.Unauthorized();
    }

    function _bind(address treasury, address governor)
        internal
        view
        returns (StakeRecord storage s)
    {
        _requireBoundGovernor(treasury, governor);
        s = stakes[treasury];
        if (s.founder == address(0) && s.token == address(0)) revert NaveErrors.StakeNotFound();
    }

    uint256[48] private __gap;
}
