// Shared GenLayer charter / venue / halt judgment.
//
// One case shape for Solana, Ethereum, Base, Robinhood, and Arc. Custody stays
// on the treasury chain. This module never talks to a signer and never treats an
// assistant paragraph as the verdict.
//
// Flags (all default off):
//   NAVE_GENLAYER_GATE       — charter is fail-closed for signing roles
//   NAVE_GENLAYER_VENUE_GATE — a venue "stop" withholds new deploys
//   NAVE_GENLAYER_HALT_GATE  — keep_pause blocks clear_halt
// When a flag is unset or not "true", the check is recorded and does not block.

export type ChainFamily = "solana" | "ethereum" | "base" | "robinhood" | "arc";
export type GenNetwork = "mainnet" | "testnet" | "devnet";
export type CustomerStatus = "checked" | "needs_closer_look" | "still_checking";
export type CharterDecision = "pass" | "fail";
export type VenueStatus = "fine" | "watch" | "stop";
export type HaltDecision = "keep_pause" | "lift_pause";
export type ReviewKind = "charter" | "venue" | "halt";

export const CHAIN_FAMILIES: readonly ChainFamily[] = ["solana", "ethereum", "base", "robinhood", "arc"];
export const GEN_NETWORKS: readonly GenNetwork[] = ["mainnet", "testnet", "devnet"];

export const NAVE_GENLAYER_GATE = "NAVE_GENLAYER_GATE";
export const NAVE_GENLAYER_VENUE_GATE = "NAVE_GENLAYER_VENUE_GATE";
export const NAVE_GENLAYER_HALT_GATE = "NAVE_GENLAYER_HALT_GATE";

/** Exact customer words. The main journey uses these and no other charter labels. */
export const CUSTOMER_STATUS_LABEL: Record<CustomerStatus, string> = {
  checked: "Checked",
  needs_closer_look: "Needs a closer look",
  still_checking: "Still checking",
};

export const ASK_ANOTHER_CHECK_LABEL = "Ask for another check";
export const HOW_CHECKED_LABEL = "How this was checked";

const FORBIDDEN_INPUT_KEYS = new Set([
  "reasoning",
  "reasoning_summary",
  "assistant",
  "assistant_text",
  "verdict",
  "essay",
  "paragraph",
  "finished_paragraph",
  "model_output",
  "decision",
  "summary",
]);

export interface CharterView {
  decision: CharterDecision | "";
  rule_ids: string[];
  summary: string;
  finished: boolean;
  provisional: boolean;
  action_hash: string;
}

export interface VenueView {
  status: VenueStatus;
  venue_id: string;
  summary: string;
  finished: boolean;
}

export interface HaltView {
  decision: HaltDecision;
  summary: string;
  finished: boolean;
  action_hash: string;
}

export interface GenlayerView {
  chain_family?: ChainFamily;
  charter?: CharterView | null;
  venue?: VenueView | null;
  halt?: HaltView | null;
}

export interface PublicCharterInput {
  chain_family: ChainFamily;
  network: GenNetwork;
  treasury: string;
  action_hash: string;
  mandate_hash?: string;
  mandate_text?: string;
  constitution_hash?: string;
  constitution_json?: string;
  venue?: string;
  amount?: string;
  asset?: string;
  evidence_url?: string;
  status_url?: string;
  pause_reason?: string;
  counterevidence?: string;
}

export interface GateOutcome {
  block: boolean;
  indeterminate: boolean;
  /** Flag off (or not applicable): recorded, not a signing block. */
  recordedOnly: boolean;
  detail: string;
}

export interface HaltAppealEffect {
  /** Always false. lift_pause never authorizes operational_clear. */
  maySignOperationalClear: false;
  /** Always false. lift_pause never shortens the review window. */
  shortensReviewWindow: false;
  blockClear: boolean;
}

