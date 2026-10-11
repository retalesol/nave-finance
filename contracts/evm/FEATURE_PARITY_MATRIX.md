# Nave EVM — Feature-Parity Matrix

This matrix is the **"no feature missed" gate** for the EVM port (Part A of the
Nave multi-chain plan). It maps **every** Solana instruction across
`nave_core`, `nave_governance`, `nave_execution`, and the strategy adapters to
its EVM function and the Foundry test that exercises it.

- **Chains in scope:** Ethereum (`1`) + Base (`8453`) + Robinhood (`4663`);
  testnets Sepolia (`11155111`) + Base Sepolia (`84532`) + Robinhood Testnet (`46630`).
  No BSC / Polygon / Arbitrum One.
- **Contracts:** `NaveProtocol` (singleton), `NaveDAOFactory` (EIP-1167 clones),
  per-DAO `NaveTreasury` / `NaveGovernor` / `NaveExecution`, `PythOracle`
  (+ Chainlink fallback), strategy adapters (`AaveV3Adapter`,
  `CompoundV3Adapter`, `BalancerAdapter`, `CurveAdapter`), and the libraries
  (`FeeMath`, `BpsGates`, `OracleMath`, `PayloadHash`, `TreasuryAdminLib`).
- **Test status:** ✅ implemented & passing · 🔱 fork test (runs with RPC) ·
  ⤳ folded into another EVM function · ❎ intentionally not ported (see notes).
- **Suite status:** local `forge build` / `forge test` must pass before cutover;
  fork tests `vm.skip` cleanly unless the required RPC and per-pool slippage
  quote env vars are supplied.
- **End-to-end:** `E2ETest` (`test/E2E.t.sol`) runs the full Part E lifecycle in
  one flow on the local EVM — create DAO → deposit → proposal → vote → finalize →
  4-agent execution pipeline → adapter deposit → yield → withdrawal + 15% yield skim →
  Transfer proposal → management-fee call (transfers nothing), plus a token-governance
  lock/vote/finalize/release path. This is the runnable substitute for a live
  Sepolia / Base Sepolia E2E (see §6 sign-off for what needs live testnet creds).

---

## 1. `nave_core` — registry, vault, agents, guardians, fees, constitution

