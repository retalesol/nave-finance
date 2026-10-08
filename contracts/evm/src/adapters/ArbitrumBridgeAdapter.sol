// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBridgeAdapter} from "../interfaces/IBridgeAdapter.sol";
import {INaveProtocol} from "../interfaces/INaveProtocol.sol";
import {IArbGatewayRouter, IWETH9} from "./external/IBridgeProtocols.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";

/// @title ArbitrumBridgeAdapter
/// @notice Arbitrum Nitro gateway router for ETH/WETH between Robinhood Chain
/// (Nitro L2) and Ethereum. USDC should prefer CCTP when the domain is live.
contract ArbitrumBridgeAdapter is IBridgeAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    INaveProtocol public immutable protocol;
    IArbGatewayRouter public immutable gatewayRouter;
    address public immutable weth;
    /// L2 WETH (or native wrapper) that the gateway accepts for outbound ETH.
    address public immutable bridgeableWeth;
    uint256 public immutable localChainId;
    uint256 public immutable remoteChainId;

    event ArbBridgeOut(
        address indexed execution, address asset, uint256 amount, address destTreasury
    );

    modifier onlyExecution() {
        if (!protocol.isNaveExecution(msg.sender)) revert NaveErrors.Unauthorized();
        _;
    }

    constructor(
        address protocol_,
        address gatewayRouter_,
        address weth_,
        address bridgeableWeth_,
        uint256 localChainId_,
        uint256 remoteChainId_
    ) {
        if (
            protocol_ == address(0) || gatewayRouter_ == address(0) || weth_ == address(0)
                || bridgeableWeth_ == address(0)
        ) revert NaveErrors.ZeroAddress();
        protocol = INaveProtocol(protocol_);
        gatewayRouter = IArbGatewayRouter(gatewayRouter_);
        weth = weth_;
        bridgeableWeth = bridgeableWeth_;
        localChainId = localChainId_;
        remoteChainId = remoteChainId_;
    }

    function protocolId() external pure returns (string memory) {
        return "arbitrum-bridge";
    }

    function supportsRoute(address asset, uint256 destChainId) external view returns (bool) {
        return (asset == weth || asset == bridgeableWeth) && destChainId == remoteChainId;
    }

    function bridgeOut(
        address asset,
        uint256 amount,
        uint256 destChainId,
        address destTreasury
    ) external onlyExecution nonReentrant returns (bytes32 correlationId) {
        if (amount == 0) revert NaveErrors.MathOverflow();
        if (destTreasury == address(0)) revert NaveErrors.ZeroAddress();
        if (destChainId != remoteChainId) revert NaveErrors.UnsupportedBridgeRoute();
        if (asset != weth && asset != bridgeableWeth) revert NaveErrors.UnsupportedBridgeRoute();

        address token = asset;
        IERC20(token).forceApprove(address(gatewayRouter), amount);
        // Minimal outbound: gateway pulls tokens and credits L1 `destTreasury`.
        gatewayRouter.outboundTransfer(token, destTreasury, amount, "");

        correlationId = keccak256(
            abi.encode("ARB_BRIDGE", localChainId, remoteChainId, destTreasury, amount, block.number)
        );
        emit ArbBridgeOut(msg.sender, token, amount, destTreasury);
    }
}
