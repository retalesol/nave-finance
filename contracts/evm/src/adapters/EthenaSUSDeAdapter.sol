// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {QueuedExitAdapter} from "./QueuedExitAdapter.sol";
import {IStakedUSDe} from "./external/IExternalProtocols.sol";

/// @title EthenaSUSDeAdapter
/// @notice Stakes USDe into Ethena sUSDe (Tier 3: synthetic-dollar basis
/// yield). Exits wait out sUSDe's on-chain `cooldownDuration`; when Ethena
/// sets it to zero the exit settles immediately through ERC-4626 `withdraw`.
contract EthenaSUSDeAdapter is QueuedExitAdapter {
    using SafeERC20 for IERC20;

    IERC4626 public immutable sUSDe;

    constructor(address protocol_, address sUSDe_)
        QueuedExitAdapter(protocol_, IERC4626(sUSDe_).asset(), "ethena-susde")
    {
        sUSDe = IERC4626(sUSDe_);
    }

    /// Current exit delay in seconds, read from Ethena.
    function exitDelay() external view returns (uint256) {
        return IStakedUSDe(address(sUSDe)).cooldownDuration();
    }

    function _supply(address asset, uint256 amount, uint256) internal override {
        IERC20(asset).forceApprove(address(sUSDe), amount);
        sUSDe.deposit(amount, address(this));
    }

    function _totalUnderlying(address asset) internal view override returns (uint256) {
        if (asset != underlying) return 0;
        return sUSDe.previewRedeem(sUSDe.balanceOf(address(this)));
    }

    function _startVenueExit(uint256 amount) internal override returns (uint256) {
        IStakedUSDe s = IStakedUSDe(address(sUSDe));
        if (s.cooldownDuration() == 0) {
            sUSDe.withdraw(amount, address(this), address(this));
            return block.timestamp;
        }
        s.cooldownAssets(amount);
        (uint104 end,) = s.cooldowns(address(this));
        return end;
    }

    function _venueExitDone() internal view override returns (bool) {
        (uint104 end, uint152 queued) = IStakedUSDe(address(sUSDe)).cooldowns(address(this));
        return queued == 0 || block.timestamp >= end;
    }

    function _finishVenueExit() internal override {
        (, uint152 queued) = IStakedUSDe(address(sUSDe)).cooldowns(address(this));
        if (queued > 0) IStakedUSDe(address(sUSDe)).unstake(address(this));
    }
}
