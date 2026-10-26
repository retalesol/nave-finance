import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import {
  BRIDGE_OUTBOUND_ENABLED as TREASURY_BRIDGE_FLAG,
  bridgeGuardrailsOk,
  resolveBridgeCorridor,
} from "../_shared/treasuryBridge.ts";
import {
  type AgentGateView,
  type VaultView,
  accountExists,
  executionRequestForProposal,
  listRegisteredMints,
  readAgentGate,
  readTreasuryVault,
  strategyPositionPda,
} from "../_shared/onchain.ts";
import { assertJupiterMainnetConfig } from "../_shared/cluster.ts";
import {
  enumerateEvmExecutionIndices,
  evmErKey,
  parseEvmErKey,
  readEvmAgentGate,
  readEvmExecutionRequest,
  readEvmPositionAccounting,
  type EvmOnChainRequest,
} from "../_shared/evmExecution.ts";
import {
  INDEXED_REQUEST_EVENT_TYPES,
  IN_ISOLATE_WAKE_MAX_MS,
  hasActiveAgentKey,
  planPollRpc,
  reviewWakeDelayMs,
  selectDispatchableWork,
  shouldScheduleReviewWake,
  type IndexedActionRow,
  type IndexedActivityRow,
} from "../_shared/pollDiscovery.ts";
import { type AgentRole, postReviewAction } from "../_shared/agentContracts.ts";
import { evmChainKindFor, SUPPORTED_EVM_CHAIN_IDS, type ChainKind } from "../_shared/chain.ts";
import { assessSignerPayload } from "../_shared/constitutionVerdict.ts";
import { persistedConstitutionCheck } from "../_shared/constitutionLog.ts";
import { evmRelaySignerRole, signerSecretFor, solanaSignerRole } from "../_shared/signerAuth.ts";
import { haltCausesFrom, operationalGate, type OperationalGateResult } from "../_shared/operationalGate.ts";
import { isStuckRow, redispatchWaitSecs, REFRESH_RETRY_SECS } from "../_shared/redispatchCooldown.ts";

/** Zero EVM address — non-strategy requests (e.g. Transfer) carry no adapter. */
const ZERO_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Grace window (seconds) after `review_end` during which a non-executable
 * Operational verdict (request_review / guardrail-blocked) PARKS the request
 * instead of expiring it. Once the grace elapses the request is expired as a
 * timeout cleanup. Halts expire immediately (see agentContracts.postReviewAction).
 */
const EXECUTION_GRACE_SECS = Math.max(
  0,
  Number(Deno.env.get("NAVE_EXECUTION_GRACE_SECS") ?? 24 * 60 * 60) || 0,
);

// ─── Types ───────────────────────────────────────────────────────────────────
// AgentRole is the shared contract type (../_shared/agentContracts.ts).

/** Maps execution request status to the agent role that should run next */
const STATUS_TO_AGENT: Record<string, AgentRole> = {
  Pending: "executive",
  ExecutiveApproved: "financial",
  FinancialApproved: "oversight",
  OversightApproved: "operational",
  InReview: "operational",
  // Halted requests stay actionable so the Oversight agent (role key operational) can re-evaluate
  // and (if conditions cleared) lift the halt via `operational_clear`, moving
  // the request back to InReview. Without this a halt is a dead-end until a
  // human intervenes. Executed/Expired remain the only true terminal states.
  Halted: "operational",
};

// ─── On-chain ExecutionRequest decoding ──────────────────────────────────────
// Byte offsets within the ExecutionRequest account (see nave_execution state):
//   8 disc + 1 bump + 32 dao + 8 request_index + 32 proposal = 81 → protocol_program (32)
//   ...+ 32 = 113 → mint (32) [Pubkey; added after initial deploy — IDL confirmed]
//   ...+ 32 = 145 → status (u8)
//   ...+ 1 = 146 → tx_payload_hash ([u8;32])
//   ...+ 32 = 178 → amount (u64 LE)
//   ...+ 8 = 186 → review_end (i64 LE)
// withdrawn_amount + review_window are appended at the end; these core offsets are stable.
const OFF_PROTOCOL_PROGRAM = 81;
const OFF_MINT = 113;
const OFF_STATUS = 145;
const OFF_PAYLOAD_HASH = 146;
const OFF_AMOUNT = 178;
const OFF_REVIEW_END = 186;

const STATUS_NAMES = [
  "Pending",
  "ExecutiveApproved",
  "FinancialApproved",
  "OversightApproved",
  "InReview",
  "Executed",
  "Halted",
  "Expired",
] as const;

interface OnChainRequest {
  status: string;
  reviewEnd: number;
  protocolProgram: string;
  /** Asset mint the request deploys (base58 on Solana, 0x asset on EVM). */
  mint: string;
  /** Base-unit amount the request will move (u64). */
  amount: number;
  /** Hex-encoded tx_payload_hash the request is bound to (no 0x prefix). */
  payloadHash: string;
  /** Present when the request was read from an EVM NaveExecution clone. */
  evm?: { chain_id: number; execution_address: string; index: number };
}

interface WorkItem {
  dao_address: string;
  /** Solana ER PDA base58, or synthetic `0x…#index` for EVM. */
  execution_request_address: string;
  status: string;
  chain?: string;
  chain_id?: number;
  execution_address?: string;
  index?: number;
}

function evmOnChainToRequest(r: EvmOnChainRequest, chainId: number): OnChainRequest {
  return {
    status: r.status,
    reviewEnd: r.reviewEnd,
    protocolProgram: r.protocolProgram,
    mint: r.mint,
    amount: r.amount,
    payloadHash: r.payloadHash,
    evm: { chain_id: chainId, execution_address: r.executionAddress, index: r.index },
  };
}

/** Read an execution request for either Solana (PDA) or EVM (`0x…#index`). */
async function readWorkItemRequest(item: WorkItem): Promise<OnChainRequest | null> {
  if (item.chain_id != null && item.index != null) {
    const evm = await readEvmExecutionRequest(item.chain_id, item.dao_address, item.index);
    return evm ? evmOnChainToRequest(evm, item.chain_id) : null;
  }
  const parsed = parseEvmErKey(item.execution_request_address);
  if (parsed) {
    const chainId = item.chain_id;
    if (chainId == null) return null;
    const evm = await readEvmExecutionRequest(chainId, item.dao_address, parsed.index);
    return evm ? evmOnChainToRequest(evm, chainId) : null;
  }
  return readExecutionRequest(item.execution_request_address);
}

function evmSignerPayload(item: WorkItem, fresh?: OnChainRequest | null): Record<string, unknown> {
  if (fresh?.evm) {
    return {
      chain: item.chain ?? evmChainLabel(fresh.evm.chain_id),
      chain_id: fresh.evm.chain_id,
      execution_address: fresh.evm.execution_address,
      index: fresh.evm.index,
      tx_payload_hash: fresh.payloadHash ? `0x${fresh.payloadHash}` : undefined,
    };
  }
  if (item.chain_id && item.execution_address && item.index != null) {
    return {
      chain: item.chain ?? evmChainLabel(item.chain_id),
      chain_id: item.chain_id,
      execution_address: item.execution_address,
      index: item.index,
    };
  }
  return {};
}

/**
 * Chain discriminator for the dispatcher payload. EVM work items carry
 * `chain`/`chain_id` from the dao_registry row (poll) or the request body
 * (manual); the on-chain read is the fallback. Solana items send nothing so the
 * dispatcher keeps its Solana default.
 */
function dispatchChainFields(item: WorkItem, fresh?: OnChainRequest | null): Record<string, unknown> {
  const chainId = item.chain_id ?? fresh?.evm?.chain_id;
  if (chainId == null) return {};
  return { chain: item.chain ?? evmChainLabel(chainId), chain_id: chainId };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/** Read and decode an ExecutionRequest account directly from the RPC. */
async function readExecutionRequest(
  erAddress: string,
): Promise<OnChainRequest | null> {
  const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
  if (!rpcUrl) return null;
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [erAddress, { encoding: "base64" }],
      }),
    });
    const json = await resp.json();
    const b64 = json?.result?.value?.data?.[0];
    if (!b64) return null;
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (raw.length < OFF_REVIEW_END + 8) return null;
    const statusByte = raw[OFF_STATUS];
    const dv = new DataView(raw.buffer, raw.byteOffset);
    const reviewEnd = Number(dv.getBigInt64(OFF_REVIEW_END, true));
    const amount = Number(dv.getBigUint64(OFF_AMOUNT, true));
    const protocolProgram = bytesToBase58(
      raw.slice(OFF_PROTOCOL_PROGRAM, OFF_PROTOCOL_PROGRAM + 32),
    );
    const mint = bytesToBase58(raw.slice(OFF_MINT, OFF_MINT + 32));
    const payloadHash = bytesToHex(
      raw.slice(OFF_PAYLOAD_HASH, OFF_PAYLOAD_HASH + 32),
    );
    return {
      status: STATUS_NAMES[statusByte] ?? `Unknown(${statusByte})`,
      reviewEnd,
      protocolProgram,
      mint,
      amount,
      payloadHash,
    };
  } catch {
    return null;
  }
}

// nave_execution program id. ExecutionRequest accounts are owned by this
// program; the bootstrap creation flow's ExecutionRequest is discoverable by
// enumerating these accounts filtered to the DAO (see enumerateDaoExecutionRequests).
const NAVE_EXECUTION_PROGRAM_ID = Deno.env.get("NAVE_EXECUTION_PROGRAM_ID")
  ?? "2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb";
// Offset of the `dao` pubkey within the ExecutionRequest account layout:
// 8 (anchor disc) + 1 (bump) = 9. Used for the getProgramAccounts memcmp filter.
const OFF_DAO = 9;

/** Terminal statuses an ExecutionRequest can never advance out of. */
const TERMINAL_STATUSES = new Set<string>(["Executed", "Expired"]);

/**
 * Enumerate ExecutionRequest accounts for a single DAO directly from the chain
 * via getProgramAccounts, filtered by the `dao` pubkey at the layout offset.
 *
 * This is the discovery FALLBACK that makes the bootstrap ExecutionRequest
 * reachable: governance's `ExecutionRequestQueued` event only carries
 * { proposal, dao, payload_hash } (no ER address), so an ER created during the
 * unified creation flow never lands in `activity_logs.raw_data.execution_request`
 * and the cheaper log-based discovery misses it. Enumerating the program's own
 * accounts per DAO closes that gap.
 *
 * Returns the base58 addresses of NON-TERMINAL requests (status decoded from the
 * existing OFF_STATUS offset). The caller re-reads each address authoritatively
 * (readExecutionRequest) before acting, so this only seeds the candidate set.
 * Best-effort: returns [] when RPC is unavailable or the call fails.
 */
async function enumerateDaoExecutionRequests(daoAddress: string): Promise<string[]> {
  const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
  if (!rpcUrl) return [];
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          NAVE_EXECUTION_PROGRAM_ID,
          {
            encoding: "base64",
            // memcmp matches the DAO pubkey (base58) at the dao offset; dataSlice
            // pulls only the 1-byte status so the response stays small even when a
            // DAO has many historical requests.
            filters: [{ memcmp: { offset: OFF_DAO, bytes: daoAddress } }],
            dataSlice: { offset: OFF_STATUS, length: 1 },
          },
        ],
      }),
    });
    const json = await resp.json();
    const accounts = json?.result;
    if (!Array.isArray(accounts)) return [];
    const out: string[] = [];
    for (const acc of accounts) {
      const pubkey = acc?.pubkey as string | undefined;
      const b64 = acc?.account?.data?.[0] as string | undefined;
      if (!pubkey || !b64) continue;
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (raw.length < 1) continue;
      const status = STATUS_NAMES[raw[0]] ?? `Unknown(${raw[0]})`;
      // Skip clearly-terminal requests; the caller's authoritative re-read decides
      // actionability for everything else (Executed is handled there too).
      if (TERMINAL_STATUSES.has(status)) continue;
      out.push(pubkey);
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Agent gate (pause / freeze) decision matrix ─────────────────────────────
// The orchestrator short-circuits BEFORE wasting Claude calls or emitting failed
// signer attempts when a DAO is paused or frozen. The gate is read from the
// authoritative on-chain DaoRegistry/AgentSet via `readAgentGate` and reduced to
// a small, testable decision describing exactly which classes of action remain
// permitted. This mirrors the dispatcher's fail-closed posture.
type GateState = "open" | "frozen" | "disabled" | "unreadable";

interface GateDecision {
  state: GateState;
  /** executive/financial/oversight approvals + operational_clear (re-arms execution). */
  allowSigning: boolean;
  /** execute_strategy / jupiter_deposit / withdraw / compound / bundle_rebalance. */
  allowCapitalMovement: boolean;
  /** operational_halt + expire_request + position-oracle accounting tick. */
  allowOperationalMonitoring: boolean;
  /** agent_action_logs.status used when an action is parked by the gate. */
  skipStatus: string;
  /** Human-readable explanation, logged + surfaced in the response `gated` list. */
  reason: string;
}

/**
 * Reduce raw on-chain gate flags to an allowed-actions matrix.
 *
 *   frozen === true        → block ALL capital movement (no approve/execute/deploy/
 *                            withdraw/compound/bundle); operational monitoring
 *                            (halt + expire_request) stays permitted.
 *   gate unreadable (null) → fail-closed for SIGNING + capital movement; allow only
 *                            operational monitoring. Mirrors the dispatcher's
 *                            fail-closed stance so a transient read miss never
 *                            opens the signing path.
 *   agentsEnabled === false→ no NEW approvals/executions; operational monitoring
 *                            (halt + expire_request) only.
 *   otherwise              → open; all actions permitted.
 *
 * Order matters: an explicit freeze is the strongest signal, then unreadable
 * (a flag we cannot confirm is safe), then a clean disable, then open.
 */
function evaluateGate(gate: AgentGateView): GateDecision {
  if (gate.frozen === true) {
    return {
      state: "frozen",
      allowSigning: false,
      allowCapitalMovement: false,
      allowOperationalMonitoring: true,
      skipStatus: "skipped_frozen",
      reason:
        "DAO frozen (emergency): all capital movement paused — approvals, execution, withdraw, compound and bundle rebalances are blocked. Oversight monitoring (halt + expire) remains active.",
    };
  }
  // Either flag unreadable → we cannot confirm the DAO is unfrozen / enabled, so
  // fail closed for anything that moves or commits capital.
  if (gate.frozen === null || gate.agentsEnabled === null) {
    return {
      state: "unreadable",
      allowSigning: false,
      allowCapitalMovement: false,
      allowOperationalMonitoring: true,
      skipStatus: "skipped_gate_unreadable",
      reason:
        "Agent gate unreadable on-chain: failing closed for signing and capital movement; Oversight monitoring (halt + expire) only.",
    };
  }
  if (gate.agentsEnabled === false) {
    return {
      state: "disabled",
      allowSigning: false,
      allowCapitalMovement: false,
      allowOperationalMonitoring: true,
      skipStatus: "skipped_disabled",
      reason:
        "Agents disabled: no new approvals or executions. Oversight monitoring (halt + expire) only.",
    };
  }
  return {
    state: "open",
    allowSigning: true,
    allowCapitalMovement: true,
    allowOperationalMonitoring: true,
    skipStatus: "skipped_gate",
    reason: "Agent gate open: all actions permitted under constitutional policy.",
  };
}

interface PositionAccounting {
  /** Principal deployed into the protocol (base units). */
  depositedBaseUnits: number;
  /** Latest oracle-refreshed position value (base units). */
  currentValueBaseUnits: number;
  /** The founder bound a venue (ext_market / ext_reserve) to the position. */
  venueBound: boolean;
}

/**
 * Read the (non-mint-keyed) StrategyPosition the position oracle refreshes, and
 * decode both the deposited principal and the current value so the compound
 * cycle can reason about realized yield. Layout (mirrors nave_core, 4-seed PDA):
 *   deposited_amount @186, current_value @194.
 * Returns null when the account is missing/unreadable (fail-safe: no compound).
 */
async function readPositionAccounting(
  daoAddress: string,
  protocolId: string,
  mint: string,
): Promise<PositionAccounting | null> {
  const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
  if (!rpcUrl || !mint) return null;
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [strategyPositionPda(daoAddress, protocolId, mint), { encoding: "base64" }],
      }),
    });
    const json = await resp.json();
    const b64 = json?.result?.value?.data?.[0];
    if (!b64) return null;
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (raw.length < 202) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset);
    // ext_market @105, ext_reserve @137 (32 bytes each).
    return {
      depositedBaseUnits: Number(dv.getBigUint64(186, true)),
      currentValueBaseUnits: Number(dv.getBigUint64(194, true)),
      venueBound: raw.subarray(105, 169).some((b) => b !== 0),
    };
  } catch {
    return null;
  }
}

/**
 * Poll the on-chain ExecutionRequest until its status differs from `fromStatus`
 * (i.e. the prior approval tx has been confirmed and applied), or until the
 * attempt budget is exhausted. Returns the latest on-chain read (or null).
 * This is how the orchestrator "waits for confirmation" before advancing the
 * pipeline, instead of optimistically assuming the next status.
 */
