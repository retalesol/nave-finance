// ─── Unified DAO creation — Solana auto-activation orchestration ──────────────
// Runs the post-init activation phase of the unified creation flow:
//
//   1. Seed & Ratify — register wSOL asset + wrap/seed + update_constitution
//                      (approve Jito) + set_policy_parameters, all in one
//                      grouped transaction. Optional revalue follows if a
//                      Pyth price account is configured (best-effort, never
//                      blocks success).
//   2. Agents        — off-chain proxy call to flip agents_enabled on-chain.
//
// Every step is idempotent + resumable: each `isDone` check reads on-chain
// state so a partially-completed flow (e.g. a wallet rejection mid-way) can
// be re-run and skips the steps that already landed.

import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { getNavePrograms } from './naveProgram';
import {
  getConstitutionPDA,
  getAssetConfigPDA,
  getTreasuryAssetPDA,
  getAgentSetPDA,
} from './pdaDerivation';
import {
  buildSeedTreasuryWsol,
  buildUpdateConstitution,
  buildSetPolicyParameters,
  WSOL_MINT,
  type TransactionBuildResult,
} from './transactionBuilders';
import { NAVE_JITO_ADAPTER_ID, SOL_USD_PRICE_UPDATE, SYSTEM_CONFIDENCE_THRESHOLD, getAdapterProgramId } from './programConfig';

/** Rough SOL/USD estimate used when Pyth price data is unavailable. */
const ESTIMATED_SOL_USD_PRICE = 150;

// ─── Step model ───────────────────────────────────────────────────────────────

export type ActivationStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface ActivationStep {
  id: string;
  label: string;
  status: ActivationStepStatus;
  detail?: string;
}

export const ACTIVATION_STEP_IDS = ['seedAndRatify', 'agents'] as const;
export type ActivationStepId = (typeof ACTIVATION_STEP_IDS)[number];

export const ACTIVATION_STEP_LABELS: Record<ActivationStepId, string> = {
  seedAndRatify: 'Seed & ratify constitution',
  agents: 'Start agents',
};

export function initialActivationSteps(): ActivationStep[] {
  return ACTIVATION_STEP_IDS.map((id) => ({
    id,
    label: ACTIVATION_STEP_LABELS[id],
    status: 'pending' as ActivationStepStatus,
  }));
}

// ─── Default Jito ratification parameters (SOL-native, no swap dependency) ─────
// Approve the Jito liquid-staking adapter so the SOL-seeded treasury has a
// compatible (SolLike) deploy target immediately. Policy is conservative:
// the stablecoin reserve floor is left UNSET (0) because a freshly SOL-seeded
// treasury holds no stablecoin; the 50% deployment cap + 20% liquidity floor
// still bound how much the agents can deploy.
export const DEFAULT_JITO_MAX_ALLOCATION_BPS = 5_000; // 50%
export const DEFAULT_CONFIDENCE_THRESHOLD = SYSTEM_CONFIDENCE_THRESHOLD;
export const DEFAULT_MIN_STABLECOIN_RESERVE_BPS = 0; // unset — SOL-seeded treasury
export const DEFAULT_MAX_TOTAL_DEPLOYED_BPS = 5_000; // 50%
export const DEFAULT_MIN_LIQUIDITY_BPS = 2_000; // 20%
export const DEFAULT_REBALANCE_FREQUENCY_SECS = 30 * 86_400; // 30 days

// ─── Executor contract (provided by the React tx hook) ─────────────────────────

interface TxOutcome {
  status: 'idle' | 'signing' | 'confirming' | 'success' | 'error' | 'mock';
  error: string | null;
}

/** Protocol entry from the wizard's approved-protocols state. */
export interface ConstitutionProtocolInput {
  id: string;
}

/** Policy parameter overrides from the wizard (UI percent values → BPS). */
export interface WizardPolicyParams {
  minStablecoinReserveBps: number;
  maxTotalDeployedBps: number;
  minLiquidityBps: number;
  rebalanceFrequencySecs: number;
  confidenceThreshold: number;
}

