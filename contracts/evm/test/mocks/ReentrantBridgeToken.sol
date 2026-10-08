// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Minimal mint surface the lockbox drives.
interface IBridgeInReenter {
    function bridgeIn(address recipient, uint256 netAmount, uint64 srcChainId, uint64 srcNonce) external;
}

/// @notice Malicious mintable token used to prove {NaveBridge.bridgeIn} follows
/// checks-effects-interactions: the replay flag (`processed`) is written BEFORE
/// the external `mint` call, so a token that re-enters `bridgeIn` with the SAME
/// `(srcChainId, srcNonce)` during mint cannot double-pay — the re-entrant call
/// reverts `AlreadyProcessed`. The lockbox treats `wnave` as an opaque
/// `IWrappedNaveMintable`, so swapping in this hostile implementation is a valid
/// way to exercise the mint-time reentrancy window that the real (hook-free)
/// WrappedNave never exposes.
contract ReentrantBridgeToken {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    address public bridge;
    bool public armed;

    /// Records the outcome of the re-entrant same-key attempt for assertions.
    bool public reentrantAttempted;
    bool public reentrantReverted;

    // Re-entrant call parameters (same key as the outer call by default).
    address public reReceiver;
    uint256 public reAmount;
    uint64 public reChain;
    uint64 public reNonce;

    function setBridge(address b) external {
        bridge = b;
    }

    function armReentry(address receiver, uint256 amount, uint64 chain, uint64 nonce) external {
        armed = true;
        reReceiver = receiver;
        reAmount = amount;
        reChain = chain;
        reNonce = nonce;
    }

    function disarm() external {
        armed = false;
    }

    function mint(address to, uint256 amount) external {
        // Attempt to re-enter the lockbox during the mint (the interaction step).
        if (armed) {
            armed = false; // one-shot, avoid infinite recursion
            reentrantAttempted = true;
            try IBridgeInReenter(bridge).bridgeIn(reReceiver, reAmount, reChain, reNonce) {
                reentrantReverted = false;
            } catch {
                reentrantReverted = true;
            }
        }
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function acceptMinter() external {}
}