export function readGenlayerFlag(name: string): boolean {
  try {
    const g = globalThis as {
      Deno?: { env: { get(key: string): string | undefined } };
      process?: { env?: Record<string, string | undefined> };
    };
    const raw = g.Deno?.env.get(name) ?? g.process?.env?.[name] ?? "false";
    return raw.toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function isChainFamily(value: string): value is ChainFamily {
  return (CHAIN_FAMILIES as readonly string[]).includes(value);
}

export function isGenNetwork(value: string): value is GenNetwork {
  return (GEN_NETWORKS as readonly string[]).includes(value);
}

/** EVM addresses are lowercased; Solana base58 is left as trimmed. */
export function treasuryKey(family: ChainFamily, treasury: string): string {
  const trimmed = treasury.trim();
  if (family === "solana") return trimmed;
  return trimmed.toLowerCase();
}

export function chainFamilyFrom(chain?: string | null, chainId?: number | null): ChainFamily {
  const c = (chain ?? "").toLowerCase();
  if (isChainFamily(c)) return c;
  if (chainId === 1 || chainId === 11155111) return "ethereum";
  if (chainId === 8453 || chainId === 84532) return "base";
  if (chainId === 4663 || chainId === 46630) return "robinhood";
  if (chainId === 5042002) return "arc";
  return "solana";
}

export function networkForSigner(args: {
  chainFamily: ChainFamily;
  chainId?: number | null;
  solanaRpcUrl?: string;
}): GenNetwork {
  if (args.chainFamily === "solana") {
    return (args.solanaRpcUrl ?? "").toLowerCase().includes("mainnet") ? "mainnet" : "devnet";
  }
  // Arc has a testnet id only. Chain id 5042 is not a Nave network.
  if (args.chainFamily === "arc") return "testnet";
  const id = args.chainId;
  if (id === 1 || id === 8453 || id === 4663) return "mainnet";
  return "testnet";
}

export function caseId(input: Pick<PublicCharterInput, "chain_family" | "network" | "treasury" | "action_hash">): string {
  const treasury = treasuryKey(input.chain_family, input.treasury);
  return [
    "nave",
    input.chain_family,
    input.network,
    treasury,
    input.action_hash.trim().toLowerCase(),
  ].join(":");
}

const EVIDENCE_KEYS = new Set([
  "mandate_text",
  "constitution_json",
  "pause_reason",
  "counterevidence",
  "evidence_url",
  "status_url",
]);

/** 64 hex characters, with or without a 0x prefix. */
export function isActionHash(value: string | null | undefined): boolean {
  const text = (value ?? "").trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(text);
}

export function normalizeActionHash(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

const COUNTEREVIDENCE_VERDICTS = new Set([
  "keep_pause",
  "lift_pause",
  "pass",
  "fail",
  "checked",
  "finalized",
  "lift",
  "keep",
]);

/**
 * Blank counterevidence is not a second check. HaltAppeal stores keep_pause
 * for a blank appeal, so the app must not send one.
 */
export function counterevidenceError(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  const token = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (token !== "" && COUNTEREVIDENCE_VERDICTS.has(token)) return "A prewritten decision is not evidence";
  if (text.length < 12) return "counterevidence is missing";
  return null;
}

/**
 * Status pages for the venues this testing environment actually uses.
 * Balancer is omitted. Jito's docs stand in for a status page because
 * jito.network answers 403 to automated reads. status.kamino.finance and
 * status.compound.finance do not resolve. status.getcompound.ai is a different
 * product.
 */
export const VENUE_STATUS_TARGETS: readonly {
  venue:
    | "kamino"
    | "jito"
    | "aave-v3"
    | "compound-v3"
    | "morpho-steakhouse-usdg"
    | "morpho-steakhouse-usdc";
  families: readonly ChainFamily[];
  statusUrl: string;
}[] = [
  {
    venue: "kamino",
    families: ["solana"],
    statusUrl: "https://kamino.com/docs/security.md",
  },
  {
    venue: "jito",
    families: ["solana"],
    statusUrl: "https://jito-foundation.gitbook.io/jitosol",
  },
  {
    venue: "aave-v3",
    families: ["ethereum", "base"],
    statusUrl: "https://status.aave.com/api/v2/summary.json",
  },
  {
    venue: "compound-v3",
    families: ["ethereum"],
    statusUrl: "https://docs.compound.xyz/",
  },
  {
    venue: "morpho-steakhouse-usdg",
    families: ["robinhood"],
    statusUrl: "https://docs.morpho.org/",
  },
  {
    venue: "morpho-steakhouse-usdc",
    families: ["arc"],
    statusUrl: "https://docs.morpho.org/",
  },
];

export interface VenueWatchJob {
  chain_family: ChainFamily;
  network: GenNetwork;
  treasury: string;
  venue: string;
  status_url: string;
}

/** One venue review per testing-environment treasury. Mainnet and Balancer are left out. */
export function venueWatchJobs(
  daos: ReadonlyArray<{ treasury: string; chain: string; network: string }>,
): VenueWatchJob[] {
  const jobs: VenueWatchJob[] = [];
  for (const dao of daos) {
    const family = dao.chain.trim().toLowerCase();
    const network = dao.network.trim().toLowerCase();
    if (!isChainFamily(family) || !isGenNetwork(network) || network === "mainnet") continue;
    for (const target of VENUE_STATUS_TARGETS) {
      if (!(target.families as readonly string[]).includes(family)) continue;
      const treasury = treasuryKey(family, dao.treasury);
      if (!treasury) continue;
      jobs.push({
        chain_family: family,
        network,
        treasury,
        venue: target.venue,
        status_url: target.statusUrl,
      });
    }
  }
  return jobs;
}

/** RPC and contract inputs. No verdict, essay, or assistant text. */
export function charterRpcParams(input: PublicCharterInput): Record<string, string> {
  const params: Record<string, string> = {
    case_id: caseId(input),
    chain_family: input.chain_family,
    network: input.network,
    treasury: treasuryKey(input.chain_family, input.treasury),
    action_hash: input.action_hash.trim(),
    mandate_hash: input.mandate_hash ?? "",
    constitution_hash: input.constitution_hash ?? "",
    venue: input.venue ?? "",
    amount: input.amount ?? "",
    asset: input.asset ?? "",
  };
  if (input.mandate_text) params.mandate_text = input.mandate_text;
  if (input.constitution_json) params.constitution_json = input.constitution_json;
  if (input.evidence_url) params.evidence_url = input.evidence_url;
  if (input.status_url) params.status_url = input.status_url;
  if (input.pause_reason) params.pause_reason = input.pause_reason;
  if (input.counterevidence) params.counterevidence = input.counterevidence;
  return params;
}

function forbiddenKey(key: string): boolean {
  return FORBIDDEN_INPUT_KEYS.has(key.toLowerCase().replace(/[\s-]+/g, "_"));
}

/** Reject a body that tries to submit a finished paragraph as the verdict. */
export function publicInputsError(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Missing case.";
  const walk = (value: unknown, depth: number): string | null => {
    if (depth > 4 || value == null) return null;
    if (typeof value === "string" && value.trim().length > 8000) {
      return "This check accepts the case id and public inputs only.";
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const err = walk(item, depth + 1);
        if (err) return err;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (forbiddenKey(key) && child != null && String(child).trim() !== "") {
          return "This check accepts the case id and public inputs only.";
        }
        if (typeof child === "string" && child.trim().length > 280 && !EVIDENCE_KEYS.has(key.toLowerCase())) {
          return "This check accepts the case id and public inputs only.";
        }
        const err = walk(child, depth + 1);
        if (err) return err;
      }
    }
    return null;
  };
  return walk(body, 0);
}

export function parsePublicCase(body: Record<string, unknown>): { ok: true; input: PublicCharterInput } | { ok: false; error: string } {
  const rejected = publicInputsError(body);
  if (rejected) return { ok: false, error: rejected };
  const family = String(body.chain_family ?? "").toLowerCase();
  const network = String(body.network ?? "").toLowerCase();
  const treasury = String(body.treasury ?? "").trim();
  const actionHash = String(body.action_hash ?? "").trim();
  if (!isChainFamily(family)) return { ok: false, error: "chain_family must be solana, ethereum, base, robinhood, or arc." };
  if (!isGenNetwork(network)) return { ok: false, error: "network must be mainnet, testnet, or devnet." };
  if (!treasury) return { ok: false, error: "treasury is required." };
  if (!actionHash) return { ok: false, error: "action_hash is required." };
  return {
    ok: true,
    input: {
      chain_family: family,
      network,
      treasury,
      action_hash: actionHash,
      mandate_hash: stringField(body.mandate_hash),
      mandate_text: stringField(body.mandate_text),
      constitution_hash: stringField(body.constitution_hash),
      constitution_json: constitutionJsonField(body.constitution_json),
      venue: stringField(body.venue),
      amount: stringField(body.amount),
      asset: stringField(body.asset),
      evidence_url: stringField(body.evidence_url),
      status_url: stringField(body.status_url),
      pause_reason: stringField(body.pause_reason),
      counterevidence: stringField(body.counterevidence),
    },
  };
}

function constitutionJsonField(value: unknown): string | undefined {
  if (typeof value === "string") return stringField(value);
  if (value && typeof value === "object") return JSON.stringify(value);
  return undefined;
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A finished pass is Checked. A finished fail needs a closer look.
 * An accepted result, including an accepted fail, is still checking.
 */
export function customerStatus(
  charter: { decision?: string; finished?: boolean; provisional?: boolean } | null | undefined,
): CustomerStatus {
  if (!charter) return "still_checking";
  const done = charter.finished === true && charter.provisional !== true;
  if (!done) return "still_checking";
  if (charter.decision === "fail") return "needs_closer_look";
  if (charter.decision === "pass") return "checked";
  return "still_checking";
}

const JARGON = /\b(genlayer|finalized|equivalence|appeal bond|chain id)\b/i;

/** One everyday sentence for a failed check. Drops protocol jargon. */
export function everydaySentence(summary: string | null | undefined): string {
  const text = (summary ?? "").replace(/\s+/g, " ").trim();
  const one = text.split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
  if (!one || JARGON.test(one) || one.length > 220) {
    return "This move does not fit the treasury's rules.";
  }
  return /[.!?]$/.test(one) ? one : `${one}.`;
}

const CHALLENGEABLE = new Set(["pending", "accepted", "provisional", "appealed", "undetermined"]);
const CLOSED = new Set(["final", "finalized", "unchallengeable"]);

/** A provisional accept is not finished, even if a caller sets finished=true. */
export function reviewFinished(raw: { finished?: boolean; provisional?: boolean; status?: string } | null | undefined): boolean {
  if (!raw) return false;
  if (raw.provisional === true) return false;
  const status = (raw.status ?? "").toLowerCase();
  if (CHALLENGEABLE.has(status)) return false;
  if (CLOSED.has(status)) return true;
  return raw.finished === true;
}

export function charterSatisfies(
  charter: CharterView | null | undefined,
  expectedActionHash: string,
): boolean {
  if (!charter) return false;
  if (charter.decision !== "pass") return false;
  if (!charter.finished || charter.provisional) return false;
  // Stored hashes drop the 0x prefix; EVM payload hashes carry it.
  const expected = expectedActionHash.trim().toLowerCase().replace(/^0x/, "");
  const got = charter.action_hash.trim().toLowerCase().replace(/^0x/, "");
  if (!expected || !got) return false;
  return expected === got;
}

export function charterGateOutcome(args: {
  gateOn: boolean;
  signing: boolean;
  expectedActionHash: string;
  charter: CharterView | null | undefined;
}): GateOutcome {
  const label = CUSTOMER_STATUS_LABEL[customerStatus(args.charter)];
  if (!args.gateOn) {
    return {
      block: false,
      indeterminate: !args.charter,
      recordedOnly: true,
      detail: `charter recorded (${label}); ${NAVE_GENLAYER_GATE} off`,
    };
  }
  if (!args.signing) {
    return {
      block: false,
      indeterminate: !args.charter,
      recordedOnly: true,
      detail: `charter recorded (${label}); not a signing role`,
    };
  }
  if (!args.charter) {
    return {
      block: true,
      indeterminate: true,
      recordedOnly: false,
      detail: "charter check missing — fail-closed",
    };
  }
  if (!args.charter.finished || args.charter.provisional) {
    return {
      block: true,
      indeterminate: true,
      recordedOnly: false,
      detail: "charter review not finished — a provisional accept does not unlock a signature",
    };
  }
  if (args.charter.decision === "fail") {
    return {
      block: true,
      indeterminate: false,
      recordedOnly: false,
      detail: everydaySentence(args.charter.summary),
    };
  }
  if (args.charter.decision !== "pass") {
    return {
      block: true,
      indeterminate: true,
      recordedOnly: false,
      detail: "charter review not finished — a provisional accept does not unlock a signature",
    };
  }
  if (!charterSatisfies(args.charter, args.expectedActionHash)) {
    return {
      block: true,
      indeterminate: false,
      recordedOnly: false,
      detail: "charter pass does not match this action",
    };
  }
  return {
    block: false,
    indeterminate: false,
    recordedOnly: false,
    detail: "finished charter pass matches this action",
  };
}

export function venueGateOutcome(args: {
  gateOn: boolean;
  isDeploy: boolean;
  venue: Pick<VenueView, "status" | "finished"> | null | undefined;
}): GateOutcome {
  if (!args.isDeploy) {
    return { block: false, indeterminate: false, recordedOnly: true, detail: "not a new deploy (n/a)" };
  }
  const status = args.venue?.status ?? "unknown";
  if (!args.gateOn) {
    return {
      block: false,
      indeterminate: !args.venue,
      recordedOnly: true,
      detail: `venue ${status} recorded; ${NAVE_GENLAYER_VENUE_GATE} off`,
    };
  }
  if (args.venue?.status === "stop" && args.venue.finished === true) {
    return {
      block: true,
      indeterminate: false,
      recordedOnly: false,
      detail: "venue stop withholds this deploy",
    };
  }
  return {
    block: false,
    indeterminate: false,
    recordedOnly: false,
    detail: `venue ${status}`,
  };
}

/** lift_pause never signs operational_clear and never shortens the review window. */
export function haltAppealEffect(halt: { decision?: string } | null | undefined): HaltAppealEffect {
  return {
    maySignOperationalClear: false,
    shortensReviewWindow: false,
    blockClear: halt?.decision === "keep_pause",
  };
}

export function haltGateOutcome(args: {
  gateOn: boolean;
  clearing: boolean;
  halt: { decision?: string; finished?: boolean } | null | undefined;
}): GateOutcome {
  const effect = haltAppealEffect(args.halt?.finished === false ? null : args.halt);
  const note = "lift_pause does not sign operational_clear and does not shorten the review window";
  if (!args.clearing) {
    return { block: false, indeterminate: false, recordedOnly: true, detail: "not a clear (n/a)" };
  }
  if (!args.gateOn) {
    return {
      block: false,
      indeterminate: !args.halt,
      recordedOnly: true,
      detail: `halt appeal recorded; ${NAVE_GENLAYER_HALT_GATE} off; ${note}`,
    };
  }
  if (effect.blockClear) {
    return {
      block: true,
      indeterminate: false,
      recordedOnly: false,
      detail: "keep_pause blocks clear_halt",
    };
  }
  return { block: false, indeterminate: false, recordedOnly: false, detail: note };
}

export interface ReviewRow {
  kind?: string;
  decision?: string;
  finished?: boolean;
  provisional?: boolean;
  rule_ids?: string[] | null;
  summary?: string | null;
  venue_status?: string | null;
  action_hash?: string | null;
  tx_id?: string | null;
}

function asDecision(value: string | undefined): CharterDecision | "" {
  if (value === "pass" || value === "fail") return value;
  return "";
}

function hashesEqual(a: string | null | undefined, b: string): boolean {
  const left = (a ?? "").trim().toLowerCase().replace(/^0x/, "");
  const right = b.trim().toLowerCase().replace(/^0x/, "");
  return left !== "" && left === right;
}

export function viewFromRows(
  rows: ReviewRow[],
  args: { chainFamily: ChainFamily; actionHash: string; protocolId?: string | null },
): GenlayerView {
  const actionHash = args.actionHash.trim();
  const charterRow = rows.find((row) => row.kind === "charter" && hashesEqual(row.action_hash, actionHash));
  const haltRow = rows.find((row) => row.kind === "halt" && (!actionHash || hashesEqual(row.action_hash, actionHash)));
  const venues = rows.filter((row) => row.kind === "venue");
  const protocol = (args.protocolId ?? "").trim().toLowerCase();
  const venueRow = protocol
    ? venues.find((row) => (row.action_hash ?? "").trim().toLowerCase() === protocol)
    : venues.find((row) => row.venue_status === "stop") ?? venues[0];

  const charter: CharterView | null = charterRow
    ? {
      decision: asDecision(charterRow.decision),
      rule_ids: Array.isArray(charterRow.rule_ids) ? charterRow.rule_ids.filter((id) => typeof id === "string") : [],
      summary: charterRow.summary ?? "",
      finished: charterRow.finished === true,
      provisional: charterRow.provisional === true,
      action_hash: charterRow.action_hash ?? "",
    }
    : null;

  const venueStatus = venueRow?.venue_status;
  const venue: VenueView | null = venueRow && (venueStatus === "fine" || venueStatus === "watch" || venueStatus === "stop")
    ? {
      status: venueStatus,
      venue_id: venueRow.action_hash ?? "",
      summary: venueRow.summary ?? "",
      finished: venueRow.finished === true,
    }
    : null;

  const haltDecision = haltRow?.decision;
  const halt: HaltView | null = haltRow && (haltDecision === "keep_pause" || haltDecision === "lift_pause")
    ? {
      decision: haltDecision,
      summary: haltRow.summary ?? "",
      finished: haltRow.finished === true,
      action_hash: haltRow.action_hash ?? "",
    }
    : null;

  return { chain_family: args.chainFamily, charter, venue, halt };
}

export interface InterpretedCharter {
  decision: CharterDecision | "";
  rule_ids: string[];
  summary: string;
  finished: boolean;
  provisional: boolean;
  action_hash: string;
  tx_id: string;
  customer_status: CustomerStatus;
}

/** A contract read may arrive as a JSON string or one wrapper object. */
export function contractRecord(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return {};
    try {
      value = JSON.parse(text);
    } catch {
      return {};
    }
  }
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  if (obj.decision === "pass" || obj.decision === "fail" || obj.decision === "keep_pause" || obj.decision === "lift_pause" || obj.status === "fine" || obj.status === "watch" || obj.status === "stop") {
    return obj;
  }
  for (const key of ["result", "data", "case"]) {
    const inner = obj[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  return obj;
}

/**
 * A later read that loses the verdict must not erase a pass or fail already
 * stored for the same transaction.
 */
export function mergeStoredCharter<T extends {
  decision: string;
  summary: string;
  finished: boolean;
  provisional: boolean;
  customer_status: string;
  rule_ids: string[];
  tx_id: string;
}>(incoming: T, stored: {
  decision?: string | null;
  summary?: string | null;
  finished?: boolean | null;
  provisional?: boolean | null;
  customer_status?: string | null;
  rule_ids?: string[] | null;
  tx_id?: string | null;
} | null): T {
  if (incoming.decision === "pass" || incoming.decision === "fail") return incoming;
  const decision = stored?.decision === "pass" || stored?.decision === "fail" ? stored.decision : "";
  if (!decision || (stored?.tx_id ?? "") !== incoming.tx_id) return incoming;
  const customer = stored?.customer_status === "checked" || stored?.customer_status === "needs_closer_look"
    ? stored.customer_status
    : incoming.customer_status;
  return {
    ...incoming,
    decision,
    summary: typeof stored?.summary === "string" && stored.summary.trim() ? stored.summary : incoming.summary,
    finished: stored?.finished === true,
    provisional: stored?.provisional === true,
    customer_status: customer,
    rule_ids: Array.isArray(stored?.rule_ids) ? stored.rule_ids : incoming.rule_ids,
  };
}

/** Read a contract result. Essays are dropped. A provisional accept stays unfinished. */
export function interpretCharterResponse(raw: unknown, expectedActionHash: string): InterpretedCharter {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const status = typeof obj.status === "string" ? obj.status : "";
  const provisional = obj.provisional === true || CHALLENGEABLE.has(status.toLowerCase());
  const finished = reviewFinished({
    finished: obj.finished === true,
    provisional,
    status,
  });
  const decision = obj.decision === "pass" || obj.decision === "fail" ? obj.decision : "";
  const echoed = typeof obj.action_hash === "string" ? obj.action_hash.trim() : "";
  const bound = echoed.toLowerCase() === expectedActionHash.trim().toLowerCase() && echoed !== "";
  const ruleIds = Array.isArray(obj.rule_ids)
    ? obj.rule_ids.filter((id): id is string => typeof id === "string")
    : [];
  const rawSummary = typeof obj.summary === "string" ? obj.summary.replace(/\s+/g, " ").trim() : "";
  // A pass keeps the contract's one sentence. Any other pass text is an essay and is dropped.
  const summary = decision === "fail"
    ? everydaySentence(rawSummary)
    : (rawSummary === "This move fits the treasury rules." ? rawSummary : "");
  const txId = typeof obj.tx_id === "string"
    ? obj.tx_id
    : typeof obj.transaction_hash === "string"
      ? obj.transaction_hash
      : "";
  const view: CharterView = {
    decision,
    rule_ids: ruleIds,
    summary,
    finished: finished && (decision === "fail" || bound),
    provisional: provisional || !bound,
    action_hash: echoed || expectedActionHash,
  };
  if (!bound && decision === "pass") {
    view.finished = false;
    view.provisional = true;
  }
  return {
    decision: view.decision,
    rule_ids: view.rule_ids,
    summary: view.summary,
    finished: view.finished,
    provisional: view.provisional,
    action_hash: view.action_hash,
    tx_id: txId,
    customer_status: customerStatus(view),
  };
}

/** Hide the status until a review exists. An empty row is not "Still checking". */
export function screenStatus(row: {
  decision?: string | null;
  finished?: boolean | null;
  provisional?: boolean | null;
  tx_id?: string | null;
} | null | undefined): CustomerStatus | null {
  if (!row) return null;
  const decision = (row.decision ?? "").trim();
  const tx = (row.tx_id ?? "").trim();
  if (!decision && !tx) return null;
  return customerStatus({
    decision,
    finished: row.finished === true,
    provisional: row.provisional === true,
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const EVM_STABLE_ASSETS = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0x6b175474e89094c44da98b954eedeac495271d0f",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8",
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f",
  "0x3600000000000000000000000000000000000000",
  "0xaaae26c5b891bf00d4cd6ef04148bf1cb1cc96b1",
]);

const EVM_OTHER_ASSETS = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  "0x4200000000000000000000000000000000000006",
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22",
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  "0x7943e237c7f95da44e0301572d358911207852fa",
]);

/** True or false when this mint is on the product allowlist. Unknown stays unknown. */
export function assetIsStable(mint: string, solanaClass?: string | null): boolean | null {
  if (solanaClass === "stablecoin") return true;
  if (solanaClass === "sol-like" || solanaClass === "blue-chip" || solanaClass === "lp") return false;
  const key = mint.trim().toLowerCase();
  if (EVM_STABLE_ASSETS.has(key)) return true;
  if (EVM_OTHER_ASSETS.has(key)) return false;
  return null;
}

/**
 * Price `amountBase` token units in micro-USD using a treasury mark.
 * `totalBase` is the marked token amount (idle + deployed) and `totalMicroUsd`
 * is that same pile's last valuation. Returns null when the mark cannot price
 * the amount. Stablecoins whose base unit is already one micro-USD do not need this.
 */
export function scaleBaseToMicroUsd(
  amountBase: number,
  totalBase: number,
  totalMicroUsd: number,
): number | null {
  if (!Number.isSafeInteger(amountBase) || amountBase < 0) return null;
  if (!Number.isSafeInteger(totalBase) || totalBase <= 0) return null;
  if (!Number.isSafeInteger(totalMicroUsd) || totalMicroUsd < 0) return null;
  const scaled = (BigInt(amountBase) * BigInt(totalMicroUsd)) / BigInt(totalBase);
  const out = Number(scaled);
  return Number.isSafeInteger(out) ? out : null;
}

function wholeUnits(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return String(value);
}

function bpsValue(value: number): number | null {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) return null;
  return value;
}

function venueLabel(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 64 || text.includes(" ")) return null;
  return text;
}

/**
 * The constitution object CharterAdjudicator validates.
 * Returns null when a required number is missing, so the caller does not open a case.
 */
export function constitutionSnapshot(args: {
  approvedVenues: string[];
  venue: string;
  maxSingleAllocationBps: number;
  maxDeploymentBps: number;
  liquidityFloorBps: number;
  reserveFloorBps: number;
  navBaseUnits: number;
  deployedBaseUnits: number;
  venueDeployedBaseUnits: number;
  reserveBaseUnits: number;
  assetIsStable: boolean | null;
}): Record<string, unknown> | null {
  const venue = venueLabel(args.venue);
  const approved = args.approvedVenues.map(venueLabel).filter((item): item is string => item != null);
  if (!venue || approved.length === 0 || args.assetIsStable == null) return null;
  const maxSingle = bpsValue(args.maxSingleAllocationBps);
  const maxDeployment = bpsValue(args.maxDeploymentBps);
  const liquidity = bpsValue(args.liquidityFloorBps);
  const reserve = bpsValue(args.reserveFloorBps);
  const nav = wholeUnits(args.navBaseUnits);
  const deployed = wholeUnits(args.deployedBaseUnits);
  const venueDeployed = wholeUnits(args.venueDeployedBaseUnits);
  const reserveUnits = wholeUnits(args.reserveBaseUnits);
  if (
    maxSingle == null || maxDeployment == null || liquidity == null || reserve == null
    || nav == null || deployed == null || venueDeployed == null || reserveUnits == null
    || args.navBaseUnits <= 0 || args.deployedBaseUnits > args.navBaseUnits
  ) return null;
  return {
    approved_venues: approved,
    max_single_allocation_bps: maxSingle,
    max_deployment_bps: maxDeployment,
    liquidity_floor_bps: liquidity,
    reserve_floor_bps: reserve,
    nav_base_units: nav,
    deployed_base_units: deployed,
    venue_deployed_base_units: venueDeployed,
    liquid_base_units: String(args.navBaseUnits - args.deployedBaseUnits),
    reserve_base_units: reserveUnits,
    asset_is_stable: args.assetIsStable,
  };
}

export function mandateFromRules(rules: {
  maxSingleAllocationBps: number;
  maxDeploymentBps: number;
  liquidityFloorBps: number;
  reserveFloorBps: number;
}): string {
  const pct = (bps: number) => (bps / 100).toString();
  return `Keep at least ${pct(rules.liquidityFloorBps)} percent available. Do not put more than ${pct(rules.maxSingleAllocationBps)} percent in one venue. Do not deploy more than ${pct(rules.maxDeploymentBps)} percent of the treasury. Keep at least ${pct(rules.reserveFloorBps)} percent in stable assets when the asset is stable.`;
}

export interface ContractCall {
  method: "open_case" | "review_venue" | "open_appeal" | "get_case" | "has_case" | "get_venue" | "has_venue" | "get_appeal" | "has_appeal";
  args: string[];
}

function constitutionReady(raw: string): boolean {
  if (!raw) return false;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return Array.isArray(obj.approved_venues)
      && obj.approved_venues.length > 0
      && typeof obj.asset_is_stable === "boolean"
      && ["max_single_allocation_bps", "max_deployment_bps", "liquidity_floor_bps", "reserve_floor_bps", "nav_base_units", "deployed_base_units", "venue_deployed_base_units", "liquid_base_units", "reserve_base_units"]
        .every((key) => obj[key] != null && obj[key] !== "");
  } catch {
    return false;
  }
}

