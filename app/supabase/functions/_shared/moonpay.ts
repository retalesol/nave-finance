/**
 * MoonPay buy-widget signing and webhook verification.
 *
 * Supabase secrets (function environment only — never commit, never log):
 * - MOONPAY_SECRET_KEY — HMAC-SHA256 key for widget URL signatures
 * - MOONPAY_PUBLISHABLE_KEY — must equal the signed URL's apiKey (`pk_test_` or `pk_live_`)
 * - MOONPAY_WEBHOOK_KEY — HMAC key for the Moonpay-Signature-V2 header
 *
 * Solana vault-authority PDA program id: `NAVE_CORE_PROGRAM_ID`, then
 * `VITE_NAVE_CORE_PROGRAM_ID`. Same fallback as snapshot-treasury when both
 * are unset.
 */

/** Devnet/default nave_core id used by other edge functions when env is unset. */
export const DEFAULT_NAVE_CORE_PROGRAM_ID = "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB";

export const MOONPAY_SANDBOX_HOST = "buy-sandbox.moonpay.com";
export const MOONPAY_LIVE_HOST = "buy.moonpay.com";

/** Currency codes MoonPay delivers as USDC on the treasuries this flow supports. */
export const MOONPAY_CURRENCY = {
  solana: "usdc_sol",
  ethereum: "usdc",
  base: "usdc_base",
} as const;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface MoonPayEnv {
  secretKey?: string;
  publishableKey?: string;
  webhookKey?: string;
  programId: string;
}

interface DenoEnv {
  env: { get(name: string): string | undefined };
}

/** Read MoonPay secrets and the nave_core program id. Missing secrets stay undefined. */
export function readMoonPayEnv(): MoonPayEnv {
  const deno = (globalThis as { Deno?: DenoEnv }).Deno;
  const get = (name: string): string | undefined => {
    const value = deno?.env.get(name)?.trim();
    return value ? value : undefined;
  };
  return {
    secretKey: get("MOONPAY_SECRET_KEY"),
    publishableKey: get("MOONPAY_PUBLISHABLE_KEY"),
    webhookKey: get("MOONPAY_WEBHOOK_KEY"),
    programId: get("NAVE_CORE_PROGRAM_ID") || get("VITE_NAVE_CORE_PROGRAM_ID") || DEFAULT_NAVE_CORE_PROGRAM_ID,
  };
}

export interface SolanaPublicKeyLike {
  toBytes(): Uint8Array;
  toBase58(): string;
}

export interface SolanaPublicKeyCtor {
  new (value: string | Uint8Array): SolanaPublicKeyLike;
  findProgramAddressSync(
    seeds: Uint8Array[],
    programId: SolanaPublicKeyLike,
  ): [SolanaPublicKeyLike, number];
}

/**
 * Vault authority PDA. Seeds: ["vault_authority", daoPubkey], owner = nave_core.
 * Mirrors getVaultAuthorityPDA in app/src/lib/pdaDerivation.ts.
 */
export function deriveVaultAuthorityAddress(
  daoAddress: string,
  programId: string,
  PublicKey: SolanaPublicKeyCtor,
): string {
  const dao = new PublicKey(daoAddress);
  const program = new PublicKey(programId);
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vault_authority"), dao.toBytes()],
    program,
  );
  return pda.toBase58();
}

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}

