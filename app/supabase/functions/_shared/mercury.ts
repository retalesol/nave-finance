/**
 * Mercury read-only feed rules, ported from nave-books lib/mercury.php.
 * This module never sends a token to the browser and never builds a write request.
 * Production calls use GET https://api.mercury.com/api/v1 or the sandbox host.
 */

export const MERCURY_PROD = "https://api.mercury.com/api/v1";
export const MERCURY_SANDBOX = "https://api-sandbox.mercury.com/api/v1";

const TOKEN_RE = /^secret-token:mercury_(production|sandbox)_[A-Za-z0-9_-]{8,}$/;
const ALLOWED_HOSTS = new Set(["api.mercury.com", "api-sandbox.mercury.com"]);

export class MercuryError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MercuryError";
    this.status = status;
  }
}

export type MercuryEnvironment = "sandbox" | "production";

export interface MercuryTxnView {
  amount_cents: number;
  bank_description?: string;
  external_memo?: string;
  note?: string;
  counterparty?: string;
  status?: string;
  ignored?: boolean;
}

export interface OpenInvoiceMatch {
  id: string;
  number: string;
  customer_name: string;
  balance_cents: number;
}

export interface OpenBillMatch {
  id: string;
  vendor_name: string;
  ref?: string;
  balance_cents: number;
}

export interface ExistingBookLink {
  id: string;
  link_type: "payment" | "bill_payment" | "cash_entry";
  label: string;
}

export type MercuryConfidence = "high" | "medium";

export interface MercurySuggestion {
  type: "invoice" | "bill" | "link";
  id: string;
  link_type?: ExistingBookLink["link_type"];
  label: string;
  balance_cents?: number;
  confidence: MercuryConfidence;
  /**
   * True only when the invoice number is in the memo and the amount equals the
   * open balance. Amount-only and vendor-only hits stay for a person to review.
   */
  auto: boolean;
}

export interface MercuryAccountKind {
  kind?: string;
  name?: string;
  nickname?: string;
  type?: string;
}

export interface MercuryCall {
  method: "GET";
  url: string;
  headers: {
    Accept: string;
    Authorization: string;
    "User-Agent": string;
  };
}

export function redactMercurySecrets(message: string): string {
  return message.replace(/secret-token:mercury_(?:production|sandbox)_[A-Za-z0-9_-]+/g, "secret-token:[redacted]");
}

export function assertMercuryReadOnly(method: string): void {
  if (method.toUpperCase() !== "GET") {
    throw new MercuryError("Mercury writes are not allowed. Nave Pay only sends GET.", 405);
  }
}

export function normalizeMercuryToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) {
    throw new MercuryError(
      'That does not look like a Mercury API token. It should start with "secret-token:mercury_production_".',
      400,
    );
  }
  const token = trimmed.replace(/^(Authorization:\s*)?Bearer\s+/i, "");
  if (!TOKEN_RE.test(token)) {
    throw new MercuryError(
      'That does not look like a Mercury API token. It should start with "secret-token:mercury_production_".',
      400,
    );
  }
  return token;
}

export function mercuryEnvironment(token: string): MercuryEnvironment {
  return token.includes("mercury_sandbox_") ? "sandbox" : "production";
}

export function mercuryTokenHint(token: string): string {
  return `••••${token.slice(-4)}`;
}

/** Checking maps to 1000. Savings or treasury maps to 1010 when that account exists. */
export function mercuryGlCode(account: MercuryAccountKind): "1000" | "1010" {
  const blob = `${account.kind ?? ""} ${account.name ?? ""} ${account.nickname ?? ""} ${account.type ?? ""}`.toLowerCase();
  if (blob.includes("saving") || blob.includes("treasury")) return "1010";
  return "1000";
}

export function mercuryBase(token: string, baseOverride?: string | null): string {
  const override = baseOverride?.trim();
  if (override) return override.replace(/\/$/, "");
  return mercuryEnvironment(token) === "sandbox" ? MERCURY_SANDBOX : MERCURY_PROD;
}

