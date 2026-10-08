// ═══════════════════════════════════════════════════════════════════════════════
// Server-only transaction builders
// ═══════════════════════════════════════════════════════════════════════════════
//
// These builders are NOT used by the browser UI. They construct transactions that
// are signed by server-held keys (the 4 agent keypairs / signer service) or by the
// protocol-admin / guardian-admin operator — never by an end user's wallet from a
// page. They were previously co-located in `transactionBuilders.ts`, which the
// client imports broadly; keeping them here in a module the app entry never imports
// ensures they are tree-shaken out of the client bundle and prevents accidental
// wiring of agent-signing / admin paths into the UI.
//
// Covered:
//   • Agent approval pipeline  : executive/financial/oversight approve, operational halt/clear
//   • Strategy execution (CPI) : execute_strategy, execute_strategy_direct, withdraw_from_strategy
//   • Protocol admin           : initialize/update_global_config
//   • Agent-set admin          : toggle/nullify/restore agents, update agent set, rotate keys,
//                                 update agent status, guardian-disable agents
//
// Frontend-used builders (deposits, proposals, voting, guardian config, constitution,
// emergency pause/freeze, token ops, etc.) remain in `transactionBuilders.ts`.

import { BN } from '@coral-xyz/anchor';
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getNavePrograms, getAdapterProgram } from './naveProgram';
import {
  NAVE_CORE_PROGRAM_ID,
  NAVE_EXECUTION_PROGRAM_ID,
  USE_MOCKS,
} from './programConfig';
import {
  getNaveGlobalConfigPDA,
  getAgentSetPDA,
  getGuardianConfigPDA,
  getGuardianActionPDA,
  getConstitutionPDA,
  getVaultAuthorityPDA,
  getTreasuryVaultPDA,
  getExecutionRequestPDA,
  getExecutionAuthorityPDA,
  getAssetConfigPDA,
  getTreasuryAssetPDA,
  getAssetVaultPDA,
  getStrategyPositionForMintPDA,
  getStrategyEscrowForMintPDA,
} from './pdaDerivation';
import type { TransactionBuildResult } from './transactionBuilders';

/** Mock-mode short circuit — useSendTransaction treats a null instruction as demo mode. */
function mock(programId: PublicKey): TransactionBuildResult {
  return {
    instruction: null,
    programId,
    error: 'Demo mode (VITE_USE_MOCKS=true) — no on-chain transaction built.',
  };
}

