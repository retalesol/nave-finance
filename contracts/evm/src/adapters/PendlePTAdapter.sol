// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {BaseStrategyAdapter} from "./BaseStrategyAdapter.sol";
import {
    IPendleSY,
    IPendleMarket,
    IPendlePYLpOracle,
    IPendleRouter,
    PendleTypes
} from "./external/IExternalProtocols.sol";
import {INaveTreasury} from "../interfaces/INaveTreasury.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";
import {AssetKind} from "../libraries/NaveEnums.sol";

interface INaveExecutionTreasuryView {
    function treasuryContract() external view returns (INaveTreasury);
}

/// @title PendlePTAdapter
/// @notice Buys Pendle principal tokens for one market (Tier 3: fixed rate to
/// maturity). `asset` must be both a valid SY input and output (for PT-sUSDe
/// that is sUSDe). Positions are valued at the market's TWAP PT->SY rate over
/// `twapDuration` (15 minutes unless the market's observation buffer is
/// shorter). Before maturity a position can only be sold back into the
/// market after the DAO's guardian quorum signs an early-exit approval; after
/// maturity PT redeems through the router at par.
contract PendlePTAdapter is BaseStrategyAdapter {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_APPROVAL_WINDOW = 7 days;
    bytes32 public constant EARLY_EXIT_TYPEHASH = keccak256("NAVE_PENDLE_PT_EARLY_EXIT");

    uint32 public immutable twapDuration;
    IPendleRouter public immutable router;
    IPendlePYLpOracle public immutable oracle;
    address public immutable market;
    IPendleSY public immutable sy;
    IERC20 public immutable pt;
    address public immutable yt;
    address public immutable underlying;
    uint256 public immutable maturity;

    /// execution => timestamp until which a pre-maturity exit is allowed
    mapping(address => uint256) public earlyExitApprovedUntil;
    /// execution => approval nonce (replay guard)
    mapping(address => uint256) public earlyExitNonce;

    event EarlyExitApproved(address indexed execution, uint256 until, uint256 signers);

    constructor(
        address protocol_,
        address router_,
        address oracle_,
        address market_,
        address asset_,
        uint32 twapDuration_,
        string memory protocolId_
    ) BaseStrategyAdapter(protocol_, AssetKind.Stable, protocolId_) {
        if (router_ == address(0) || oracle_ == address(0) || market_ == address(0)) {
            revert NaveErrors.ZeroAddress();
        }
        router = IPendleRouter(router_);
        oracle = IPendlePYLpOracle(oracle_);
        market = market_;
        (address sy_, address pt_, address yt_) = IPendleMarket(market_).readTokens();
        sy = IPendleSY(sy_);
        pt = IERC20(pt_);
        yt = yt_;
        maturity = IPendleMarket(market_).expiry();
        if (!IPendleSY(sy_).isValidTokenIn(asset_) || !IPendleSY(sy_).isValidTokenOut(asset_)) {
            revert NaveErrors.UnsupportedAdapter();
        }
        if (twapDuration_ < 300) revert NaveErrors.PendleOracleNotReady();
        (bool grow,, bool oldestOk) = IPendlePYLpOracle(oracle_).getOracleState(market_, twapDuration_);
        if (grow || !oldestOk) revert NaveErrors.PendleOracleNotReady();
        underlying = asset_;
        twapDuration = twapDuration_;
    }

    function matured() public view returns (bool) {
        return block.timestamp >= maturity;
    }

    /// Digest each guardian signs (EIP-191) to approve one early exit window.
    function earlyExitDigest(address execution, uint256 until) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    EARLY_EXIT_TYPEHASH,
                    block.chainid,
                    address(this),
                    execution,
                    earlyExitNonce[execution],
                    until
                )
            )
        );
    }

    /// Record a guardian-quorum approval for `execution` to exit before
    /// maturity until `until`. Signatures must come from distinct guardians of
    /// that DAO's treasury, sorted by signer address, and meet its threshold.
    function approveEarlyExit(address execution, uint256 until, bytes[] calldata signatures)
        external
    {
        if (!protocol.isNaveExecution(execution)) revert NaveErrors.Unauthorized();
        if (until <= block.timestamp || until > block.timestamp + MAX_APPROVAL_WINDOW) {
            revert NaveErrors.InvalidGuardianApproval();
        }
        INaveTreasury treasury = INaveExecutionTreasuryView(execution).treasuryContract();
        uint256 threshold = treasury.guardianThreshold();
        if (threshold == 0 || signatures.length < threshold) {
            revert NaveErrors.InvalidGuardianApproval();
        }
        bytes32 digest = earlyExitDigest(execution, until);
        address last;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= last || !treasury.isGuardian(signer)) {
                revert NaveErrors.InvalidGuardianApproval();
            }
            last = signer;
        }
        earlyExitNonce[execution] += 1;
        earlyExitApprovedUntil[execution] = until;
        emit EarlyExitApproved(execution, until, signatures.length);
    }

    function _supply(address asset, uint256 amount, uint256 minOut) internal override {
        IERC20(asset).forceApprove(address(sy), amount);
        uint256 syOut = sy.deposit(address(this), asset, amount, 0);
        IERC20(address(sy)).forceApprove(address(router), syOut);
        uint256 minPtOut = minOut == 0 ? 0 : _syToPt(sy.previewDeposit(asset, minOut));
        router.swapExactSyForPt(address(this), market, syOut, minPtOut, _approx(), _noLimit());
    }

    function _redeem(address asset, uint256 amount, address to, uint256 minOut)
        internal
        override
        returns (uint256)
    {
        uint256 ptIn = _syToPt(sy.previewDeposit(asset, amount)) + 1;
        uint256 held = pt.balanceOf(address(this));
        if (ptIn > held) ptIn = held;
        uint256 syOut;
        pt.forceApprove(address(router), ptIn);
        if (matured()) {
            syOut = router.redeemPyToSy(address(this), yt, ptIn, 0);
        } else {
            if (block.timestamp > earlyExitApprovedUntil[msg.sender]) revert NaveErrors.PtNotMatured();
            (syOut,) = router.swapExactPtForSy(address(this), market, ptIn, 0, _noLimit());
        }
        return sy.redeem(to, syOut, asset, minOut, false);
    }

    function _totalUnderlying(address asset) internal view override returns (uint256) {
        if (asset != underlying) return 0;
        uint256 syValue = (pt.balanceOf(address(this)) * _ptToSyRate()) / 1e18
            + IERC20(address(sy)).balanceOf(address(this));
        return syValue == 0 ? 0 : sy.previewRedeem(asset, syValue);
    }

    function _supportsAsset(address asset) internal view override returns (bool) {
        return asset == underlying;
    }

    function _requiresSlippageBound() internal pure override returns (bool) {
        return true;
    }

    function _ptToSyRate() internal view returns (uint256) {
        return oracle.getPtToSyRate(market, twapDuration);
    }

    function _syToPt(uint256 syAmount) internal view returns (uint256) {
        return (syAmount * 1e18) / _ptToSyRate();
    }

    function _approx() internal pure returns (PendleTypes.ApproxParams memory) {
        return PendleTypes.ApproxParams({
            guessMin: 0, guessMax: type(uint256).max, guessOffchain: 0, maxIteration: 256, eps: 1e14
        });
    }

    function _noLimit() internal pure returns (PendleTypes.LimitOrderData memory l) {}
}
