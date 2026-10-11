import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import nacl from "npm:tweetnacl@1.0.3";
import bs58 from "npm:bs58@5.0.0";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { wrapDekBound } from "../_shared/kek.ts";
import { daoRegistryPda, readDaoFounder } from "../_shared/onchain.ts";
import {
  checkChallengeTimestamp,
  isValidChallengeNonce,
  verifyWalletSignature,
} from "../_shared/walletAuth.ts";
import { consumeChallenge } from "../_shared/replay.ts";

// Founder credential: a TIMESTAMPED, single-use challenge (no static bearer):
//   creator_message   = `nave-agent-keys|<dao_address>|solana|<issued_at_unix_ms>|<nonce>`
//   creator_signature = ed25519 over the message (base58 or base64)
// Expires after 5 minutes; consumed via dispatch_nonces.
//
// break_glass (raw DEK export) additionally requires the operator secret in the
// `X-Break-Glass-Secret` header matching NAVE_BREAK_GLASS_SECRET. When that env
// is absent the mode is disabled outright.
const AGENT_KEYS_CHALLENGE_PREFIX = "nave-agent-keys";

// ─── Crypto helpers ──────────────────────────────────────────────────────────

/** Generate a random 256-bit AES-GCM key, returned as a CryptoKey. */
async function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable — we need to export it once
    ["encrypt", "decrypt"],
  );
}

/** Export a CryptoKey to a base64 string (returned ONCE to the caller). */
async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

/** Encrypt a Uint8Array with AES-256-GCM. Returns { ciphertext, iv, tag } as base64. */
async function encryptPrivateKey(
  privateKeyBytes: Uint8Array,
  aesKey: CryptoKey,
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    // Copy into an ArrayBuffer-backed view (tweetnacl arrays are ArrayBufferLike).
    new Uint8Array(privateKeyBytes),
  );

  // WebCrypto appends the 16-byte auth tag to the ciphertext
  const encryptedArr = new Uint8Array(encrypted);
  const ciphertextOnly = encryptedArr.slice(0, encryptedArr.length - 16);
  const tag = encryptedArr.slice(encryptedArr.length - 16);

  return {
    ciphertext: btoa(String.fromCharCode(...ciphertextOnly)),
    iv: btoa(String.fromCharCode(...iv)),
    tag: btoa(String.fromCharCode(...tag)),
  };
}

// ─── Main handler ────────────────────────────────────────────────────────────

interface RequestPayload {
  dao_address: string;
  creator_wallet: string;
  /** `nave-agent-keys|<dao_address>|solana|<issued_at_ms>|<nonce>` */
  creator_message: string;
  creator_signature: string; // base58 (or base64) ed25519 signature over creator_message
  // Required for pre-creation key gen: proves dao_address is the canonical
  // PDA(["dao", creator_wallet, dao_id]) for this founder before the DAO exists.
  dao_id?: number;
  // Optional role override. Defaults to the canonical 4-agent pipeline roles.
  // Allows provisioning of a dedicated planner key without regenerating all keys.
  roles?: string[];
  // Break-glass ONLY: return the raw decrypt keys (DEKs) in the response for
  // external custody. Off by default — normal operation persists the wrapped DEK
  // and the signer unwraps it at runtime, so the raw DEK never needs to leave
  // the function. Returning it on every DAO creation is a standing exfiltration
  // risk, so it is gated behind this explicit, logged flag.
  break_glass?: boolean;
}

