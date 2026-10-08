import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2.21.55/accounts";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { type ChainKind, isEvmChain, normalizeChain, normalizeEvmAddress } from "../_shared/chain.ts";
import {
  EVM_RPC_CONFIG,
  hasEvmRpc,
  readEvmTreasuryFounder,
  verifyEvmTreasuryMembership,
} from "../_shared/evmFounder.ts";
import { checkChallengeTimestamp, verifyWalletSignature } from "../_shared/walletAuth.ts";
import { consumeChallenge, replayChainLabel } from "../_shared/replay.ts";

// EVM KEK selection MUST mirror the signer-service (signer-service/src/kek.ts
// unwrapEvmDek): prefer a dedicated NAVE_EVM_MASTER_KEK, else NAVE_MASTER_KEK.
// We wrap the per-key DEK under that exact key so the signer can unwrap it.
function evmKekBase64(): string {
  const k = Deno.env.get("NAVE_EVM_MASTER_KEK") || Deno.env.get("NAVE_MASTER_KEK");
  if (!k) throw new Error("No EVM KEK configured (NAVE_EVM_MASTER_KEK or NAVE_MASTER_KEK)");
  return k;
}

// ArrayBuffer-backed so the result satisfies WebCrypto's BufferSource type.
function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Wrap a raw DEK (base64) under the EVM master KEK (AES-256-GCM envelope). */
async function wrapEvmDek(dekBase64: string): Promise<{ wrapped_dek: string; dek_wrap_iv: string; dek_wrap_tag: string }> {
  const keyBytes = b64ToBytes(evmKekBase64());
  if (keyBytes.length !== 32) throw new Error("EVM KEK must decode to 32 bytes (256-bit)");
  const kek = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, kek, b64ToBytes(dekBase64)),
  );
  const ct = encrypted.slice(0, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);
  return { wrapped_dek: bytesToB64(ct), dek_wrap_iv: bytesToB64(iv), dek_wrap_tag: bytesToB64(tag) };
}

// ─── EVM counterpart to generate-agent-keys (secp256k1 + guardian) ────────────
//
// Generates and securely stores secp256k1 agent EOAs (executive | financial |
// oversight | operational) plus one server-custodied guardian signer for an EVM
// (Ethereum / Base) DAO, populating `encrypted_evm_keys`. Mirrors the Solana
// Ed25519 generate-agent-keys flow but for the EVM path.
//
// Architectural note — why a two-phase ref+bind:
//   On Solana the DAO address is a deterministic PDA, so keys can be bound to it
//   before creation. On EVM, NaveDAOFactory deploys EIP-1167 clones with CREATE
//   (Clones.clone), so the treasury address is NOT knowable until the createDao
//   tx is mined. We therefore generate keys under an unguessable client ref
//   (`pending:<uuid>`), return the agent addresses for the createDao params, and
//   rebind the rows to the real treasury address once the DaoCreated event is
//   observed (action: "bind").
//
// Scope: the supported EVM chains in ../_shared/chain.ts (Ethereum / Base /
// Robinhood mainnets + testnets).
//
// Bind security: rebinding custody keys to a treasury address is founder-only
// and the treasury must be a genuine clone of the configured NaveProtocol.
// Both facts are read ON-CHAIN (NaveTreasury.founder(), NaveTreasury.protocol()
// + NaveProtocol.isNaveTreasury) — never from the writable dao_registry row.

const AGENT_ROLES = ["executive", "financial", "oversight", "operational"] as const;

interface GeneratePayload {
  action?: "generate" | "bind";
  // Client-chosen unguessable reference for the soon-to-be-created DAO.
  dao_ref: string;
  // Founder wallet (0x EVM address) — proven via EIP-191 personal_sign below.
  founder: string;
  creator_signature: string; // 0x-hex EIP-191 signature
  chain?: string; // 'ethereum' | 'base'
  chain_id?: number; // 1 | 8453 | 11155111 | 84532
  // bind only: the real treasury address from the DaoCreated event.
  treasury?: string;
  // Challenge message that was signed (must match the canonical templates).
  message: string;
}

const REF_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_CHALLENGE_AGE_MS = 10 * 60 * 1000;

function pendingAddress(daoRef: string): string {
  return `pending:${daoRef.toLowerCase()}`;
}