export interface ActivationContext {
  connection: Connection;
  daoRegistry: PublicKey;
  founder: PublicKey;
  /** 'wallet' or 'token' */
  governanceType: 'wallet' | 'token';
  /** Mint account passed to create_proposal (the vault mint; wSOL for wallet gov). */
  daoTokenMint: PublicKey;
  /** Number of guardian wallets. */
  guardianWalletCount: number;
  /** Treasury-seed amount in lamports. */
  seedLamports: number;
  /**
   * Optional agent deployment threshold in micro-USD (USD × 1_000_000).
   * When omitted, the activation derives it from the post-revalue NAV, or
   * falls back to estimating from seedLamports × ESTIMATED_SOL_USD_PRICE.
   */
  agentThresholdUsdMicro?: number;
  /**
   * Protocol approvals from the wizard. When omitted, falls back to
   * Jito-only (the legacy default).
   */
  constitutionProtocols?: ConstitutionProtocolInput[];
  /**
   * Policy parameter overrides from the wizard. When omitted, uses the
   * conservative defaults.
   */
  policyParams?: WizardPolicyParams;
  send: (
    r: TransactionBuildResult,
    opts?: { successLabel?: string; quietMock?: boolean },
  ) => Promise<TxOutcome>;
  sendGrouped: (
    groups: TransactionBuildResult[][],
    opts?: { successLabel?: string; quietMock?: boolean },
  ) => Promise<TxOutcome>;
  /** Wraps setAgentsEnabledViaProxy — flips the on-chain agents_enabled flag. */
  setAgentsEnabled: (enabled: boolean) => Promise<{ error: string | null }>;
  onStep: (id: ActivationStepId, status: ActivationStepStatus, detail?: string) => void;
}

function ok(o: TxOutcome): boolean {
  return o.status === 'success' || o.status === 'mock';
}

// ─── Resume detection helpers ──────────────────────────────────────────────────

async function wsolAssetRegistered(connection: Connection, dao: PublicKey): Promise<boolean> {
  const { core } = getNavePrograms(connection);
  const [assetConfig] = getAssetConfigPDA(dao, WSOL_MINT);
  const acc = await core.account.assetConfig.fetchNullable(assetConfig);
  return acc !== null;
}

async function wsolSeedDeposited(connection: Connection, dao: PublicKey): Promise<boolean> {
  const { core } = getNavePrograms(connection);
  const [treasuryAsset] = getTreasuryAssetPDA(dao, WSOL_MINT);
  const acc = await core.account.treasuryAsset.fetchNullable(treasuryAsset);
  if (!acc) return false;
  const deposited = (acc as { deposited?: { toString(): string } }).deposited;
  return deposited != null && BigInt(deposited.toString()) > 0n;
}

/**
 * Check if the constitution has been ratified with at least one approved protocol.
 * Renamed from jitoRatified; now checks any approved protocol (not just Jito).
 */
async function constitutionRatified(connection: Connection, dao: PublicKey): Promise<boolean> {
  const { core } = getNavePrograms(connection);
  const [constitution] = getConstitutionPDA(dao);
  const acc = await core.account.treasuryConstitution.fetchNullable(constitution);
  if (!acc) return false;
  const protocols = (acc.protocols as Array<{ programId: { toString(): string }; approved: boolean }>)
    .slice(0, (acc as { protocolCount: number }).protocolCount);
  return protocols.some((p) => p.approved);
}

async function agentsAreEnabled(connection: Connection, dao: PublicKey): Promise<boolean> {
  const { core } = getNavePrograms(connection);
  const [agentSet] = getAgentSetPDA(dao);
  const acc = await core.account.agentSet.fetchNullable(agentSet);
  return acc !== null && Boolean((acc as { agentsEnabled?: boolean }).agentsEnabled);
}

// ─── Orchestrator ───────────────────────────────────────────────────────────────

/**
 * Run the Solana auto-activation phases. Returns `{ ok }`: `ok=false` means a
 * REQUIRED phase failed (treasury was created but is not fully activated — the
 * user can re-run to resume). Best-effort phases (revalue, agent start) never
 * flip `ok` to false; they surface as `skipped`/`error` step details so the
 * treasury remains fully usable even when auto-activation is only partial.
 */
