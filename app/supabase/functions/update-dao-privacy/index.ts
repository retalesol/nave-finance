import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import nacl from "npm:tweetnacl@1.0.3";
import bs58 from "npm:bs58@5.0.0";
import { verifyMessage } from "npm:viem@2.21.55";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { readDaoFounder } from "../_shared/onchain.ts";
import { isEvmChain, normalizeChain, normalizeEvmAddress } from "../_shared/chain.ts";
import { hasEvmRpc, readEvmTreasuryFounder } from "../_shared/evmFounder.ts";

interface RequestPayload {
  dao_address: string;
  wallet: string;
  message: string;
  signature: string; // base64 (Solana ed25519) or 0x-hex (EVM EIP-191)
  privacy_enabled: boolean;
  chain?: string;
  chain_id?: number;
}

function decodeBase64(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

    const body: RequestPayload = await req.json();
    let daoAddress = body.dao_address?.trim();
    let wallet = body.wallet?.trim();
    const message = body.message ?? "";
    const signatureStr = body.signature ?? "";

    if (!daoAddress || !wallet || !message || !signatureStr) {
      return jsonResponse({ error: "Missing required fields" }, 400);
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
        daoAddress = normalizeEvmAddress(daoAddress);
        wallet = normalizeEvmAddress(wallet);
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "Invalid EVM address" }, 400);
      }
    }

    // SEC-M6: the signed message must bind the DAO, the requested flag value,
    // and a fresh timestamp — otherwise a captured signature could be replayed
    // later or paired with a tampered `privacy_enabled` body field.
    const PRIVACY_MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;
    const PRIVACY_MESSAGE_MAX_SKEW_MS = 60 * 1000;
    const parts = message.split("|");
    if (parts.length !== 4 || parts[0] !== "nave-privacy") {
      return jsonResponse({ error: "Invalid message format" }, 400);
    }
    const [, msgDao, msgFlag, msgTs] = parts;
    const sameDao = evm ? msgDao.toLowerCase() === daoAddress.toLowerCase() : msgDao === daoAddress;
    if (!sameDao) {
      return jsonResponse({ error: "Message is bound to a different DAO" }, 400);
    }
    if (msgFlag !== (body.privacy_enabled ? "1" : "0")) {
      return jsonResponse({ error: "Signed privacy flag does not match the request" }, 400);
    }
    const ts = Number(msgTs);
    const now = Date.now();
    if (!Number.isFinite(ts) || ts > now + PRIVACY_MESSAGE_MAX_SKEW_MS || now - ts > PRIVACY_MESSAGE_MAX_AGE_MS) {
      return jsonResponse({ error: "Signed message has expired — sign a fresh request" }, 400);
    }

    // Verify the founder's signature: Solana = base64 ed25519 against the base58
    // wallet; EVM = 0x-hex EIP-191 personal_sign against the address.
    let ok = false;
    try {
      if (evm) {
        ok = await verifyMessage({
          address: wallet as `0x${string}`,
          message,
          signature: signatureStr as `0x${string}`,
        });
      } else {
        ok = nacl.sign.detached.verify(
          new TextEncoder().encode(message),
          decodeBase64(signatureStr),
          bs58.decode(wallet),
        );
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      return jsonResponse({ error: "Invalid signature" }, 403);
    }

    // Confirm the signer is the on-chain DAO founder (fail closed on no RPC).
    if (evm) {
      const chainId = chainSel.chain_id as number;
      const onchainFounder = await readEvmTreasuryFounder(chainId, daoAddress);
      if (onchainFounder === null) {
        if (!hasEvmRpc(chainId)) {
          return jsonResponse({ error: "EVM RPC is not configured" }, 500);
        }
        return jsonResponse({ error: "Could not verify DAO founder on-chain (EVM)" }, 400);
      }
      if (onchainFounder !== wallet.toLowerCase()) {
        return jsonResponse({ error: "Only the DAO founder can update privacy mode" }, 403);
      }
    } else {
      const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
      if (!rpcUrl) {
        return jsonResponse({ error: "SOLANA_RPC_URL is not configured" }, 500);
      }
      const founder = await readDaoFounder(rpcUrl, daoAddress);
      if (!founder || founder !== wallet) {
        return jsonResponse({ error: "Only the DAO founder can update privacy mode" }, 403);
      }
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error } = await supabase
      .from("dao_registry")
      .update({
        privacy_enabled: !!body.privacy_enabled,
        updated_at: new Date().toISOString(),
      })
      .eq("dao_onchain_address", daoAddress);

    if (error) {
      console.error("update-dao-privacy update failed:", error);
      return jsonResponse({ error: "Failed to update DAO privacy mode" }, 500);
    }

    return jsonResponse({
      success: true,
      dao_address: daoAddress,
      privacy_enabled: !!body.privacy_enabled,
    });
  } catch (error) {
    console.error("update-dao-privacy error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