async function encryptKey(
  plaintext: Uint8Array,
): Promise<{ ciphertext: string; iv: string; tag: string; dek: string }> {
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, aesKey, new Uint8Array(plaintext)),
  );
  const ct = encrypted.slice(0, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);
  const rawDek = new Uint8Array(await crypto.subtle.exportKey("raw", aesKey));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return { ciphertext: b64(ct), iv: b64(iv), tag: b64(tag), dek: b64(rawDek) };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const limited = rateLimit(req, { key: clientKey(req, "evm-genkeys"), limit: 5, windowMs: 60_000 }, corsHeaders);
  if (limited) return limited;

  let body: GeneratePayload;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action ?? "generate";
  const { dao_ref, message, creator_signature } = body;
  let founder = body.founder;
  if (!dao_ref || !founder || !message || !creator_signature) {
    return jsonResponse({ error: "Missing dao_ref, founder, message, or creator_signature" }, 400);
  }
  if (!REF_RE.test(dao_ref)) {
    return jsonResponse({ error: "dao_ref must be 8-64 url-safe chars" }, 400);
  }

  // ── Chain (EVM only) ──
  let chainSel: { chain: ChainKind; chain_id: number | null };
  try {
    chainSel = normalizeChain(body.chain, body.chain_id);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Invalid chain" }, 400);
  }
  if (!isEvmChain(chainSel.chain) || chainSel.chain_id === null) {
    return jsonResponse({ error: "generate-evm-agent-keys is EVM-only (chain ethereum|base|robinhood + chain_id)" }, 400);
  }
  try {
    founder = normalizeEvmAddress(founder);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Invalid founder address" }, 400);
  }

  // ── Verify the founder EIP-191 signature + challenge freshness ──
  const parts = message.split("|");
  if (checkChallengeTimestamp(parts[parts.length - 1], { maxAgeMs: MAX_CHALLENGE_AGE_MS })) {
    return jsonResponse({ error: "Challenge expired or not yet valid" }, 401);
  }
  const verified = await verifyWalletSignature("evm", founder, message, creator_signature);
  if (!verified) return jsonResponse({ error: "Invalid founder signature" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Service not configured" }, 500);
  if (!Deno.env.get("NAVE_EVM_MASTER_KEK") && !Deno.env.get("NAVE_MASTER_KEK")) {
    return jsonResponse({ error: "Service not configured: NAVE_EVM_MASTER_KEK or NAVE_MASTER_KEK" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey);
  const chainId = chainSel.chain_id;
  const chainKind = chainSel.chain;

  // ── BIND: rebind pending rows to the real treasury address ──
  if (action === "bind") {
    if (!body.treasury) return jsonResponse({ error: "treasury is required for bind" }, 400);
    let treasury: string;
    try {
      treasury = normalizeEvmAddress(body.treasury);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Invalid treasury address" }, 400);
    }
    // Expected challenge: nave-evm-keybind|<dao_ref>|<treasury>|<chain_id>|<ts>
    if (
      parts.length !== 5 || parts[0] !== "nave-evm-keybind" ||
      parts[1] !== dao_ref || parts[2]?.toLowerCase() !== treasury || Number(parts[3]) !== chainId
    ) {
      return jsonResponse({ error: "Malformed bind challenge message" }, 400);
    }

    // ── On-chain authority: founder() must be the signer, and the treasury must
    // be a registered clone of the configured NaveProtocol. Fail closed when the
    // per-chain RPC or protocol address is not configured.
    if (!hasEvmRpc(chainId)) {
      return jsonResponse(
        { error: `Service not configured: ${EVM_RPC_CONFIG[chainId]?.rpcEnv ?? "EVM RPC"} required for bind verification` },
        500,
      );
    }
    const onChainFounder = await readEvmTreasuryFounder(chainId, treasury);
    if (onChainFounder === null) {
      return jsonResponse({ error: "Could not verify DAO founder on-chain (EVM)" }, 502);
    }
    if (onChainFounder !== founder) {
      return jsonResponse({ error: "Signer is not the on-chain treasury founder" }, 403);
    }
    const membership = await verifyEvmTreasuryMembership(chainId, treasury);
    if (!membership.ok) {
      if (membership.reason === "protocol_unconfigured") {
        return jsonResponse(
          { error: `Service not configured: ${EVM_RPC_CONFIG[chainId]?.protocolEnv ?? "EVM protocol address"}` },
          500,
        );
      }
      if (membership.reason === "read_failed" || membership.reason === "rpc_unavailable") {
        return jsonResponse({ error: "Could not verify treasury protocol membership on-chain" }, 502);
      }
      return jsonResponse({ error: "Treasury is not a NaveProtocol-registered treasury" }, 403);
    }

    // Single-use: a captured bind challenge must not be replayable.
    const consumed = await consumeChallenge(supabase, {
      wallet: founder,
      chain: replayChainLabel(chainKind, chainId),
      verified,
      daoAddress: treasury,
    });
    if (!consumed.ok) return jsonResponse({ error: consumed.error }, consumed.status);

    const { data: updated, error: updErr } = await supabase
      .from("encrypted_evm_keys")
      .update({ dao_onchain_address: treasury })
      .eq("dao_onchain_address", pendingAddress(dao_ref))
      .eq("chain_id", chainId)
      .eq("is_active", true)
      .select("signer_role, evm_address, guardian_index");
    if (updErr) {
      console.error("evm key bind failed:", updErr);
      return jsonResponse({ error: "Failed to bind EVM keys" }, 500);
    }
    return jsonResponse({ success: true, dao_address: treasury, chain: chainKind, chain_id: chainId, bound: updated?.length ?? 0 });
  }

  // ── GENERATE: create 4 agent EOAs + 1 guardian under the pending ref ──
  // Expected challenge: nave-evm-keygen|<dao_ref>|<chain_id>|<ts>
  if (
    parts.length !== 4 || parts[0] !== "nave-evm-keygen" ||
    parts[1] !== dao_ref || Number(parts[2]) !== chainId
  ) {
    return jsonResponse({ error: "Malformed keygen challenge message" }, 400);
  }

  const daoAddr = pendingAddress(dao_ref);

  // Single-use challenge. Consumed before generation so a replayed keygen
  // cannot mint a second key set under a fresh ref-collision.
  const consumed = await consumeChallenge(supabase, {
    wallet: founder,
    chain: replayChainLabel(chainKind, chainId),
    verified,
    daoAddress: daoAddr,
  });
  if (!consumed.ok) return jsonResponse({ error: consumed.error }, consumed.status);
  // Idempotency: if rows already exist for this ref, return their addresses.
  const { data: existing } = await supabase
    .from("encrypted_evm_keys")
    .select("signer_role, evm_address, guardian_index")
    .eq("dao_onchain_address", daoAddr)
    .eq("chain_id", chainId)
    .eq("is_active", true);
  if (existing && existing.length > 0) {
    const agents: Record<string, { address: string }> = {};
    let guardian: { address: string } | null = null;
    for (const r of existing) {
      if (r.signer_role === "guardian") guardian = { address: String(r.evm_address) };
      else agents[String(r.signer_role)] = { address: String(r.evm_address) };
    }
    return jsonResponse({
      success: true, dao_ref, dao_address: daoAddr, chain: chainKind, chain_id: chainId,
      agents, guardian, regenerated: false,
      warning: "EVM agent keys already existed for this ref; returning addresses.",
    });
  }

  const rows: Array<Record<string, unknown>> = [];
  const agents: Record<string, { address: string }> = {};
  const roleList: string[] = [...AGENT_ROLES, "guardian"];
  for (const role of roleList) {
    const privKey = generatePrivateKey();
    const account = privateKeyToAccount(privKey);
    const address = account.address.toLowerCase();
    // Persist the 0x-hex private key string (the signer accepts hex or 32 raw bytes).
    const { ciphertext, iv, tag, dek } = await encryptKey(new TextEncoder().encode(privKey));
    const wrapped = await wrapEvmDek(dek);
    rows.push({
      dao_onchain_address: daoAddr,
      chain: chainKind,
      chain_id: chainId,
      signer_role: role,
      guardian_index: role === "guardian" ? 0 : null,
      evm_address: address,
      encrypted_private_key: ciphertext,
      encryption_iv: iv,
      encryption_tag: tag,
      wrapped_dek: wrapped.wrapped_dek,
      dek_wrap_iv: wrapped.dek_wrap_iv,
      dek_wrap_tag: wrapped.dek_wrap_tag,
      is_active: true,
    });
    if (role === "guardian") continue;
    agents[role] = { address };
  }

  const { error: insErr } = await supabase.from("encrypted_evm_keys").insert(rows);
  if (insErr) {
    console.error("Failed to store EVM agent keys:", insErr);
    return jsonResponse({ error: "Failed to store EVM agent keys" }, 500);
  }

  const guardianRow = rows.find((r) => r.signer_role === "guardian");
  return jsonResponse({
    success: true,
    dao_ref,
    dao_address: daoAddr,
    chain: chainKind,
    chain_id: chainId,
    agents,
    guardian: guardianRow ? { address: guardianRow.evm_address as string } : null,
    regenerated: true,
    warning:
      "EVM secp256k1 agent + guardian keys generated under a pending ref. Call action='bind' with the treasury address after the DaoCreated event to associate them with the on-chain DAO.",
  });
});
