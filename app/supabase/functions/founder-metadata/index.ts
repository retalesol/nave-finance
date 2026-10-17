import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { readDaoFounder } from "../_shared/onchain.ts";
import { isEvmChain, normalizeChain, normalizeEvmAddress } from "../_shared/chain.ts";
import { hasEvmRpc, readEvmTreasuryFounder } from "../_shared/evmFounder.ts";
import { checkChallengeTimestamp, verifyWalletSignature } from "../_shared/walletAuth.ts";
import { consumeChallenge, replayChainLabel } from "../_shared/replay.ts";

const BUCKET = "dao-logos";
const MAX_IMAGE_BYTES = 1_500_000;
const ACTIONS = ["upload_logo", "set_token_image", "hide_asset", "unhide_asset"] as const;
type Action = (typeof ACTIONS)[number];

interface RequestPayload {
  action?: string;
  dao_address?: string;
  wallet?: string;
  message?: string;
  signature?: string;
  chain?: string;
  chain_id?: number;
  image_base64?: string;
  content_type?: string;
  mint?: string;
  asset_chain?: string;
  asset_identifier?: string;
}

function bytesFromBase64(input: string): Uint8Array | null {
  try {
    const bin = atob(input);
    if (bin.length > MAX_IMAGE_BYTES) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extFor(contentType: string): string | null {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/jpeg") return "jpg";
  return null;
}

function logoFolder(dao: string): string {
  return dao.replace(/[^a-zA-Z0-9]+/g, "");
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = (await req.json()) as RequestPayload;
    const action = body.action as Action;
    if (!ACTIONS.includes(action)) return jsonResponse({ error: "Unknown action" }, 400);

    let chainSel;
    try {
      chainSel = normalizeChain(body.chain, body.chain_id);
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : "Invalid chain" }, 400);
    }
    const evm = isEvmChain(chainSel.chain);
    const daoAddress = (body.dao_address ?? "").trim();
    const wallet = (body.wallet ?? "").trim();
    const message = body.message ?? "";
    const signature = body.signature ?? "";
    if (!daoAddress || !wallet || !message || !signature) {
      return jsonResponse({ error: "Missing dao, wallet, message, or signature" }, 400);
    }
    if (evm && daoAddress !== daoAddress.toLowerCase()) {
      return jsonResponse({ error: "EVM treasury address must be lowercase in the challenge" }, 400);
    }
    if (evm) {
      try {
        if (normalizeEvmAddress(wallet) !== wallet.toLowerCase()) {
          return jsonResponse({ error: "Invalid founder wallet" }, 400);
        }
      } catch {
        return jsonResponse({ error: "Invalid founder wallet" }, 400);
      }
    }

    const parts = message.split("|");
    if (parts.length !== 6 || parts[0] !== "nave-founder-meta" || parts[1] !== action || parts[2] !== daoAddress) {
      return jsonResponse({ error: "Challenge does not match this request" }, 400);
    }
    const subject = parts[3];
    const issuedAt = Number(parts[4]);
    const nonce = parts[5] ?? "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
      return jsonResponse({ error: "Invalid challenge nonce" }, 400);
    }
    const stale = checkChallengeTimestamp(issuedAt);
    if (stale) return jsonResponse({ error: "Challenge expired" }, 400);

    const kind = evm ? "evm" as const : "solana" as const;
    const verified = await verifyWalletSignature(kind, wallet, message, signature);
    if (!verified) return jsonResponse({ error: "Invalid signature" }, 403);

    if (evm) {
      const chainId = chainSel.chain_id as number;
      const onchainFounder = await readEvmTreasuryFounder(chainId, daoAddress);
      if (onchainFounder === null) {
        if (!hasEvmRpc(chainId)) return jsonResponse({ error: "EVM RPC is not configured" }, 500);
        return jsonResponse({ error: "Could not verify DAO founder on-chain" }, 400);
      }
      if (onchainFounder !== wallet.toLowerCase()) {
        return jsonResponse({ error: "Only the DAO founder can change this" }, 403);
      }
    } else {
      const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
      if (!rpcUrl) return jsonResponse({ error: "SOLANA_RPC_URL is not configured" }, 500);
      const founder = await readDaoFounder(rpcUrl, daoAddress);
      if (!founder || founder !== wallet) {
        return jsonResponse({ error: "Only the DAO founder can change this" }, 403);
      }
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Server misconfigured" }, 500);
    const supabase = createClient(supabaseUrl, serviceKey);

    const consumed = await consumeChallenge(supabase, {
      wallet,
      chain: replayChainLabel(chainSel.chain, chainSel.chain_id),
      verified,
      daoAddress,
    });
    if (!consumed.ok) return jsonResponse({ error: consumed.error }, consumed.status);

    if (action === "upload_logo" || action === "set_token_image") {
      const contentType = body.content_type ?? "";
      const ext = extFor(contentType);
      if (!ext) return jsonResponse({ error: "Image must be jpeg, png, or webp" }, 400);
      const bytes = bytesFromBase64(body.image_base64 ?? "");
      if (!bytes || bytes.length === 0) return jsonResponse({ error: "Image is missing or too large" }, 400);
      const hash = await sha256Hex(bytes);
      const mint = (body.mint ?? "").trim();
      const expected = action === "set_token_image" ? `${mint}:${hash}` : hash;
      if (subject !== expected || subject.includes("|")) {
        return jsonResponse({ error: "Signed image does not match the upload" }, 400);
      }
      if (action === "set_token_image" && (mint.length < 8 || mint.length > 80 || mint.includes("|") || mint.includes(":"))) {
        return jsonResponse({ error: "Invalid token mint" }, 400);
      }
      const folder = logoFolder(daoAddress);
      const path = `${folder}/${action === "set_token_image" ? "token" : "logo"}-${Date.now()}-${hash.slice(0, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType,
        upsert: false,
        cacheControl: "31536000",
      });
      if (upErr) return jsonResponse({ error: `Logo upload failed: ${upErr.message}` }, 500);
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const publicUrl = pub.publicUrl;
      if (action === "set_token_image") {
        const { error: rowErr } = await supabase.from("dao_token_images").upsert(
          { dao_address: daoAddress, mint, image_uri: publicUrl },
          { onConflict: "dao_address,mint" },
        );
        if (rowErr) return jsonResponse({ error: rowErr.message }, 500);
      }
      return jsonResponse({ success: true, public_url: publicUrl });
    }

    const assetChain = (body.asset_chain ?? "").trim();
    const assetId = (body.asset_identifier ?? "").trim();
    if (!assetChain || !assetId || assetChain.length > 32 || assetId.length > 128) {
      return jsonResponse({ error: "Invalid asset" }, 400);
    }
    if (assetChain.includes("|") || assetId.includes("|") || subject !== `${assetChain}:${assetId}`) {
      return jsonResponse({ error: "Signed asset does not match the request" }, 400);
    }
    if (action === "hide_asset") {
      const { error } = await supabase.from("dao_hidden_assets").insert({
        dao_onchain_address: daoAddress,
        chain: assetChain,
        asset_identifier: assetId,
        hidden_by_wallet: wallet,
      });
      if (error && (error as { code?: string }).code !== "23505") {
        return jsonResponse({ error: error.message }, 500);
      }
      return jsonResponse({ success: true });
    }
    const { error: delErr } = await supabase.from("dao_hidden_assets").delete()
      .eq("dao_onchain_address", daoAddress)
      .eq("chain", assetChain)
      .eq("asset_identifier", assetId);
    if (delErr) return jsonResponse({ error: delErr.message }, 500);
    return jsonResponse({ success: true });
  } catch (err) {
    console.error("founder-metadata error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
