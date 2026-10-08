import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { readDaoFounder } from "../_shared/onchain.ts";
import {
  type ChainKind,
  daoNetworkFor,
  isEvmChain,
  normalizeChain,
  normalizeEvmAddress,
} from "../_shared/chain.ts";
import { isMainnetCluster } from "../_shared/cluster.ts";
import { EVM_RPC_CONFIG, readEvmTreasuryFounder } from "../_shared/evmFounder.ts";
import {
  checkChallengeTimestamp,
  isValidChallengeNonce,
  verifyWalletSignature,
} from "../_shared/walletAuth.ts";
import { consumeChallenge, replayChainLabel } from "../_shared/replay.ts";

// ─── Request payload ─────────────────────────────────────────────────────────
// The off-chain metadata companion to the on-chain DAO. The canonical identity
// (dao_id, founder) is also written by the indexer from DaoInitialized; this
// function attaches the rich, user-supplied fields that aren't on-chain.
//
// Founder credential: a TIMESTAMPED, single-use challenge (no static bearer):
//   creator_message = `nave-register-dao|<dao_address>|<chain_id|solana>|<issued_at_unix_ms>|<nonce>`
//   creator_signature = Solana: ed25519 over the message (base58 or base64)
//                       EVM:    0x-hex EIP-191 personal_sign over the message
// The challenge expires after 5 minutes and is consumed via dispatch_nonces.

const REGISTER_CHALLENGE_PREFIX = "nave-register-dao";

interface RequestPayload {
  dao_address: string;
  creator_wallet: string;
  /** The signed challenge (see header). */
  creator_message: string;
  /** Signature over `creator_message` (Solana base58/base64 ed25519; EVM 0x-hex EIP-191). */
  creator_signature: string;
  // Multi-chain discriminator. Defaults to 'solana' when omitted.
  chain?: string; // 'solana' | 'ethereum' | 'base' | 'robinhood'
  chain_id?: number; // EVM numeric id (1 | 8453 | 4663 | 11155111 | 84532 | 46630)
  name: string;
  description?: string;
  logo_url?: string;
  governance_type?: string; // 'wallet' | 'wallets' | 'token'
  privacy_enabled?: boolean;
  voting_token_mint?: string;
  authorized_wallets?: string[];
  social_twitter?: string;
  social_discord?: string;
  social_website?: string;
  dao_id?: number;
  slug?: string;
}

function normalizeGovernanceType(v?: string): "wallet" | "token" {
  return v === "token" ? "token" : "wallet";
}

const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "www", "create", "create-dao", "dashboard", "settings",
  "governance", "tokens", "agent", "policy", "treasuries", "dao", "dao-created",
  "login", "signup", "help", "support", "docs", "static", "assets",
]);

