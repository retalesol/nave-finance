// Founder-gated proxy for the agent orchestrator.
//
// The browser must NEVER hold NAVE_AGENT_SECRET. This function lets a DAO
// founder trigger an orchestrator run by signing a short challenge with their
// wallet. We verify the ed25519 signature, confirm the signer is the DAO's
// on-chain founder (via dao_registry), then forward to agent-orchestrator with
// the server-held secret.
//
// Required body:
//   { dao_address, execution_request_address?, wallet, message, signature }
// `signature` is base64 of the ed25519 signature over `message` (UTF-8).
// `message` must be: `nave-dispatch|<dao_address>|<er_or_poll>|<unix_ms>`.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { readDaoFounder } from "../_shared/onchain.ts";
import { isEvmChain, normalizeChain, normalizeEvmAddress } from "../_shared/chain.ts";
import { hasEvmRpc, readEvmTreasuryFounder } from "../_shared/evmFounder.ts";
import { checkChallengeTimestamp, verifyWalletSignature } from "../_shared/walletAuth.ts";
import { consumeChallenge, replayChainLabel } from "../_shared/replay.ts";

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Throttle abuse: this endpoint is browser-reachable. 10 req/min/IP.
  const limited = rateLimit(req, { key: clientKey(req, "proxy"), limit: 10, windowMs: 60_000 }, corsHeaders);
  if (limited) return limited;

  const agentSecret = Deno.env.get("NAVE_AGENT_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!agentSecret || !supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Service not configured" }, 500);
  }

  let body: {
    dao_address?: string;
    execution_request_address?: string;
    wallet?: string;
    message?: string;
    signature?: string;
    chain?: string;
    chain_id?: number;
    index?: number;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  let { dao_address, wallet } = body;
  const { execution_request_address, message, signature } = body;
  if (!dao_address || !wallet || !message || !signature) {
    return jsonResponse({ error: "Missing dao_address, wallet, message, or signature" }, 400);
  }

  // Resolve chain (defaults to Solana so existing callers are unchanged).
  let chainSel: { chain: string; chain_id: number | null };
  try {
    chainSel = normalizeChain(body.chain, body.chain_id);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Invalid chain" }, 400);
  }
  const evm = isEvmChain(chainSel.chain as never);
  if (evm) {
    try {
      dao_address = normalizeEvmAddress(dao_address);
      wallet = normalizeEvmAddress(wallet);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Invalid EVM address" }, 400);
    }
  }

  // ── Verify the challenge structure and freshness ──
  const expectedTarget = execution_request_address ?? "poll";
  const parts = message.split("|");
  // EVM addresses are case-insensitive (EIP-55 is only a checksum), so compare
  // the message's DAO field case-insensitively on EVM; Solana stays exact.
  const daoMatches = evm
    ? parts[1]?.toLowerCase() === dao_address.toLowerCase()
    : parts[1] === dao_address;
  if (parts.length !== 4 || parts[0] !== "nave-dispatch" || !daoMatches || parts[2] !== expectedTarget) {
    return jsonResponse({ error: "Malformed challenge message" }, 400);
  }
  // Reject expired AND future-dated challenges (only a small clock skew is
  // tolerated). A future timestamp would otherwise extend the replay window.
  if (checkChallengeTimestamp(parts[3])) {
    return jsonResponse({ error: "Challenge expired or not yet valid" }, 401);
  }

  // ── Verify the signature ──
  // Solana: ed25519 (base64 or base58) against the base58 wallet.
  // EVM: 0x-hex EIP-191 personal_sign against the address.
  const verified = await verifyWalletSignature(evm ? "evm" : "solana", wallet, message, signature);
  if (!verified) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  // ── Confirm the signer is the DAO founder (ON-CHAIN authority) ──
  // The authoritative founder is read on-chain (DaoRegistry.founder on Solana,
  // NaveTreasury.founder() on EVM), NOT the off-chain dao_registry.creator_wallet
  // (a writable hint). FAIL CLOSED: without an RPC, or if the founder can't be
  // read, we cannot verify authority and must reject — no DB-only fallback.
  const supabase = createClient(supabaseUrl, serviceKey);
  let onChainFounder: string | null;
  if (evm) {
    const chainId = chainSel.chain_id as number;
    onChainFounder = await readEvmTreasuryFounder(chainId, dao_address);
    if (onChainFounder === null) {
      if (!hasEvmRpc(chainId)) {
        return jsonResponse({ error: "Service not configured: EVM RPC required for founder verification" }, 500);
      }
      return jsonResponse({ error: "Could not verify DAO founder on-chain (EVM)" }, 502);
    }
    if (onChainFounder !== wallet.toLowerCase()) {
      return jsonResponse({ error: "Signer is not the DAO founder" }, 403);
    }
  } else {
    const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
    if (!rpcUrl) {
      console.error("orchestrator-proxy: SOLANA_RPC_URL unset — cannot verify founder on-chain");
      return jsonResponse({ error: "Service not configured: SOLANA_RPC_URL required for founder verification" }, 500);
    }
    onChainFounder = await readDaoFounder(rpcUrl, dao_address);
    if (!onChainFounder) {
      return jsonResponse({ error: "Could not verify DAO founder on-chain" }, 502);
    }
    if (onChainFounder !== wallet) {
      return jsonResponse({ error: "Signer is not the DAO founder" }, 403);
    }
  }

  // DB row is a hint only: surface drift between the off-chain mirror and the
  // authoritative on-chain founder, but never let it gate authorization.
  const { data: dao } = await supabase
    .from("dao_registry")
    .select("creator_wallet, dao_onchain_address")
    .eq("dao_onchain_address", dao_address)
    .maybeSingle();
  if (dao && dao.creator_wallet && dao.creator_wallet !== onChainFounder) {
    console.warn(
      `orchestrator-proxy: dao_registry.creator_wallet (${dao.creator_wallet}) != on-chain founder (${onChainFounder}) for ${dao_address}`,
    );
  }

  // ── Replay protection: each signed challenge may be consumed at most once ──
  // Keyed on the canonical (wallet, chain, message, signature-bytes) digest so a
  // re-encoded signature (hex case / base64 padding / base58) cannot replay.
  const consumed = await consumeChallenge(supabase, {
    wallet,
    chain: replayChainLabel(chainSel.chain, chainSel.chain_id),
    verified,
    daoAddress: dao_address,
  });
  if (!consumed.ok) {
    return jsonResponse({ error: consumed.error }, consumed.status);
  }

  // ── Forward to the orchestrator with the server-held secret ──
  // Poll mode is scoped to the signed DAO so a founder can only trigger runs for
  // their own DAO (never a fleet-wide poll).
  const chainFields = evm
    ? { chain: chainSel.chain, chain_id: chainSel.chain_id }
    : {};
  const payload = execution_request_address
    ? {
        mode: "manual",
        dao_address,
        execution_request_address,
        ...(typeof body.index === "number" ? { index: body.index } : {}),
        ...chainFields,
      }
    : { mode: "poll", dao_address, ...chainFields };

  const resp = await fetch(`${supabaseUrl}/functions/v1/agent-orchestrator`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
      "X-Agent-Secret": agentSecret,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  return jsonResponse(data, resp.status);
});
