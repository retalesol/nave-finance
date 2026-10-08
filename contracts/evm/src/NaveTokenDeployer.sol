// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveDaoToken} from "./NaveDaoToken.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";

/// @title NaveTokenDeployer
/// @notice Shared helper that deploys {NaveDaoToken} instances on behalf of a
/// treasury. Extracting the token creation bytecode here keeps `NaveTreasury`
/// under the EIP-170 24KB runtime limit. The deployed token's `controller`
/// (sole minter) is set to the calling treasury.
contract NaveTokenDeployer {
    function deploy(
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address controller,
        uint256 initialSupply,
        address initialRecipient
    ) external returns (address) {
        // A caller may only deploy a token controlled (minted) by itself. This
        // stops an arbitrary EOA from minting a NaveDaoToken whose controller is
        // some other treasury/address to impersonate an official governance
        // token (audit M-1). Treasuries call this with controller == address(this).
        if (controller != msg.sender) revert NaveErrors.Unauthorized();
        // A non-zero initial supply must have a real recipient, else OpenZeppelin
        // reverts deep in _mint with a confusing ERC20InvalidReceiver (audit L-7).
        if (initialSupply > 0 && initialRecipient == address(0)) {
            revert NaveErrors.ZeroAddress();
        }
        NaveDaoToken token = new NaveDaoToken(
            name, symbol, decimals, controller, initialSupply, initialRecipient
        );
        return address(token);
    }
}