const AGENT_ROLES = [
  "executive",
  "financial",
  "oversight",
  "operational",
  "planner",
] as const;
const DEFAULT_PIPELINE_ROLES = AGENT_ROLES.slice(0, 4);

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Only accept POST
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // Key generation is expensive and creator-gated; cap hard per IP.
    const limited = rateLimit(req, { key: clientKey(req, "genkeys"), limit: 5, windowMs: 60_000 }, corsHeaders);
    if (limited) return limited;

    const body: RequestPayload = await req.json();
    const { dao_address, creator_wallet, creator_message, creator_signature, dao_id } = body;
    const breakGlass = body.break_glass === true;

    // ── Break-glass operator gate ────────────────────────────────────────
    // Raw DEK export is an exfiltration path; the founder signature alone is
    // not sufficient. Require the operator secret, and disable the mode when
    // no secret is configured.
    if (breakGlass) {
      const breakGlassSecret = Deno.env.get("NAVE_BREAK_GLASS_SECRET");
      if (!breakGlassSecret) {
        return jsonResponse({ error: "break_glass is disabled (NAVE_BREAK_GLASS_SECRET not configured)" }, 403);
      }
      if (!secretsMatch(req.headers.get("X-Break-Glass-Secret"), breakGlassSecret)) {
        return jsonResponse({ error: "Unauthorized break_glass request" }, 401);
      }
    }
    const requestedRoles = (body.roles && body.roles.length > 0)
      ? [...new Set(body.roles.map((r) => String(r).trim()))]
      : [...DEFAULT_PIPELINE_ROLES];
    const invalidRoles = requestedRoles.filter(
      (role) => !(AGENT_ROLES as readonly string[]).includes(role),
    );
    if (invalidRoles.length > 0) {
      return jsonResponse(
        { error: `Invalid role(s): ${invalidRoles.join(", ")}` },
        400,
      );
    }

    if (!dao_address || !creator_wallet || !creator_signature || !creator_message) {
      return jsonResponse(
        { error: "Missing required fields: dao_address, creator_wallet, creator_message, creator_signature" },
        400,
      );
    }

    // ── Verify the timestamped creator challenge ─────────────────────────
    // `nave-agent-keys|<dao_address>|solana|<issued_at_ms>|<nonce>`
    const parts = creator_message.split("|");
    if (
      parts.length !== 5 ||
      parts[0] !== AGENT_KEYS_CHALLENGE_PREFIX ||
      parts[1] !== dao_address ||
      parts[2] !== "solana" ||
      !isValidChallengeNonce(parts[4])
    ) {
      return jsonResponse({ error: "Malformed creator challenge message" }, 400);
    }
    if (checkChallengeTimestamp(parts[3])) {
      return jsonResponse({ error: "Creator challenge expired or not yet valid" }, 401);
    }
    const verified = await verifyWalletSignature("solana", creator_wallet, creator_message, creator_signature);
    if (!verified) {
      return jsonResponse({ error: "Invalid creator signature" }, 403);
    }

    // ── Bind to the DAO founder (H6) ──────────────────────────────────────
    // Generating agent custody keys is founder-only; a signature proving wallet
    // ownership is not enough — the wallet must be the DAO's founder. Agent keys
    // are needed BEFORE initialize_dao (their pubkeys are set at creation), so
    // this must succeed pre-creation. We bind in two ways:
    //   • DAO already on-chain → require DaoRegistry.founder == creator_wallet.
    //   • DAO not yet created  → require dao_address to be the canonical PDA
    //     ["dao", creator_wallet, dao_id]. Only the founder's own wallet derives
    //     that address, so this proves intended ownership without the account
    //     existing yet. The Ed25519 signature above proves wallet control.
    // FAIL CLOSED: founder binding is mandatory. Without an RPC endpoint we
    // cannot verify the on-chain founder (and, pre-creation, cannot distinguish a
    // real PDA from a guess), so we reject rather than mint custody keys for an
    // unverified wallet. No devnet/default fallback is permitted on any path.
    const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
    if (!rpcUrl) {
      console.error("generate-agent-keys: SOLANA_RPC_URL unset — refusing to generate keys without founder verification");
      return jsonResponse(
        { error: "Service not configured: SOLANA_RPC_URL required for founder verification" },
        500,
      );
    }
    const founder = await readDaoFounder(rpcUrl, dao_address);
    if (founder) {
      if (founder !== creator_wallet) {
        return jsonResponse(
          { error: "creator_wallet is not the on-chain DAO founder" },
          403,
        );
      }
    } else {
      // Pre-creation: verify the canonical DAO PDA for this founder + dao_id.
      if (dao_id === undefined || dao_id === null || !Number.isFinite(dao_id)) {
        return jsonResponse(
          { error: "DAO not found on-chain; dao_id is required for pre-creation key generation" },
          400,
        );
      }
      let derived: string;
      try {
        derived = daoRegistryPda(creator_wallet, dao_id);
      } catch {
        return jsonResponse({ error: "Invalid creator_wallet or dao_id" }, 400);
      }
      if (derived !== dao_address) {
        return jsonResponse(
          { error: "dao_address is not the canonical PDA for creator_wallet + dao_id" },
          403,
        );
      }
    }

    // ── Initialize Supabase service-role client ───────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ── Single-use challenge (canonical, encoding-independent replay key) ──
    const consumed = await consumeChallenge(supabase, {
      wallet: creator_wallet,
      chain: "solana",
      verified,
      daoAddress: dao_address,
    });
    if (!consumed.ok) return jsonResponse({ error: consumed.error }, consumed.status);

    // ── Check if keys already exist for this DAO ─────────────────────────
    const { data: existing } = await supabase
      .from("encrypted_agent_keys")
      .select("id, agent_role, public_key")
      .eq("dao_onchain_address", dao_address)
      .eq("is_active", true)
      .in("agent_role", requestedRoles);

    const existingByRole = new Map(
      (existing ?? []).map((r) => [
        String(r.agent_role),
        String(r.public_key),
      ]),
    );
    const existingRoles = new Set(existingByRole.keys());
    const rolesToGenerate = requestedRoles.filter((role) => !existingRoles.has(role));

    // ── Envelope encryption requires a master KEK ────────────────────────
    // The per-DAO/per-role data keys (DEKs) are wrapped under this KEK and
    // persisted, so servers can unwrap on demand instead of relying on four
    // reused global env AES keys.
    if (!Deno.env.get("NAVE_MASTER_KEK")) {
      return jsonResponse(
        { error: "Service not configured: NAVE_MASTER_KEK" },
        500,
      );
    }

    // ── Generate keypairs + encrypt ───────────────────────────────────────
    const result: Record<string, { pubkey: string; decrypt_key?: string }> = {};
    for (const role of requestedRoles) {
      const pubkey = existingByRole.get(role);
      if (pubkey) {
        result[role] = { pubkey };
      }
    }
    const dbRows: Array<{
      dao_onchain_address: string;
      agent_role: string;
      encrypted_private_key: string;
      encryption_iv: string;
      encryption_tag: string;
      public_key: string;
      wrapped_dek: string;
      dek_wrap_iv: string;
      dek_wrap_tag: string;
      dek_wrap_version: number;
      dek_kek_ref: string;
    }> = [];

    for (const role of rolesToGenerate) {
      // Generate Ed25519 keypair (Solana-compatible)
      const keypair = nacl.sign.keyPair();
      const publicKeyBase58 = bs58.encode(keypair.publicKey);

      // Generate unique AES-256-GCM data key (DEK) for this agent
      const aesKey = await generateAesKey();

      // Encrypt the 64-byte secret key under the DEK
      const { ciphertext, iv, tag } = await encryptPrivateKey(
        keypair.secretKey,
        aesKey,
      );

      // Export the DEK and wrap it (per-role KEK when configured), bound to
      // this DAO, role and chain.
      const decryptKeyBase64 = await exportKeyToBase64(aesKey);
      const wrapped = await wrapDekBound("solana", decryptKeyBase64, {
        dao: dao_address,
        role,
        chain: "solana",
      });

      dbRows.push({
        dao_onchain_address: dao_address,
        agent_role: role,
        encrypted_private_key: ciphertext,
        encryption_iv: iv,
        encryption_tag: tag,
        public_key: publicKeyBase58,
        wrapped_dek: wrapped.wrapped_dek,
        dek_wrap_iv: wrapped.dek_wrap_iv,
        dek_wrap_tag: wrapped.dek_wrap_tag,
        dek_wrap_version: wrapped.dek_wrap_version,
        dek_kek_ref: wrapped.dek_kek_ref,
      });

      // The wrapped DEK is persisted, so normal operation NEVER needs the raw
      // decrypt key in the response. Only include it when an explicit
      // break-glass request asks for external custody — and log that it happened.
      if (breakGlass) {
        result[role] = {
          pubkey: publicKeyBase58,
          decrypt_key: decryptKeyBase64,
        };
      } else {
        result[role] = { pubkey: publicKeyBase58 };
      }
    }

    if (breakGlass) {
      console.warn(
        `generate-agent-keys: BREAK-GLASS raw DEK export for dao=${dao_address} roles=${rolesToGenerate.join(",")}`,
      );
    }

    // ── Store encrypted keys in database ──────────────────────────────────
    if (dbRows.length > 0) {
      const { error: insertError } = await supabase
        .from("encrypted_agent_keys")
        .insert(dbRows);

      if (insertError) {
        console.error("Failed to store agent keys:", insertError);
        return jsonResponse(
          { error: "Failed to store agent keys" },
          500,
        );
      }
    }

    // ── Return pubkeys + decrypt keys (ONE-TIME) ─────────────────────────
    // The raw decrypt keys are never stored. The wrapped DEK (encrypted under
    // NAVE_MASTER_KEK) is persisted so servers can unwrap on demand; the master
    // KEK itself lives only in server env / KMS.
    return jsonResponse({
      success: true,
      dao_address,
      agents: result,
      generated_roles: rolesToGenerate,
      warning: rolesToGenerate.length === 0
        ? "Agent keys already existed for this DAO. Returning public keys only; decrypt keys are stored wrapped server-side."
        : breakGlass
        ? "BREAK-GLASS: raw decrypt keys returned exactly once and cannot be recovered. Store them in offline custody and treat as highly sensitive."
        : "Agent keys generated. Decrypt keys are persisted wrapped under the master KEK and are NOT returned; pass break_glass=true only for offline custody export.",
    });
  } catch (error) {
    console.error("generate-agent-keys error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