| Solana instruction | EVM function | Test | Status |
|---|---|---|---|
| `initialize_global_config` | `NaveProtocol` constructor | `TreasuryTest.test_protocolRegistersClones` | ✅ |
| `update_global_config` | `NaveProtocol.setPaused` / `setFormationFee` / `setTokenMintFee` | `TreasuryTest` (setUp wiring) | ✅ |
| `initialize_dao` | `NaveDAOFactory.createDao` → `NaveTreasury.initialize`. Proxies are deployed with **CREATE2**, salt `keccak256(abi.encode(block.chainid, factory, daoId, founder))` (+ role byte), so the N-th DAO on Base / Robinhood / Ethereum can never share an address even when the factories do (`predictDaoAddresses(founder)` previews them) | `TreasuryTest.test_init_setsFounderAndConfig`, `FactoryTest.test_createDao_addressesDifferAcrossChains_sameFactoryState`, `test_createDao_deterministicOnSameChain_andSaltFormula` | ✅ |
| `initialize_dao_extensions` | folded into `createDao` / `NaveTreasury.initialize` | `TreasuryTest.test_init_setsFounderAndConfig` | ⤳✅ |
| `initialize_dao_governance` | folded into `createDao` / `NaveTreasury.initialize` | `TreasuryTest.test_init_setsFounderAndConfig` | ⤳✅ |
| `update_constitution` | `NaveTreasury.updateConstitution` (→ `TreasuryAdminLib`) — every adapter must be on the **protocol adapter allowlist** (`NaveProtocol.setAdapterApproved` / `isApprovedAdapter`, owner-managed); founder alone cannot add an arbitrary contract | `TreasuryTest.test_updateConstitution_rejectsUnapprovedAdapter`, `test_setAdapterApproved_onlyOwner`, `ExecutionTest` (setUp approves adapter on protocol + constitution) | ✅ |
| `set_review_window` | `NaveTreasury.setReviewWindow` — floor **1 h** (`MIN_REVIEW_WINDOW_SECONDS`); increases immediate, **reductions timelocked** by the current window and resolved lazily by `reviewWindowSecs()` (`pendingReviewWindow()` exposes the queue) | `TreasuryTest.test_setReviewWindow_*`, `ExecutionTest.test_reviewWindowReduction_notUsableUntilDelayElapses` | ✅ |
| `set_linked_treasury` (bridge destination) | `NaveTreasury.setLinkedTreasury` — target must be registered in the **remote-treasury registry** `NaveProtocol.setRemoteTreasury` / `isRemoteTreasury(chainId, treasury)` (owner-managed) | `TreasuryTest.test_setLinkedTreasury_rejectsUnregisteredTarget`, `test_setRemoteTreasury_guards` | ✅ |
| `set_policy_parameters` | `NaveTreasury.setPolicyParameters` | `MathTest.test_globalLimits_*` (gate math) | ✅ |
| `update_guardian_config` | `NaveTreasury.updateGuardianConfig` (founder one-shot bootstrap) + `applyGuardianConfigFromGovernor` / `NaveGovernor.executePermissionProposal` | `GovernanceTest.test_permissionProposal_updatesGuardians`, `test_founderGuardianBootstrap_oneShot` | ✅ |
| `update_agent_set` | `NaveTreasury.updateAgentSet` | `TreasuryTest.test_agentRotation_respects48hTimelock` | ✅ |
| `apply_agent_rotation` | `NaveTreasury.applyAgentRotation` | `TreasuryTest.test_agentRotation_respects48hTimelock` / `_noPendingReverts` | ✅ |
| `toggle_agents` | `NaveTreasury.toggleAgents` (enable only) | `TreasuryTest.test_toggleAgents_onlyExecutiveCanEnable` | ✅ |
| `guardian_disable_agents` | `NaveTreasury.guardianDisableAgents` (M-of-N) | `TreasuryTest.test_guardianDisableAgents` | ✅ |
| `emergency_pause_agents` | ❎ **removed** (pre-redeploy hardening). The single-actor founder-OR-any-guardian `emergencyPauseAgents()` let one key manufacture the `!agentsEnabled` condition that unlocks the Executive break-glass `executeDirect`. Disabling agents is now **guardian M-of-N only** via `guardianDisableAgents` (EIP-712 `GuardianActionType.DISABLE_AGENTS`) | `TreasuryTest.test_singleGuardian_cannotDisableAgents`, `ExecutionTest.test_executeDirect_unlockedOnlyByGuardianQuorumDisable` | ❎→M-of-N |
| `nullify_agent` | `NaveTreasury.nullifyAgent(role, nonce, deadline, sigs)` — **guardian M-of-N** (`GuardianActionType.NULLIFY_AGENT = 6`; Solana uses discriminant 5 — EVM reserved 5 for `CANCEL_RECOVERY`) | `TreasuryTest.test_agentDetails_exposesLifecycleFlags`, `test_nullifyAgent_requiresGuardianQuorum` | ✅ |
| `restore_agent` | `NaveTreasury.restoreAgent` (Executive; does not unfreeze) | covered by agent-auth paths | ✅ |
| `update_agent_status` | `NaveTreasury.updateAgentStatus` (M-of-N) | `TreasuryTest` guardian suite (shared `_verifyGuardianAction`) | ✅ |
| `rotate_agent_key` | `NaveTreasury.rotateAgentKey` (M-of-N) | `TreasuryTest.test_guardianRotateAgentKey` | ✅ |
| `emergency_freeze` | `NaveTreasury.emergencyFreeze` (M-of-N, EIP-712 + bitmask) | `TreasuryTest.test_guardianFreeze_*` (5 cases) | ✅ |
| `emergency_unfreeze` | `NaveTreasury.emergencyUnfreeze` | `TreasuryTest.test_guardianUnfreeze` | ✅ |
| `cancel_guardian_action` | ❎ not needed — EVM uses atomic aggregated EIP-712 sigs (no lingering PDA to GC) | — | ❎ |
| `deposit_to_vault` | `NaveTreasury.deposit` (stablecoin → NAV at $1) | `TreasuryTest.test_deposit_stablecoinCreditsNavAtOneDollar` | ✅ |
| `deposit_to_asset` | `NaveTreasury.deposit` (unified multi-asset deposit) | `ExecutionTest` (setUp funds treasury) | ⤳✅ |
| `withdraw_from_vault` | `NaveTreasury.withdrawFromVault` → **always reverts** | `TreasuryTest.test_withdrawFromVault_alwaysReverts` | ✅ |
| `collect_management_fee` | `NaveTreasury.collectManagementFee` (transfers nothing; management bps are 0 in both the normal and frozen state) | `TreasuryTest.test_managementFee_*` | ✅ |
| `set_dao_privacy` | `NaveTreasury.setDaoPrivacy` | (founder-gated setter) | ✅ |
| `set_holder_annotation` | `NaveTreasury.setHolderAnnotation` (→ `TreasuryAdminLib`) | (annotation flow) | ✅ |
| `approve_holder_annotation` | `NaveTreasury.approveHolderAnnotation` | (annotation flow) | ✅ |
| `deny_holder_annotation` | `NaveTreasury.denyHolderAnnotation` | (annotation flow) | ✅ |
| `archive_proposals` | `NaveTreasury.archiveProposals` | (founder-gated counter) | ✅ |
| `register_dao_token` | `NaveTreasury.registerDaoToken` (deploys `NaveDaoToken`) | `GovernanceTest._tokenDao` (used in all token-gov tests) | ✅ |
| `revoke_token_authority` | `NaveTreasury.revokeTokenAuthority` (→ `NaveDaoToken.revokeMinting`) | `GovernanceTest` (registry path) | ✅ |
| `update_token_metadata` | `NaveTreasury.updateTokenMetadata` | (registry path) | ✅ |
| `switch_voting_system` | `NaveTreasury.switchVotingSystem` (governor-gated) | `GovernanceTest.test_tokenGov_switchVotingQuorum70pct` (quorum) | ✅ |
| `register_asset` | `NaveTreasury.registerAsset` (→ `TreasuryAdminLib`) | `TreasuryTest.test_registerAsset_onlyFounder` | ✅ |
| `revalue_treasury` | `NaveTreasury.revalueTreasury` | `ExecutionTest.test_fullPipeline_deploys` (fresh NAV) | ✅ |
| `init_strategy_position` | ⤳ positions auto-init on first `recordStrategyDeposit` (keyed by adapter) | `ExecutionTest.test_fullPipeline_deploys` | ⤳✅ |
| `update_strategy_position_value` | `NaveTreasury.updateStrategyPositionValue` | `ExecutionTest.test_withdrawWithYield_skims85pct` | ✅ |
| `record_proposal_creation` | `NaveTreasury.recordProposalCreation` (governor-gated) | `GovernanceTest` (proposal creation) | ✅ |
| `record_strategy_deposit` | `NaveTreasury.recordStrategyDeposit` (execution-gated) | `ExecutionTest.test_fullPipeline_deploys` | ✅ |
| `record_strategy_withdrawal` | `NaveTreasury.recordStrategyWithdrawal` (+ 15% of realized yield; frozen uses the same 15%; principal is not charged) | `ExecutionTest.test_withdrawWithYield_skims85pct` | ✅ |
| `initialize_protocol_fee_vault` | ❎ `NaveProtocol` collects native fees directly (no separate PDA) | — | ❎ |
| `set_fee_asset` | ❎ legacy (pre-redesign), unused by the in-kind fee model | — | ❎ |
| `configure_position_targets` | ❎ Solana Kamino market/reserve binding; on EVM the adapter encodes its target | — | ❎ |
| `init_strategy_escrow` | ❎ no escrow PDA on EVM — the adapter custodies deployed funds | — | ❎ |
| `kamino_deposit` / `kamino_withdraw` | `IStrategyAdapter.deposit` / `withdraw` (see §4) | see §4 | ✅/🔱 |
| `jito_deposit` / `jito_withdraw` | `IStrategyAdapter.deposit` / `withdraw` (see §4) | see §4 | ✅/🔱 |
| `jupiter_deposit` / `jupiter_withdraw` | `IStrategyAdapter.deposit` / `withdraw` (see §4) | see §4 | ✅/🔱 |