function normalizeSlug(input?: string): string {
  if (!input) return "";
  const trimmed = input.trim().toLowerCase();
  const withoutSuffix = trimmed.endsWith(".dao") ? trimmed.slice(0, -4) : trimmed;
  return withoutSuffix
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function validateSlug(slug: string): string | null {
  if (!slug) return "Missing slug";
  if (slug.length < 3) return "Slug must be at least 3 characters";
  if (!SLUG_PATTERN.test(slug)) {
    return "Slug must start with a letter and use lowercase letters, numbers, and hyphens";
  }
  if (RESERVED_SLUGS.has(slug)) return "That DAO name is reserved";
  return null;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // Browser-reachable; throttle abuse per IP (M9).
    const limited = rateLimit(req, { key: clientKey(req, "register-dao"), limit: 10, windowMs: 60_000 }, corsHeaders);
    if (limited) return limited;

    const body: RequestPayload = await req.json();
    let { dao_address, creator_wallet } = body;
    const { creator_message, creator_signature, name } = body;

    if (!dao_address || !creator_wallet || !creator_signature || !creator_message) {
      return jsonResponse(
        {
          error:
            "Missing required fields: dao_address, creator_wallet, creator_message, creator_signature",
        },
        400,
      );
    }

    // ── Resolve the chain discriminator (defaults to Solana) ──────────────
    let selector: { chain: ChainKind; chain_id: number | null };
    try {
      selector = normalizeChain(body.chain, body.chain_id);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Invalid chain" }, 400);
    }
    const evm = isEvmChain(selector.chain);
    if (evm) {
      // Addresses are stored lowercased for consistent lookups across the backend.
      try {
        dao_address = normalizeEvmAddress(dao_address);
        creator_wallet = normalizeEvmAddress(creator_wallet);
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "Invalid EVM address" }, 400);
      }
    }

    // ── Verify the timestamped challenge ──────────────────────────────────
    // `nave-register-dao|<dao_address>|<chain_id|solana>|<issued_at_ms>|<nonce>`
    const parts = creator_message.split("|");
    const expectedChainField = evm ? String(selector.chain_id) : "solana";
    const daoMatches = evm
      ? parts[1]?.toLowerCase() === dao_address
      : parts[1] === dao_address;
    if (
      parts.length !== 5 ||
      parts[0] !== REGISTER_CHALLENGE_PREFIX ||
      !daoMatches ||
      parts[2] !== expectedChainField ||
      !isValidChallengeNonce(parts[4])
    ) {
      return jsonResponse({ error: "Malformed creator challenge message" }, 400);
    }
    if (checkChallengeTimestamp(parts[3])) {
      return jsonResponse({ error: "Creator challenge expired or not yet valid" }, 401);
    }
    const verified = await verifyWalletSignature(
      evm ? "evm" : "solana",
      creator_wallet,
      creator_message,
      creator_signature,
    );
    if (!verified) {
      return jsonResponse({ error: evm ? "Invalid creator signature (EVM)" : "Invalid creator signature" }, 403);
    }

    if (evm) {
      // ── Bind to the on-chain DAO founder (C-2) ──────────────────────────
      // The signature proves control of creator_wallet, but NOT that it owns
      // this contract. Read NaveTreasury.founder() over the per-chain EVM RPC
      // and require an exact match, mirroring the Solana readDaoFounder gate so
      // nobody can claim an arbitrary EVM contract they don't found. When the
      // per-chain RPC is unset we warn + skip (same posture as the Solana path).
      const onchainFounder = await readEvmTreasuryFounder(
        selector.chain_id as number,
        dao_address,
      );
      if (onchainFounder === null) {
        const cfg = EVM_RPC_CONFIG[selector.chain_id as number];
        if (cfg && Deno.env.get(cfg.rpcEnv)) {
          // RPC was configured but the read failed → treat as unverifiable.
          return jsonResponse(
            { error: "Could not verify DAO founder on-chain (EVM)" },
            400,
          );
        }
        // Fail CLOSED: no per-chain RPC means we cannot bind the founder, so we
        // must reject rather than accept an unverified EVM DAO registration.
        return jsonResponse(
          { error: `Service not configured: ${cfg?.rpcEnv ?? "EVM RPC"}` },
          500,
        );
      } else if (onchainFounder !== creator_wallet) {
        return jsonResponse(
          { error: "creator_wallet is not the on-chain DAO founder" },
          403,
        );
      }
    } else {
      // ── Bind to the on-chain DAO founder (H6) ───────────────────────────
      // A valid signature only proves the caller controls creator_wallet. It
      // must ALSO be the DAO's actual on-chain founder, otherwise anyone could
      // attach (or overwrite) metadata for a DAO they don't own.
      // Fail CLOSED: without an RPC we cannot prove founder ownership, so we
      // must NOT accept the registration (a valid signature alone lets any
      // wallet claim a DAO it does not own). Mirrors generate-agent-keys and
      // orchestrator-proxy, which also 500 when SOLANA_RPC_URL is absent.
      const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
      if (!rpcUrl) {
        return jsonResponse(
          { error: "Service not configured: SOLANA_RPC_URL" },
          500,
        );
      }
      const founder = await readDaoFounder(rpcUrl, dao_address);
      if (!founder) {
        return jsonResponse(
          { error: "Could not verify DAO founder on-chain" },
          400,
        );
      }
      if (founder !== creator_wallet) {
        return jsonResponse(
          { error: "creator_wallet is not the on-chain DAO founder" },
          403,
        );
      }
    }

    const slug = normalizeSlug(body.slug);
    const slugError = validateSlug(slug);
    if (slugError) {
      return jsonResponse({ error: slugError }, 400);
    }

    // ── Upsert off-chain metadata (service-role) ──────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Single-use challenge (canonical replay key; encoding-independent).
    const consumed = await consumeChallenge(supabase, {
      wallet: creator_wallet,
      chain: replayChainLabel(selector.chain, selector.chain_id),
      verified,
      daoAddress: dao_address,
    });
    if (!consumed.ok) return jsonResponse({ error: consumed.error }, consumed.status);

    const { data: slugOwner } = await supabase
      .from("dao_registry")
      .select("dao_onchain_address")
      .eq("slug", slug)
      .maybeSingle();

    if (slugOwner && slugOwner.dao_onchain_address !== dao_address) {
      return jsonResponse({ error: "That DAO name is already taken" }, 409);
    }

    // deno-lint-ignore no-explicit-any
    const row: Record<string, any> = {
      dao_onchain_address: dao_address,
      chain: selector.chain,
      chain_id: selector.chain_id,
      network: daoNetworkFor(selector, isMainnetCluster()),
      name: name || "",
      slug,
      description: body.description ?? "",
      logo_url: body.logo_url ?? "",
      governance_type: normalizeGovernanceType(body.governance_type),
      privacy_enabled: body.privacy_enabled ?? false,
      voting_token_mint: body.voting_token_mint ?? null,
      creator_wallet,
      social_twitter: body.social_twitter ?? "",
      social_discord: body.social_discord ?? "",
      social_website: body.social_website ?? "",
      updated_at: new Date().toISOString(),
    };

    if (typeof body.dao_id === "number" && Number.isFinite(body.dao_id)) {
      row.dao_id = body.dao_id;
    }

    const { error: upsertError } = await supabase
      .from("dao_registry")
      .upsert(row, {
        onConflict: "dao_onchain_address",
        ignoreDuplicates: false,
      });

    if (upsertError) {
      console.error("Failed to upsert dao_registry:", upsertError);
      if (upsertError.code === "23505") {
        return jsonResponse({ error: "That DAO name is already taken" }, 409);
      }
      return jsonResponse({ error: "Failed to register DAO" }, 500);
    }

    if (row.governance_type === "wallet") {
      // EVM addresses are lowercased on write: dao-access-check / watch-dao
      // compare against the lowercased caller wallet, so a checksummed entry
      // would silently lock out an authorized member.
      const normalizedWallets = Array.from(
        new Set(
          [creator_wallet, ...(Array.isArray(body.authorized_wallets) ? body.authorized_wallets : [])]
            .map((w) => (typeof w === "string" ? w.trim() : ""))
            .map((w) => (/^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : w))
            .filter((w) => w.length >= 32),
        ),
      );

      await supabase
        .from("dao_authorized_wallets")
        .delete()
        .eq("dao_onchain_address", dao_address);

      if (normalizedWallets.length > 0) {
        const rows = normalizedWallets.map((wallet) => ({
          dao_onchain_address: dao_address,
          wallet_address: wallet,
        }));
        const { error: authInsertError } = await supabase
          .from("dao_authorized_wallets")
          .upsert(rows, {
            onConflict: "dao_onchain_address,wallet_address",
            ignoreDuplicates: false,
          });
        if (authInsertError) {
          console.error("Failed to sync dao_authorized_wallets:", authInsertError);
        }
      }
    }

    const { error: watchError } = await supabase
      .from("watched_daos")
      .upsert(
        {
          wallet_address: creator_wallet,
          dao_onchain_address: dao_address,
          label: name || slug || dao_address,
        },
        {
          onConflict: "wallet_address,dao_onchain_address",
          ignoreDuplicates: false,
        },
      );
    if (watchError) {
      console.error("Failed to auto-watch creator DAO:", watchError);
    }

    return jsonResponse({ success: true, dao_address, slug });
  } catch (error) {
    console.error("register-dao error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