/** EVM treasuries are stored lowercase. Solana base58 is left unchanged. */
export function canonicalDaoAddress(address: string): string {
  const trimmed = address.trim();
  return isEvmAddress(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export interface MoonPaySignInput {
  url: string;
  daoAddress: string;
  chainId: number | null;
}

export interface MoonPaySignRules {
  publishableKey: string;
  programId: string;
  PublicKey: SolanaPublicKeyCtor;
}

/** Invoice checkout. The widget must pay this address, not the treasury vault. */
export interface MoonPayInvoiceLock {
  token: string;
  walletAddress: string;
  currency: "usdc_sol" | "usdc" | "usdc_base";
}

export interface InvoicePayAddress {
  chain: string;
  chain_id?: number | null;
  asset: string;
  address: string;
  kind?: string;
}

const EVM_NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Destination MoonPay must use for an invoice.
 * Solana pays the invoice vault (MoonPay creates the USDC account).
 * Ethereum and Base pay the invoice USDC forwarder when one exists,
 * otherwise the treasury address stored for that chain.
 */
export function selectInvoiceMoonPayWallet(
  rows: InvoicePayAddress[],
  chainId: number | null,
): { walletAddress: string; currency: MoonPayInvoiceLock["currency"] } | null {
  if (chainId === null) {
    const vault = rows.find((row) => row.chain === "solana" && (row.kind === "solana_vault" || row.asset === "native"));
    const canonical = rows.find((row) => row.chain === "solana" && row.asset === "treasury");
    const picked = vault ?? canonical;
    if (!picked?.address) return null;
    return { walletAddress: picked.address, currency: "usdc_sol" };
  }
  if (chainId !== 1 && chainId !== 8453) return null;
  const chain = chainId === 1 ? "ethereum" : "base";
  const forwarder = rows.find((row) => (
    row.chain === chain
    && row.asset
    && row.asset !== "native"
    && row.asset !== "treasury"
    && row.asset.toLowerCase() !== EVM_NATIVE
  ));
  const canonical = rows.find((row) => row.chain === chain && row.asset === "treasury");
  const picked = forwarder ?? canonical;
  if (!picked?.address) return null;
  return { walletAddress: picked.address, currency: chainId === 1 ? "usdc" : "usdc_base" };
}

/** USDC base units from a MoonPay completed payload. Null when the amount is missing. */
export function moonPayRawUnits(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  const quote = finiteNumber(data.quoteCurrencyAmount);
  const base = finiteNumber(data.baseCurrencyAmount);
  const amount = quote ?? base;
  if (amount == null || !(amount > 0)) return null;
  return BigInt(Math.round(amount * 1_000_000)).toString();
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type MoonPaySignDecision =
  | { ok: true; query: string }
  | { ok: false; error: string };

function fail(error: string): MoonPaySignDecision {
  return { ok: false, error };
}

function singleParam(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name).map((value) => value.trim()).filter((value) => value.length > 0);
  if (values.length !== 1) return null;
  return values[0];
}

function validateInvoiceLock(parsed: URL, invoice: MoonPayInvoiceLock): MoonPaySignDecision {
  const token = invoice.token.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(token)) return fail("Invoice token is not valid");
  const currencyCode = singleParam(parsed, "currencyCode");
  if (currencyCode !== invoice.currency) return fail("Currency does not match this invoice");
  const walletAddress = singleParam(parsed, "walletAddress");
  if (!walletAddress) return fail("walletAddress is required");
  const walletMatches = invoice.currency === "usdc_sol"
    ? walletAddress === invoice.walletAddress
    : canonicalDaoAddress(walletAddress) === canonicalDaoAddress(invoice.walletAddress);
  if (!walletMatches) return fail("Wallet does not match this invoice");
  const externalTransactionId = singleParam(parsed, "externalTransactionId");
  if (!externalTransactionId || externalTransactionId.toLowerCase() !== token) {
    return fail("externalTransactionId must be the invoice");
  }
  if (!parsed.search.startsWith("?")) return fail("MoonPay URL is missing a query string");
  return { ok: true, query: parsed.search };
}

/**
 * Refuse every URL that is not a MoonPay buy widget locked to this treasury's
 * USDC address, or to an invoice payment address when an invoice lock is set.
 * Returns the exact query string (leading "?") to sign.
 */
export function validateMoonPaySignUrl(
  input: MoonPaySignInput,
  rules: MoonPaySignRules,
  invoice?: MoonPayInvoiceLock | null,
): MoonPaySignDecision {
  const publishableKey = rules.publishableKey.trim();
  if (!publishableKey) return fail("MoonPay publishable key is not configured");

  const keyIsTest = publishableKey.startsWith("pk_test_");
  const keyIsLive = publishableKey.startsWith("pk_live_");
  if (!keyIsTest && !keyIsLive) return fail("MoonPay publishable key is not a test or live key");

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail("Invalid URL");
  }
  if (parsed.protocol !== "https:") return fail("MoonPay URL must be https");
  if (parsed.username || parsed.password) return fail("Invalid URL");
  if (parsed.pathname !== "/" && parsed.pathname !== "") return fail("MoonPay URL path is not the buy widget");

  const expectedHost = keyIsTest ? MOONPAY_SANDBOX_HOST : MOONPAY_LIVE_HOST;
  if (parsed.hostname !== expectedHost) return fail("MoonPay host does not match the key");

  const apiKey = singleParam(parsed, "apiKey");
  if (!apiKey || apiKey !== publishableKey) return fail("apiKey does not match");

  if (invoice) return validateInvoiceLock(parsed, invoice);

  const daoAddress = input.daoAddress?.trim() ?? "";
  if (!daoAddress) return fail("daoAddress is required");

  const chainId = input.chainId;
  let currency = "";
  let expectedWallet = "";

  if (chainId === null) {
    if (daoAddress.toLowerCase().startsWith("0x")) {
      return fail("EVM treasury requires chain id 1 or 8453");
    }
    try {
      expectedWallet = deriveVaultAuthorityAddress(daoAddress, rules.programId, rules.PublicKey);
    } catch {
      return fail("Invalid Solana treasury address");
    }
    currency = MOONPAY_CURRENCY.solana;
  } else if (chainId === 1 || chainId === 8453) {
    if (!isEvmAddress(daoAddress)) return fail("daoAddress must be an EVM address");
    expectedWallet = canonicalDaoAddress(daoAddress);
    currency = chainId === 1 ? MOONPAY_CURRENCY.ethereum : MOONPAY_CURRENCY.base;
  } else {
    return fail("Unsupported chain");
  }

  const currencyCode = singleParam(parsed, "currencyCode");
  if (currencyCode !== currency) return fail("Currency does not match this treasury");

  const walletAddress = singleParam(parsed, "walletAddress");
  if (!walletAddress) return fail("walletAddress is required");
  const walletMatches = chainId === null
    ? walletAddress === expectedWallet
    : canonicalDaoAddress(walletAddress) === expectedWallet;
  if (!walletMatches) return fail("Wallet does not match this treasury");

  const externalTransactionId = singleParam(parsed, "externalTransactionId");
  if (!externalTransactionId) return fail("externalTransactionId must be the treasury address");
  const externalMatches = chainId === null
    ? externalTransactionId === daoAddress
    : canonicalDaoAddress(externalTransactionId) === canonicalDaoAddress(daoAddress);
  if (!externalMatches) return fail("externalTransactionId must be the treasury address");

  if (!parsed.search.startsWith("?")) return fail("MoonPay URL is missing a query string");
  return { ok: true, query: parsed.search };
}