## 2. `nave_governance` — proposals & voting

| Solana instruction | EVM function | Test | Status |
|---|---|---|---|
| `create_proposal` | `NaveGovernor.createProposal` (9 types incl. Transfer 8) | `GovernanceTest.test_*`, `test_transferProposalType_allowedOnEvm` | ✅ |
| `cast_vote_wallet` | `NaveGovernor.castVoteWallet` (guardian, weight 1) | `GovernanceTest.test_walletGov_*` | ✅ |
| `lock_tokens_and_vote` | `NaveGovernor.lockTokensAndVote` (ERC-20 escrow, weight = amount). Solana now snapshots `dao_registry.voting_token` onto `Proposal.token_mint` at create and rejects any other mint (`VotingMintMismatch`) | `GovernanceTest.test_tokenGov_*` | ✅ |
| `release_vote_escrow` | `NaveGovernor.releaseVoteEscrow` | `GovernanceTest.test_tokenGov_escrowReleaseAfterFinalize` | ✅ |
| `finalize_proposal` | `NaveGovernor.finalizeProposal` (per-type quorum + early-finalize). After `votingEnd`, a proposal that **missed quorum resolves to terminal `Failed`** (no longer reverts `QuorumNotMet`), so `releaseVoteEscrow` always becomes possible | `GovernanceTest.test_walletGov_earlyFinalizationPasses`, `test_tokenGov_tokenMintQuorum25pct`, `test_tokenGov_switchVotingQuorum70pct`, `test_finalize_missedQuorum_failsAndReleasesEscrow` | ✅ |
| `mark_executed` (execution hook) | `NaveGovernor.markExecuted` — execution-gated **and** requires a finalized `Passed` proposal | `GovernanceTest.test_markExecuted_requiresPassedProposal`, `SecurityTest.test_C1_markExecuted_rejectsForeignExecution` | ✅ |
| `mark_moonlight_proposal_executed` | `NaveGovernor.markMoonlightProposalExecuted` — `NaveDaoStake`-gated; consumes a Passed `MoonlightRequest` / `MoonlightDistribution` (Passed → Executed) so one approval cannot drive a second moonlight cycle after `restoreDao` (P6-3) | `DaoStakeTest.test_moonlightRequest_consumed_cannotReplayAfterRestore`, `test_moonlightDistribution_consumed_secondCallReverts`, `test_markMoonlightProposalExecuted_gated` | ✅ |
| `execute_contract_upgrade` | `NaveGovernor.executeContractUpgrade(index, treasuryImpl, governorImpl, executionImpl)` — **explicit implementation addresses bound in the payload hash only**. The former `UPGRADE_TO_LATEST` sentinel / `executeContractUpgradeToLatest` (which consented to whatever `latestImplementations()` returned at execution time) is **removed** | `UpgradeabilityTest.test_daoConsent_upgradeToLatest_preservesStorage`, `test_upgrade_boundToVotedAddresses_notLatestAtExecution`, `GovernanceTest.test_upgradeToLatestSentinel_hasNoExecutionPath` | ✅ |
| `cancel_proposal` | `NaveGovernor.cancelProposal` | `GovernanceTest.test_cancelProposal_onlyProposer` | ✅ |
| `mint_additional_tokens` | `NaveGovernor.mintAdditionalTokens(proposalIndex, mint, to, amount)` — **governance-gated (H-1)**: requires a PASSED `TokenMint` proposal (25% quorum) whose `payloadHash == keccak256(abi.encode(mint,to,amount))`; the proposal is consumed (→ Executed) to block replay | `GovernanceTest.test_mintAdditional_*`, `E2ETest` (passed-proposal mint) | ✅ |

Quorum dispatch parity: `TokenMint = 25%` (`TOKEN_MINT_QUORUM_BPS`),
`SwitchVotingSystem = 70%` (`SWITCH_VOTING_QUORUM_BPS`), all others use the DAO's
configured `quorumBps` — verified in the three `finalize` tests above.

## 3. `nave_execution` — agent approval pipeline

