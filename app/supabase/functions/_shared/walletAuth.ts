// Shared wallet-signature verification for founder / member challenges.
//
// Every browser-facing edge function that authenticates a wallet does so with
// a short pipe-delimited challenge (`<prefix>|...|<unix_ms>[|<nonce>]`) signed
// by the wallet:
//   - Solana: ed25519 over the UTF-8 message; signature transported as base64
//     (wallet-adapter flows) or base58 (legacy creation flow). Both are accepted;
//     the decoding that verifies is the canonical one.
//   - EVM: EIP-191 personal_sign (0x-hex, 65 bytes) verified via viem.
//
// The verifier returns the decoded signature BYTES so callers can derive an
// encoding-independent replay key (see ./replay.ts) — a caller-supplied string
// (hex case, base64 padding, base58 vs base64) must never be the replay key.

import nacl from "npm:tweetnacl@1.0.3";
import { verifyMessage } from "npm:viem@2.21.55";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const value = B58_ALPHABET.indexOf(ch);
    if (value === -1) throw new Error("invalid base58 char");
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

export function base64Decode(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hexDecode(input: string): Uint8Array {
  const hex = input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type WalletChainKind = "solana" | "evm";

export interface VerifiedSignature {
  /** Canonical decoded signature bytes (64 ed25519 / 65 secp256k1). */
  signatureBytes: Uint8Array;
  /** UTF-8 bytes of the exact message that was verified. */
  messageBytes: Uint8Array;
}

/** Candidate decodings of a Solana signature string (base64 first, then base58). */
function solanaSignatureCandidates(signature: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const seen = new Set<string>();
  const push = (b: Uint8Array | null) => {
    if (!b || b.length !== 64) return;
    const key = Array.from(b).join(",");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(b);
  };
  try {
    push(base64Decode(signature));
  } catch { /* not base64 */ }
  try {
    push(base58Decode(signature));
  } catch { /* not base58 */ }
  return out;
}

/**
 * Verify `signature` over `message` for `wallet`. Returns the canonical decoded
 * bytes on success, or null when the signature is invalid / undecodable.
 */
export async function verifyWalletSignature(
  kind: WalletChainKind,
  wallet: string,
  message: string,
  signature: string,
): Promise<VerifiedSignature | null> {
  const messageBytes = new TextEncoder().encode(message);
  try {
    if (kind === "evm") {
      if (!/^0x[0-9a-fA-F]+$/.test(signature)) return null;
      const ok = await verifyMessage({
        address: wallet as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
      return ok ? { signatureBytes: hexDecode(signature), messageBytes } : null;
    }
    const pubkey = base58Decode(wallet);
    if (pubkey.length !== 32) return null;
    for (const sigBytes of solanaSignatureCandidates(signature)) {
      if (nacl.sign.detached.verify(messageBytes, sigBytes, pubkey)) {
        return { signatureBytes: sigBytes, messageBytes };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Default freshness window for signed challenges. */
export const CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000;
/** Tolerated future-dated skew (a future timestamp would extend the replay window). */
export const CHALLENGE_CLOCK_SKEW_MS = 5_000;

/**
 * Validate a unix-ms challenge timestamp: reject NaN, expired, or future-dated
 * beyond the skew. Returns null when fresh, else a short error code.
 */
export function checkChallengeTimestamp(
  raw: string | number | undefined,
  opts: { maxAgeMs?: number; skewMs?: number } = {},
): "invalid_timestamp" | "challenge_expired" | null {
  const ts = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(ts)) return "invalid_timestamp";
  const age = Date.now() - ts;
  if (age > (opts.maxAgeMs ?? CHALLENGE_MAX_AGE_MS)) return "challenge_expired";
  if (age < -(opts.skewMs ?? CHALLENGE_CLOCK_SKEW_MS)) return "challenge_expired";
  return null;
}

const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Client-chosen challenge nonce: 8-64 url-safe chars. */
export function isValidChallengeNonce(nonce: unknown): nonce is string {
  return typeof nonce === "string" && NONCE_RE.test(nonce);
}
