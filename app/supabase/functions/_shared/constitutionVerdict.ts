// One constitution verdict before any capital signature.
//
// callSigner asks this module whether a payload may reach the signer. Capital
// actions load the on-chain constitution (Solana or EVM), run evaluateGuardrails
// in live-treasury mode, and are refused when a critical check fails or is
// indeterminate. Accounting ticks are allowed while agents are paused and move
// no value. clear_halt needs a readable open gate and a fresh constitution read.

import {
  AGENT_CONTEXT_VERSION,
  type AgentContext,
  type AgentRole,
} from "./agentContext.ts";
import {
  classifyAction,
  type ActionClass,
} from "./constitutionLog.ts";
import {
  isEvmPolicyChain,
  readEvmConstitution,
  readEvmStrategyPositions,
  readEvmTreasuryVault,
} from "./evmPolicy.ts";
import { readEvmAgentGate } from "./evmExecution.ts";
import {
  evaluateGuardrails,
  type CheckResult,
  type GuardrailVerdict,
} from "./guardrails.ts";
import {
  NAVE_GENLAYER_GATE,
  NAVE_GENLAYER_HALT_GATE,
  NAVE_GENLAYER_VENUE_GATE,
  type GenlayerView,
  chainFamilyFrom,
  haltGateOutcome,
  networkForSigner,
  readGenlayerFlag,
} from "./genlayerCharter.ts";
import { fetchGenlayerView } from "./genlayerStore.ts";
import {
  listRegisteredMints,
  readAgentGate,
  readConstitution,
  readStrategyPositions,
  readTreasuryVault,
  type ApprovedProtocol,
  type ConstitutionView,
  type VaultView,
} from "./onchain.ts";
import { computeDrift, type PolicyParams } from "./policy.ts";

export interface SignerVerdictInput {
  action: string;
  dao_address: string;
  execution_request_address?: string;
  agent_role: AgentRole;
  protocol_id?: string;
  amount?: number | string;
  mint?: string;
  bundle_operations?: Array<{
    action: string;
    mint?: string;
    amount?: number | string;
    protocol_id?: string;
    expected_payload_hash?: string;
    payload_hash?: string;
    confidence?: number;
    execution_request_address?: string;
    purpose?: "venue_placement";
  }>;
  chain?: string;
  chain_id?: number;
  min_out?: number | string;
  confidence?: number;
  expected_payload_hash?: string;
  payload_hash?: string;
  purpose?: "compound" | "auto_withdraw" | "venue_placement" | "venue_recall";
  policy_intent?: "rebalance" | "deploy_idle" | "reduce_exposure" | "hold";
  /** Stored charter / venue / halt review. Loaded when omitted. */
  genlayer?: GenlayerView;
}

export interface SignerVerdict {
  /** When false, callSigner must not contact the signer. */
  allow: boolean;
  reason: string;
  record: Record<string, unknown>;
}

interface ChainState {
  constitution: ConstitutionView | null;
  vault: VaultView | null;
  gate: { agentsEnabled: boolean | null; frozen: boolean | null } | null;
  targetDeployed?: number;
}

function envFlag(name: string): boolean {
  try {
    return (Deno.env.get(name) ?? "false").toLowerCase() === "true";
  } catch {
    return false;
  }
}

