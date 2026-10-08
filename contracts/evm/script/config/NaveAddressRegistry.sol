// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NaveAddressRegistry
/// @notice Per-chain external-protocol address book consumed by
/// `script/DeployAdapters.s.sol` and the adapter fork tests so neither
/// hardcodes test constants. Covers the four EVM chains Nave supports:
///
///   - Ethereum mainnet      (chain id 1)
///   - Base mainnet          (chain id 8453)
///   - Robinhood Chain       (chain id 4663)
///   - Sepolia testnet       (chain id 11155111)
///   - Base Sepolia testnet  (chain id 84532)
///   - Robinhood Testnet     (chain id 46630)
///
/// Only the *protocol singletons* are pinned here (Aave v3 Pool, Compound v3
/// Comet/USDC market, Balancer v2 Vault). The *pool-specific* args for Balancer
/// (poolId / bpt / assetIndex / tokenCount) are strategy decisions that vary per
/// DAO and per liquidity venue, so they are supplied to the deploy script via env
/// vars (see `DeployAdapters.s.sol`). The recommended reference pools — verified
/// on-chain at authoring time — are documented as constants below for the deploy
/// operator and the fork tests.
///
/// `address(0)` means "not deployed / not applicable on this chain". The deploy
/// script skips an adapter whose required singleton is zero.
library NaveAddressRegistry {
    // ── Chain ids ─────────────────────────────────────────────────────────
    uint256 internal constant ETHEREUM = 1;
    uint256 internal constant BASE = 8453;
    uint256 internal constant ROBINHOOD = 4663;
    uint256 internal constant SEPOLIA = 11_155_111;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ROBINHOOD_TESTNET = 46_630;

    // Circle CCTP TokenMessenger (v1) — identical proxy on Eth/Base mainnet.
    address internal constant CCTP_TOKEN_MESSENGER = 0xbd3fA81b58bA92A82136038b25aDEC7066af1865;
    uint32 internal constant CCTP_DOMAIN_ETHEREUM = 0;
    uint32 internal constant CCTP_DOMAIN_BASE = 6;

    // OP Stack StandardBridge
    address internal constant BASE_L2_STANDARD_BRIDGE = 0x4200000000000000000000000000000000000010;
    address internal constant ETH_L1_STANDARD_BRIDGE_BASE = 0x3154CF16AEe4c8a57706ec88091C63f42690a87b;

    // Arbitrum Nitro L2 gateway router (override via deploy env on Robinhood if distinct).
    address internal constant ARB_L2_GATEWAY_ROUTER = 0x5288c571fD7ad117BEa99BF60EE0539c26513f10;

    struct ChainConfig {
        uint256 chainId;
        // Canonical stablecoin used by the lending adapters on this chain.
        address usdc;
        // Canonical wrapped native (WETH) for treasury native wrap.
        address weth;
        // Aave v3 Pool (supply/withdraw).
        address aaveV3Pool;
        // Compound v3 Comet market whose base asset is USDC (cUSDCv3).
        address compoundCometUsdc;
        // Balancer v2 Vault. Zero on testnets without a compatible v2 pool target.
        address balancerVault;
    }

    // ── Balancer v2 Vault: canonical, identical on all chains ─────────────
    address internal constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    // ── Ethereum mainnet (1) ──────────────────────────────────────────────
    address internal constant ETH_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant ETH_AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant ETH_COMET_USDC = 0xc3d688B66703497DAA19211EEdff47f25384cdc3;
    address internal constant ETH_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // Reference Balancer pool (Ethereum): 50 USDC / 50 WETH weighted pool.
    //   poolId   0x96646936b91d6b9d7d0c47c496afbf3d6ec7b6f8000200000000000000000019
    //   bpt/pool 0x96646936b91d6B9D7D0c47C496AfBF3D6ec7B6f8 (the pool IS the BPT)
    //   tokens   [USDC (idx 0), WETH (idx 1)] -> route USDC at assetIndex 0, tokenCount 2
    bytes32 internal constant ETH_BAL_USDC_WETH_POOL_ID =
        0x96646936b91d6b9d7d0c47c496afbf3d6ec7b6f8000200000000000000000019;
    address internal constant ETH_BAL_USDC_WETH_BPT = 0x96646936b91d6B9D7D0c47C496AfBF3D6ec7B6f8;

    // Curve is intentionally omitted until a vetted deployment/pool exists.

    // ── Base mainnet (8453) ───────────────────────────────────────────────
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant BASE_COMET_USDC = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;

    // ── Sepolia testnet (11155111) ────────────────────────────────────────
    // Circle native USDC on Sepolia; Compound v3 Sepolia cUSDCv3 uses this as
    // its baseToken.
    address internal constant SEPOLIA_CIRCLE_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    // Aave address-book Sepolia market token, distinct from Circle testnet USDC.
    address internal constant SEPOLIA_AAVE_USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    address internal constant SEPOLIA_AAVE_V3_POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address internal constant SEPOLIA_COMET_USDC = 0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e;
    // Canonical Sepolia WETH9.
    address internal constant SEPOLIA_WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    // Balancer Sepolia has official v3 core deployments, including Vault
    // 0xbA1333333333a1BA1108E8412f11850A5C319bA9 and WeightedPoolFactory
    // 0xc383B240B40660cca6c5b6Fbf4fbAb85E9F4de24, but Nave's current
    // BalancerAdapter targets the v2 Vault joinPool/exitPool ABI plus a concrete
    // poolId/BPT/routed-asset tuple. Keep the v2 adapter disabled on testnets
    // until a compatible v2 pool target is validated.

    // ── Base Sepolia testnet (84532) ───────────────────────────────────────
    address internal constant BASE_SEPOLIA_AAVE_USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
    address internal constant BASE_SEPOLIA_AAVE_V3_POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address internal constant BASE_SEPOLIA_WETH = 0x4200000000000000000000000000000000000006;

    // ── Robinhood Chain (4663) ────────────────────────────────────────────
    // Canonical WETH from Robinhood Chain token contracts docs.
    address internal constant ROBINHOOD_USDC = address(0);
    address internal constant ROBINHOOD_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    // ── Resolution ────────────────────────────────────────────────────────
    /// Resolve the config for `chainId`. Reverts on an unsupported chain so a
    /// mis-targeted deploy fails loudly rather than deploying with zeros.
    function config(uint256 chainId) internal pure returns (ChainConfig memory c) {
        if (chainId == ETHEREUM) {
            return ChainConfig({
                chainId: ETHEREUM,
                usdc: ETH_USDC,
                weth: ETH_WETH,
                aaveV3Pool: ETH_AAVE_V3_POOL,
                compoundCometUsdc: ETH_COMET_USDC,
                balancerVault: BALANCER_V2_VAULT
            });
        }
        if (chainId == BASE) {
            return ChainConfig({
                chainId: BASE,
                usdc: BASE_USDC,
                weth: BASE_WETH,
                aaveV3Pool: BASE_AAVE_V3_POOL,
                compoundCometUsdc: BASE_COMET_USDC,
                balancerVault: BALANCER_V2_VAULT
            });
        }
        if (chainId == SEPOLIA) {
            return ChainConfig({
                chainId: SEPOLIA,
                usdc: SEPOLIA_CIRCLE_USDC,
                weth: SEPOLIA_WETH,
                aaveV3Pool: SEPOLIA_AAVE_V3_POOL,
                compoundCometUsdc: SEPOLIA_COMET_USDC,
                balancerVault: address(0)
            });
        }
        if (chainId == BASE_SEPOLIA) {
            return ChainConfig({
                chainId: BASE_SEPOLIA,
                usdc: BASE_SEPOLIA_AAVE_USDC,
                weth: BASE_SEPOLIA_WETH,
                aaveV3Pool: BASE_SEPOLIA_AAVE_V3_POOL,
                compoundCometUsdc: address(0),
                balancerVault: address(0)
            });
        }
        // ── Robinhood Chain mainnet (4663) / testnet (46630) ──────────────
        // Yield adapters are typically unavailable; treasury capital bridges out
        // via CCTP (USDC) and Arbitrum Nitro (ETH). Populate when addresses are
        // confirmed on-chain; zeros skip adapter deploy.
        if (chainId == ROBINHOOD) {
            return ChainConfig({
                chainId: ROBINHOOD,
                usdc: ROBINHOOD_USDC,
                weth: ROBINHOOD_WETH,
                aaveV3Pool: address(0),
                compoundCometUsdc: address(0),
                balancerVault: address(0)
            });
        }
        if (chainId == ROBINHOOD_TESTNET) {
            return ChainConfig({
                chainId: ROBINHOOD_TESTNET,
                usdc: address(0),
                weth: address(0),
                aaveV3Pool: address(0),
                compoundCometUsdc: address(0),
                balancerVault: address(0)
            });
        }
        revert("NaveAddressRegistry: unsupported chain id (1, 8453, 4663, 11155111, 84532, 46630)");
    }

    /// Convenience: wrapped-native address for `chainId` (zero if unknown).
    function weth(uint256 chainId) internal pure returns (address) {
        return config(chainId).weth;
    }
}
