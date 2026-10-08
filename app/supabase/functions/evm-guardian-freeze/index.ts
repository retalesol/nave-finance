// Founder-gated EVM guardian M-of-N freeze/unfreeze proxy.
//
// Collects EIP-712 GuardianAction signatures from custodied guardian EOAs via
// the signer `/sign-evm` endpoint, then returns them so the browser (or a
// subsequent founder wallet tx) can submit `emergencyFreeze` /
// `emergencyUnfreeze` on NaveTreasury. Does NOT hold NAVE_SIGNER_SECRET in the
// browser.
//
// Body:
//   { dao_address, wallet, message, signature, freeze: boolean, chain, chain_id,
//     nonce?, deadline?, guardian_count? }
// message MUST be:
//   `nave-admin|<dao>|emergency_freeze|<0|1>|<unix_ms>`
// where 1 = freeze, 0 = unfreeze.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { type ChainKind, isEvmChain, normalizeChain, normalizeEvmAddress } from "../_shared/chain.ts";
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

  const limited = rateLimit(req, { key: clientKey(req, "evm-guardian-freeze"), limit: 10, windowMs: 60_000 }, corsHeaders);
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
    freeze?: boolean;
    chain?: string;
    chain_id?: number;
    nonce?: number | string;
    deadline?: number | string;
    guardian_count?: number;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  let { dao_address, wallet } = body;
  const { message, signature, freeze } = body;
  if (!dao_address || !wallet || !message || !signature || typeof freeze !== "boolean") {
    return jsonResponse({ error: "Missing dao_address, wallet, message, signature, or freeze" }, 400);
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
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Invalid EVM address" }, 400);
  }

  const freezeFlag = freeze ? "1" : "0";
  const parts = message.split("|");
  if (
    parts.length !== 5 ||
    parts[0] !== "nave-admin" ||
    parts[1]?.toLowerCase() !== dao_address ||
    parts[2] !== "emergency_freeze" ||
    parts[3] !== freezeFlag
  ) {
    return jsonResponse({ error: "Malformed challenge message" }, 400);
  }
  if (checkChallengeTimestamp(parts[4])) {
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

  const nonce = body.nonce != null ? BigInt(body.nonce) : BigInt(Math.floor(Date.now() / 1000));
  const deadline = body.deadline != null
    ? BigInt(body.deadline)
    : BigInt(Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60);
  const guardianCount = Math.min(Math.max(Number(body.guardian_count ?? 3), 1), 10);
  const actionType = freeze ? "FREEZE" : "UNFREEZE";

  const signatures: string[] = [];
  const signers: string[] = [];
  for (let i = 0; i < guardianCount; i++) {
    const resp = await fetch(`${signerUrl.replace(/\/$/, "")}/sign-evm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signer-Secret": signerSecret },
      body: JSON.stringify({
        chain: chainSel.chain,
        chain_id: chainSel.chain_id,
        dao_address,
        agent_role: "guardian",
        guardian_index: i,
        action_type: actionType,
        agent_slot: 0,
        new_status: 0,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      }),
    });
    if (!resp.ok) {
      // Stop once we run out of custodied guardians (404/400) — partial set is OK
      // when the founder wallet will add their own signature client-side.
      if (resp.status === 404 || resp.status === 400) break;
      const errText = await resp.text().catch(() => "");
      return jsonResponse({
        error: `Guardian ${i} sign failed: ${resp.status} ${errText.slice(0, 200)}`,
      }, 502);
    }
    const data = await resp.json() as { signature?: string; signer?: string };
    if (data.signature) {
      signatures.push(data.signature);
      if (data.signer) signers.push(data.signer);
    }
  }

  if (signatures.length === 0) {
    return jsonResponse({
      error: "No custodied guardian signatures available. Ensure generate-evm-agent-keys bound a guardian, or sign from a guardian wallet.",
    }, 422);
  }

  return jsonResponse({
    success: true,
    dao_address,
    freeze,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    signatures,
    signers,
    chain_id: chainSel.chain_id,
  });
});
