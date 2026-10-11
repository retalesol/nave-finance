import { BN } from '@coral-xyz/anchor';
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  LAMPORTS_PER_SOL,
  Keypair,
  type AccountMeta,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { getNavePrograms } from './naveProgram';
import {
  NAVE_CORE_PROGRAM_ID,
  NAVE_GOVERNANCE_PROGRAM_ID,
  NAVE_EXECUTION_PROGRAM_ID,
  NAVE_JUPITER_SWAP_PROGRAM_ID,
  MARGINFI_PROGRAM_ID,
  USE_MOCKS,
  BOOTSTRAP_PROGRAMS_DEPLOYED,
} from './programConfig';
import {
  getNaveGlobalConfigPDA,
  getProtocolFeeVaultPDA,
  getDaoRegistryPDA,
  getDaoStakeLockPDA,
  getStakeEscrowPDA,
  getDaoLifecyclePDA,
  getTreasuryVaultPDA,
  getVaultAuthorityPDA,
  getAgentSetPDA,
  getGuardianConfigPDA,
  getConstitutionPDA,
  getTokenRegistryPDA,
  getFeeConfigPDA,
  getGuardianActionPDA,
  getHolderAnnotationPDA,
  getProposalPDA,
  getVoteRecordPDA,
  getVoteEscrowPDA,
  getExecutionRequestPDA,
  getAssetConfigPDA,
  getTreasuryAssetPDA,
  getAssetVaultPDA,
  getNftVaultRecordPDA,
  getNftVaultPDA,
  getPositionTokenPDA,
  getStrategyPositionForMintPDA,
  getStrategyEscrowForMintPDA,
  getTokenGenesisRecordPDA,
} from './pdaDerivation';

// ─── Result type ─────────────────────────────────────────────────────────────

export interface TransactionBuildResult {
  instruction: TransactionInstruction | null;
  programId: PublicKey;
  /** Instructions prepended before `instruction` in the same transaction (e.g. ATA creation). */
  preInstructions?: TransactionInstruction[];
  /** Optional extra signers (e.g. a freshly created mint keypair). */
  signers?: import('@solana/web3.js').Keypair[];
  error?: string;
}

/** Mock-mode short circuit — useSendTransaction treats a null instruction as demo mode. */
function mock(programId: PublicKey): TransactionBuildResult {
  return {
    instruction: null,
    programId,
    error: 'Demo mode (VITE_USE_MOCKS=true) — no on-chain transaction built.',
  };
}

// ─── Argument types (mirror the Anchor IDL) ──────────────────────────────────

export interface InitializeDaoParams {
  name: string;
  guardianWallets: PublicKey[];
  guardianThreshold: number;
  /** Must be exactly 4 (executive, financial, oversight, operational). */
  agentAuthorities: PublicKey[];
  managementFeeBps: number;
  performanceFeeBps: number;
  frozenManagementFeeBps: number;
  frozenPerformanceFeeBps: number;
  privacyMode: number;
  /** LEGACY: retained for layout stability; unused by the in-kind fee model. */
  feeRecipient: PublicKey;
  /**
   * Protocol revenue wallet (owner account, NOT a token account). Destination
   * for the 8.5% performance-fee skim and the annual 0.65% management fee (paid
   * to its ATA per mint). Required & validated non-zero on-chain.
   */
  protocolRevenueWallet: PublicKey;
  quorumBps: number;
  /** 0 = Wallet (authorized-wallet voting), 1 = Token (token-weighted voting). */
  governanceType: number;
}

export interface ProtocolInput {
  protocolId: string;
  programId: PublicKey;
  maxAllocationBps: number;
  approved: boolean;
}

export interface CreateProposalParams {
  title: string;
  description: string;
  payload: number[] | Buffer;
  /** 0 = Policy, 1 = Strategy */
  proposalType: number;
  votingPeriodSeconds: number;
}

function toBN(n: number | bigint | string): BN {
  return new BN(n.toString());
}

// NOTE: Global-config admin builders (initialize/update_global_config) and the
// agent-set admin / agent-pipeline / strategy-execution builders are server-only.
// They live in `serverTransactionBuilders.ts` so they are not bundled into the
// client. See that module for buildInitializeGlobalConfig, buildUpdateGlobalConfig,
// buildToggle/Nullify/RestoreAgent, buildUpdateAgentSet, buildApplyAgentRotation,
// buildUpdateAgentStatus, buildRotateAgentKey, buildGuardianDisableAgents, the
// executive/financial/oversight approve + operational halt/clear pipeline, and
// execute_strategy(_direct) / withdraw_from_strategy.

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — DAO setup (3 instructions + token registration)
// ═══════════════════════════════════════════════════════════════════════════════