async function waitForStatusChange(
  item: WorkItem,
  fromStatus: string,
  attempts = 8,
  delayMs = 1500,
): Promise<OnChainRequest | null> {
  let latest: OnChainRequest | null = null;
  for (let i = 0; i < attempts; i++) {
    latest = await readWorkItemRequest(item);
    if (latest && latest.status !== fromStatus) return latest;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return latest;
}

/** Map an on-chain adapter program id (or Jupiter lending program id) to its protocol_id string. */
function protocolIdForProgram(programId: string): string | null {
  const map: Record<string, string> = {};
  const jito = Deno.env.get("NAVE_JITO_ADAPTER_ID");
  const kamino = Deno.env.get("NAVE_KAMINO_ADAPTER_ID");
  const marginfi = Deno.env.get("NAVE_MARGINFI_ADAPTER_ID");
  // Jupiter uses its Lend lending program ID as the protocol_program in execution requests.
  const jupiterLending = Deno.env.get("JUPITER_LENDING_PROGRAM_ID")
    ?? "7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3"; // devnet default
  if (jito) map[jito] = "jito";
  if (kamino) map[kamino] = "kamino";
  if (marginfi) map[marginfi] = "marginfi";
  map[jupiterLending] = "jupiter";
  return map[programId] ?? null;
}

/**
 * Venue deposit that places a Solana request's escrowed funds after
 * `execute_strategy`. MarginFi needs founder-provisioned accounts and stays in
 * escrow until placed manually.
 */
function venueDepositAction(protocolId: string): string | null {
  switch (protocolId) {
    case "kamino":
      return "kamino_deposit";
    case "jito":
      return "jito_deposit";
    case "jupiter":
      return "jupiter_deposit";
    default:
      return null;
  }
}

interface OrchestratorRequest {
  mode: "poll" | "manual";
  /** manual mode only: skip the redispatch wait for this one evaluation. */
  force_redispatch?: boolean;
  dao_address?: string;
  execution_request_address?: string;
  execution_status?: string;
  chain?: string;
  chain_id?: number;
  /** EVM-only: uint64 request index on NaveExecution (when ER key is synthetic). */
  index?: number;
  /** sweep, review_end, or the index-events hook. Informational. */
  reason?: string;
  /**
   * "caller" means the signer worker arms review-end timers from `review_wakes`.
   * Any other caller (index-events) arms a short in-isolate wake so a 60s
   * testnet window still executes on time.
   */
  wake_owner?: "caller" | "self";
}

// Safety cap on how many execution requests a single poll run will act on.
// Prevents one cycle from fanning out unbounded across DAOs (each work item
// triggers dispatcher + signer calls). Overridable via env.
const MAX_WORK_ITEMS = Number(Deno.env.get("NAVE_ORCHESTRATOR_MAX_WORK_ITEMS") ?? "25");
const AUTO_WITHDRAW_ENABLED = (Deno.env.get("NAVE_AUTO_WITHDRAW_ENABLED") ?? "false").toLowerCase() === "true";
const WITHDRAW_DELAY_SECS = Number(Deno.env.get("NAVE_WITHDRAW_DELAY_SECS") ?? "3600");
// Wait before re-asking a role that blocked, reviewed, or rejected the same
// request. 0 turns the wait off.
const REDISPATCH_COOLDOWN_SECS = Number(Deno.env.get("NAVE_REDISPATCH_COOLDOWN_SECS") ?? "21600");
const POSITION_ORACLE_ENABLED = (Deno.env.get("NAVE_POSITION_ORACLE_ENABLED") ?? "true").toLowerCase() === "true";
const POSITION_ORACLE_COOLDOWN_SECS = Number(Deno.env.get("NAVE_POSITION_ORACLE_COOLDOWN_SECS") ?? "900");
// Yield-aware compounding: harvest realized gains (current position value above
// the deposited principal) via withdraw_from_strategy so the planner can redeploy
// them through the normal governance pipeline. Distinct from (and orthogonal to)
// the legacy flat-delay auto-withdraw, which is preserved for backward compat.
const COMPOUND_ENABLED = (Deno.env.get("NAVE_COMPOUND_ENABLED") ?? "false").toLowerCase() === "true";
/** Agent-automated USDC/ETH hops to sister Ethereum treasuries (CCTP / OP / Arb). */
const BRIDGE_OUTBOUND_ENABLED =
  ((Deno.env.get("NAVE_BRIDGE_OUTBOUND_ENABLED") ?? "false").toLowerCase() === "true") ||
  TREASURY_BRIDGE_FLAG;

/** Expose corridor helper so dead-code elimination does not drop the import. */
function assertBridgeCorridor(
  sourceChainId: number,
  destChainId: number,
  assetSymbol: string,
  amountBaseUnits: bigint,
): { ok: true; corridor: NonNullable<ReturnType<typeof resolveBridgeCorridor>> } | { ok: false; reason: string } {
  const corridor = resolveBridgeCorridor(sourceChainId, destChainId, assetSymbol);
  if (!corridor) {
    return { ok: false, reason: `no bridge corridor ${sourceChainId}→${destChainId} for ${assetSymbol}` };
  }
  const guard = bridgeGuardrailsOk({
    enabled: BRIDGE_OUTBOUND_ENABLED,
    assetSymbol,
    amountBaseUnits,
  });
  if (!guard.ok) return guard;
  return { ok: true, corridor };
}
void assertBridgeCorridor;
// Minimum realized gain (in bps of deposited principal) required before a harvest
// is worthwhile. Default 1% — keeps tx fees from eroding small harvests.
const COMPOUND_MIN_GAIN_BPS = Number(Deno.env.get("NAVE_COMPOUND_MIN_GAIN_BPS") ?? "100");
// Same 50 bps bound as NaveConstants.DEPOSIT_SLIPPAGE_BPS and the signer's
// withDefaultMinOut. Founder withdrawals quote through resolveEvmMinOut; the
// keeper has no quote, so harvest and auto-withdraw pass this floor. The
// base is the amount this call withdraws (realized gain on the harvest path).
const EVM_MIN_OUT_SLIPPAGE_BPS = 50n;

function evmPositiveMinOut(amount: number | string): string {
  let base: bigint;
  try {
    const raw = typeof amount === "number" ? Math.trunc(amount) : String(amount).trim();
    base = BigInt(raw);
  } catch {
    return "1";
  }
  if (base <= 0n) return "1";
  const floor = (base * (10_000n - EVM_MIN_OUT_SLIPPAGE_BPS)) / 10_000n;
  return (floor > 0n ? floor : 1n).toString();
}

// Jito bundle support for atomic rebalancing. Enabled by default on mainnet;
// on devnet the signer falls back to sequential submission automatically.
const JITO_BUNDLE_REBALANCE_ENABLED = (Deno.env.get("JITO_BUNDLE_REBALANCE_ENABLED") ?? "true").toLowerCase() === "true";
const JITO_TIP_LAMPORTS = Number(Deno.env.get("JITO_TIP_LAMPORTS") ?? "5000");

/** Maps an approving agent role to its on-chain signer action. */
const ROLE_TO_SIGN_ACTION: Record<AgentRole, string> = {
  executive: "executive_approve",
  financial: "financial_approve",
  oversight: "oversight_approve",
  operational: "operational_halt",
};

// ─── EVM relay routing (Ethereum + Base + Robinhood) ─────────────────────────
//
// On EVM, the four-agent approvals are msg.sender-gated TRANSACTIONS on
// NaveExecution (relayed from the agent EOA via the signer's /relay-evm), NOT
// EIP-712 signatures. The action vocabulary below maps 1:1 onto the signer's
// relayEvmAgentAction. (Solana-only actions — jupiter_*, bundle_rebalance,
// create_proposal, etc. — have no EVM relay here and are rejected.)
const EVM_CHAIN_IDS = SUPPORTED_EVM_CHAIN_IDS;
const EVM_RELAY_ACTIONS = new Set<string>([
  "executive_approve",
  "financial_approve",
  "oversight_approve",
  "operational_halt",
  "operational_clear",
  "expire_request",
  "execute_strategy",
  "execute_strategy_direct",
  "withdraw_from_strategy",
  // Position-oracle tick — targets the TREASURY directly (not NaveExecution).
  "update_strategy_position_value",
  // Hermes price post + revalueTreasury. Treasury call; parks on failure.
  "revalue_treasury",
  // Capital bridge-out (RH→Eth / Base↔Eth) — gated by NAVE_BRIDGE_OUTBOUND_ENABLED
  // at the call sites that enqueue these actions.
  "create_bridge_request",
  "bridge_outbound",
  // Planner proposal lifecycle: permissionless governor finalize, then bind
  // the passed proposal to its (adapter, amount, asset) request.
  "finalize_proposal",
  "create_strategy_request",
]);

function evmChainLabel(chainId: number): Exclude<ChainKind, "solana"> {
  return evmChainKindFor(chainId) ?? "ethereum";
}

function isEvmTarget(p: { chain?: string; chain_id?: number }): boolean {
  const c = (p.chain ?? "").toLowerCase();
  if (c === "ethereum" || c === "base" || c === "robinhood" || c === "arc") return true;
  if (typeof p.chain_id === "number" && EVM_CHAIN_IDS.has(p.chain_id)) return true;
  return false;
}

/** POST a signing/relay request to the Node.js signer/relayer service.
 *
 * Chain-aware: Solana payloads (the default) POST to /sign (Ed25519/Anchor); EVM
 * payloads (chain 'ethereum'|'base' or an EVM chain_id) POST agent-pipeline
 * actions to /relay-evm (msg.sender tx from the agent EOA). The returned
 * `signature` carries the Solana tx signature OR the EVM tx hash uniformly so
 * callers/log writers are unchanged.
 *
 * NOTE — orchestrator EVM enumeration is NOT yet wired (see the comment block in
 * the poll-mode work-item builder). This helper makes the routing correct so an
 * EVM work item dispatched here reaches the right endpoint, but poll-mode work
 * discovery (readExecutionRequest et al.) still decodes Solana accounts only;
 * EVM request enumeration must be added (e.g. off the evm-indexer cursors)
 * before this EVM branch is exercised at runtime.
 */
async function callSigner(payload: {
  action: string;
  dao_address: string;
  execution_request_address: string;
  /** "planner" pays for proposal and request creation; it never approves. */
  agent_role: AgentRole | "planner";
  /** revalue_treasury: the mints to revalue. */
  assets?: Array<{ mint: string }>;
  reasoning_hash?: string;
  protocol_id?: string;
  amount?: number | "max";
  /** Asset mint for venue CPIs (kamino/jito/jupiter deposit and withdraw). */
  mint?: string;
  /** ATA / Lookup Table for large direct-CPI transactions. */
  lookup_table_address?: string;
  /** For bundle_rebalance: array of operations to execute atomically. */
  bundle_operations?: Array<{
    action: string;
    mint?: string;
    amount?: number | string;
    protocol_id?: string;
    kamino?: Record<string, unknown>;
    jito?: Record<string, unknown>;
    jupiter?: Record<string, unknown>;
    lookup_table_address?: string;
    confidence?: number;
    expected_payload_hash?: string;
    payload_hash?: string;
    /** execute_strategy ops: the request being executed. */
    execution_request_address?: string;
    purpose?: "venue_placement";
  }>;
  jito_tip_lamports?: number;
  // ── EVM-only routing fields (ignored by the Solana /sign path) ──────────────
  /** 'ethereum' | 'base' triggers EVM relay (otherwise Solana). */
  chain?: string;
  /** EVM numeric chain id (1/8453/11155111/84532). */
  chain_id?: number;
  /** NaveExecution contract address — the EVM tx target (msg.sender-gated). */
  execution_address?: string;
  /** uint64 execution-request index on NaveExecution. */
  index?: number | string;
  /** bytes32 tx payload hash bound at creation (financial/oversight approvals). */
  tx_payload_hash?: string;
  /** uint256 slippage floor for execute_strategy / *_direct / withdraw. */
  min_out?: number | string;
  /**
   * EVM-only: adapter address for `update_strategy_position_value`
   * (NaveExecution.syncPositionValue). Also the bridge adapter for
   * `create_bridge_request`.
   */
  adapter?: string;
  /** EVM create_bridge_request: ERC-20 (or WETH) being bridged. */
  asset?: string;
  /** EVM create_bridge_request: sister treasury on dest_chain_id. */
  dest_treasury?: string;
  /** EVM create_bridge_request: destination chain id. */
  dest_chain_id?: number;
  /** EVM create_bridge_request: passed Strategy proposal index. */
  proposal_index?: number | string;
  /** Verdict-only. Stripped before the signer HTTP body. */
  confidence?: number;
  expected_payload_hash?: string;
  payload_hash?: string;
  purpose?: "compound" | "auto_withdraw" | "venue_placement" | "venue_recall";
  policy_intent?: "rebalance" | "deploy_idle" | "reduce_exposure" | "hold";
}): Promise<{
  ok: boolean;
  signature?: string;
  bundle_id?: string;
  atomic?: boolean;
  execution_request_address?: string;
  error?: string;
  constitution_check: Record<string, unknown>;
}> {
  const verdict = await assessSignerPayload({
    ...payload,
    agent_role: payload.agent_role === "planner" ? "operational" : payload.agent_role,
  });
  const constitution_check = verdict.record;
  const deny = (error: string) => ({ ok: false as const, error, constitution_check });
  if (!verdict.allow) return deny(verdict.reason);

  // Fail-closed: no hardcoded signer URL fallback. A misconfigured environment
  // must not silently route signing requests at a default host (which could be
  // wrong, stale, or attacker-controlled). Both the URL and the shared secret
  // are required.
  const signerUrl = Deno.env.get("NAVE_SIGNER_URL");
  const signerSecret = Deno.env.get("NAVE_SIGNER_SECRET");
  if (!signerUrl) return deny("NAVE_SIGNER_URL not configured");
  if (!signerSecret) return deny("NAVE_SIGNER_SECRET not configured");

  const base = signerUrl.replace(/\/$/, "");

  // ── EVM relay branch ────────────────────────────────────────────────────────
  if (isEvmTarget(payload)) {
    if (!EVM_RELAY_ACTIONS.has(payload.action)) {
      return deny(
        `action '${payload.action}' is not relayable on EVM (no NaveExecution function). Solana-only actions cannot route to /relay-evm.`,
      );
    }
    if (
      (payload.action === "create_bridge_request" || payload.action === "bridge_outbound") &&
      !BRIDGE_OUTBOUND_ENABLED
    ) {
      return deny("NAVE_BRIDGE_OUTBOUND_ENABLED is false — capital bridge relay refused");
    }
    // update_strategy_position_value → NaveExecution.syncPositionValue(adapter)
    // (no request index; the value is read from the adapter on-chain).
    // revalue_treasury targets the treasury directly.
    if (payload.action === "update_strategy_position_value" || payload.action === "revalue_treasury") {
      if (payload.action === "update_strategy_position_value") {
        if (!payload.adapter) {
          return deny("EVM update_strategy_position_value requires adapter (NaveTreasury position key)");
        }
        if (!payload.execution_address) {
          return deny("EVM update_strategy_position_value requires execution_address (NaveExecution contract)");
        }
      }
    } else if (payload.action === "finalize_proposal" || payload.action === "create_strategy_request") {
      if (payload.proposal_index === undefined || payload.proposal_index === null) {
        return deny(`EVM ${payload.action} requires proposal_index`);
      }
      if (payload.action === "create_strategy_request" && (!payload.adapter || !payload.asset || payload.amount == null)) {
        return deny("EVM create_strategy_request requires adapter, asset, and amount");
      }
    } else if (payload.action === "create_bridge_request") {
      if (!payload.execution_address) {
        return deny("EVM create_bridge_request requires execution_address");
      }
      if (!payload.adapter) {
        return deny("EVM create_bridge_request requires adapter");
      }
    } else {
      if (!payload.execution_address) {
        return deny(`EVM ${payload.action} requires execution_address (NaveExecution contract)`);
      }
      if (payload.index === undefined || payload.index === null) {
        return deny(`EVM ${payload.action} requires index (uint64 request key)`);
      }
    }
    try {
      const resp = await fetch(`${base}/relay-evm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signer-Secret": signerSecretFor(evmRelaySignerRole(payload.action)) ?? signerSecret,
        },
        body: JSON.stringify({
          action: payload.action,
          chain_id: payload.chain_id,
          dao_address: payload.dao_address,
          execution_address: payload.execution_address,
          index: payload.index,
          reasoning_hash: payload.reasoning_hash,
          tx_payload_hash: payload.tx_payload_hash,
          amount: payload.amount,
          min_out: payload.min_out,
          adapter: payload.adapter,
          asset: payload.asset,
          dest_treasury: payload.dest_treasury,
          dest_chain_id: payload.dest_chain_id,
          proposal_index: payload.proposal_index,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return deny(data.error || `Relayer HTTP ${resp.status}`);
      }
      // /relay-evm echoes the tx hash as `signature` for uniform logging.
      return {
        ok: true,
        signature: data.signature ?? data.tx_hash,
        execution_request_address:
          typeof data.execution_address === "string" && data.index !== undefined
            ? evmErKey(data.execution_address, Number(data.index))
            : undefined,
        constitution_check,
      };
    } catch (err) {
      return deny(err instanceof Error ? err.message : "EVM relay request failed");
    }
  }

  // ── Solana signing branch ───────────────────────────────────────────────────
  try {
    const resp = await fetch(`${base}/sign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signer-Secret": signerSecretFor(solanaSignerRole(payload.agent_role)) ?? signerSecret,
      },
      body: JSON.stringify(signerRequestBody(payload)),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return deny(data.error || `Signer HTTP ${resp.status}`);
    }
    return {
      ok: true,
      signature: data.signature,
      bundle_id: data.bundle_id,
      atomic: data.atomic,
      execution_request_address: typeof data.execution_request_address === "string" ? data.execution_request_address : undefined,
      constitution_check,
    };
  } catch (err) {
    return deny(err instanceof Error ? err.message : "Signer request failed");
  }
}

const SIGNER_VERDICT_KEYS = new Set([
  "confidence",
  "expected_payload_hash",
  "payload_hash",
  "purpose",
  "policy_intent",
]);

/** Drop verdict-only fields so the signer still sees the historical body. */
function signerRequestBody(payload: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SIGNER_VERDICT_KEYS.has(key)) continue;
    if (key === "bundle_operations" && Array.isArray(value)) {
      out[key] = value.map((op) => {
        if (!op || typeof op !== "object") return op;
        const cleaned: Record<string, unknown> = {};
        for (const [opKey, opValue] of Object.entries(op as Record<string, unknown>)) {
          if (!SIGNER_VERDICT_KEYS.has(opKey)) cleaned[opKey] = opValue;
        }
        return cleaned;
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Trigger an on-chain treasury revalue for a single DAO via the snapshot-treasury
 * edge function (which enumerates the DAO's registered assets, self-posts fresh
 * Pyth prices, and calls `revalue_treasury` through the signer). Best-effort —
 * returns ok=false with a reason when the function is unconfigured or fails.
 */
async function triggerRevalue(
  daoAddress: string,
): Promise<{ ok: boolean; error?: string }> {
  // The signer revalues every registered mint, using Chainlink for wSOL.
  // snapshot-treasury is the fallback; its revalue does not refresh wSOL.
  const rpcUrl = Deno.env.get("SOLANA_RPC_URL") ?? "";
  const mints = rpcUrl ? await listRegisteredMints(rpcUrl, daoAddress) : [];
  if (mints.length > 0) {
    const direct = await callSigner({
      action: "revalue_treasury",
      dao_address: daoAddress,
      execution_request_address: "",
      agent_role: "operational",
      assets: mints.map((mint) => ({ mint })),
    });
    if (direct.ok) return { ok: true };
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const indexerSecret = Deno.env.get("NAVE_INDEXER_SECRET");
  if (!supabaseUrl) return { ok: false, error: "SUPABASE_URL unset" };
  if (!indexerSecret) return { ok: false, error: "NAVE_INDEXER_SECRET unset" };
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/snapshot-treasury`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Indexer-Secret": indexerSecret,
      },
      body: JSON.stringify({ dao_addresses: [daoAddress] }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return { ok: false, error: data?.error || `snapshot-treasury HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "snapshot-treasury call failed" };
  }
}

/**
 * NAV freshness self-heal for executable strategy deploys. The contract now
 * hard-blocks `execute_strategy` / `execute_strategy_direct` with `StaleNav`
 * when `treasury_vault.last_revalued_at` is `0` (never revalued) or older than
 * the staleness window — deploys are priced against the on-chain USD NAV, so a
 * stale snapshot would corrupt the allocation/deployment/reserve caps.
 *
 * Before deploying, confirm the NAV is fresh; if it is stale beyond the
 * configured window, trigger a revalue and re-read. Fail-closed: returns
 * `ok:false` (caller PARKs the deploy) whenever freshness cannot be confirmed.
 *
 * The window is `NAVE_MAX_NAV_AGE_SECONDS` (default 900; 0 disables it). When
 * the on-chain field is not exposed (`NAVE_VAULT_LAST_REVALUED_OFF` unset →
 * `navLastRevaluedAt` undefined) the gate is not applicable and the deploy
 * proceeds (the on-chain StaleNav check remains the ultimate guard).
 */
async function ensureNavFreshForDeploy(
  daoAddress: string,
): Promise<{ ok: boolean; reason: string }> {
  const maxNavAge = Number(Deno.env.get("NAVE_MAX_NAV_AGE_SECONDS") ?? 900) || 0;
  if (maxNavAge <= 0) return { ok: true, reason: "NAV freshness window unset (n/a)" };

  const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
  if (!rpcUrl) return { ok: false, reason: "SOLANA_RPC_URL unset" };

  // true = fresh, false = stale, null = unknown (field not exposed / unreadable).
  const freshness = (v: VaultView | null): boolean | null => {
    if (!v) return null;
    if (v.navLastRevaluedAt == null) return null; // offset env unset → unknown
    if (v.navLastRevaluedAt <= 0) return false; // never revalued
    const age = Math.floor(Date.now() / 1000) - v.navLastRevaluedAt;
    return age <= maxNavAge;
  };

  const before = freshness(await readTreasuryVault(rpcUrl, daoAddress));
  if (before === null) return { ok: true, reason: "NAV last_revalued_at not available (n/a)" };
  if (before === true) return { ok: true, reason: "NAV already fresh" };

  // Stale → self-heal by revaluing, then re-read to confirm freshness.
  const revalued = await triggerRevalue(daoAddress);
  if (!revalued.ok) return { ok: false, reason: `revalue not confirmed: ${revalued.error}` };

  const after = freshness(await readTreasuryVault(rpcUrl, daoAddress));
  if (after === true) return { ok: true, reason: "NAV revalued fresh" };
  return { ok: false, reason: "NAV still stale after revalue" };
}

/**
 * Build and submit a Jito bundle rebalance via the signer service.
 * `operations` is a list of protocol CPI actions to execute atomically.
 * Falls back to sequential on devnet / when JITO_BUNDLE_REBALANCE_ENABLED=false.
 */
async function callSignerBundle(
  daoAddress: string,
  operations: Array<{
    action: string;
    mint?: string;
    amount?: number | string;
    protocol_id?: string;
    kamino?: Record<string, unknown>;
    jito?: Record<string, unknown>;
    jupiter?: Record<string, unknown>;
    lookup_table_address?: string;
    confidence?: number;
    expected_payload_hash?: string;
    payload_hash?: string;
    /** execute_strategy ops: the request being executed. */
    execution_request_address?: string;
    purpose?: "venue_placement";
  }>,
): Promise<{ ok: boolean; bundle_id?: string; atomic?: boolean; error?: string; constitution_check: Record<string, unknown> }> {
  return callSigner({
    action: "bundle_rebalance",
    dao_address: daoAddress,
    execution_request_address: "",
    agent_role: "operational",
    bundle_operations: operations,
    jito_tip_lamports: JITO_TIP_LAMPORTS,
  });
}

interface DispatchResult {
  dao_address: string;
  execution_request_address: string;
  agent_role: AgentRole;
  decision: string;
  should_sign: boolean;
  confidence: number;
  reasoning_summary: string;
  risk_flags: string[];
  guardrail_failures: string[];
}

type AgentKeyIndex = { solana: Set<string>; evm: Set<string> };

/** Active Solana or EVM agent-key rows for the DAOs in this batch. Fail closed. */
async function loadActiveKeys(
  supabase: ReturnType<typeof createClient>,
  items: WorkItem[],
): Promise<AgentKeyIndex> {
  const solana = new Set<string>();
  const evm = new Set<string>();
  const solDaos = [...new Set(
    items
      .filter((item) => item.chain_id == null && !item.dao_address.startsWith("0x"))
      .map((item) => item.dao_address),
  )];
  const evmDaos = [...new Set(
    items
      .filter((item) => item.chain_id != null || item.dao_address.startsWith("0x"))
      .map((item) => item.dao_address.toLowerCase()),
  )];
  if (solDaos.length > 0) {
    const { data, error } = await supabase
      .from("encrypted_agent_keys")
      .select("dao_onchain_address, agent_role")
      .in("dao_onchain_address", solDaos)
      .eq("is_active", true);
    if (error) {
      console.error(`[orchestrator] encrypted_agent_keys lookup failed; parking Solana dispatcher work: ${error.message}`);
    } else {
      for (const row of data ?? []) {
        const dao = String((row as { dao_onchain_address?: string }).dao_onchain_address ?? "");
        const role = String((row as { agent_role?: string }).agent_role ?? "");
        if (dao && role) solana.add(`${dao}:${role}`);
      }
    }
  }
  if (evmDaos.length > 0) {
    const { data, error } = await supabase
      .from("encrypted_evm_keys")
      .select("dao_onchain_address, chain_id, signer_role")
      .in("dao_onchain_address", evmDaos)
      .eq("is_active", true)
      .is("guardian_index", null);
    if (error) {
      console.error(`[orchestrator] encrypted_evm_keys lookup failed; parking EVM dispatcher work: ${error.message}`);
    } else {
      for (const row of data ?? []) {
        const dao = String((row as { dao_onchain_address?: string }).dao_onchain_address ?? "").toLowerCase();
        const chainId = Number((row as { chain_id?: number | string }).chain_id);
        const role = String((row as { signer_role?: string }).signer_role ?? "");
        if (dao && role && Number.isFinite(chainId)) evm.add(`${dao}:${chainId}:${role}`);
      }
    }
  }
  return { solana, evm };
}

/**
 * Arm one follow-up poll at reviewEnd for windows short enough to outlive this
 * isolate (testnet's 60s window). Longer windows are returned as review_wakes
 * for the worker, which also runs the 15-minute safety sweep.
 */
function armReviewEndWake(args: {
  dao: string;
  reviewEnd: number;
  wakeOwnerIsCaller: boolean;
  agentSecret: string;
  supabaseUrl: string;
  serviceKey: string;
}): void {
  if (args.wakeOwnerIsCaller) return;
  // EVM oversight events already carry reviewEnd. The worker arms those, including
  // a 60s testnet window, so this isolate must not arm a second poll. Solana
  // oversight events do not carry reviewEnd, so the poll that just read it on
  // chain arms the short wake itself.
  if (args.dao.startsWith("0x") || args.dao.startsWith("0X")) return;
  const now = Date.now();
  if (shouldScheduleReviewWake(args.reviewEnd, now, { horizonMs: IN_ISOLATE_WAKE_MAX_MS }) !== "schedule") {
    return;
  }
  const delay = reviewWakeDelayMs(args.reviewEnd, now);
  const task = (async () => {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const resp = await fetch(`${args.supabaseUrl}/functions/v1/agent-orchestrator`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.serviceKey}`,
          "X-Agent-Secret": args.agentSecret,
        },
        body: JSON.stringify({
          mode: "poll",
          dao_address: args.dao,
          reason: "review_end",
        }),
      });
      if (!resp.ok) {
        console.error(`[orchestrator] review-end wake for ${args.dao} -> HTTP ${resp.status}`);
      }
    } catch (err) {
      console.error(
        "[orchestrator] review-end wake failed:",
        err instanceof Error ? err.message : err,
      );
    }
  })();
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
  else void task;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const limited = rateLimit(req, { key: clientKey(req, "orchestrator"), limit: 30, windowMs: 60_000 }, corsHeaders);
    if (limited) return limited;

    // ── Authenticate (fail-closed) ────────────────────────────────────────
    const agentSecret = Deno.env.get("NAVE_AGENT_SECRET");
    if (!agentSecret) {
      return jsonResponse({ error: "Agent service not configured" }, 500);
    }

    if (!secretsMatch(req.headers.get("X-Agent-Secret"), agentSecret)) {
      return jsonResponse({ error: "Unauthorized — invalid agent secret" }, 401);
    }

    // Fail-closed: a mainnet deployment must carry mainnet Jupiter program ids.
    // This dispatcher maps protocol_program → protocol_id and routes Jupiter
    // direct-CPI capital movements, so a devnet-id mismatch here could misroute
    // real funds. Refuse the whole run rather than proceed.
    try {
      assertJupiterMainnetConfig();
    } catch (e) {
      console.error("agent-orchestrator:", e instanceof Error ? e.message : e);
      return jsonResponse(
        { error: e instanceof Error ? e.message : "Jupiter program id misconfiguration" },
        500,
      );
    }

    const body: OrchestratorRequest = await req.json();
    const { mode } = body;

    if (!mode || !["poll", "manual"].includes(mode)) {
      return jsonResponse({ error: "Invalid mode — must be 'poll' or 'manual'" }, 400);
    }

    // Initialize Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const dispatcherUrl = `${supabaseUrl}/functions/v1/agent-dispatcher`;
    const results: DispatchResult[] = [];
    const errors: Array<{ dao: string; er: string; error: string }> = [];
    // Actions parked because of the agent gate (frozen / disabled / unreadable).
    const gated: Array<{
      dao: string;
      er: string;
      action: string;
      state: GateState | "operational_gate";
      reason: string;
    }> = [];
    // DAOs that resumed (gate now open) after recently being parked — surfaced so
    // operators can see the backlog was reconciled rather than silently dropped.
    const reconciled: Array<{ dao: string; requeued: number; note: string }> = [];
    const parkedMissingKey: WorkItem[] = [];
    const reviewWakes: Array<{ dao_address: string; execution_request_address: string; review_end: number }> = [];
    const seenReviewWakes = new Set<string>();
    let activeKeys: AgentKeyIndex | null = null;
    const wakeOwnerIsCaller = body.wake_owner === "caller";

    const noteReviewWake = (dao: string, er: string, reviewEnd: number) => {
      if (!Number.isFinite(reviewEnd) || reviewEnd <= Math.floor(Date.now() / 1000)) return;
      const key = `${dao}:${er}:${reviewEnd}`;
      if (seenReviewWakes.has(key)) return;
      seenReviewWakes.add(key);
      reviewWakes.push({ dao_address: dao, execution_request_address: er, review_end: reviewEnd });
      armReviewEndWake({
        dao,
        reviewEnd,
        wakeOwnerIsCaller,
        agentSecret,
        supabaseUrl,
        serviceKey: supabaseServiceKey,
      });
    };

    // ── Execute-then-place batching (Jito bundle) ─────────────────────────
    // Solana executions that become ready in the same poll cycle for the same
    // DAO are collected here. With JITO_BUNDLE_REBALANCE_ENABLED each one is
    // submitted as an atomic [execute_strategy, <venue>_deposit] pair (two pairs
    // per ≤4-op bundle); otherwise, or if the bundle fails, each runs
    // sequentially: execute, then place the escrowed funds in the venue.
    interface PendingDirectOp {
      er: string;
      action: string;
      mint: string;
      amount: number | "max";
      protocolId: string;
      payloadHash: string;
      confidence: number;
      riskFlags: string[];
      model: string | null;
      reasoningHash?: string;
    }
    const pendingDirectCpiOps = new Map<string, PendingDirectOp[]>();

    // Read each DAO's gate at most once per poll run (avoid redundant RPC). The
    // matrix decision is cached and reused for every work item of that DAO.
    const gateCache = new Map<string, GateDecision>();
    const getGate = async (daoAddr: string, chainId?: number): Promise<GateDecision> => {
      const cacheKey = chainId ? `evm:${chainId}:${daoAddr.toLowerCase()}` : `sol:${daoAddr}`;
      const cached = gateCache.get(cacheKey);
      if (cached) return cached;
      let decision: GateDecision;
      if (chainId) {
        const view = await readEvmAgentGate(chainId, daoAddr);
        decision = evaluateGate({
          frozen: view ? view.frozen : null,
          agentsEnabled: view ? view.agentsEnabled : null,
        });
      } else {
        const rpcUrl = Deno.env.get("SOLANA_RPC_URL") ?? "";
        const view = await readAgentGate(rpcUrl, daoAddr);
        decision = evaluateGate(view);
      }
      gateCache.set(cacheKey, decision);
      return decision;
    };

    const getGateFresh = async (daoAddr: string, chainId?: number): Promise<GateDecision> => {
      const cacheKey = chainId ? `evm:${chainId}:${daoAddr.toLowerCase()}` : `sol:${daoAddr}`;
      let decision: GateDecision;
      if (chainId) {
        const view = await readEvmAgentGate(chainId, daoAddr);
        decision = evaluateGate({
          frozen: view ? view.frozen : null,
          agentsEnabled: view ? view.agentsEnabled : null,
        });
      } else {
        const rpcUrl = Deno.env.get("SOLANA_RPC_URL") ?? "";
        const view = await readAgentGate(rpcUrl, daoAddr);
        decision = evaluateGate(view);
      }
      gateCache.set(cacheKey, decision);
      return decision;
    };

    /** Park an action behind the gate: record an auditable skip + add to `gated`. */
    const logGateSkip = async (
      daoAddr: string,
      erAddr: string,
      role: AgentRole,
      actionType: string,
      gate: GateDecision,
      chainOpts?: { chain?: string; chain_id?: number | null },
    ) => {
      const chainId = chainOpts?.chain_id ?? null;
      const chainLabel = chainOpts?.chain ?? (chainId ? evmChainLabel(chainId) : "solana");
      gated.push({ dao: daoAddr, er: erAddr, action: actionType, state: gate.state, reason: gate.reason });
      await supabase.from("agent_action_logs").insert({
        dao_onchain_address: daoAddr,
        chain: chainLabel,
        chain_id: chainId,
        agent_role: role,
        action_type: actionType,
        reasoning: `Orchestrator: ${actionType} parked by agent gate (${gate.state}). ${gate.reason}`,
        constitution_check: { agent_gate: gate.state },
        payload_hash: "",
        tx_signature: "",
        execution_request_address: erAddr,
        status: gate.skipStatus,
        error_message: "",
        confidence_score: null,
        risk_flags: [`agent_gate_${gate.state}`],
        decision: "skipped",
        claude_model: null,
        raw_claude_response: null,
        retry_count: 0,
      });
    };

    /** Deterministic causes recorded with the request's latest successful halt; null if none. */
    const latestHaltCauses = async (erAddr: string): Promise<string[] | null> => {
      const { data } = await supabase
        .from("agent_action_logs")
        .select("constitution_check")
        .eq("execution_request_address", erAddr)
        .eq("action_type", "halt")
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return null;
      const causes = (data.constitution_check as Record<string, unknown> | null)?.halt_causes;
      return Array.isArray(causes) ? causes.filter((c): c is string => typeof c === "string") : [];
    };

    /** Place an executed request's escrowed funds in its venue (`op.action` = venue deposit). */
    const placeInVenue = async (daoAddr: string, op: PendingDirectOp) => {
      const placeRes = await callSigner({
        action: op.action,
        dao_address: daoAddr,
        execution_request_address: op.er,
        agent_role: "operational",
        protocol_id: op.protocolId,
        mint: op.mint,
        amount: op.amount,
        purpose: "venue_placement",
      });
      await supabase.from("agent_action_logs").insert({
        dao_onchain_address: daoAddr,
        chain: "solana",
        chain_id: null,
        agent_role: "operational",
        action_type: op.action,
        reasoning: placeRes.ok
          ? `Orchestrator: placed the executed request's escrowed funds in ${op.protocolId} (sig ${placeRes.signature}).`
          : `Orchestrator: ${op.action} after execute failed: ${placeRes.error}. Funds stay in the strategy escrow.`,
        constitution_check: persistedConstitutionCheck(op.action, placeRes.constitution_check),
        payload_hash: op.payloadHash,
        tx_signature: placeRes.signature || "",
        execution_request_address: op.er,
        status: placeRes.ok ? "completed" : "failed",
        error_message: placeRes.error || "",
        confidence_score: op.confidence,
        risk_flags: op.riskFlags,
        decision: "execute",
        claude_model: op.model,
        raw_claude_response: null,
        retry_count: 0,
      });
      if (!placeRes.ok) {
        errors.push({ dao: daoAddr, er: op.er, error: `${op.action} failed: ${placeRes.error}` });
      }
    };

    /**
     * Recall a venue-placed position into the strategy escrow so
     * withdraw_from_strategy can pay it out. No-op for escrow-only positions.
     */
    const recallFromVenue = async (
      daoAddr: string,
      er: string,
      protocolId: string,
      mint: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      const placeAction = venueDepositAction(protocolId);
      if (!placeAction) return { ok: true };
      const pos = await readPositionAccounting(daoAddr, protocolId, mint);
      if (!pos?.venueBound) return { ok: true };
      const recallAction = placeAction.replace(/_deposit$/, "_withdraw");
      const recallRes = await callSigner({
        action: recallAction,
        dao_address: daoAddr,
        execution_request_address: er,
        agent_role: "operational",
        protocol_id: protocolId,
        mint,
        amount: "max",
        purpose: "venue_recall",
      });
      if (!recallRes.ok && /nothing to move/.test(recallRes.error ?? "")) return { ok: true };
      await supabase.from("agent_action_logs").insert({
        dao_onchain_address: daoAddr,
        chain: "solana",
        chain_id: null,
        agent_role: "operational",
        action_type: recallAction,
        reasoning: recallRes.ok
          ? `Orchestrator: recalled the ${protocolId} position into the strategy escrow ahead of a withdraw (sig ${recallRes.signature}).`
          : `Orchestrator: ${recallAction} recall failed: ${recallRes.error}`,
        constitution_check: persistedConstitutionCheck(recallAction, recallRes.constitution_check),
        payload_hash: "",
        tx_signature: recallRes.signature || "",
        execution_request_address: er,
        status: recallRes.ok ? "completed" : "failed",
        error_message: recallRes.error || "",
        confidence_score: null,
        risk_flags: [],
        decision: "withdraw",
        claude_model: null,
        raw_claude_response: null,
        retry_count: 0,
      });
      return recallRes.ok ? { ok: true } : { ok: false, error: recallRes.error };
    };

    /** Record an Operational continue/clear_halt that the deterministic gate refused. */
    const logOperationalGateBlock = async (
      item: WorkItem,
      actionType: "clear_halt" | "execute_strategy",
      decision: OperationalGateResult,
      result: DispatchResult,
      model: string | null | undefined,
      checks?: unknown,
    ) => {
      gated.push({
        dao: item.dao_address,
        er: item.execution_request_address,
        action: actionType,
        state: "operational_gate",
        reason: decision.blockers.join("; "),
      });
      await supabase.from("agent_action_logs").insert({
        dao_onchain_address: item.dao_address,
        chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
        chain_id: item.chain_id ?? null,
        agent_role: "operational",
        action_type: actionType,
        reasoning: `Orchestrator: Operational ${actionType} refused by the deterministic gate: ${decision.blockers.join("; ")}.`,
        constitution_check: { operational_gate: decision, checks: Array.isArray(checks) ? checks : [] },
        payload_hash: "",
        tx_signature: "",
        execution_request_address: item.execution_request_address,
        status: "skipped",
        error_message: "",
        confidence_score: result.confidence,
        risk_flags: [...result.risk_flags, "operational_gate_blocked"],
        decision: "skipped",
        claude_model: model ?? null,
        raw_claude_response: null,
        retry_count: 0,
      });
    };

    // ── Build work items ──────────────────────────────────────────────────
    const workItems: WorkItem[] = [];

    if (mode === "manual") {
      if (!body.dao_address || !body.execution_request_address) {
        return jsonResponse(
          { error: "Manual mode requires dao_address and execution_request_address" },
          400,
        );
      }
      const chainId = body.chain_id;
      const isEvmManual = typeof chainId === "number" && chainId > 0;
      await getGate(body.dao_address, isEvmManual ? chainId : undefined);
      let status = body.execution_status;
      const manualItem: WorkItem = {
        dao_address: body.dao_address,
        execution_request_address: body.execution_request_address,
        status: status ?? "Pending",
        chain: body.chain,
        chain_id: chainId,
        index: body.index,
      };
      if (isEvmManual && body.index != null) {
        manualItem.execution_address = parseEvmErKey(body.execution_request_address)?.execution;
        const onchain = await readWorkItemRequest(manualItem);
        if (!onchain && !status) {
          return jsonResponse(
            { error: "Could not read EVM execution request on-chain; pass execution_status explicitly." },
            400,
          );
        }
        status = status ?? onchain?.status;
      } else if (!status) {
        const onchain = await readWorkItemRequest(manualItem);
        if (!onchain) {
          return jsonResponse(
            { error: "Could not read execution request status on-chain; pass execution_status explicitly." },
            400,
          );
        }
        status = onchain.status;
      }
      manualItem.status = status ?? "Pending";
      workItems.push(manualItem);
    } else {
      // Indexed open requests only. Idle treasuries are not loaded from
      // dao_registry and are not RPC-scanned. enumerateEvmExecutionIndices
      // runs only when an indexed hint has no request index. A dao_address
      // (founder proxy or review-end wake) never fans out to other DAOs.
      console.log(`[orchestrator] poll reason=${body.reason ?? "event"}`);
      const lookbackIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const scopedDao = body.dao_address?.startsWith("0x")
        ? body.dao_address.toLowerCase()
        : body.dao_address;

      let activityQuery = supabase
        .from("activity_logs")
        .select("dao_onchain_address, event_type, raw_data, chain, chain_id, created_at")
        .in("event_type", INDEXED_REQUEST_EVENT_TYPES)
        .gte("created_at", lookbackIso)
        .order("created_at", { ascending: false })
        .limit(500);
      if (scopedDao) activityQuery = activityQuery.eq("dao_onchain_address", scopedDao);
      const { data: activityRows } = await activityQuery;

      let actionQuery = supabase
        .from("agent_action_logs")
        .select("dao_onchain_address, execution_request_address, chain, chain_id, created_at")
        .gte("created_at", lookbackIso)
        .not("execution_request_address", "is", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (scopedDao) actionQuery = actionQuery.eq("dao_onchain_address", scopedDao);
      const { data: actionRows } = await actionQuery;

      const executedActionable = POSITION_ORACLE_ENABLED || COMPOUND_ENABLED || AUTO_WITHDRAW_ENABLED;
      const plan = planPollRpc({
        activity: (activityRows ?? []) as IndexedActivityRow[],
        actions: (actionRows ?? []) as IndexedActionRow[],
        includeExecutedFollowUps: executedActionable,
      });

      const queued = new Set<string>();
      const consider = (onchain: OnChainRequest | null, item: WorkItem) => {
        if (!onchain) return;
        if (onchain.status === "Expired") return;
        if (onchain.status === "Executed" && !executedActionable) return;
        if (!STATUS_TO_AGENT[onchain.status] && onchain.status !== "Executed") return;
        const key = `${item.dao_address}:${item.execution_request_address}`;
        if (queued.has(key)) return;
        queued.add(key);
        item.status = onchain.status;
        workItems.push(item);
        if (onchain.status === "InReview") {
          noteReviewWake(item.dao_address, item.execution_request_address, onchain.reviewEnd);
        }
      };

      const chainMeta = new Map<string, { chain: string; chainId: number }>();
      const unresolved = [...new Set(
        plan.evmTargets.filter((target) => target.chainId == null).map((target) => target.dao.toLowerCase()),
      )];
      if (unresolved.length > 0) {
        const { data: metaRows } = await supabase
          .from("dao_registry")
          .select("dao_onchain_address, chain, chain_id")
          .in("dao_onchain_address", unresolved);
        for (const row of metaRows ?? []) {
          const dao = String((row as { dao_onchain_address?: string }).dao_onchain_address ?? "").toLowerCase();
          const chainId = Number((row as { chain_id?: number | null }).chain_id);
          const chain = String((row as { chain?: string }).chain ?? "");
          if (dao && chainId) chainMeta.set(dao, { chain, chainId });
        }
      }

      const registeredSolana = new Set<string>();
      if (plan.solanaDaos.length > 0) {
        const { data: registered } = await supabase
          .from("dao_registry")
          .select("dao_onchain_address")
          .eq("chain", "solana")
          .in("dao_onchain_address", plan.solanaDaos);
        for (const row of registered ?? []) {
          const dao = (row as { dao_onchain_address?: string }).dao_onchain_address;
          if (dao) registeredSolana.add(dao);
        }
      }

      for (const target of plan.solanaRead) {
        if (!registeredSolana.has(target.dao)) continue;
        const onchain = await readExecutionRequest(target.executionRequest);
        consider(onchain, {
          dao_address: target.dao,
          execution_request_address: target.executionRequest,
          status: onchain?.status ?? "Pending",
        });
      }

      for (const daoAddr of plan.solanaEnumerate) {
        if (!registeredSolana.has(daoAddr)) continue;
        for (const er of await enumerateDaoExecutionRequests(daoAddr)) {
          const onchain = await readExecutionRequest(er);
          consider(onchain, {
            dao_address: daoAddr,
            execution_request_address: er,
            status: onchain?.status ?? "Pending",
          });
        }
      }

      for (const target of plan.evmTargets) {
        const meta = target.chainId != null
          ? { chain: target.chain, chainId: target.chainId }
          : chainMeta.get(target.dao.toLowerCase());
        if (!meta?.chainId) continue;
        const indices: number[] = [];
        if (target.index != null) {
          indices.push(target.index);
        } else if (target.enumerate) {
          for (const idx of await enumerateEvmExecutionIndices(meta.chainId, target.dao)) {
            indices.push(idx);
          }
        }
        for (const index of indices) {
          const onchain = await readEvmExecutionRequest(meta.chainId, target.dao, index);
          if (!onchain) continue;
          consider(evmOnChainToRequest(onchain, meta.chainId), {
            dao_address: target.dao,
            execution_request_address: evmErKey(onchain.executionAddress, index),
            status: onchain.status,
            chain: meta.chain || evmChainLabel(meta.chainId),
            chain_id: meta.chainId,
            execution_address: onchain.executionAddress,
            index,
          });
        }
      }

      const solanaCounts = new Map<string, number>();
      for (const item of workItems) {
        if (item.chain_id == null && !item.dao_address.startsWith("0x")) {
          solanaCounts.set(item.dao_address, (solanaCounts.get(item.dao_address) ?? 0) + 1);
        }
      }
      for (const [daoAddr, nonTerminalForDao] of solanaCounts) {
        const gate = await getGate(daoAddr);
        if (gate.state !== "open" || nonTerminalForDao <= 0) continue;
        const { data: recentSkips } = await supabase
          .from("agent_action_logs")
          .select("id")
          .eq("dao_onchain_address", daoAddr)
          .in("status", ["skipped_frozen", "skipped_disabled", "skipped_gate_unreadable"])
          .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
          .limit(1);
        if ((recentSkips ?? []).length === 0) continue;
        const note =
          `Reconciled after resume: gate re-opened; re-queued ${nonTerminalForDao} non-terminal execution request(s) at their correct role for the pipeline to advance/expire.`;
        reconciled.push({ dao: daoAddr, requeued: nonTerminalForDao, note });
        await supabase.from("agent_action_logs").insert({
          dao_onchain_address: daoAddr,
          chain: "solana",
          chain_id: null,
          agent_role: "operational",
          action_type: "reconcile_after_resume",
          reasoning: `Orchestrator: ${note}`,
          constitution_check: { agent_gate: "open" },
          payload_hash: "",
          tx_signature: "",
          execution_request_address: "",
          status: "completed",
          error_message: "",
          confidence_score: null,
          risk_flags: [],
          decision: "reconcile",
          claude_model: null,
          raw_claude_response: null,
          retry_count: 0,
        });
      }
    }

    // Dispatcher cap applies after missing-key requests are parked, so a DAO
    // with no active key does not consume one of the 25 slots. Follow-ups
    // appended later for a request already in this list are not re-capped.
    let workCapped = 0;
    if (mode === "poll") {
      activeKeys = await loadActiveKeys(supabase, workItems);
      const selected = selectDispatchableWork(
        workItems,
        (item) => hasActiveAgentKey({
          dao: item.dao_address,
          chainId: item.chain_id ?? null,
          status: item.status,
        }, activeKeys!),
        MAX_WORK_ITEMS,
      );
      parkedMissingKey.push(...selected.parkedMissingKey);
      workCapped = selected.capped;
      workItems.length = 0;
      workItems.push(...selected.dispatch);
      if (parkedMissingKey.length > 0) {
        console.log(
          `[orchestrator] parked ${parkedMissingKey.length} request(s) with no active agent key; not dispatched and not counted toward the cap`,
        );
      }
    }

    if (workItems.length === 0 && parkedMissingKey.length === 0) {
      return jsonResponse({
        success: true,
        message: "No eligible work found",
        dispatched: 0,
        work_capped: workCapped,
        results: [],
        errors: [],
        gated,
        reconciled,
        parked_missing_key: 0,
        review_wakes: reviewWakes,
      });
    }

    // ── Dispatch each work item ───────────────────────────────────────────
    // Index-based loop: confirmed follow-up items are appended as the pipeline
    // advances (see below), never optimistically.
    for (let wi = 0; wi < workItems.length; wi++) {
      const item = workItems[wi];

      // Re-read the authoritative on-chain status before acting. The status
      // captured when this item was queued may be stale — a prior item in this
      // same run could have advanced the chain. On-chain is the source of truth,
      // which removes the pipeline race (C1).
      const fresh = await readWorkItemRequest(item);
      if (!fresh) {
        errors.push({
          dao: item.dao_address,
          er: item.execution_request_address,
          error: "Could not read on-chain execution request status",
        });
        continue;
      }
      if (fresh.status === "Expired") {
        continue; // terminal — nothing to do this cycle
      }

      // Post-execution handling for an Executed request: keep the position-oracle
      // accounting fresh, then (behind flags + the gate) either COMPOUND realized
      // yield or run the legacy flat-delay auto-withdraw.
      if (fresh.status === "Executed") {
        const gate = await getGate(item.dao_address, item.chain_id);

        // ═══════════════ EVM branch (parity with the Solana logic below) ═══════════════
        // Adapter address IS the on-chain protocol key on EVM (NaveTreasury's
        // `_positions` mapping is keyed directly by adapter) — no protocol_id
        // string mapping is needed the way Solana needs one for its PDA seeds.
        if (item.chain_id != null) {
          const chainId = item.chain_id;
          const adapter = fresh.protocolProgram;
          const executionAddress = fresh.evm?.execution_address ?? item.execution_address;
          const index = fresh.evm?.index ?? item.index;
          // Non-strategy requests (e.g. Transfer) carry a zero-address adapter —
          // nothing to track/compound/withdraw for those.
          const isStrategyAdapter = !!adapter && adapter !== ZERO_EVM_ADDRESS;

          // Position-oracle tick — accounting only (moves no capital), so it
          // runs even on a frozen/disabled DAO to keep NAV honest while paused.
          if (POSITION_ORACLE_ENABLED && isStrategyAdapter) {
            let skipOracleEvm = false;
            if (POSITION_ORACLE_COOLDOWN_SECS > 0) {
              const sinceOracleEvm = new Date(Date.now() - POSITION_ORACLE_COOLDOWN_SECS * 1000).toISOString();
              const { data: recentOracleEvm } = await supabase
                .from("agent_action_logs")
                .select("id")
                .eq("execution_request_address", item.execution_request_address)
                .eq("action_type", "update_strategy_position_value")
                .gte("created_at", sinceOracleEvm)
                .limit(1);
              if ((recentOracleEvm ?? []).length > 0) skipOracleEvm = true;
            }
            if (!skipOracleEvm) {
              const oracleRes = await callSigner({
                action: "update_strategy_position_value",
                dao_address: item.dao_address,
                execution_request_address: item.execution_request_address,
                agent_role: "operational",
                adapter,
                execution_address: executionAddress,
                chain: item.chain,
                chain_id: chainId,
              });
              await supabase.from("agent_action_logs").insert({
                dao_onchain_address: item.dao_address,
                chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
                chain_id: item.chain_id ?? null,
                agent_role: "operational",
                action_type: "update_strategy_position_value",
                reasoning: oracleRes.ok
                  ? `Orchestrator: refreshed EVM strategy position value via oracle tick (tx ${oracleRes.signature}).`
                  : `Orchestrator: EVM position value oracle tick failed: ${oracleRes.error}`,
                constitution_check: persistedConstitutionCheck(
                  "update_strategy_position_value",
                  oracleRes.constitution_check,
                  { adapter },
                ),
                payload_hash: fresh.payloadHash,
                tx_signature: oracleRes.signature || "",
                execution_request_address: item.execution_request_address,
                status: oracleRes.ok ? "completed" : "failed",
                error_message: oracleRes.error || "",
                confidence_score: null,
                risk_flags: [],
                decision: "oracle_update",
                claude_model: null,
                raw_claude_response: null,
                retry_count: 0,
              });
              if (!oracleRes.ok) {
                errors.push({
                  dao: item.dao_address,
                  er: item.execution_request_address,
                  error: `update_strategy_position_value failed: ${oracleRes.error}`,
                });
              }
            }
          }

          // ── Compound (yield-aware harvest → redeploy via governance) ──────
          if (COMPOUND_ENABLED) {
            if (!gate.allowCapitalMovement) {
              await logGateSkip(item.dao_address, item.execution_request_address, "executive", "compound", gate, {
                chain: item.chain,
                chain_id: item.chain_id,
              });
              continue;
            }
            if (!isStrategyAdapter || !executionAddress || index == null) continue;

            const pos = await readEvmPositionAccounting(chainId, item.dao_address, adapter);
            if (!pos || pos.depositedBaseUnits <= 0) continue; // uninitialized / no principal
            const realizedGain = pos.currentValueBaseUnits - pos.depositedBaseUnits;
            const minGain = Math.floor((pos.depositedBaseUnits * COMPOUND_MIN_GAIN_BPS) / 10000);
            if (realizedGain <= 0 || realizedGain < minGain) continue;

            // Spacing guard — keyed to the POSITION (dao, adapter), mirrors Solana.
            const sinceTs = new Date(Date.now() - WITHDRAW_DELAY_SECS * 1000).toISOString();
            const { data: recentCompound } = await supabase
              .from("agent_action_logs")
              .select("id")
              .eq("dao_onchain_address", item.dao_address)
              .eq("action_type", "compound")
              .eq("status", "completed")
              .contains("constitution_check", { protocol_id: adapter })
              .gte("created_at", sinceTs)
              .limit(1);
            if ((recentCompound ?? []).length > 0) continue;

            const compoundGate = await getGateFresh(item.dao_address, chainId);
            if (!compoundGate.allowCapitalMovement) {
              await logGateSkip(item.dao_address, item.execution_request_address, "executive", "compound", compoundGate, {
                chain: item.chain,
                chain_id: item.chain_id,
              });
              continue;
            }

            const gainPct = ((realizedGain / pos.depositedBaseUnits) * 100).toFixed(2);
            // Harvest the realized gain only. The verdict refuses compound
            // unless min_out is a positive slippage floor of that gain.
            const compoundRes = await callSigner({
              action: "withdraw_from_strategy",
              dao_address: item.dao_address,
              execution_request_address: item.execution_request_address,
              agent_role: "executive",
              protocol_id: adapter,
              amount: realizedGain,
              min_out: evmPositiveMinOut(realizedGain),
              purpose: "compound",
              expected_payload_hash: fresh.payloadHash,
              payload_hash: fresh.payloadHash,
              chain: item.chain,
              chain_id: chainId,
              execution_address: executionAddress,
              index,
            });

            await supabase.from("agent_action_logs").insert({
              dao_onchain_address: item.dao_address,
              chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
              chain_id: item.chain_id ?? null,
              agent_role: "executive",
              action_type: "compound",
              reasoning: compoundRes.ok
                ? `Orchestrator: compound — harvested realized yield of ${realizedGain} base units (${gainPct}% over ${pos.depositedBaseUnits} deposited) from adapter ${adapter} for redeploy (tx ${compoundRes.signature}). Redeploy proceeds via the planner → governance pipeline.`
                : `Orchestrator: EVM compound harvest failed: ${compoundRes.error}`,
              constitution_check: persistedConstitutionCheck("compound", compoundRes.constitution_check, {
                compound: true,
                protocol_id: adapter,
                realized_gain_base_units: realizedGain,
                deposited_base_units: pos.depositedBaseUnits,
              }),
              payload_hash: fresh.payloadHash,
              tx_signature: compoundRes.signature || "",
              execution_request_address: item.execution_request_address,
              status: compoundRes.ok ? "completed" : "failed",
              error_message: compoundRes.error || "",
              confidence_score: null,
              risk_flags: [],
              decision: "compound",
              claude_model: null,
              raw_claude_response: null,
              retry_count: 0,
            });

            if (!compoundRes.ok) {
              errors.push({
                dao: item.dao_address,
                er: item.execution_request_address,
                error: `compound harvest failed: ${compoundRes.error}`,
              });
            }
            continue;
          }

          // ── Legacy flat-delay auto-withdraw (backward compat) ─────────────
          if (!AUTO_WITHDRAW_ENABLED) continue;
          if (!gate.allowCapitalMovement) {
            await logGateSkip(item.dao_address, item.execution_request_address, "executive", "withdraw_from_strategy", gate, {
              chain: item.chain,
              chain_id: item.chain_id,
            });
            continue;
          }
          if (!isStrategyAdapter || !executionAddress || index == null) continue;

          const [{ data: existingWithdrawEvm }, { data: lastExecEvm }] = await Promise.all([
            supabase
              .from("agent_action_logs")
              .select("id")
              .eq("execution_request_address", item.execution_request_address)
              .eq("action_type", "withdraw_from_strategy")
              .eq("status", "completed")
              .limit(1),
            supabase
              .from("agent_action_logs")
              .select("created_at")
              .eq("execution_request_address", item.execution_request_address)
              .eq("action_type", "execute_strategy")
              .eq("status", "completed")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
          ]);
          if ((existingWithdrawEvm ?? []).length > 0) continue;

          const executedAtSecsEvm = lastExecEvm?.created_at
            ? Math.floor(new Date(lastExecEvm.created_at as string).getTime() / 1000)
            : 0;
          const nowEvm = Math.floor(Date.now() / 1000);
          if (executedAtSecsEvm > 0 && nowEvm < executedAtSecsEvm + WITHDRAW_DELAY_SECS) continue;

          const withdrawGateEvm = await getGateFresh(item.dao_address, chainId);
          if (!withdrawGateEvm.allowCapitalMovement) {
            await logGateSkip(item.dao_address, item.execution_request_address, "executive", "withdraw_from_strategy", withdrawGateEvm, {
              chain: item.chain,
              chain_id: item.chain_id,
            });
            continue;
          }

          const withdrawResEvm = await callSigner({
            action: "withdraw_from_strategy",
            dao_address: item.dao_address,
            execution_request_address: item.execution_request_address,
            agent_role: "executive",
            protocol_id: adapter,
            amount: fresh.amount,
            min_out: evmPositiveMinOut(fresh.amount),
            purpose: "auto_withdraw",
            expected_payload_hash: fresh.payloadHash,
            payload_hash: fresh.payloadHash,
            chain: item.chain,
            chain_id: chainId,
            execution_address: executionAddress,
            index,
          });

          await supabase.from("agent_action_logs").insert({
            dao_onchain_address: item.dao_address,
            chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
            chain_id: item.chain_id ?? null,
            agent_role: "executive",
            action_type: "withdraw_from_strategy",
            reasoning: withdrawResEvm.ok
              ? `Orchestrator: EVM auto-withdraw executed after ${WITHDRAW_DELAY_SECS}s delay (tx ${withdrawResEvm.signature}).`
              : `Orchestrator: EVM auto-withdraw failed: ${withdrawResEvm.error}`,
            constitution_check: persistedConstitutionCheck("withdraw_from_strategy", withdrawResEvm.constitution_check),
            payload_hash: fresh.payloadHash,
            tx_signature: withdrawResEvm.signature || "",
            execution_request_address: item.execution_request_address,
            status: withdrawResEvm.ok ? "completed" : "failed",
            error_message: withdrawResEvm.error || "",
            confidence_score: null,
            risk_flags: [],
            decision: "withdraw",
            claude_model: null,
            raw_claude_response: null,
            retry_count: 0,
          });

          if (!withdrawResEvm.ok) {
            errors.push({
              dao: item.dao_address,
              er: item.execution_request_address,
              error: `withdraw_from_strategy failed: ${withdrawResEvm.error}`,
            });
          }
          continue;
        }

        // ═══════════════════════ Solana branch ═══════════════════════════════
        const protocolId = protocolIdForProgram(fresh.protocolProgram);

        // Position-oracle tick — accounting only (refreshes on-chain position
        // value; moves no capital), so it runs even on a frozen/disabled DAO to
        // keep NAV honest while paused.
        if (POSITION_ORACLE_ENABLED && protocolId) {
          let skipOracleSol = false;
          if (POSITION_ORACLE_COOLDOWN_SECS > 0) {
            const sinceOracleSol = new Date(Date.now() - POSITION_ORACLE_COOLDOWN_SECS * 1000).toISOString();
            const { data: recentOracleSol } = await supabase
              .from("agent_action_logs")
              .select("id")
              .eq("execution_request_address", item.execution_request_address)
              .eq("action_type", "update_strategy_position_value")
              .gte("created_at", sinceOracleSol)
              .limit(1);
            if ((recentOracleSol ?? []).length > 0) skipOracleSol = true;
          }
          if (!skipOracleSol) {
            const oracleRes = await callSigner({
              action: "update_strategy_position_value",
              dao_address: item.dao_address,
              execution_request_address: item.execution_request_address,
              agent_role: "operational",
              protocol_id: protocolId,
              mint: fresh.mint,
              amount: fresh.amount,
            });
            await supabase.from("agent_action_logs").insert({
              dao_onchain_address: item.dao_address,
              chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
              chain_id: item.chain_id ?? null,
              agent_role: "operational",
              action_type: "update_strategy_position_value",
              reasoning: oracleRes.ok
                ? `Orchestrator: refreshed strategy position value via oracle tick (sig ${oracleRes.signature}).`
                : `Orchestrator: position value oracle tick failed: ${oracleRes.error}`,
              constitution_check: persistedConstitutionCheck(
                "update_strategy_position_value",
                oracleRes.constitution_check,
              ),
              payload_hash: fresh.payloadHash,
              tx_signature: oracleRes.signature || "",
              execution_request_address: item.execution_request_address,
              status: oracleRes.ok ? "completed" : "failed",
              error_message: oracleRes.error || "",
              confidence_score: null,
              risk_flags: [],
              decision: "oracle_update",
              claude_model: null,
              raw_claude_response: null,
              retry_count: 0,
            });
            if (!oracleRes.ok) {
              errors.push({
                dao: item.dao_address,
                er: item.execution_request_address,
                error: `update_strategy_position_value failed: ${oracleRes.error}`,
              });
            }
          }
        }

        // ── Compound (yield-aware harvest → redeploy via governance) ──────────
        // When enabled, compounding takes precedence over the flat auto-withdraw.
        // It harvests ONLY the realized gain (current value above deposited
        // principal), leaving the principal deployed, and logs a `compound`
        // action. The redeploy of the harvested gain is NOT done here — it goes
        // back through the planner → governance → pipeline, so the orchestrator
        // never bypasses governance; it only harvests and records.
        if (COMPOUND_ENABLED) {
          // Harvesting moves capital — gate it.
          if (!gate.allowCapitalMovement) {
            await logGateSkip(item.dao_address, item.execution_request_address, "executive", "compound", gate, {
              chain: item.chain,
              chain_id: item.chain_id,
            });
            continue;
          }
          if (!protocolId) {
            errors.push({
              dao: item.dao_address,
              er: item.execution_request_address,
              error: `Unknown adapter program for compound harvest: ${fresh.protocolProgram}`,
            });
            continue;
          }

          const pos = await readPositionAccounting(item.dao_address, protocolId, fresh.mint);
          if (!pos || pos.depositedBaseUnits <= 0) continue; // uninitialized / no principal
          const realizedGain = pos.currentValueBaseUnits - pos.depositedBaseUnits;
          const minGain = Math.floor((pos.depositedBaseUnits * COMPOUND_MIN_GAIN_BPS) / 10000);
          // Policy: only compound when the realized gain clears the min-gain
          // threshold (keeps tx fees from eroding tiny harvests).
          if (realizedGain <= 0 || realizedGain < minGain) continue;

          // Spacing guard: avoid re-harvesting before the oracle reflects the
          // prior harvest (which drops realized gain back toward zero). Keyed to
          // the POSITION (dao, protocolId) — NOT the execution request — so the
          // same position cannot be double-harvested via different ERs within the
          // cooldown window. We match on the protocol_id stored in
          // constitution_check on prior compound logs.
          const sinceTs = new Date(Date.now() - WITHDRAW_DELAY_SECS * 1000).toISOString();
          const { data: recentCompound } = await supabase
            .from("agent_action_logs")
            .select("id")
            .eq("dao_onchain_address", item.dao_address)
            .eq("action_type", "compound")
            .eq("status", "completed")
            .contains("constitution_check", { protocol_id: protocolId })
            .gte("created_at", sinceTs)
            .limit(1);
          if ((recentCompound ?? []).length > 0) continue;

          // Gate freshness: re-read the gate right before moving capital.
          const compoundGate = await getGateFresh(item.dao_address, item.chain_id);
          if (!compoundGate.allowCapitalMovement) {
            await logGateSkip(item.dao_address, item.execution_request_address, "executive", "compound", compoundGate, {
              chain: item.chain,
              chain_id: item.chain_id,
            });
            continue;
          }

          const recall = await recallFromVenue(item.dao_address, item.execution_request_address, protocolId, fresh.mint);
          if (!recall.ok) {
            errors.push({ dao: item.dao_address, er: item.execution_request_address, error: `compound recall failed: ${recall.error}` });
            continue;
          }
          const gainPct = ((realizedGain / pos.depositedBaseUnits) * 100).toFixed(2);
          const compoundRes = await callSigner({
            action: "withdraw_from_strategy",
            dao_address: item.dao_address,
            execution_request_address: item.execution_request_address,
            agent_role: "executive",
            protocol_id: protocolId,
            amount: realizedGain,
            min_out: evmPositiveMinOut(realizedGain),
            purpose: "compound",
            expected_payload_hash: fresh.payloadHash,
            payload_hash: fresh.payloadHash,
          });

          await supabase.from("agent_action_logs").insert({
            dao_onchain_address: item.dao_address,
            chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
            chain_id: item.chain_id ?? null,
            agent_role: "executive",
            action_type: "compound",
            reasoning: compoundRes.ok
              ? `Orchestrator: compound — harvested realized yield of ${realizedGain} base units (${gainPct}% over ${pos.depositedBaseUnits} deposited) from ${protocolId} for redeploy (sig ${compoundRes.signature}). Redeploy proceeds via the planner → governance pipeline.`
              : `Orchestrator: compound harvest failed: ${compoundRes.error}`,
            constitution_check: persistedConstitutionCheck("compound", compoundRes.constitution_check, {
              compound: true,
              protocol_id: protocolId,
              realized_gain_base_units: realizedGain,
              deposited_base_units: pos.depositedBaseUnits,
            }),
            payload_hash: fresh.payloadHash,
            tx_signature: compoundRes.signature || "",
            execution_request_address: item.execution_request_address,
            status: compoundRes.ok ? "completed" : "failed",
            error_message: compoundRes.error || "",
            confidence_score: null,
            risk_flags: [],
            decision: "compound",
            claude_model: null,
            raw_claude_response: null,
            retry_count: 0,
          });

          if (!compoundRes.ok) {
            errors.push({
              dao: item.dao_address,
              er: item.execution_request_address,
              error: `compound harvest failed: ${compoundRes.error}`,
            });
          }
          // The principal stays deployed: put what remains in escrow back in the venue.
          const replaceAction = pos.venueBound ? venueDepositAction(protocolId) : null;
          if (replaceAction) {
            await placeInVenue(item.dao_address, {
              er: item.execution_request_address,
              action: replaceAction,
              mint: fresh.mint,
              amount: "max",
              protocolId,
              payloadHash: fresh.payloadHash,
              confidence: 0,
              riskFlags: [],
              model: null,
            });
          }
          continue;
        }

        // ── Legacy flat-delay auto-withdraw (backward compat) ─────────────────
        if (!AUTO_WITHDRAW_ENABLED) continue;

        // Auto-withdraw moves capital — gate it (park on frozen/disabled).
        if (!gate.allowCapitalMovement) {
          await logGateSkip(item.dao_address, item.execution_request_address, "executive", "withdraw_from_strategy", gate, {
            chain: item.chain,
            chain_id: item.chain_id,
          });
          continue;
        }

        const [{ data: existingWithdraw }, { data: lastExec }] = await Promise.all([
          supabase
            .from("agent_action_logs")
            .select("id")
            .eq("execution_request_address", item.execution_request_address)
            .eq("action_type", "withdraw_from_strategy")
            .eq("status", "completed")
            .limit(1),
          supabase
            .from("agent_action_logs")
            .select("created_at")
            .eq("execution_request_address", item.execution_request_address)
            .eq("action_type", "execute_strategy")
            .eq("status", "completed")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        if ((existingWithdraw ?? []).length > 0) continue;

        const executedAtSecs = lastExec?.created_at
          ? Math.floor(new Date(lastExec.created_at as string).getTime() / 1000)
          : 0;
        const now = Math.floor(Date.now() / 1000);
        if (executedAtSecs > 0 && now < executedAtSecs + WITHDRAW_DELAY_SECS) continue;

        if (!protocolId) {
          errors.push({
            dao: item.dao_address,
            er: item.execution_request_address,
            error: `Unknown adapter program for withdraw_from_strategy: ${fresh.protocolProgram}`,
          });
          continue;
        }

        // Gate freshness: re-read the gate right before moving capital.
        const withdrawGate = await getGateFresh(item.dao_address, item.chain_id);
        if (!withdrawGate.allowCapitalMovement) {
          await logGateSkip(item.dao_address, item.execution_request_address, "executive", "withdraw_from_strategy", withdrawGate, {
            chain: item.chain,
            chain_id: item.chain_id,
          });
          continue;
        }

        const recall = await recallFromVenue(item.dao_address, item.execution_request_address, protocolId, fresh.mint);
        if (!recall.ok) {
          errors.push({ dao: item.dao_address, er: item.execution_request_address, error: `withdraw recall failed: ${recall.error}` });
          continue;
        }
        const withdrawRes = await callSigner({
          action: "withdraw_from_strategy",
          dao_address: item.dao_address,
          execution_request_address: item.execution_request_address,
          agent_role: "executive",
          protocol_id: protocolId,
          amount: fresh.amount,
          purpose: "auto_withdraw",
          expected_payload_hash: fresh.payloadHash,
          payload_hash: fresh.payloadHash,
        });

        await supabase.from("agent_action_logs").insert({
          dao_onchain_address: item.dao_address,
          chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
          chain_id: item.chain_id ?? null,
          agent_role: "executive",
          action_type: "withdraw_from_strategy",
          reasoning: withdrawRes.ok
            ? `Orchestrator: auto-withdraw executed after ${WITHDRAW_DELAY_SECS}s delay (sig ${withdrawRes.signature}).`
            : `Orchestrator: auto-withdraw failed: ${withdrawRes.error}`,
          constitution_check: persistedConstitutionCheck("withdraw_from_strategy", withdrawRes.constitution_check),
          payload_hash: fresh.payloadHash,
          tx_signature: withdrawRes.signature || "",
          execution_request_address: item.execution_request_address,
          status: withdrawRes.ok ? "completed" : "failed",
          error_message: withdrawRes.error || "",
          confidence_score: null,
          risk_flags: [],
          decision: "withdraw",
          claude_model: null,
          raw_claude_response: null,
          retry_count: 0,
        });

        if (!withdrawRes.ok) {
          errors.push({
            dao: item.dao_address,
            er: item.execution_request_address,
            error: `withdraw_from_strategy failed: ${withdrawRes.error}`,
          });
        }
        continue;
      }
      const agentRole = STATUS_TO_AGENT[fresh.status];
      if (!agentRole) {
        errors.push({
          dao: item.dao_address,
          er: item.execution_request_address,
          error: `No agent role for status: ${fresh.status}`,
        });
        continue;
      }

      // ── Agent gate ──────────────────────────────────────────────────────
      // Apply the pause/freeze matrix before spending a Claude call or emitting
      // a signer attempt. Signing roles (executive/financial/oversight) are
      // parked when the gate blocks signing — no dispatch, no signer call. The
      // operational role still runs (monitoring is always permitted) so it can
      // halt or expire; its capital-moving steps are gated individually below.
      const gate = await getGate(item.dao_address, item.chain_id);
      if (agentRole !== "operational" && !gate.allowSigning) {
        await logGateSkip(item.dao_address, item.execution_request_address, agentRole, "signing", gate, {
          chain: item.chain,
          chain_id: item.chain_id,
        });
        continue;
      }

      // A role whose last answer on this request was a block, a review, or a
      // reject is not asked again until the cooldown passes. Without this a
      // request that stays unsigned is re-sent to the model every poll.
      let lastFailure = "";
      // An operator-forced manual run (force_redispatch, only the service-key
      // caller can set it; the founder proxy builds its own body) skips the wait
      // for exactly one evaluation. Poll and founder runs keep it.
      if (REDISPATCH_COOLDOWN_SECS > 0 && !(mode === "manual" && body.force_redispatch === true)) {
        const { data: lastRows } = await supabase
          .from("agent_action_logs")
          .select("decision, status, error_message, created_at")
          .eq("dao_onchain_address", item.dao_address)
          .eq("execution_request_address", item.execution_request_address)
          .eq("agent_role", agentRole)
          .order("created_at", { ascending: false })
          .limit(1);
        const last = lastRows?.[0] as {
          decision?: string | null;
          status?: string | null;
          error_message?: string | null;
          created_at?: string;
        } | undefined;
        // Wait rules (block/review/reject, Halted-and-idle, failed/error rows)
        // live in one pure helper so they are unit-tested.
        const waitLeft = redispatchWaitSecs({
          last,
          requestStatus: fresh.status,
          role: agentRole,
          cooldownSecs: REDISPATCH_COOLDOWN_SECS,
          refreshRetrySecs: REFRESH_RETRY_SECS,
        });
        if (waitLeft > 0) continue;
        const stuck = isStuckRow(last);
        if (stuck) lastFailure = last?.error_message ?? "";
      }

      // A signing role last blocked on stale NAV gets a revalue first, so the
      // retry is not refused for the same reason.
      if (agentRole !== "operational" && lastFailure.includes("nav_freshness:")) {
        if (fresh.evm) {
          await callSigner({
            action: "revalue_treasury",
            dao_address: item.dao_address,
            execution_request_address: item.execution_request_address,
            agent_role: "operational",
            ...evmSignerPayload(item, fresh),
          });
        } else {
          await ensureNavFreshForDeploy(item.dao_address);
        }
      }

      // Deterministic guardrail context, sourced from the authoritative on-chain
      // request so the dispatcher can hard-enforce payload-hash equality,
      // protocol allowlist, amount, and cap (H1).
      const protocolId = protocolIdForProgram(fresh.protocolProgram) ?? undefined;
      const confidenceThreshold = Number(
        Deno.env.get("NAVE_CONFIDENCE_THRESHOLD") ?? "70",
      );

      try {
        // If an InReview request already has a completed `continue` decision in
        // `agent_action_logs` whose `execute_strategy` attempt failed at the
        // signer/RPC layer, reuse that prior `continue` evaluation if the
        // dispatcher is temporarily unavailable (e.g. upstream LLM 400/502) or
        // when retrying post-review execution after the review window has elapsed.
        let cachedDispatchData: Record<string, any> | null = null;
        if (agentRole === "operational" && fresh.status === "InReview" && Math.floor(Date.now() / 1000) >= fresh.reviewEnd) {
          const { data: priorContinueRows } = await supabase
            .from("agent_action_logs")
            .select("decision, status, confidence_score, reasoning, risk_flags, reasoning_hash, claude_model, constitution_check, created_at")
            .eq("dao_onchain_address", item.dao_address)
            .eq("execution_request_address", item.execution_request_address)
            .eq("agent_role", "operational")
            .eq("action_type", "pipeline_operational")
            .eq("status", "completed")
            .eq("decision", "continue")
            .order("created_at", { ascending: false })
            .limit(1);
          const priorContinue = priorContinueRows?.[0] as Record<string, any> | undefined;
          if (priorContinue && Number(priorContinue.confidence_score ?? 0) >= confidenceThreshold) {
            const cc = (priorContinue.constitution_check ?? {}) as Record<string, unknown>;
            const storedChecks = Array.isArray(cc.checks) && cc.checks.length > 0
              ? cc.checks
              : [
                { id: "role_valid", ok: true, severity: "critical", indeterminate: false },
                { id: "confidence_threshold", ok: true, severity: "critical", indeterminate: false },
                { id: "decision_consistency", ok: true, severity: "critical", indeterminate: false },
                { id: "risk_severity", ok: true, severity: "critical", indeterminate: false },
                { id: "snapshot_freshness", ok: true, severity: "critical", indeterminate: false },
              ];
            cachedDispatchData = {
              success: true,
              agent_role: "operational",
              decision: "continue",
              should_sign: false,
              should_halt: false,
              should_clear_halt: false,
              confidence: Number(priorContinue.confidence_score),
              reasoning_summary: String(priorContinue.reasoning ?? ""),
              risk_flags: Array.isArray(priorContinue.risk_flags) ? priorContinue.risk_flags : [],
              guardrail_failures: [],
              guardrail_checks: storedChecks,
              reasoning_hash: String(priorContinue.reasoning_hash ?? ""),
              model: priorContinue.claude_model ?? null,
            };
          }
        }

        // deno-lint-ignore no-explicit-any
        let dispatchData: Record<string, any>;
        if (cachedDispatchData) {
          dispatchData = cachedDispatchData;
        } else {
          if (!activeKeys) activeKeys = await loadActiveKeys(supabase, [item]);
          if (!hasActiveAgentKey({
            dao: item.dao_address,
            chainId: item.chain_id ?? fresh.evm?.chain_id ?? null,
            status: fresh.status,
            role: agentRole,
          }, activeKeys)) {
            parkedMissingKey.push(item);
            console.log(
              `[orchestrator] parked ${item.dao_address} ${item.execution_request_address}: no active ${agentRole} key`,
            );
            continue;
          }
          const dispatchResponse = await fetch(dispatcherUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseServiceKey}`,
              "X-Agent-Secret": agentSecret,
            },
            body: JSON.stringify({
              dao_address: item.dao_address,
              agent_role: agentRole,
              execution_request_address: item.execution_request_address,
              action_type: `pipeline_${agentRole}`,
              // Chain discriminator from the work item (dao_registry row / on-chain
              // read). Without it the dispatcher defaulted to Solana and every EVM
              // DAO's key lookup failed.
              ...dispatchChainFields(item, fresh),
              protocol_id: protocolId,
              protocol_program: fresh.protocolProgram,
              mint: fresh.mint,
              target_amount: fresh.amount,
              expected_payload_hash: fresh.payloadHash,
              confidence_threshold: confidenceThreshold,
              // Lets the Oversight prompt say plainly that the request is Halted.
              request_status: fresh.status,
              ...(fresh.status === "Halted"
                ? { halt_causes: (await latestHaltCauses(item.execution_request_address)) ?? undefined }
                : {}),
            }),
          });

          const rawData = await dispatchResponse.json();

          if (!dispatchResponse.ok) {
            errors.push({
              dao: item.dao_address,
              er: item.execution_request_address,
              error: rawData.error || `HTTP ${dispatchResponse.status}`,
            });
            continue;
          }
          dispatchData = rawData;
        }

        const result: DispatchResult = {
          dao_address: item.dao_address,
          execution_request_address: item.execution_request_address,
          agent_role: agentRole,
          decision: dispatchData.decision,
          should_sign: dispatchData.should_sign,
          confidence: dispatchData.confidence,
          reasoning_summary: dispatchData.reasoning_summary,
          risk_flags: dispatchData.risk_flags || [],
          guardrail_failures: dispatchData.guardrail_failures || [],
        };

        results.push(result);

        // ── Signing step — submit the on-chain approval via the signer service ──
        if (result.should_sign && agentRole !== "operational") {
          const signRes = await callSigner({
            action: ROLE_TO_SIGN_ACTION[agentRole],
            dao_address: item.dao_address,
            execution_request_address: item.execution_request_address,
            agent_role: agentRole,
            reasoning_hash: dispatchData.reasoning_hash || undefined,
            ...evmSignerPayload(item, fresh),
          });

          await supabase.from("agent_action_logs").insert({
            dao_onchain_address: item.dao_address,
            chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
            chain_id: item.chain_id ?? null,
            agent_role: agentRole,
            action_type: "signing",
            reasoning: signRes.ok
              ? `Orchestrator: ${agentRole} approved and signed on-chain (sig ${signRes.signature}).`
              : `Orchestrator: ${agentRole} approval failed to sign: ${signRes.error}`,
            constitution_check: persistedConstitutionCheck("signing", signRes.constitution_check),
            payload_hash: dispatchData.payload_hash || "",
            tx_signature: signRes.signature || "",
            execution_request_address: item.execution_request_address,
            status: signRes.ok ? "completed" : "failed",
            error_message: signRes.error || "",
            confidence_score: result.confidence,
            risk_flags: result.risk_flags,
            decision: "approve",
            claude_model: dispatchData.model,
            raw_claude_response: null,
            retry_count: 0,
          });

          if (!signRes.ok) {
            errors.push({
              dao: item.dao_address,
              er: item.execution_request_address,
              error: `Signer failed for ${agentRole}: ${signRes.error}`,
            });
          }
        }

        // ── Oversight halt handling — submit operational_halt on-chain ──
        if (agentRole === "operational" && dispatchData.should_halt && fresh.status !== "Halted") {
          const signRes = await callSigner({
            action: "operational_halt",
            dao_address: item.dao_address,
            execution_request_address: item.execution_request_address,
            agent_role: "operational",
            reasoning_hash: dispatchData.reasoning_hash || undefined,
            ...evmSignerPayload(item, fresh),
          });

          await supabase.from("agent_action_logs").insert({
            dao_onchain_address: item.dao_address,
            chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
            chain_id: item.chain_id ?? null,
            agent_role: "operational",
            action_type: "halt",
            reasoning: signRes.ok
              ? `Orchestrator: Oversight agent halted execution on-chain (sig ${signRes.signature}). Reason: ${dispatchData.halt_reason}`
              : `Orchestrator: Oversight halt failed to sign: ${signRes.error}`,
            constitution_check: persistedConstitutionCheck("halt", signRes.constitution_check, {
              halt_causes: haltCausesFrom(dispatchData.guardrail_checks),
            }),
            payload_hash: "",
            tx_signature: signRes.signature || "",
            execution_request_address: item.execution_request_address,
            status: signRes.ok ? "completed" : "failed",
            error_message: signRes.error || "",
            confidence_score: result.confidence,
            risk_flags: result.risk_flags,
            decision: "halt",
            claude_model: dispatchData.model,
            raw_claude_response: null,
            retry_count: 0,
          });
        }

        // ── Post-halt recovery — lift a halt once conditions clear ──
        // When a request is Halted and the Oversight agent (role key operational) now judges it safe
        // (decision=clear_halt, should_clear_halt, no guardrail failures), submit
        // operational_clear on-chain to move Halted → InReview. The cleared
        // request is then re-queued so the same run can proceed to the
        // execution/expiry evaluation below.
        let clearDecision: OperationalGateResult | null = null;
        if (
          agentRole === "operational" &&
          fresh.status === "Halted" &&
          dispatchData.should_clear_halt &&
          dispatchData.decision === "clear_halt"
        ) {
          clearDecision = operationalGate({
            action: "clear_halt",
            status: fresh.status,
            nowSecs: Math.floor(Date.now() / 1000),
            reviewEndSecs: fresh.reviewEnd,
            checks: dispatchData.guardrail_checks,
            guardrailFailures: dispatchData.guardrail_failures,
            openHaltCauses: await latestHaltCauses(item.execution_request_address),
          });
          if (!clearDecision.ok) {
            await logOperationalGateBlock(item, "clear_halt", clearDecision, result, dispatchData.model, dispatchData.guardrail_checks);
          }
        }
        if (clearDecision?.ok) {
          // Clearing a halt re-arms the request for execution → capital movement.
          // Park it (don't clear) when the gate blocks capital movement.
          // Gate freshness: re-read immediately before acting.
          const clearGate = await getGateFresh(item.dao_address, item.chain_id);
          if (!clearGate.allowCapitalMovement) {
            await logGateSkip(item.dao_address, item.execution_request_address, "operational", "clear_halt", clearGate, {
              chain: item.chain,
              chain_id: item.chain_id,
            });
            continue;
          }
          const clearRes = await callSigner({
            action: "operational_clear",
            dao_address: item.dao_address,
            execution_request_address: item.execution_request_address,
            agent_role: "operational",
            reasoning_hash: dispatchData.reasoning_hash || undefined,
            ...evmSignerPayload(item, fresh),
          });

          await supabase.from("agent_action_logs").insert({
            dao_onchain_address: item.dao_address,
            chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
            chain_id: item.chain_id ?? null,
            agent_role: "operational",
            action_type: "clear_halt",
            reasoning: clearRes.ok
              ? `Orchestrator: Oversight agent cleared a prior halt on-chain (sig ${clearRes.signature}); request returned to InReview.`
              : `Orchestrator: operational_clear failed to sign: ${clearRes.error}`,
            constitution_check: persistedConstitutionCheck("clear_halt", clearRes.constitution_check, {
              operational_gate: clearDecision,
            }),
            payload_hash: "",
            tx_signature: clearRes.signature || "",
            execution_request_address: item.execution_request_address,
            status: clearRes.ok ? "completed" : "failed",
            error_message: clearRes.error || "",
            confidence_score: result.confidence,
            risk_flags: result.risk_flags,
            decision: "clear_halt",
            claude_model: dispatchData.model,
            raw_claude_response: null,
            retry_count: 0,
          });

          if (clearRes.ok) {
            const advanced = await waitForStatusChange(item, "Halted");
            if (advanced && advanced.status === "InReview") {
              workItems.push({
                dao_address: item.dao_address,
                execution_request_address: item.execution_request_address,
                status: advanced.status,
                chain: item.chain,
                chain_id: item.chain_id,
                execution_address: item.execution_address ?? advanced.evm?.execution_address,
                index: item.index ?? advanced.evm?.index,
              });
            }
          } else {
            errors.push({
              dao: item.dao_address,
              er: item.execution_request_address,
              error: `operational_clear failed: ${clearRes.error}`,
            });
          }
        }

        // ── Execution / expiry — after the review window ──
        // The Oversight agent (role key operational) monitors during InReview. Once the window elapses
        // the shared contract (agentContracts.postReviewAction) decides:
        //   • continue + no guardrail failures → execute_strategy
        //   • halt → expire_request
        //   • request_review / blocked → park until the grace window elapses,
        //     then expire_request (timeout cleanup)
        // NOTE: the Oversight schema (role key operational) never emits "approve"; gating on it made
        // autonomous execution dead code.
        // Skip this block when the request started this turn in `Halted` and was
        // just cleared: `clear_halt` already pushed a follow-up `InReview` work
        // item above, so running `postReviewAction` here on the `clear_halt`
        // decision would log a spurious `park` row.
        if (agentRole === "operational" && !dispatchData.should_halt && fresh.status !== "Halted") {
          const onchain = await readWorkItemRequest(item);
          const now = Math.floor(Date.now() / 1000);
          if (onchain && onchain.status === "InReview" && now >= onchain.reviewEnd) {
            const action = postReviewAction(
              {
                decision: dispatchData.decision,
                should_halt: dispatchData.should_halt,
                guardrail_failures: dispatchData.guardrail_failures,
              },
              { graceElapsed: now >= onchain.reviewEnd + EXECUTION_GRACE_SECS },
            );

            if (action === "park") {
              await supabase.from("agent_action_logs").insert({
                dao_onchain_address: item.dao_address,
                chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
                chain_id: item.chain_id ?? null,
                agent_role: "operational",
                action_type: "execute_strategy",
                reasoning: `Orchestrator: review window elapsed but Operational decision '${dispatchData.decision}' does not permit execution${(dispatchData.guardrail_failures?.length ?? 0) > 0 ? ` (guardrails: ${dispatchData.guardrail_failures.join("; ")})` : ""}; request parked for review (expires after grace window).`,
                constitution_check: persistedConstitutionCheck("execute_strategy", {
                  action_class: "capital",
                  action: "execute_strategy",
                  pass: false,
                  should_sign: false,
                  parked: true,
                  checks: [{
                    id: "decision_consistency",
                    ok: false,
                    indeterminate: false,
                    severity: "critical",
                    detail: `parked: operational decision '${dispatchData.decision}' does not permit execution`,
                  }],
                  failures: dispatchData.guardrail_failures ?? [],
                }),
                payload_hash: dispatchData.payload_hash || "",
                tx_signature: "",
                execution_request_address: item.execution_request_address,
                status: "skipped",
                error_message: "",
                confidence_score: result.confidence,
                risk_flags: result.risk_flags,
                decision: "skipped",
                claude_model: dispatchData.model ?? null,
                raw_claude_response: null,
                retry_count: 0,
              });
            } else if (action === "execute") {
              const continueDecision = operationalGate({
                action: "continue",
                status: onchain.status,
                nowSecs: now,
                reviewEndSecs: onchain.reviewEnd,
                checks: dispatchData.guardrail_checks,
                guardrailFailures: dispatchData.guardrail_failures,
                openHaltCauses: await latestHaltCauses(item.execution_request_address),
              });
              if (!continueDecision.ok) {
                await logOperationalGateBlock(
                  item,
                  "execute_strategy",
                  continueDecision,
                  result,
                  dispatchData.model,
                  dispatchData.guardrail_checks,
                );
                continue;
              }
              const isEvmExec = item.chain_id != null;
              const execProtocolId = isEvmExec
                ? (onchain.protocolProgram || "evm")
                : protocolIdForProgram(onchain.protocolProgram);
              if (!execProtocolId) {
                errors.push({
                  dao: item.dao_address,
                  er: item.execution_request_address,
                  error: `Unknown adapter program for execution: ${onchain.protocolProgram}`,
                });
              } else if (!(await getGateFresh(item.dao_address, item.chain_id)).allowCapitalMovement) {
                const gateKey = item.chain_id
                  ? `evm:${item.chain_id}:${item.dao_address.toLowerCase()}`
                  : `sol:${item.dao_address}`;
                await logGateSkip(
                  item.dao_address,
                  item.execution_request_address,
                  "operational",
                  "execute_strategy",
                  gateCache.get(gateKey)!,
                  { chain: item.chain, chain_id: item.chain_id },
                );
              } else {
                // NAV freshness self-heal (StaleNav hard-block). A deploy is
                // priced against the on-chain USD NAV; the contract now rejects
                // execute_strategy / execute_strategy_direct with `StaleNav` when
                // last_revalued_at is stale. Solana tries snapshot-treasury →
                // revalue_treasury. EVM posts Hermes prices then revalueTreasury
                // through the signer. If a fresh NAV still can't be confirmed,
                // fail closed and PARK the request (leave it InReview).
                const navResult = isEvmExec
                  ? await (async () => {
                    const revalue = await callSigner({
                      action: "revalue_treasury",
                      dao_address: item.dao_address,
                      execution_request_address: item.execution_request_address,
                      agent_role: "operational",
                      ...evmSignerPayload(item, onchain),
                    });
                    return revalue.ok
                      ? { ok: true as const, reason: "EVM revalueTreasury posted" }
                      : { ok: false as const, reason: revalue.error ?? "revalue_treasury failed" };
                  })()
                  : await ensureNavFreshForDeploy(item.dao_address);
                if (!navResult.ok) {
                  await supabase.from("agent_action_logs").insert({
                    dao_onchain_address: item.dao_address,
                    chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
                    chain_id: item.chain_id ?? null,
                    agent_role: "operational",
                    action_type: "execute_strategy",
                    reasoning: `Orchestrator: deploy parked — NAV not fresh for StaleNav guard. ${navResult.reason}`,
                    constitution_check: persistedConstitutionCheck("execute_strategy", {
                      action_class: "capital",
                      action: "execute_strategy",
                      pass: false,
                      should_sign: false,
                      nav_freshness: "stale",
                      checks: [{
                        id: "nav_freshness",
                        ok: false,
                        indeterminate: false,
                        severity: "critical",
                        detail: navResult.reason,
                      }],
                      failures: [`nav_freshness: ${navResult.reason}`],
                    }),
                    payload_hash: dispatchData.payload_hash || "",
                    tx_signature: "",
                    execution_request_address: item.execution_request_address,
                    status: "skipped",
                    error_message: "",
                    confidence_score: result.confidence,
                    risk_flags: [...(result.risk_flags ?? []), "nav_stale"],
                    decision: "skipped",
                    claude_model: dispatchData.model ?? null,
                    raw_claude_response: null,
                    retry_count: 0,
                  });
                  continue;
                }

                // Every venue goes through execute_strategy; on Solana the escrowed
                // funds are then placed with the venue deposit.
                const execAction = "execute_strategy";
                const placeAction = isEvmExec ? null : venueDepositAction(execProtocolId);

                if (!isEvmExec && JITO_BUNDLE_REBALANCE_ENABLED) {
                  const list = pendingDirectCpiOps.get(item.dao_address) ?? [];
                  list.push({
                    er: item.execution_request_address,
                    action: execAction,
                    mint: onchain.mint,
                    amount: onchain.amount,
                    protocolId: execProtocolId,
                    // On-chain request hash first: Oversight returns none.
                    payloadHash: onchain.payloadHash || dispatchData.payload_hash || "",
                    confidence: result.confidence,
                    riskFlags: result.risk_flags,
                    model: dispatchData.model ?? null,
                    reasoningHash: dispatchData.reasoning_hash || undefined,
                  });
                  pendingDirectCpiOps.set(item.dao_address, list);
                  continue;
                }

                const execRes = await callSigner({
                  action: execAction,
                  dao_address: item.dao_address,
                  execution_request_address: item.execution_request_address,
                  // EVM `execute` is Executive-only on-chain (the relayer signs
                  // with the Executive key regardless of this field).
                  agent_role: isEvmExec ? "executive" : "operational",
                  protocol_id: execProtocolId,
                  mint: onchain.mint,
                  amount: onchain.amount,
                  confidence: result.confidence,
                  expected_payload_hash: onchain.payloadHash || dispatchData.payload_hash || undefined,
                  payload_hash: dispatchData.payload_hash || onchain.payloadHash || undefined,
                  reasoning_hash: dispatchData.reasoning_hash || undefined,
                  ...evmSignerPayload(item, onchain),
                });

                await supabase.from("agent_action_logs").insert({
                  dao_onchain_address: item.dao_address,
                  chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
                  chain_id: item.chain_id ?? null,
                  agent_role: "operational",
                  action_type: execAction,
                  reasoning: execRes.ok
                    ? `Orchestrator: review window elapsed; executed ${execAction} on-chain via ${execProtocolId} (sig ${execRes.signature}).`
                    : `Orchestrator: ${execAction} failed to sign: ${execRes.error}`,
                  constitution_check: persistedConstitutionCheck(execAction, execRes.constitution_check),
                  payload_hash: dispatchData.payload_hash || "",
                  tx_signature: execRes.signature || "",
                  execution_request_address: item.execution_request_address,
                  status: execRes.ok ? "completed" : "failed",
                  error_message: execRes.error || "",
                  confidence_score: result.confidence,
                  risk_flags: result.risk_flags,
                  decision: "execute",
                  claude_model: dispatchData.model,
                  raw_claude_response: null,
                  retry_count: 0,
                });

                if (!execRes.ok) {
                  errors.push({
                    dao: item.dao_address,
                    er: item.execution_request_address,
                    error: `execute_strategy failed: ${execRes.error}`,
                  });
                } else if (placeAction) {
                  await placeInVenue(item.dao_address, {
                    er: item.execution_request_address,
                    action: placeAction,
                    mint: onchain.mint,
                    amount: onchain.amount,
                    protocolId: execProtocolId,
                    payloadHash: onchain.payloadHash || dispatchData.payload_hash || "",
                    confidence: result.confidence,
                    riskFlags: result.risk_flags,
                    model: dispatchData.model ?? null,
                  });
                }
              }
            } else {
              const expireRes = await callSigner({
                action: "expire_request",
                dao_address: item.dao_address,
                execution_request_address: item.execution_request_address,
                agent_role: "operational",
                reasoning_hash: dispatchData.reasoning_hash || undefined,
                ...evmSignerPayload(item, fresh),
              });

              await supabase.from("agent_action_logs").insert({
                dao_onchain_address: item.dao_address,
                chain: item.chain ?? (item.chain_id ? evmChainLabel(item.chain_id) : "solana"),
                chain_id: item.chain_id ?? null,
                agent_role: "operational",
                action_type: "expire_request",
                reasoning: expireRes.ok
                  ? `Orchestrator: review window elapsed without approval; expired request (sig ${expireRes.signature}).`
                  : `Orchestrator: expire_request failed to sign: ${expireRes.error}`,
                constitution_check: persistedConstitutionCheck("expire_request", expireRes.constitution_check),
                payload_hash: "",
                tx_signature: expireRes.signature || "",
                execution_request_address: item.execution_request_address,
                status: expireRes.ok ? "completed" : "failed",
                error_message: expireRes.error || "",
                confidence_score: result.confidence,
                risk_flags: result.risk_flags,
                decision: "reject",
                claude_model: dispatchData.model,
                raw_claude_response: null,
                retry_count: 0,
              });

              if (!expireRes.ok) {
                errors.push({
                  dao: item.dao_address,
                  er: item.execution_request_address,
                  error: `expire_request failed: ${expireRes.error}`,
                });
              }
            }
          }
        }

        // ── Pipeline advancement (confirmation-gated) ───────────────────
        // Never optimistically queue the next role. Only advance after the
        // on-chain status actually changes — i.e. the approval tx confirmed and
        // applied. This is the fix for the pipeline race (C1): if the signer
        // failed or the tx didn't land, the status stays put and we do NOT
        // advance. The next role is re-derived from the confirmed on-chain
        // status (re-validated at the top of the loop).
        if (result.should_sign && result.decision === "approve" && agentRole !== "operational") {
          const advanced = await waitForStatusChange(
            item,
            fresh.status,
          );
          if (
            advanced &&
            !["Executed", "Halted", "Expired"].includes(advanced.status) &&
            STATUS_TO_AGENT[advanced.status]
          ) {
            workItems.push({
              dao_address: item.dao_address,
              execution_request_address: item.execution_request_address,
              status: advanced.status,
              chain: item.chain,
              chain_id: item.chain_id,
              execution_address: item.execution_address ?? advanced.evm?.execution_address,
              index: item.index ?? advanced.evm?.index,
            });
          } else if (!advanced || advanced.status === fresh.status) {
            errors.push({
              dao: item.dao_address,
              er: item.execution_request_address,
              error: `${agentRole} approval did not confirm on-chain (status still ${fresh.status})`,
            });
          }
        }
      } catch (err) {
        errors.push({
          dao: item.dao_address,
          er: item.execution_request_address,
          error: err instanceof Error ? err.message : "Unknown dispatch error",
        });
      }
    }

    // ── Flush execute-then-place pairs (Jito bundle) ──────────────────────
    // Each collected execution is bundled with its venue deposit (two pairs per
    // ≤4-op bundle). Executions without a venue deposit (MarginFi) and bundle
    // failures run sequentially. The signer falls back to sequential
    // submission on devnet automatically.
    let bundledRebalances = 0;
    for (const [daoAddr, ops] of pendingDirectCpiOps) {
      if (ops.length === 0) continue;

      // Gate freshness: a DAO can be frozen between when these ops were collected
      // and now. Re-read the gate and park the whole batch if capital movement is
      // no longer allowed (the requests stay InReview and resume next poll).
      const flushGate = await getGateFresh(daoAddr);
      if (!flushGate.allowCapitalMovement) {
        for (const op of ops) {
          await logGateSkip(daoAddr, op.er, "operational", op.action, flushGate);
        }
        continue;
      }

      const runSequential = async (op: PendingDirectOp) => {
        const execRes = await callSigner({
          action: op.action,
          dao_address: daoAddr,
          execution_request_address: op.er,
          agent_role: "operational",
          protocol_id: op.protocolId,
          mint: op.mint,
          amount: op.amount,
          confidence: op.confidence,
          expected_payload_hash: op.payloadHash,
          payload_hash: op.payloadHash,
          reasoning_hash: op.reasoningHash,
        });
        await supabase.from("agent_action_logs").insert({
          dao_onchain_address: daoAddr,
          chain: "solana",
          chain_id: null,
          agent_role: "operational",
          action_type: op.action,
          reasoning: execRes.ok
            ? `Orchestrator: review window elapsed; executed ${op.action} on-chain via ${op.protocolId} (sig ${execRes.signature}).`
            : `Orchestrator: ${op.action} failed to sign: ${execRes.error}`,
          constitution_check: persistedConstitutionCheck(op.action, execRes.constitution_check),
          payload_hash: op.payloadHash,
          tx_signature: execRes.signature || "",
          execution_request_address: op.er,
          status: execRes.ok ? "completed" : "failed",
          error_message: execRes.error || "",
          confidence_score: op.confidence,
          risk_flags: op.riskFlags,
          decision: "execute",
          claude_model: op.model,
          raw_claude_response: null,
          retry_count: 0,
        });
        if (!execRes.ok) {
          errors.push({ dao: daoAddr, er: op.er, error: `${op.action} failed: ${execRes.error}` });
          return;
        }
        const placeAction = venueDepositAction(op.protocolId);
        if (placeAction) await placeInVenue(daoAddr, { ...op, action: placeAction });
      };

      // ≤4 ops per bundle (1 slot reserved for the Jito tip) = two
      // [execute, deposit] pairs; overflow runs sequentially so nothing is dropped.
      const pairable = ops.filter((op) => venueDepositAction(op.protocolId));
      for (const op of ops.filter((o) => !venueDepositAction(o.protocolId))) await runSequential(op);
      if (pairable.length === 0) continue;

      const batch = pairable.slice(0, 2);
      const overflow = pairable.slice(2);

      const bundleRes = await callSignerBundle(
        daoAddr,
        batch.flatMap((op) => [
          {
            action: "execute_strategy",
            execution_request_address: op.er,
            mint: op.mint,
            amount: op.amount,
            protocol_id: op.protocolId,
            confidence: op.confidence,
            expected_payload_hash: op.payloadHash,
            payload_hash: op.payloadHash,
          },
          {
            action: venueDepositAction(op.protocolId)!,
            mint: op.mint,
            amount: op.amount,
            protocol_id: op.protocolId,
            purpose: "venue_placement" as const,
          },
        ]),
      );

      if (bundleRes.ok) {
        bundledRebalances++;
        for (const op of batch) {
          await supabase.from("agent_action_logs").insert({
            dao_onchain_address: daoAddr,
            chain: "solana",
            chain_id: null,
            agent_role: "operational",
            action_type: "bundle_rebalance",
            reasoning:
              `Orchestrator: executed the request and placed it in ${op.protocolId} in a ${batch.length * 2}-op Jito bundle (bundle_id ${bundleRes.bundle_id ?? "n/a"}, atomic=${bundleRes.atomic ?? false}).`,
            constitution_check: persistedConstitutionCheck("bundle_rebalance", bundleRes.constitution_check, {
              atomic_rebalance: true,
              bundle_ops: batch.length * 2,
            }),
            payload_hash: op.payloadHash,
            tx_signature: bundleRes.bundle_id || "",
            execution_request_address: op.er,
            status: "completed",
            error_message: "",
            confidence_score: op.confidence,
            risk_flags: op.riskFlags,
            decision: "execute",
            claude_model: op.model,
            raw_claude_response: null,
            retry_count: 0,
          });
        }
      } else {
        // Bundle failed (or unsupported) — fall back to sequential so the ready
        // ops still execute rather than silently stalling.
        for (const op of batch) await runSequential(op);
      }

      for (const op of overflow) await runSequential(op);
    }

    // ── Auto-finalize: proposals whose outcome is mathematically certain ──
    //
    // Once a proposal either (a) has passed its voting_end timestamp OR
    // (b) has accumulated votes such that the remaining voters can't change
    // the outcome, we submit finalize_proposal on-chain automatically.
    //
    // The instruction is permissionless (anyone can call it) so we use the
    // executive agent as a convenience signer/payer. If voting is still open
    // the on-chain instruction simply fails — we catch and ignore it so the
    // poll cycle continues unaffected.
    //
    // We source proposals to check from agent_proposals (proposals the agents
    // created), polling for both 'created' and 'Active' status. For proposals
    // created by humans, the orchestrator relies on on-chain data from
    // execution_requests which already reference the proposal index.
    let autoFinalizeCount = 0;
    try {
      const { data: agentProps } = await supabase
        .from("agent_proposals")
        .select("id, dao_onchain_address, proposal_index, proposal_address, action_kind, protocol_id, program_id, amount_base_units, asset_mint")
        .eq("status", "created")
        .not("proposal_index", "is", null)
        .order("created_at", { ascending: false })
        .limit(20);

      const propDaos = [...new Set((agentProps ?? []).map((ap) => String(ap.dao_onchain_address ?? "")).filter(Boolean))];
      const chainByPropDao = new Map<string, { chain: string; chain_id: number | null }>();
      if (propDaos.length > 0) {
        const { data: propChainRows } = await supabase
          .from("dao_registry")
          .select("dao_onchain_address, chain, chain_id")
          .in("dao_onchain_address", propDaos);
        for (const row of propChainRows ?? []) {
          chainByPropDao.set(String(row.dao_onchain_address), {
            chain: String(row.chain ?? "solana"),
            chain_id: typeof row.chain_id === "number" ? row.chain_id : null,
          });
        }
      }

      if (agentProps && agentProps.length > 0) {
        for (const ap of agentProps) {
          if (ap.proposal_index == null || !ap.dao_onchain_address) continue;
          const propChain = chainByPropDao.get(String(ap.dao_onchain_address));
          const evmRoute: { chain?: string; chain_id?: number } =
            propChain && isEvmTarget({ chain: propChain.chain, chain_id: propChain.chain_id ?? undefined })
              ? { chain: propChain.chain, chain_id: propChain.chain_id ?? undefined }
              : {};

          const propChainLabel = evmRoute.chain ?? (evmRoute.chain_id ? evmChainLabel(evmRoute.chain_id) : "solana");
          const propChainId = evmRoute.chain_id ?? null;

          // Park auto-finalize when the DAO's gate is frozen/disabled/unreadable.
          // Finalizing a passed proposal re-arms it for execution (capital
          // movement), so a frozen DAO must not have its proposals advanced.
          // Gate is read fresh here so an emergency freeze mid-poll is honored.
          const finalizeGate = await getGateFresh(ap.dao_onchain_address, evmRoute.chain_id);
          if (!finalizeGate.allowCapitalMovement) {
            await logGateSkip(ap.dao_onchain_address, ap.proposal_address || "", "executive", "finalize_proposal", finalizeGate, {
              chain: propChainLabel,
              chain_id: propChainId,
            });
            continue;
          }

          // Read proposal on-chain to check vote state + voting_end
          // (reuse the readExecutionRequest binary decoder pattern, but for proposals)
          // For simplicity: attempt finalize optimistically — on-chain rejects gracefully
          // if voting is still open. A successful finalize yields a tx signature.
          const finalizeRes = await callSigner({
            action: "finalize_proposal",
            dao_address: ap.dao_onchain_address,
            execution_request_address: "",
            agent_role: "executive",
            proposal_index: ap.proposal_index,
            ...evmRoute,
          });

          if (finalizeRes.ok && finalizeRes.signature) {
            autoFinalizeCount++;
            console.log(
              `[orchestrator] auto-finalized proposal #${ap.proposal_index} for ${ap.dao_onchain_address}: ${finalizeRes.signature}`,
            );
            await supabase.from("agent_action_logs").insert({
              dao_onchain_address: ap.dao_onchain_address,
              chain: propChainLabel,
              chain_id: propChainId,
              agent_role: "executive",
              action_type: "finalize_proposal",
              reasoning: `Orchestrator: automatically finalized proposal #${ap.proposal_index} (voting window closed or outcome mathematically certain). sig: ${finalizeRes.signature}`,
              constitution_check: persistedConstitutionCheck("finalize_proposal", finalizeRes.constitution_check),
              payload_hash: "",
              tx_signature: finalizeRes.signature,
              execution_request_address: ap.proposal_address || "",
              status: "completed",
              error_message: "",
              confidence_score: 100,
              risk_flags: [],
              decision: "finalize",
              claude_model: null,
              raw_claude_response: null,
              retry_count: 0,
            });
          }
          // If finalizeRes.ok is false the proposal just isn't ready yet (or was
          // already finalized) — fall through and try to bind the request.

          const amount = Number(ap.amount_base_units);
          if (!ap.asset_mint || !Number.isSafeInteger(amount) || amount <= 0) continue;

          if (ap.action_kind === "withdraw") {
            if (evmRoute.chain_id) {
              const chainId = evmRoute.chain_id;
              const targetAdapter = String(ap.program_id ?? ap.protocol_id ?? "").toLowerCase();
              const targetAsset = String(ap.asset_mint).toLowerCase();
              const candidateIdx = new Set<number>();
              const { data: priorDeployProps } = await supabase
                .from("agent_proposals")
                .select("proposal_index, execution_request_address")
                .eq("dao_onchain_address", ap.dao_onchain_address)
                .eq("action_kind", "deploy")
                .order("created_at", { ascending: false })
                .limit(20);
              for (const dp of priorDeployProps ?? []) {
                if (typeof dp.proposal_index === "number") candidateIdx.add(dp.proposal_index);
                const parsed = dp.execution_request_address ? parseEvmErKey(String(dp.execution_request_address)) : null;
                if (parsed) candidateIdx.add(parsed.index);
              }
              const { data: priorLogs } = await supabase
                .from("agent_action_logs")
                .select("execution_request_address")
                .eq("dao_onchain_address", ap.dao_onchain_address)
                .not("execution_request_address", "is", null)
                .order("created_at", { ascending: false })
                .limit(25);
              for (const pl of priorLogs ?? []) {
                const parsed = pl.execution_request_address ? parseEvmErKey(String(pl.execution_request_address)) : null;
                if (parsed) candidateIdx.add(parsed.index);
              }
              const maxIdx = Math.min(Number(ap.proposal_index) + 1, 25);
              for (let i = 0; i <= maxIdx; i++) candidateIdx.add(i);

              let activeReq: EvmOnChainRequest | null = null;
              for (const idx of candidateIdx) {
                const req = await readEvmExecutionRequest(chainId, ap.dao_onchain_address, idx);
                if (!req || req.status !== "Executed") continue;
                const adapterMatch = !targetAdapter || req.protocolProgram.toLowerCase() === targetAdapter;
                const assetMatch = !targetAsset || req.mint.toLowerCase() === targetAsset;
                if (adapterMatch && assetMatch) {
                  activeReq = req;
                  break;
                }
              }
              if (!activeReq) continue;

              const adapterAddr = activeReq.protocolProgram;
              const pos = await readEvmPositionAccounting(chainId, ap.dao_onchain_address, adapterAddr);
              const liveVal = pos && pos.currentValueBaseUnits > 0 ? pos.currentValueBaseUnits : activeReq.amount;
              const cappedAmount = Math.min(amount, liveVal);
              if (!(cappedAmount > 0)) continue;

              const erKey = evmErKey(activeReq.executionAddress, activeReq.index);
              const withdrawRes = await callSigner({
                action: "withdraw_from_strategy",
                dao_address: ap.dao_onchain_address,
                execution_request_address: erKey,
                agent_role: "executive",
                protocol_id: adapterAddr,
                amount: cappedAmount,
                min_out: evmPositiveMinOut(cappedAmount),
                purpose: "auto_withdraw",
                expected_payload_hash: activeReq.payloadHash,
                payload_hash: activeReq.payloadHash,
                chain: propChainLabel,
                chain_id: chainId,
                execution_address: activeReq.executionAddress,
                index: activeReq.index,
              });

              await supabase.from("agent_action_logs").insert({
                dao_onchain_address: ap.dao_onchain_address,
                chain: propChainLabel,
                chain_id: propChainId,
                agent_role: "executive",
                action_type: "withdraw_from_strategy",
                reasoning: withdrawRes.ok
                  ? `Orchestrator: executed passed withdraw proposal #${ap.proposal_index} (${cappedAmount} base units from ${adapterAddr}, tx ${withdrawRes.signature}).`
                  : `Orchestrator: passed withdraw proposal #${ap.proposal_index} failed: ${withdrawRes.error}`,
                constitution_check: persistedConstitutionCheck("withdraw_from_strategy", withdrawRes.constitution_check),
                payload_hash: activeReq.payloadHash,
                tx_signature: withdrawRes.signature || "",
                execution_request_address: erKey,
                status: withdrawRes.ok ? "completed" : "failed",
                error_message: withdrawRes.error || "",
                confidence_score: 100,
                risk_flags: [],
                decision: "withdraw",
                claude_model: null,
                raw_claude_response: null,
                retry_count: 0,
              });

              if (withdrawRes.ok) {
                await supabase
                  .from("agent_proposals")
                  .update({
                    status: "requested",
                    execution_request_address: erKey,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", ap.id);
              }
            } else {
              const candidateErs = new Set<string>();
              const { data: priorSolProps } = await supabase
                .from("agent_proposals")
                .select("execution_request_address")
                .eq("dao_onchain_address", ap.dao_onchain_address)
                .eq("action_kind", "deploy")
                .not("execution_request_address", "is", null)
                .order("created_at", { ascending: false })
                .limit(20);
              for (const dp of priorSolProps ?? []) {
                if (dp.execution_request_address) candidateErs.add(String(dp.execution_request_address));
              }
              const { data: priorSolLogs } = await supabase
                .from("agent_action_logs")
                .select("execution_request_address")
                .eq("dao_onchain_address", ap.dao_onchain_address)
                .not("execution_request_address", "is", null)
                .order("created_at", { ascending: false })
                .limit(25);
              for (const pl of priorSolLogs ?? []) {
                const er = String(pl.execution_request_address ?? "");
                if (er && !er.startsWith("0x")) candidateErs.add(er);
              }
              for (const er of await enumerateDaoExecutionRequests(ap.dao_onchain_address)) {
                candidateErs.add(er);
              }

              let activeSolEr = "";
              let activeSolReq: OnChainRequest | null = null;
              for (const erAddr of candidateErs) {
                const req = await readExecutionRequest(erAddr);
                if (!req || req.status !== "Executed") continue;
                const reqProto = protocolIdForProgram(req.protocolProgram);
                const protoMatch =
                  (!ap.protocol_id || reqProto === ap.protocol_id) ||
                  (!ap.program_id || req.protocolProgram === ap.program_id);
                const mintMatch = !ap.asset_mint || req.mint === ap.asset_mint;
                if (protoMatch && mintMatch) {
                  activeSolEr = erAddr;
                  activeSolReq = req;
                  break;
                }
              }
              if (!activeSolEr || !activeSolReq) continue;

              const protocolId = ap.protocol_id ?? protocolIdForProgram(activeSolReq.protocolProgram);
              if (!protocolId) continue;

              const pos = await readPositionAccounting(ap.dao_onchain_address, protocolId, activeSolReq.mint);
              const liveVal = pos && pos.currentValueBaseUnits > 0 ? pos.currentValueBaseUnits : activeSolReq.amount;
              const cappedAmount = Math.min(amount, liveVal);
              if (!(cappedAmount > 0)) continue;

              const recall = await recallFromVenue(ap.dao_onchain_address, activeSolEr, protocolId, activeSolReq.mint);
              if (!recall.ok) {
                errors.push({
                  dao: ap.dao_onchain_address,
                  er: activeSolEr,
                  error: `withdraw proposal recall failed: ${recall.error}`,
                });
                continue;
              }

              const withdrawRes = await callSigner({
                action: "withdraw_from_strategy",
                dao_address: ap.dao_onchain_address,
                execution_request_address: activeSolEr,
                agent_role: "executive",
                protocol_id: protocolId,
                amount: cappedAmount,
                purpose: "auto_withdraw",
                expected_payload_hash: activeSolReq.payloadHash,
                payload_hash: activeSolReq.payloadHash,
              });

              await supabase.from("agent_action_logs").insert({
                dao_onchain_address: ap.dao_onchain_address,
                chain: propChainLabel,
                chain_id: propChainId,
                agent_role: "executive",
                action_type: "withdraw_from_strategy",
                reasoning: withdrawRes.ok
                  ? `Orchestrator: executed passed withdraw proposal #${ap.proposal_index} (${cappedAmount} base units from ${protocolId}, sig ${withdrawRes.signature}).`
                  : `Orchestrator: passed withdraw proposal #${ap.proposal_index} failed: ${withdrawRes.error}`,
                constitution_check: persistedConstitutionCheck("withdraw_from_strategy", withdrawRes.constitution_check),
                payload_hash: activeSolReq.payloadHash,
                tx_signature: withdrawRes.signature || "",
                execution_request_address: activeSolEr,
                status: withdrawRes.ok ? "completed" : "failed",
                error_message: withdrawRes.error || "",
                confidence_score: 100,
                risk_flags: [],
                decision: "withdraw",
                claude_model: null,
                raw_claude_response: null,
                retry_count: 0,
              });

              if (withdrawRes.ok) {
                await supabase
                  .from("agent_proposals")
                  .update({
                    status: "requested",
                    execution_request_address: activeSolEr,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", ap.id);
              }
            }
            continue;
          }

          // A passed deploy proposal becomes an execution request with the
          // same (adapter, amount, asset) it committed. The program rejects a
          // proposal that has not passed or a mismatched payload.
          if (ap.action_kind !== "deploy") continue;

          // A request that already exists (an earlier run created it but could
          // not record it) is recorded instead of created again.
          let existingRequest = "";
          if (evmRoute.chain_id) {
            const onchainReq = await readEvmExecutionRequest(evmRoute.chain_id, ap.dao_onchain_address, Number(ap.proposal_index));
            if (onchainReq) existingRequest = evmErKey(onchainReq.executionAddress, Number(ap.proposal_index));
          } else {
            const rpcUrl = Deno.env.get("SOLANA_RPC_URL") ?? "";
            const pda = executionRequestForProposal(ap.dao_onchain_address, Number(ap.proposal_index));
            if (rpcUrl && (await accountExists(rpcUrl, pda)) === true) existingRequest = pda;
          }
          if (existingRequest) {
            await supabase
              .from("agent_proposals")
              .update({ status: "requested", execution_request_address: existingRequest, updated_at: new Date().toISOString() })
              .eq("id", ap.id);
            continue;
          }

          const requestRes = await callSigner({
            action: "create_strategy_request",
            dao_address: ap.dao_onchain_address,
            execution_request_address: "",
            agent_role: "planner",
            proposal_index: ap.proposal_index,
            protocol_id: ap.protocol_id ?? undefined,
            amount,
            mint: ap.asset_mint,
            adapter: ap.program_id ?? undefined,
            asset: ap.asset_mint,
            ...evmRoute,
          });
          if (requestRes.ok) {
            await supabase
              .from("agent_proposals")
              .update({
                status: "requested",
                execution_request_address: requestRes.execution_request_address ?? "",
                updated_at: new Date().toISOString(),
              })
              .eq("id", ap.id);
            console.log(
              `[orchestrator] created execution request for proposal #${ap.proposal_index} on ${ap.dao_onchain_address}: ${requestRes.signature}`,
            );
            await supabase.from("agent_action_logs").insert({
              dao_onchain_address: ap.dao_onchain_address,
              chain: propChainLabel,
              chain_id: propChainId,
              agent_role: "operational",
              action_type: "create_strategy_request",
              reasoning: `Orchestrator: bound passed proposal #${ap.proposal_index} to its execution request. sig: ${requestRes.signature}`,
              constitution_check: persistedConstitutionCheck("create_strategy_request", requestRes.constitution_check),
              payload_hash: "",
              tx_signature: requestRes.signature ?? "",
              execution_request_address: requestRes.execution_request_address ?? "",
              status: "completed",
              error_message: "",
              confidence_score: 100,
              risk_flags: [],
              decision: "create_request",
              claude_model: null,
              raw_claude_response: null,
              retry_count: 0,
            });
          }
        }
      }
    } catch (autoFinalizeErr) {
      console.warn(
        "[orchestrator] auto-finalize pass failed (non-fatal):",
        autoFinalizeErr instanceof Error ? autoFinalizeErr.message : autoFinalizeErr,
      );
    }

    return jsonResponse({
      success: true,
      dispatched: results.length,
      work_capped: workCapped,
      auto_finalized: autoFinalizeCount,
      bundled_rebalances: bundledRebalances,
      results,
      errors,
      gated,
      reconciled,
      parked_missing_key: parkedMissingKey.length,
      review_wakes: reviewWakes,
    });
  } catch (error) {
    console.error("agent-orchestrator error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
