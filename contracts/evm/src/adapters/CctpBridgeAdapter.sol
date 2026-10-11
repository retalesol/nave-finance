// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBridgeAdapter} from "../interfaces/IBridgeAdapter.sol";
import {INaveProtocol} from "../interfaces/INaveProtocol.sol";
import {ITokenMessenger, ITokenMessengerV2} from "./external/IBridgeProtocols.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";

/// @title CctpBridgeAdapter
/// @notice Circle CCTP `depositForBurn` for native USDC. v1 uses the 4-arg
/// method. v2 uses the 7-arg method (destinationCaller 0, maxFee 0, standard
/// finality 2000). Domain 0 is a real Circle domain (Ethereum / Sepolia), so
/// routes are tracked with `hasDomain` rather than treating 0 as unset.
contract CctpBridgeAdapter is IBridgeAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Standard-finality threshold for TokenMessengerV2.
    uint32 public constant V2_MIN_FINALITY = 2000;

    INaveProtocol public immutable protocol;
    ITokenMessenger public immutable tokenMessenger;
    address public immutable usdc;
    uint256 public immutable localChainId;
    bool public immutable messengerV2;

    mapping(uint256 => uint32) public domainForChain;
    mapping(uint256 => bool) public hasDomain;

    event CctpBurn(
        address indexed execution,
        uint256 destChainId,
        address destTreasury,
        uint256 amount,
        uint64 nonce
    );

    modifier onlyExecution() {
        if (!protocol.isNaveExecution(msg.sender)) revert NaveErrors.Unauthorized();
        _;
    }

    constructor(
        address protocol_,
        address tokenMessenger_,
        address usdc_,
        uint256 localChainId_,
        uint256[] memory destChainIds,
        uint32[] memory domains,
        bool messengerV2_
    ) {
        if (
            protocol_ == address(0) || tokenMessenger_ == address(0) || usdc_ == address(0)
                || destChainIds.length != domains.length
        ) revert NaveErrors.ZeroAddress();
        protocol = INaveProtocol(protocol_);
        tokenMessenger = ITokenMessenger(tokenMessenger_);
        usdc = usdc_;
        localChainId = localChainId_;
        messengerV2 = messengerV2_;
        for (uint256 i; i < destChainIds.length; i++) {
            domainForChain[destChainIds[i]] = domains[i];
            hasDomain[destChainIds[i]] = true;
        }
    }

    function protocolId() external pure returns (string memory) {
        return "cctp";
    }

    function supportsRoute(address asset, uint256 destChainId) external view returns (bool) {
        return asset == usdc && destChainId != localChainId && hasDomain[destChainId];
    }

    function bridgeOut(
        address asset,
        uint256 amount,
        uint256 destChainId,
        address destTreasury
    ) external onlyExecution nonReentrant returns (bytes32 correlationId) {
        if (asset != usdc || amount == 0) revert NaveErrors.MathOverflow();
        if (destTreasury == address(0)) revert NaveErrors.ZeroAddress();
        if (!hasDomain[destChainId] || destChainId == localChainId) revert NaveErrors.UnsupportedBridgeRoute();
        uint32 domain = domainForChain[destChainId];

        IERC20(usdc).forceApprove(address(tokenMessenger), amount);
        bytes32 mintRecipient = bytes32(uint256(uint160(destTreasury)));
        uint64 nonce = messengerV2
            ? ITokenMessengerV2(address(tokenMessenger)).depositForBurn(
                amount, domain, mintRecipient, usdc, bytes32(0), 0, V2_MIN_FINALITY
            )
            : tokenMessenger.depositForBurn(amount, domain, mintRecipient, usdc);
        correlationId = keccak256(abi.encode(localChainId, destChainId, nonce, destTreasury, amount));
        emit CctpBurn(msg.sender, destChainId, destTreasury, amount, nonce);
    }
}