function httpsOrEmpty(value: string | undefined, label: string, required: boolean): string {
  const url = (value ?? "").trim();
  if (!url) {
    if (required) throw new Error(`${label} must be an https address`);
    return "";
  }
  if (!url.startsWith("https://") || url.includes(" ")) {
    throw new Error(`${label} must be an https address`);
  }
  return url;
}

/** Positional arguments for CharterAdjudicator.open_case. */
export async function buildOpenCaseArgs(input: PublicCharterInput): Promise<ContractCall> {
  if (!isActionHash(input.action_hash)) throw new Error("action_hash must be 64 hex characters");
  const mandate = (input.mandate_text ?? "").trim();
  if (!mandate) throw new Error("Mandate text is missing");
  const digest = await sha256Hex(mandate);
  const supplied = (input.mandate_hash ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (supplied && supplied !== digest) throw new Error("Mandate hash does not match the mandate text");
  const constitution = (input.constitution_json ?? "").trim();
  if (!constitutionReady(constitution)) throw new Error("Constitution snapshot is missing");
  const venue = (input.venue ?? "").trim();
  const amount = (input.amount ?? "").trim();
  const asset = (input.asset ?? "").trim();
  if (!venue || !amount || !asset) throw new Error("Venue, amount, and asset are required");
  const id = [
    input.chain_family,
    input.network,
    treasuryKey(input.chain_family, input.treasury),
    normalizeActionHash(input.action_hash),
  ];
  return {
    method: "open_case",
    args: [
      ...id,
      venue,
      amount,
      asset,
      mandate,
      digest,
      constitution,
      httpsOrEmpty(input.evidence_url, "Evidence url", false),
    ],
  };
}

export function buildVenueArgs(input: PublicCharterInput): ContractCall {
  const venue = (input.venue ?? "").trim();
  if (!venue) throw new Error("venue is required");
  return {
    method: "review_venue",
    args: [
      input.chain_family,
      input.network,
      venue,
      httpsOrEmpty(input.status_url, "Evidence url", true),
    ],
  };
}

export function buildHaltArgs(input: PublicCharterInput): ContractCall {
  if (!isActionHash(input.action_hash)) throw new Error("action_hash must be 64 hex characters");
  const reason = (input.pause_reason ?? "").trim();
  if (reason.length < 12) throw new Error("pause_reason is missing");
  const evidenceError = counterevidenceError(input.counterevidence);
  if (evidenceError) throw new Error(evidenceError);
  return {
    method: "open_appeal",
    args: [
      input.chain_family,
      input.network,
      treasuryKey(input.chain_family, input.treasury),
      normalizeActionHash(input.action_hash),
      reason,
      (input.counterevidence ?? "").trim(),
      (input.venue ?? "venue").trim(),
      (input.amount ?? "0").trim(),
      (input.asset ?? "asset").trim(),
    ],
  };
}

export function idArgs(input: PublicCharterInput): string[] {
  return [
    input.chain_family,
    input.network,
    treasuryKey(input.chain_family, input.treasury),
    normalizeActionHash(input.action_hash),
  ];
}

export interface ChainObservation {
  status: string;
  executionResult: string;
}

/** Accepted is not enough. Finished means FINALIZED and FINISHED_WITH_RETURN. */
export function observationFinished(obs: ChainObservation | null | undefined): boolean {
  if (!obs) return false;
  const status = obs.status.trim().toLowerCase();
  const result = obs.executionResult.trim().toLowerCase().replace(/_/g, "");
  return status === "finalized" && (result === "finishedwithreturn" || result === "1");
}

/**
 * One recorded review. `decision` is only a charter pass/fail.
 * Venue status stays on `venue_status`. Halt keep/lift stays on `halt_decision`.
 */
export interface RecordedReview {
  kind: ReviewKind;
  decision: CharterDecision | "";
  halt_decision: HaltDecision | "";
  venue_status: VenueStatus | null;
  rule_ids: string[];
  summary: string;
  finished: boolean;
  provisional: boolean;
  action_hash: string;
  tx_id: string;
  customer_status: CustomerStatus;
}

/** Column value for `genlayer_reviews.decision`. Halt uses its own verdict; venue does not. */
export function storedDecision(review: Pick<RecordedReview, "kind" | "decision" | "halt_decision">): string {
  return review.kind === "halt" ? review.halt_decision : review.decision;
}

export function reviewFromRecord(args: {
  kind: ReviewKind;
  record: unknown;
  observation: ChainObservation | null;
  actionHash: string;
  txId: string;
}): RecordedReview {
  const finished = observationFinished(args.observation);
  const obj = contractRecord(args.record);
  if (args.kind === "venue") {
    const status = obj.status === "fine" || obj.status === "watch" || obj.status === "stop" ? obj.status : null;
    const done = finished && status != null;
    return {
      kind: "venue",
      decision: "",
      halt_decision: "",
      rule_ids: [],
      summary: typeof obj.summary === "string" ? obj.summary : "",
      finished: done,
      provisional: !done,
      action_hash: args.actionHash,
      tx_id: args.txId,
      customer_status: "still_checking",
      venue_status: finished ? status : null,
    };
  }
  if (args.kind === "halt") {
    const haltDecision = obj.decision === "keep_pause" || obj.decision === "lift_pause" ? obj.decision : "";
    const done = finished && haltDecision !== "";
    return {
      kind: "halt",
      decision: "",
      halt_decision: haltDecision,
      rule_ids: [],
      summary: typeof obj.summary === "string" ? obj.summary : "",
      finished: done,
      provisional: !done,
      action_hash: args.actionHash,
      tx_id: args.txId,
      customer_status: "still_checking",
      venue_status: null,
    };
  }
  const interpreted = interpretCharterResponse(
    {
      decision: obj.decision,
      rule_ids: obj.rule_ids,
      summary: obj.summary,
      action_hash: typeof obj.action_hash === "string" ? obj.action_hash : args.actionHash,
      status: finished ? "finalized" : (args.observation?.status ?? ""),
      finished,
      provisional: !finished,
      tx_id: args.txId,
    },
    args.actionHash,
  );
  return {
    kind: "charter",
    decision: interpreted.decision,
    halt_decision: "",
    venue_status: null,
    rule_ids: interpreted.rule_ids,
    summary: interpreted.summary,
    finished: interpreted.finished,
    provisional: interpreted.provisional,
    action_hash: interpreted.action_hash,
    tx_id: interpreted.tx_id,
    customer_status: interpreted.customer_status,
  };
}