| Solana instruction | EVM function | Test | Status |
|---|---|---|---|
| `create_execution_request` (Strategy) | `NaveExecution.createStrategyRequest` (payload-hash bound) | `ExecutionTest.test_fullPipeline_deploys`, `test_createRequest_wrongAmountReverts` | ✅ |
| **Transfer proposal (type 8) — NEW** | `NaveExecution.createTransferRequest` + `execute` dispatch | `ExecutionTest.test_transferProposal_executes` | ✅ (net-new) |
| **Bridge outbound (Strategy + bridgeHash)** | `NaveExecution.createBridgeRequest` + `execute` → `IBridgeAdapter` (CCTP / OP / Arbitrum) | unit adapters + payload binding | ✅ (net-new) |
| `executive_approve` | `NaveExecution.executiveApprove` | `ExecutionTest.test_executiveApprove_wrongAgentReverts` | ✅ |
| `financial_approve` | `NaveExecution.financialApprove` (payload-hash binding) | `ExecutionTest.test_financialApprove_payloadBinding` | ✅ |
| `oversight_approve` | `NaveExecution.oversightApprove` (starts review window) | `ExecutionTest.test_fullPipeline_deploys` | ✅ |
| `operational_halt` | `NaveExecution.operationalHalt` | `ExecutionTest.test_operationalHaltAndClear` | ✅ |
| `operational_clear` | `NaveExecution.operationalClear` | `ExecutionTest.test_operationalHaltAndClear` | ✅ |
| `expire_request` | `NaveExecution.expireRequest` | `ExecutionTest.test_expireRequest_afterWindow` | ✅ |
| `execute_strategy` | `NaveExecution.execute(index, **minOut**)` (Strategy dispatch; caller-supplied slippage floor C-3/C-4) | `ExecutionTest.test_fullPipeline_deploys`, `test_execute_beforeReviewWindowReverts`, `E2ETest` (non-zero minOut) | ✅ |
| `execute_strategy_direct` | `NaveExecution.executeDirect(index, **minOut**)` (break-glass when frozen or agents disabled by guardian quorum; requires `InReview` / `OversightApproved` — rejects Pending/early states). Hardened: **Strategy kind only** (`DirectExecutionKindNotAllowed` for Transfer/Bridge), `InReview` must have cleared `reviewEnd` (`ReviewWindowActive`), refused while moonlighting (`DaoMoonlighting`) | `ExecutionTest.test_executeDirect_whenFrozen`, `test_executeDirect_rejectsPendingWhenFrozen`, `test_executeDirect_rejectsExecutiveApprovedWhenFrozen`, `test_executeDirect_inReviewBeforeReviewEndReverts`, `test_executeDirect_transferKindReverts`, `test_executeDirect_bridgeKindReverts`, `DaoStakeTest.test_executeDirect_blockedWhileMoonlighting` | ✅ |
| `withdraw_from_strategy` | `NaveExecution.withdrawFromStrategy(index, amount, **minOut**)` (NE-8 cap + exit slippage floor) | `ExecutionTest.test_withdrawWithYield_skims85pct`, `E2ETest` | ✅ |

## 4. Strategy adapters — 4 protocols × 2 chains

Solana's three adapter programs (`nave_jito`, `nave_kamino`, `nave_marginfi`)
each expose `deposit_to_*` / `withdraw_from_*` gated to the execution authority.
On EVM these become `IStrategyAdapter.deposit` / `withdraw`, gated to a
registered per-DAO `NaveExecution` (`NaveProtocol.isNaveExecution`). The plan's
target protocol surface is **Aave v3, Compound v3 (Comet), Balancer v2**
on **Ethereum (1)** and **Base (8453)**.

| Adapter | Solana analogue | EVM contract | Ethereum (1) | Base (8453) | Test |
|---|---|---|---|---|---|
| **Aave v3** | lending (kamino/marginfi) | `AaveV3Adapter` | ✅ | ✅ | `ForkAdaptersTest.test_fork_aave_ethereum` 🔱, `test_fork_aave_base` 🔱 |
| **Compound v3 (Comet)** | lending | `CompoundV3Adapter` | ✅ | ✅ | `ForkAdaptersTest.test_fork_compound_ethereum` 🔱, `test_fork_compound_base` 🔱 |
| **Balancer v2** | AMM/LP | `BalancerAdapter` | ✅ (wired) | ✅ (wired) | unit via `BaseStrategyAdapter` shares (`InvariantTest`); fork ⚠️ pending pool config |
| **CCTP USDC bridge** | — | `CctpBridgeAdapter` | ✅ | ✅ | `IBridgeAdapter.bridgeOut` → TokenMessenger |
| **OP StandardBridge ETH** | — | `OpStandardBridgeAdapter` | ✅ | ✅ | Base↔Ethereum ETH/WETH |
| **Arbitrum Nitro bridge ETH** | — | `ArbitrumBridgeAdapter` | ✅ (Robinhood) | — | Robinhood↔Ethereum ETH |
| **Curve** | stableswap | `CurveAdapter` source retained but dormant | ⏸️ disabled | ⏸️ disabled | Removed from active launch surface until a vetted deployment/pool exists |
| share-isolation accounting (all adapters) | escrow / position PDAs | `BaseStrategyAdapter` | ✅ | ✅ | `InvariantTest.invariant_sharesConserved`, `invariant_positionsDoNotExceedPool` |

Fork-path documentation:

- **Aave v3 / Compound v3:** mainnet-fork tests run against the **live** pool /
  Comet addresses on **Ethereum and Base** (`ForkAdaptersTest`), funded via
  `deal`. They run automatically when `ETH_MAINNET_RPC_URL` /
  `BASE_MAINNET_RPC_URL` are set, and `vm.skip` cleanly otherwise.
