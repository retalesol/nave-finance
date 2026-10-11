// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveTokenDeployer} from "../src/NaveTokenDeployer.sol";
import {PythOracle} from "../src/oracle/PythOracle.sol";
import {AgentRole, GovernanceType, DaoImplRole} from "../src/libraries/NaveEnums.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {TreasuryGuardianLib} from "../src/libraries/TreasuryGuardianLib.sol";

/// @notice Shared deployment + helpers for the Nave EVM test suite.
contract NaveBase is Test {
    NaveProtocol internal protocol;
    NaveDAOFactory internal factory;
    NaveTokenDeployer internal tokenDeployer;
    PythOracle internal oracle;
    MockPyth internal pyth;
    MockWETH internal weth;

    address internal treasuryImpl;
    address internal governorImpl;
    address internal executionImpl;

    address internal owner = makeAddr("owner");
    address internal protocolTreasury = makeAddr("protocolTreasury");
    address internal founder = makeAddr("founder");
    address internal revenueWallet = makeAddr("revenueWallet");

    // Agents (with keys for signing where needed).
    address internal exec = makeAddr("execAgent");
    address internal fin = makeAddr("finAgent");
    address internal over = makeAddr("overAgent");
    address internal oper = makeAddr("operAgent");

    // Guardians (with keys for EIP-712 signing).
    uint256 internal g1Key;
    uint256 internal g2Key;
    uint256 internal g3Key;
    address internal g1;
    address internal g2;
    address internal g3;

    MockERC20 internal usdc; // 6-decimal stablecoin

    bytes32 internal constant GUARDIAN_ACTION_TYPEHASH = keccak256(
        "GuardianAction(uint8 actionType,uint8 agentSlot,uint8 newStatus,address newKey,uint64 nonce,uint64 deadline)"
    );

    /// A guardian-action deadline 6 days out — unexpired and within the
    /// contract's 7-day cap, with enough margin for the per-test time warps that
    /// occur between signing and submitting an action.
    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 6 days);
    }

    function setUp() public virtual {
        (g1, g1Key) = makeAddrAndKey("guardian1");
        (g2, g2Key) = makeAddrAndKey("guardian2");
        (g3, g3Key) = makeAddrAndKey("guardian3");

        NaveProtocol protocolImplementation = new NaveProtocol();
        protocol = NaveProtocol(
            payable(
                address(
                    new ERC1967Proxy(
                        address(protocolImplementation),
                        abi.encodeCall(
                            NaveProtocol.initialize, (owner, protocolTreasury, 0, 0)
                        )
                    )
                )
            )
        );
        tokenDeployer = new NaveTokenDeployer();
        pyth = new MockPyth(60, 1);
        PythOracle oracleImplementation = new PythOracle();
        oracle = PythOracle(
            address(
                new ERC1967Proxy(
                    address(oracleImplementation),
                    abi.encodeCall(PythOracle.initialize, (address(pyth), owner))
                )
            )
        );
        weth = new MockWETH();
        vm.prank(owner);
        protocol.setWrappedNative(address(weth), NaveConstants.PYTH_ETH_USD_FEED_ID);
        // Fresh ETH/USD so auto-registered WETH from native seed revalues cleanly.
        _setPythPrice(NaveConstants.PYTH_ETH_USD_FEED_ID, 2000e8, 1e6, -8);

        treasuryImpl = address(new NaveTreasury());
        governorImpl = address(new NaveGovernor());
        executionImpl = address(new NaveExecution());
        vm.startPrank(owner);
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), treasuryImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Governor), governorImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Execution), executionImpl);
        vm.stopPrank();

        NaveDAOFactory factoryImplementation = new NaveDAOFactory();
        factory = NaveDAOFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImplementation),
                    abi.encodeCall(
                        NaveDAOFactory.initialize,
                        (owner, address(protocol), address(oracle), address(tokenDeployer))
                    )
                )
            )
        );
        vm.prank(owner);
        protocol.setFactory(address(factory));

        usdc = new MockERC20("USD Coin", "USDC", 6);
    }

    function _guardians() internal view returns (address[] memory g) {
        g = new address[](3);
        g[0] = g1;
        g[1] = g2;
        g[2] = g3;
    }

    function _agents() internal view returns (address[4] memory a) {
        a = [exec, fin, over, oper];
    }

    /// Standard DAO-creation params used across the suite.
    function _daoParams(uint8 governanceType)
        internal
        view
        returns (NaveDAOFactory.CreateDaoParams memory p)
    {
        p = NaveDAOFactory.CreateDaoParams({
            name: "Test DAO",
            privacyMode: 0,
            guardianWallets: _guardians(),
            guardianThreshold: 2,
            agentAuthorities: _agents(),
            managementFeeBps: 0,
            performanceFeeBps: 1500,
            frozenManagementFeeBps: 0,
            frozenPerformanceFeeBps: 1500,
            protocolRevenueWallet: revenueWallet,
            quorumBps: 1000,
            governanceType: governanceType
        });
    }

    /// Overwrite the four packed fee bps on a live treasury. They share a slot
    /// with `protocolRevenueWallet`; only those eight bytes are replaced.
    /// Used to simulate a treasury created before the 0 / 1500 schedule.
    function _writeFeeBps(
        NaveTreasury treasury,
        uint16 management,
        uint16 performance,
        uint16 frozenManagement,
        uint16 frozenPerformance
    ) internal {
        uint256 needle = (uint256(treasury.performanceFeeBps()) << 16)
            | (uint256(treasury.frozenPerformanceFeeBps()) << 48);
        bytes32 slot;
        bool found;
        for (uint256 i; i < 64; i++) {
            uint256 raw = uint256(vm.load(address(treasury), bytes32(i)));
            uint256 seen = (raw & (uint256(type(uint16).max) << 16))
                | (raw & (uint256(type(uint16).max) << 48));
            if (
                seen == needle && uint16(raw) == treasury.managementFeeBps()
                    && uint16(raw >> 32) == treasury.frozenManagementFeeBps()
            ) {
                slot = bytes32(i);
                found = true;
                break;
            }
        }
        require(found, "fee slot not found");
        uint256 current = uint256(vm.load(address(treasury), slot));
        uint256 packed = uint256(management) | (uint256(performance) << 16)
            | (uint256(frozenManagement) << 32) | (uint256(frozenPerformance) << 48);
        vm.store(address(treasury), slot, bytes32((current & ~uint256(type(uint64).max)) | packed));
    }

    /// Create a DAO via the factory and return its three proxies.
    function _createDao(uint8 governanceType)
        internal
        returns (NaveTreasury treasury, NaveGovernor governor, NaveExecution execution)
    {
        vm.prank(founder);
        (, address t, address g, address e) = factory.createDao(_daoParams(governanceType));
        return (NaveTreasury(payable(t)), NaveGovernor(g), NaveExecution(e));
    }

    /// Switch to Ethereum mainnet so production delays apply, and lift the DAO's
    /// review window (stamped with the dev delay at creation) to the default.
    function _useProductionDelays(NaveTreasury treasury) internal {
        vm.chainId(1);
        vm.prank(founder);
        treasury.setReviewWindow(NaveConstants.DEFAULT_REVIEW_WINDOW_SECONDS);
    }

    /// Create a DAO forwarding `value` to cover a non-zero formation fee.
    function _createDaoWithValue(uint8 governanceType, uint256 value)
        internal
        returns (
            uint256 daoId,
            NaveTreasury treasury,
            NaveGovernor governor,
            NaveExecution execution
        )
    {
        vm.deal(founder, founder.balance + value);
        vm.prank(founder);
        (uint256 id, address t, address g, address e) =
            factory.createDao{value: value}(_daoParams(governanceType));
        return (id, NaveTreasury(payable(t)), NaveGovernor(g), NaveExecution(e));
    }

    /// Build a guardian-action EIP-712 digest for `treasury`.
    function _guardianDigest(
        NaveTreasury treasury,
        uint8 actionType,
        uint8 agentSlot,
        uint8 newStatus,
        address newKey,
        uint64 nonce,
        uint64 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                GUARDIAN_ACTION_TYPEHASH, actionType, agentSlot, newStatus, newKey, nonce, deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", treasury.domainSeparator(), structHash));
    }

    /// Push a fresh Pyth price for `feedId` into the MockPyth used by the suite.
    /// `publishTime` must be strictly greater than any prior update for that feed
    /// (MockPyth ignores non-increasing publish times).
    function _setPythPrice(bytes32 feedId, int64 price, uint64 conf, int32 expo) internal {
        _setPythPriceAt(feedId, price, conf, expo, uint64(block.timestamp));
    }

    function _setPythPriceAt(
        bytes32 feedId,
        int64 price,
        uint64 conf,
        int32 expo,
        uint64 publishTime
    ) internal {
        bytes[] memory upd = new bytes[](1);
        upd[0] = pyth.createPriceFeedUpdateData(
            feedId, price, conf, expo, price, conf, publishTime
        );
        uint256 fee = pyth.getUpdateFee(upd);
        vm.deal(address(this), address(this).balance + fee);
        pyth.updatePriceFeeds{value: fee}(upd);
    }

    function _gp(
        uint8 actionType,
        uint8 agentSlot,
        uint8 newStatus,
        address newKey,
        uint64 nonce,
        uint64 deadline
    ) internal pure returns (TreasuryGuardianLib.GuardianActionParams memory) {
        return TreasuryGuardianLib.GuardianActionParams(
            actionType, agentSlot, newStatus, newKey, nonce, deadline
        );
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Two-of-three guardian signatures (g1, g2) for an action.
    function _guardianSigs(
        NaveTreasury treasury,
        uint8 actionType,
        uint8 agentSlot,
        uint8 newStatus,
        address newKey,
        uint64 nonce,
        uint64 deadline
    ) internal view returns (bytes[] memory sigs) {
        bytes32 digest =
            _guardianDigest(treasury, actionType, agentSlot, newStatus, newKey, nonce, deadline);
        sigs = new bytes[](2);
        sigs[0] = _sign(g1Key, digest);
        sigs[1] = _sign(g2Key, digest);
    }

    /// Revalue NAV as the DAO founder (permissionless revalue removed — audit M-3).
    function _revalueTreasury(NaveTreasury treasury) internal {
        vm.prank(founder);
        treasury.revalueTreasury();
    }

    /// Put `adapter` on the protocol-level adapter allowlist (required before
    /// any DAO constitution may reference it — pre-redeploy hardening).
    /// Once a DAO exists the approval is queued, so warp past the delay.
    function _protocolApproveAdapter(address adapter) internal {
        vm.prank(owner);
        protocol.setAdapterApproved(adapter, true);
        if (!protocol.isApprovedAdapter(adapter)) {
            vm.warp(block.timestamp + NaveConstants.ADAPTER_APPROVAL_DELAY_SECS);
            protocol.applyAdapterApproval(adapter);
        }
    }

    /// Approve a single adapter (100% cap) in `treasury`'s constitution, taking
    /// care of the protocol allowlist first.
    function _approveAdapterInConstitution(NaveTreasury treasury, address adapter) internal {
        _protocolApproveAdapter(adapter);
        address[] memory adapters = new address[](1);
        adapters[0] = adapter;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000;
        bool[] memory approved = new bool[](1);
        approved[0] = true;
        string[] memory ids = new string[](1);
        ids[0] = "mock";
        vm.prank(founder);
        treasury.updateConstitution(adapters, bps, approved, ids, 70, 0);
    }
}
