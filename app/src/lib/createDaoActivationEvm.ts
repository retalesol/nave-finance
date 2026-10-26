// ─── Unified DAO creation — EVM auto-activation orchestration ─────────────────
// Runs the post-init activation phase of the EVM creation flow:
//
//   Tx 2: updateConstitution (approved adapters) + setPolicyParameters
//         → sent SEQUENTIALLY via sendEvm (unlike Solana's sendGrouped, EVM has
//           no atomic multi-instruction transaction, so each call is its own tx
//           and can independently succeed/fail/be rejected)
//   Then: revalueTreasury (best-effort)
//   Then: setAgentsEnabledViaProxyEvm (off-chain founder-gated proxy)
//
// Modelled after the Solana activation flow in createDaoActivation.ts, but with
// PER-STEP on-chain idempotency checks (not just an outer "already done" gate):
// because EVM steps are separate sequential transactions rather than one atomic
// Solana transaction, a retry after a partial failure (e.g. updateConstitution
// landed but the wallet rejected setPolicyParameters) must skip the step(s)
// that already landed on-chain, or it will double-submit them.

import { getBalance, readContract, sendTransaction } from '@wagmi/core';
import { getAddress, parseEther, type Address } from 'viem';
import { constitutionCapsBps, findVenue, strategyChainForEvmId } from '../../supabase/functions/_shared/strategyCatalog.ts';
import { rebalanceFreqToSecs, type PolicyState } from '../components/ConstitutionStep';
import {
  buildUpdateConstitutionEvm,
  buildSetPolicyParametersEvm,
  buildRevalueTreasuryEvm,
  type EvmBuildResult,
  type EvmConstitutionAdapter,
} from './evm/writers';
import { fetchConstitutionEvm, waitForEvmReceipt } from './evm/readers';
import { NaveProtocolAbi, NaveTreasuryAbi } from './evm/contracts';
import { getProtocolAddress, toAddress } from './evm/addresses';
import { wagmiConfig } from './evm/wagmi';
import { evmNativeGasSymbol, isEvmTestnet, type EvmChainId } from './chain/types';
import { getEvmAdapterAddress, SYSTEM_CONFIDENCE_THRESHOLD } from './programConfig';
import { setAgentsEnabledViaProxyEvm } from './edgeFunctionClient';

// Rough ETH/USD estimate for agentThresholdUsd derivation when no price feed
// is available at creation time.
const ESTIMATED_ETH_USD_PRICE = 3_500;

/** Per-adapter allocation cap when the policy carries no max lending exposure. */
const DEFAULT_ADAPTER_MAX_ALLOCATION_BPS = 5_000;

export interface EvmActivationContext {
  daoAddress: string;
  chainId: EvmChainId;
  /** Chain family label expected by agent-admin. */
  chain: 'ethereum' | 'base' | 'robinhood' | 'arc';
  founderAddress: string;
  policy: PolicyState;
  seedAmount: string;
  sendEvm: (
    results: EvmBuildResult | EvmBuildResult[],
    opts?: { successLabel?: string; quietMock?: boolean },
  ) => Promise<{ status: string; error: string | null }>;
  signMessage: (message: string) => Promise<string>;
  onStep: (label: string) => void;
  /** Executive agent EOA. Funded with a little native gas before the first enable. */
  executiveAddress?: string;
}

// ─── Resume detection helpers (EVM analogue of createDaoActivation.ts's Solana checks) ──

/** True once the constitution has at least one approved adapter (mirrors Solana's constitutionRatified). */
async function constitutionRatifiedEvm(chainId: EvmChainId, daoAddress: string): Promise<boolean> {
  const data = await fetchConstitutionEvm(chainId, daoAddress);
  return !!data && data.approvedProtocols.some((p) => p.approved);
}

interface EvmPolicyTarget {
  reserveBps: number;
  deployedBps: number;
  liquidityBps: number;
  rebalanceFreqSecs: number;
}

/** True when the on-chain policy already matches the wizard's target values exactly. */
async function policyParametersAppliedEvm(
  chainId: EvmChainId,
  daoAddress: string,
  target: EvmPolicyTarget,
): Promise<boolean> {
  const treasury = toAddress(daoAddress);
  if (!treasury) return false;
  try {
    const [policyBps, rebalanceFreq] = await Promise.all([
      readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'policyBps', chainId }),
      readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'rebalanceFrequencySecs', chainId }),
    ]);
    const [reserveBps, deployedBps, liquidityBps] = policyBps as readonly [number, number, number];
    return (
      Number(reserveBps) === target.reserveBps &&
      Number(deployedBps) === target.deployedBps &&
      Number(liquidityBps) === target.liquidityBps &&
      Number(rebalanceFreq as bigint) === target.rebalanceFreqSecs
    );
  } catch {
    return false;
  }
}