/** initialize_dao(params) — tx 1: DaoRegistry + TreasuryVault + VaultAuthority. */
export async function buildInitializeDao(
  founder: PublicKey,
  protocolTreasury: PublicKey,
  daoId: number,
  params: InitializeDaoParams,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoRegistry] = getDaoRegistryPDA(founder, daoId);
  const [vaultAuthority] = getVaultAuthorityPDA(daoRegistry);
  const [treasuryVault] = getTreasuryVaultPDA(daoRegistry);

  const instruction = await core.methods
    .initializeDao(toIdlDaoParams(params))
    .accountsPartial({
      founder,
      globalConfig,
      protocolTreasury,
      daoRegistry,
      vaultAuthority,
      treasuryVault,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** initialize_dao_extensions(params) — tx 2: AgentSet + FeeConfig + vault token account. */
export async function buildInitializeDaoExtensions(
  founder: PublicKey,
  daoId: number,
  vaultMint: PublicKey,
  params: InitializeDaoParams,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoRegistry] = getDaoRegistryPDA(founder, daoId);
  const [treasuryVault] = getTreasuryVaultPDA(daoRegistry);
  const [vaultAuthority] = getVaultAuthorityPDA(daoRegistry);
  const [agentSet] = getAgentSetPDA(daoRegistry);
  const [feeConfig] = getFeeConfigPDA(daoRegistry);
  const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);

  const instruction = await core.methods
    .initializeDaoExtensions(toIdlDaoParams(params))
    .accountsPartial({
      founder,
      globalConfig,
      daoRegistry,
      treasuryVault,
      vaultAuthority,
      vaultTokenAccount,
      vaultMint,
      agentSet,
      feeConfig,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** initialize_dao_governance(params) — tx 3: GuardianConfig + Constitution + TokenRegistry. */
export async function buildInitializeDaoGovernance(
  founder: PublicKey,
  daoId: number,
  params: InitializeDaoParams,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoRegistry] = getDaoRegistryPDA(founder, daoId);
  const [guardianConfig] = getGuardianConfigPDA(daoRegistry);
  const [constitution] = getConstitutionPDA(daoRegistry);
  const [tokenRegistry] = getTokenRegistryPDA(daoRegistry);

  const instruction = await core.methods
    .initializeDaoGovernance(toIdlDaoParams(params))
    .accountsPartial({
      founder,
      globalConfig,
      daoRegistry,
      guardianConfig,
      constitution,
      tokenRegistry,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** register_dao_token(name, symbol, decimals, charge_mint_fee, initial_supply) — nave_core.
 *  When `chargeMintFee` is true, 0.5 SOL is moved from the DAO treasury
 *  (vault_authority PDA) to the protocol fee vault. Used for post-creation
 *  token mints; pass false for the initial voting token chosen at creation.
 *  `initialSupply` mints into the treasury vault ATA (base units); pass 0 for
 *  existing SPL tokens or post-creation registrations without a mint. */
export async function buildRegisterDaoToken(
  daoPubkey: PublicKey,
  authority: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  name: string,
  symbol: string,
  decimals: number,
  chargeMintFee = false,
  initialSupply = 0,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [tokenRegistry] = getTokenRegistryPDA(daoPubkey);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);
  const [protocolFeeVault] = getProtocolFeeVaultPDA();

  const instruction = await core.methods
    .registerDaoToken(name, symbol, decimals, chargeMintFee, initialSupply)
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      tokenRegistry,
      vaultAuthority,
      treasuryVault,
      destination,
      protocolFeeVault,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — DAO creation stake (Phase 3) & moonlighting lifecycle (Phase 5)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * stake_dao_creation(amount, price_usd_micro) — founder. Locks the recoverable
 * recoverable NAVE creation stake (`NAVE_DAO_CREATION_STAKE_USD`) into a per-DAO escrow. Invoked in the same
 * creation flow, immediately after `initialize_dao_governance`. `amount` is the
 * oracle-derived required NAVE (base units); `priceUsdMicro` is recorded as
 * price-snapshot metadata only. Formation itself charges NO protocol fee.
 *
 * Derives the DaoStakeLock + stake_escrow PDAs and the founder's NAVE ATA. Both
 * the DaoStakeLock record and the escrow token account are created by this
 * instruction (founder pays rent).
 */
export async function buildStakeDaoCreation(
  founder: PublicKey,
  daoId: number,
  naveMint: PublicKey,
  amount: number | bigint,
  priceUsdMicro: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoRegistry] = getDaoRegistryPDA(founder, daoId);
  const [daoStakeLock] = getDaoStakeLockPDA(daoRegistry);
  const [stakeEscrow] = getStakeEscrowPDA(daoRegistry);
  const founderNaveAccount = getAssociatedTokenAddressSync(naveMint, founder, false);

  const instruction = await core.methods
    .stakeDaoCreation(toBN(amount), toBN(priceUsdMicro))
    .accountsPartial({
      founder,
      globalConfig,
      daoRegistry,
      naveMint,
      founderNaveAccount,
      daoStakeLock,
      stakeEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** record_moonlight_request — founder. Binds a PASSED MoonlightRequest (type 9)
 *  proposal: halts agents + blocks new strategy/deposit and records the proposal
 *  creator as the authorized distribution driver. Creates the DaoLifecycle PDA on
 *  first use. `requestProposal` is the passed proposal account (by address). */
export async function buildRecordMoonlightRequest(
  daoPubkey: PublicKey,
  founder: PublicKey,
  requestProposal: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoLifecycle] = getDaoLifecyclePDA(daoPubkey);
  const [agentSet] = getAgentSetPDA(daoPubkey);

  const instruction = await core.methods
    .recordMoonlightRequest()
    .accountsPartial({
      founder,
      globalConfig,
      daoRegistry: daoPubkey,
      daoLifecycle,
      agentSet,
      requestProposal,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** set_moonlight_distribution(recipient) — proposal creator only (enforced
 *  on-chain against DaoLifecycle.initiated_by). Distribution wizard step 1:
 *  records the approved recipient wallet and moves to DistributionPending. */
export async function buildSetMoonlightDistribution(
  daoPubkey: PublicKey,
  initiator: PublicKey,
  recipient: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoLifecycle] = getDaoLifecyclePDA(daoPubkey);

  const instruction = await core.methods
    .setMoonlightDistribution(recipient)
    .accountsPartial({
      initiator,
      globalConfig,
      daoRegistry: daoPubkey,
      daoLifecycle,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** execute_moonlight_distribution — proposal creator (bound on-chain). Distribution
 *  wizard step 2: after the bound MoonlightDistribution (type 10) proposal passes,
 *  releases the staked NAVE from escrow to the approved recipient. The recipient's
 *  NAVE ATA is created idempotently as a preInstruction (payer = authority). */
export async function buildExecuteMoonlightDistribution(
  daoPubkey: PublicKey,
  authority: PublicKey,
  naveMint: PublicKey,
  recipient: PublicKey,
  distributionProposal: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoLifecycle] = getDaoLifecyclePDA(daoPubkey);
  const [daoStakeLock] = getDaoStakeLockPDA(daoPubkey);
  const [stakeEscrow] = getStakeEscrowPDA(daoPubkey);
  const recipientNaveAccount = getAssociatedTokenAddressSync(naveMint, recipient, false);

  const preInstructions = [
    createAssociatedTokenAccountIdempotentInstruction(authority, recipientNaveAccount, recipient, naveMint),
  ];

  const instruction = await core.methods
    .executeMoonlightDistribution()
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      daoLifecycle,
      daoStakeLock,
      stakeEscrow,
      recipientNaveAccount,
      distributionProposal,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID, preInstructions };
}

/** finalize_moonlight — founder or distribution driver. Final phase: marks the
 *  DAO moonlighted/hidden (flips privacy to Private; agents stay off). */
export async function buildFinalizeMoonlight(
  daoPubkey: PublicKey,
  authority: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoLifecycle] = getDaoLifecyclePDA(daoPubkey);
  const [agentSet] = getAgentSetPDA(daoPubkey);

  const instruction = await core.methods
    .finalizeMoonlight()
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      daoLifecycle,
      agentSet,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** restore_dao(amount, price_usd_micro) — founder only. Reopen a moonlighted DAO
 *  by restaking the current `NAVE_DAO_CREATION_STAKE_USD` of NAVE into the (now-empty) escrow, returning
 *  the DAO to Active. The founder's NAVE ATA, DaoLifecycle, DaoStakeLock, and
 *  stake_escrow PDAs are derived; the escrow already exists from creation. */
export async function buildRestoreDao(
  daoPubkey: PublicKey,
  founder: PublicKey,
  naveMint: PublicKey,
  amount: number | bigint,
  priceUsdMicro: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [daoLifecycle] = getDaoLifecyclePDA(daoPubkey);
  const [daoStakeLock] = getDaoStakeLockPDA(daoPubkey);
  const [stakeEscrow] = getStakeEscrowPDA(daoPubkey);
  const founderNaveAccount = getAssociatedTokenAddressSync(naveMint, founder, false);

  const instruction = await core.methods
    .restoreDao(toBN(amount), toBN(priceUsdMicro))
    .accountsPartial({
      founder,
      globalConfig,
      daoRegistry: daoPubkey,
      daoLifecycle,
      daoStakeLock,
      naveMint,
      founderNaveAccount,
      stakeEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** Execute a passed SwitchVotingSystem proposal (SOL-C2 CPI gate).
 *  Target governance config is decoded from the proposal payload on-chain. */
export async function buildSwitchVotingSystem(
  daoPubkey: PublicKey,
  executor: PublicKey,
  proposalIndex: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [tokenRegistry] = getTokenRegistryPDA(daoPubkey);
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);

  const instruction = await governance.methods
    .executeSwitchVotingSystem()
    .accountsPartial({
      executor,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      tokenRegistry,
      proposal,
      naveCoreProgram: NAVE_CORE_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

/** revoke_token_authority — nave_core. Irrevocable. */
export async function buildRevokeTokenAuthority(
  daoPubkey: PublicKey,
  authority: PublicKey,
  mint: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [tokenRegistry] = getTokenRegistryPDA(daoPubkey);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [protocolFeeVault] = getProtocolFeeVaultPDA();

  const instruction = await core.methods
    .revokeTokenAuthority()
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      tokenRegistry,
      vaultAuthority,
      protocolFeeVault,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** update_token_metadata(name, symbol) — nave_core. */
export async function buildUpdateTokenMetadata(
  daoPubkey: PublicKey,
  authority: PublicKey,
  name: string,
  symbol: string,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [tokenRegistry] = getTokenRegistryPDA(daoPubkey);

  const instruction = await core.methods
    .updateTokenMetadata(name, symbol)
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      tokenRegistry,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — Constitution / guardians / agents
// ═══════════════════════════════════════════════════════════════════════════════

/** update_constitution(protocols, confidence_threshold?) — founder/authority. */
export async function buildUpdateConstitution(
  daoPubkey: PublicKey,
  authority: PublicKey,
  protocols: ProtocolInput[],
  confidenceThreshold: number | null = null,
  /** Agent deployment threshold in micro-USD (USD × 1_000_000), the on-chain
   *  `agent_threshold_usd` Option<u64> enforced against treasury NAV. When
   *  undefined, `null` is passed so the constitution value is left unchanged. */
  agentThresholdUsdMicro?: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [constitution] = getConstitutionPDA(daoPubkey);

  const instruction = await core.methods
    .updateConstitution(
      protocols.map((p) => ({
        protocolId: p.protocolId,
        programId: p.programId,
        maxAllocationBps: p.maxAllocationBps,
        approved: p.approved,
      })),
      confidenceThreshold,
      agentThresholdUsdMicro === undefined ? null : toBN(agentThresholdUsdMicro),
    )
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      constitution,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** set_review_window(review_window_secs) — founder. Sets the agent-pipeline
 *  oversight review window (in seconds) on the DAO constitution. New execution
 *  requests snapshot this value at creation; must be within MIN/MAX bounds
 *  enforced on-chain (60s–7d, default 24h). */
export async function buildSetReviewWindow(
  daoPubkey: PublicKey,
  authority: PublicKey,
  reviewWindowSecs: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [constitution] = getConstitutionPDA(daoPubkey);

  const instruction = await core.methods
    .setReviewWindow(toBN(reviewWindowSecs))
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      constitution,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** set_policy_parameters(...) — founder. Sets the continuous treasury policy:
 *  stablecoin reserve floor, global deployment cap, liquidity floor, and
 *  rebalance cadence. A `0` for any bps field unsets that constraint;
 *  `rebalanceFrequencySecs == 0` disables the cadence. Bounds are enforced
 *  on-chain. */
export async function buildSetPolicyParameters(
  daoPubkey: PublicKey,
  authority: PublicKey,
  minStablecoinReserveBps: number,
  maxTotalDeployedBps: number,
  minLiquidityBps: number,
  rebalanceFrequencySecs: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [constitution] = getConstitutionPDA(daoPubkey);

  const instruction = await core.methods
    .setPolicyParameters(
      minStablecoinReserveBps,
      maxTotalDeployedBps,
      minLiquidityBps,
      toBN(rebalanceFrequencySecs),
    )
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      constitution,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** update_guardian_config(wallets, threshold) — founder. */
export async function buildUpdateGuardianConfig(
  daoPubkey: PublicKey,
  authority: PublicKey,
  wallets: PublicKey[],
  threshold: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);

  const instruction = await core.methods
    .updateGuardianConfig(wallets, threshold)
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/**
 * emergency_pause_agents (SOLANA nave_core only) — instant single-actor pause
 * of the agent pipeline. Either the DAO founder OR any single guardian may sign;
 * no M-of-N threshold, no accumulation window. Scoped per-DAO. Re-enabling is
 * the high-friction path (governance proposal + executive toggle_agents via the
 * server proxy).
 *
 * NOTE: the EVM treasury has NO single-actor pause any more —
 * `NaveTreasury.emergencyPauseAgents()` was removed in favour of guardian
 * M-of-N `guardianAction(DISABLE_AGENTS, sigs)`; see
 * `buildGuardianDisableAgentsEvm` (evm/writers.ts) and
 * `setAgentsEnabledViaProxyEvm` (edgeFunctionClient.ts).
 */
export async function buildEmergencyPauseAgents(
  daoPubkey: PublicKey,
  authority: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [agentSet] = getAgentSetPDA(daoPubkey);

  const instruction = await core.methods
    .emergencyPauseAgents()
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      agentSet,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** emergency_freeze(action_nonce) — guardian multisig (action type 0). */
export async function buildEmergencyFreeze(
  daoPubkey: PublicKey,
  guardian: PublicKey,
  nonce: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [guardianAction] = getGuardianActionPDA(daoPubkey, 0, nonce);

  const instruction = await core.methods
    .emergencyFreeze(toBN(nonce))
    .accountsPartial({
      guardian,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      guardianAction,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** emergency_unfreeze(action_nonce) — guardian multisig (action type 1). */
export async function buildEmergencyUnfreeze(
  daoPubkey: PublicKey,
  guardian: PublicKey,
  nonce: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [guardianAction] = getGuardianActionPDA(daoPubkey, 1, nonce);

  const instruction = await core.methods
    .emergencyUnfreeze(toBN(nonce))
    .accountsPartial({
      guardian,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      guardianAction,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** cancel_guardian_action — founder-callable. Closes a finished or stale
 *  `GuardianAction` PDA and refunds its rent to the founder (`authority`). The
 *  action PDA is passed by address (not derived here): its on-chain `dao` field
 *  is verified against `dao_registry` in the handler, and a staleness gate
 *  preserves the guardian fail-closed behavior. No args. */
export async function buildCancelGuardianAction(
  daoPubkey: PublicKey,
  authority: PublicKey,
  guardianAction: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();

  const instruction = await core.methods
    .cancelGuardianAction()
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianAction,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** set_dao_privacy(privacy_mode) — founder. */
export async function buildSetDaoPrivacy(
  daoPubkey: PublicKey,
  founder: PublicKey,
  privacyMode: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();

  const instruction = await core.methods
    .setDaoPrivacy(privacyMode)
    .accountsPartial({
      founder,
      globalConfig,
      daoRegistry: daoPubkey,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** archive_proposals(count) — founder. */
export async function buildArchiveProposals(
  daoPubkey: PublicKey,
  authority: PublicKey,
  count: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();

  const instruction = await core.methods
    .archiveProposals(toBN(count))
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — Treasury & fees
// ═══════════════════════════════════════════════════════════════════════════════

/** deposit_to_vault(amount) — any depositor, SPL transfer into the legacy vault
 *  token account. The contract now REQUIRES the `mint` + per-(dao, mint)
 *  `asset_config` accounts and only accepts mints flagged as registered
 *  stablecoins (NonStablecoinVaultDeposit otherwise); the asset_config keys the
 *  stablecoin check and base-unit→micro-USD scaling. Non-stable / multi-asset
 *  deposits go through `deposit_to_asset` instead. */
export async function buildDepositToVault(
  daoPubkey: PublicKey,
  depositor: PublicKey,
  vaultMint: PublicKey,
  depositorTokenAccount: PublicKey,
  amount: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [assetConfig] = getAssetConfigPDA(daoPubkey, vaultMint);
  const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);

  const instruction = await core.methods
    .depositToVault(toBN(amount))
    .accountsPartial({
      depositor,
      globalConfig,
      daoRegistry: daoPubkey,
      treasuryVault,
      mint: vaultMint,
      assetConfig,
      depositorTokenAccount,
      vaultTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** collect_management_fee — discrete per-asset annual fee (0.65%/yr of the
 *  asset's idle vault balance), paid in-kind to the protocol revenue wallet's
 *  ATA for `mint`. Permissionless-but-validated: due only once per
 *  SECONDS_PER_YEAR (UTC-midnight anchored). Must be called ONCE PER MINT.
 *
 *  NOTE: the performance fee is no longer a standalone instruction — it is an
 *  8.5%-of-realized-yield skim taken inline on the strategy-withdrawal path
 *  (see withdraw_from_strategy / record_strategy_withdrawal). The old
 *  `collect_performance_fee` instruction was removed. */
export async function buildCollectManagementFee(
  daoPubkey: PublicKey,
  feeCollector: PublicKey,
  mint: PublicKey,
  revenueTokenAccount: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [feeConfig] = getFeeConfigPDA(daoPubkey);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryAsset] = getTreasuryAssetPDA(daoPubkey, mint);
  const [assetVault] = getAssetVaultPDA(daoPubkey, mint);

  const instruction = await core.methods
    .collectManagementFee()
    .accountsPartial({
      feeCollector,
      globalConfig,
      daoRegistry: daoPubkey,
      feeConfig,
      vaultAuthority,
      mint,
      treasuryAsset,
      assetVault,
      revenueTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — Multi-asset treasury
// ═══════════════════════════════════════════════════════════════════════════════

/** AssetKind discriminants (mirror nave_core::constants::AssetKind). */
export const ASSET_KIND = { STABLE: 0, SOL_LIKE: 1, OTHER: 2 } as const;

/** Convert a 32-byte Pyth feed id (hex string, with/without 0x) to a byte array.
 *  Returns 32 zero bytes for an empty/undefined id (valid only for stablecoins). */
export function hexFeedIdToBytes(hex?: string | null): number[] {
  if (!hex) return Array(32).fill(0);
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('Pyth feed id must be 32 bytes (64 hex chars)');
  }
  return Array.from(Buffer.from(clean, 'hex'));
}

/** register_asset(pyth_feed_id, is_stablecoin, asset_kind) — founder. Creates the
 *  per-(dao, mint) AssetConfig + TreasuryAsset + asset_vault holding account. */
export async function buildRegisterAsset(
  daoPubkey: PublicKey,
  founder: PublicKey,
  mint: PublicKey,
  pythFeedId: number[] | string | null,
  isStablecoin: boolean,
  assetKind: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);
  const [assetConfig] = getAssetConfigPDA(daoPubkey, mint);
  const [treasuryAsset] = getTreasuryAssetPDA(daoPubkey, mint);
  const [assetVault] = getAssetVaultPDA(daoPubkey, mint);
  const feedId = Array.isArray(pythFeedId) ? pythFeedId : hexFeedIdToBytes(pythFeedId);

  const instruction = await core.methods
    .registerAsset(feedId, isStablecoin, assetKind)
    .accountsPartial({
      authority: founder,
      globalConfig,
      daoRegistry: daoPubkey,
      mint,
      vaultAuthority,
      treasuryVault,
      assetConfig,
      treasuryAsset,
      assetVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** register_nft_asset — founder. Creates NftVaultRecord + nft_vault holding account. */
export async function buildRegisterNftAsset(
  daoPubkey: PublicKey,
  founder: PublicKey,
  mint: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [nftRecord] = getNftVaultRecordPDA(daoPubkey, mint);
  const [nftVault] = getNftVaultPDA(daoPubkey, mint);

  const instruction = await (core.methods as unknown as { registerNftAsset: () => { accountsPartial: (a: object) => { instruction: () => Promise<TransactionInstruction> } } })
    .registerNftAsset()
    .accountsPartial({
      authority: founder,
      daoRegistry: daoPubkey,
      mint,
      vaultAuthority,
      nftRecord,
      nftVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** set_fee_asset — founder. Designates which registered stablecoin USD fees are
 *  paid in. The asset must already be registered and flagged stablecoin. */
export async function buildSetFeeAsset(
  daoPubkey: PublicKey,
  founder: PublicKey,
  mint: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [assetConfig] = getAssetConfigPDA(daoPubkey, mint);
  const [feeConfig] = getFeeConfigPDA(daoPubkey);

  const instruction = await core.methods
    .setFeeAsset()
    .accountsPartial({
      authority: founder,
      daoRegistry: daoPubkey,
      mint,
      assetConfig,
      feeConfig,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** deposit_to_asset(amount) — any depositor. SPL transfer of a registered asset
 *  into its holding account; bumps per-asset principal (NAV via revalue_treasury). */
export async function buildDepositToAsset(
  daoPubkey: PublicKey,
  depositor: PublicKey,
  mint: PublicKey,
  depositorTokenAccount: PublicKey,
  amount: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [assetConfig] = getAssetConfigPDA(daoPubkey, mint);
  const [treasuryAsset] = getTreasuryAssetPDA(daoPubkey, mint);
  const [assetVault] = getAssetVaultPDA(daoPubkey, mint);

  const instruction = await core.methods
    .depositToAsset(toBN(amount))
    .accountsPartial({
      depositor,
      daoRegistry: daoPubkey,
      mint,
      assetConfig,
      treasuryAsset,
      assetVault,
      depositorTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** deposit_sol(amount) — any depositor. Native SOL transfer (in lamports) into
 *  the DAO's vault_authority PDA, the same account that custodies native SOL for
 *  governance transfers. Resets on-chain NAV staleness (NAV via revalue_treasury). */
export async function buildDepositSol(
  daoPubkey: PublicKey,
  depositor: PublicKey,
  lamports: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);

  const instruction = await core.methods
    .depositSol(toBN(lamports))
    .accountsPartial({
      depositor,
      daoRegistry: daoPubkey,
      vaultAuthority,
      treasuryVault,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** configure_position_targets(protocol_id, ext_market, ext_reserve) — founder.
 *  Binds the approved external market+reserve to a (protocol, mint) strategy
 *  position and provisions the vault-owned receipt-token (cToken / poolSOL)
 *  account, so agent CPIs can only ever deploy into THIS target. */
export async function buildConfigurePositionTargets(
  daoPubkey: PublicKey,
  founder: PublicKey,
  protocolId: string,
  mint: PublicKey,
  collateralMint: PublicKey,
  extMarket: PublicKey,
  extReserve: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [strategyPosition] = getStrategyPositionForMintPDA(daoPubkey, protocolId, mint);
  const [positionTokenAccount] = getPositionTokenPDA(daoPubkey, protocolId, mint);

  const instruction = await core.methods
    .configurePositionTargets(protocolId, extMarket, extReserve)
    .accountsPartial({
      authority: founder,
      globalConfig,
      daoRegistry: daoPubkey,
      mint,
      collateralMint,
      vaultAuthority,
      strategyPosition,
      positionTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/**
 * configure_marginfi_position(ext_market, ext_reserve) — founder, one-time
 * per (dao, mint). Binds the approved MarginFi group + bank to a (marginfi,
 * mint) strategy position (mirrors `configure_position_targets` for
 * Kamino/Jito) and provisions the DAO's cross-margin `MarginfiAccount` ledger
 * via a permissionless `marginfi_account_initialize` CPI, signed by the
 * `vault_authority` PDA as the ledger's authority.
 *
 * Unlike Kamino/Jito's receipt-token PDA, a MarginfiAccount is a non-PDA data
 * account: `marginfiAccount` MUST be a FRESH keypair that co-signs this call
 * (Anchor requires it be a signer on every call, even once already
 * provisioned — the on-chain handler's idempotent skip only elides the CPI
 * itself, not the signature requirement). The on-chain design supports
 * REUSING the same ledger across multiple mints for one DAO (pass the same
 * `marginfiAccount` again), but that requires persisting the keypair's
 * PRIVATE key off-chain to reuse it later — this app does not currently do
 * that (no Supabase schema addition was made unilaterally for it; see
 * AUDIT_FINDINGS / the phase6 handoff notes). Each call to this builder
 * therefore generates and returns a FRESH ledger keypair; configuring MarginFi
 * for multiple mints on the same DAO will provision one ledger per mint
 * (functionally correct, marginally less rent-efficient than the ideal
 * single-shared-ledger design).
 */
export async function buildConfigureMarginfiPosition(
  daoPubkey: PublicKey,
  founder: PublicKey,
  mint: PublicKey,
  marginfiGroup: PublicKey,
  bank: PublicKey,
): Promise<TransactionBuildResult & { marginfiAccount: PublicKey }> {
  const marginfiAccountKeypair = Keypair.generate();
  if (USE_MOCKS) {
    return { ...mock(NAVE_CORE_PROGRAM_ID), marginfiAccount: marginfiAccountKeypair.publicKey };
  }
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [strategyPosition] = getStrategyPositionForMintPDA(daoPubkey, 'marginfi', mint);

  const instruction = await core.methods
    .configureMarginfiPosition(marginfiGroup, bank)
    .accountsPartial({
      authority: founder,
      globalConfig,
      daoRegistry: daoPubkey,
      mint,
      vaultAuthority,
      strategyPosition,
      marginfiGroup,
      marginfiAccount: marginfiAccountKeypair.publicKey,
      marginfiProgram: MARGINFI_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return {
    instruction,
    programId: NAVE_CORE_PROGRAM_ID,
    signers: [marginfiAccountKeypair],
    marginfiAccount: marginfiAccountKeypair.publicKey,
  };
}

/** A registered asset to revalue. `priceUpdate` is the posted Pyth PriceUpdateV2
 *  account; required for non-stables, omitted (or any placeholder) for stables. */
export interface RevalueAsset {
  mint: PublicKey;
  priceUpdate?: PublicKey;
}

/** revalue_treasury — operational agent. Recomputes the DAO's USD NAV (micro-USD)
 *  from every registered asset. Each asset contributes a 4-account group passed as
 *  remaining accounts: [assetConfig, treasuryAsset(w), assetVault, priceUpdate],
 *  followed by the DAO's StrategyPositions that hold principal.
 *  Stablecoins ignore the 4th slot, so the assetVault is passed as a placeholder.
 *
 *  NOTE: this builds the raw instruction only. Non-stable assets require a FRESH
 *  posted Pyth update — in production the off-chain pipeline (snapshot-treasury →
 *  signer) self-posts and triggers this. The browser builder is for advanced /
 *  manual use where the caller already has posted update accounts. */
export async function buildRevalueTreasury(
  daoPubkey: PublicKey,
  authority: PublicKey,
  assets: RevalueAsset[],
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  if (assets.length === 0) {
    return { instruction: null, programId: NAVE_CORE_PROGRAM_ID, error: 'revalue requires at least one asset' };
  }
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);

  const remainingAccounts = assets.flatMap((a) => {
    const [assetConfig] = getAssetConfigPDA(daoPubkey, a.mint);
    const [treasuryAsset] = getTreasuryAssetPDA(daoPubkey, a.mint);
    const [assetVault] = getAssetVaultPDA(daoPubkey, a.mint);
    return [
      { pubkey: assetConfig, isWritable: false, isSigner: false },
      { pubkey: treasuryAsset, isWritable: true, isSigner: false },
      { pubkey: assetVault, isWritable: false, isSigner: false },
      { pubkey: a.priceUpdate ?? assetVault, isWritable: false, isSigner: false },
    ];
  });
  // Every position holding principal follows the asset groups; NAV counts
  // their marked value.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const positions: any[] = await (core.account as any).strategyPosition.all([
    { memcmp: { offset: 9, bytes: daoPubkey.toBase58() } },
  ]);
  for (const p of positions) {
    if (BigInt(p.account.depositedAmount.toString()) > 0n) {
      remainingAccounts.push({ pubkey: p.publicKey, isWritable: false, isSigner: false });
    }
  }

  const [agentSet] = getAgentSetPDA(daoPubkey);
  const instruction = await core.methods
    .revalueTreasury()
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
      treasuryVault,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** Canonical Pyth SOL/USD price feed id (32-byte hex, no 0x). Used to register
 *  the wSOL treasury-seed asset so the on-chain valuation can price it. Same id
 *  on mainnet and devnet (Pyth pull-oracle feed ids are network-independent). */
export const SOL_USD_PYTH_FEED_ID =
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

/** The wrapped-SOL mint (`So111...112`); the SolLike treasury-seed asset. */
export const WSOL_MINT = NATIVE_MINT;

/**
 * Treasury-seed (wSOL) sequence for the unified creation flow.
 *
 * Seeds the brand-new DAO treasury with `seedLamports` of SOL, wrapped to wSOL
 * and registered as a `SolLike` priced asset so the agents have a deployable
 * balance immediately after creation. Mirrors the on-chain `TREASURY_SEED_LAMPORTS`
 * carve-out (mainnet 0.3 SOL / devnet 0.1 SOL) which `initialize_dao` intentionally
 * does NOT charge — the seed is performed client-side here.
 *
 * Returns three discrete builds the caller sequences as tx groups:
 *   1. `register` — `register_asset(wSOL, SolLike, SOL/USD feed)` (inits the
 *      AssetConfig + TreasuryAsset + asset_vault PDAs).
 *   2. `deposit`  — wrap (`createAta` + `SystemProgram.transfer` + `syncNative`
 *      as preInstructions) then `deposit_to_asset(seedLamports)` from the founder's
 *      wSOL ATA into the treasury asset vault.
 *   3. `revalue`  — `revalue_treasury` over the wSOL asset, recomputing USD NAV.
 *      OMITTED (null) unless `solUsdPriceUpdate` (a posted Pyth PriceUpdateV2
 *      account) is supplied, since non-stable revaluation requires a fresh price
 *      account. When omitted, the off-chain snapshot/revalue pipeline computes NAV
 *      before the bootstrap request executes — the wizard does not block on it.
 */
export async function buildSeedTreasuryWsol(
  daoPubkey: PublicKey,
  founder: PublicKey,
  seedLamports: number | bigint,
  solUsdPriceUpdate?: PublicKey,
): Promise<{
  register: TransactionBuildResult;
  deposit: TransactionBuildResult;
  revalue: TransactionBuildResult | null;
}> {
  const founderWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, founder, false);

  const register = await buildRegisterAsset(
    daoPubkey,
    founder,
    WSOL_MINT,
    SOL_USD_PYTH_FEED_ID,
    false,
    ASSET_KIND.SOL_LIKE,
  );

  const deposit = await buildDepositToAsset(
    daoPubkey,
    founder,
    WSOL_MINT,
    founderWsolAta,
    seedLamports,
  );
  // Wrap native SOL into the founder's wSOL ATA in the SAME tx as the tracked
  // deposit: create the ATA (idempotent), fund it with the seed lamports, then
  // sync_native so the wrapped balance is spendable before deposit_to_asset.
  if (!USE_MOCKS && deposit.instruction) {
    deposit.preInstructions = [
      createAssociatedTokenAccountIdempotentInstruction(founder, founderWsolAta, founder, WSOL_MINT),
      SystemProgram.transfer({
        fromPubkey: founder,
        toPubkey: founderWsolAta,
        lamports: Number(seedLamports),
      }),
      createSyncNativeInstruction(founderWsolAta),
      ...(deposit.preInstructions ?? []),
    ];
  }

  const revalue = solUsdPriceUpdate
    ? await buildRevalueTreasury(daoPubkey, founder, [
        { mint: WSOL_MINT, priceUpdate: solUsdPriceUpdate },
      ])
    : null;

  return { register, deposit, revalue };
}

/**
 * jupiter_swap(amount_in, min_amount_out, expected_amount_out, route_data) —
 * operational-agent-gated.
 *
 * Swaps one registered treasury asset (`mintIn`) for another (`mintOut`) via a
 * direct CPI into the Jupiter v6 aggregator, signing as the DAO `vault_authority`
 * PDA. The on-chain context enforces the operational-agent signer, balance-delta
 * bounds (`actual_in <= amount_in`, `actual_out >= min_amount_out`), the
 * stablecoin reserve floor when selling a stable, and that the swap
 * source/destination are the vault-owned per-mint `asset_vault` token accounts
 * (`source_token_account == treasury_asset_in.token_account`, and likewise for
 * out). The DAO keeps custody throughout.
 *
 * `expectedAmountOut` (NEW, inserted before `route_data`) is the constitution
 * `max_slippage_bps` guardrail's independent reference point: when a DAO has
 * configured `max_slippage_bps > 0`, the program requires
 * `min_amount_out >= expected_amount_out * (1 - max_slippage_bps / 10_000)`,
 * bounding how far an agent's caller-supplied `min_amount_out` floor may drift
 * from the genuine expected output — a compromised/rogue agent can no longer
 * pick an unbounded (near-zero) `min_amount_out` and still pass every check.
 * CALLERS MUST source this from the SAME off-chain quote used to derive
 * `min_amount_out`/`routeData` (e.g. a fresh Jupiter `/quote` response's
 * `outAmount` field — the optimistic expected output, distinct from
 * `otherAmountThreshold`, which is what `minAmountOut` should come from).
 * Passing `minAmountOut` again here would make the guardrail check trivially
 * pass regardless of `max_slippage_bps` and defeat its purpose.
 *
 * MAINNET-ONLY: the swap route must be built off-chain via the Jupiter
 * `/swap-instructions` API with a capped `maxAccounts` (e.g. <= 30) because a CPI
 * cannot use Address Lookup Tables — every route account is forwarded inline as
 * `remaining_accounts`. Pass `routeData` = base64-decoded `swapInstruction.data`
 * and `routeAccounts` = `swapInstruction.accounts` mapped to `AccountMeta[]`.
 * Jupiter v6 is only deployed on mainnet, so this fails against a devnet RPC.
 */
export async function buildJupiterSwap(
  daoPubkey: PublicKey,
  operationalAgent: PublicKey,
  mintIn: PublicKey,
  mintOut: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint,
  expectedAmountOut: bigint,
  routeData: Buffer,
  routeAccounts: AccountMeta[],
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [constitution] = getConstitutionPDA(daoPubkey);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);
  const [assetConfigIn] = getAssetConfigPDA(daoPubkey, mintIn);
  const [assetConfigOut] = getAssetConfigPDA(daoPubkey, mintOut);
  const [treasuryAssetIn] = getTreasuryAssetPDA(daoPubkey, mintIn);
  const [treasuryAssetOut] = getTreasuryAssetPDA(daoPubkey, mintOut);
  // Source/destination are the per-mint asset_vault PDAs (vault_authority-owned),
  // which the on-chain context binds to treasury_asset_{in,out}.token_account.
  const [sourceTokenAccount] = getAssetVaultPDA(daoPubkey, mintIn);
  const [destinationTokenAccount] = getAssetVaultPDA(daoPubkey, mintOut);

  const instruction = await core.methods
    .jupiterSwap(
      new BN(amountIn.toString()),
      new BN(minAmountOut.toString()),
      new BN(expectedAmountOut.toString()),
      routeData,
    )
    .accountsPartial({
      operationalAgent,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
      constitution,
      vaultAuthority,
      treasuryVault,
      mintIn,
      mintOut,
      assetConfigIn,
      assetConfigOut,
      treasuryAssetIn,
      treasuryAssetOut,
      sourceTokenAccount,
      destinationTokenAccount,
      jupiterProgram: NAVE_JUPITER_SWAP_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(routeAccounts)
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** Encode the 72-byte Strategy execution payload bound by the proposal hash:
 *  `protocol_program(32) ‖ amount_le(8) ‖ mint(32)`. The governance proposal
 *  stores `sha256(payload)`; `create_execution_request` recomputes it from
 *  `(protocol_program, amount, mint)` and rejects any mismatch (NE-7), so the
 *  Strategy proposal MUST be created with exactly these bytes. */
export function encodeStrategyProposalPayload(
  protocolProgram: PublicKey,
  amount: number | bigint,
  mint: PublicKey,
): number[] {
  const buf = Buffer.alloc(72);
  buf.set(protocolProgram.toBytes(), 0);
  buf.writeBigUInt64LE(BigInt(amount.toString()), 32);
  buf.set(mint.toBytes(), 40);
  return [...buf];
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — Holder annotations
// ═══════════════════════════════════════════════════════════════════════════════

/** set_holder_annotation(annotation) — holder. */
export async function buildSetHolderAnnotation(
  daoPubkey: PublicKey,
  holder: PublicKey,
  annotation: string,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [holderAnnotation] = getHolderAnnotationPDA(daoPubkey, holder);

  const instruction = await core.methods
    .setHolderAnnotation(annotation)
    .accountsPartial({
      holder,
      globalConfig,
      daoRegistry: daoPubkey,
      holderAnnotation,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** approve_holder_annotation — founder/guardian reviewer. */
export async function buildApproveHolderAnnotation(
  daoPubkey: PublicKey,
  holderPubkey: PublicKey,
  reviewer: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [holderAnnotation] = getHolderAnnotationPDA(daoPubkey, holderPubkey);

  const instruction = await core.methods
    .approveHolderAnnotation()
    .accountsPartial({
      reviewer,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      holderAnnotation,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** deny_holder_annotation — founder/guardian reviewer. */
export async function buildDenyHolderAnnotation(
  daoPubkey: PublicKey,
  holderPubkey: PublicKey,
  reviewer: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [holderAnnotation] = getHolderAnnotationPDA(daoPubkey, holderPubkey);

  const instruction = await core.methods
    .denyHolderAnnotation()
    .accountsPartial({
      reviewer,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      holderAnnotation,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_governance — Proposals & voting
// ═══════════════════════════════════════════════════════════════════════════════

/** create_proposal(params) — any proposer. Auto-resolves daoTokenMint from token registry. */
export async function buildCreateProposal(
  daoPubkey: PublicKey,
  proposalIndex: number,
  proposer: PublicKey,
  params: CreateProposalParams,
  daoTokenMint: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);

  const instruction = await governance.methods
    .createProposal({
      title: params.title,
      description: params.description,
      payload: Buffer.from(params.payload),
      proposalType: params.proposalType,
      votingPeriodSeconds: toBN(params.votingPeriodSeconds),
    })
    .accountsPartial({
      proposer,
      daoRegistry: daoPubkey,
      proposal,
      daoTokenMint,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

/** cast_vote_wallet(choice) — guardian only, weight = 1. */
export async function buildCastVoteWallet(
  daoPubkey: PublicKey,
  proposalIndex: number,
  voter: PublicKey,
  choice: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);

  const instruction = await governance.methods
    .castVoteWallet(choice)
    .accountsPartial({
      voter,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      proposal,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

/** lock_tokens_and_vote(amount, choice) — token voter, weight = amount. */
export async function buildLockTokensAndVote(
  daoPubkey: PublicKey,
  proposalIndex: number,
  voter: PublicKey,
  daoTokenMint: PublicKey,
  voterTokenAccount: PublicKey,
  amount: number | bigint,
  choice: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);
  const [voteEscrow] = getVoteEscrowPDA(proposal, voter);
  const [voteRecord] = getVoteRecordPDA(proposal, voter);
  const escrowTokenAccount = getAssociatedTokenAddressSync(daoTokenMint, voteEscrow, true);

  const instruction = await governance.methods
    .lockTokensAndVote(toBN(amount), choice)
    .accountsPartial({
      voter,
      globalConfig,
      daoRegistry: daoPubkey,
      proposal,
      daoTokenMint,
      voterTokenAccount,
      escrowTokenAccount,
      voteEscrow,
      voteRecord,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

/** release_vote_escrow — voter, after proposal no longer Active. */
export async function buildReleaseVoteEscrow(
  daoPubkey: PublicKey,
  proposalIndex: number,
  voter: PublicKey,
  daoTokenMint: PublicKey,
  voterTokenAccount: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);
  const [voteEscrow] = getVoteEscrowPDA(proposal, voter);
  const escrowTokenAccount = getAssociatedTokenAddressSync(daoTokenMint, voteEscrow, true);

  const instruction = await governance.methods
    .releaseVoteEscrow()
    .accountsPartial({
      voter,
      globalConfig,
      daoRegistry: daoPubkey,
      proposal,
      voteEscrow,
      escrowTokenAccount,
      voterTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

/** finalize_proposal — anyone, after voting_end or when outcome is certain. */
export async function buildFinalizeProposal(
  daoPubkey: PublicKey,
  proposalIndex: number,
  authority: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);

  const instruction = await governance.methods
    .finalizeProposal()
    .accountsPartial({
      authority,
      daoRegistry: daoPubkey,
      guardianConfig,
      proposal,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

/** Anchor discriminator for `execute_treasury_transfer_native_sol`. */
const EXECUTE_TREASURY_TRANSFER_NATIVE_SOL_DISCRIMINATOR = Buffer.from([
  57, 18, 0, 108, 98, 23, 116, 45,
]);

/** Post-pass Transfer (native SOL): disburse lamports from vault_authority per proposal payload. */
export async function buildExecuteTreasuryTransferNativeSol(
  daoPubkey: PublicKey,
  proposalIndex: number,
  executor: PublicKey,
  recipient: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);

  // Manual account list: app IDL predates `treasury_vault` on this instruction; omitting it
  // shifts `recipient` into the treasury_vault slot and fails with Custom 3007 (wrong owner).
  const instruction = new TransactionInstruction({
    programId: NAVE_GOVERNANCE_PROGRAM_ID,
    keys: [
      { pubkey: executor, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: daoPubkey, isSigner: false, isWritable: false },
      { pubkey: proposal, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: true },
      { pubkey: treasuryVault, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: NAVE_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: EXECUTE_TREASURY_TRANSFER_NATIVE_SOL_DISCRIMINATOR,
  });

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

/** Post-pass Transfer (registered SPL): move idle vault tokens to recipient ATA. */
export async function buildExecuteTreasuryTransferSpl(
  daoPubkey: PublicKey,
  proposalIndex: number,
  executor: PublicKey,
  mint: PublicKey,
  recipientOwner: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [assetConfig] = getAssetConfigPDA(daoPubkey, mint);
  const [treasuryAsset] = getTreasuryAssetPDA(daoPubkey, mint);
  const [assetVault] = getAssetVaultPDA(daoPubkey, mint);
  const recipientToken = getAssociatedTokenAddressSync(mint, recipientOwner, false);

  const preInstructions = [
    createAssociatedTokenAccountIdempotentInstruction(executor, recipientToken, recipientOwner, mint),
  ];

  const instruction = await governance.methods
    .executeTreasuryTransferSpl()
    .accountsPartial({
      executor,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      globalConfig,
      daoRegistry: daoPubkey,
      proposal,
      vaultAuthority,
      mint,
      assetConfig,
      treasuryAsset,
      assetVault,
      recipient: recipientOwner,
      recipientToken,
      naveCoreProgram: NAVE_CORE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID, preInstructions };
}

/** Anchor discriminator for `execute_treasury_transfer_nft`. */
const EXECUTE_TREASURY_TRANSFER_NFT_DISCRIMINATOR = Buffer.from([31, 12, 38, 220, 178, 105, 122, 241]);

/** Post-pass NFT transfer: move 1 unit from nft_vault after a Transfer proposal (amount=1). */
export async function buildExecuteTreasuryTransferNft(
  daoPubkey: PublicKey,
  proposalIndex: number,
  executor: PublicKey,
  mint: PublicKey,
  recipientOwner: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [nftRecord] = getNftVaultRecordPDA(daoPubkey, mint);
  const [nftVault] = getNftVaultPDA(daoPubkey, mint);
  const recipientToken = getAssociatedTokenAddressSync(mint, recipientOwner, false);

  const preInstructions = [
    createAssociatedTokenAccountIdempotentInstruction(executor, recipientToken, recipientOwner, mint),
  ];

  const instruction = new TransactionInstruction({
    programId: NAVE_GOVERNANCE_PROGRAM_ID,
    keys: [
      { pubkey: executor, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: daoPubkey, isSigner: false, isWritable: false },
      { pubkey: proposal, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: nftRecord, isSigner: false, isWritable: true },
      { pubkey: nftVault, isSigner: false, isWritable: true },
      { pubkey: recipientOwner, isSigner: false, isWritable: false },
      { pubkey: recipientToken, isSigner: false, isWritable: true },
      { pubkey: NAVE_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: EXECUTE_TREASURY_TRANSFER_NFT_DISCRIMINATOR,
  });

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID, preInstructions };
}

/** Decode on-chain transfer proposal payload: recipient (32) || mint (32) || amount u64 LE. */
export function decodeSolanaTransferProposalPayload(payload: Buffer | Uint8Array): {
  recipient: PublicKey;
  mint: PublicKey;
  amount: bigint;
} {
  const buf = Buffer.from(payload);
  if (buf.length < 72) {
    throw new Error('Solana transfer proposal payload must be 72 bytes');
  }
  return {
    recipient: new PublicKey(buf.subarray(0, 32)),
    mint: new PublicKey(buf.subarray(32, 64)),
    amount: buf.readBigUInt64LE(64),
  };
}

/** Encode the 72-byte transfer proposal payload (mirrors on-chain hash binding). */
export function encodeSolanaTransferProposalPayload(
  recipient: PublicKey,
  mintOrZero: PublicKey | null,
  amount: bigint,
): number[] {
  const buf = Buffer.alloc(72);
  buf.set(recipient.toBytes(), 0);
  buf.set(mintOrZero ? mintOrZero.toBytes() : Buffer.alloc(32), 32);
  buf.writeBigUInt64LE(amount, 64);
  return [...buf];
}

/** Encode a 72-byte NFT transfer proposal payload (amount fixed at 1). */
export function encodeSolanaNftTransferProposalPayload(
  recipient: PublicKey,
  mint: PublicKey,
): number[] {
  return encodeSolanaTransferProposalPayload(recipient, mint, 1n);
}

/** cancel_proposal — original proposer, while active. */
export async function buildCancelProposal(
  daoPubkey: PublicKey,
  proposalIndex: number,
  proposer: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [proposal] = getProposalPDA(daoPubkey, proposalIndex);

  const instruction = await governance.methods
    .cancelProposal()
    .accountsPartial({
      proposer,
      globalConfig,
      proposal,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

/** mint_additional_tokens(amount) — founder; DAO PDA is mint authority. */
export async function buildMintAdditionalTokens(
  daoPubkey: PublicKey,
  authority: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  amount: number | bigint,
  proposalIndex?: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_GOVERNANCE_PROGRAM_ID);
  const { governance } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [tokenRegistry] = getTokenRegistryPDA(daoPubkey);
  const [genesisRecord] = getTokenGenesisRecordPDA(daoPubkey, mint);
  // Post-genesis mints are bound on-chain to their passed TokenMint proposal
  // (audit M11). The genesis supply mint (supply == 0) passes no proposal.
  const proposal =
    typeof proposalIndex === 'number' ? getProposalPDA(daoPubkey, proposalIndex)[0] : null;

  const instruction = await governance.methods
    .mintAdditionalTokens(toBN(amount))
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      tokenRegistry,
      proposal,
      genesisRecord,
      mint,
      destination,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      naveCoreProgram: NAVE_CORE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_GOVERNANCE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — Strategy position accounting
// ═══════════════════════════════════════════════════════════════════════════════

/** init_strategy_position(protocol_id) — founder/authority, once per (protocol, mint).
 *  Multi-asset: positions are keyed by the asset mint they deploy. */
export async function buildInitStrategyPosition(
  daoPubkey: PublicKey,
  authority: PublicKey,
  protocolId: string,
  mint: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [strategyPosition] = getStrategyPositionForMintPDA(daoPubkey, protocolId, mint);

  const instruction = await core.methods
    .initStrategyPosition(protocolId)
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      mint,
      strategyPosition,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** init_strategy_escrow(protocol_id) — founder/authority, once per (protocol, mint).
 *  Creates the per-(protocol, mint) escrow token account (PDA-owned by
 *  vault_authority) that strategy capital is moved into. Requires the mint to
 *  already be registered as a treasury asset (register_asset). */
export async function buildInitStrategyEscrow(
  daoPubkey: PublicKey,
  authority: PublicKey,
  protocolId: string,
  vaultMint: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryAsset] = getTreasuryAssetPDA(daoPubkey, vaultMint);
  const [strategyEscrow] = getStrategyEscrowForMintPDA(daoPubkey, protocolId, vaultMint);

  const instruction = await core.methods
    .initStrategyEscrow(protocolId)
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      vaultAuthority,
      treasuryAsset,
      mint: vaultMint,
      strategyEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_execution — Agent approval pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/** Anchor discriminator for `create_execution_request` (sha256("global:create_execution_request")[..8]).
 *  Stable across the legacy and bootstrap program versions (it is derived from the
 *  instruction NAME, which is unchanged) — used to hand-build the legacy wire shape. */
const CREATE_EXECUTION_REQUEST_DISCRIMINATOR = Buffer.from([78, 158, 203, 32, 231, 122, 140, 188]);

/**
 * Build the LEGACY `create_execution_request(amount, protocol_program, mint)`
 * instruction (no `bootstrap` arg, no `nave_core_program` / `execution_program`
 * accounts) so it matches the CURRENTLY-DEPLOYED nave_execution program. Used
 * whenever {@link BOOTSTRAP_PROGRAMS_DEPLOYED} is false. Built by hand (not via
 * the Anchor IDL codec) because the bundled IDL now describes the newer shape.
 */
function buildLegacyCreateExecutionRequestIx(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  creator: PublicKey,
  amount: number | bigint,
  protocolProgram: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [constitution] = getConstitutionPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);

  // args: amount(u64 LE) ‖ protocol_program(32) ‖ mint(32)
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(amount.toString()), 0);
  const data = Buffer.concat([
    CREATE_EXECUTION_REQUEST_DISCRIMINATOR,
    amountBuf,
    protocolProgram.toBuffer(),
    mint.toBuffer(),
  ]);

  // Account order mirrors the deployed (pre-bootstrap) program's Accounts struct.
  const keys = [
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: globalConfig, isSigner: false, isWritable: false },
    { pubkey: daoPubkey, isSigner: false, isWritable: false },
    { pubkey: proposalPubkey, isSigner: false, isWritable: false },
    { pubkey: constitution, isSigner: false, isWritable: false },
    { pubkey: treasuryVault, isSigner: false, isWritable: false },
    { pubkey: executionRequest, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: NAVE_EXECUTION_PROGRAM_ID, keys, data });
}

/** create_execution_request(amount, protocol_program, mint, bootstrap) — requires
 *  a Passed Strategy proposal whose payload hash binds (protocol_program, amount,
 *  mint). When `bootstrap` is true the request snapshots a zero review window for
 *  immediate execution — this is founder-gated and consumes the DAO's one-time
 *  `dao_registry.bootstrap_used` latch (flipped via the nave_core CPI). The
 *  `dao_registry` is mutated on the bootstrap path, and the nave_core +
 *  execution programs are forwarded for that CPI; pass them for every call
 *  (ignored when `bootstrap === false`).
 *
 *  COMPATIBILITY: the bootstrap arg + extra accounts only exist on the redeployed
 *  programs. Until {@link BOOTSTRAP_PROGRAMS_DEPLOYED} is set (VITE_NAVE_BOOTSTRAP_DEPLOYED=true),
 *  non-bootstrap calls fall back to the legacy instruction shape so the normal
 *  strategy-execution path keeps working against the deployed program, and a
 *  `bootstrap = true` request is rejected up-front with a clear redeploy message. */
export async function buildCreateExecutionRequest(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  creator: PublicKey,
  amount: number | bigint,
  protocolProgram: PublicKey,
  mint: PublicKey,
  bootstrap = false,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);

  // ── Legacy / pre-bootstrap deployed program ─────────────────────────────────
  if (!BOOTSTRAP_PROGRAMS_DEPLOYED) {
    if (bootstrap) {
      throw new Error(
        'Bootstrap execution requests require the redeployed nave_execution + ' +
          'nave_core programs (set VITE_NAVE_BOOTSTRAP_DEPLOYED=true after redeploy). ' +
          'The currently-deployed program does not support the bootstrap path.',
      );
    }
    const instruction = buildLegacyCreateExecutionRequestIx(
      daoPubkey,
      proposalPubkey,
      creator,
      amount,
      protocolProgram,
      mint,
    );
    return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
  }

  // ── Redeployed program with bootstrap support ───────────────────────────────
  const { execution } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [constitution] = getConstitutionPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);

  const instruction = await execution.methods
    .createExecutionRequest(toBN(amount), protocolProgram, mint, bootstrap)
    .accountsPartial({
      creator,
      globalConfig,
      daoRegistry: daoPubkey,
      proposal: proposalPubkey,
      constitution,
      treasuryVault,
      executionRequest,
      naveCoreProgram: NAVE_CORE_PROGRAM_ID,
      executionProgram: NAVE_EXECUTION_PROGRAM_ID,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

/** Map our InitializeDaoParams to the IDL's BN-typed field shape. */
function toIdlDaoParams(p: InitializeDaoParams) {
  return {
    name: p.name,
    guardianWallets: p.guardianWallets,
    guardianThreshold: p.guardianThreshold,
    agentAuthorities: p.agentAuthorities,
    managementFeeBps: p.managementFeeBps,
    performanceFeeBps: p.performanceFeeBps,
    frozenManagementFeeBps: p.frozenManagementFeeBps,
    frozenPerformanceFeeBps: p.frozenPerformanceFeeBps,
    privacyMode: p.privacyMode,
    feeRecipient: p.feeRecipient,
    protocolRevenueWallet: p.protocolRevenueWallet,
    quorumBps: p.quorumBps,
    governanceType: p.governanceType,
  };
}

// ─── Fee calculation helper ──────────────────────────────────────────────────

/** DEPRECATED: DAO formation is now fee-free (a recoverable NAVE stake replaces
 *  the old SOL formation fee). Retained as zero for call-site compatibility. */
export const DAO_FORMATION_FEE_SOL = 0;

export function calculateFormationFee(): number {
  return DAO_FORMATION_FEE_SOL * LAMPORTS_PER_SOL;
}
