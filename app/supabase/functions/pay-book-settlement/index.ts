import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, requireSecret } from "../_shared/http.ts";

/**
 * Books a payment-address settlement. Idempotent on
 * (chain, tx hash, invoice, asset). Service role only; callers present
 * X-Indexer-Secret. USDC is at par. A non-stable uses price_cache when a
 * symbol is supplied, and otherwise leaves USD for a manual payment.
 */

interface SettlementBody {
  chain?: string;
  tx_hash?: string;
  invoice_id?: string;
  asset?: string;
  raw_amount?: string | number;
  decimals?: number;
  stable?: boolean;
  symbol?: string | null;
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const json = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const denied = requireSecret(req, "NAVE_INDEXER_SECRET", "X-Indexer-Secret", corsHeaders);
  if (denied) return denied;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "service_not_configured" }, 500);

  let body: SettlementBody;
  try {
    body = await req.json() as SettlementBody;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const supabase = createClient(url, key);
  const { data, error } = await supabase.rpc("pay_book_settlement", {
    p_chain: body.chain ?? "",
    p_tx_hash: body.tx_hash ?? "",
    p_invoice_id: body.invoice_id,
    p_asset: body.asset ?? "",
    p_raw_amount: body.raw_amount == null ? "" : String(body.raw_amount),
    p_decimals: body.decimals ?? null,
    p_stable: body.stable === true,
    p_symbol: body.symbol ?? null,
  });
  if (error) return json({ error: error.message }, 400);
  return json(data);
});