/** True once the treasury has recorded at least one revalue (`lastRevaluedAt > 0`). */
async function treasuryRevaluedEvm(chainId: EvmChainId, daoAddress: string): Promise<boolean> {
  const treasury = toAddress(daoAddress);
  if (!treasury) return false;
  try {
    const lastRevaluedAt = await readContract(wagmiConfig, {
      address: treasury, abi: NaveTreasuryAbi, functionName: 'lastRevaluedAt', chainId,
    });
    return Number(lastRevaluedAt as bigint) > 0;
  } catch {
    return false;
  }
}

/** True once the treasury's `agentsEnabled` flag is already set. */
async function agentsAreEnabledEvm(chainId: EvmChainId, daoAddress: string): Promise<boolean> {
  const treasury = toAddress(daoAddress);
  if (!treasury) return false;
  try {
    const enabled = await readContract(wagmiConfig, {
      address: treasury, abi: NaveTreasuryAbi, functionName: 'agentsEnabled', chainId,
    });
    return Boolean(enabled);
  } catch {
    return false;
  }
}

/**
 * Drop adapters the protocol has not approved, and keep one entry per address.
 * An unapproved address reverts `updateConstitution` after the treasury exists.
 * Two wizard ids can share one contract (Robinhood Aave and Morpho); listing
 * that address twice would count its cap twice.
 */
export async function keepProtocolApprovedAdapters(
  chainId: EvmChainId,
  adapters: EvmConstitutionAdapter[],
): Promise<EvmConstitutionAdapter[]> {
  const protocol = getProtocolAddress(chainId);
  const seen = new Set<string>();
  const kept: EvmConstitutionAdapter[] = [];
  for (const entry of adapters) {
    let adapter: Address;
    try {
      adapter = getAddress(entry.adapter);
    } catch {
      continue;
    }
    const key = adapter.toLowerCase();
    if (seen.has(key)) continue;
    if (!protocol) continue;
    try {
      const approved = await readContract(wagmiConfig, {
        address: protocol,
        abi: NaveProtocolAbi,
        functionName: 'isApprovedAdapter',
        args: [adapter],
        chainId,
      });
      if (!approved) continue;
    } catch {
      continue;
    }
    seen.add(key);
    kept.push({ ...entry, adapter });
  }
  return kept;
}

/**
 * Run EVM post-creation activation (Tx 2 + agent-enable).
 * Returns `{ ok: true }` when all critical steps succeed; agent-enable failures
 * are non-fatal and reported in `agentError`.
 *
 * Every step is idempotent + resumable: each `isDone` check reads on-chain
 * state so a partially-completed flow (e.g. a wallet rejection between
 * updateConstitution and setPolicyParameters) can be re-run and skips the
 * steps that already landed — mirrors createDaoActivation.ts's Solana pattern.
 */
