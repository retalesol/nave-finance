// watch-dao — add a DAO to the caller's watchlist (writes `watched_daos`).
//
// AUTHENTICATED: the caller must prove ownership of `wallet_address` by signing
//   `nave-watch|<dao_address>|<wallet_address>|<unix_ms>`
// (Solana: ed25519, base64 or base58; EVM: 0x-hex EIP-191 personal_sign).
// Without this anyone could write to any wallet's watchlist and probe private-
// DAO membership by asserting a member's address. Each signed challenge is
// single-use (dispatch_nonces). Missing signature → 401 `signature_required`
// so the client can sign and retry (same pattern as dao-access-check).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { evmRpcUrlFor } from "../_shared/evmFounder.ts";
import { checkChallengeTimestamp, verifyWalletSignature } from "../_shared/walletAuth.ts";
import { consumeChallenge } from "../_shared/replay.ts";

interface RequestPayload {
  dao_address: string;
  wallet_address: string;
  label?: string;
  /** `nave-watch|<dao_address>|<wallet_address>|<unix_ms>` */
  message?: string;
  /** Solana: base64/base58 ed25519; EVM: 0x-hex EIP-191. */
  signature?: string;
}

type GovernanceType = "wallet" | "token";

/** Watch challenges may be a little older than admin challenges (wallet UX). */
const WATCH_MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;
const WATCH_MESSAGE_MAX_SKEW_MS = 60 * 1000;

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function getEvmRpcUrl(chainId: number | null): string | null {
  return evmRpcUrlFor(chainId);
}

async function hasTokenBalance(
  rpcUrl: string,
  walletAddress: string,
  mint: string,
): Promise<boolean> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [
        walletAddress,
        { mint },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ],
    }),
  });
  const json = await resp.json();
  const rows = json?.result?.value ?? [];
  for (const row of rows) {
    const amount = row?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === "string" && amount !== "0") return true;
  }
  return false;
}

