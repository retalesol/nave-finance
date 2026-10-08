// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal external-protocol interfaces consumed by the strategy
/// adapters. Only the methods the adapters call are declared.

/// Aave v3 Pool (supply/withdraw) + reserve data lookup for the aToken address.
interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    struct ReserveDataLegacy {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
}

/// Compound v3 (Comet) single-base-asset money market.
interface IComet {
    function supply(address asset, uint256 amount) external;
    function withdrawTo(address to, address asset, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function baseToken() external view returns (address);
}

/// Curve StableSwap pool (NG / legacy). The adapter is configured with a pool
/// whose `coins(i)` matches the adapter's asset at index `coinIndex`.
interface ICurvePool {
    function add_liquidity(uint256[] calldata amounts, uint256 minMintAmount)
        external
        returns (uint256);
    function remove_liquidity_one_coin(uint256 lpAmount, int128 i, uint256 minReceived)
        external
        returns (uint256);
    function calc_withdraw_one_coin(uint256 lpAmount, int128 i) external view returns (uint256);
    function coins(uint256 i) external view returns (address);
    /// Invariant-derived (StableMath `D`) LP-token exchange rate, 18-decimal
    /// fixed point. Unlike `calc_withdraw_one_coin`/raw `balances()`, a single
    /// swap moves this only by the trading fee it pays — not by the pool's
    /// instantaneous imbalance — making it the manipulation-resistant measure
    /// to use for LP-token pricing (EVM-C2).
    function get_virtual_price() external view returns (uint256);
}

/// Balancer v2 Vault (single-asset join/exit of a weighted/stable pool).
interface IBalancerVault {
    enum JoinKind {
        INIT,
        EXACT_TOKENS_IN_FOR_BPT_OUT,
        TOKEN_IN_FOR_EXACT_BPT_OUT,
        ALL_TOKENS_IN_FOR_EXACT_BPT_OUT
    }
    enum ExitKind {
        EXACT_BPT_IN_FOR_ONE_TOKEN_OUT,
        EXACT_BPT_IN_FOR_TOKENS_OUT,
        BPT_IN_FOR_EXACT_TOKENS_OUT
    }

    struct JoinPoolRequest {
        address[] assets;
        uint256[] maxAmountsIn;
        bytes userData;
        bool fromInternalBalance;
    }

    struct ExitPoolRequest {
        address[] assets;
        uint256[] minAmountsOut;
        bytes userData;
        bool toInternalBalance;
    }

    function joinPool(
        bytes32 poolId,
        address sender,
        address recipient,
        JoinPoolRequest calldata request
    ) external;
    function exitPool(
        bytes32 poolId,
        address sender,
        address payable recipient,
        ExitPoolRequest calldata request
    ) external;
    function getPoolTokens(bytes32 poolId)
        external
        view
        returns (address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock);
}

/// Standard Balancer "rate provider" surface, implemented by the BPT of
/// Stable / ComposableStable / MetaStable / Linear pools. Returns the
/// exchange rate of 1 BPT to the pool's underlying base asset (18-decimal
/// fixed point), computed from the pool's amplification-invariant rather than
/// raw `getPoolTokens()` balances — a single-block flash loan can skew
/// balances materially, but only skews `getRate()` by the swap fee paid
/// (EVM-C2). Plain (non-rate-provider) Weighted Pools do not implement this
/// interface and are not supported by {BalancerAdapter}.
interface IRateProviderPool {
    function getRate() external view returns (uint256);
}
