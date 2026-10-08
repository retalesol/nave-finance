// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveErrors} from "../libraries/NaveErrors.sol";

/// @title NaveInitializable
/// @notice Minimal one-shot initializer guard for Nave UUPS proxies.
/// Lighter than OZ Initializable (no reinitializer, no ERC-7201 namespacing,
/// no version counter, no event) while providing the same protection.
/// @custom:security-contact security@navefinance.xyz
abstract contract NaveInitializable {
    // Storage slot for the initialized flag. Uses a fixed known slot to avoid
    // collisions with contract state variables.
    // keccak256(abi.encode(uint256(keccak256("nave.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant _INIT_SLOT =
        0xc7c4bd8fdea0c040f9ab5b1dcd26266f47b5de0c1b3efada8d0c7d3b41920200;

    modifier initializer() {
        bytes32 slot = _INIT_SLOT;
        bool initialized;
        assembly { initialized := sload(slot) }
        if (initialized) revert NaveErrors.AlreadyInitialized();
        assembly { sstore(slot, 1) }
        _;
    }

    /// @dev Lock the implementation contract against direct initialization.
    function _disableInitializers() internal {
        bytes32 slot = _INIT_SLOT;
        assembly { sstore(slot, 1) }
    }
}