async function hasErc20Balance(
  rpcUrl: string,
  walletAddress: string,
  tokenAddress: string,
): Promise<boolean> {
  const wallet = walletAddress.trim().replace(/^0x/i, "").padStart(64, "0");
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: tokenAddress,
          data: `0x70a08231${wallet}`,
        },
        "latest",
      ],
    }),
  });
  const json = await resp.json();
  const result = typeof json?.result === "string" ? json.result : "0x0";
  try {
    return BigInt(result) > 0n;
  } catch {
    return false;
  }
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

    const limited = rateLimit(req, { key: clientKey(req, "watch-dao"), limit: 20, windowMs: 60_000 }, corsHeaders);
    if (limited) return limited;

    const body: RequestPayload = await req.json();
    const rawDaoAddress = body.dao_address?.trim();
    const rawWalletAddress = body.wallet_address?.trim();
    const daoAddress = rawDaoAddress && isEvmAddress(rawDaoAddress) ? rawDaoAddress.toLowerCase() : rawDaoAddress;
    const walletAddress = rawWalletAddress && isEvmAddress(rawWalletAddress) ? rawWalletAddress.toLowerCase() : rawWalletAddress;
    if (!daoAddress || !walletAddress) {
      return jsonResponse({ error: "Missing dao_address or wallet_address" }, 400);
    }

    // ── Wallet ownership (signed challenge) ─────────────────────────────
    const { message, signature } = body;
    if (!message || !signature) {
      return jsonResponse({ error: "signature_required", reason: "signature_required" }, 401);
    }
    const walletIsEvm = isEvmAddress(walletAddress);
    const parts = message.split("|");
    if (parts.length !== 4 || parts[0] !== "nave-watch") {
      return jsonResponse({ error: "invalid_message_format" }, 400);
    }
    const [, msgDao, msgWallet] = parts;
    const sameDao = isEvmAddress(msgDao) || isEvmAddress(daoAddress)
      ? msgDao.toLowerCase() === daoAddress.toLowerCase()
      : msgDao === daoAddress;
    const sameWallet = walletIsEvm
      ? msgWallet.toLowerCase() === walletAddress
      : msgWallet === walletAddress;
    if (!sameDao || !sameWallet) {
      return jsonResponse({ error: "message_binding_mismatch" }, 403);
    }
    const tsErr = checkChallengeTimestamp(parts[3], {
      maxAgeMs: WATCH_MESSAGE_MAX_AGE_MS,
      skewMs: WATCH_MESSAGE_MAX_SKEW_MS,
    });
    if (tsErr) return jsonResponse({ error: tsErr === "invalid_timestamp" ? "invalid_message_timestamp" : "message_expired" }, 403);
    const verified = await verifyWalletSignature(
      walletIsEvm ? "evm" : "solana",
      walletAddress,
      message,
      signature,
    );
    if (!verified) return jsonResponse({ error: "invalid_signature" }, 403);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Single-use: consume the challenge before any membership lookup so a
    // captured signature cannot be replayed to probe membership later.
    const consumed = await consumeChallenge(supabase, {
      wallet: walletAddress,
      chain: walletIsEvm ? "evm" : "solana",
      verified,
      daoAddress,
    });
    if (!consumed.ok) return jsonResponse({ error: consumed.error }, consumed.status);

    const { data: dao, error: daoError } = await supabase
      .from("dao_registry")
      .select("dao_onchain_address, governance_type, privacy_enabled, creator_wallet, voting_token_mint, chain, chain_id")
      .eq("dao_onchain_address", daoAddress)
      .maybeSingle();
    if (daoError || !dao) {
      return jsonResponse({ error: "DAO not found" }, 404);
    }

    const governanceType: GovernanceType = dao.governance_type === "token" ? "token" : "wallet";
    const privacyEnabled = !!dao.privacy_enabled;
    const isEvmDao = dao.chain === "ethereum" || dao.chain === "base" || dao.chain === "robinhood" || isEvmAddress(dao.dao_onchain_address);
    const normalizedWallet = isEvmDao ? walletAddress.toLowerCase() : walletAddress;

    let allowed = !privacyEnabled || dao.creator_wallet === normalizedWallet;
    let reason = allowed ? (privacyEnabled ? "creator_wallet" : "public_dao") : "access_denied";

    if (!allowed && governanceType === "wallet") {
      const { data: auth } = await supabase
        .from("dao_authorized_wallets")
        .select("id")
        .eq("dao_onchain_address", daoAddress)
        .eq("wallet_address", normalizedWallet)
        .limit(1)
        .maybeSingle();
      if (auth) {
        allowed = true;
        reason = "authorized_wallet";
      } else {
        reason = "wallet_not_authorized";
      }
    }

    if (!allowed && governanceType === "token") {
      const mint = (dao.voting_token_mint ?? "").trim();
      if (!mint) {
        reason = "missing_voting_token_mint";
      } else {
        let holder = false;
        if (isEvmDao) {
          if (!isEvmAddress(walletAddress) || !isEvmAddress(mint)) {
            holder = false;
          } else {
            const rpcUrl = getEvmRpcUrl(typeof dao.chain_id === "number" ? dao.chain_id : null);
            if (!rpcUrl) return jsonResponse({ error: "EVM RPC URL is not configured for this DAO chain" }, 500);
            holder = await hasErc20Balance(rpcUrl, normalizedWallet, mint.toLowerCase());
          }
        } else {
          const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
          if (!rpcUrl) return jsonResponse({ error: "SOLANA_RPC_URL is not configured" }, 500);
          holder = await hasTokenBalance(rpcUrl, walletAddress, mint);
        }
        if (holder) {
          allowed = true;
          reason = "token_holder";
        } else {
          reason = "wallet_not_token_holder";
        }
      }
    }

    if (!allowed) {
      return jsonResponse(
        {
          success: false,
          allowed: false,
          dao_address: daoAddress,
          governance_type: governanceType,
          privacy_enabled: privacyEnabled,
          reason,
        },
        403,
      );
    }

    const { error: upsertError } = await supabase
      .from("watched_daos")
      .upsert(
        {
          wallet_address: normalizedWallet,
          dao_onchain_address: daoAddress,
          label: body.label ?? "",
        },
        { onConflict: "wallet_address,dao_onchain_address" },
      );

    if (upsertError) {
      return jsonResponse({ error: upsertError.message }, 500);
    }

    return jsonResponse({
      success: true,
      allowed: true,
      dao_address: daoAddress,
      governance_type: governanceType,
      privacy_enabled: privacyEnabled,
      reason,
    });
  } catch (error) {
    console.error("watch-dao error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