function toBN(n: number | bigint | string): BN {
  return new BN(n.toString());
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — Global config (protocol admin)
// ═══════════════════════════════════════════════════════════════════════════════

/** BPF Upgradeable Loader — owner of every upgradeable program's ProgramData. */
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

/**
 * initialize_global_config(formation_fee_lamports: u64) — one-time bootstrap.
 *
 * The contract now binds initialization to the program's deploy/upgrade
 * authority: `authority` MUST be the upgrade authority recorded in the program's
 * ProgramData account, and the instruction takes the `program` + `program_data`
 * accounts so the handler can verify that signer. `program_data` is the BPF
 * Upgradeable Loader PDA for nave_core (`PDA([program_id], BPFLoaderUpgradeable)`).
 */
export async function buildInitializeGlobalConfig(
  authority: PublicKey,
  treasury: PublicKey,
  formationFeeLamports: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [programData] = PublicKey.findProgramAddressSync(
    [NAVE_CORE_PROGRAM_ID.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  );

  const instruction = await core.methods
    .initializeGlobalConfig(toBN(formationFeeLamports))
    .accountsPartial({
      authority,
      treasury,
      globalConfig,
      program: NAVE_CORE_PROGRAM_ID,
      programData,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** update_global_config(paused: bool, formation_fee_lamports: u64) */
export async function buildUpdateGlobalConfig(
  authority: PublicKey,
  paused: boolean,
  formationFeeLamports: number | bigint,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();

  const instruction = await core.methods
    .updateGlobalConfig(paused, toBN(formationFeeLamports))
    .accountsPartial({ authority, globalConfig })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core — Agent-set administration (founder / guardian multisig)
// ═══════════════════════════════════════════════════════════════════════════════

/** update_agent_set(agent_authorities[4]) — founder, schedules +48h rotation. */
export async function buildUpdateAgentSet(
  daoPubkey: PublicKey,
  authority: PublicKey,
  agentAuthorities: PublicKey[],
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);

  const instruction = await core.methods
    .updateAgentSet(agentAuthorities)
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** apply_agent_rotation(role) — founder, after the 48h delay. */
export async function buildApplyAgentRotation(
  daoPubkey: PublicKey,
  authority: PublicKey,
  role: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);

  const instruction = await core.methods
    .applyAgentRotation(role)
    .accountsPartial({
      authority,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** toggle_agents(enabled=true) — executive agent RE-ENABLE only.
 *  Disabling agents requires guardian M-of-N via buildGuardianDisableAgents. */
export async function buildToggleAgents(
  daoPubkey: PublicKey,
  executiveAgent: PublicKey,
  enabled: boolean,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);

  const instruction = await core.methods
    .toggleAgents(enabled)
    .accountsPartial({
      authority: executiveAgent,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/**
 * guardian_disable_agents(action_nonce) — signed by a guardian wallet.
 * Accumulates guardian signatures (like emergency_freeze) and executes once the
 * threshold is reached. All signers must use the same `actionNonce`.
 * On-chain constant: GUARDIAN_ACTION_DISABLE_AGENTS = 4.
 */
export async function buildGuardianDisableAgents(
  daoPubkey: PublicKey,
  guardian: PublicKey,
  actionNonce: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [agentSet] = getAgentSetPDA(daoPubkey);
  // GUARDIAN_ACTION_DISABLE_AGENTS = 4
  const [guardianAction] = getGuardianActionPDA(daoPubkey, 4, actionNonce);

  const instruction = await core.methods
    .guardianDisableAgents(toBN(actionNonce))
    .accountsPartial({
      guardian,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      guardianAction,
      agentSet,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** nullify_agent(role, action_nonce) — guardian M-of-N (SOL-H2). */
export async function buildNullifyAgent(
  daoPubkey: PublicKey,
  guardian: PublicKey,
  role: number,
  actionNonce: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [guardianAction] = getGuardianActionPDA(daoPubkey, 5, actionNonce, [Buffer.from([role])]);

  const instruction = await core.methods
    .nullifyAgent(role, toBN(actionNonce))
    .accountsPartial({
      guardian,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      guardianAction,
      agentSet,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** restore_agent(role) — executive agent. */
export async function buildRestoreAgent(
  daoPubkey: PublicKey,
  executiveAgent: PublicKey,
  role: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);

  const instruction = await core.methods
    .restoreAgent(role)
    .accountsPartial({
      authority: executiveAgent,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** update_agent_status(agent_slot, new_status, action_nonce) — guardian multisig (action type 2). */
export async function buildUpdateAgentStatus(
  daoPubkey: PublicKey,
  guardian: PublicKey,
  agentSlot: number,
  newStatus: number,
  actionNonce: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [guardianAction] = getGuardianActionPDA(daoPubkey, 2, actionNonce, [
    Buffer.from([agentSlot]),
    Buffer.from([newStatus]),
  ]);

  const instruction = await core.methods
    .updateAgentStatus(agentSlot, newStatus, toBN(actionNonce))
    .accountsPartial({
      guardian,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      guardianAction,
      agentSet,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

/** rotate_agent_key(agent_slot, new_pubkey, action_nonce) — guardian multisig (action type 3). */
export async function buildRotateAgentKey(
  daoPubkey: PublicKey,
  guardian: PublicKey,
  agentSlot: number,
  newPubkey: PublicKey,
  actionNonce: number,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_CORE_PROGRAM_ID);
  const { core } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [guardianConfig] = getGuardianConfigPDA(daoPubkey);
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [guardianAction] = getGuardianActionPDA(daoPubkey, 3, actionNonce, [
    Buffer.from([agentSlot]),
    newPubkey.toBuffer(),
  ]);

  const instruction = await core.methods
    .rotateAgentKey(agentSlot, newPubkey, toBN(actionNonce))
    .accountsPartial({
      guardian,
      globalConfig,
      daoRegistry: daoPubkey,
      guardianConfig,
      guardianAction,
      agentSet,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, programId: NAVE_CORE_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_execution — Agent approval pipeline (agent-signed)
// ═══════════════════════════════════════════════════════════════════════════════

/** executive_approve(reasoning_hash) — Executive agent. */
export async function buildExecutiveApprove(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  executiveAgent: PublicKey,
  reasoningHash: number[],
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);
  const { execution } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);

  const instruction = await execution.methods
    .executiveApprove(reasoningHash)
    .accountsPartial({
      authority: executiveAgent,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
      executionRequest,
    })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

/** financial_approve(tx_payload_hash, reasoning_hash) — Financial agent. */
export async function buildFinancialApprove(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  financialAgent: PublicKey,
  txPayloadHash: number[],
  reasoningHash: number[],
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);
  const { execution } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);

  const instruction = await execution.methods
    .financialApprove(txPayloadHash, reasoningHash)
    .accountsPartial({
      authority: financialAgent,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
      executionRequest,
    })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

/** oversight_approve(tx_payload_hash, reasoning_hash) — Oversight agent. */
export async function buildOversightApprove(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  oversightAgent: PublicKey,
  txPayloadHash: number[],
  reasoningHash: number[],
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);
  const { execution } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);

  const instruction = await execution.methods
    .oversightApprove(txPayloadHash, reasoningHash)
    .accountsPartial({
      authority: oversightAgent,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
      executionRequest,
    })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

/** operational_halt(reason_hash) — Operational agent. */
export async function buildOperationalHalt(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  operationalAgent: PublicKey,
  reasonHash: number[],
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);
  const { execution } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);

  const instruction = await execution.methods
    .operationalHalt(reasonHash)
    .accountsPartial({
      authority: operationalAgent,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
      executionRequest,
    })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

/** operational_clear — Operational agent. Halted -> InReview. */
export async function buildOperationalClear(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  operationalAgent: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);
  const { execution } = getNavePrograms();
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);

  const instruction = await execution.methods
    .operationalClear()
    .accountsPartial({
      authority: operationalAgent,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
      executionRequest,
    })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_execution — Strategy execution (adapter CPI, server-submitted)
// ═══════════════════════════════════════════════════════════════════════════════

/** execute_strategy — any executor. CPI into the approved adapter, after review window. */
export async function buildExecuteStrategy(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  executor: PublicKey,
  protocolId: string,
  assetMint: PublicKey,
  priceUpdate?: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);
  const programs = getNavePrograms();
  const adapter = getAdapterProgram(protocolId, programs);
  if (!adapter) {
    return { instruction: null, programId: NAVE_EXECUTION_PROGRAM_ID, error: `Unknown protocol: ${protocolId}` };
  }
  const accounts = strategyExecutionAccounts(daoPubkey, proposalPubkey, protocolId, assetMint, adapter.programId, priceUpdate);

  const instruction = await programs.execution.methods
    .executeStrategy()
    .accountsPartial({ executor, ...accounts })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

/** execute_strategy_direct — Executive agent, only when DAO frozen OR agents disabled. */
export async function buildExecuteStrategyDirect(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  executiveAgent: PublicKey,
  protocolId: string,
  assetMint: PublicKey,
  priceUpdate?: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);
  const programs = getNavePrograms();
  const adapter = getAdapterProgram(protocolId, programs);
  if (!adapter) {
    return { instruction: null, programId: NAVE_EXECUTION_PROGRAM_ID, error: `Unknown protocol: ${protocolId}` };
  }
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const accounts = strategyExecutionAccounts(daoPubkey, proposalPubkey, protocolId, assetMint, adapter.programId, priceUpdate);

  const instruction = await programs.execution.methods
    .executeStrategyDirect()
    .accountsPartial({ authority: executiveAgent, agentSet, ...accounts })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

/** withdraw_from_strategy(amount) — executor, after Executed. CPI withdraw from adapter. */
export async function buildWithdrawFromStrategy(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  executor: PublicKey,
  protocolId: string,
  assetMint: PublicKey,
  amount: number | bigint,
  priceUpdate?: PublicKey,
): Promise<TransactionBuildResult> {
  if (USE_MOCKS) return mock(NAVE_EXECUTION_PROGRAM_ID);
  const programs = getNavePrograms();
  const adapter = getAdapterProgram(protocolId, programs);
  if (!adapter) {
    return { instruction: null, programId: NAVE_EXECUTION_PROGRAM_ID, error: `Unknown protocol: ${protocolId}` };
  }
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [agentSet] = getAgentSetPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);
  const [executionAuthority] = getExecutionAuthorityPDA(daoPubkey);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);
  const [assetConfig] = getAssetConfigPDA(daoPubkey, assetMint);
  const [treasuryAsset] = getTreasuryAssetPDA(daoPubkey, assetMint);
  const [strategyPosition] = getStrategyPositionForMintPDA(daoPubkey, protocolId, assetMint);
  const [vaultTokenAccount] = getAssetVaultPDA(daoPubkey, assetMint);
  const strategyEscrow = resolveStrategyEscrow(daoPubkey, protocolId, assetMint);

  const instruction = await programs.execution.methods
    .withdrawFromStrategy(toBN(amount))
    .accountsPartial({
      executor,
      globalConfig,
      daoRegistry: daoPubkey,
      agentSet,
      vaultAuthority,
      treasuryVault,
      mint: assetMint,
      assetConfig,
      treasuryAsset,
      priceUpdate: priceUpdate ?? assetMint,
      vaultTokenAccount,
      executionAuthority,
      adapterProgram: adapter.programId,
      executionRequest,
      strategyEscrow,
      strategyPosition,
      tokenProgram: TOKEN_PROGRAM_ID,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      naveCoreProgram: NAVE_CORE_PROGRAM_ID,
    })
    .instruction();

  return { instruction, programId: NAVE_EXECUTION_PROGRAM_ID };
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the strategy escrow token account (per (protocol, mint)). Distinct
 * escrow PDAs are enabled by default. Set VITE_ESCROW_PDA_ENABLED=false only for
 * legacy deployments where strategy_escrow == the asset holding account.
 */
function resolveStrategyEscrow(
  daoPubkey: PublicKey,
  protocolId: string,
  assetMint: PublicKey,
): PublicKey {
  const escrowOff = import.meta.env.VITE_ESCROW_PDA_ENABLED === 'false';
  if (!escrowOff) {
    return getStrategyEscrowForMintPDA(daoPubkey, protocolId, assetMint)[0];
  }
  return getAssetVaultPDA(daoPubkey, assetMint)[0];
}

/** Account set shared by execute_strategy and execute_strategy_direct. */
function strategyExecutionAccounts(
  daoPubkey: PublicKey,
  proposalPubkey: PublicKey,
  protocolId: string,
  assetMint: PublicKey,
  adapterProgram: PublicKey,
  priceUpdate?: PublicKey,
) {
  const [globalConfig] = getNaveGlobalConfigPDA();
  const [constitution] = getConstitutionPDA(daoPubkey);
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  const [treasuryVault] = getTreasuryVaultPDA(daoPubkey);
  const [executionAuthority] = getExecutionAuthorityPDA(daoPubkey);
  const [executionRequest] = getExecutionRequestPDA(proposalPubkey);
  const [assetConfig] = getAssetConfigPDA(daoPubkey, assetMint);
  const [treasuryAsset] = getTreasuryAssetPDA(daoPubkey, assetMint);
  const [strategyPosition] = getStrategyPositionForMintPDA(daoPubkey, protocolId, assetMint);
  const [vaultTokenAccount] = getAssetVaultPDA(daoPubkey, assetMint);
  const strategyEscrow = resolveStrategyEscrow(daoPubkey, protocolId, assetMint);

  return {
    globalConfig,
    daoRegistry: daoPubkey,
    constitution,
    vaultAuthority,
    treasuryVault,
    mint: assetMint,
    assetConfig,
    treasuryAsset,
    priceUpdate: priceUpdate ?? assetMint,
    vaultTokenAccount,
    executionAuthority,
    adapterProgram,
    executionRequest,
    strategyEscrow,
    strategyPosition,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    naveCoreProgram: NAVE_CORE_PROGRAM_ID,
  };
}
