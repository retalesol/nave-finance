// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {NaveErrors} from "./libraries/NaveErrors.sol";

/// @title NaveStaking
/// @notice EVM (Base / Ethereum) staking mirror for the Nave bridge. Users
/// stake wNAVE here and earn a share of the protocol's bridge fees. Fees accrue
/// centrally on Solana; the relayer periodically computes THIS chain's share
/// (by staked weight vs. the global total) and delivers it as wNAVE via
/// {notifyReward} — i.e. "wrap NAVE and reward it as wNAVE" on the EVM side.
/// Stake/unstake emit events the relayer mirrors back to the Solana central
/// pool so global reward weight stays consistent across chains.
///
/// Rewards are emitted as a **rolling time-metered drip** (Synthetix
/// `StakingRewards` pattern): each {notifyReward} folds the new amount plus any
/// undripped leftover into a fresh `rewardsDuration` window (default 365 days),
/// so realized APY tracks whatever fees actually arrive. Accrual is lazy — the
/// MasterChef accumulator (`accRewardPerShare`) is advanced by elapsed time on
/// every interaction — which is mathematically identical to per-second updates.
///
/// Accounting is O(1) per action and hardened with `ReentrancyGuard` +
/// `SafeERC20`.
contract NaveStaking is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// The staked + reward token (wNAVE). Same token for principal and rewards.
    IERC20 public stakingToken;

    /// The relayer allowed to deliver cross-chain reward top-ups.
    address public rewarder;

    /// Pause stake + claim (unstake stays open so users can always exit).
    bool public paused;

    uint256 private constant ACC_SCALE = 1e12;

    /// Accumulated reward per staked unit, scaled by ACC_SCALE.
    uint256 public accRewardPerShare;
    /// Total principal staked.
    uint256 public totalStaked;

    // ── Drip schedule (Synthetix rolling window) ───────────────────────────
    /// Reward tokens emitted per second over the active window.
    uint256 public rewardRate;
    /// Unix timestamp at which the current drip window ends.
    uint256 public periodFinish;
    /// Last timestamp the accumulator was advanced (capped at `periodFinish`).
    uint256 public lastUpdateTime;
    /// Length of each rolling drip window (default 365 days).
    uint256 public rewardsDuration;

    // ── Dust accounting (audit low: rewardRate truncation) ─────────────────
    /// Cumulative reward tokens actually metered into the accumulator (i.e.
    /// `rewardRate * elapsed`, summed). Tokens delivered via {notifyReward} but
    /// lost to integer truncation of `rewardRate` are never counted here, so
    /// they surface as sweepable dust. Only advances while something is staked.
    uint256 public rewardsDistributed;
    /// Cumulative reward tokens withdrawn via {claim}.
    uint256 public rewardsClaimed;

    struct UserInfo {
        uint256 amount; // staked principal
        uint256 rewardDebt; // amount * accRewardPerShare / ACC_SCALE at last touch
        uint256 pending; // accrued-but-unclaimed rewards
    }

    mapping(address => UserInfo) public users;

    event Staked(address indexed user, uint256 amount, uint256 totalStaked);
    event Unstaked(address indexed user, uint256 amount, uint256 totalStaked);
    event RewardClaimed(address indexed user, uint256 amount);
    event RewardNotified(uint256 amount, uint256 rewardRate, uint256 periodFinish);
    event RewardsDurationUpdated(uint256 duration);
    event PausedSet(bool paused);
    event RewarderUpdated(address indexed previous, address indexed current);
    event DustSwept(address indexed to, uint256 amount);

    modifier onlyRewarder() {
        if (msg.sender != rewarder) revert NaveErrors.Unauthorized();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address stakingToken_, address owner_, address rewarder_) external initializer {
        if (stakingToken_ == address(0) || owner_ == address(0) || rewarder_ == address(0)) {
            revert NaveErrors.ZeroAddress();
        }
        // Relayer (rewarder) hot key and owner must be distinct keys.
        if (rewarder_ == owner_) revert NaveErrors.PrivilegedRolesMustDiffer();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        stakingToken = IERC20(stakingToken_);
        rewarder = rewarder_;
        rewardsDuration = 365 days;
        emit RewarderUpdated(address(0), rewarder_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// Advance `accRewardPerShare` by the reward that has dripped since the last
    /// touch, capped at `periodFinish`. No-op emission when nothing is staked,
    /// but `lastUpdateTime` still advances (undripped time while empty is
    /// forfeited, matching Synthetix). Must run before any `_accrue`.
    function _updatePool() internal {
        uint256 applicable = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (totalStaked > 0 && applicable > lastUpdateTime) {
            uint256 elapsed = applicable - lastUpdateTime;
            accRewardPerShare += (rewardRate * elapsed * ACC_SCALE) / totalStaked;
            rewardsDistributed += rewardRate * elapsed;
        }
        lastUpdateTime = applicable;
    }

    /// Accrue a user's freshly-earned rewards into `pending`.
    function _accrue(UserInfo storage u) internal {
        if (u.amount > 0) {
            uint256 accumulated = (u.amount * accRewardPerShare) / ACC_SCALE;
            if (accumulated > u.rewardDebt) {
                u.pending += accumulated - u.rewardDebt;
            }
        }
    }

    /// Stake `amount` wNAVE. Emits {Staked} for the relayer to mirror to Solana.
    function stake(uint256 amount) external nonReentrant {
        if (paused) revert NaveErrors.BridgePaused();
        if (amount == 0) revert NaveErrors.ZeroAmount();

        UserInfo storage u = users[msg.sender];
        _updatePool();
        _accrue(u);

        // Balance-delta accounting is unnecessary for a plain (non-fee) token,
        // but SafeERC20 + explicit pull keeps this robust.
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        u.amount += amount;
        totalStaked += amount;
        u.rewardDebt = (u.amount * accRewardPerShare) / ACC_SCALE;

        emit Staked(msg.sender, amount, totalStaked);
    }

    /// Unstake `amount` wNAVE principal (always available, even while paused).
    function unstake(uint256 amount) external nonReentrant {
        UserInfo storage u = users[msg.sender];
        if (amount == 0) revert NaveErrors.ZeroAmount();
        if (u.amount < amount) revert NaveErrors.InsufficientVaultBalance();

        _updatePool();
        _accrue(u);

        u.amount -= amount;
        totalStaked -= amount;
        u.rewardDebt = (u.amount * accRewardPerShare) / ACC_SCALE;

        stakingToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, totalStaked);
    }

    /// Claim accrued wNAVE rewards.
    function claim() external nonReentrant {
        if (paused) revert NaveErrors.BridgePaused();
        UserInfo storage u = users[msg.sender];
        _updatePool();
        _accrue(u);

        uint256 payout = u.pending;
        if (payout == 0) revert NaveErrors.ZeroAmount();

        // Never pay beyond what the contract holds above staked principal.
        uint256 available = stakingToken.balanceOf(address(this)) - totalStaked;
        if (payout > available) payout = available;
        if (payout == 0) revert NaveErrors.ZeroAmount();

        u.pending -= payout;
        u.rewardDebt = (u.amount * accRewardPerShare) / ACC_SCALE;
        rewardsClaimed += payout;

        stakingToken.safeTransfer(msg.sender, payout);
        emit RewardClaimed(msg.sender, payout);
    }

    /// Relayer-only: deliver `amount` wNAVE of cross-chain reward for this
    /// chain's stakers. The relayer must have approved this contract; the tokens
    /// are pulled in and metered out over a fresh `rewardsDuration` window,
    /// rolling any still-undripped leftover from the current window into the new
    /// rate (Synthetix `StakingRewards`). Reverts when nothing is staked so
    /// rewards are never stranded on an empty pool.
    function notifyReward(uint256 amount) external onlyRewarder nonReentrant {
        if (amount == 0) revert NaveErrors.ZeroAmount();
        if (totalStaked == 0) revert NaveErrors.InsufficientVaultBalance();
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        _updatePool();

        uint256 leftover = block.timestamp < periodFinish ? rewardRate * (periodFinish - block.timestamp) : 0;
        rewardRate = (amount + leftover) / rewardsDuration;
        periodFinish = block.timestamp + rewardsDuration;
        lastUpdateTime = block.timestamp;

        emit RewardNotified(amount, rewardRate, periodFinish);
    }

    /// View: rewards a user could currently claim, including the drip that has
    /// elapsed since the accumulator was last touched (projects
    /// `accRewardPerShare` forward to `min(now, periodFinish)`), so this matches
    /// what {claim} would pay right now.
    function pendingReward(address account) external view returns (uint256) {
        UserInfo storage u = users[account];

        uint256 projectedAcc = accRewardPerShare;
        if (totalStaked > 0) {
            uint256 applicable = block.timestamp < periodFinish ? block.timestamp : periodFinish;
            if (applicable > lastUpdateTime) {
                uint256 elapsed = applicable - lastUpdateTime;
                projectedAcc += (rewardRate * elapsed * ACC_SCALE) / totalStaked;
            }
        }

        uint256 accumulated = (u.amount * projectedAcc) / ACC_SCALE;
        uint256 extra = accumulated > u.rewardDebt ? accumulated - u.rewardDebt : 0;
        return u.pending + extra;
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    /// Owner-only: change the drip window length. Only permitted between
    /// windows (i.e. once the active drip has fully elapsed) so an in-flight
    /// rate is never retroactively distorted.
    function setRewardsDuration(uint256 secs) external onlyOwner {
        if (secs == 0) revert NaveErrors.ZeroAmount();
        if (block.timestamp < periodFinish) revert NaveErrors.InvalidStateTransition();
        rewardsDuration = secs;
        emit RewardsDurationUpdated(secs);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setRewarder(address newRewarder) external onlyOwner {
        if (newRewarder == address(0)) revert NaveErrors.ZeroAddress();
        if (newRewarder == owner() || newRewarder == pendingOwner()) {
            revert NaveErrors.PrivilegedRolesMustDiffer();
        }
        emit RewarderUpdated(rewarder, newRewarder);
        rewarder = newRewarder;
    }

    /// Two-step ownership handoff may not target the rewarder hot key.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == rewarder) revert NaveErrors.PrivilegedRolesMustDiffer();
        super.transferOwnership(newOwner);
    }

    /// Owner-only: recover reward dust that can never drip. `rewardRate` is
    /// floored on every {notifyReward} (`(amount + leftover) / rewardsDuration`),
    /// so the truncated remainder — plus any drip forfeited while nothing was
    /// staked — sits in the contract above what is owed to stakers and would
    /// otherwise be stranded forever (audit low, EVM side; Solana recaptures
    /// this via balance-delta measurement).
    ///
    /// Only callable once the active window has fully elapsed
    /// (`block.timestamp >= periodFinish`) so no in-flight drip is disturbed.
    /// The sweepable amount is the contract balance minus staked principal minus
    /// rewards that have been metered out but not yet claimed
    /// (`rewardsDistributed - rewardsClaimed`), so users' unclaimed earnings are
    /// never touched.
    function sweepDust(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert NaveErrors.ZeroAddress();
        if (block.timestamp < periodFinish) revert NaveErrors.InvalidStateTransition();

        _updatePool();

        uint256 owedUnclaimed = rewardsDistributed - rewardsClaimed;
        uint256 balance = stakingToken.balanceOf(address(this));
        uint256 reserved = totalStaked + owedUnclaimed;
        if (balance <= reserved) revert NaveErrors.ZeroAmount();

        amount = balance - reserved;
        stakingToken.safeTransfer(to, amount);
        emit DustSwept(to, amount);
    }

    uint256[40] private __gap;
}
