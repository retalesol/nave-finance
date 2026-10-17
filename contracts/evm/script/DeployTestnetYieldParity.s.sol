// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {ERC4626VaultAdapter} from "../src/adapters/ERC4626VaultAdapter.sol";
import {TestnetPegOracle} from "../src/oracle/TestnetPegOracle.sol";
import {TestnetMintableERC20} from "../src/mocks/TestnetMintableERC20.sol";
import {TestnetERC4626YieldVault} from "../src/mocks/TestnetERC4626YieldVault.sol";

/// @title DeployTestnetYieldParity
/// @notice Deploys first-party ERC-4626 testnet yield vaults and adapters on
/// Arc Testnet (5042002) and Robinhood Testnet (46630), plus the Robinhood
/// Testnet 6-decimal USDC token and dual-asset TestnetPegOracle.
contract DeployTestnetYieldParity is Script {
    address internal constant DEPLOYER = 0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca;

    // Arc Testnet (5042002)
    address internal constant ARC_PROTOCOL = 0x3334fBe32eEe1F9f34C047d90762b3030B5Fe255;
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    // Robinhood Testnet (46630)
    address internal constant RH_PROTOCOL = 0xcA99d4A75A41C3aff5F3Fc2c2Dfd241129B1e093;
    address internal constant RH_FACTORY = 0x303cE551De723cad43e1575C4D981C0E2b662b7F;
    address internal constant RH_WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    uint256 internal constant RH_WETH_REF_PRICE_MICRO_USD = 2_500_000_000; // $2,500.00

    function run() external {
        uint256 id = block.chainid;
        if (id == 5_042_002) {
            _deployArc();
        } else if (id == 46_630) {
            _deployRobinhood();
        } else {
            revert("DeployTestnetYieldParity: unsupported chainId (expected 5042002 or 46630)");
        }
    }

    function _deployArc() internal {
        NaveProtocol protocol = NaveProtocol(payable(ARC_PROTOCOL));

        vm.startBroadcast();
        TestnetERC4626YieldVault vault = new TestnetERC4626YieldVault(
            IERC20(ARC_USDC), "Nave Arc Testnet USDC Yield Vault", "nvArcUSDC"
        );
        ERC4626VaultAdapter adapter = new ERC4626VaultAdapter(
            ARC_PROTOCOL, address(vault), "morpho-steakhouse-usdc"
        );
        protocol.setAdapterRiskTier(address(adapter), 1);
        protocol.setAdapterApproved(address(adapter), true);
        vm.stopBroadcast();

        console2.log("chainId                ", block.chainid);
        console2.log("Arc USDC Yield Vault   ", address(vault));
        console2.log("Arc ERC4626Adapter     ", address(adapter));
        console2.log("isApprovedAdapter      ", protocol.isApprovedAdapter(address(adapter)));
        console2.log("approvalEffectiveAt    ", protocol.adapterApprovalEffectiveAt(address(adapter)));
    }

    function _deployRobinhood() internal {
        NaveProtocol protocol = NaveProtocol(payable(RH_PROTOCOL));
        NaveDAOFactory factory = NaveDAOFactory(RH_FACTORY);

        vm.startBroadcast();
        TestnetMintableERC20 usdc = new TestnetMintableERC20(
            "USD Coin (Robinhood Testnet)", "USDC", 6, 1_000_000e6
        );
        usdc.mint(DEPLOYER, 1_000_000e6);

        TestnetPegOracle oracle = new TestnetPegOracle(address(usdc));
        oracle.setReferencePrice(RH_WETH, RH_WETH_REF_PRICE_MICRO_USD);
        factory.setOracle(address(oracle));

        TestnetERC4626YieldVault usdcVault = new TestnetERC4626YieldVault(
            IERC20(address(usdc)), "Nave Robinhood Testnet USDC Yield Vault", "nvRhUSDC"
        );
        ERC4626VaultAdapter usdcAdapter = new ERC4626VaultAdapter(
            RH_PROTOCOL, address(usdcVault), "morpho-steakhouse-usdg"
        );
        protocol.setAdapterRiskTier(address(usdcAdapter), 1);
        protocol.setAdapterApproved(address(usdcAdapter), true);

        TestnetERC4626YieldVault wethVault = new TestnetERC4626YieldVault(
            IERC20(RH_WETH), "Nave Robinhood Testnet WETH Yield Vault", "nvRhWETH"
        );
        ERC4626VaultAdapter wethAdapter = new ERC4626VaultAdapter(
            RH_PROTOCOL, address(wethVault), "robinhood-weth-vault"
        );
        protocol.setAdapterRiskTier(address(wethAdapter), 1);
        protocol.setAdapterApproved(address(wethAdapter), true);
        vm.stopBroadcast();

        console2.log("chainId                ", block.chainid);
        console2.log("Robinhood Testnet USDC ", address(usdc));
        console2.log("Robinhood Oracle       ", address(oracle));
        console2.log("RH USDC Yield Vault    ", address(usdcVault));
        console2.log("RH USDC Adapter        ", address(usdcAdapter));
        console2.log("RH WETH Yield Vault    ", address(wethVault));
        console2.log("RH WETH Adapter        ", address(wethAdapter));
        console2.log("usdcAdapterApproved    ", protocol.isApprovedAdapter(address(usdcAdapter)));
        console2.log("usdcApprovalEffectiveAt", protocol.adapterApprovalEffectiveAt(address(usdcAdapter)));
        console2.log("wethAdapterApproved    ", protocol.isApprovedAdapter(address(wethAdapter)));
        console2.log("wethApprovalEffectiveAt", protocol.adapterApprovalEffectiveAt(address(wethAdapter)));
    }
}
