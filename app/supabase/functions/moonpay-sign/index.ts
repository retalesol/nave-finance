import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { PublicKey } from "npm:@solana/web3.js@1.95.0";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import {
  readMoonPayEnv,
  selectInvoiceMoonPayWallet,
  signMoonPayQuery,
  validateMoonPaySignUrl,
  type InvoicePayAddress,
  type MoonPayInvoiceLock,
  type SolanaPublicKeyCtor,
} from "../_shared/moonpay.ts";

/**
 * POST /moonpay-sign
 *
 * Body: { url: string, daoAddress: string, chainId: number | null }
 * 200:  { signature: string }  — raw base64 HMAC of the query string, not URL-encoded
 * non-200: { error: string }
 *
 * verify_jwt is off, same as the other browser functions. The caller must send
 * the Supabase anon key (or the service role) as Authorization: Bearer, which
 * is the header callEdgeFunction already attaches. The anon key is not proof
 * of a user; the URL checks below are what keep this from signing an arbitrary
 * wallet.
 */

interface SignBody {
  url?: unknown;
  daoAddress?: unknown;
  chainId?: unknown;
  invoiceToken?: unknown;
}

function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function callerAuthorized(req: Request, anonKey: string | undefined, serviceKey: string | undefined): boolean {
  const token = bearerToken(req);
  const apiKey = (req.headers.get("apikey") ?? "").trim();
  if (anonKey && (secretsMatch(token, anonKey) || secretsMatch(apiKey, anonKey))) return true;
  if (serviceKey && (secretsMatch(token, serviceKey) || secretsMatch(apiKey, serviceKey))) return true;
  return false;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const json = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const limited = rateLimit(req, { key: clientKey(req, "moonpay-sign"), limit: 60, windowMs: 60_000 }, corsHeaders);
  if (limited) return limited;

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!anonKey && !serviceKey) {
    return json({ error: "Supabase auth is not configured" }, 500);
  }
  if (!callerAuthorized(req, anonKey, serviceKey)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const env = readMoonPayEnv();
  if (!env.secretKey || !env.publishableKey) {
    return json({ error: "MoonPay is not configured" }, 500);
  }

  let body: SignBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid request" }, 400);
  }
  if (typeof body.url !== "string" || body.url.length === 0 || body.url.length > 4096) {
    return json({ error: "url is required" }, 400);
  }
  const invoiceToken = typeof body.invoiceToken === "string" ? body.invoiceToken.trim().toLowerCase() : "";
  if (!invoiceToken && (typeof body.daoAddress !== "string" || body.daoAddress.trim().length === 0)) {
    return json({ error: "daoAddress is required" }, 400);
  }
  if (invoiceToken && !/^[0-9a-f]{64}$/.test(invoiceToken)) {
    return json({ error: "invoiceToken is not valid" }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "chainId")) {
    return json({ error: "chainId is required" }, 400);
  }
  if (body.chainId !== null && (typeof body.chainId !== "number" || !Number.isInteger(body.chainId))) {
    return json({ error: "chainId must be an integer or null" }, 400);
  }

  const chainId: number | null = body.chainId as number | null;
  let invoiceLock: MoonPayInvoiceLock | null = null;
  if (invoiceToken) {
    const loaded = await loadInvoiceLock(invoiceToken, chainId);
    if (!loaded.ok) return json({ error: loaded.error }, loaded.status);
    invoiceLock = loaded.lock;
  }

  const decision = validateMoonPaySignUrl(
    {
      url: body.url,
      daoAddress: typeof body.daoAddress === "string" ? body.daoAddress : "",
      chainId,
    },
    {
      publishableKey: env.publishableKey,
      programId: env.programId,
      PublicKey: PublicKey as unknown as SolanaPublicKeyCtor,
    },
    invoiceLock,
  );
  if (!decision.ok) {
    return json({ error: decision.error }, 400);
  }

  try {
    if (invoiceToken) {
      const held = await extendInvoiceForMoonPay(invoiceToken);
      if (!held) return json({ error: "The invoice could not be held open for MoonPay" }, 500);
    }
    const signature = await signMoonPayQuery(decision.query, env.secretKey);
    return json({ signature });
  } catch (err) {
    console.error("moonpay-sign failed:", err instanceof Error ? err.message : "sign error");
    return json({ error: "Failed to sign MoonPay URL" }, 500);
  }
});

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadInvoiceLock(
  token: string,
  chainId: number | null,
): Promise<{ ok: true; lock: MoonPayInvoiceLock } | { ok: false; error: string; status: number }> {
  const supabase = serviceClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", status: 500 };
  const { data: invoice, error } = await supabase
    .from("pay_invoices")
    .select("id, status")
    .eq("public_token", token)
    .maybeSingle();
  if (error) return { ok: false, error: "Invoice lookup failed", status: 500 };
  if (!invoice || invoice.status === "void" || invoice.status === "draft") {
    return { ok: false, error: "This invoice cannot be paid", status: 400 };
  }
  const { data: addresses, error: addressError } = await supabase
    .from("pay_invoice_addresses")
    .select("chain, chain_id, asset, kind, address")
    .eq("invoice_id", invoice.id);
  if (addressError) return { ok: false, error: "Invoice lookup failed", status: 500 };
  let rows = (addresses ?? []) as InvoicePayAddress[];
  if (!rows.some((row) => row.asset === "treasury")) {
    const { data: invoiceRow } = await supabase
      .from("pay_invoices")
      .select("treasury_group_id")
      .eq("id", invoice.id)
      .maybeSingle();
    const groupId = invoiceRow?.treasury_group_id;
    if (groupId) {
      const { data: wallets } = await supabase
        .from("pay_wallet_addresses")
        .select("chain, chain_id, address")
        .eq("treasury_group_id", groupId);
      rows = rows.concat((wallets ?? []).map((row) => ({
        chain: String(row.chain),
        chain_id: row.chain_id,
        asset: "treasury",
        address: String(row.address),
      })));
    }
  }
  const selected = selectInvoiceMoonPayWallet(rows, chainId);
  if (!selected) return { ok: false, error: "This invoice has no MoonPay address on that network", status: 400 };
  return { ok: true, lock: { token, walletAddress: selected.walletAddress, currency: selected.currency } };
}

async function extendInvoiceForMoonPay(token: string): Promise<boolean> {
  const supabase = serviceClient();
  if (!supabase) return false;
  const { error } = await supabase.rpc("pay_extend_invoice_for_moonpay", { p_token: token });
  if (error) {
    console.error("moonpay-sign hold failed:", error.message);
    return false;
  }
  return true;
}
