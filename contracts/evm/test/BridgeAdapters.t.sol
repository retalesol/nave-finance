// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArbitrumBridgeAdapter} from "../src/adapters/ArbitrumBridgeAdapter.sol";
import {CctpBridgeAdapter} from "../src/adapters/CctpBridgeAdapter.sol";
import {OpStandardBridgeAdapter} from "../src/adapters/OpStandardBridgeAdapter.sol";
import {NaveAddressRegistry} from "../script/config/NaveAddressRegistry.sol";

/// @dev Minimal protocol stub: every address is treated as NaveExecution.
contract MockProtocolForBridge {
    function isNaveExecution(address) external pure returns (bool) {
        return true;
    }
}

contract BridgeAdaptersTest is Test {
    MockProtocolForBridge internal protocol;
    address internal constant WETH = address(0xBEEF);
    address internal constant USDC = address(0xCAFE);
    address internal constant MESSENGER = address(0x1111);
    address internal constant BRIDGE = address(0x2222);
    address internal constant GATEWAY = address(0x3333);

    function setUp() public {
        protocol = new MockProtocolForBridge();
    }

    function test_arbitrumBridge_protocolIdAndRoute() public {
        ArbitrumBridgeAdapter a = new ArbitrumBridgeAdapter(
            address(protocol),
            GATEWAY,
            WETH,
            WETH,
            NaveAddressRegistry.ROBINHOOD,
            NaveAddressRegistry.ETHEREUM
        );
        assertEq(a.protocolId(), "arbitrum-bridge");
        assertTrue(a.supportsRoute(WETH, NaveAddressRegistry.ETHEREUM));
        assertFalse(a.supportsRoute(WETH, NaveAddressRegistry.BASE));
        assertFalse(a.supportsRoute(USDC, NaveAddressRegistry.ETHEREUM));
    }

    function test_cctp_protocolIdAndRoute() public {
        uint256[] memory dest = new uint256[](1);
        uint32[] memory domains = new uint32[](1);
        dest[0] = NaveAddressRegistry.BASE;
        domains[0] = NaveAddressRegistry.CCTP_DOMAIN_BASE;
        CctpBridgeAdapter a = new CctpBridgeAdapter(
            address(protocol), MESSENGER, USDC, NaveAddressRegistry.ETHEREUM, dest, domains
        );
        assertEq(a.protocolId(), "cctp");
        assertTrue(a.supportsRoute(USDC, NaveAddressRegistry.BASE));
        assertFalse(a.supportsRoute(USDC, NaveAddressRegistry.ROBINHOOD));
        assertFalse(a.supportsRoute(WETH, NaveAddressRegistry.BASE));
    }

    function test_opBridge_protocolIdAndRoute() public {
        OpStandardBridgeAdapter a = new OpStandardBridgeAdapter(
            address(protocol),
            BRIDGE,
            WETH,
            WETH,
            NaveAddressRegistry.BASE,
            NaveAddressRegistry.ETHEREUM,
            true,
            200_000
        );
        assertEq(a.protocolId(), "op-standard-bridge");
        assertTrue(a.supportsRoute(WETH, NaveAddressRegistry.ETHEREUM));
        assertFalse(a.supportsRoute(WETH, NaveAddressRegistry.ROBINHOOD));
    }
}