export async function runEvmActivation(
  ctx: EvmActivationContext,
): Promise<{ ok: boolean; error?: string; agentError?: string }> {
  const { daoAddress, chainId, founderAddress, policy, seedAmount, sendEvm, onStep } = ctx;

  // ── Tx 2: Update constitution + set policy parameters (idempotent) ────────
  onStep('Sign Tx 2 of 2 — Activate & Ratify');

  // Build the approved adapter list from the wizard's policy.approvedProtocols,
  // each capped at the preset's per-venue limit.
  const maxAllocationBps = Number.isFinite(policy.maxLending) && policy.maxLending > 0
    ? Math.round(policy.maxLending * 100)
    : DEFAULT_ADAPTER_MAX_ALLOCATION_BPS;
  const strategyChain = strategyChainForEvmId(chainId);
  const enabledIds = Object.entries(policy.approvedProtocols)
    .filter(([, enabled]) => enabled)
    .map(([protocolId]) => protocolId);
  // NaveProtocol holds each adapter's tier; the per-venue caps here keep every
  // tier's approved total inside its on-chain ceiling.
  const capsBps = constitutionCapsBps(
    enabledIds.map((id) => ({ id, tier: (strategyChain && findVenue(strategyChain, id)?.tier) || 1 })),
    maxAllocationBps / 100,
  );
  const requested: EvmConstitutionAdapter[] = enabledIds.flatMap((protocolId) => {
    const addr = getEvmAdapterAddress(chainId, protocolId as Parameters<typeof getEvmAdapterAddress>[1]);
    if (!addr) return [];
    return [{
      adapter: addr,
      maxAllocationBps: capsBps.get(protocolId) ?? maxAllocationBps,
      approved: true,
      protocolId,
    }];
  });
  const adapters = await keepProtocolApprovedAdapters(chainId, requested);

  // agentThresholdUsd is micro-USD, the same unit as currentNav. A missing
  // seed must not write 0, which disables the gate. Arc seeds are denominated
  // in USDC ($1) rather than ETH.
  const seedNum = parseFloat(seedAmount);
  const isArc = (chainId as number) === 5042002 || (chainId as number) === 5042;
  const seedUsdPrice = isArc ? 1 : ESTIMATED_ETH_USD_PRICE;
  const agentThresholdUsd =
    !isNaN(seedNum) && seedNum > 0
      ? Math.round(seedNum * seedUsdPrice * 1_000_000)
      : 100_000_000;

  const policyTarget: EvmPolicyTarget = {
    reserveBps: Math.round(policy.minStablecoin * 100),
    deployedBps: Math.round(policy.maxDeployment * 100),
    liquidityBps: Math.round(policy.liquidityReserve * 100),
    rebalanceFreqSecs: rebalanceFreqToSecs(policy.rebalanceFreq),
  };

  // Check EACH step independently — unlike Solana's single atomic transaction,
  // sendEvm submits these SEQUENTIALLY as separate txs, so a retry must only
  // resend whichever ones did not already land.
  const [constitutionDone, policyDone] = await Promise.all([
    constitutionRatifiedEvm(chainId, daoAddress),
    policyParametersAppliedEvm(chainId, daoAddress, policyTarget),
  ]);

  const pendingTx2: EvmBuildResult[] = [];
  if (!constitutionDone && adapters.length > 0) {
    pendingTx2.push(buildUpdateConstitutionEvm(chainId, daoAddress, adapters, SYSTEM_CONFIDENCE_THRESHOLD, agentThresholdUsd));
  }
  if (!policyDone) {
    pendingTx2.push(buildSetPolicyParametersEvm(
      chainId,
      daoAddress,
      policyTarget.reserveBps,
      policyTarget.deployedBps,
      policyTarget.liquidityBps,
      policyTarget.rebalanceFreqSecs,
    ));
  }

  if (pendingTx2.length > 0) {
    const activationResult = await sendEvm(pendingTx2, {
      successLabel: 'Constitution ratified',
      quietMock: true,
    });

    if (activationResult.status !== 'success' && activationResult.status !== 'mock') {
      return {
        ok: false,
        error: activationResult.error ?? 'Constitution update failed',
      };
    }
  }

  // Revalue is best-effort AND idempotent-checked: skip re-sending (and the
  // extra wallet prompt) once the treasury has already recorded a revalue.
  if (!(await treasuryRevaluedEvm(chainId, daoAddress))) {
    await sendEvm(buildRevalueTreasuryEvm(chainId, daoAddress), {
      successLabel: 'Revalued treasury NAV',
      quietMock: true,
    });
  }

  // ── Enable agents (off-chain, non-fatal, idempotent) ───────────────────────
  onStep('Starting agents…');
  if (await agentsAreEnabledEvm(chainId, daoAddress)) {
    return { ok: true };
  }
  try {
    const executive = toAddress(ctx.executiveAddress);
    if (executive) await fundExecutiveGas(chainId, executive);
    const chain = ctx.chain;
    const { error: agentError } = await setAgentsEnabledViaProxyEvm(
      daoAddress,
      founderAddress,
      ctx.signMessage,
      true,
      chainId,
      chain,
    );
    if (agentError) {
      // Non-fatal: treasury is ratified; the founder can start agents later
      // from Settings. Do not fail the whole flow.
      return { ok: true, agentError };
    }
  } catch (err) {
    return {
      ok: true,
      agentError: err instanceof Error ? err.message : 'Agent start failed',
    };
  }

  return { ok: true };
}

/**
 * The executive EOA is created with a zero balance, so the first
 * `toggleAgents` reverts until someone pays its gas. On testnets the founder
 * sends a small stipend. Arc's stipend is 18-decimal native USDC.
 */
export async function fundExecutiveGas(chainId: EvmChainId, executive: Address): Promise<void> {
  if (!isEvmTestnet(chainId)) return;
  const floor = chainId === 5042002 ? parseEther('0.02') : parseEther('0.001');
  const balance = await getBalance(wagmiConfig, { address: executive, chainId });
  if (balance.value >= floor) return;
  const symbol = evmNativeGasSymbol(chainId);
  const hash = await sendTransaction(wagmiConfig, {
    to: executive,
    value: floor - balance.value,
    chainId,
  });
  const receipt = await waitForEvmReceipt(chainId, hash);
  if (receipt.status !== 'success') {
    throw new Error(`Funding the executive agent with ${symbol} for gas failed.`);
  }
}
