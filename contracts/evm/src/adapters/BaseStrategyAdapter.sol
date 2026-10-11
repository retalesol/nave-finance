// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {INaveProtocol} from "../interfaces/INaveProtocol.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";
import {AssetKind} from "../libraries/NaveEnums.sol";

/// @title BaseStrategyAdapter
/// @notice Shared base for all EVM strategy adapters. EVM analogue of the Solana
/// adapter programs: every mutating call is gated to a registered per-DAO
/// `NaveExecution` (replacing the `execution_authority` PDA), and each DAO's
/// position is isolated via an ERC-4626-style share ledger keyed by the calling
/// execution contract. Interest/yield accrues proportionally to shares, so
/// multiple DAOs can safely share one adapter without commingling principal.
///
/// Funds flow: `NaveExecution` transfers `amount` of `asset` to the adapter and
/// then calls {deposit}; {withdraw} redeems and forwards the underlying to `to`.
abstract contract BaseStrategyAdapter is IStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    INaveProtocol public immutable protocol;
    AssetKind internal immutable _assetKind;
    string internal _protocolId;

    /// Shares permanently locked on the first deposit into each asset to defuse
    /// the ERC-4626 first-depositor / share-inflation ("1-wei donation") attack
    /// (C-2). Credited to {DEAD_SHARES_HOLDER}, which can never withdraw, so an
    /// attacker can no longer round a later depositor down to zero shares cheaply.
    uint256 public constant MIN_DEAD_SHARES = 1000;
    /// Burn sink that holds the locked first-deposit shares forever.
    address internal constant DEAD_SHARES_HOLDER = address(0xdead);

    /// caller (execution) => asset => shares
    mapping(address => mapping(address => uint256)) public shares;
    /// asset => total shares
    mapping(address => uint256) public totalShares;

    event AdapterDeposit(
        address indexed execution, address indexed asset, uint256 amount, uint256 sharesMinted
    );
    event AdapterWithdraw(
        address indexed execution, address indexed asset, uint256 amount, uint256 sharesBurned
    );
    event AdapterExitRequested(
        address indexed execution, address indexed asset, uint256 amount, uint256 sharesBurned
    );

    modifier onlyExecution() {
        if (!protocol.isNaveExecution(msg.sender)) revert NaveErrors.Unauthorized();
        _;
    }

    constructor(address protocol_, AssetKind assetKind_, string memory protocolId_) {
        if (protocol_ == address(0)) revert NaveErrors.ZeroAddress();
        protocol = INaveProtocol(protocol_);
        _assetKind = assetKind_;
        _protocolId = protocolId_;
    }

    function assetKind() external view returns (AssetKind) {
        return _assetKind;
    }

    function protocolId() external view returns (string memory) {
        return _protocolId;
    }

    /// @inheritdoc IStrategyAdapter
    function deposit(address asset, uint256 amount, uint256 minOut)
        external
        onlyExecution
        nonReentrant
        returns (uint256 minted)
    {
        if (amount == 0) revert NaveErrors.MathOverflow();
        if (!_supportsAsset(asset)) revert NaveErrors.UnsupportedAdapter();
        _enforceSlippageBound(minOut);

        uint256 beforeBal = _totalUnderlying(asset);
        _supply(asset, amount, minOut);
        uint256 afterBal = _totalUnderlying(asset);
        uint256 added = afterBal - beforeBal;

        uint256 ts = totalShares[asset];
        if (ts == 0) {
            // C-2: first deposit permanently locks MIN_DEAD_SHARES so the share
            // price cannot be cheaply inflated to round later depositors to zero.
            if (added <= MIN_DEAD_SHARES) revert NaveErrors.DepositBelowMinimum();
            shares[DEAD_SHARES_HOLDER][asset] += MIN_DEAD_SHARES;
            minted = added - MIN_DEAD_SHARES;
            shares[msg.sender][asset] += minted;
            totalShares[asset] = added;
        } else {
            minted = beforeBal == 0 ? added : (added * ts) / beforeBal;
            shares[msg.sender][asset] += minted;
            totalShares[asset] = ts + minted;
        }
        emit AdapterDeposit(msg.sender, asset, amount, minted);
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(address asset, uint256 amount, address to, uint256 minOut)
        external
        onlyExecution
        nonReentrant
        returns (uint256 underlyingOut)
    {
        if (amount == 0) revert NaveErrors.MathOverflow();
        _enforceSlippageBound(minOut);
        if (_queuedExit()) {
            // Queued venues pay only from a claim that finished its queue.
            underlyingOut = _payClaim(msg.sender, asset, amount, to);
            if (underlyingOut < minOut) revert NaveErrors.SlippageExceeded();
            emit AdapterWithdraw(msg.sender, asset, amount, 0);
            return underlyingOut;
        }
        uint256 burned = _burnFor(msg.sender, asset, amount);
        underlyingOut = _redeem(asset, amount, to, minOut);
        // Defence-in-depth: the protocol must return at least the caller's floor.
        if (underlyingOut < minOut) revert NaveErrors.SlippageExceeded();
        emit AdapterWithdraw(msg.sender, asset, amount, burned);
    }

    /// Start a queued exit of `amount` underlying for the calling execution. The
    /// amount leaves the share ledger now (it stops earning) and is owed to the
    /// caller; {withdraw} pays it once the venue's queue or cooldown completes.
    function requestExit(address asset, uint256 amount)
        external
        onlyExecution
        nonReentrant
        returns (uint256 readyAt)
    {
        if (!_queuedExit()) revert NaveErrors.ExitNotQueued();
        if (amount == 0) revert NaveErrors.MathOverflow();
        uint256 burned = _burnFor(msg.sender, asset, amount);
        readyAt = _queueExit(msg.sender, asset, amount);
        emit AdapterExitRequested(msg.sender, asset, amount, burned);
    }

    /// Remove `amount` of `caller`'s value from the share ledger. SEC-M1: round
    /// UP (deposit-side minting rounds down), matching ERC-4626 convention —
    /// flooring let a withdrawer repeatedly keep the fractional share the
    /// division dropped, slowly diluting co-tenant DAOs sharing the adapter.
    function _burnFor(address caller, address asset, uint256 amount)
        internal
        returns (uint256 burned)
    {
        uint256 ts = totalShares[asset];
        uint256 total = _totalUnderlying(asset);
        uint256 callerValue = ts == 0 ? 0 : (shares[caller][asset] * total) / ts;
        if (amount > callerValue) revert NaveErrors.WithdrawExceedsDeployed();
        burned = total == 0 ? 0 : Math.ceilDiv(amount * ts, total);
        if (burned > shares[caller][asset]) burned = shares[caller][asset];
        shares[caller][asset] -= burned;
        totalShares[asset] = ts - burned;
    }

    /// Reject an unbounded (`minOut == 0`) join/exit on a mainnet chain for
    /// adapters that route through a slippage-bearing protocol (Balancer/Curve).
    /// On testnets liquidity is thin/absent, so the guard is relaxed there.
    function _enforceSlippageBound(uint256 minOut) internal view {
        if (minOut == 0 && _requiresSlippageBound() && _isMainnetChain()) {
            revert NaveErrors.SlippageBoundRequired();
        }
    }

    function _isMainnetChain() internal view returns (bool) {
        // Ethereum (1) and Base (8453) — the two production EVM chains Nave ships.
        return block.chainid == 1 || block.chainid == 8453;
    }

    /// @inheritdoc IStrategyAdapter
    function positionValue(address asset) external view returns (uint256) {
        uint256 ts = totalShares[asset];
        uint256 pooled = ts == 0 ? 0 : (shares[msg.sender][asset] * _totalUnderlying(asset)) / ts;
        return pooled + _owedTo(msg.sender, asset);
    }

    function supportsAsset(address asset) external view returns (bool) {
        return _supportsAsset(asset);
    }

    // ── Hooks implemented by concrete adapters ────────────────────────────
    /// Supply `amount` of `asset` (already held by this adapter) to the protocol,
    /// enforcing the caller-supplied `minOut` join floor where applicable.
    function _supply(address asset, uint256 amount, uint256 minOut) internal virtual;
    /// Redeem `amount` underlying `asset` from the protocol to `to`, enforcing the
    /// caller-supplied `minOut` floor where applicable.
    function _redeem(address asset, uint256 amount, address to, uint256 minOut)
        internal
        virtual
        returns (uint256);
    /// Total underlying `asset` this adapter currently controls in the protocol.
    function _totalUnderlying(address asset) internal view virtual returns (uint256);
    /// Whether the adapter can route `asset` on this chain.
    function _supportsAsset(address asset) internal view virtual returns (bool);

    /// Queued-exit venues (Maple, Ethena) override these. A queued amount is
    /// still the DAO's capital: it stays in `deployedCapital` (so the liquidity
    /// floor treats it as illiquid) and in {positionValue} until paid out.
    function _queuedExit() internal view virtual returns (bool) {
        return false;
    }

    /// Start the venue-side exit for `amount`; returns the earliest payout time.
    function _queueExit(address, address, uint256) internal virtual returns (uint256) {
        revert NaveErrors.ExitNotQueued();
    }

    /// Pay `amount` of `caller`'s finished claim to `to`.
    function _payClaim(address, address, uint256, address) internal virtual returns (uint256) {
        revert NaveErrors.ExitNotQueued();
    }

    /// Underlying owed to `caller` from queued or finished exits.
    function _owedTo(address, address) internal view virtual returns (uint256) {
        return 0;
    }

    /// Whether this adapter routes through a slippage-bearing protocol and so
    /// must reject `minOut == 0` on mainnet. Defaults to false (1:1 lending).
    function _requiresSlippageBound() internal view virtual returns (bool) {
        return false;
    }

    /// Scale an amount expressed in 18-decimal fixed point (the normalized
    /// precision Balancer/Curve invariant-based rate functions report in) down
    /// (or up) to `decimals`. Shared by adapters that price positions via a
    /// manipulation-resistant rate/virtual-price function (EVM-C2) instead of
    /// raw pool balances.
    function _scaleFrom18(uint256 amount18, uint8 decimals) internal pure returns (uint256) {
        if (decimals == 18) return amount18;
        if (decimals < 18) return amount18 / (10 ** (18 - decimals));
        return amount18 * (10 ** (decimals - 18));
    }
}
