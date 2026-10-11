import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import nacl from "npm:tweetnacl@1.0.3";
import bs58 from "npm:bs58@5.0.0";
import { verifyMessage } from "npm:viem@2.21.55";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { evmRpcUrlFor } from "../_shared/evmFounder.ts";

interface RequestPayload {
  dao_address: string;
  wallet_address: string;
  // SEC-M6: private-DAO access must prove wallet ownership, not just claim an
  // address. `message` = `nave-access|<dao>|<wallet>|<timestamp_ms>`;
  // `signature` = base64 ed25519 (Solana) or 0x-hex EIP-191 (EVM).
  message?: string;
  signature?: string;
}

/** Max age of a signed access message (ms). */
const ACCESS_MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;
/** Allowed clock skew for messages timestamped slightly in the future (ms). */
const ACCESS_MESSAGE_MAX_SKEW_MS = 60 * 1000;

function decodeBase64(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Verify the caller owns `wallet` via a fresh signed access message bound to
 * this DAO + wallet. Returns null on success, or an error string.
 */
async function verifyWalletOwnership(
  daoAddress: string,
  wallet: string,
  evmWallet: boolean,
  message: string | undefined,
  signature: string | undefined,
): Promise<string | null> {
  if (!message || !signature) return "signature_required";

  const parts = message.split("|");
  if (parts.length !== 4 || parts[0] !== "nave-access") return "invalid_message_format";
  const [, msgDao, msgWallet, msgTs] = parts;
  const sameWallet = evmWallet
    ? msgWallet.toLowerCase() === wallet.toLowerCase()
    : msgWallet === wallet;
  const sameDao = evmWallet || /^0x/i.test(msgDao)
    ? msgDao.toLowerCase() === daoAddress.toLowerCase()
    : msgDao === daoAddress;
  if (!sameDao || !sameWallet) return "message_binding_mismatch";

  const ts = Number(msgTs);
  if (!Number.isFinite(ts)) return "invalid_message_timestamp";
  const now = Date.now();
  if (ts > now + ACCESS_MESSAGE_MAX_SKEW_MS || now - ts > ACCESS_MESSAGE_MAX_AGE_MS) {
    return "message_expired";
  }

  try {
    if (evmWallet) {
      const ok = await verifyMessage({
        address: wallet as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
      return ok ? null : "invalid_signature";
    }
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      decodeBase64(signature),
      bs58.decode(wallet),
    );
    return ok ? null : "invalid_signature";
  } catch {
    return "invalid_signature";
  }
}

type GovernanceType = "wallet" | "token";

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/** Per-chain RPC from the shared config (mainnets require the env; no public fallback). */
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

    const limited = rateLimit(req, { key: clientKey(req, "dao-access"), limit: 30, windowMs: 60_000 }, corsHeaders);
    if (limited) return limited;

    const body: RequestPayload = await req.json();
    const rawDaoAddress = body.dao_address?.trim();
    const rawWalletAddress = body.wallet_address?.trim();
    const daoAddress = rawDaoAddress && isEvmAddress(rawDaoAddress) ? rawDaoAddress.toLowerCase() : rawDaoAddress;
    const walletAddress = rawWalletAddress && isEvmAddress(rawWalletAddress) ? rawWalletAddress.toLowerCase() : rawWalletAddress;

    if (!daoAddress || !walletAddress) {
      return jsonResponse({ error: "Missing dao_address or wallet_address" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

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
    const isEvmDao = dao.chain === "ethereum" || dao.chain === "base" || dao.chain === "robinhood" || dao.chain === "arc" || isEvmAddress(dao.dao_onchain_address);
    const normalizedWallet = isEvmDao ? walletAddress.toLowerCase() : walletAddress;

    if (!privacyEnabled) {
      return jsonResponse({
        allowed: true,
        dao_address: daoAddress,
        governance_type: governanceType,
        privacy_enabled: false,
        reason: "public_dao",
      });
    }

    // SEC-M6: for private DAOs, the wallet claim must be backed by a signature.
    // Without this, anyone could probe/enter a private DAO by asserting a
    // member's address. Public DAOs above stay signature-free.
    const ownershipError = await verifyWalletOwnership(
      daoAddress,
      normalizedWallet,
      isEvmDao || isEvmAddress(walletAddress),
      body.message,
      body.signature,
    );
    if (ownershipError) {
      return jsonResponse({
        allowed: false,
        dao_address: daoAddress,
        governance_type: governanceType,
        privacy_enabled: true,
        error: ownershipError,
        reason: ownershipError,
      }, ownershipError === "signature_required" ? 401 : 403);
    }

    if ((dao.creator_wallet ?? "") === normalizedWallet) {
      return jsonResponse({
        allowed: true,
        dao_address: daoAddress,
        governance_type: governanceType,
        privacy_enabled: true,
        reason: "creator_wallet",
      });
    }

    if (governanceType === "wallet") {
      const { data: match } = await supabase
        .from("dao_authorized_wallets")
        .select("id")
        .eq("dao_onchain_address", daoAddress)
        .eq("wallet_address", normalizedWallet)
        .limit(1)
        .maybeSingle();

      if (match) {
        return jsonResponse({
          allowed: true,
          dao_address: daoAddress,
          governance_type: governanceType,
          privacy_enabled: true,
          reason: "authorized_wallet",
        });
      }

      return jsonResponse({
        allowed: false,
        dao_address: daoAddress,
        governance_type: governanceType,
        privacy_enabled: true,
        reason: "wallet_not_authorized",
      }, 403);
    }

    const mint = (dao.voting_token_mint ?? "").trim();
    if (!mint) {
      return jsonResponse({
        allowed: false,
        dao_address: daoAddress,
        governance_type: governanceType,
        privacy_enabled: true,
        reason: "missing_voting_token_mint",
      }, 403);
    }

    let holder = false;
    if (isEvmDao) {
      if (!isEvmAddress(walletAddress) || !isEvmAddress(mint)) {
        return jsonResponse({
          allowed: false,
          dao_address: daoAddress,
          governance_type: governanceType,
          privacy_enabled: true,
          reason: "wallet_not_token_holder",
        }, 403);
      }
      const rpcUrl = getEvmRpcUrl(typeof dao.chain_id === "number" ? dao.chain_id : null);
      if (!rpcUrl) {
        return jsonResponse({ error: "EVM RPC URL is not configured for this DAO chain" }, 500);
      }
      holder = await hasErc20Balance(rpcUrl, normalizedWallet, mint.toLowerCase());
    } else {
      const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
      if (!rpcUrl) {
        return jsonResponse({ error: "SOLANA_RPC_URL is not configured" }, 500);
      }
      holder = await hasTokenBalance(rpcUrl, walletAddress, mint);
    }

    if (!holder) {
      return jsonResponse({
        allowed: false,
        dao_address: daoAddress,
        governance_type: governanceType,
        privacy_enabled: true,
        reason: "wallet_not_token_holder",
      }, 403);
    }

    return jsonResponse({
      allowed: true,
      dao_address: daoAddress,
      governance_type: governanceType,
      privacy_enabled: true,
      reason: "token_holder",
    });
  } catch (error) {
    console.error("dao-access-check error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
