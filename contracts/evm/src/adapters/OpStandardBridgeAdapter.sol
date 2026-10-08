// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBridgeAdapter} from "../interfaces/IBridgeAdapter.sol";
import {INaveProtocol} from "../interfaces/INaveProtocol.sol";
import {IL2StandardBridge, IL1StandardBridge, IWETH9} from "./external/IBridgeProtocols.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";

/// @title OpStandardBridgeAdapter
/// @notice OP Stack StandardBridge for ETH/WETH between Base and Ethereum.
/// Deployed on L2 (Base) uses L2StandardBridge; on L1 (Ethereum) uses L1StandardBridge.
contract OpStandardBridgeAdapter is IBridgeAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    INaveProtocol public immutable protocol;
    address public immutable bridge;
    address public immutable weth;
    address public immutable remoteWeth;
    uint256 public immutable localChainId;
    uint256 public immutable remoteChainId;
    bool public immutable isL2;
    uint32 public minGasLimit;

    event OpBridgeOut(
        address indexed execution,
        address asset,
        uint256 amount,
        address destTreasury,
        bool nativeEth
    );

    modifier onlyExecution() {
        if (!protocol.isNaveExecution(msg.sender)) revert NaveErrors.Unauthorized();
        _;
    }

    constructor(
        address protocol_,
        address bridge_,
        address weth_,
        address remoteWeth_,
        uint256 localChainId_,
        uint256 remoteChainId_,
        bool isL2_,
        uint32 minGasLimit_
    ) {
        if (protocol_ == address(0) || bridge_ == address(0) || weth_ == address(0)) {
            revert NaveErrors.ZeroAddress();
        }
        protocol = INaveProtocol(protocol_);
        bridge = bridge_;
        weth = weth_;
        remoteWeth = remoteWeth_;
        localChainId = localChainId_;
        remoteChainId = remoteChainId_;
        isL2 = isL2_;
        minGasLimit = minGasLimit_ == 0 ? 200_000 : minGasLimit_;
    }

    function protocolId() external pure returns (string memory) {
        return "op-standard-bridge";
    }

    function supportsRoute(address asset, uint256 destChainId) external view returns (bool) {
        return (asset == weth || asset == address(0)) && destChainId == remoteChainId;
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
        if (asset != weth && asset != address(0)) revert NaveErrors.UnsupportedBridgeRoute();

        bool nativeEth = asset == address(0);
        if (!nativeEth) {
            // Unwrap WETH held by this adapter, then bridge as ETH.
            IWETH9(weth).withdraw(amount);
        } else if (address(this).balance < amount) {
            revert NaveErrors.MathOverflow();
        }

        if (isL2) {
            IL2StandardBridge(bridge).bridgeETHTo{value: amount}(destTreasury, minGasLimit, "");
        } else {
            IL1StandardBridge(bridge).bridgeETHTo{value: amount}(destTreasury, minGasLimit, "");
        }

        correlationId = keccak256(
            abi.encode("OP_BRIDGE", localChainId, remoteChainId, destTreasury, amount, block.number)
        );
        emit OpBridgeOut(msg.sender, asset == address(0) ? weth : asset, amount, destTreasury, true);
    }

    receive() external payable {}
}
