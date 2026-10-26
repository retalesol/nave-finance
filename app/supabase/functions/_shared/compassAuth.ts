// Compass operator session helpers. Web Crypto only, so node tests and the
// edge function share one implementation. The operator password is never stored
// here. Callers pass the server-side expected password and an HMAC secret.

export const COMPASS_USERNAME = "captain";
export const COMPASS_SESSION_MS = 8 * 60 * 60 * 1000;

const text = new TextEncoder();

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

export function timingEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Compare two strings by their SHA-256 digests so the check does not stop at the first differing character. */
export async function digestsMatch(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    sha256(text.encode(provided)),
    sha256(text.encode(expected)),
  ]);
  return timingEqual(left, right);
}

/**
 * Accept only the single operator username, and only when the password digest
 * matches the server secret. Both digests are computed even when the username
 * is wrong.
 */
export async function credentialsMatch(
  username: string,
  password: string,
  expectedPassword: string,
): Promise<boolean> {
  const [userOk, passwordOk] = await Promise.all([
    digestsMatch(username.trim().toLowerCase(), COMPASS_USERNAME),
    expectedPassword.length > 0 ? digestsMatch(password, expectedPassword) : Promise.resolve(false),
  ]);
  return userOk && passwordOk;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    text.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, text.encode(message));
  return new Uint8Array(signature);
}

export async function signSession(
  secret: string,
  sessionId: string,
  nowMs: number,
): Promise<{ token: string; expiresAtMs: number }> {
  const expiresAtMs = nowMs + COMPASS_SESSION_MS;
  const payload = JSON.stringify({ v: 1, u: COMPASS_USERNAME, sid: sessionId, exp: expiresAtMs });
  const body = bytesToBase64Url(text.encode(payload));
  const signature = await hmac(secret, body);
  return { token: `${body}.${bytesToBase64Url(signature)}`, expiresAtMs };
}

export async function openSession(
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ sid: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, signature] = parts;
  const expected = await hmac(secret, body);
  const actual = base64UrlToBytes(signature);
  if (!actual || !timingEqual(expected, actual)) return null;
  const payloadBytes = base64UrlToBytes(body);
  if (!payloadBytes) return null;
  let parsed: { v?: unknown; u?: unknown; sid?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (parsed.v !== 1 || parsed.u !== COMPASS_USERNAME) return null;
  if (typeof parsed.sid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.sid)) {
    return null;
  }
  if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp) || parsed.exp <= nowMs) return null;
  return { sid: parsed.sid };
}
