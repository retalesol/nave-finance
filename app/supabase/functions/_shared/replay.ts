// Single-use replay protection for signed wallet challenges.
//
// Every verified challenge is recorded in `dispatch_nonces` (text primary key
// `signature`) and a second use fails with a unique violation. The key MUST be
// independent of how the caller encoded the signature: the verifiers accept
// hex-case / base64-padding / base58-vs-base64 variants of the same signature,
// so storing the raw `body.signature` string let a replay slip through by
// re-encoding. The key is therefore
//
//   sha256( lowercase(wallet) || chain || message_bytes || canonical_signature_bytes )
//
// with length prefixes between fields so no field can smear into its neighbour.
// The column stays `text` — no migration is required.

import type { VerifiedSignature } from "./walletAuth.ts";

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function concat(parts: Uint8Array[]) {
  // Explicit ArrayBuffer backing so the result satisfies WebCrypto's BufferSource
  // under strict TS libs (Uint8Array<ArrayBufferLike> is rejected there).
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ReplayKeyInput {
  /** Signer wallet (base58 Solana pubkey or 0x EVM address). Lowercased in the key. */
  wallet: string;
  /** Chain label bound into the key, e.g. "solana", "ethereum:1", "base:8453". */
  chain: string;
  verified: VerifiedSignature;
}

/** Canonical replay key (hex sha256). Deterministic across signature encodings. */
export async function replayKey(input: ReplayKeyInput): Promise<string> {
  const enc = new TextEncoder();
  const fields = [
    enc.encode(input.wallet.trim().toLowerCase()),
    enc.encode(input.chain.trim().toLowerCase()),
    input.verified.messageBytes,
    input.verified.signatureBytes,
  ];
  const framed = concat(fields.flatMap((f) => [u32be(f.length), f]));
  const digest = await crypto.subtle.digest("SHA-256", framed);
  return `v1:${hex(new Uint8Array(digest))}`;
}

/** Chain label for the replay key from a (chain, chain_id) selector. */
export function replayChainLabel(chain: string, chainId: number | null | undefined): string {
  return chainId == null ? chain : `${chain}:${chainId}`;
}

export type ConsumeResult =
  | { ok: true; key: string }
  | { ok: false; status: 409 | 500; error: string };

/**
 * Atomically consume a verified challenge. Inserts the canonical replay key into
 * `dispatch_nonces`; a unique violation means the challenge was already used.
 */
export async function consumeChallenge(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  params: ReplayKeyInput & { daoAddress: string },
): Promise<ConsumeResult> {
  const key = await replayKey(params);
  const { error } = await supabase
    .from("dispatch_nonces")
    .insert({ signature: key, dao_onchain_address: params.daoAddress, wallet: params.wallet });
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, status: 409, error: "Challenge already used" };
    }
    console.error("dispatch_nonces insert failed:", error);
    return { ok: false, status: 500, error: "Replay-protection store unavailable" };
  }
  return { ok: true, key };
}
