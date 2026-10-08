// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveBridge} from "../src/NaveBridge.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {ReentrantBridgeToken} from "./mocks/ReentrantBridgeToken.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

/// @notice Adversarial / end-to-end coverage for the EVM bridge lockbox and the
/// one-signature bridge-back path, complementing the unit tests in
/// {NaveBridgeLockboxTest}. Focus: the full lock→relay→bridgeIn mint path, the
/// bridgeBurn→release path (mocked relayer), and the attacker cases called out
/// in the bridge audit — cross-key replay, cap-boundary abuse, pause bypass,
/// authorization gates, mint-time reentrancy (CEI), the per-chain supplyCap vs.
/// single-custody backing gap, and the single-step WrappedNave ownership risk.
contract BridgeE2ETest is Test {
    WrappedNave internal token;
    NaveBridge internal bridge;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    // Solana-side chain id used by the relayer for inbound messages.
    uint64 internal constant SOL_CHAIN = 900;
    uint64 internal constant OTHER_CHAIN = 901;
    bytes32 internal constant SOL_RECIPIENT = bytes32(uint256(0xBEEF));

    // per-tx cap 100 NAVE, daily cap 250 NAVE (6 decimals).
    uint256 internal constant PER_TX = 100_000_000;
    uint256 internal constant DAILY = 250_000_000;

    event BridgeIn(address indexed recipient, uint256 netAmount, uint64 indexed srcChainId, uint64 indexed srcNonce);
    event BridgeBurnTo(address indexed from, bytes32 indexed solanaRecipient, uint256 amount);
    event BridgeBurn(address indexed from, uint256 amount);

    function setUp() public {
        token = TestProxies.deployWrappedNave("Wrapped NAVE", "NAVE", 6, owner, owner);
        bridge = TestProxies.deployBridge(address(token), owner, relayer, PER_TX, DAILY);
        vm.prank(owner);
        token.setMinter(address(bridge));
        vm.prank(owner);
        bridge.acceptMinterRole();
    }

    // ── Full happy-path round trip: inbound mint then one-sig bridge-back ────

    /// lock(on Solana) → relayer verifies → bridgeIn mints net on EVM; then the
    /// user bridges back with a single signed bridgeBurn embedding the Solana
    /// recipient. Asserts balances and the recipient-authorizing event.
    function test_e2e_bridgeInThenBridgeBurnRoundTrip() public {
        // Inbound: relayer mints the NET (fee already taken on Solana).
        vm.expectEmit(true, true, true, true);
        emit BridgeIn(alice, 40_000_000, SOL_CHAIN, 1);
        vm.prank(relayer);
        bridge.bridgeIn(alice, 40_000_000, SOL_CHAIN, 1);
        assertEq(token.balanceOf(alice), 40_000_000);
        assertEq(token.totalSupply(), 40_000_000);

        // Outbound: one signed tx burns the gross and authorizes the exact
        // Solana payout address in the same transaction.
        vm.expectEmit(true, true, false, true);
        emit BridgeBurn(alice, 25_000_000);
        vm.expectEmit(true, true, false, true);
        emit BridgeBurnTo(alice, SOL_RECIPIENT, 25_000_000);
        vm.prank(alice);
        token.bridgeBurn(25_000_000, SOL_RECIPIENT);

        assertEq(token.balanceOf(alice), 15_000_000);
        assertEq(token.totalSupply(), 15_000_000, "burn reduces supply, unbacking on Solana handled by relayer");
    }

    /// FINDING (informational): `WrappedNave.burnFrom` is gated to the token's
    /// `minter`. In the lockbox deployment the minter is the {NaveBridge}
    /// CONTRACT (so all supply flows through the caps), and the lockbox exposes
    /// NO wrapper that calls `burnFrom`. Therefore the manager-initiated
    /// allowance-burn path is effectively unreachable here: the relayer EOA is
    /// not the minter, and the contract never calls it. Users bridge back via
    /// `burn`/`bridgeBurn` instead. This pins the gate + the dead path.
    function test_managerBurnFrom_isMinterGated_andUnreachableInLockbox() public {
        vm.prank(relayer);
        bridge.bridgeIn(alice, 30_000_000, SOL_CHAIN, 2);

        // Even with an allowance, the relayer (not the minter) cannot burnFrom.
        vm.prank(alice);
        token.approve(relayer, 30_000_000);
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        token.burnFrom(alice, 12_000_000);

        // The user's own burn/bridgeBurn is the supported exit.
        vm.prank(alice);
        token.bridgeBurn(12_000_000, SOL_RECIPIENT);
        assertEq(token.balanceOf(alice), 18_000_000);
    }

    // ── Replay across (srcChainId, srcNonce) ────────────────────────────────

    /// The replay key is keccak(srcChainId, srcNonce): the SAME nonce on a
    /// DIFFERENT source chain is a distinct message and must be payable, while a
    /// repeat of the exact pair is rejected. Guards a naive nonce-only guard.
    function test_replay_isKeyedOnChainIdAndNonce() public {
        vm.prank(relayer);
        bridge.bridgeIn(alice, 10_000_000, SOL_CHAIN, 5);

        // Same nonce, different chain id → different key → allowed.
        vm.prank(relayer);
        bridge.bridgeIn(alice, 10_000_000, OTHER_CHAIN, 5);
        assertEq(token.balanceOf(alice), 20_000_000);

        // Exact (chain, nonce) repeat on either chain → rejected.
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.AlreadyProcessed.selector);
        bridge.bridgeIn(alice, 10_000_000, SOL_CHAIN, 5);

        vm.prank(relayer);
        vm.expectRevert(NaveErrors.AlreadyProcessed.selector);
        bridge.bridgeIn(alice, 10_000_000, OTHER_CHAIN, 5);
    }

    // ── Per-tx cap boundary ─────────────────────────────────────────────────

    function test_perTxCap_boundaryExactVsOver() public {
        // Exactly the cap is allowed.
        vm.prank(relayer);
        bridge.bridgeIn(alice, PER_TX, SOL_CHAIN, 10);
        assertEq(token.balanceOf(alice), PER_TX);

        // One over reverts.
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.PerTxCapExceeded.selector);
        bridge.bridgeIn(alice, PER_TX + 1, SOL_CHAIN, 11);
    }

    // ── Daily-cap rolling-window boundary abuse ─────────────────────────────

    /// The rolling window is a single fixed 24h bucket, not a sliding average:
    /// an attacker who fills the cap at the very end of one window and again at
    /// the very start of the next can move 2x the daily cap across the boundary.
    /// This is intended (bounded, known) behavior; the test pins it so any
    /// future change to sliding-window semantics is a conscious decision.
    function test_dailyCap_windowBoundaryAllows2xAcrossReset() public {
        // Use a lockbox with no per-tx cap so the daily cap is the only bound.
        NaveBridge dcBridge = TestProxies.deployBridge(address(token), owner, relayer, 0, DAILY);
        vm.prank(owner);
        token.setMinter(address(dcBridge));
        vm.prank(owner);
        dcBridge.acceptMinterRole();

        // Fill the whole daily cap in window 1.
        vm.startPrank(relayer);
        dcBridge.bridgeIn(alice, DAILY, SOL_CHAIN, 20);
        // Any more in the same window is blocked.
        vm.expectRevert(NaveErrors.DailyCapExceeded.selector);
        dcBridge.bridgeIn(alice, 1, SOL_CHAIN, 21);
        vm.stopPrank();

        // Cross the 24h boundary: the window resets and the FULL cap is
        // available again — 2x the daily cap moved in a short wall-clock span.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(relayer);
        dcBridge.bridgeIn(alice, DAILY, SOL_CHAIN, 22);

        assertEq(token.balanceOf(alice), 2 * DAILY, "2x daily cap across the window boundary");
    }

    /// Within a single window the cap is a hard ceiling summed across txs; the
    /// boundary between "fits" and "one over" is exact.
    function test_dailyCap_sumBoundaryWithinWindow() public {
        vm.startPrank(relayer);
        bridge.bridgeIn(alice, PER_TX, SOL_CHAIN, 30); // 100
        bridge.bridgeIn(alice, PER_TX, SOL_CHAIN, 31); // 200
        // 200 + 50 = 250 == cap → allowed.
        bridge.bridgeIn(alice, 50_000_000, SOL_CHAIN, 32);
        // One more base unit tips over the cap.
        vm.expectRevert(NaveErrors.DailyCapExceeded.selector);
        bridge.bridgeIn(alice, 1, SOL_CHAIN, 33);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), DAILY);
    }

    // ── Pause bypass attempts ───────────────────────────────────────────────

    function test_pause_blocksMintButUsersCanStillBridgeBack() public {
        vm.prank(relayer);
        bridge.bridgeIn(alice, 20_000_000, SOL_CHAIN, 40);

        vm.prank(owner);
        bridge.setPaused(true);

        // Relayer cannot mint while paused, even with a valid unused nonce.
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.BridgePaused.selector);
        bridge.bridgeIn(alice, 1_000_000, SOL_CHAIN, 41);

        // Users can still exit (bridgeBurn lives on the token, not the lockbox).
        vm.prank(alice);
        token.bridgeBurn(5_000_000, SOL_RECIPIENT);
        assertEq(token.balanceOf(alice), 15_000_000);

        // Unpause restores minting on a fresh nonce (paused mints never
        // consumed the replay slot).
        vm.prank(owner);
        bridge.setPaused(false);
        vm.prank(relayer);
        bridge.bridgeIn(alice, 1_000_000, SOL_CHAIN, 41);
        assertEq(token.balanceOf(alice), 16_000_000);
    }

    function test_pause_onlyOwnerCanToggle() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, attacker));
        bridge.setPaused(true);
    }

    // ── Only-relayer / only-minter authorization gates ──────────────────────

    function test_onlyRelayer_ownerCannotMintDirectly() public {
        // Even the owner cannot call bridgeIn (separation of duties).
        vm.prank(owner);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        bridge.bridgeIn(alice, 1_000_000, SOL_CHAIN, 50);
    }

    function test_onlyMinter_directTokenMintBlockedForEveryoneButLockbox() public {
        // The lockbox is the sole minter; no EOA (relayer/owner/attacker) can
        // mint the token directly, so all supply flows through the caps.
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        token.mint(alice, 1);
        vm.prank(owner);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        token.mint(alice, 1);
        vm.prank(attacker);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        token.mint(alice, 1);
    }

    function test_setRelayer_onlyOwner_andRotationMovesTheGate() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, attacker));
        bridge.setRelayer(attacker);

        // Owner rotates to bob; old relayer loses the mint right immediately.
        vm.prank(owner);
        bridge.setRelayer(bob);
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        bridge.bridgeIn(alice, 1_000_000, SOL_CHAIN, 60);
        vm.prank(bob);
        bridge.bridgeIn(alice, 1_000_000, SOL_CHAIN, 60);
        assertEq(token.balanceOf(alice), 1_000_000);
    }

    // ── Mint-time reentrancy (checks-effects-interactions) ──────────────────

    /// Drive the lockbox against a hostile mintable token that re-enters
    /// `bridgeIn` with the SAME (chainId, nonce) during the mint call. Because
    /// the replay flag is set BEFORE the external mint (CEI), the re-entrant
    /// call reverts `AlreadyProcessed` — so a callback-bearing token can never
    /// double-mint the same source message.
    function test_reentrancy_mintCannotReplaySameKey() public {
        ReentrantBridgeToken evil = new ReentrantBridgeToken();
        NaveBridge evilBridge = TestProxies.deployBridge(address(evil), owner, relayer, 0, 0);
        evil.setBridge(address(evilBridge));

        // Arm a re-entrant bridgeIn with the identical key it is currently paying.
        evil.armReentry(attacker, 1_000_000, SOL_CHAIN, 70);

        vm.prank(relayer);
        evilBridge.bridgeIn(bob, 1_000_000, SOL_CHAIN, 70);

        assertTrue(evil.reentrantAttempted(), "reentry path exercised");
        assertTrue(evil.reentrantReverted(), "same-key reentry rejected by replay guard (CEI)");
        // Only the outer mint credited; the re-entrant same-key mint did not.
        assertEq(evil.balanceOf(bob), 1_000_000);
        assertEq(evil.balanceOf(attacker), 0);
        assertEq(evil.totalSupply(), 1_000_000);
    }

    // ── supplyCap stacking vs. single custody backing ───────────────────────

    /// FINDING (informational): `supplyCap` is a PER-CHAIN ceiling. Deploying
    /// wNAVE on both Base and Ethereum, each capped at X, permits up to 2X
    /// wNAVE in existence while a single Solana custody only backs X. Per-chain
    /// caps bound a single chain's blast radius but do NOT enforce the global
    /// 1:1 custody-backing invariant — that must be governed operationally
    /// (sum of per-chain caps ≤ custody). This test documents/pins the gap.
    function test_supplyCap_isPerChain_notGlobalBacking() public {
        uint256 cap = 100_000_000; // 100 NAVE per chain

        // Chain A stack.
        WrappedNave tokenA = TestProxies.deployWrappedNave("wNAVE-A", "NAVE", 6, owner, owner);
        NaveBridge bridgeA = TestProxies.deployBridge(address(tokenA), owner, relayer, 0, 0);
        vm.startPrank(owner);
        tokenA.setMinter(address(bridgeA));
        bridgeA.acceptMinterRole();
        tokenA.setSupplyCap(cap);
        vm.stopPrank();

        // Chain B stack (independent token + lockbox, same cap).
        WrappedNave tokenB = TestProxies.deployWrappedNave("wNAVE-B", "NAVE", 6, owner, owner);
        NaveBridge bridgeB = TestProxies.deployBridge(address(tokenB), owner, relayer, 0, 0);
        vm.startPrank(owner);
        tokenB.setMinter(address(bridgeB));
        bridgeB.acceptMinterRole();
        tokenB.setSupplyCap(cap);
        vm.stopPrank();

        // Each chain independently mints up to its own cap.
        vm.startPrank(relayer);
        bridgeA.bridgeIn(alice, cap, SOL_CHAIN, 1);
        bridgeB.bridgeIn(alice, cap, SOL_CHAIN, 1);
        vm.stopPrank();

        // Combined wNAVE across chains is 2x a single chain's cap.
        assertEq(tokenA.totalSupply() + tokenB.totalSupply(), 2 * cap);
        assertGt(tokenA.totalSupply() + tokenB.totalSupply(), cap);
    }

    // ── WrappedNave.transferOwnership two-step (audit remediation) ──────────

    /// REMEDIATION (audit low): WrappedNave.transferOwnership is now TWO-STEP,
    /// matching the lockbox and staking. Proposing does not move control, so a
    /// mistyped target can be re-pointed before it is accepted and cannot lock
    /// out administration.
    function test_wrappedNaveOwnership_twoStep_typoIsRecoverableBeforeAccept() public {
        // Ownable2Step: address(0) cancels a pending transfer rather than reverting.
        vm.prank(owner);
        token.transferOwnership(alice);
        vm.prank(owner);
        token.transferOwnership(address(0));
        assertEq(token.pendingOwner(), address(0));
        assertEq(token.owner(), owner);

        // A call to a wrong (but nonzero) address only PROPOSES; control stays.
        address typo = address(0xDEAD);
        vm.prank(owner);
        token.transferOwnership(typo);
        assertEq(token.owner(), owner);
        assertEq(token.pendingOwner(), typo);

        // The owner retains rights and can re-point to the correct address.
        vm.prank(owner);
        token.transferOwnership(alice);
        assertEq(token.pendingOwner(), alice);

        // The stale (typo) pending owner cannot claim.
        vm.prank(typo);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, typo));
        token.acceptOwnership();

        // The correct address accepts and ownership flips.
        vm.prank(alice);
        token.acceptOwnership();
        assertEq(token.owner(), alice);
    }

    // ── Lockbox two-step ownership (contrast) ───────────────────────────────

    /// The lockbox uses a safe two-step handoff: proposing does not move
    /// control, and a wrong pending owner cannot be claimed by anyone else.
    function test_lockboxOwnership_twoStep_isRecoverableBeforeAccept() public {
        vm.prank(owner);
        bridge.transferOwnership(bob);
        // Not transferred yet — owner can re-point the pending owner.
        assertEq(bridge.owner(), owner);
        vm.prank(owner);
        bridge.transferOwnership(alice);

        // The stale pending owner (bob) cannot claim.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, bob));
        bridge.acceptOwnership();

        // The current pending owner accepts.
        vm.prank(alice);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), alice);
    }

    // ── Zero-amount / zero-recipient guards ─────────────────────────────────

    function test_bridgeIn_zeroAmountAndZeroRecipientRejected() public {
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.ZeroAmount.selector);
        bridge.bridgeIn(alice, 0, SOL_CHAIN, 80);

        vm.prank(relayer);
        vm.expectRevert(NaveErrors.InvalidRecipient.selector);
        bridge.bridgeIn(address(0), 1_000_000, SOL_CHAIN, 80);
    }
}
