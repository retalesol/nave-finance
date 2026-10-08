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
    event AgentKeyRotated(uint8 slot, address oldKey, address newKey);

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

    /// @return newFrozenAt Anchored freeze timestamp (unchanged if already frozen).
    function _freezeAt(uint256 frozenAt) private view returns (uint256) {
        return frozenAt == 0 ? block.timestamp : frozenAt;
    }

    function _clearRecoveryOnUnfreeze(RecoveryState storage recovery) private {
        if (recovery.executableAt != 0) {
            clearRecovery(recovery);
            emit GuardianRecoveryCancelled(msg.sender);
        }
    }

    function nullifyAgent(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        TreasuryAdminLib.AgentSlot[4] storage agents,
        uint256 frozenAt,
        uint8 role,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external returns (uint256 newFrozenAt) {
        if (role >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentRole();
        verifyGuardianAction(
            usedDigest,
            guardianWallets,
            guardianThreshold,
            address(this),
            uint8(GuardianActionType.NULLIFY_AGENT),
            role,
            0,
            address(0),
            nonce,
            deadline,
            signatures
        );
        address authority = TreasuryAdminLib.nullifyAgent(agents, role);
        newFrozenAt = _freezeAt(frozenAt);
        emit AgentNullified(role, authority);
    }

    function emergencyFreeze(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        uint256 frozenAt,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external returns (uint256 newFrozenAt) {
        verifyGuardianAction(
            usedDigest,
            guardianWallets,
            guardianThreshold,
            address(this),
            uint8(GuardianActionType.FREEZE),
            0,
            0,
            address(0),
            nonce,
            deadline,
            signatures
        );
        newFrozenAt = _freezeAt(frozenAt);
        emit DaoEmergencyFrozen(msg.sender);
    }

    function emergencyUnfreeze(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        RecoveryState storage recovery,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external {
        verifyGuardianAction(
            usedDigest,
            guardianWallets,
            guardianThreshold,
            address(this),
            uint8(GuardianActionType.UNFREEZE),
            0,
            0,
            address(0),
            nonce,
            deadline,
            signatures
        );
        _clearRecoveryOnUnfreeze(recovery);
        emit DaoEmergencyUnfrozen(msg.sender);
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

    function guardianVetoRecovery(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        RecoveryState storage recovery,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external {
        verifyGuardianAction(
            usedDigest,
            guardianWallets,
            guardianThreshold,
            address(this),
            uint8(GuardianActionType.CANCEL_RECOVERY),
            0,
            0,
            address(0),
            nonce,
            deadline,
            signatures
        );
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
        if (block.timestamp < frozenAt + NaveConstants.PROTOCOL_FORCE_UNFREEZE_TIMELOCK_SECS) {
            revert NaveErrors.RecoveryTimelockActive();
        }
        _clearRecoveryOnUnfreeze(recovery);
        emit DaoForceUnfrozen(msg.sender);
    }

    function guardianDisableAgents(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external {
        verifyGuardianAction(
            usedDigest,
            guardianWallets,
            guardianThreshold,
            address(this),
            uint8(GuardianActionType.DISABLE_AGENTS),
            0,
            0,
            address(0),
            nonce,
            deadline,
            signatures
        );
        emit AgentsToggled(false);
    }

    function updateAgentStatus(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        TreasuryAdminLib.AgentSlot[4] storage agents,
        uint8 slot,
        uint8 newStatus,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external {
        if (slot >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentSlot();
        if (newStatus > uint8(AgentStatus.Rotating)) revert NaveErrors.InvalidAgentStatus();
        verifyGuardianAction(
            usedDigest,
            guardianWallets,
            guardianThreshold,
            address(this),
            uint8(GuardianActionType.UPDATE_AGENT_STATUS),
            slot,
            newStatus,
            address(0),
            nonce,
            deadline,
            signatures
        );
        uint8 oldStatus = agents[slot].status;
        agents[slot].status = newStatus;
        emit AgentStatusChanged(slot, oldStatus, newStatus);
    }

    function rotateAgentKey(
        mapping(bytes32 => bool) storage usedDigest,
        address[] storage guardianWallets,
        uint8 guardianThreshold,
        TreasuryAdminLib.AgentSlot[4] storage agents,
        TreasuryAdminLib.PendingRotation[4] storage pendingRotations,
        uint8 slot,
        address newKey,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external {
        if (slot >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentSlot();
        if (newKey == address(0)) revert NaveErrors.ZeroAddress();
        verifyGuardianAction(
            usedDigest,
            guardianWallets,
            guardianThreshold,
            address(this),
            uint8(GuardianActionType.ROTATE_AGENT_KEY),
            slot,
            0,
            newKey,
            nonce,
            deadline,
            signatures
        );
        address oldKey = TreasuryAdminLib.rotateAgentKey(agents, pendingRotations, slot, newKey);
        emit AgentKeyRotated(slot, oldKey, newKey);
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
        executableAt = block.timestamp + NaveConstants.GUARDIAN_RECOVERY_TIMELOCK_SECS;
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
