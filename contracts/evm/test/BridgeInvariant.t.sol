// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveBridge} from "../src/NaveBridge.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

/// @notice Stateful-fuzz handler driving the EVM lockbox mint (`bridgeIn`) and
/// the one-signature user exits (`bridgeBurn` / `burn`) so the invariant engine
/// can hammer arbitrary interleavings. Caps + pause are left OPEN here so the
/// campaign explores the value-conservation surface rather than getting stuck on
/// cap reverts (cap/pause enforcement is pinned separately by the unit + fuzz
/// tests in {BridgeE2ETest} / {BridgeSupplyFuzzTest}).
contract BridgeInvariantHandler is Test {
    WrappedNave public token;
    NaveBridge public bridge;
    address public relayer;

    // Fixed actor set the fuzzer bridges to / burns from.
    address[] public actors;

    // Ghost accounting the invariants check the real supply against.
    uint256 public ghostNetMinted; // sum of every net amount minted via bridgeIn
    uint256 public ghostBurned; // sum of every wNAVE burned by users
    uint64 public nonceCounter; // strictly-increasing so no replay revert

    uint64 internal constant SOL_CHAIN = 900;
    uint256 internal constant MAX_MINT = 1_000_000_000_000; // 1e12 base units/call

    constructor(WrappedNave token_, NaveBridge bridge_, address relayer_) {
        token = token_;
        bridge = bridge_;
        relayer = relayer_;
        actors.push(makeAddr("inv_alice"));
        actors.push(makeAddr("inv_bob"));
        actors.push(makeAddr("inv_carol"));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// Relayer mints `netAmount` to an actor with a fresh nonce (always succeeds
    /// with open caps + unpaused), so `ghostNetMinted` tracks total minted.
    function bridgeIn(uint256 amount, uint256 actorSeed) external {
        amount = bound(amount, 1, MAX_MINT);
        address to = _actor(actorSeed);
        nonceCounter += 1;
        vm.prank(relayer);
        bridge.bridgeIn(to, amount, SOL_CHAIN, nonceCounter);
        ghostNetMinted += amount;
    }

    /// An actor burns part of its balance to bridge back (single-sig exit).
    function bridgeBurn(uint256 amount, uint256 actorSeed) external {
        address from = _actor(actorSeed);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        token.bridgeBurn(amount, bytes32(uint256(0xABCD)));
        ghostBurned += amount;
    }

    /// Plain burn exit (no embedded recipient) — same supply effect.
    function burn(uint256 amount, uint256 actorSeed) external {
        address from = _actor(actorSeed);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        token.burn(amount);
        ghostBurned += amount;
    }
}

/// @notice Invariant coverage for the EVM bridge supply model. The core safety
/// property of the wNAVE lockbox is that ALL supply is created by the lockbox
/// minting the NET amount (the fee is resolved on Solana, so the EVM side never
/// adds or removes fee) and is only ever destroyed by user burns. Therefore, at
/// every reachable state:
///
///   totalSupply() == (Σ net minted via bridgeIn) − (Σ burned by users)
///
/// This is the on-chain half of the global custody-backing invariant: minted
/// wNAVE must always be traceable to a net bridged amount, and a burn must
/// always reduce supply (unbacking is settled by the relayer releasing NAVE on
/// Solana). It also guarantees the lockbox can never inflate supply beyond what
/// it minted (no phantom mint via reentrancy / replay).
contract BridgeInvariantTest is Test {
    WrappedNave internal token;
    NaveBridge internal bridge;
    BridgeInvariantHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        token = TestProxies.deployWrappedNave("Wrapped NAVE", "NAVE", 6, owner, owner);
        // perTxCap = 0, dailyCap = 0 → unlimited, so the fuzz explores value
        // conservation without cap reverts. (Cap enforcement is a separate test.)
        bridge = TestProxies.deployBridge(address(token), owner, relayer, 0, 0);
        vm.prank(owner);
        token.setMinter(address(bridge));
        vm.prank(owner);
        bridge.acceptMinterRole();

        handler = new BridgeInvariantHandler(token, bridge, relayer);
        targetContract(address(handler));
    }

    /// Supply is exactly what was minted minus what was burned — no value is
    /// created or lost by the lockbox across arbitrary mint/burn interleavings.
    function invariant_supplyEqualsNetMintedMinusBurned() public view {
        assertEq(
            token.totalSupply(),
            handler.ghostNetMinted() - handler.ghostBurned(),
            "supply must equal net-minted minus burned"
        );
    }

    /// Burning can only ever decrease supply below the cumulative minted total;
    /// the lockbox never mints more than the fuzzer instructed (no phantom mint).
    function invariant_supplyNeverExceedsCumulativeMinted() public view {
        assertLe(
            token.totalSupply(),
            handler.ghostNetMinted(),
            "supply can never exceed cumulative net minted"
        );
    }
}
