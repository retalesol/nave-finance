// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {BaseStrategyAdapter} from "../src/adapters/BaseStrategyAdapter.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../src/adapters/CompoundV3Adapter.sol";
import {IComet} from "../src/adapters/external/IExternalProtocols.sol";
import {PayloadHash} from "../src/libraries/PayloadHash.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {NaveAddressRegistry} from "../script/config/NaveAddressRegistry.sol";
import {
    ProposalType,
    ProposalStatus,
    VoteChoice,
    ExecutionStatus
} from "../src/libraries/NaveEnums.sol";

/// @title TestnetE2E
/// @notice Live Sepolia / Base Sepolia lifecycle against deployed factory + Aave adapter.
/// Skips unless `EVM_TESTNET_LIVE=1`, `EVM_TESTNET_RPC_URL`, and `EVM_DEPLOY_PRIVATE_KEY` are set.
/// Run via `run-evm-testnet-suite.mjs` (loads wallet + deployments).
contract TestnetE2ETest is Test {
    bytes32 internal constant RH = keccak256("testnet-e2e-reasoning");
    uint256 internal constant FUND = 5e6; // 5 USDC
    uint256 internal constant DEPLOY = 1e6; // 1 USDC

    uint256 internal deployerKey;
    address internal deployer;
    address internal agentExec;
    address internal agentFin;
    address internal agentOver;
    address internal agentOper;
    address internal g1;
    address internal g2;
    address internal g3;

    function setUp() public {
        if (!_liveEnabled()) vm.skip(true);
        string memory rpc = vm.envString("EVM_TESTNET_RPC_URL");
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        deployerKey = vm.envUint("EVM_DEPLOY_PRIVATE_KEY");
        deployer = vm.addr(deployerKey);
        agentExec = vm.addr(uint256(keccak256("nave.testnet.exec")));
        agentFin = vm.addr(uint256(keccak256("nave.testnet.fin")));
        agentOver = vm.addr(uint256(keccak256("nave.testnet.over")));
        agentOper = vm.addr(uint256(keccak256("nave.testnet.oper")));
        g1 = vm.addr(uint256(keccak256("nave.testnet.g1")));
        g2 = vm.addr(uint256(keccak256("nave.testnet.g2")));
        g3 = vm.addr(uint256(keccak256("nave.testnet.g3")));
    }

    function _liveEnabled() internal view returns (bool) {
        try vm.envBool("EVM_TESTNET_LIVE") returns (bool live) {
            return live;
        } catch {
            return false;
        }
    }

    function _chainId() internal view returns (uint256) {
        return vm.envUint("EVM_TESTNET_CHAIN_ID");
    }

    function _factory() internal view returns (NaveDAOFactory) {
        address f = vm.envAddress("NAVE_FACTORY_ADDRESS");
        return NaveDAOFactory(f);
    }

    function _usdc() internal view returns (address) {
        return vm.envAddress("NAVE_TESTNET_USDC");
    }

    function _strategyAdapter() internal view returns (address) {
        return vm.envAddress("STRATEGY_ADAPTER");
    }

    function _strategyProtocolId() internal view returns (string memory) {
        return vm.envString("STRATEGY_PROTOCOL_ID");
    }

    function _aaveAdapter() internal view returns (address) {
        return vm.envAddress("AAVE_V3_ADAPTER");
    }

    function _daoParams() internal view returns (NaveDAOFactory.CreateDaoParams memory p) {
        address[] memory guardians = new address[](3);
        guardians[0] = g1;
        guardians[1] = g2;
        guardians[2] = g3;
        p = NaveDAOFactory.CreateDaoParams({
            name: "testnet-e2e",
            privacyMode: 0,
            guardianWallets: guardians,
            guardianThreshold: 2,
            agentAuthorities: [agentExec, agentFin, agentOver, agentOper],
            managementFeeBps: 65,
            performanceFeeBps: 850,
            frozenManagementFeeBps: 0,
            frozenPerformanceFeeBps: 0,
            protocolRevenueWallet: deployer,
            quorumBps: 1000,
            governanceType: 0
        });
    }

    function _fundUsdcIfNeeded(address usdc) internal {
        uint256 bal = IERC20(usdc).balanceOf(deployer);
        if (bal >= FUND) return;
        console.log("SKIP: deployer needs >= 5 USDC. Have:", bal);
        vm.skip(true);
    }

    function _assertCapitalDeployed(address adapterAddr, address usdc) internal view {
        bytes32 pid = keccak256(bytes(_strategyProtocolId()));
        if (pid == keccak256("compound-v3")) {
            address comet = address(CompoundV3Adapter(adapterAddr).comet());
            assertGt(IComet(comet).balanceOf(adapterAddr), 0, "capital in comet");
        } else if (pid == keccak256("aave-v3")) {
            address aToken = AaveV3Adapter(adapterAddr).aTokenFor(usdc);
            assertGt(IERC20(aToken).balanceOf(adapterAddr), 0, "capital in aave");
        } else {
            assertGt(IERC20(usdc).balanceOf(adapterAddr), 0, "capital in adapter");
        }
    }

    function test_testnet_strategy_fullLifecycle() public {
        uint256 chainId = _chainId();
        address usdc = _usdc();
        address adapterAddr = _strategyAdapter();
        require(adapterAddr != address(0), "STRATEGY_ADAPTER required");

        NaveAddressRegistry.ChainConfig memory cfg = NaveAddressRegistry.config(chainId);
        // Compound path uses Circle USDC on Sepolia; Aave path uses chain-specific reserve asset.
        if (keccak256(bytes(_strategyProtocolId())) == keccak256("aave-v3")) {
            assertTrue(cfg.aaveV3Pool != address(0), "aave pool pinned");
        }

        _fundUsdcIfNeeded(usdc);

        NaveDAOFactory factory = _factory();
        uint256 fee = factory.protocol().formationFee();

        vm.startBroadcast(deployerKey);
        (, address tAddr, address gAddr, address eAddr) = factory.createDao{value: fee}(_daoParams());
        vm.stopBroadcast();

        NaveTreasury t = NaveTreasury(payable(tAddr));
        NaveGovernor g = NaveGovernor(gAddr);
        NaveExecution e = NaveExecution(eAddr);

        console.log("E2E_DAO_TREASURY=", tAddr);

        vm.startBroadcast(deployerKey);
        t.registerAsset(usdc, bytes32(0), true, 0);
        IERC20(usdc).approve(tAddr, FUND);
        t.deposit(usdc, FUND);
        vm.stopBroadcast();

        address[] memory adapters = new address[](1);
        adapters[0] = adapterAddr;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000;
        bool[] memory approved = new bool[](1);
        approved[0] = true;
        string[] memory ids = new string[](1);
        ids[0] = _strategyProtocolId();

        // Protocol-level adapter allowlist (pre-redeploy hardening): the adapter
        // must be approved on NaveProtocol before any constitution can list it.
        // On testnet the deployer is the protocol owner; on a live chain where it
        // is not, the owner (Safe) must have run setAdapterApproved beforehand.
        NaveProtocol p = NaveProtocol(payable(address(factory.protocol())));
        if (!p.isApprovedAdapter(adapterAddr)) {
            require(p.owner() == deployer, "adapter not protocol-approved and deployer != owner");
            vm.startBroadcast(deployerKey);
            p.setAdapterApproved(adapterAddr, true);
            vm.stopBroadcast();
        }

        vm.startBroadcast(deployerKey);
        t.updateConstitution(adapters, bps, approved, ids, 70, 0);
        vm.stopBroadcast();

        vm.prank(agentExec);
        t.toggleAgents(true);

        bytes memory payload = abi.encode(adapterAddr, DEPLOY, usdc);
        vm.startBroadcast(deployerKey);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "deploy-aave",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Strategy),
                votingPeriodSeconds: NaveConstants.MIN_VOTING_PERIOD,
                votingMint: address(0)
            })
        );
        vm.stopBroadcast();

        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed), "proposal passed");

        vm.startBroadcast(deployerKey);
        e.createStrategyRequest(idx, DEPLOY, adapterAddr, usdc);
        vm.stopBroadcast();

        bytes32 ph = PayloadHash.strategyHash(adapterAddr, DEPLOY, usdc);
        vm.prank(agentExec);
        e.executiveApprove(idx, RH);
        vm.prank(agentFin);
        e.financialApprove(idx, ph, RH);
        vm.prank(agentOver);
        e.oversightApprove(idx, ph, RH);

        vm.warp(block.timestamp + uint256(int256(NaveConstants.DEFAULT_REVIEW_WINDOW_SECONDS)) + 1);

        vm.startBroadcast(deployerKey);
        t.revalueTreasury();
        vm.stopBroadcast();

        // EVM-C2: execute() is gated to the DAO's own registered agents.
        vm.prank(agentExec);
        e.execute(idx, 0);

        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed), "executed");
        _assertCapitalDeployed(adapterAddr, usdc);

        uint256 beforeBal = IERC20(usdc).balanceOf(tAddr);
        // First adapter deposit locks MIN_DEAD_SHARES; share rounding can shave a few wei.
        uint256 dead = BaseStrategyAdapter(adapterAddr).MIN_DEAD_SHARES();
        uint256 withdrawAmt = DEPLOY > dead + 100 ? DEPLOY - dead - 100 : DEPLOY / 2;
        vm.prank(agentExec);
        e.withdrawFromStrategy(idx, withdrawAmt, 0);
        assertGt(IERC20(usdc).balanceOf(tAddr), beforeBal, "withdrawn to treasury");

        // Transfer proposal (type 8)
        address grantee = vm.addr(uint256(keccak256("nave.testnet.grantee")));
        uint256 grant = 500_000; // 0.5 USDC
        bytes memory tpayload = abi.encode(usdc, grantee, grant);
        vm.startBroadcast(deployerKey);
        uint64 tIdx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "grant",
                description: "",
                payload: tpayload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: NaveConstants.MIN_VOTING_PERIOD,
                votingMint: address(0)
            })
        );
        vm.stopBroadcast();

        vm.prank(g1);
        g.castVoteWallet(tIdx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(tIdx, uint8(VoteChoice.For));
        g.finalizeProposal(tIdx);

        uint256 granteeBefore = IERC20(usdc).balanceOf(grantee);
        vm.startBroadcast(deployerKey);
        g.executeTransferProposal(tIdx, usdc, grantee, grant);
        vm.stopBroadcast();
        assertEq(IERC20(usdc).balanceOf(grantee) - granteeBefore, grant, "transfer disbursed");
    }
}
