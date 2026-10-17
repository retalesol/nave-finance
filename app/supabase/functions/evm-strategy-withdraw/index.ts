// Founder-gated EVM strategy withdraw proxy.
//
// Collects a founder EIP-191 challenge, then relays
// `NaveExecution.withdrawFromStrategy(index, amount, minOut)` from the
// custodied Executive EOA via signer `/relay-evm`. Does NOT expose
// NAVE_SIGNER_SECRET to the browser.
//
// Body:
//   { dao_address, wallet, message, signature, chain, chain_id,
//     execution_address, index, amount, min_out? }
// message MUST be:
//   `nave-admin|<dao>|withdraw_from_strategy|<index>|<amount>|<unix_ms>`

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { type ChainKind, isEvmChain, normalizeChain, normalizeEvmAddress } from "../_shared/chain.ts";
import { hasEvmRpc, readEvmTreasuryFounder } from "../_shared/evmFounder.ts";
import { checkChallengeTimestamp, verifyWalletSignature } from "../_shared/walletAuth.ts";
import { consumeChallenge, replayChainLabel } from "../_shared/replay.ts";
import { signerSecretFor } from "../_shared/signerAuth.ts";

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const limited = rateLimit(req, { key: clientKey(req, "evm-strategy-withdraw"), limit: 10, windowMs: 60_000 }, corsHeaders);
  if (limited) return limited;

  const signerUrl = Deno.env.get("NAVE_SIGNER_URL");
  const signerSecret = Deno.env.get("NAVE_SIGNER_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!signerUrl || !signerSecret || !supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Service not configured" }, 500);
  }

  let body: {
    dao_address?: string;
    wallet?: string;
    message?: string;
    signature?: string;
    chain?: string;
    chain_id?: number;
    execution_address?: string;
    index?: number | string;
    amount?: number | string;
    min_out?: number | string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  let { dao_address, wallet, execution_address } = body;
  const { message, signature } = body;
  if (!dao_address || !wallet || !message || !signature || !execution_address) {
    return jsonResponse({ error: "Missing dao_address, wallet, message, signature, or execution_address" }, 400);
  }
  if (body.index === undefined || body.amount === undefined) {
    return jsonResponse({ error: "Missing index or amount" }, 400);
  }

  let chainSel: { chain: ChainKind; chain_id: number | null };
  try {
    chainSel = normalizeChain(body.chain, body.chain_id);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Invalid chain" }, 400);
  }
  if (!isEvmChain(chainSel.chain) || chainSel.chain_id == null) {
    return jsonResponse({ error: "EVM chain_id required" }, 400);
  }
  try {
    dao_address = normalizeEvmAddress(dao_address);
    wallet = normalizeEvmAddress(wallet);
    execution_address = normalizeEvmAddress(execution_address);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Invalid EVM address" }, 400);
  }

  const indexStr = String(body.index);
  const amountStr = String(body.amount);
  const parts = message.split("|");
  const signedMinOut = parts[5] ?? "";
  const bodyMinOut = body.min_out === undefined || body.min_out === null || String(body.min_out) === ""
    ? signedMinOut
    : String(body.min_out);
  if (
    parts.length !== 7 ||
    parts[0] !== "nave-admin" ||
    parts[1]?.toLowerCase() !== dao_address ||
    parts[2] !== "withdraw_from_strategy" ||
    parts[3] !== indexStr ||
    parts[4] !== amountStr ||
    signedMinOut === "" ||
    bodyMinOut !== signedMinOut
  ) {
    return jsonResponse({ error: "Malformed challenge message" }, 400);
  }
  if (checkChallengeTimestamp(parts[6])) {
    return jsonResponse({ error: "Challenge expired or not yet valid" }, 401);
  }

  const verified = await verifyWalletSignature("evm", wallet, message, signature);
  if (!verified) return jsonResponse({ error: "Invalid signature" }, 401);

  // Founder authority is read ON-CHAIN (NaveTreasury.founder()); the
  // dao_registry.creator_wallet hint never gates. Fail closed without an RPC.
  const chainId = chainSel.chain_id;
  const onChainFounder = await readEvmTreasuryFounder(chainId, dao_address);
  if (onChainFounder === null) {
    if (!hasEvmRpc(chainId)) {
      return jsonResponse({ error: "Service not configured: EVM RPC required for founder verification" }, 500);
    }
    return jsonResponse({ error: "Could not verify DAO founder on-chain (EVM)" }, 502);
  }
  if (onChainFounder !== wallet) {
    return jsonResponse({ error: "Signer is not the DAO founder" }, 403);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const consumed = await consumeChallenge(supabase, {
    wallet,
    chain: replayChainLabel(chainSel.chain, chainId),
    verified,
    daoAddress: dao_address,
  });
  if (!consumed.ok) return jsonResponse({ error: consumed.error }, consumed.status);

  const payload: Record<string, unknown> = {
    action: "withdraw_from_strategy",
    dao_address,
    execution_address,
    agent_role: "executive",
    chain: chainSel.chain,
    chain_id: chainSel.chain_id,
    index: indexStr,
    amount: amountStr,
  };
  payload.min_out = signedMinOut;

  const resp = await fetch(`${signerUrl.replace(/\/$/, "")}/relay-evm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signer-Secret": signerSecretFor("executive") ?? signerSecret },
    body: JSON.stringify(payload),
  });
  const errText = await resp.text().catch(() => "");
  if (!resp.ok) {
    return jsonResponse({
      error: `Signer relay failed: ${resp.status} ${errText.slice(0, 300)}`,
    }, 502);
  }
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(errText) as Record<string, unknown>;
  } catch {
    data = { raw: errText };
  }

  await supabase.from("agent_action_logs").insert({
    dao_onchain_address: dao_address,
    agent_role: "executive",
    action_type: "withdraw_from_strategy",
    reasoning: `Founder-initiated EVM strategy withdraw via Settings (index ${indexStr}, amount ${amountStr})`,
    constitution_check: { index: indexStr, amount: amountStr, min_out: payload.min_out ?? null },
    payload_hash: "",
    tx_signature: String(data.tx_hash ?? data.signature ?? ""),
    execution_request_address: `${execution_address}#${indexStr}`,
    status: "completed",
    error_message: "",
    confidence_score: null,
    risk_flags: [],
    decision: "withdraw_from_strategy",
    claude_model: null,
    raw_claude_response: null,
    retry_count: 0,
  });

  return jsonResponse({
    success: true,
    dao_address,
    index: indexStr,
    amount: amountStr,
    tx_hash: data.tx_hash ?? data.signature ?? null,
    chain_id: chainSel.chain_id,
  });
});
