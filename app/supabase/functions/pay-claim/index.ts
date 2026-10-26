import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { evmRpcUrlFor } from "../_shared/evmFounder.ts";

/**
 * Public checkout confirmation. The payer already sent USDC. This reads the
 * transaction and, when the recipient and amount match, books the invoice or
 * starts the Nave Pay subscription. It does not move funds.
 */

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const USDC: Record<string, { address: string; decimals: number }> = {
  "1": { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  "8453": { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  "11155111": { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
  "84532": { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
  "46630": { address: "0xAaaE26C5B891bF00D4cD6eF04148Bf1CB1CC96b1", decimals: 6 },
  "5042002": { address: "0x3600000000000000000000000000000000000000", decimals: 6 },
};

function priceCents(term: number): number | null {
  if (term === 1) return 4900;
  if (term === 3) return 13230;
  if (term === 12) return 44100;
  return null;
}

function tokenUnits(cents: number, decimals: number): bigint {
  return BigInt(cents) * 10n ** BigInt(decimals - 2);
}

function padAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "rpc_error");
  return body.result;
}

function evmReceived(receipt: { logs?: { address?: string; topics?: string[]; data?: string }[] }, token: string, destinations: string[]): bigint {
  const want = new Set(destinations.map((item) => padAddress(item)));
  let total = 0n;
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? "").toLowerCase() !== token.toLowerCase()) continue;
    if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!log.topics?.[2] || !want.has(log.topics[2].toLowerCase())) continue;
    total += BigInt(log.data ?? "0x0");
  }
  return total;
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const json = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "service_not_configured" }, 500);

  let body: {
    kind?: string;
    token?: string;
    treasuryGroupId?: string;
    termMonths?: number;
    chain?: string;
    chainId?: number | null;
    txHash?: string;
    payer?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const chain = body.chain ?? "";
  const txHash = (body.txHash ?? "").trim();
  if (!txHash || txHash.length < 8) return json({ error: "invalid_tx" }, 400);

  const chainKey = chain === "solana" ? "solana" : String(body.chainId ?? "");
  const usdc = chain === "solana"
    ? {
      address: Deno.env.get("PAY_SOLANA_USDC_MINT")
        ?? (Deno.env.get("SOLANA_RPC_URL")?.toLowerCase().includes("mainnet")
          ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
          : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
      decimals: 6,
    }
    : USDC[chainKey];
  if (!usdc) return json({ error: "usdc_unavailable" }, 400);

  const supabase = createClient(url, key);

  try {
    if (body.kind === "invoice") {
      const { data: invoice, error } = await supabase
        .from("pay_invoices")
        .select("id, total_cents, public_token")
        .eq("public_token", body.token ?? "")
        .maybeSingle();
      if (error || !invoice) return json({ error: "invoice_not_found" }, 404);
      const { data: view } = await supabase.rpc("pay_public_invoice", { p_token: body.token });
      const amountDue = Number((view as { amount_due_cents?: number } | null)?.amount_due_cents ?? 0);
      if (amountDue <= 0) return json({ ok: true, already_paid: true });
      const addresses = ((view as { addresses?: { address?: string }[] } | null)?.addresses ?? [])
        .map((row) => row.address ?? "")
        .filter(Boolean);
      const received = await receivedUsdc(chain, body.chainId ?? null, txHash, usdc, addresses);
      if (received < tokenUnits(amountDue, usdc.decimals)) {
        return json({ error: "payment_not_found", received: received.toString() }, 400);
      }
      const booked = await supabase.rpc("pay_book_settlement", {
        p_chain: chain,
        p_tx_hash: txHash,
        p_invoice_id: invoice.id,
        p_asset: usdc.address,
        p_raw_amount: received.toString(),
        p_decimals: usdc.decimals,
        p_stable: true,
        p_symbol: "USDC",
      });
      if (booked.error) return json({ error: booked.error.message }, 400);
      return json({ ok: true, booked: booked.data });
    }

    if (body.kind === "subscription") {
      const term = Number(body.termMonths);
      const price = priceCents(term);
      if (!price || !body.treasuryGroupId) return json({ error: "invalid_term" }, 400);
      const destination = chain === "solana"
        ? Deno.env.get("PAY_BILLING_SOLANA") ?? Deno.env.get("NAVE_PROTOCOL_FEE_WALLET") ?? ""
        : Deno.env.get("PAY_BILLING_EVM") ?? Deno.env.get("EVM_PROTOCOL_REVENUE_WALLET") ?? "";
      if (!destination) return json({ error: "billing_address_unset" }, 500);
      const received = await receivedUsdc(chain, body.chainId ?? null, txHash, usdc, [destination]);
      if (received < tokenUnits(price, usdc.decimals)) {
        return json({ error: "payment_not_found", received: received.toString() }, 400);
      }
      const activated = await supabase.rpc("pay_activate_subscription", {
        p_treasury_group_id: body.treasuryGroupId,
        p_term: term,
        p_tx_hash: txHash,
        p_chain: chain,
        p_payer: body.payer ?? "",
        p_source: "wallet",
      });
      if (activated.error) return json({ error: activated.error.message }, 400);
      return json({ ok: true, subscription: activated.data });
    }

    return json({ error: "invalid_kind" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "claim_failed" }, 400);
  }
});

async function receivedUsdc(
  chain: string,
  chainId: number | null,
  txHash: string,
  usdc: { address: string; decimals: number },
  destinations: string[],
): Promise<bigint> {
  if (chain === "solana") {
    const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
    if (!rpcUrl) throw new Error("solana_rpc_unset");
    const tx = await rpc(rpcUrl, "getTransaction", [txHash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]) as {
      meta?: { preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] };
      transaction?: { message?: { accountKeys?: ({ pubkey?: string } | string)[] } };
    } | null;
    if (!tx?.meta) throw new Error("transaction_not_found");
    const keys = (tx.transaction?.message?.accountKeys ?? []).map((key) => typeof key === "string" ? key : key.pubkey ?? "");
    return solanaIncrease(tx.meta.preTokenBalances ?? [], tx.meta.postTokenBalances ?? [], keys, usdc.address, destinations);
  }
  const rpcUrl = evmRpcUrlFor(chainId);
  if (!rpcUrl) throw new Error("evm_rpc_unset");
  const receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [txHash]) as { status?: string; logs?: { address?: string; topics?: string[]; data?: string }[] } | null;
  if (!receipt) throw new Error("transaction_not_found");
  if (receipt.status === "0x0") throw new Error("transaction_failed");
  return evmReceived(receipt, usdc.address, destinations);
}

interface TokenBal {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

function solanaIncrease(pre: TokenBal[], post: TokenBal[], keys: string[], mint: string, destinations: string[]): bigint {
  const wanted = new Set(destinations);
  const matches = (row: TokenBal) => {
    if (row.mint !== mint) return false;
    if (row.owner && wanted.has(row.owner)) return true;
    const account = row.accountIndex == null ? "" : keys[row.accountIndex] ?? "";
    return wanted.has(account);
  };
  const keyOf = (row: TokenBal) => `${row.accountIndex ?? ""}:${row.owner ?? ""}`;
  const before = new Map<string, bigint>();
  for (const row of pre) {
    if (!matches(row)) continue;
    before.set(keyOf(row), BigInt(row.uiTokenAmount?.amount ?? "0"));
  }
  let increase = 0n;
  for (const row of post) {
    if (!matches(row)) continue;
    const next = BigInt(row.uiTokenAmount?.amount ?? "0");
    const prior = before.get(keyOf(row)) ?? 0n;
    if (next > prior) increase += next - prior;
  }
  return increase;
}
