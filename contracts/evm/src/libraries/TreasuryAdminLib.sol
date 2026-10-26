// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INaveProtocol} from "../interfaces/INaveProtocol.sol";
import {INaveDaoStake} from "../interfaces/INaveDaoStake.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {NaveConstants} from "./NaveConstants.sol";
import {NaveErrors} from "./NaveErrors.sol";
import {NaveStructs} from "./NaveStructs.sol";
import {FeeMath} from "./FeeMath.sol";
import {OracleMath} from "./OracleMath.sol";
import {AnnotationStatus, AgentRole, AgentStatus, GovernanceType, PrivacyMode} from "./NaveEnums.sol";
import {NaveTokenDeployer} from "../NaveTokenDeployer.sol";
import {NaveDaoToken} from "../NaveDaoToken.sol";
import {TreasuryValuationLib} from "./TreasuryValuationLib.sol";
import {TreasuryStrategyLib} from "./TreasuryStrategyLib.sol";
import {ProtocolFeeLib} from "./ProtocolFeeLib.sol";

/// @title TreasuryAdminLib
/// @notice External (DELEGATECALL-linked) library holding the bulkier
/// founder-config logic — constitution updates, the DAO token registry, and
/// holder annotations — so `NaveTreasury` stays under the EIP-170 24KB limit.
/// Functions operate directly on the treasury's storage references; access
/// control and event emission remain in the facade.
library TreasuryAdminLib {
    using SafeERC20 for IERC20;

    struct InitParams {
        address protocol;
        address governor;
        address execution;
        address oracle;
        address tokenDeployer;
        uint256 daoId;
        address founder;
        string name;
        uint8 privacyMode;
        address[] guardianWallets;
        uint8 guardianThreshold;
        address[4] agentAuthorities;
        uint16 managementFeeBps;
        uint16 performanceFeeBps;
        uint16 frozenManagementFeeBps;
        uint16 frozenPerformanceFeeBps;
        address protocolRevenueWallet;
        uint16 quorumBps;
        uint8 governanceType;
    }

    struct AgentSlot {
        address authority;
        bool active;
        bool nullified;
        uint8 status;
    }

    struct PendingRotation {
        address pendingAuthority;
        uint256 effectiveAt;
    }

    /// Revert unless `signer` is the active, non-nullified authority for `role`.
    /// Extracted to save bytecode in NaveTreasury (called via DELEGATECALL).
    function requireAgentAuthority(
        AgentSlot[4] storage agents,
        address signer,
        uint8 role
    ) external view {
        AgentSlot storage s = agents[role];
        bool operational = s.active && !s.nullified && s.status == uint8(AgentStatus.Active)
            && s.authority != address(0);
        if (!operational) revert NaveErrors.AgentNullified();
        if (signer != s.authority) revert NaveErrors.Unauthorized();
    }

    /// Revert unless `caller` is `founder` or an active, non-nullified Oversight agent (`AgentRole.Operational`).
    /// Used by revalueTreasury.
    function requireFounderOrOperational(
        AgentSlot[4] storage agents,
        address founder,
        address caller
    ) external view {
        if (caller == founder) return;
        AgentSlot storage s = agents[uint8(AgentRole.Operational)];
        bool operational = s.active && !s.nullified && s.status == uint8(AgentStatus.Active)
            && s.authority != address(0) && caller == s.authority;
        if (!operational) revert NaveErrors.Unauthorized();
    }

    function initAgents(
        AgentSlot[4] storage agents,
        address[4] calldata authorities,
        address founder,
        address[] calldata guardianWallets
    ) external {
        for (uint256 i; i < NaveConstants.AGENT_COUNT; i++) {
            _requireAgentKeyOutsideRoles(authorities[i], founder, guardianWallets);
            for (uint256 j = i + 1; j < NaveConstants.AGENT_COUNT; j++) {
                if (authorities[i] == authorities[j]) revert NaveErrors.AgentKeyConflict();
            }
            agents[i] = AgentSlot({
                authority: authorities[i],
                active: true,
                nullified: false,
                status: uint8(AgentStatus.Active)
            });
        }
    }

    /// One key per role: an agent key may not be zero, the founder, a guardian,
    /// or the current authority of any other slot.
    function requireAgentKeyAllowed(
        AgentSlot[4] storage agents,
        address[] storage guardianWallets,
        address founder,
        uint256 slot,
        address key
    ) public view {
        if (key == address(0) || key == founder) revert NaveErrors.AgentKeyConflict();
        for (uint256 g; g < guardianWallets.length; g++) {
            if (guardianWallets[g] == key) revert NaveErrors.AgentKeyConflict();
        }
        for (uint256 j; j < NaveConstants.AGENT_COUNT; j++) {
            if (j != slot && agents[j].authority == key) revert NaveErrors.AgentKeyConflict();
        }
    }

    function _requireAgentKeyOutsideRoles(
        address key,
        address founder,
        address[] calldata guardianWallets
    ) private pure {
        if (key == address(0) || key == founder) revert NaveErrors.AgentKeyConflict();
        for (uint256 g; g < guardianWallets.length; g++) {
            if (guardianWallets[g] == key) revert NaveErrors.AgentKeyConflict();
        }
    }

    function initGuardians(address[] storage guardianWallets, address[] calldata wallets) external {
        for (uint256 i; i < wallets.length; i++) {
            guardianWallets.push(wallets[i]);
        }
    }

    function scheduleAgentRotations(
        AgentSlot[4] storage agents,
        PendingRotation[4] storage pendingRotations,
        address[4] calldata authorities,
        address founder,
        address[] storage guardianWallets
    ) external returns (uint256 effectiveAt) {
        effectiveAt = block.timestamp + NaveConstants.agentRotationDelaySecs();
        for (uint256 i; i < NaveConstants.AGENT_COUNT; i++) {
            if (authorities[i] == address(0) || authorities[i] == founder) {
                revert NaveErrors.AgentKeyConflict();
            }
            for (uint256 g; g < guardianWallets.length; g++) {
                if (guardianWallets[g] == authorities[i]) revert NaveErrors.AgentKeyConflict();
            }
            for (uint256 j = i + 1; j < NaveConstants.AGENT_COUNT; j++) {
                if (authorities[i] == authorities[j]) revert NaveErrors.AgentKeyConflict();
            }
        }
        for (uint256 i; i < NaveConstants.AGENT_COUNT; i++) {
            if (agents[i].nullified) continue;
            if (agents[i].authority == authorities[i]) {
                pendingRotations[i] = PendingRotation(address(0), 0);
                continue;
            }
            pendingRotations[i] = PendingRotation(authorities[i], effectiveAt);
        }
    }

    /// Apply a matured rotation (founder 48h or guardian 24h). Permissionless:
    /// authorization happened when it was queued. A pending authority equal to
    /// the current one is a queued re-activation. Re-checks key uniqueness
    /// because the guardian set or other slots may have changed meanwhile.
    function applyAgentRotation(
        AgentSlot[4] storage agents,
        PendingRotation[4] storage pendingRotations,
        address[] storage guardianWallets,
        address founder,
        uint8 role
    ) external returns (address newAuthority) {
        if (role >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentRole();
        PendingRotation memory pending = pendingRotations[role];
        if (pending.pendingAuthority == address(0)) revert NaveErrors.NoPendingAgentRotation();
        if (block.timestamp < pending.effectiveAt) revert NaveErrors.AgentRotationNotReady();
        if (agents[role].nullified) revert NaveErrors.AgentNullified();
        requireAgentKeyAllowed(agents, guardianWallets, founder, role, pending.pendingAuthority);
        agents[role].authority = pending.pendingAuthority;
        agents[role].active = true;
        agents[role].status = uint8(AgentStatus.Active);
        pendingRotations[role] = PendingRotation(address(0), 0);
        newAuthority = pending.pendingAuthority;
    }

    function cancelAgentRotation(PendingRotation[4] storage pendingRotations, uint8 role)
        public
    {
        if (role >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentRole();
        if (pendingRotations[role].pendingAuthority == address(0)) {
            revert NaveErrors.NoPendingAgentRotation();
        }
        pendingRotations[role] = PendingRotation(address(0), 0);
    }

    function nullifyAgent(AgentSlot[4] storage agents, uint8 role)
        external
        returns (address authority)
    {
        if (role >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentRole();
        AgentSlot storage s = agents[role];
        if (s.nullified) revert NaveErrors.AgentAlreadyNullified();
        s.nullified = true;
        s.active = false;
        authority = s.authority;
    }

    function restoreAgent(AgentSlot[4] storage agents, uint8 role)
        external
        returns (address authority)
    {
        if (role >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentRole();
        AgentSlot storage s = agents[role];
        if (!s.nullified) revert NaveErrors.Unauthorized();
        s.nullified = false;
        s.active = true;
        authority = s.authority;
    }

    /// Guardian-initiated rotation (or re-activation when `newKey` is the
    /// current authority). Queued behind GUARDIAN_AGENT_CHANGE_DELAY_SECS so
    /// the founder can cancel a hostile guardian quorum's change.
    function queueGuardianAgentChange(
        AgentSlot[4] storage agents,
        PendingRotation[4] storage pendingRotations,
        address[] storage guardianWallets,
        address founder,
        uint8 slot,
        address newKey
    ) public returns (uint256 effectiveAt) {
        if (agents[slot].nullified) revert NaveErrors.AgentNullified();
        requireAgentKeyAllowed(agents, guardianWallets, founder, slot, newKey);
        effectiveAt = block.timestamp + NaveConstants.guardianAgentChangeDelaySecs();
        pendingRotations[slot] = PendingRotation(newKey, effectiveAt);
    }

    // ── Constitution ──────────────────────────────────────────────────────
    /// Replace the DAO constitution. Every listed adapter must be on the
    /// protocol-level allowlist (`NaveProtocol.isApprovedAdapter`) — the
    /// founder alone cannot route treasury capital into an arbitrary contract.
    function updateConstitution(
        INaveProtocol protocol,
        mapping(address => NaveStructs.ProtocolEntry) storage constitution,
        address[] storage approvedAdapters,
        address[] calldata adapters,
        uint16[] calldata maxAllocationBps,
        bool[] calldata approved,
        string[] calldata protocolIds,
        uint8 newConfidenceThreshold
    ) external returns (uint8 count) {
        if (newConfidenceThreshold > NaveConstants.MAX_CONFIDENCE_THRESHOLD) {
            revert NaveErrors.InvalidConfidenceThreshold();
        }
        uint256 n = adapters.length;
        if (n == 0 || n > NaveConstants.MAX_CONSTITUTION_PROTOCOLS) {
            revert NaveErrors.TooManyProtocols();
        }
        if (maxAllocationBps.length != n || approved.length != n || protocolIds.length != n) {
            revert NaveErrors.InvalidPolicyParameters();
        }
        uint256 prev = approvedAdapters.length;
        for (uint256 i; i < prev; i++) {
            delete constitution[approvedAdapters[i]];
        }
        // Reset the list.
        while (approvedAdapters.length > 0) {
            approvedAdapters.pop();
        }
        for (uint256 i; i < n; i++) {
            if (maxAllocationBps[i] > 10_000) revert NaveErrors.InvalidBps();
            if (adapters[i] == address(0)) revert NaveErrors.ZeroAddress();
            if (!protocol.isApprovedAdapter(adapters[i])) {
                revert NaveErrors.AdapterNotProtocolApproved();
            }
            constitution[adapters[i]] = NaveStructs.ProtocolEntry({
                maxAllocationBps: maxAllocationBps[i],
                approved: approved[i],
                protocolId: protocolIds[i]
            });
            approvedAdapters.push(adapters[i]);
        }
        _enforceRiskTierTotals(protocol, adapters, maxAllocationBps, approved);
        return uint8(n);
    }

    /// Approved caps summed per venue tier must fit the tier ceilings, so the
    /// combined exposure to riskier venues stays bounded however agents allocate.
    function _enforceRiskTierTotals(
        INaveProtocol protocol,
        address[] calldata adapters,
        uint16[] calldata maxAllocationBps,
        bool[] calldata approved
    ) private view {
        uint256 tier2;
        uint256 tier3;
        for (uint256 i; i < adapters.length; i++) {
            if (!approved[i]) continue;
            uint8 tier = protocol.riskTierOf(adapters[i]);
            if (tier == 2) tier2 += maxAllocationBps[i];
            else if (tier == 3) tier3 += maxAllocationBps[i];
        }
        if (tier2 > NaveConstants.MAX_TIER2_TOTAL_BPS || tier3 > NaveConstants.MAX_TIER3_TOTAL_BPS) {
            revert NaveErrors.RiskTierCapExceeded();
        }
    }

    // ── Guardians ─────────────────────────────────────────────────────────
    function requireUniqueGuardians(address[] calldata wallets) public pure {
        uint256 n = wallets.length;
        for (uint256 i; i < n; i++) {
            if (wallets[i] == address(0)) revert NaveErrors.ZeroAddress();
            for (uint256 j = i + 1; j < n; j++) {
                if (wallets[i] == wallets[j]) revert NaveErrors.DuplicateGuardianWallet();
            }
        }
    }

    function updateGuardianConfig(
        AgentSlot[4] storage agents,
        address[] storage guardianWallets,
        address[] calldata wallets,
        uint8 threshold
    ) external {
        for (uint256 i; i < wallets.length; i++) {
            for (uint256 j; j < NaveConstants.AGENT_COUNT; j++) {
                if (agents[j].authority == wallets[i]) revert NaveErrors.AgentKeyConflict();
            }
        }
        if (wallets.length == 0 || wallets.length > NaveConstants.MAX_GUARDIAN_WALLETS) {
            revert NaveErrors.TooManyGuardianWallets();
        }
        if (
            threshold == 0 || threshold > NaveConstants.MAX_GUARDIAN_THRESHOLD
                || threshold > wallets.length
        ) {
            revert NaveErrors.InvalidGuardianThreshold();
        }
        requireUniqueGuardians(wallets);
        while (guardianWallets.length > 0) {
            guardianWallets.pop();
        }
        for (uint256 i; i < wallets.length; i++) {
            guardianWallets.push(wallets[i]);
        }
    }

    // ── Assets ────────────────────────────────────────────────────────────
    function requireNotMoonlighting(INaveProtocol protocol) external view {
        address stake = protocol.daoStake();
        if (stake == address(0)) return;
        if (INaveDaoStake(stake).isMoonlighting(address(this))) {
            revert NaveErrors.DaoMoonlighting();
        }
    }

    function registerAsset(
        mapping(address => NaveStructs.AssetRecord) storage assets,
        address[] storage registeredAssets,
        address asset,
        bytes32 pythFeedId,
        bool isStablecoin,
        uint8 assetKind
    ) external {
        if (asset == address(0)) revert NaveErrors.ZeroAddress();
        if (assets[asset].registered) revert NaveErrors.AssetAlreadyRegistered();
        if (registeredAssets.length >= NaveConstants.MAX_TREASURY_ASSETS) {
            revert NaveErrors.TooManyAssets();
        }
        uint8 dec = IERC20Metadata(asset).decimals();
        assets[asset] = NaveStructs.AssetRecord({
            registered: true,
            enabled: true,
            isStablecoin: isStablecoin,
            assetKind: assetKind,
            decimals: dec,
            pythFeedId: pythFeedId,
            deposited: 0,
            deployedCapitalBase: 0,
            lastValuedUsd: 0,
            lastValuedAt: 0,
            lastManagementFeeAt: FeeMath.floorToUtcMidnight(block.timestamp),
            markedValueBase: 0
        });
        registeredAssets.push(asset);
    }

    function setAssetEnabled(
        mapping(address => NaveStructs.AssetRecord) storage assets,
        address asset,
        bool enabled
    ) external {
        if (!assets[asset].registered) revert NaveErrors.AssetNotRegistered();
        assets[asset].enabled = enabled;
    }

    /// Wrap the treasury's entire native ETH balance into the protocol's
    /// configured WETH. Does not auto-register — the founder registers WETH
    /// via {registerAsset} (same as any other ERC-20) so NAV/oracle wiring
    /// stays explicit.
    function wrapNativeBalance(INaveProtocol protocol) public returns (uint256 wrapped) {
        wrapped = address(this).balance;
        if (wrapped == 0) return 0;
        address weth = protocol.wrappedNative();
        if (weth == address(0)) revert NaveErrors.WrappedNativeNotConfigured();
        IWETH(weth).deposit{value: wrapped}();
    }

    /// One-time factory seed gate + wrap (runs via DELEGATECALL, so
    /// `msg.sender` / `msg.value` are the treasury's callers'). Extracted from
    /// `NaveTreasury.seedNativeTreasury` to stay under EIP-170.
    function seedNativeTreasury(INaveProtocol protocol, uint256 alreadySeeded) external {
        if (msg.sender != protocol.factory()) revert NaveErrors.Unauthorized();
        if (alreadySeeded != 0) revert NaveErrors.TreasuryAlreadySeeded();
        if (msg.value > 0) wrapNativeBalance(protocol);
    }

    // ── Token registry ────────────────────────────────────────────────────
    function registerDaoToken(
        NaveStructs.TokenSlot[] storage tokens,
        mapping(address => uint256) storage tokenIndexPlusOne,
        address tokenDeployer,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply,
        address initialRecipient
    ) external returns (address mint) {
        if (tokens.length >= NaveConstants.MAX_TOKEN_REGISTRY) {
            revert NaveErrors.TokenRegistryFull();
        }
        if (bytes(name).length == 0 || bytes(name).length > NaveConstants.MAX_TOKEN_NAME_LEN) {
            revert NaveErrors.InvalidNameLength();
        }
        if (bytes(symbol).length == 0 || bytes(symbol).length > NaveConstants.MAX_TOKEN_SYMBOL_LEN)
        {
            revert NaveErrors.InvalidNameLength();
        }
        mint = NaveTokenDeployer(tokenDeployer)
            .deploy(name, symbol, decimals, address(this), initialSupply, initialRecipient);
        tokens.push(
            NaveStructs.TokenSlot({
                mint: mint, authorityRevoked: false, decimals: decimals, name: name, symbol: symbol
            })
        );
        tokenIndexPlusOne[mint] = tokens.length;
    }

    /// Register an existing ERC-20 as a DAO governance token (no deploy, no mint).
    /// Used when the founder supplies an external token at creation time. The
    /// treasury never holds mint authority, so `authorityRevoked` is set true.
    function registerExternalDaoToken(
        NaveStructs.TokenSlot[] storage tokens,
        mapping(address => uint256) storage tokenIndexPlusOne,
        address mint,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) external {
        if (mint == address(0)) revert NaveErrors.ZeroAddress();
        if (mint.code.length == 0) revert NaveErrors.ZeroAddress();
        if (tokenIndexPlusOne[mint] != 0) revert NaveErrors.DuplicateTokenMint();
        if (tokens.length >= NaveConstants.MAX_TOKEN_REGISTRY) {
            revert NaveErrors.TokenRegistryFull();
        }
        if (bytes(name).length == 0 || bytes(name).length > NaveConstants.MAX_TOKEN_NAME_LEN) {
            revert NaveErrors.InvalidNameLength();
        }
        if (bytes(symbol).length == 0 || bytes(symbol).length > NaveConstants.MAX_TOKEN_SYMBOL_LEN)
        {
            revert NaveErrors.InvalidNameLength();
        }
        tokens.push(
            NaveStructs.TokenSlot({
                mint: mint,
                authorityRevoked: true,
                decimals: decimals,
                name: name,
                symbol: symbol
            })
        );
        tokenIndexPlusOne[mint] = tokens.length;
    }

    function revokeTokenAuthority(
        NaveStructs.TokenSlot[] storage tokens,
        mapping(address => uint256) storage tokenIndexPlusOne,
        address mint
    ) external {
        uint256 idx = tokenIndexPlusOne[mint];
        if (idx == 0) revert NaveErrors.TokenNotFound();
        if (tokens[idx - 1].authorityRevoked) revert NaveErrors.AuthorityAlreadyRevoked();
        tokens[idx - 1].authorityRevoked = true;
        NaveDaoToken(mint).revokeMinting();
    }

    function updateTokenMetadata(
        NaveStructs.TokenSlot[] storage tokens,
        mapping(address => uint256) storage tokenIndexPlusOne,
        address mint,
        string calldata name,
        string calldata symbol
    ) external {
        uint256 idx = tokenIndexPlusOne[mint];
        if (idx == 0) revert NaveErrors.TokenNotFound();
        if (bytes(name).length == 0 || bytes(name).length > NaveConstants.MAX_TOKEN_NAME_LEN) {
            revert NaveErrors.InvalidNameLength();
        }
        if (bytes(symbol).length == 0 || bytes(symbol).length > NaveConstants.MAX_TOKEN_SYMBOL_LEN)
        {
            revert NaveErrors.InvalidNameLength();
        }
        tokens[idx - 1].name = name;
        tokens[idx - 1].symbol = symbol;
    }

    // ── Holder annotations ────────────────────────────────────────────────
    function setHolderAnnotation(
        mapping(address => NaveStructs.Annotation) storage annotations,
        string calldata text
    ) external {
        if (bytes(text).length == 0 || bytes(text).length > NaveConstants.MAX_ANNOTATION_LEN) {
            revert NaveErrors.InvalidNameLength();
        }
        annotations[msg.sender] = NaveStructs.Annotation({
            exists: true,
            status: uint8(AnnotationStatus.Pending),
            submittedAt: block.timestamp,
            reviewedAt: 0,
            text: text
        });
    }

    function reviewAnnotation(
        mapping(address => NaveStructs.Annotation) storage annotations,
        address holder,
        uint8 status
    ) external {
        NaveStructs.Annotation storage ann = annotations[holder];
        if (!ann.exists) revert NaveErrors.Unauthorized();
        ann.status = status;
        ann.reviewedAt = block.timestamp;
    }

    function validateInitParams(InitParams calldata p) external pure {
        if (bytes(p.name).length == 0 || bytes(p.name).length > NaveConstants.MAX_DAO_NAME_LEN) {
            revert NaveErrors.InvalidNameLength();
        }
        if (
            p.guardianWallets.length == 0
                || p.guardianWallets.length > NaveConstants.MAX_GUARDIAN_WALLETS
        ) {
            revert NaveErrors.TooManyGuardianWallets();
        }
        if (
            p.guardianThreshold == 0 || p.guardianThreshold > NaveConstants.MAX_GUARDIAN_THRESHOLD
                || p.guardianThreshold > p.guardianWallets.length
        ) revert NaveErrors.InvalidGuardianThreshold();
        validateBps(p.managementFeeBps, p.performanceFeeBps);
        validateBps(p.frozenManagementFeeBps, p.frozenPerformanceFeeBps);
        if (p.privacyMode > uint8(PrivacyMode.Private)) revert NaveErrors.InvalidPrivacyMode();
        if (p.protocolRevenueWallet == address(0)) revert NaveErrors.InvalidFeeRecipient();
        if (p.quorumBps == 0 || p.quorumBps > 10_000) revert NaveErrors.InvalidBps();
        if (p.governanceType > uint8(GovernanceType.Token)) {
            revert NaveErrors.InvalidGovernanceType();
        }
    }

    function validateReviewWindow(int64 secs) public view {
        if (
            secs < NaveConstants.minReviewWindowSecs()
                || secs > NaveConstants.MAX_REVIEW_WINDOW_SECONDS
        ) {
            revert NaveErrors.InvalidReviewWindow();
        }
    }

    // ── Review window (timelocked reductions) ─────────────────────────────
    event ReviewWindowUpdated(int64 reviewWindowSecs);
    event ReviewWindowChangeQueued(int64 reviewWindowSecs, uint256 effectiveAt);

    /// Founder review-window change. `current` is the EFFECTIVE window (a
    /// queued reduction whose delay has elapsed already counts). `secs >=
    /// current` applies immediately and clears any queued reduction. `secs <
    /// current` is QUEUED and only comes into force after the CURRENT window
    /// has elapsed (resolved lazily by `NaveTreasury.reviewWindowSecs()`), so
    /// the founder cannot shorten the window and immediately push a request
    /// through it. Returns the new (stored, pending, pendingEffectiveAt) triple.
    function setReviewWindow(int64 current, int64 secs)
        external
        returns (int64 newStored, int64 newPending, uint256 newPendingAt)
    {
        validateReviewWindow(secs);
        if (secs >= current) {
            emit ReviewWindowUpdated(secs);
            return (secs, 0, 0);
        }
        // Reduction: delay equals the window that is being shortened.
        newPendingAt = block.timestamp + uint256(int256(current));
        emit ReviewWindowChangeQueued(secs, newPendingAt);
        return (current, secs, newPendingAt);
    }

    // ── Linked (sister) treasuries ────────────────────────────────────────
    /// A bridge destination must be a sister treasury the protocol owner has
    /// registered for `destChainId`; `address(0)` clears the link.
    function validateLinkedTreasury(INaveProtocol protocol, uint256 destChainId, address treasury)
        external
        view
    {
        if (destChainId == 0) revert NaveErrors.MathOverflow();
        if (treasury != address(0) && !protocol.isRemoteTreasury(destChainId, treasury)) {
            revert NaveErrors.LinkedTreasuryNotRegistered();
        }
    }

    function validatePolicyParameters(
        uint16 reserveBps,
        uint16 deployedBps,
        uint16 liquidityBps,
        int64 rebalanceFreq
    ) external pure {
        if (reserveBps > NaveConstants.MAX_RESERVE_BPS) {
            revert NaveErrors.InvalidPolicyParameters();
        }
        if (deployedBps > NaveConstants.MAX_DEPLOYMENT_BPS) {
            revert NaveErrors.InvalidPolicyParameters();
        }
        if (liquidityBps > NaveConstants.MAX_LIQUIDITY_BPS) {
            revert NaveErrors.InvalidPolicyParameters();
        }
        if (
            rebalanceFreq != 0
                && (rebalanceFreq < NaveConstants.MIN_REBALANCE_FREQUENCY_SECONDS
                    || rebalanceFreq > NaveConstants.MAX_REBALANCE_FREQUENCY_SECONDS)
        ) revert NaveErrors.InvalidPolicyParameters();
        if (deployedBps > 0 && liquidityBps > 0) {
            if (uint256(deployedBps) + uint256(liquidityBps) > 10_000) {
                revert NaveErrors.InvalidPolicyParameters();
            }
        }
    }

    /// Annual management fee is 0. Validates the asset is registered, transfers
    /// nothing, and leaves `lastManagementFeeAt` where it is so the anchor does
    /// not move as if a fee had been taken. Arguments are retained so the
    /// treasury call shape stays stable.
    function collectManagementFee(
        IERC20,
        NaveStructs.AssetRecord storage a,
        uint16,
        address,
        uint256
    ) external view returns (uint256 fee, uint256 newAnchor) {
        if (!a.registered) revert NaveErrors.AssetNotRegistered();
        fee = 0;
        newAnchor = a.lastManagementFeeAt;
    }

    function chargeTokenMintFee(INaveProtocol protocol, uint256 msgValue, address payer) external {
        uint256 fee = protocol.tokenMintFee();
        if (fee == 0) return;
        if (msgValue < fee) revert NaveErrors.InsufficientFeeAsset();
        (bool ok,) = protocol.protocolTreasury().call{value: fee}("");
        if (!ok) revert NaveErrors.InsufficientFeeAsset();
        if (msgValue > fee) {
            (bool refunded,) = payer.call{value: msgValue - fee}("");
            if (!refunded) revert NaveErrors.InsufficientFeeAsset();
        }
    }

    /// Credit deposited base units only. NAV marking for stables is done in the
    /// facade via {TreasuryValuationLib} (SEC-M5) so storage-pointer valuation
    /// stays in the DELEGATECALL context of `NaveTreasury`.
    function applyDeposit(NaveStructs.AssetRecord storage a, uint256 amount) external {
        a.deposited += amount;
    }

    /// Full SEC-M5 CEI deposit (accounting + pull). Returns updated vault counters.
    function deposit(
        IOracle oracle,
        mapping(address => NaveStructs.AssetRecord) storage assets,
        address asset,
        uint256 amount,
        uint256 totalDeposited,
        uint256 currentNav,
        uint256 highWaterMark
    )
        external
        returns (uint256 newTotalDeposited, uint256 newCurrentNav, uint256 newHighWaterMark)
    {
        if (amount == 0) revert NaveErrors.MathOverflow();
        NaveStructs.AssetRecord storage a = assets[asset];
        if (!a.registered) revert NaveErrors.AssetNotRegistered();
        if (!a.enabled) revert NaveErrors.AssetDisabled();
        a.deposited += amount;
        newTotalDeposited = totalDeposited;
        newCurrentNav = currentNav;
        newHighWaterMark = highWaterMark;
        if (a.isStablecoin) {
            uint256 navCredit = TreasuryValuationLib.valueAssetUsd(oracle, a, asset, amount);
            if (navCredit > 0) {
                newTotalDeposited = totalDeposited + navCredit;
                newCurrentNav = currentNav + navCredit;
                if (highWaterMark == 0) newHighWaterMark = newCurrentNav;
            }
        }
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }

    function executeTransfer(
        IOracle oracle,
        mapping(address => NaveStructs.AssetRecord) storage assets,
        address asset,
        address recipient,
        uint256 amount,
        uint256 currentNav,
        uint256 totalWithdrawn
    ) external returns (uint256 newCurrentNav, uint256 newTotalWithdrawn) {
        NaveStructs.AssetRecord storage a = assets[asset];
        newCurrentNav = currentNav;
        newTotalWithdrawn = totalWithdrawn;
        if (a.registered) {
            uint256 amountUsd = TreasuryValuationLib.valueAssetUsd(oracle, a, asset, amount);
            newCurrentNav = currentNav > amountUsd ? currentNav - amountUsd : 0;
            newTotalWithdrawn = totalWithdrawn + amountUsd;
        }
        IERC20(asset).safeTransfer(recipient, amount);
    }

    function recordStrategyWithdrawal(
        mapping(address => TreasuryStrategyLib.Position) storage positions,
        mapping(address => NaveStructs.AssetRecord) storage assets,
        address adapter,
        address asset,
        uint256 amount,
        uint256 amountUsd,
        uint256 deployedCapital,
        uint16,
        address protocolRevenueWallet,
        uint256 totalWithdrawn
    )
        external
        returns (
            uint256 perfFeeSkimmed,
            uint256 newDeployedCapital,
            uint256 gain,
            uint256 newTotalWithdrawn
        )
    {
        (perfFeeSkimmed, newDeployedCapital, gain) = TreasuryStrategyLib.recordWithdrawal(
            positions[adapter],
            assets[asset],
            deployedCapital,
            NaveConstants.DEFAULT_PERFORMANCE_FEE_BPS,
            asset,
            amount,
            amountUsd
        );
        newTotalWithdrawn = totalWithdrawn + amountUsd;
        if (perfFeeSkimmed > 0) {
            IERC20(asset).safeTransfer(protocolRevenueWallet, perfFeeSkimmed);
        }
    }

    function mintRegisteredToken(
        NaveStructs.TokenSlot[] storage tokens,
        mapping(address => uint256) storage tokenIndexPlusOne,
        address mint,
        address to,
        uint256 amount
    ) external {
        uint256 idx = tokenIndexPlusOne[mint];
        if (idx == 0) revert NaveErrors.TokenNotInRegistry();
        if (tokens[idx - 1].authorityRevoked) revert NaveErrors.AuthorityAlreadyRevoked();
        NaveDaoToken(mint).mint(to, amount);
    }

    /// Send the outbound relayer fee to `protocol.relayer()`. No-op when the
    /// owner has not stored a relayer yet (existing suites and already-deployed
    /// protocols). Once set, a treasury that cannot cover the fee reverts with
    /// {NaveErrors.InsufficientNativeForRelayerFee}.
    ///
    /// Non-Arc: 0.0005 ETH. Raw native is used first. Inbound ETH is wrapped on
    /// receive, so a shortfall is unwrapped from WETH. The treasury sets a
    /// transient flag before this call so that unwrap does not immediately
    /// re-wrap. Arc: the 18-decimal native USDC value of 0.0005 ETH.
    function pullOutboundRelayerFee(INaveProtocol protocol, IOracle oracle) external {
        address payee = protocol.relayer();
        if (payee == address(0)) return;
        uint256 due;
        if (ProtocolFeeLib.isArc(block.chainid)) {
            due = ProtocolFeeLib.ethToArcNative(
                oracle, protocol.wrappedNative(), protocol.ethUsdFeedId(), NaveConstants.OUTBOUND_RELAYER_FEE_WEI
            );
        } else {
            due = NaveConstants.OUTBOUND_RELAYER_FEE_WEI;
            if (address(this).balance < due) {
                address weth = protocol.wrappedNative();
                uint256 short = due - address(this).balance;
                if (weth == address(0) || IERC20(weth).balanceOf(address(this)) < short) {
                    revert NaveErrors.InsufficientNativeForRelayerFee();
                }
                IWETH(weth).withdraw(short);
            }
        }
        if (address(this).balance < due) revert NaveErrors.InsufficientNativeForRelayerFee();
        (bool ok,) = payee.call{value: due}("");
        if (!ok) revert NaveErrors.InsufficientNativeForRelayerFee();
    }

    function validateBps(uint16 management, uint16 performance) internal pure {
        if (
            management != NaveConstants.DEFAULT_MANAGEMENT_FEE_BPS
                || performance != NaveConstants.DEFAULT_PERFORMANCE_FEE_BPS
        ) revert NaveErrors.InvalidBps();
    }
}
