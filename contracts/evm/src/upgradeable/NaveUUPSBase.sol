// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";

/// @title NaveUUPSBase
/// @notice Minimal UUPS upgrade base used by NaveTreasury, NaveGovernor, and NaveExecution
/// (per-DAO UUPS proxies). Omits the `onlyProxy` / `notDelegated` guards and the
/// `UPGRADE_INTERFACE_VERSION` constant from OpenZeppelin's full UUPSUpgradeable to stay
/// under the EIP-170 24 KB limit. The security guarantee is preserved by:
///   1. `_authorizeUpgrade` enforcing governor-only + protocol-approved-implementation checks.
///   2. The proxy (`NaveERC1967Proxy`) forwarding all calls via DELEGATECALL, so there is
///      no way for the implementation to receive an `upgradeToAndCall` without going through
///      the proxy.
/// @custom:security-contact security@navefinance.xyz
abstract contract NaveUUPSBase is IERC1822Proxiable {
    /// @inheritdoc IERC1822Proxiable
    function proxiableUUID() external pure returns (bytes32) {
        return ERC1967Utils.IMPLEMENTATION_SLOT;
    }

    /// @notice Upgrade the proxy to `newImplementation` and optionally call `data`.
    /// Restricted by `_authorizeUpgrade`.
    function upgradeToAndCall(address newImplementation, bytes memory data) public payable virtual {
        _authorizeUpgrade(newImplementation);
        ERC1967Utils.upgradeToAndCall(newImplementation, data);
    }

    /// @dev Override to enforce access control on upgrades.
    function _authorizeUpgrade(address newImplementation) internal virtual;
}
