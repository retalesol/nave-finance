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

    /// Revert unless `caller` is `founder` or an active, non-nullified Operational agent.
    /// Used by revalueTreasury and updateStrategyPositionValue.
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

    function initAgents(AgentSlot[4] storage agents, address[4] calldata authorities) external {
        for (uint256 i; i < NaveConstants.AGENT_COUNT; i++) {
            agents[i] = AgentSlot({
                authority: authorities[i],
                active: true,
                nullified: false,
                status: uint8(AgentStatus.Active)
            });
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
        address[4] calldata authorities
    ) external returns (uint256 effectiveAt) {
        effectiveAt = block.timestamp + uint256(int256(NaveConstants.AGENT_ROTATION_DELAY_SECONDS));
        for (uint256 i; i < NaveConstants.AGENT_COUNT; i++) {
            if (agents[i].nullified) continue;
            if (agents[i].authority == authorities[i]) {
                pendingRotations[i] = PendingRotation(address(0), 0);
                continue;
            }
            pendingRotations[i] = PendingRotation(authorities[i], effectiveAt);
        }
    }

    function applyAgentRotation(
        AgentSlot[4] storage agents,
        PendingRotation[4] storage pendingRotations,
        uint8 role
    ) external returns (address newAuthority) {
        if (role >= NaveConstants.AGENT_COUNT) revert NaveErrors.InvalidAgentRole();
        PendingRotation memory pending = pendingRotations[role];
        if (pending.pendingAuthority == address(0)) revert NaveErrors.NoPendingAgentRotation();
        if (block.timestamp < pending.effectiveAt) revert NaveErrors.AgentRotationNotReady();
        if (agents[role].nullified) revert NaveErrors.AgentNullified();
        agents[role].authority = pending.pendingAuthority;
        agents[role].active = true;
        pendingRotations[role] = PendingRotation(address(0), 0);
        newAuthority = pending.pendingAuthority;
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

    function rotateAgentKey(
        AgentSlot[4] storage agents,
        PendingRotation[4] storage pendingRotations,
        uint8 slot,
        address newKey
    ) external returns (address oldKey) {
        if (agents[slot].nullified) revert NaveErrors.AgentNullified();
        oldKey = agents[slot].authority;
        agents[slot].authority = newKey;
        agents[slot].active = true;
        agents[slot].status = uint8(AgentStatus.Active);
        pendingRotations[slot] = PendingRotation(address(0), 0);
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
        return uint8(n);
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
        address[] storage guardianWallets,
        address[] calldata wallets,
        uint8 threshold
    ) external {
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
            lastManagementFeeAt: FeeMath.floorToUtcMidnight(block.timestamp)
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

    function validateReviewWindow(int64 secs) public pure {
        if (
            secs < NaveConstants.MIN_REVIEW_WINDOW_SECONDS
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

    function collectManagementFee(
        IERC20 asset,
        NaveStructs.AssetRecord storage a,
        uint16 feeBps,
        address protocolRevenueWallet,
        uint256 idle
    ) external returns (uint256 fee, uint256 newAnchor) {
        if (!a.registered) revert NaveErrors.AssetNotRegistered();
        if (!FeeMath.managementFeeDue(a.lastManagementFeeAt, block.timestamp)) {
            revert NaveErrors.NoManagementFeeDue();
        }
        fee = FeeMath.annualManagementFee(idle, feeBps);
        if (fee == 0) revert NaveErrors.NoManagementFeeDue();
        if (idle < fee) revert NaveErrors.InsufficientFeeAsset();
        newAnchor = FeeMath.floorToUtcMidnight(block.timestamp);
        a.lastManagementFeeAt = newAnchor;
        // SafeERC20: non-standard tokens (e.g. USDT) return false instead of
        // reverting on a failed transfer; a bare transfer would advance the fee
        // anchor while silently skipping the actual fee movement.
        asset.safeTransfer(protocolRevenueWallet, fee);
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
        uint16 feeBps,
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
            positions[adapter], assets[asset], deployedCapital, feeBps, asset, amount, amountUsd
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

    function validateBps(uint16 management, uint16 performance) internal pure {
        if (management > 10_000 || performance > 10_000) revert NaveErrors.InvalidBps();
    }
}
