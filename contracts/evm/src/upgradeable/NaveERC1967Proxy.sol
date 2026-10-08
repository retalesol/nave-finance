// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title NaveERC1967Proxy
/// @notice ERC1967 proxy that may be constructed with empty init data so the
/// factory can `registerDao` then `initialize` in the same transaction
/// (daoId is assigned at registration and required by initialize).
contract NaveERC1967Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory _data) payable ERC1967Proxy(implementation, _data) {}

    function _unsafeAllowUninitialized() internal pure override returns (bool) {
        return true;
    }
}
