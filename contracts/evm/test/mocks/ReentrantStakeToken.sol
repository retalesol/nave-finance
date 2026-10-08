// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IStakingReenter {
    function claim() external;
    function unstake(uint256 amount) external;
}

/// @notice ERC-777-style hook token that re-enters {NaveStaking} on a transfer
/// OUT of the staking contract (the reward-payout / principal-return window).
/// Used to prove the `nonReentrant` guard on `claim`/`unstake`/`stake`: the
/// re-entrant call reverts, so a hostile reward/staking token cannot drain the
/// pool by looping the payout. Decimals fixed at 6 to match wNAVE.
contract ReentrantStakeToken is ERC20 {
    address public staking;
    bool public armed;
    /// 0 = re-enter claim(), 1 = re-enter unstake().
    uint8 public mode;
    uint256 public reAmount;

    bool public reentrantReverted;

    constructor() ERC20("ReentrantStake", "RSTK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setStaking(address s) external {
        staking = s;
    }

    function arm(uint8 mode_, uint256 amount_) external {
        armed = true;
        mode = mode_;
        reAmount = amount_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && staking != address(0) && from == staking) {
            armed = false; // one-shot
            if (mode == 0) {
                try IStakingReenter(staking).claim() {
                    reentrantReverted = false;
                } catch {
                    reentrantReverted = true;
                }
            } else {
                try IStakingReenter(staking).unstake(reAmount) {
                    reentrantReverted = false;
                } catch {
                    reentrantReverted = true;
                }
            }
        }
    }
}