export function assertMercuryUrl(url: URL, baseOverride?: string | null): void {
  const override = baseOverride?.trim();
  if (override) {
    const allowed = new URL(override);
    if (url.origin !== allowed.origin) {
      throw new MercuryError("Mercury host is not allowed.", 400);
    }
    return;
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || !url.pathname.startsWith("/api/v1")) {
    throw new MercuryError("Mercury host is not allowed.", 400);
  }
}

export function mercuryCall(
  path: string,
  query: Record<string, string | number | undefined>,
  token: string,
  baseOverride?: string | null,
): MercuryCall {
  assertMercuryReadOnly("GET");
  const normalized = normalizeMercuryToken(token);
  const base = mercuryBase(normalized, baseOverride);
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  assertMercuryUrl(url, baseOverride);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return {
    method: "GET",
    url: url.toString(),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${normalized}`,
      "User-Agent": "NavePay/1.0",
    },
  };
}

export function mercuryCents(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return value * 100;
    return Math.round(value * 100);
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.round(Number(value) * 100);
  }
  return 0;
}

export function addIsoDays(iso: string, days: number): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** First sync uses sync_start or 90 days. Later syncs overlap 14 days, never moving the start earlier. */
export function mercurySyncStart(today: string, syncStart: string | null | undefined, lastSyncAt: string | null | undefined): string {
  const fallback = addIsoDays(today, -90);
  let start = syncStart && syncStart.trim() !== "" ? syncStart.slice(0, 10) : fallback;
  if (lastSyncAt && lastSyncAt.trim() !== "") {
    const overlap = addIsoDays(lastSyncAt, -14);
    if (overlap > start) start = overlap;
  }
  return start;
}

export function mercurySyncEnd(today: string): string {
  return addIsoDays(today, 1);
}

export function mercuryNorm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 3 when the invoice number is a whole token, 2 when a long number is contained, else 0. */
export function mercuryNumberScore(number: string, text: string, textNorm: string): number {
  const num = mercuryNorm(number);
  if (num.length < 3) return 0;
  const boundary = new RegExp(`(^|[^a-z0-9])${escapeRegExp(number.toLowerCase())}($|[^a-z0-9])`);
  if (boundary.test(text)) return 3;
  if (num.length >= 5 && textNorm.includes(num)) return 2;
  return 0;
}

function txnText(txn: MercuryTxnView): { text: string; textNorm: string; counterparty: string } {
  const text = [txn.bank_description, txn.external_memo, txn.note, txn.counterparty].filter(Boolean).join(" ").toLowerCase();
  return { text, textNorm: mercuryNorm(text), counterparty: mercuryNorm(txn.counterparty ?? "") };
}

/**
 * Suggestion for a posted bank line. Auto-apply is only the high-confidence
 * invoice case: invoice number in the memo and the amount equal to the open balance.
 * Amount-only scores as a medium suggestion and does not auto-match.
 */
export function mercurySuggest(
  txn: MercuryTxnView,
  invoices: OpenInvoiceMatch[],
  bills: OpenBillMatch[],
  existing: ExistingBookLink[],
): MercurySuggestion | null {
  if (existing.length > 0) {
    const first = existing[0];
    return {
      type: "link",
      id: first.id,
      link_type: first.link_type,
      label: first.label,
      confidence: existing.length === 1 ? "high" : "medium",
      auto: false,
    };
  }

  const amount = txn.amount_cents;
  const { text, textNorm, counterparty } = txnText(txn);
  let best: OpenInvoiceMatch | OpenBillMatch | null = null;
  let bestScore = 0;
  let tie = false;
  let bestNumber = 0;

  if (amount > 0) {
    for (const invoice of invoices) {
      const balance = invoice.balance_cents;
      if (balance <= 0 || amount > balance) continue;
      let score = 0;
      const numberScore = mercuryNumberScore(invoice.number, text, textNorm);
      score += numberScore;
      const exact = amount === balance;
      if (exact) score += 2;
      const customer = mercuryNorm(invoice.customer_name);
      if (customer !== "" && counterparty !== "" && (counterparty.includes(customer) || customer.includes(counterparty))) {
        score += 1;
      }
      if (score > bestScore) {
        best = invoice;
        bestScore = score;
        bestNumber = numberScore;
        tie = false;
      } else if (score === bestScore && score > 0) {
        tie = true;
      }
    }
    if (best && bestScore >= 2 && !tie && "number" in best) {
      const exact = amount === best.balance_cents;
      const high = bestNumber >= 3 && exact && bestScore >= 4;
      return {
        type: "invoice",
        id: best.id,
        label: `${best.number} · ${best.customer_name}`,
        balance_cents: best.balance_cents,
        confidence: high ? "high" : "medium",
        auto: high,
      };
    }
    return null;
  }

  if (amount < 0) {
    const abs = -amount;
    for (const bill of bills) {
      const balance = bill.balance_cents;
      if (balance <= 0 || abs > balance) continue;
      let score = 0;
      if (abs === balance) score += 2;
      const vendor = mercuryNorm(bill.vendor_name);
      if (vendor !== "" && counterparty !== "" && (counterparty.includes(vendor) || vendor.includes(counterparty))) score += 2;
      const ref = mercuryNorm(bill.ref ?? "");
      if (ref.length >= 4 && textNorm.includes(ref)) score += 2;
      if (score > bestScore) {
        best = bill;
        bestScore = score;
        tie = false;
      } else if (score === bestScore && score > 0) {
        tie = true;
      }
    }
    if (best && bestScore >= 2 && !tie && "vendor_name" in best) {
      return {
        type: "bill",
        id: best.id,
        label: `${best.vendor_name}${best.ref ? ` · ${best.ref}` : ""}`,
        balance_cents: best.balance_cents,
        confidence: bestScore >= 4 ? "high" : "medium",
        auto: false,
      };
    }
  }
  return null;
}

export function mercuryShouldAutoMatch(suggestion: MercurySuggestion | null): boolean {
  return suggestion?.auto === true;
}

interface MercuryFetch {
  (input: string, init: { method: "GET"; headers: MercuryCall["headers"]; redirect: "error"; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export async function mercuryGet(
  path: string,
  query: Record<string, string | number | undefined>,
  token: string,
  options?: { base?: string | null; fetchImpl?: MercuryFetch },
): Promise<unknown> {
  const call = mercuryCall(path, query, token, options?.base);
  const doFetch = options?.fetchImpl ?? (fetch as unknown as MercuryFetch);
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(30_000) : undefined;
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await doFetch(call.url, {
      method: "GET",
      headers: call.headers,
      redirect: "error",
      signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new MercuryError(`Could not reach Mercury: ${redactMercurySecrets(message)}`, 502);
  }
  const body = await response.text();
  if (!response.ok) throw mercuryFailure(response.status, body);
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("not json");
    return parsed;
  } catch {
    throw new MercuryError("Mercury returned an unexpected response", 502);
  }
}

function mercuryFailure(status: number, body: string): MercuryError {
  let detail = "";
  try {
    const json = JSON.parse(body) as { errors?: { message?: unknown }; message?: unknown; error?: unknown };
    const raw = json.errors?.message ?? json.message ?? json.error ?? "";
    detail = typeof raw === "string" ? raw : "";
  } catch {
    detail = "";
  }
  detail = redactMercurySecrets(detail);
  if (status === 401 || status === 403) {
    return new MercuryError(
      "Mercury rejected the API token. It may be revoked or missing read permission. Generate a new read-only token.",
      status,
    );
  }
  if (status === 429) return new MercuryError("Mercury rate limit hit. Wait a minute and sync again.", status);
  return new MercuryError(`Mercury API error ${status}${detail ? `: ${detail}` : ""}`, status >= 400 ? status : 502);
}

/** Drop anything that could carry the API token before a response leaves the server. */
export function mercuryPublicView<T extends Record<string, unknown>>(row: T): T {
  const copy = { ...row };
  for (const key of Object.keys(copy)) {
    if (key !== "token_hint" && /token|kek|ciphertext|authorization|secret/i.test(key)) {
      delete copy[key];
    }
  }
  return copy;
}