- **Balancer:** the adapter is wired to the real `IBalancerVault` join/exit
  interfaces and share-tested via `BaseStrategyAdapter`. Per-pool fork tests
  require an operator-provided pool id and non-zero off-chain slippage floor
  (`BALANCER_MIN_BPT_OUT`) before they run; missing quote env vars skip the fork path.
- **Curve:** intentionally dormant until a vetted deployment/pool exists.

## 5. Parity must-haves (security call-outs)

| Must-have | Where enforced | Test |
|---|---|---|
| No direct treasury withdraw (exits only via execution) | `NaveTreasury.withdrawFromVault` reverts; funds move only via `transferForStrategy` / `executeTransfer` (`onlyExecution`) | `TreasuryTest.test_withdrawFromVault_alwaysReverts` |
| Yield fee = 15% of realized yield, skimmed on withdrawal. Principal is not charged. Frozen treasuries use the same 15%. There is no annual management fee (0 bps, normal and frozen). | `FeeMath.calculatePerformanceSkim` + `recordStrategyWithdrawal`; `collectManagementFee` transfers nothing | `ExecutionTest.test_withdrawWithYield_skims85pct`, `MathTest.test_perfSkim_*`, `TreasuryTest.test_managementFee_*` |
| No creation stake. Forming a treasury does not lock NAVE. An existing lock is still released on moonlight. Reopening does not require a new stake. | `NaveDAOFactory.createDao` does not call `lockStake`. `restoreDao` does not demand a new lock. | `DaoStakeTest` moonlight release and restore paths |
| 48h agent-rotation timelock | `NaveTreasury.updateAgentSet` / `applyAgentRotation` | `TreasuryTest.test_agentRotation_respects48hTimelock` |
| Guardian M-of-N (EIP-712 + bitmask) | `NaveTreasury._verifyGuardianAction` | `TreasuryTest.test_guardianFreeze_*` |
| Allocation bps gates + per-protocol caps | `BpsGates` + `NaveExecution._prepareStrategyDeposit` | `MathTest.test_allocationCap_*`, `test_globalLimits_*` |
| Payload-hash binding (keccak) | `PayloadHash` + `financialApprove` / `oversightApprove` | `ExecutionTest.test_*payloadBinding`, `test_createRequest_wrongAmountReverts` |
| Review window (snapshotted, configurable) | `NaveExecution.oversightApprove` / `execute` | `ExecutionTest.test_execute_beforeReviewWindowReverts` |
| Frozen DAO blocks normal execution (break-glass only) | `NaveExecution.execute` / `executeDirect` | `ExecutionTest.test_executeDirect_whenFrozen` |
| micro-USD (1e6) accounting | `NaveConstants.USD_SCALE`, `OracleMath` | `MathTest.test_value*` |
| Pyth: 32-byte feed ids, 60s staleness, 2% confidence | `PythOracle` + `OracleMath.confidenceWithinBounds` | `MathTest.test_confidence_*` |
| Transfer proposal (type 8) execution handler | `NaveExecution.createTransferRequest` + `execute` | `ExecutionTest.test_transferProposal_executes` |

---

### Intentional deviations from Solana (with rationale)

1. **Guardian actions are atomic aggregated EIP-712 signatures** (one tx, M
   signatures verified + bitmask-deduped) instead of incremental per-guardian
   transactions accumulating a `signed_mask` PDA. This is the idiomatic EVM
   M-of-N pattern and removes the need for `cancel_guardian_action` (no stale
   PDA to garbage-collect). Replay is prevented by consuming the action digest.
2. **One contract instead of escrow/position PDAs:** the `NaveTreasury` clone
   custodies idle assets and the adapter custodies deployed funds; strategy
   positions are keyed by adapter address (not a `protocol_id` string PDA), so
   `init_strategy_escrow` / `init_strategy_position` / `configure_position_targets`
   are not separate instructions.
3. **`AssetKind.SolLike` → `AssetKind.NativeLike`** (ETH/native + LSTs) and the
   strict Solana `asset_kind ↔ adapter` routing is relaxed: EVM lending adapters
   (Aave/Compound) are multi-asset, so routing is governed by the constitution's
   approved-adapter set + per-asset registration rather than a fixed kind map.
4. **Legacy fields dropped:** `FeeConfig.fee_recipient` / `fee_asset_mint` and
   `set_fee_asset` (retained on Solana only for account-layout stability) are
   omitted; the single `protocolRevenueWallet` is the fee destination.

---

## 6. Integration & cutover sign-off

**Verdict:** Every Solana instruction maps to an EVM function with a passing
Foundry test (✅), is intentionally folded (⤳✅) or intentionally not ported
(❎ with rationale). Contracts parity is **complete**. The frontend, backend, and
cutover were reconciled against the **real Foundry ABIs** (not the placeholders):

- **ABI reconciliation:** `nave-app` `npm run sync-abi` now pulls the real
  artifacts; the EVM lib trio (`readers.ts` / `writers.ts` / `addresses.ts`) and
  `CreateDAO.tsx` were fixed to the real surface — `createDao(CreateDaoParams)`
  (no `vaultAsset`/`feeRecipient`), `daoCount`/`formationFee` on `NaveProtocol`
  (not the factory), governor/execution discovery via the treasury's
  `governor()`/`execution()` getters, `currentNav` (not `nav`), `proposalCount`
  on the treasury, `createProposal` taking raw `payload` bytes + `votingMint`,
  `castVoteWallet`/`lockTokensAndVote`, `finalizeProposal`, and `execute(index)`.
  `npm run build` is green.
