// Envelope-encryption helpers (Deno/WebCrypto) for agent key custody.
//
// Each agent private key is encrypted under a per-DAO/per-role data key (DEK).
// Rather than handing the raw DEK back to operators once (the old, unscalable
// model that forced four global env AES keys), we WRAP each DEK under a single
// master key-encryption-key (KEK) and persist the wrapped DEK in the database.
// Servers (dispatcher, signer) unwrap it on demand using the KEK from env/KMS.
//
// NAVE_MASTER_KEK must be a base64-encoded 32-byte (256-bit) key. Generate via:
//   openssl rand -base64 32

// ArrayBuffer-backed so the result satisfies WebCrypto's BufferSource under
// strict TS libs (Uint8Array<ArrayBufferLike> is rejected there).
function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

let _kek: CryptoKey | null = null;

async function getMasterKek(): Promise<CryptoKey> {
  if (_kek) return _kek;
  const raw = Deno.env.get("NAVE_MASTER_KEK");
  if (!raw) {
    throw new Error("NAVE_MASTER_KEK is not configured");
  }
  const keyBytes = base64ToBytes(raw);
  if (keyBytes.length !== 32) {
    throw new Error("NAVE_MASTER_KEK must decode to 32 bytes (256-bit)");
  }
  _kek = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return _kek;
}

export interface WrappedDek {
  wrapped_dek: string; // base64 ciphertext (without tag)
  dek_wrap_iv: string; // base64 12-byte IV
  dek_wrap_tag: string; // base64 16-byte GCM tag
}

/** Returns true when a master KEK is configured (lets callers no-op gracefully). */
export function isKekConfigured(): boolean {
  return Boolean(Deno.env.get("NAVE_MASTER_KEK"));
}

/** Wrap a raw DEK (base64) under the master KEK. */
export async function wrapDek(dekBase64: string): Promise<WrappedDek> {
  const kek = await getMasterKek();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    kek,
    base64ToBytes(dekBase64),
  );
  const arr = new Uint8Array(encrypted);
  const ciphertext = arr.slice(0, arr.length - 16);
  const tag = arr.slice(arr.length - 16);
  return {
    wrapped_dek: bytesToBase64(ciphertext),
    dek_wrap_iv: bytesToBase64(iv),
    dek_wrap_tag: bytesToBase64(tag),
  };
}

/** Unwrap a stored DEK back to its raw base64 form. */
export async function unwrapDek(w: WrappedDek): Promise<string> {
  const kek = await getMasterKek();
  const ciphertext = base64ToBytes(w.wrapped_dek);
  const tag = base64ToBytes(w.dek_wrap_tag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(w.dek_wrap_iv), tagLength: 128 },
    kek,
    combined,
  );
  return bytesToBase64(new Uint8Array(decrypted));
}

// ── v2 envelope: per-role KEK + associated data ─────────────────────────────
// Mirrors signer-service/src/kek.ts. The wrapped DEK carries AES-GCM associated
// data `nave-dek:v2|<dao>|<role>|<chain>` so it only unwraps for the row it was
// written for. The per-role KEK (NAVE_KEK_<ROLE> for Solana, NAVE_EVM_KEK_<ROLE>
// for EVM) is used when configured; otherwise the family master KEK.

export type KekFamily = "solana" | "evm";

export interface DekBinding {
  dao: string;
  /** Agent role, or `guardian#<index>` for custodied EVM guardians. */
  role: string;
  /** `solana` or `evm:<chainId>`. */
  chain: string;
}

export interface BoundWrappedDek extends WrappedDek {
  dek_wrap_version: 2;
  dek_kek_ref: "role" | "master";
}

function dekAad(binding: DekBinding): ArrayBuffer {
  const bytes = new TextEncoder().encode(`nave-dek:v2|${binding.dao}|${binding.role}|${binding.chain}`);
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

function roleKekEnvName(family: KekFamily, role: string): string {
  const base = role.split("#")[0].toUpperCase();
  return family === "evm" ? `NAVE_EVM_KEK_${base}` : `NAVE_KEK_${base}`;
}

function masterKekEnv(family: KekFamily): string | undefined {
  return family === "evm"
    ? Deno.env.get("NAVE_EVM_MASTER_KEK") || Deno.env.get("NAVE_MASTER_KEK")
    : Deno.env.get("NAVE_MASTER_KEK");
}

async function importKek(raw: string, label: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(raw);
  if (keyBytes.length !== 32) throw new Error(`${label} must decode to 32 bytes (256-bit)`);
  return await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function kekFor(family: KekFamily, role: string, ref: "role" | "master"): Promise<CryptoKey> {
  if (ref === "role") {
    const name = roleKekEnvName(family, role);
    const raw = Deno.env.get(name);
    if (!raw) throw new Error(`${name} is not configured`);
    return await importKek(raw, name);
  }
  const raw = masterKekEnv(family);
  if (!raw) throw new Error(`No ${family} master KEK configured`);
  return await importKek(raw, `${family} master KEK`);
}

/** Wrap a raw DEK (base64) for one row: per-role KEK when set, bound to `binding`. */
export async function wrapDekBound(
  family: KekFamily,
  dekBase64: string,
  binding: DekBinding,
): Promise<BoundWrappedDek> {
  const ref: "role" | "master" = Deno.env.get(roleKekEnvName(family, binding.role)) ? "role" : "master";
  const kek = await kekFor(family, binding.role, ref);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128, additionalData: dekAad(binding) },
      kek,
      base64ToBytes(dekBase64),
    ),
  );
  return {
    wrapped_dek: bytesToBase64(encrypted.slice(0, encrypted.length - 16)),
    dek_wrap_iv: bytesToBase64(iv),
    dek_wrap_tag: bytesToBase64(encrypted.slice(encrypted.length - 16)),
    dek_wrap_version: 2,
    dek_kek_ref: ref,
  };
}

/** Unwrap a v2 row's DEK; fails unless `binding` matches the row it was written for. */
export async function unwrapDekBound(
  family: KekFamily,
  row: WrappedDek & { dek_kek_ref?: string | null },
  binding: DekBinding,
): Promise<string> {
  const kek = await kekFor(family, binding.role, row.dek_kek_ref === "role" ? "role" : "master");
  const ciphertext = base64ToBytes(row.wrapped_dek);
  const tag = base64ToBytes(row.dek_wrap_tag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(row.dek_wrap_iv), tagLength: 128, additionalData: dekAad(binding) },
    kek,
    combined,
  );
  return bytesToBase64(new Uint8Array(decrypted));
}