/** HMAC-SHA256 of the query string, including the leading "?", as raw base64. */
export async function signMoonPayQuery(query: string, secretKey: string): Promise<string> {
  if (!query.startsWith("?")) throw new Error("query must include the leading ?");
  if (!secretKey) throw new Error("secret key is required");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(query));
  return bytesToBase64(new Uint8Array(mac));
}

export function chainForMoonPayCurrency(
  code: string | null | undefined,
): { chain: "solana" | "ethereum" | "base"; chain_id: number | null } | null {
  switch ((code ?? "").trim().toLowerCase()) {
    case MOONPAY_CURRENCY.solana:
      return { chain: "solana", chain_id: null };
    case MOONPAY_CURRENCY.ethereum:
      return { chain: "ethereum", chain_id: 1 };
    case MOONPAY_CURRENCY.base:
      return { chain: "base", chain_id: 8453 };
    default:
      return null;
  }
}

export function currencyCodeFromMoonPayData(data: Record<string, unknown> | null | undefined): string {
  if (!data) return "";
  const currency = data.currency;
  if (currency && typeof currency === "object" && "code" in currency) {
    const code = (currency as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  if (typeof data.currencyCode === "string" && data.currencyCode.trim()) return data.currencyCode.trim();
  return "";
}

/** `t=<unix>,s=<hex hmac>` from Moonpay-Signature-V2. */
export function parseMoonpaySignatureV2(header: string | null | undefined): { t: string; s: string } | null {
  if (!header) return null;
  let t: string | undefined;
  let s: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    else if (key === "s") s = value;
  }
  if (!t || !s) return null;
  if (!/^\d+$/.test(t)) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return null;
  return { t, s: s.toLowerCase() };
}

/** HMAC-SHA256 of `${timestamp}.${rawBody}` as lowercase hex. */
export async function moonpayWebhookDigest(timestamp: string, rawBody: string, webhookKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  return bytesToHex(new Uint8Array(mac));
}

/** True when Moonpay-Signature-V2 matches the raw POST body. */
export async function moonpayWebhookSignatureValid(
  header: string | null | undefined,
  rawBody: string,
  webhookKey: string,
): Promise<boolean> {
  const parsed = parseMoonpaySignatureV2(header);
  if (!parsed || !webhookKey) return false;
  const expected = await moonpayWebhookDigest(parsed.t, rawBody, webhookKey);
  return constantTimeEqual(parsed.s, expected);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