export async function runSolanaAutoActivation(
  ctx: ActivationContext,
): Promise<{ ok: boolean; error?: string }> {
  const { connection, daoRegistry: dao, founder } = ctx;

  // ── Step 1/2: Seed treasury + Ratify constitution (single grouped tx) ────────
  // register_asset → deposit_to_asset → update_constitution → set_policy_parameters
  // are batched into one wallet signature. The revalue instruction (optional,
  // best-effort) is sent in a separate call immediately after if configured.
  ctx.onStep('seedAndRatify', 'running');
  try {
    const solUsdPriceUpdate = SOL_USD_PRICE_UPDATE ? new PublicKey(SOL_USD_PRICE_UPDATE) : undefined;
    const { register, deposit, revalue } = await buildSeedTreasuryWsol(
      dao,
      founder,
      ctx.seedLamports,
      solUsdPriceUpdate,
    );

    // Idempotency: only skip when BOTH wSOL is seeded and constitution is ratified.
    // Using constitutionRatified alone would wrongly skip register/deposit if an
    // older partial run ratified without seeding.
    if ((await wsolSeedDeposited(connection, dao)) && (await constitutionRatified(connection, dao))) {
      ctx.onStep('seedAndRatify', 'done', 'Already completed');
    } else {
      // Build the protocol list from wizard selection, or fall back to Jito-only.
      const wizardProtocols = ctx.constitutionProtocols && ctx.constitutionProtocols.length > 0
        ? ctx.constitutionProtocols
        : [{ id: 'jito' }];

      const protocolEntries = wizardProtocols.map((p) => {
        const programId = p.id === 'jito' ? NAVE_JITO_ADAPTER_ID : getAdapterProgramId(p.id);
        return {
          protocolId: p.id,
          programId: programId ?? NAVE_JITO_ADAPTER_ID,
          maxAllocationBps: DEFAULT_JITO_MAX_ALLOCATION_BPS,
          approved: true,
        };
      });

      const policy = ctx.policyParams;
      const confidenceThreshold = policy?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

      // Derive agentThresholdUsdMicro: use explicit value, or estimate from seed.
      const agentThresholdUsdMicro =
        ctx.agentThresholdUsdMicro ??
        Math.round((ctx.seedLamports / 1e9) * ESTIMATED_SOL_USD_PRICE * 1_000_000);

      const updateConstitution = await buildUpdateConstitution(
        dao,
        founder,
        protocolEntries,
        confidenceThreshold,
        agentThresholdUsdMicro,
      );
      const setPolicy = await buildSetPolicyParameters(
        dao,
        founder,
        policy?.minStablecoinReserveBps ?? DEFAULT_MIN_STABLECOIN_RESERVE_BPS,
        policy?.maxTotalDeployedBps ?? DEFAULT_MAX_TOTAL_DEPLOYED_BPS,
        policy?.minLiquidityBps ?? DEFAULT_MIN_LIQUIDITY_BPS,
        policy?.rebalanceFrequencySecs ?? DEFAULT_REBALANCE_FREQUENCY_SECS,
      );

      // Build the instruction list. If wSOL is already registered/deposited, skip
      // those instructions so we only retry the remaining ones within this group.
      const alreadyRegistered = await wsolAssetRegistered(connection, dao);
      const alreadyDeposited = await wsolSeedDeposited(connection, dao);

      const group: TransactionBuildResult[] = [
        ...(alreadyRegistered ? [] : [register]),
        ...(alreadyDeposited ? [] : [deposit]),
        updateConstitution,
        setPolicy,
      ];

      const r = await ctx.sendGrouped([group], {
        successLabel: 'Treasury seeded and constitution ratified',
        quietMock: true,
      });
      if (!ok(r)) {
        ctx.onStep('seedAndRatify', 'error', r.error ?? 'Seed & ratify failed');
        return { ok: false, error: r.error ?? 'Seed & ratify failed' };
      }
      ctx.onStep('seedAndRatify', 'done');
    }

    // Revalue is best-effort: needs a fresh posted Pyth price account
    // (VITE_SOL_USD_PRICE_UPDATE). Never block treasury creation on it.
    if (revalue && revalue.instruction) {
      await ctx.send(revalue, { successLabel: 'Revalued treasury NAV', quietMock: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Seed & ratify failed';
    ctx.onStep('seedAndRatify', 'error', msg);
    return { ok: false, error: msg };
  }

  // ── Step 2/2: Start agents (off-chain founder-gated proxy) ──────────────────
  ctx.onStep('agents', 'running');
  try {
    if (await agentsAreEnabled(connection, dao)) {
      ctx.onStep('agents', 'done', 'Already enabled');
    } else {
      const { error } = await ctx.setAgentsEnabled(true);
      if (error) {
        // Non-fatal: the treasury is created + seeded + ratified; the founder can
        // start agents later from Settings. Do not block the flow.
        ctx.onStep('agents', 'error', error);
      } else {
        ctx.onStep('agents', 'done');
      }
    }
  } catch (err) {
    ctx.onStep('agents', 'error', err instanceof Error ? err.message : 'Agent start failed');
  }

  return { ok: true };
}
