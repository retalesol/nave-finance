// Canonical agent context contract (Phase 7).
//
// This is the single, typed definition of the context a Nave treasury agent
// reasons over, plus deterministic helpers (snapshot age, canonical reasoning
// serialization, reasoning hash). Keeping the shape explicit lets us:
//   - feed a stable, versioned context to the model,
//   - run deterministic guardrails over the same fields (see guardrails.ts),
//   - build eval fixtures that exactly mirror production inputs,
//   - detect log/on-chain reasoning-hash drift.
//
// Dependency-free; uses Web Crypto (available in Deno and Node 18+).

import type { GenlayerView } from "./genlayerCharter.ts";

export const AGENT_CONTEXT_VERSION = "1.1.0";

export type AgentRole = "executive" | "financial" | "oversight" | "operational";

/** Risk parameters sourced from the on-chain constitution / dao_registry. */
export interface RiskParams {
  /** Max single-strategy allocation, basis points of NAV. */
  maxSingleAllocationBps?: number;
  /** Max total deployed across ALL strategies, basis points of NAV. */
  maxTotalDeployedBps?: number;
  /** Min reserve floor, basis points of NAV (legacy alias of liquidity floor). */
  minReservesBps?: number;
  /** Continuous policy: stablecoin reserve floor, basis points of NAV. */
  minStablecoinReserveBps?: number;
  /** Continuous policy: immediate-liquidity floor, basis points of NAV. */
  minLiquidityBps?: number;
  /** Continuous policy: rebalance cadence in seconds (0/undefined = unset). */
  rebalanceFrequencySecs?: number;
  /** Unix seconds of the last completed rebalance (for cadence eligibility). */
  lastRebalanceAt?: number;
  /** Minimum model confidence required to sign (0-100). */
  confidenceThreshold: number;
}

export interface TreasurySnapshotView {
  totalValueUsd: number | null;
  solBalance: number | null;
  usdcBalance: number | null;
  /** ISO timestamp of the snapshot. */
  snapshotAt: string | null;
  strategyPositions: Array<Record<string, unknown>>;
  /**
   * On-chain net asset value in token base units (treasury_vault.current_nav).
   * When present, the allocation-cap check uses this instead of the USD value so
   * NAV and the request amount are compared in the SAME units (both base units).
   */
  navBaseUnits?: number | null;
  /**
   * On-chain capital already deployed to strategies in base units
   * (treasury_vault.deployed_capital). Preferred over summing snapshot positions
   * for the cumulative cap check.
   */
  deployedBaseUnits?: number | null;
  /**
   * Stablecoin holdings in base units, when measurable. `null`/undefined means
   * the reserve composition is unknown (single-mint vault model) — the reserve
   * guardrail then surfaces a warning rather than hard-blocking.
   */
  stablecoinBaseUnits?: number | null;
  /**
   * Unix seconds the on-chain NAV was last revalued
   * (treasury_vault.last_revalued_at). `undefined`/`null` means the freshness
   * signal is unavailable (field not yet exposed on-chain) — the NAV freshness
   * guardrail then treats it as not-applicable rather than stale.
   */
  navLastRevaluedAt?: number | null;
}

export interface ExecutionRequestView {
  address: string;
  actionType: string;
  /** Protocol the request targets, when applicable. */
  protocolId?: string | null;
  /**
   * Raw adapter program id (base58) the request targets, when applicable. Used
   * by the protocol-allowlist guardrail to fail-closed when a program is present
   * but maps to no known/allowlisted `protocolId` (unmapped adapter).
   */
  protocolProgram?: string | null;
  /** Hash the on-chain request is bound to (from the proposal payload). */
  expectedPayloadHash?: string | null;
  /** Base-unit amount the request would move, when known. */
  amount?: number | null;
  /**
   * Base-unit deployed value already held in the request's TARGET protocol
   * (StrategyPosition.current_value for that protocol). Used by the per-protocol
   * allocation cap so it compares target-protocol deployed (not vault-wide
   * deployed) against the per-protocol cap. `null`/`undefined` falls back to the
   * vault-wide deployed figure for legacy contexts.
   */
  targetProtocolDeployedBaseUnits?: number | null;
}

export interface PriorAgentAction {
  agentRole: string;
  actionType: string;
  decision: string | null;
  status: string | null;
  reasoning: string | null;
}

/** The full, versioned context handed to an agent for one decision. */
export interface AgentContext {
  version: string;
  daoAddress: string;
  daoName: string;
  governanceType: string;
  role: AgentRole;
  request: ExecutionRequestView;
  treasury: TreasurySnapshotView;
  /** Protocols approved by the constitution (allowlist). Empty = unknown. */
  approvedProtocols: string[];
  riskParams: RiskParams;
  /**
   * Policy-engine intent for this cycle. When `requireCompleteConstitution` is
   * set, a `"rebalance"` intent applies the rebalance cadence even if the
   * action name does not contain "rebalance".
   */
  policyIntent?: "rebalance" | "deploy_idle" | "reduce_exposure" | "hold";
  /**
   * On-chain agent pause/freeze state (DaoRegistry.frozen +
   * AgentSet/DaoRegistry.agents_enabled). Optional and absent in legacy
   * contexts/fixtures; the `agents_enabled` guardrail only blocks when this is
   * explicitly present AND frozen/disabled (see guardrails.ts). A flag is `null`
   * when it could not be read from chain.
   */
  gate?: { agentsEnabled: boolean | null; frozen: boolean | null };
  priorActions: PriorAgentAction[];
  recentActivity: Array<Record<string, unknown>>;
  /** Server time the context was assembled (ISO). */
  assembledAt: string;
  /**
   * Independent charter / venue / halt review for this treasury and action.
   * Absent in legacy contexts. Signing uses it only when the matching flag is on.
   */
  genlayer?: GenlayerView;
}

/** Age of the treasury snapshot in seconds, or null when no snapshot exists. */
export function snapshotAgeSeconds(
  ctx: Pick<AgentContext, "treasury" | "assembledAt">,
): number | null {
  const at = ctx.treasury.snapshotAt;
  if (!at) return null;
  const snap = Date.parse(at);
  const now = Date.parse(ctx.assembledAt);
  if (Number.isNaN(snap) || Number.isNaN(now)) return null;
  return Math.max(0, Math.floor((now - snap) / 1000));
}

/**
 * Canonical, stable serialization of the reasoning artifacts that get
 * committed on-chain. Order-stable so the same decision always hashes the same.
 */
export function canonicalReasoning(input: {
  daoAddress: string;
  role: AgentRole;
  executionRequestAddress: string;
  decision: string;
  confidence: number;
  payloadHash: string;
  riskFlags: string[];
  reasoningSummary: string;
}): string {
  return JSON.stringify({
    v: AGENT_CONTEXT_VERSION,
    dao: input.daoAddress,
    role: input.role,
    er: input.executionRequestAddress,
    decision: input.decision,
    confidence: input.confidence,
    payload_hash: input.payloadHash || "",
    risk_flags: [...(input.riskFlags || [])].sort(),
    reasoning: input.reasoningSummary || "",
  });
}

/** Hex-encoded SHA-256 of the canonical reasoning string. */
export async function computeReasoningHash(canonical: string): Promise<string> {
  const data = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
