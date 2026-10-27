import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import {
  canonicalDaoAddress,
  chainForMoonPayCurrency,
  currencyCodeFromMoonPayData,
  moonPayRawUnits,
  moonpayWebhookSignatureValid,
  readMoonPayEnv,
} from "../_shared/moonpay.ts";

/**
 * POST /moonpay-webhook
 *
 * MoonPay cannot send a Supabase JWT (verify_jwt = false, same as helius-webhook).
 * Auth is the Moonpay-Signature-V2 header: t=<unix>,s=<hex hmac> over
 * `${t}.${rawBody}` keyed with MOONPAY_WEBHOOK_KEY.
 *
 * transaction_updated + data.status "completed" inserts one activity_logs row
 * (event_type MoonPayPurchase). Other events return 200 so MoonPay stops retrying.
 * This does not write a treasury balance; the USDC transfer is the credit.
 */

interface ActivityInsert {
  dao_onchain_address: string;
  chain: "solana" | "ethereum" | "base";
  chain_id: number | null;
  event_type: string;
  description: string;
  actor: string;
  agent_role: null;
  tx_signature: string;
  slot: null;
  block_time: string | null;
  raw_data: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const json = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const webhookKey = readMoonPayEnv().webhookKey;
  if (!webhookKey) {
    return json({ error: "MoonPay webhook is not configured" }, 500);
  }

  const rawBody = await req.text();
  const signatureOk = await moonpayWebhookSignatureValid(
    req.headers.get("Moonpay-Signature-V2"),
    rawBody,
    webhookKey,
  );
  if (!signatureOk) {
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    const record = asRecord(parsed);
    if (!record) return json({ ok: true, ignored: true });
    payload = record;
  } catch {
    return json({ ok: true, ignored: true });
  }

  if (payload.type !== "transaction_updated") {
    return json({ ok: true, ignored: true });
  }
  const data = asRecord(payload.data);
  if (!data) return json({ ok: true, ignored: true });

  const externalTransactionId = asString(data.externalTransactionId);
  if (/^[0-9a-fA-F]{64}$/.test(externalTransactionId)) {
    const settled = await settleInvoicePayment(externalTransactionId.toLowerCase(), data);
    return json(settled, settled.error ? 500 : 200);
  }
  if (data.status !== "completed") {
    return json({ ok: true, ignored: true });
  }

  const cryptoTransactionId = asString(data.cryptoTransactionId);
  const currencyCode = currencyCodeFromMoonPayData(data);
  const chain = chainForMoonPayCurrency(currencyCode);
  if (!externalTransactionId || !cryptoTransactionId || !chain) {
    console.error("moonpay-webhook: completed event missing dao, tx hash, or supported currency");
    return json({ ok: true, ignored: true });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Supabase is not configured" }, 500);
  }

  const dao = canonicalDaoAddress(externalTransactionId);
  const wallet = asString(data.walletAddress);
  const updatedAt = asString(data.updatedAt);
  const blockTime = updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? new Date(updatedAt).toISOString() : null;
  const row: ActivityInsert = {
    dao_onchain_address: dao,
    chain: chain.chain,
    chain_id: chain.chain_id,
    event_type: "MoonPayPurchase",
    description: `MoonPay purchase completed (${currencyCode}) ${cryptoTransactionId}`,
    actor: wallet ? canonicalDaoAddress(wallet) : "",
    agent_role: null,
    tx_signature: cryptoTransactionId,
    slot: null,
    block_time: blockTime,
    raw_data: {
      cryptoTransactionId,
      currencyCode,
      moonpayTransactionId: asString(data.id),
      walletAddress: wallet,
      status: "completed",
    },
  };

  const supabase = createClient(supabaseUrl, serviceKey);
  const { error } = await supabase.from("activity_logs").upsert(row, {
    onConflict: "tx_signature",
    ignoreDuplicates: true,
  });
  if (error) {
    console.error("moonpay-webhook: activity_logs insert failed:", error.message);
    return json({ error: "Failed to record purchase" }, 500);
  }

  return json({ ok: true });
});

async function settleInvoicePayment(token: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceKey) return { error: "Supabase is not configured" };
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  if (data.status === "failed" || data.status === "refunded") return { ok: true, held: false };
  const { error: holdError } = await supabase.rpc("pay_extend_invoice_for_moonpay", { p_token: token });
  if (holdError) console.error("moonpay-webhook hold failed:", holdError.message);

  if (data.status !== "completed") return { ok: true, held: true };
  const cryptoTransactionId = asString(data.cryptoTransactionId);
  const raw = moonPayRawUnits(data);
  const currencyCode = currencyCodeFromMoonPayData(data);
  const chain = chainForMoonPayCurrency(currencyCode);
  if (!cryptoTransactionId || !raw || !chain) return { ok: true, held: true };

  const { data: invoice, error } = await supabase
    .from("pay_invoices")
    .select("id")
    .eq("public_token", token)
    .maybeSingle();
  if (error || !invoice?.id) return { ok: true, held: true };

  const { error: bookError } = await supabase.rpc("pay_book_settlement", {
    p_chain: chain.chain,
    p_tx_hash: cryptoTransactionId,
    p_invoice_id: invoice.id,
    p_asset: currencyCode,
    p_raw_amount: raw,
    p_decimals: 6,
    p_stable: true,
    p_symbol: "USDC",
  });
  if (bookError) {
    console.error("moonpay-webhook book failed:", bookError.message);
    return { error: "Failed to record invoice payment" };
  }
  return { ok: true, booked: true };
}
