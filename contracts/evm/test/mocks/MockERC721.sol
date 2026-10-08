// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// Minimal mintable ERC-721 for treasury NFT custody/transfer tests.
contract MockERC721 is ERC721 {
    constructor() ERC721("MockNFT", "MNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    /// safeMint exercises the recipient's onERC721Received hook.
    function safeMint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}