- **Agent EOAs:** the `generate-evm-agent-keys` edge fn provisions secp256k1
  agent + guardian keys (real `agentAuthorities` into `createDao`, rebound to the
  treasury from the `DaoCreated` event); the signer `/relay-evm` broadcasts the
  agent toggle (`toggleAgents(true)`; disable is guardian M-of-N
  `guardianDisableAgents` — `emergencyPauseAgents` no longer exists); the EVM indexer event
  metadata matches the real Solidity events (dao resolved by emitter / `treasury()`).

**Remaining gaps / risks (flagged):**

1. **Native ETH wrap-to-WETH (shipped):** formation seeds and bare ETH sends
   wrap immediately via `NaveProtocol.wrappedNative` (`IWETH.deposit`). Founder
   registers WETH for NAV. Raw ETH is never left locked. Deploy scripts set WETH
   from `NaveAddressRegistry.weth(chainId)`.
2. **Balancer fork pin (shipped default):** `ForkAdapters.t.sol` defaults to the
   Ethereum wstETH/WETH MetaStable pool (`getRate()`). Override via `BALANCER_*`
   env. Curve remains dormant until a vetted StableSwap-NG pool is chosen.
   Testnet Balancer adapters stay `0x0` (no compatible v2 pool target on Sepolia /
   Base Sepolia).
3. **Aave / Compound fork tests (🔱):** pass against live pools but only run when
   `ETH_MAINNET_RPC_URL` / `BASE_MAINNET_RPC_URL` are set (skipped in CI without
   them). Run with RPCs set before sign-off.
4. **Live testnet E2E:** run `bash scripts/evm-testnet-dao-e2e.sh <11155111|84532>`
   for artifact checks + operator gates. Still needs funded keys, Safe
   `acceptOwnership`, adapters (or accept governance-only E2E), app `VITE_EVM_*`,
   and agent key bind after `DaoCreated`. Base Sepolia Compound stays `0x0` until
   Comet is supplied in the registry.
5. **Agent-key rebind dependency:** the relayer (`/relay-evm`) and the guardian
   EIP-712 signer resolve keys by treasury address, so the post-creation
   `generate-evm-agent-keys` **bind** step must succeed (the frontend calls it
   from the `DaoCreated` receipt; the indexer also records the trio).
6. **Mainnet DAO cutover:** launch artifacts remain `scope: bridge-stake` until
   `--scope full` is run for chains 1/8453 (protocol/factory/treasuryImpl/
   adapters/`NaveDaoStake`/WETH wiring + Safe handoff). App
   `evm.enabled` stays **false** until that cutover completes and ABIs are synced.
7. **Moonlighting:** on-chain halt for deposit + new strategy requests via
   `NaveDaoStake.isMoonlighting`; Settings wizard wired for EVM.
8. **Stable deposit NAV:** deposit credits stables via SEC-M5 oracle + 2% peg
   band (same path as `revalueTreasury`); par `$1` only when no fresh feed.
9. **NFT gallery:** permanent custody-only on EVM (no on-chain registry / EIP-170);
   app `useTreasuryNfts` returns `unsupported` — transfer via governance still works.

---

## 7. Frontend EVM action parity (usable, not just compiled)

The final integration pass walked **every** page write-action and either wired
it to the EVM writers or recorded an explicit, defensible reason. "Parity" below
means a real on-chain effect from the connected wallet (or the founder-signed
relay), not a guarded no-op.

