// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Minimal sUSDe stand-in: ERC-4626 share math over `asset`, with Ethena's
/// cooldown exit (`cooldownAssets` -> wait -> `unstake`).
contract MockStakedUSDe {
    IERC20 public immutable assetToken;
    uint24 public cooldownDuration = 1 days;
    uint256 public totalSupply;
    uint256 public totalManaged;
    mapping(address => uint256) public balanceOf;

    struct Cooldown {
        uint104 cooldownEnd;
        uint152 underlyingAmount;
    }

    mapping(address => Cooldown) public cooldowns;

    constructor(address asset_) {
        assetToken = IERC20(asset_);
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function setCooldownDuration(uint24 d) external {
        cooldownDuration = d;
    }

    /// Simulate staking rewards landing in the vault.
    function accrue(uint256 amount) external {
        assetToken.transferFrom(msg.sender, address(this), amount);
        totalManaged += amount;
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return totalSupply == 0 ? shares : (shares * totalManaged) / totalSupply;
    }

    function _toShares(uint256 assets, bool up) internal view returns (uint256) {
        if (totalSupply == 0) return assets;
        uint256 s = (assets * totalSupply) / totalManaged;
        if (up && s * totalManaged < assets * totalSupply) s += 1;
        return s;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = _toShares(assets, false);
        assetToken.transferFrom(msg.sender, address(this), assets);
        totalManaged += assets;
        totalSupply += shares;
        balanceOf[receiver] += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(cooldownDuration == 0, "cooldown on");
        shares = _toShares(assets, true);
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        totalManaged -= assets;
        assetToken.transfer(receiver, assets);
    }

    function cooldownAssets(uint256 assets) external returns (uint256 shares) {
        require(cooldownDuration != 0, "cooldown off");
        shares = _toShares(assets, true);
        balanceOf[msg.sender] -= shares;
        totalSupply -= shares;
        totalManaged -= assets;
        Cooldown storage c = cooldowns[msg.sender];
        c.cooldownEnd = uint104(block.timestamp + cooldownDuration);
        c.underlyingAmount += uint152(assets);
    }

    function unstake(address receiver) external {
        Cooldown storage c = cooldowns[msg.sender];
        require(block.timestamp >= c.cooldownEnd, "cooling");
        uint256 amount = c.underlyingAmount;
        c.underlyingAmount = 0;
        c.cooldownEnd = 0;
        assetToken.transfer(receiver, amount);
    }
}
