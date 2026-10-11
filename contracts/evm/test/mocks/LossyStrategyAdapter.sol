// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStrategyAdapter} from "../../src/interfaces/IStrategyAdapter.sol";
import {INaveProtocol} from "../../src/interfaces/INaveProtocol.sol";
import {AssetKind} from "../../src/libraries/NaveEnums.sol";

/// @notice Like {MockStrategyAdapter}, but `withdraw` returns `lossBps` less
/// underlying than requested — modelling a lossy Balancer/Curve exit — so the
/// EVM-H2 accounting fix (book the ACTUAL `underlyingOut`, revert beyond the
/// shortfall tolerance) can be regression-tested. The shortfall stays in the
/// adapter (as slippage would stay in the pool).
contract LossyStrategyAdapter is IStrategyAdapter {
    INaveProtocol public immutable protocol;
    uint16 public lossBps;
    /// Share of a deposit that never shows up in `positionValue` (join slippage).
    uint16 public depositLossBps;
    mapping(address => mapping(address => uint256)) public deposited; // caller=>asset=>amount
    mapping(address => mapping(address => uint256)) public marked; // caller=>asset=>marked value

    constructor(address protocol_) {
        protocol = INaveProtocol(protocol_);
    }

    modifier onlyExecution() {
        require(protocol.isNaveExecution(msg.sender), "not execution");
        _;
    }

    function setLossBps(uint16 bps) external {
        lossBps = bps;
    }

    function setDepositLossBps(uint16 bps) external {
        depositLossBps = bps;
    }

    function assetKind() external pure returns (AssetKind) {
        return AssetKind.Stable;
    }

    function supportsAsset(address) external pure returns (bool) {
        return true;
    }

    function protocolId() external pure returns (string memory) {
        return "lossy-mock";
    }

    function deposit(address asset, uint256 amount, uint256)
        external
        onlyExecution
        returns (uint256)
    {
        uint256 booked = amount - (amount * depositLossBps) / 10_000;
        deposited[msg.sender][asset] += booked;
        marked[msg.sender][asset] += booked;
        return booked;
    }

    function withdraw(address asset, uint256 amount, address to, uint256)
        external
        onlyExecution
        returns (uint256 underlyingOut)
    {
        require(amount <= marked[msg.sender][asset], "exceeds");
        uint256 mk = marked[msg.sender][asset];
        uint256 principalUnwound = mk == 0 ? 0 : (amount * deposited[msg.sender][asset]) / mk;
        deposited[msg.sender][asset] -= principalUnwound;
        marked[msg.sender][asset] -= amount;
        underlyingOut = amount - (amount * lossBps) / 10_000;
        IERC20(asset).transfer(to, underlyingOut);
    }

    function positionValue(address asset) external view returns (uint256) {
        return marked[msg.sender][asset];
    }
}
