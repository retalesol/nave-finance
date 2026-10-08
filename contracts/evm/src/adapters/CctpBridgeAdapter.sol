// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBridgeAdapter} from "../interfaces/IBridgeAdapter.sol";
import {INaveProtocol} from "../interfaces/INaveProtocol.sol";
import {ITokenMessenger} from "./external/IBridgeProtocols.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";

/// @title CctpBridgeAdapter
/// @notice Circle CCTP v1 TokenMessenger `depositForBurn` for native USDC
/// hops between Ethereum / Base / (Robinhood when domain is configured).
contract CctpBridgeAdapter is IBridgeAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    INaveProtocol public immutable protocol;
    ITokenMessenger public immutable tokenMessenger;
    address public immutable usdc;
    uint256 public immutable localChainId;

    mapping(uint256 => uint32) public domainForChain;

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
        uint32[] memory domains
    ) {
        if (
            protocol_ == address(0) || tokenMessenger_ == address(0) || usdc_ == address(0)
                || destChainIds.length != domains.length
        ) revert NaveErrors.ZeroAddress();
        protocol = INaveProtocol(protocol_);
        tokenMessenger = ITokenMessenger(tokenMessenger_);
        usdc = usdc_;
        localChainId = localChainId_;
        for (uint256 i; i < destChainIds.length; i++) {
            domainForChain[destChainIds[i]] = domains[i];
        }
    }

    function protocolId() external pure returns (string memory) {
        return "cctp";
    }

    function supportsRoute(address asset, uint256 destChainId) external view returns (bool) {
        return asset == usdc && destChainId != localChainId && domainForChain[destChainId] != 0;
    }

    function bridgeOut(
        address asset,
        uint256 amount,
        uint256 destChainId,
        address destTreasury
    ) external onlyExecution nonReentrant returns (bytes32 correlationId) {
        if (asset != usdc || amount == 0) revert NaveErrors.MathOverflow();
        if (destTreasury == address(0)) revert NaveErrors.ZeroAddress();
        uint32 domain = domainForChain[destChainId];
        if (domain == 0 || destChainId == localChainId) revert NaveErrors.UnsupportedBridgeRoute();

        IERC20(usdc).forceApprove(address(tokenMessenger), amount);
        bytes32 mintRecipient = bytes32(uint256(uint160(destTreasury)));
        uint64 nonce = tokenMessenger.depositForBurn(amount, domain, mintRecipient, usdc);
        correlationId = keccak256(abi.encode(localChainId, destChainId, nonce, destTreasury, amount));
        emit CctpBurn(msg.sender, destChainId, destTreasury, amount, nonce);
    }
}
