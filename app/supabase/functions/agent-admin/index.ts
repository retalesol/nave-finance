// Founder-gated admin proxy for real on-chain operational controls.
//
// The browser must NEVER hold NAVE_SIGNER_SECRET. This function lets a DAO
// founder flip the authoritative on-chain `agents_enabled` flag by signing a
// short challenge with their wallet. We verify the signature, confirm the
// signer is the DAO's ON-CHAIN founder (DaoRegistry.founder on Solana,
// NaveTreasury.founder() on EVM — never the writable dao_registry.creator_wallet
// hint), enforce single-use replay protection, then forward to the signer
// service which signs nave_core::toggle_agents with the Executive agent key.
//
// This is the backing call for the UI "Pause / Resume All Agents" control —
// there is no local-only pause; the button changes real on-chain state.
//
// Required body:
//   { dao_address, wallet, message, signature, enabled }
// `message` MUST be: `nave-admin|<dao_address>|toggle_agents|<0|1>|<unix_ms>`
// where the 4th field is `1` to enable agents or `0` to pause them, and it MUST
// match the `enabled` boolean in the body.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { type ChainKind, isEvmChain, normalizeChain, normalizeEvmAddress } from "../_shared/chain.ts";
import { readDaoFounder } from "../_shared/onchain.ts";
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

  const limited = rateLimit(req, { key: clientKey(req, "agent-admin"), limit: 10, windowMs: 60_000 }, corsHeaders);
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
    enabled?: boolean;
    chain?: string;
    chain_id?: number;
    /** EVM pause only: founder's EIP-712 GuardianAction(DISABLE_AGENTS) signature(s). */
    guardian_signatures?: unknown;
    /** EVM pause only: GuardianAction nonce / deadline the founder signed over. */
    guardian_nonce?: number | string | null;
    guardian_deadline?: number | string | null;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  let { dao_address, wallet } = body;
  const { message, signature, enabled } = body;
  if (!dao_address || !wallet || !message || !signature || typeof enabled !== "boolean") {
    return jsonResponse({ error: "Missing dao_address, wallet, message, signature, or enabled" }, 400);
  }

  // ── Resolve chain discriminator (defaults to Solana) ──
  let chainSel: { chain: ChainKind; chain_id: number | null };
  try {
    chainSel = normalizeChain(body.chain, body.chain_id);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Invalid chain" }, 400);
  }
  const evm = isEvmChain(chainSel.chain);
  if (evm) {
    try {
      dao_address = normalizeEvmAddress(dao_address);
      wallet = normalizeEvmAddress(wallet);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Invalid EVM address" }, 400);
    }
  }

  // ── Verify the challenge structure, action, and freshness ──
  const enabledFlag = enabled ? "1" : "0";
  const parts = message.split("|");
  // EVM addresses are case-insensitive (EIP-55 checksum); compare accordingly.
  const daoMatches = evm
    ? parts[1]?.toLowerCase() === dao_address
    : parts[1] === dao_address;
  if (
    parts.length !== 5 ||
    parts[0] !== "nave-admin" ||
    !daoMatches ||
    parts[2] !== "toggle_agents" ||
    parts[3] !== enabledFlag
  ) {
    return jsonResponse({ error: "Malformed challenge message" }, 400);
  }
  if (checkChallengeTimestamp(parts[4])) {
    return jsonResponse({ error: "Challenge expired or not yet valid" }, 401);
  }

  // ── Verify the founder's signature over the challenge ──
  // Solana: ed25519 (base64/base58) against the base58 wallet.
  // EVM: 0x-hex EIP-191 personal_sign verified/recovered against the address.
  const verified = await verifyWalletSignature(evm ? "evm" : "solana", wallet, message, signature);
  if (!verified) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  // ── Confirm the signer is the DAO founder (ON-CHAIN authority) ──
  // FAIL CLOSED: without an RPC, or if the founder can't be read, reject.
  // dao_registry.creator_wallet is a writable off-chain hint and never gates.
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
    if (onChainFounder !== wallet) {
      return jsonResponse({ error: "Signer is not the DAO founder" }, 403);
    }
  } else {
    const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
    if (!rpcUrl) {
      console.error("agent-admin: SOLANA_RPC_URL unset — cannot verify founder on-chain");
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

  // ── Replay protection: each signed challenge may be consumed at most once ──
  const consumed = await consumeChallenge(supabase, {
    wallet,
    chain: replayChainLabel(chainSel.chain, chainSel.chain_id),
    verified,
    daoAddress: dao_address,
  });
  if (!consumed.ok) {
    return jsonResponse({ error: consumed.error }, consumed.status);
  }

  // ── Forward to the signer with the server-held secret ──
  // EVM: the toggle is an on-chain tx broadcast by the EVM relayer from a
  // custodied agent/guardian EOA. Resume → Executive toggleAgents(true). Pause →
  // guardian M-of-N `guardianAction(DISABLE_AGENTS, sigs)`: the relayer
  // signs with every custodied guardian and appends the optional
  // `guardian_signatures` the founder produced in-browser (EIP-712
  // GuardianAction DISABLE_AGENTS over the SAME `guardian_nonce` /
  // `guardian_deadline`). Solana: the Anchor signer path.
  // The founder signature + founder match + single-use nonce are verified above
  // identically for both chains.
  const endpoint = evm ? "/relay-evm" : "/sign";
  const externalGuardianSigs: string[] = Array.isArray(body.guardian_signatures)
    ? (body.guardian_signatures as unknown[]).filter(
        (s): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{130}$/.test(s),
      )
    : [];
  if (evm && !enabled && externalGuardianSigs.length > 0
    && (body.guardian_nonce == null || body.guardian_deadline == null)) {
    return jsonResponse({ error: "guardian_nonce and guardian_deadline are required with guardian_signatures" }, 400);
  }
  const forwardBody = evm
    ? {
        action: "toggle_agents",
        dao_address,
        enabled,
        chain: chainSel.chain,
        chain_id: chainSel.chain_id,
        ...(enabled
          ? {}
          : {
              guardian_signatures: externalGuardianSigs,
              nonce: body.guardian_nonce != null ? String(body.guardian_nonce) : undefined,
              deadline: body.guardian_deadline != null ? String(body.guardian_deadline) : undefined,
            }),
      }
    : {
        action: "toggle_agents",
        dao_address,
        agent_role: "executive",
        enabled,
        chain: chainSel.chain,
        chain_id: chainSel.chain_id,
      };
  const resp = await fetch(`${signerUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signer-Secret": signerSecretFor(evm ? "guardian" : "executive") ?? signerSecret,
    },
    body: JSON.stringify(forwardBody),
  });

  const data = await resp.json().catch(() => ({}));

  // Best-effort audit trail (mirrors orchestrator action logging).
  await supabase.from("agent_action_logs").insert({
    dao_onchain_address: dao_address,
    chain: chainSel.chain,
    chain_id: chainSel.chain_id,
    agent_role: "executive",
    action_type: "toggle_agents",
    reasoning: resp.ok
      ? `Founder ${wallet} ${enabled ? "resumed" : "paused"} agents on-chain (sig ${data.signature ?? "?"}).`
      : `Founder ${wallet} toggle_agents(${enabled}) failed: ${data.error ?? `HTTP ${resp.status}`}`,
    constitution_check: {},
    payload_hash: "",
    tx_signature: data.signature || "",
    status: resp.ok ? "completed" : "failed",
    error_message: resp.ok ? "" : (data.error || `HTTP ${resp.status}`),
    decision: enabled ? "resume" : "pause",
    retry_count: 0,
  }).then(undefined, () => {});

  return jsonResponse(data, resp.status);
});
