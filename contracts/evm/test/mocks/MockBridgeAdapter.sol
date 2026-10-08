// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBridgeAdapter} from "../../src/interfaces/IBridgeAdapter.sol";

/// @notice Minimal bridge adapter for tests: accepts any route and records the
/// last `bridgeOut` call (funds simply stay on the adapter).
contract MockBridgeAdapter is IBridgeAdapter {
    uint256 public bridgedOut;
    address public lastDest;

    function protocolId() external pure returns (string memory) {
        return "mock-bridge";
    }

    function supportsRoute(address, uint256) external pure returns (bool) {
        return true;
    }

    function bridgeOut(address, uint256 amount, uint256, address destTreasury)
        external
        returns (bytes32)
    {
        bridgedOut += amount;
        lastDest = destTreasury;
        return keccak256(abi.encode(amount, destTreasury));
    }
}