function envNum(name: string, fallback = 0): number {
  try {
    const n = Number(Deno.env.get(name) ?? String(fallback));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function asFinite(value: number | string | undefined | null): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function check(
  id: CheckResult["id"],
  ok: boolean,
  detail: string,
  indeterminate = false,
): CheckResult {
  return { id, ok, indeterminate, severity: "critical", detail };
}

function failureRecord(action: string, detail: string, actionClass?: ActionClass): Record<string, unknown> {
  const klass = actionClass ?? classifyAction(action);
  return {
    action_class: klass,
    action,
    pass: false,
    should_sign: false,
    checks: [check("snapshot_freshness", false, detail, true)],
    failures: [detail],
  };
}

function isEvmPayload(input: SignerVerdictInput): boolean {
  if (isEvmPolicyChain(input.chain)) return true;
  return typeof input.chain_id === "number" && Number.isFinite(input.chain_id);
}

async function loadChainState(input: SignerVerdictInput, protocolId?: string): Promise<ChainState> {
  if (isEvmPayload(input)) {
    const chainId = input.chain_id;
    if (chainId == null) return { constitution: null, vault: null, gate: null };
    const [constitution, vault, gate] = await Promise.all([
      readEvmConstitution(chainId, input.dao_address),
      readEvmTreasuryVault(chainId, input.dao_address),
      readEvmAgentGate(chainId, input.dao_address),
    ]);
    let targetDeployed: number | undefined;
    if (constitution && protocolId) {
      const positions = await readEvmStrategyPositions(
        chainId,
        input.dao_address,
        constitution.approvedProtocols.map((p) => ({
          protocolId: p.protocolId,
          programId: p.programId,
        })),
      );
      const key = protocolId.toLowerCase();
      const pos = positions.find((p) => p.protocolId.toLowerCase() === key);
      if (pos && pos.mint) targetDeployed = pos.currentValueBaseUnits;
    }
    return { constitution, vault, gate, targetDeployed };
  }

  let rpc = "";
  try {
    rpc = Deno.env.get("SOLANA_RPC_URL") ?? "";
  } catch {
    rpc = "";
  }
  if (!rpc) return { constitution: null, vault: null, gate: null };
  const [constitution, vault, gate] = await Promise.all([
    readConstitution(rpc, input.dao_address),
    readTreasuryVault(rpc, input.dao_address),
    readAgentGate(rpc, input.dao_address),
  ]);
  let targetDeployed: number | undefined;
  if (protocolId) {
    const mints = await listRegisteredMints(rpc, input.dao_address);
    const positions = await readStrategyPositions(rpc, input.dao_address, [protocolId], mints);
    const measured = positions.filter((p) => p.mint);
    if (measured.length > 0) {
      targetDeployed = measured.reduce((sum, p) => sum + p.currentValueBaseUnits, 0);
    }
  }
  return { constitution, vault, gate, targetDeployed };
}

function policyOf(constitution: ConstitutionView): PolicyParams {
  return {
    minStablecoinReserveBps: constitution.minStablecoinReserveBps,
    maxTotalDeployedBps: constitution.maxTotalDeployedBps,
    minLiquidityBps: constitution.minLiquidityBps,
    rebalanceFrequencySecs: constitution.rebalanceFrequencySecs,
    lastRebalanceAt: constitution.lastRebalanceAt,
    confidenceThreshold: constitution.confidenceThreshold,
  };
}

function venueApproved(approved: ApprovedProtocol[], protocolId: string | undefined): boolean {
  const key = (protocolId ?? "").toLowerCase();
  if (!key) return false;
  return approved.some(
    (p) =>
      p.approved &&
      (p.protocolId.toLowerCase() === key || p.programId.toLowerCase() === key),
  );
}

function withdrawRepairs(args: {
  dao: string;
  nav: number;
  deployed: number;
  amount: number;
  policy: PolicyParams;
  protocolId: string | undefined;
  approved: ApprovedProtocol[];
  nowSecs: number;
}): { ok: boolean; detail: string } {
  if (!venueApproved(args.approved, args.protocolId)) {
    return { ok: false, detail: "withdraw venue is not approved" };
  }
  if (!(args.amount > 0) || args.amount > args.deployed) {
    return { ok: false, detail: "withdraw amount does not reduce deployed capital" };
  }
  const shared = {
    daoAddress: args.dao,
    navBaseUnits: args.nav,
    stablecoinBaseUnits: null as number | null,
    positions: [],
    approvedProtocols: args.approved,
    policy: args.policy,
    opportunities: [],
    nowSecs: args.nowSecs,
  };
  const pre = computeDrift({ ...shared, deployedBaseUnits: args.deployed });
  const breach = pre.flags.filter(
    (flag) => flag === "deployment_cap_breached" || flag === "liquidity_floor_breached",
  );
  if (breach.length === 0) {
    return {
      ok: false,
      detail: "withdraw does not repair a deployment-cap or liquidity-floor breach",
    };
  }
  const post = computeDrift({
    ...shared,
    deployedBaseUnits: Math.max(0, args.deployed - args.amount),
  });
  const remaining = breach.filter((flag) => post.flags.includes(flag));
  if (remaining.length > 0) {
    return { ok: false, detail: `post-withdraw still breached: ${remaining.join(", ")}` };
  }
  return { ok: true, detail: `post-withdraw cleared ${breach.join(", ")}` };
}

function signingRole(role: AgentRole): AgentRole {
  return role === "operational" ? "financial" : role;
}

interface EvalSlice {
  action: string;
  protocolId?: string;
  amount: number | null;
  deployed: number | null;
  payloadHash?: string;
  confidence: number;
  policyIntent?: SignerVerdictInput["policy_intent"];
  /** When set, guardrails see this vault deployed total and a zero request amount (post-withdraw). */
  postDeployed?: number | null;
  /** Overrides the per-protocol deployed figure used by the allocation cap. */
  allocationDeployed?: number;
}

function evaluateSlice(
  input: SignerVerdictInput,
  state: ChainState,
  slice: EvalSlice,
): GuardrailVerdict {
  const nowIso = new Date().toISOString();
  const constitution = state.constitution;
  const key = (slice.protocolId ?? "").toLowerCase();
  const approved = (constitution?.approvedProtocols ?? []).filter((p) => p.approved);
  const allowlist = new Set<string>();
  for (const p of approved) {
    if (p.protocolId) allowlist.add(p.protocolId.toLowerCase());
    if (p.programId) allowlist.add(p.programId.toLowerCase());
  }
  const match = approved.find(
    (p) => p.protocolId.toLowerCase() === key || p.programId.toLowerCase() === key,
  );
  const deployed = slice.postDeployed ?? slice.deployed;
  const amount = slice.postDeployed != null ? 0 : slice.amount;
  const ctx: AgentContext = {
    version: AGENT_CONTEXT_VERSION,
    daoAddress: input.dao_address,
    daoName: "",
    governanceType: "token",
    role: signingRole(input.agent_role),
    request: {
      address: input.execution_request_address || "",
      actionType: slice.action,
      protocolId: key || null,
      protocolProgram: key ? null : "unspecified",
      expectedPayloadHash: slice.payloadHash ?? null,
      amount,
      targetProtocolDeployedBaseUnits: slice.allocationDeployed ?? state.targetDeployed,
    },
    treasury: {
      totalValueUsd: state.vault?.navBaseUnits ?? null,
      solBalance: null,
      usdcBalance: null,
      snapshotAt: state.vault ? nowIso : null,
      strategyPositions: [],
      navBaseUnits: state.vault?.navBaseUnits ?? null,
      deployedBaseUnits: deployed,
      stablecoinBaseUnits: null,
      navLastRevaluedAt: state.vault?.navLastRevaluedAt ?? null,
    },
    approvedProtocols: [...allowlist],
    riskParams: {
      confidenceThreshold: constitution?.confidenceThreshold ?? 100,
      maxSingleAllocationBps: match?.maxAllocationBps,
      maxTotalDeployedBps: constitution?.maxTotalDeployedBps,
      minStablecoinReserveBps: constitution?.minStablecoinReserveBps,
      minLiquidityBps: constitution?.minLiquidityBps,
      rebalanceFrequencySecs: constitution?.rebalanceFrequencySecs,
      lastRebalanceAt: constitution?.lastRebalanceAt,
    },
    policyIntent: slice.policyIntent,
    gate: state.gate ?? undefined,
    priorActions: [],
    recentActivity: [],
    assembledAt: nowIso,
    genlayer: input.genlayer,
  };
  return evaluateGuardrails(
    ctx.role,
    ctx,
    {
      decision: "approve",
      confidence: slice.confidence,
      should_sign: true,
      payload_hash: slice.payloadHash ?? "",
      risk_flags: [],
    },
    {
      failClosedOnUnknown: true,
      requireCompleteConstitution: true,
      maxNavAgeSeconds: envNum("NAVE_MAX_NAV_AGE_SECONDS", 900),
      genlayerGate: readGenlayerFlag(NAVE_GENLAYER_GATE),
      genlayerVenueGate: readGenlayerFlag(NAVE_GENLAYER_VENUE_GATE),
      genlayerHaltGate: readGenlayerFlag(NAVE_GENLAYER_HALT_GATE),
    },
  );
}

function blocks(verdict: GuardrailVerdict): boolean {
  if (!verdict.pass) return true;
  return verdict.checks.some((c) => c.severity === "critical" && c.indeterminate);
}

function capitalRecord(args: {
  action: string;
  actor: AgentRole;
  pass: boolean;
  checks: CheckResult[];
  failures: string[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    action_class: "capital",
    action: args.action,
    actor_role: args.actor,
    pass: args.pass,
    should_sign: args.pass,
    checks: args.checks,
    failures: args.failures,
    ...args.extra,
  };
}

function confidenceFor(input: SignerVerdictInput, constitution: ConstitutionView | null, explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  if (input.purpose === "compound" || input.purpose === "auto_withdraw") {
    return constitution?.confidenceThreshold ?? 0;
  }
  if (typeof input.confidence === "number" && Number.isFinite(input.confidence)) return input.confidence;
  return -1;
}

async function assessCapital(input: SignerVerdictInput): Promise<SignerVerdict> {
  const state = await loadChainState(input, input.protocol_id);
  const extraFailures: string[] = [];
  const hash = input.payload_hash ?? input.expected_payload_hash ?? undefined;
  const withdraw = input.action.toLowerCase().includes("withdraw");
  const compound = input.purpose === "compound";
  let postDeployed: number | null | undefined;
  let allocationDeployed: number | undefined;
  const amountNow = asFinite(input.amount);
  const deployedNow = state.vault?.deployedBaseUnits ?? null;
  if (withdraw && amountNow != null && amountNow > 0 && deployedNow != null) {
    postDeployed = Math.max(0, deployedNow - amountNow);
    const preTarget = state.targetDeployed ?? deployedNow;
    allocationDeployed = Math.max(0, preTarget - amountNow);
  }

  if (compound) {
    if (!envFlag("NAVE_COMPOUND_ENABLED")) {
      extraFailures.push("NAVE_COMPOUND_ENABLED is false — compound refused");
    }
    const minOut = asFinite(input.min_out);
    if (minOut == null || minOut <= 0) {
      extraFailures.push("compound requires min_out > 0");
    }
  } else if (withdraw) {
    if (input.purpose !== "auto_withdraw") {
      extraFailures.push("withdraw requires purpose auto_withdraw");
    } else if (!envFlag("NAVE_AUTO_WITHDRAW_ENABLED")) {
      extraFailures.push("NAVE_AUTO_WITHDRAW_ENABLED is false — withdraw refused");
    }
    const nav = state.vault?.navBaseUnits;
    if (!state.constitution || deployedNow == null || nav == null || amountNow == null) {
      extraFailures.push("withdraw repair could not be evaluated (constitution, NAV, or amount missing)");
    } else {
      const repair = withdrawRepairs({
        dao: input.dao_address,
        nav,
        deployed: deployedNow,
        amount: amountNow,
        policy: policyOf(state.constitution),
        protocolId: input.protocol_id,
        approved: state.constitution.approvedProtocols,
        nowSecs: Math.floor(Date.now() / 1000),
      });
      if (!repair.ok) extraFailures.push(repair.detail);
    }
  }

  const bundleOps = input.bundle_operations ?? [];
  if (input.action === "bundle_rebalance") {
    // A placement op only moves the escrow of the execute_strategy op right
    // before it (same venue and mint) into the venue.
    bundleOps.forEach((op, i) => {
      if (op.purpose !== "venue_placement") return;
      const prev = bundleOps[i - 1];
      if (
        !/_deposit$/.test(op.action) || prev?.action !== "execute_strategy"
        || prev.protocol_id !== op.protocol_id || prev.mint !== op.mint
      ) {
        extraFailures.push(`bundle op[${i}] venue placement must follow its execute_strategy op`);
      }
    });
  }
  const slices: EvalSlice[] = input.action === "bundle_rebalance"
    ? bundleOps.filter((op) => op.purpose !== "venue_placement").map((op) => ({
      action: op.action,
      protocolId: op.protocol_id,
      amount: asFinite(op.amount),
      deployed: state.vault?.deployedBaseUnits ?? null,
      payloadHash: op.payload_hash ?? op.expected_payload_hash,
      confidence: confidenceFor(input, state.constitution, op.confidence),
      policyIntent: op.action === "execute_strategy" ? undefined : "rebalance" as const,
    }))
    : [{
      action: input.action,
      protocolId: input.protocol_id,
      amount: asFinite(input.amount),
      deployed: state.vault?.deployedBaseUnits ?? null,
      payloadHash: hash,
      confidence: confidenceFor(input, state.constitution),
      policyIntent: input.policy_intent,
      postDeployed,
      allocationDeployed,
    }];

  if (input.action === "bundle_rebalance" && slices.length === 0) {
    extraFailures.push("bundle_rebalance has no operations");
  }

  const checks: CheckResult[] = [];
  const failures: string[] = [];
  let running = state.vault?.deployedBaseUnits ?? null;
  for (const slice of slices) {
    const cumulative = slice.policyIntent === "rebalance" && slice.postDeployed == null;
    const evaluated: EvalSlice = cumulative
      ? {
        ...slice,
        deployed: running,
        allocationDeployed: running ?? undefined,
      }
      : slice;
    const verdict = evaluateSlice(input, state, evaluated);
    checks.push(...verdict.checks);
    failures.push(...verdict.failures);
    if (blocks(verdict) && verdict.failures.length === 0) {
      failures.push("indeterminate critical constitution check");
    }
    if (
      cumulative &&
      running != null &&
      slice.amount != null &&
      slice.amount > 0 &&
      !slice.action.toLowerCase().includes("withdraw")
    ) {
      running += slice.amount;
    }
  }
  if (slices.length === 0) {
    checks.push(check("decision_consistency", false, "no capital operation to evaluate", true));
  }

  failures.push(...extraFailures);
  const criticalBad = checks.some((c) => c.severity === "critical" && (!c.ok || c.indeterminate));
  const pass = failures.length === 0 && !criticalBad;
  const reason = pass ? "constitution verdict passed" : failures[0] ?? "constitution verdict failed";
  return {
    allow: pass,
    reason,
    record: capitalRecord({
      action: input.action,
      actor: input.agent_role,
      pass,
      checks,
      failures,
      extra: {
        protocol_id: input.protocol_id,
        purpose: input.purpose,
        policy_intent: input.policy_intent ?? (input.action === "bundle_rebalance" ? "rebalance" : undefined),
      },
    }),
  };
}

async function assessClearHalt(input: SignerVerdictInput): Promise<SignerVerdict> {
  const state = await loadChainState(input);
  const readable = !!state.gate && state.gate.frozen !== null && state.gate.agentsEnabled !== null;
  const open = readable && state.gate!.frozen === false && state.gate!.agentsEnabled === true;
  const fresh = state.constitution != null;
  const checks = [
    check(
      "agents_enabled",
      open,
      open
        ? "agent gate open"
        : `clear_halt requires a readable open agent gate (frozen=${state.gate?.frozen ?? "missing"}, agents_enabled=${state.gate?.agentsEnabled ?? "missing"})`,
      !readable,
    ),
    check(
      "snapshot_freshness",
      fresh,
      fresh ? "constitution read" : "clear_halt requires a fresh constitution read",
      !fresh,
    ),
  ];
  const halt = haltGateOutcome({
    gateOn: readGenlayerFlag(NAVE_GENLAYER_HALT_GATE),
    clearing: true,
    halt: input.genlayer?.halt,
  });
  checks.push({
    id: "genlayer_halt",
    ok: !halt.block,
    indeterminate: halt.indeterminate,
    severity: halt.recordedOnly ? "warning" : "critical",
    detail: halt.detail,
  });
  const failures = checks.filter((c) => !c.ok && c.severity === "critical").map((c) => `${c.id}: ${c.detail}`);
  const pass = failures.length === 0;
  return {
    allow: pass,
    reason: pass ? "clear_halt gate and constitution are readable" : failures[0],
    record: {
      action_class: "control",
      action: input.action,
      pass,
      should_sign: pass,
      checks,
      failures,
    },
  };
}

function allowRecord(action: string, klass: ActionClass, detail: string, extra?: Record<string, unknown>): SignerVerdict {
  return {
    allow: true,
    reason: detail,
    record: {
      action_class: klass,
      action,
      pass: true,
      should_sign: klass !== "accounting",
      checks: [check("role_valid", true, detail)],
      failures: [],
      ...extra,
    },
  };
}

async function withGenlayer(input: SignerVerdictInput): Promise<SignerVerdictInput> {
  if (input.genlayer) return input;
  const chainFamily = chainFamilyFrom(input.chain, input.chain_id ?? null);
  let rpc = "";
  try {
    rpc = Deno.env.get("SOLANA_RPC_URL") ?? "";
  } catch {
    rpc = "";
  }
  const network = networkForSigner({
    chainFamily,
    chainId: input.chain_id,
    solanaRpcUrl: rpc,
  });
  const genlayer = await fetchGenlayerView({
    treasury: input.dao_address,
    chainFamily,
    network,
    actionHash: input.payload_hash ?? input.expected_payload_hash ?? "",
    protocolId: input.protocol_id,
  });
  return { ...input, genlayer };
}

export async function assessSignerPayload(raw: SignerVerdictInput): Promise<SignerVerdict> {
  const input = await withGenlayer(raw);
  try {
    const klass = classifyAction(input.action);
    if (klass === "accounting") {
      return allowRecord(input.action, "accounting", "accounting action; amount moved is 0", {
        accounting_only: true,
        amount_moved: 0,
      });
    }
    if (input.action === "clear_halt" || input.action === "operational_clear") {
      return await assessClearHalt(input);
    }
    if (klass === "control") {
      return allowRecord(
        input.action,
        "control",
        "control action is allowed while capital movement is paused",
      );
    }
    if (klass !== "capital") {
      return allowRecord(input.action, "other", "not a capital movement");
    }
    if (input.purpose === "venue_placement" || input.purpose === "venue_recall") {
      // Moves funds between the strategy escrow and the venue the founder bound
      // to the position (placement after execute, recall before a withdraw).
      // Deployed capital and NAV exposure are unchanged.
      const placement = input.purpose === "venue_placement";
      if (!(placement ? /_deposit$/ : /_withdraw$/).test(input.action)) {
        const reason = placement ? "venue_placement is only for venue deposits" : "venue_recall is only for venue withdraws";
        return { allow: false, reason, record: failureRecord(input.action, reason) };
      }
      return allowRecord(
        input.action,
        "capital",
        placement
          ? "venue placement of escrowed funds from an executed request (deployed capital unchanged)"
          : "venue recall into the strategy escrow ahead of a withdraw (deployed capital unchanged)",
        { [input.purpose]: true },
      );
    }
    return await assessCapital(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "constitution verdict failed";
    return { allow: false, reason: detail, record: failureRecord(input.action, detail) };
  }
}
