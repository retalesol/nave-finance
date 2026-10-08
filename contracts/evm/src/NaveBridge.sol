// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {NaveErrors} from "./libraries/NaveErrors.sol";

/// Minimal mint surface of {WrappedNave} the lockbox needs.
interface IWrappedNaveMintable {
    function mint(address to, uint256 amount) external;
    function acceptMinter() external;
}

/// @title NaveBridge
/// @notice Inbound minting lockbox for the Nave NAVE <-> wNAVE trusted-relayer
/// bridge on EVM. This contract is set as the sole `minter` of {WrappedNave},
/// so ALL wrapped supply is created here, behind on-chain guardrails that a
/// bare relayer EOA cannot provide:
///
/// * Pause circuit breaker (owner / multisig) — halts inbound mints instantly.
/// * Per-transaction cap and rolling 24h cap — bound the blast radius of a
///   compromised relayer key to a known daily maximum rather than the full
///   `supplyCap`.
/// * Per-message replay guard (`processed[srcChainId, srcNonce]`) — the same
///   Solana lock can never be minted twice, independent of any off-chain DB.
/// * Two-step ownership handoff — safe transfer to a Safe/multisig.
///
/// The OUTBOUND direction (burn-to-bridge-back) lives on {WrappedNave} itself
/// via `bridgeBurn(amount, solanaRecipient)`, so bridging out is a single
/// signature with the recipient embedded. Fees are resolved on Solana in both
/// directions, so this contract only ever mints the NET amount.
contract NaveBridge is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    /// The wrapped NAVE token this lockbox mints.
    IWrappedNaveMintable public wnave;

    /// The single relayer hot key allowed to call {bridgeIn}.
    address public relayer;

    /// Inbound-mint circuit breaker.
    bool public paused;

    /// Per-transaction cap on the minted net amount (0 = unlimited).
    uint256 public perTxCap;
    /// Rolling 24h cap on total minted net amount (0 = unlimited).
    uint256 public dailyCap;
    /// Net amount minted so far in the current rolling window.
    uint256 public dailyMinted;
    /// Unix timestamp marking the start of the current rolling window.
    uint256 public windowStart;

    /// Replay guard: keccak256(srcChainId, srcNonce) => processed.
    mapping(bytes32 => bool) public processed;

    /// Rolling-cap window length. NOTE (L2 compat): the window logic uses
    /// `block.timestamp` ONLY — never `block.number` / `blockhash` /
    /// `prevrandao` — so it behaves identically on Arbitrum Nitro chains
    /// (e.g. Robinhood Chain), where `block.number` is an L1 estimate.
    uint256 private constant DAILY_WINDOW = 1 days;

    event BridgeIn(
        address indexed recipient,
        uint256 netAmount,
        uint64 indexed srcChainId,
        uint64 indexed srcNonce
    );
    event PausedSet(bool paused);
    event RelayerUpdated(address indexed previous, address indexed current);
    event CapsUpdated(uint256 perTxCap, uint256 dailyCap);

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NaveErrors.Unauthorized();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address wnave_,
        address owner_,
        address relayer_,
        uint256 perTxCap_,
        uint256 dailyCap_
    ) external initializer {
        if (wnave_ == address(0) || owner_ == address(0) || relayer_ == address(0)) {
            revert NaveErrors.ZeroAddress();
        }
        // The relayer hot key must never also be the owner: a single compromised
        // key could then both mint and lift pause / caps.
        if (relayer_ == owner_) revert NaveErrors.PrivilegedRolesMustDiffer();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        wnave = IWrappedNaveMintable(wnave_);
        relayer = relayer_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        windowStart = block.timestamp;
        emit RelayerUpdated(address(0), relayer_);
        emit CapsUpdated(perTxCap_, dailyCap_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// Relayer-only: mint `netAmount` wNAVE to `recipient` for a verified Solana
    /// lock identified by `(srcChainId, srcNonce)`. Guarded by pause, per-tx +
    /// rolling daily caps, and the per-message replay map. Fees are resolved on
    /// Solana, so only the net is minted here.
    function bridgeIn(address recipient, uint256 netAmount, uint64 srcChainId, uint64 srcNonce)
        external
        onlyRelayer
    {
        if (paused) revert NaveErrors.BridgePaused();
        if (recipient == address(0)) revert NaveErrors.InvalidRecipient();
        if (netAmount == 0) revert NaveErrors.ZeroAmount();
        if (perTxCap != 0 && netAmount > perTxCap) revert NaveErrors.PerTxCapExceeded();

        bytes32 key = keccak256(abi.encodePacked(srcChainId, srcNonce));
        if (processed[key]) revert NaveErrors.AlreadyProcessed();

        // Rolling daily cap (window resets after 24h).
        if (block.timestamp - windowStart >= DAILY_WINDOW) {
            windowStart = block.timestamp;
            dailyMinted = 0;
        }
        if (dailyCap != 0) {
            uint256 projected = dailyMinted + netAmount;
            if (projected > dailyCap) revert NaveErrors.DailyCapExceeded();
            dailyMinted = projected;
        }

        // Effects before the external mint (checks-effects-interactions).
        processed[key] = true;

        emit BridgeIn(recipient, netAmount, srcChainId, srcNonce);
        wnave.mint(recipient, netAmount);
    }

    // ── Admin (owner / multisig) ───────────────────────────────────────────

    /// Complete the two-step {WrappedNave} minter rotation: after the token
    /// owner proposes this lockbox via `setMinter(address(this))`, the lockbox
    /// owner calls this so the CONTRACT claims the role (contracts cannot sign,
    /// so the claim must be relayed through an owner-gated call).
    function acceptMinterRole() external onlyOwner {
        wnave.acceptMinter();
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert NaveErrors.ZeroAddress();
        if (newRelayer == owner() || newRelayer == pendingOwner()) {
            revert NaveErrors.PrivilegedRolesMustDiffer();
        }
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    /// Two-step ownership handoff may not target the relayer hot key.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == relayer) revert NaveErrors.PrivilegedRolesMustDiffer();
        super.transferOwnership(newOwner);
    }

    function setCaps(uint256 perTxCap_, uint256 dailyCap_) external onlyOwner {
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        emit CapsUpdated(perTxCap_, dailyCap_);
    }

    uint256[40] private __gap;
}