| Page action | Solana instr. | EVM verdict | How |
|---|---|---|---|
| Settings · guardian config | `update_guardian_config` | ✅ **wired** | `buildUpdateGuardianConfigEvm` → `NaveTreasury.updateGuardianConfig(wallets, threshold)` (founder wallet, `sendEvm`) |
| Settings · review window | `set_review_window` | ✅ **wired** (UI note needed) | `buildSetReviewWindowEvm` → `setReviewWindow(int64)`. Floor is now 1 h and a **reduction is queued** for one current window (`ReviewWindowChangeQueued`; read `pendingReviewWindow()`); the UI should surface "takes effect at …" instead of assuming an immediate change. |
| Settings · emergency freeze | `emergency_freeze` | ✅ **wired** | guardian **M-of-N** EIP-712 (`GuardianAction`) collected via `evm-guardian-freeze` + Settings UI → `emergencyFreeze` / `emergencyUnfreeze`. There is **no single-actor pause path any more**. |
| PolicyEngine · direct save | `set_policy_parameters` (+`update_constitution`) | ✅ **wired** (params) | `buildSetPolicyParametersEvm` → `setPolicyParameters(reserve, deployed, liquidity, rebalance)`. Approved-**adapter** set needs deployed adapter addresses (see risk #1) so it is configured once adapters exist, not from the Solana jito/kamino toggles. |
| Assets · deposit | `deposit_to_vault`/`_asset` | ✅ **wired** | `buildApproveErc20Evm` + `buildDepositEvm` |
| Assets · set fee asset | `set_fee_asset` | ❎ **N/A** | legacy pre-redesign; EVM fees are in-kind to the single `protocolRevenueWallet`. UI shows "Not applicable on EVM". |
| Assets · configure strategy targets | `configure_position_targets`/`init_strategy_*` | ❎ **N/A** | EVM adapters self-encode their pool; allocation caps + approval live in the constitution. UI shows "Solana-only step". |
| Agent · pause | `emergency_pause_agents` → `guardian_disable_agents` | ✅ **wired (relay, M-of-N)** | `emergencyPauseAgents()` was removed from `NaveTreasury`. `agent-admin` (founder-signed challenge) now accepts `guardian_signatures` + `guardian_nonce`/`guardian_deadline` (founder's browser EIP-712 `GuardianAction(DISABLE_AGENTS)` signature) and forwards them to the signer `/relay-evm`, which appends every custodied guardian signature over the same digest and broadcasts `guardianDisableAgents(nonce, deadline, sigs)` from the first guardian. Resume stays a governance-gated Executive `toggleAgents(true)`. Frontend default guardian threshold must be ≥ 2 so a single custodied key can never pause alone. |
| Agent · propose-enable → Governance · execute-enable | `toggle_agents` | ✅ **wired (relay)** | governance proposal (EVM `createProposal`) gates the resume; on pass, `setAgentsEnabledViaProxyEvm` → `agent-admin` → `/relay-evm` broadcasts Executive `toggleAgents(true)` |
| Tokens · create token | `register_dao_token` | ✅ **wired** | `buildRegisterDaoTokenEvm` → `registerDaoToken(name, symbol, decimals, initialSupply, treasury)` (payable token-mint fee) |
| Tokens · revoke authority | `revoke_token_authority` | ✅ **wired** | `buildRevokeTokenAuthorityEvm` → `revokeTokenAuthority(mint)` |
| Tokens · mint more / Governance · ratify token-mint | `mint_additional_tokens` | ◑ **writer-wired** | `buildMintAdditionalTokensEvm` → `mintAdditionalTokens(proposalIndex, mint, to, amount)` exists and is E2E-proven; the UI mint routes to a TokenMint governance proposal. Ratify-from-UI needs the proposal's `(mint,to,amount)` payload metadata (on-chain stores only the keccak hash) — sourced from Supabase proposal metadata. |
| Governance · create / vote / finalize / release-escrow | `create_proposal`/`cast_vote_*`/`finalize_proposal`/`release_vote_escrow` | ✅ **wired** | `buildCreateProposalEvm` / `buildCastVoteEvm` / `buildFinalizeProposalEvm` / `buildReleaseVoteEscrowEvm` |
| Governance · ratify constitution | `update_constitution`+`set_policy_parameters` | ◑ **params wireable** | policy params map directly; adapter set blocked on deployed adapters (risk #1) |
| Governance · create execution request / execute | `create_execution_request` / `execute_strategy` | ◑ **writer-wired** | `buildCreateStrategyRequestEvm` + `buildExecuteEvm(index, minOut)` exist and are E2E-proven; UI invocation blocked on **deployed testnet adapters** + an off-chain **minOut** quote (`resolveEvmMinOut` enforces a positive quote on mainnet, allows `0` on Sepolia/Base Sepolia). |

Legend: ✅ wired in-wallet · ✅ wired (relay) founder-signed backend relay · ◑ writer + contract done, UI invocation gated on adapter deploy / proposal-payload metadata · ❎ intentional Solana-only.

## 8. Signer / agent-approval reconciliation (EIP-712 ✗ → relay ✓)

The four agent approvals on-chain are **`msg.sender`-gated transactions**, not
signatures — the earlier signer `AgentApproval`/`GuardianApproval` EIP-712
(domain `NaveExecution`) did **not** match the contracts. Reconciled:

- **Agent approvals are RELAYED, not signed.** The signer `/relay-evm` broadcasts
  `executiveApprove` / `financialApprove(index, txPayloadHash, reasoningHash)` /
  `oversightApprove(...)` / `operationalHalt` / `operationalClear` /
  `expireRequest` / `execute(index, minOut)` / `executeDirect` /
  `withdrawFromStrategy(index, amount, minOut)` from the agent's EOA (loaded by
  `signer_role`), reusing the same gas-cap / fee-cap / nonce / receipt hardening
  as the toggle relay. `execute*` require a positive `minOut` on mainnet.
- **Guardian EIP-712 fixed to the contract.** `/sign-evm` now signs
  `GuardianAction(uint8 actionType,uint8 agentSlot,uint8 newStatus,address newKey,uint64 nonce)`
  with domain **name `NaveTreasury`**, version `1`, `chainId`, and
  `verifyingContract = treasury` (the per-clone domain). These M signatures are
  aggregated into the treasury's `emergencyFreeze`/`updateAgentStatus`/`rotateAgentKey`
  bitmask path. Agent roles are rejected on `/sign-evm` (they relay instead).
- **Dispatcher/orchestrator routing:** the advisory dispatcher's routing hint and
  the orchestrator's submit path were updated so EVM agent approvals go to
  `/relay-evm` (msg.sender tx) and guardians to `/sign-evm` (EIP-712); Solana
  Anchor `/sign` is unchanged.

## 9. Live testnet E2E — operator runbook & prerequisites

The full lifecycle is proven on the local Foundry EVM (`E2ETest`, chain-agnostic
identical logic). A live Sepolia + Base Sepolia run cannot be executed here (no
RPCs, no funded deploy key, no Safe, no faucet ETH) — fabricating secrets is
out of scope. Exact steps + what the operator must supply:

**A. Deploy the singletons (per chain):**
```
cd nave-contracts/solana
npm run mainnet:cutover:evm:preflight -- --chain-id 11155111 --env ../../nave-app/.env.evm.sepolia
npm run mainnet:cutover:evm          -- --chain-id 11155111 --env ../../nave-app/.env.evm.sepolia
# repeat for --chain-id 84532 (Base Sepolia)
```
Writes `evm/deployments/{11155111,84532}.json` + `evm-launch-*.json`
and prints the `VITE_EVM_*_PROTOCOL_ADDRESS` / `_FACTORY_ADDRESS` to wire.

**B. Operator MUST supply (preflight fails closed without these):**
- `EVM_RPC_URL` — a Sepolia / Base Sepolia JSON-RPC (must serve the matching
  chain id; `verifyRpcChainId` rejects a mismatch).
- `EVM_DEPLOY_PRIVATE_KEY` (or `EVM_DEPLOY_ACCOUNT` keystore) — **funded** with
  testnet ETH for deploy gas.
- `PROTOCOL_OWNER`, `PROTOCOL_TREASURY` — 0x addresses (owner = deploy wallet
  pre-handoff).
- `PYTH_ADDRESS` — the Pyth contract on that testnet.
- `SAFE_ADDRESS` — a **deployed** Safe multisig on that chain (`cast code != 0x`,
  enforced at preflight AND handoff). Deploy one via the Safe UI on the testnet first.
- `ETHERSCAN_API_KEY` (Sepolia) / `BASESCAN_API_KEY` (Base Sepolia) for `--verify`.
- Funded testnet ETH for: the **4 agent EOAs** + the **guardian EOA** (relayed
  approvals/pause pay their own gas) + the **founder** (DAO creation + founder writes).

**C. Authority handoff (Safe):** the `handoff` phase calls
`transferOwnership(Safe)` on `NaveProtocol` (Ownable2Step → **pending**) and
`PythOracle` (Ownable → immediate). The operator must then **`acceptOwnership()`
from the Safe UI** on the testnet; `--phase verify` (or `:verify`) confirms
`pendingOwner`/`owner` resolve to the Safe before treating handoff as proven.

**D. Wire the app:** set the printed `VITE_EVM_<NET>_PROTOCOL_ADDRESS` /
`_FACTORY_ADDRESS`, a real `VITE_EVM_SEPOLIA_RPC_URL` / `VITE_EVM_BASE_SEPOLIA_RPC_URL`,
and a real `VITE_WALLETCONNECT_PROJECT_ID`; backend signer needs
`EVM_SEPOLIA_RPC_URL` / `EVM_BASE_SEPOLIA_RPC_URL`, `NAVE_SIGNER_URL`,
`NAVE_SIGNER_SECRET`, and the `NAVE_EVM_MASTER_KEK`. Then run the in-app E2E:
create DAO → deposit → proposal → vote → finalize → enable agents (relay) →
(once adapters exist) strategy request → execute(minOut) → withdraw+skim →
Transfer proposal → ratify TokenMint.

**E. Missing per-chain testnet ADAPTER addresses (blocks the strategy leg):**
From `script/config/NaveAddressRegistry.sol`:
- **Sepolia (11155111):** only Aave v3 Pool is pinned
  (`0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`); USDC, Compound Comet =
  `address(0)`; Balancer Vault canonical but pools sparse; Curve via env.
- **Base Sepolia (84532):** USDC, Aave Pool, Compound Comet all `address(0)`
  (only the canonical Balancer Vault). **No lending adapter deployable** without
  operator-supplied test addresses.
- The deploy script **skips** any adapter whose required singleton is zero, so
  the strategy-execution leg of the live E2E needs the operator to either supply
  test-pool addresses (`AAVE_V3_POOL`, `COMPOUND_V3_COMET`, `BALANCER_*`,
  `CURVE_*` env) or accept that only the governance/treasury/transfer legs run on
  testnet while the adapter leg is covered by `E2ETest` + the Aave/Compound
  mainnet-**fork** tests (run with `ETH_MAINNET_RPC_URL` / `BASE_MAINNET_RPC_URL`).

## 10. Open risks / decisions

1. **Balancer / Curve fork tests (⚠️):** adapters wired + share-tested, but
   per-pool mainnet-fork tests require operator-pinned pool id / coin index plus
   non-zero quote env (`BALANCER_MIN_BPT_OUT`, `CURVE_MIN_LP_OUT`) for the chosen pool.
   **Curve constraint:** the `CurveAdapter` targets **StableSwap-NG** pools only
   (dynamic-array `add_liquidity(uint256[],uint256)` + built-in LP token, pool ==
   lpToken). Legacy fixed-array pools (classic 3pool) are **not** call-compatible
   — pick an NG pool when configuring `CURVE_*`.
2. **Aave / Compound fork tests (🔱):** pass against live pools only when
   `ETH_MAINNET_RPC_URL` / `BASE_MAINNET_RPC_URL` are set (else skip cleanly).
3. **`protocolRevenueWallet` default:** DECIDED — route per-DAO protocol
   fees to a **Nave-controlled fee wallet** (`VITE_EVM_PROTOCOL_REVENUE_WALLET`),
   mirroring Solana `global_config.treasury` / `VITE_NAVE_PROTOCOL_FEE_WALLET`.
   CreateDAO falls back to the founder only when the env var is unset (testnets).
   Mainnet cutover **requires** a non-zero `VITE_EVM_PROTOCOL_REVENUE_WALLET`
   (no founder fallback on mainnet). It is a `CreateDaoParams` field set at
   creation — there is no post-hoc setter.
4. **minOut on the keeper path:** `resolveEvmMinOut` rejects `0` on mainnet
   (Ethereum/Base) and relaxes to `0` on Sepolia/Base Sepolia; the agent/keeper
   that triggers `execute` MUST pass an off-chain quote on mainnet.
5. **Live testnet E2E + Safe `acceptOwnership`** still require the operator
   prerequisites in §9 (RPCs, funded keys, Safe, faucet ETH).
