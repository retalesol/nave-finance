// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {NaveConstants} from "./NaveConstants.sol";
import {NaveErrors} from "./NaveErrors.sol";
import {GuardianActionType, AgentStatus} from "./NaveEnums.sol";
import {TreasuryAdminLib} from "./TreasuryAdminLib.sol";
import {INaveProtocol} from "../interfaces/INaveProtocol.sol";

/// @title TreasuryGuardianLib
/// @notice EIP-712 guardian quorum verification, freeze/recovery, and agent
/// guardian actions — extracted from `NaveTreasury` for EIP-170 headroom.
/// Scalar state (`frozen`, `frozenAt`, `agentsEnabled`, `guardianThreshold`) is
/// returned for the facade to assign (Solidity forbids `bool storage` params).
library TreasuryGuardianLib {
    struct RecoveryState {
        address[] pendingWallets;
        uint8 pendingThreshold;
        uint256 executableAt;
    }

    event DaoEmergencyFrozen(address triggeredBy);
    event DaoEmergencyUnfrozen(address triggeredBy);
    event DaoForceUnfrozen(address by);
    event GuardianRecoveryQueued(uint256 executableAt, uint8 walletCount, uint8 threshold);
    event GuardianRecoveryCancelled(address by);
    event GuardianRecoveryExecuted(uint8 threshold, uint8 walletCount);
    event GuardianConfigUpdated(uint8 threshold, uint8 walletCount);
    event AgentsToggled(bool enabled);
    event AgentNullified(uint8 role, address agent);
    event AgentStatusChanged(uint8 slot, uint8 oldStatus, uint8 newStatus);
    event AgentChangeQueued(uint8 slot, address newKey, uint256 effectiveAt);
    event AgentRestored(uint8 role, address agent);
    event AgentRotationCancelled(uint8 role, address by);

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant GUARDIAN_ACTION_TYPEHASH = keccak256(
        "GuardianAction(uint8 actionType,uint8 agentSlot,uint8 newStatus,address newKey,uint64 nonce,uint64 deadline)"
    );

    function domainSeparator(address verifyingContract) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("NaveTreasury")),
                keccak256(bytes("1")),
                block.chainid,
                verifyingContract
            )
        );
    }

    function hashTypedDataV4(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function isGuardian(address[] storage guardianWallets, address wallet)
        external
        view
        returns (bool)
    {
        return guardianIndex(guardianWallets, wallet) >= 0;
    }

    /// Revert unless caller is the DAO founder or an active guardian.
    /// Used by emergencyPauseAgents and _reviewAnnotation to save bytecode in the facade.
    function requireFounderOrGuardian(
        address[] storage guardianWallets,
        address founder,
        address caller
    ) external view {
        if (caller != founder && guardianIndex(guardianWallets, caller) < 0) {
            revert NaveErrors.Unauthorized();
        }
    }

    function verifyGuardianAction(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        address verifyingContract,
        uint8 actionType,
        uint8 agentSlot,
        uint8 newStatus,
        address newKey,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) public {
        if (block.timestamp > deadline) revert NaveErrors.GuardianActionExpired();
        if (
            deadline
                > block.timestamp + uint64(uint256(int256(NaveConstants.GUARDIAN_ACTION_STALE_SECS)))
        ) {
            revert NaveErrors.GuardianActionExpired();
        }
        bytes32 structHash = keccak256(
            abi.encode(
                GUARDIAN_ACTION_TYPEHASH, actionType, agentSlot, newStatus, newKey, nonce, deadline
            )
        );
        bytes32 digest = hashTypedDataV4(domainSeparator(verifyingContract), structHash);
        if (usedDigest[digest]) revert NaveErrors.InvalidGuardianSignature();

        uint256 mask;
        uint256 count;
        uint256 len = signatures.length;
        for (uint256 i; i < len; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            int256 idx = guardianIndex(guardianWallets, signer);
            if (idx < 0) revert NaveErrors.GuardianNotFound();
            uint256 bit = 1 << uint256(idx);
            if (mask & bit != 0) revert NaveErrors.DuplicateGuardianSignature();
            mask |= bit;
            unchecked {
                count++;
            }
        }
        if (count < guardianThreshold) revert NaveErrors.InvalidGuardianThreshold();
        usedDigest[digest] = true;
    }

    function guardianIndex(address[] storage guardianWallets, address wallet)
        internal
        view
        returns (int256)
    {
        uint256 n = guardianWallets.length;
        for (uint256 i; i < n; i++) {
            if (guardianWallets[i] == wallet) return int256(i);
        }
        return -1;
    }

    /// Facade side effects returned by {guardianAction}. Scalar treasury state
    /// cannot be passed as a storage reference, so the facade applies these.
    uint8 internal constant EFFECT_NONE = 0;
    uint8 internal constant EFFECT_FREEZE = 1;
    uint8 internal constant EFFECT_UNFREEZE = 2;
    uint8 internal constant EFFECT_DISABLE_AGENTS = 3;
    uint8 internal constant EFFECT_ENABLE_AGENTS = 4;

    /// The fields signed in the GuardianAction EIP-712 struct.
    struct GuardianActionParams {
        uint8 actionType;
        uint8 slot;
        uint8 newStatus;
        address newKey;
        uint64 nonce;
        uint64 deadline;
    }

    /// Single guardian M-of-N entry point (EIP-170 headroom for the facade).
    /// Every action is bound to its own `actionType` in the signed digest.
    ///  - FREEZE / UNFREEZE (unfreeze also clears a pending recovery)
    ///  - NULLIFY_AGENT: nullify `slot` and freeze
    ///  - DISABLE_AGENTS: disable and lock the pipeline (Executive cannot undo)
    ///  - ENABLE_AGENTS: clear the lock and re-enable
    ///  - CANCEL_RECOVERY: veto a founder-queued guardian recovery
    ///  - UPDATE_AGENT_STATUS: pause/revoke now; return to Active is queued
    ///  - ROTATE_AGENT_KEY: queued for GUARDIAN_AGENT_CHANGE_DELAY_SECS
    ///  - RESTORE_AGENT: un-nullify `slot` (does not unfreeze)
    ///  - CANCEL_AGENT_ROTATION: veto any pending rotation for `slot`
    function guardianAction(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        TreasuryAdminLib.AgentSlot[4] storage agents,
        TreasuryAdminLib.PendingRotation[4] storage pendingRotations,
        RecoveryState storage recovery,
        address founder,
        GuardianActionParams calldata c,
        bytes[] calldata signatures
    ) external returns (uint8 effect) {
        verifyGuardianAction(
            usedDigest,
            guardianWallets,
            guardianThreshold,
            address(this),
            c.actionType,
            c.slot,
            c.newStatus,
            c.newKey,
            c.nonce,
            c.deadline,
            signatures
        );
        uint8 a = c.actionType;
        if (a == GuardianActionType.FREEZE) {
            emit DaoEmergencyFrozen(msg.sender);
            return EFFECT_FREEZE;
        }
        if (a == GuardianActionType.UNFREEZE) {
            _clearRecoveryOnUnfreeze(recovery);
            emit DaoEmergencyUnfrozen(msg.sender);
            return EFFECT_UNFREEZE;
        }
        if (a == GuardianActionType.DISABLE_AGENTS) {
            emit AgentsToggled(false);
            return EFFECT_DISABLE_AGENTS;
        }
        if (a == GuardianActionType.ENABLE_AGENTS) {
            emit AgentsToggled(true);
            return EFFECT_ENABLE_AGENTS;
        }
        if (a == GuardianActionType.CANCEL_RECOVERY) {
            clearRecovery(recovery);
            emit GuardianRecoveryCancelled(msg.sender);
            return EFFECT_NONE;
        }
        uint8 slot = c.slot;
        if (slot >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentSlot();
        if (a == GuardianActionType.NULLIFY_AGENT) {
            emit AgentNullified(slot, TreasuryAdminLib.nullifyAgent(agents, slot));
            return EFFECT_FREEZE;
        }
        if (a == GuardianActionType.UPDATE_AGENT_STATUS) {
            uint8 newStatus = c.newStatus;
            if (newStatus > uint8(AgentStatus.Rotating)) revert NaveErrors.InvalidAgentStatus();
            uint8 oldStatus = agents[slot].status;
            if (newStatus == uint8(AgentStatus.Active) && oldStatus != newStatus) {
                address current = agents[slot].authority;
                emit AgentChangeQueued(
                    slot,
                    current,
                    TreasuryAdminLib.queueGuardianAgentChange(
                        agents, pendingRotations, guardianWallets, founder, slot, current
                    )
                );
            } else {
                agents[slot].status = newStatus;
                emit AgentStatusChanged(slot, oldStatus, newStatus);
            }
        } else if (a == GuardianActionType.ROTATE_AGENT_KEY) {
            emit AgentChangeQueued(
                slot,
                c.newKey,
                TreasuryAdminLib.queueGuardianAgentChange(
                    agents, pendingRotations, guardianWallets, founder, slot, c.newKey
                )
            );
        } else if (a == GuardianActionType.RESTORE_AGENT) {
            emit AgentRestored(slot, TreasuryAdminLib.restoreAgent(agents, slot));
        } else if (a == GuardianActionType.CANCEL_AGENT_ROTATION) {
            TreasuryAdminLib.cancelAgentRotation(pendingRotations, slot);
            emit AgentRotationCancelled(slot, msg.sender);
        } else {
            revert NaveErrors.InvalidAgentStatus();
        }
    }

    function _clearRecoveryOnUnfreeze(RecoveryState storage recovery) private {
        if (recovery.executableAt != 0) {
            clearRecovery(recovery);
            emit GuardianRecoveryCancelled(msg.sender);
        }
    }

    function queueGuardianRecovery(
        bool frozen,
        RecoveryState storage recovery,
        address[] calldata wallets,
        uint8 threshold
    ) external {
        if (!frozen) revert NaveErrors.DaoNotFrozen();
        uint256 executableAt = queueRecovery(recovery, wallets, threshold);
        emit GuardianRecoveryQueued(executableAt, uint8(wallets.length), threshold);
    }

    function executeGuardianRecovery(
        bool frozen,
        RecoveryState storage recovery,
        address[] storage guardianWallets
    ) external returns (uint8 newThreshold) {
        if (!frozen) revert NaveErrors.DaoNotFrozen();
        uint8 walletCount;
        (newThreshold, walletCount) = executeRecovery(recovery, guardianWallets);
        emit GuardianRecoveryExecuted(newThreshold, walletCount);
        emit GuardianConfigUpdated(newThreshold, walletCount);
    }

    function cancelGuardianRecovery(RecoveryState storage recovery) external {
        clearRecovery(recovery);
        emit GuardianRecoveryCancelled(msg.sender);
    }

    function forceUnfreeze(
        INaveProtocol protocol,
        bool frozen,
        uint256 frozenAt,
        RecoveryState storage recovery
    ) external {
        if (msg.sender != protocol.owner()) revert NaveErrors.Unauthorized();
        if (!frozen) revert NaveErrors.DaoNotFrozen();
        if (block.timestamp < frozenAt + NaveConstants.protocolForceUnfreezeTimelockSecs()) {
            revert NaveErrors.RecoveryTimelockActive();
        }
        _clearRecoveryOnUnfreeze(recovery);
        emit DaoForceUnfrozen(msg.sender);
    }

    function recoveryPending(RecoveryState storage r)
        external
        view
        returns (uint256 executableAt, uint8 pendingThreshold, uint256 pendingWalletCount)
    {
        return (r.executableAt, r.pendingThreshold, r.pendingWallets.length);
    }

    function queueRecovery(
        RecoveryState storage r,
        address[] calldata wallets,
        uint8 threshold
    ) public returns (uint256 executableAt) {
        if (wallets.length == 0 || wallets.length > NaveConstants.MAX_GUARDIAN_WALLETS) {
            revert NaveErrors.TooManyGuardianWallets();
        }
        if (
            threshold == 0 || threshold > NaveConstants.MAX_GUARDIAN_THRESHOLD
                || threshold > wallets.length
        ) {
            revert NaveErrors.InvalidGuardianThreshold();
        }
        uint256 n = wallets.length;
        for (uint256 i; i < n; i++) {
            if (wallets[i] == address(0)) revert NaveErrors.ZeroAddress();
            for (uint256 j = i + 1; j < n; j++) {
                if (wallets[i] == wallets[j]) revert NaveErrors.DuplicateGuardianWallet();
            }
        }
        delete r.pendingWallets;
        for (uint256 i; i < n; i++) {
            r.pendingWallets.push(wallets[i]);
        }
        r.pendingThreshold = threshold;
        executableAt = block.timestamp + NaveConstants.guardianRecoveryTimelockSecs();
        r.executableAt = executableAt;
    }

    function executeRecovery(RecoveryState storage r, address[] storage guardianWallets)
        public
        returns (uint8 newThreshold, uint8 walletCount)
    {
        if (r.executableAt == 0) revert NaveErrors.NoGuardianRecoveryPending();
        if (block.timestamp < r.executableAt) revert NaveErrors.RecoveryTimelockActive();
        while (guardianWallets.length > 0) {
            guardianWallets.pop();
        }
        uint256 n = r.pendingWallets.length;
        for (uint256 i; i < n; i++) {
            guardianWallets.push(r.pendingWallets[i]);
        }
        newThreshold = r.pendingThreshold;
        walletCount = uint8(n);
        clearRecovery(r);
    }

    function clearRecovery(RecoveryState storage r) public {
        if (r.executableAt == 0) revert NaveErrors.NoGuardianRecoveryPending();
        delete r.pendingWallets;
        r.pendingThreshold = 0;
        r.executableAt = 0;
    }
}
