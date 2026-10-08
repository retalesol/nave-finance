// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStrategyAdapter} from "../../src/interfaces/IStrategyAdapter.sol";
import {INaveProtocol} from "../../src/interfaces/INaveProtocol.sol";
import {AssetKind} from "../../src/libraries/NaveEnums.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice A simple in-memory adapter for unit tests: holds deposited funds and
/// can be marked up (simulated yield) via {accrue}. Gated to registered
/// NaveExecution callers, exactly like the production adapters.
contract MockStrategyAdapter is IStrategyAdapter {
    INaveProtocol public immutable protocol;
    mapping(address => mapping(address => uint256)) public deposited; // caller=>asset=>amount
    mapping(address => mapping(address => uint256)) public marked; // caller=>asset=>marked value

    constructor(address protocol_) {
        protocol = INaveProtocol(protocol_);
    }

    modifier onlyExecution() {
        require(protocol.isNaveExecution(msg.sender), "not execution");
        _;
    }

    function assetKind() external pure returns (AssetKind) {
        return AssetKind.Stable;
    }

    function supportsAsset(address) external pure returns (bool) {
        return true;
    }

    function protocolId() external pure returns (string memory) {
        return "mock";
    }

    function deposit(address asset, uint256 amount, uint256)
        external
        onlyExecution
        returns (uint256)
    {
        deposited[msg.sender][asset] += amount;
        marked[msg.sender][asset] += amount;
        return amount;
    }

    function withdraw(address asset, uint256 amount, address to, uint256)
        external
        onlyExecution
        returns (uint256)
    {
        require(amount <= marked[msg.sender][asset], "exceeds");
        // Reduce principal proportionally to the marked value being unwound.
        uint256 mk = marked[msg.sender][asset];
        uint256 principalUnwound = mk == 0 ? 0 : (amount * deposited[msg.sender][asset]) / mk;
        deposited[msg.sender][asset] -= principalUnwound;
        marked[msg.sender][asset] -= amount;
        IERC20(asset).transfer(to, amount);
        return amount;
    }

    function positionValue(address asset) external view returns (uint256) {
        return marked[msg.sender][asset];
    }

    /// Simulate yield: mint `gain` of `asset` to the adapter and mark up the
    /// position for `execution`.
    function accrue(address execution, address asset, uint256 gain) external {
        MockERC20(asset).mint(address(this), gain);
        marked[execution][asset] += gain;
    }
}
