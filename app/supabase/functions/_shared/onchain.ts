// On-chain reads for the deterministic guardrails (Phase 3, H1).
//
// Dependency-light: uses @solana/web3.js only for PDA derivation (the same
// pattern as snapshot-treasury) and raw JSON-RPC getAccountInfo for account
// data, then decodes the fixed-layout nave_core accounts by byte offset. This
// lets the dispatcher hard-enforce protocol allowlist + allocation cap +
// payload-hash equality over authoritative on-chain state.

import { PublicKey } from "npm:@solana/web3.js@1.95.0";

/** Encode raw bytes as a base58 string (Bitcoin/Solana alphabet). */
function bytesToBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

const NAVE_CORE_PROGRAM_ID =
  Deno.env.get("NAVE_CORE_PROGRAM_ID") ||
  "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB";

const corePid = new PublicKey(NAVE_CORE_PROGRAM_ID);
const governancePid = new PublicKey(
  Deno.env.get("NAVE_GOVERNANCE_PROGRAM_ID") || "CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M",
);
const executionPid = new PublicKey(
  Deno.env.get("NAVE_EXECUTION_PROGRAM_ID") || "2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb",
);

/** ExecutionRequest PDA for proposal `index`: ["execution_request", proposal]. */
export function executionRequestForProposal(dao: string, index: number): string {
  const indexLe = new Uint8Array(8);
  new DataView(indexLe.buffer).setBigUint64(0, BigInt(index), true);
  const proposal = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("proposal"), new PublicKey(dao).toBuffer(), indexLe],
    governancePid,
  )[0];
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("execution_request"), proposal.toBuffer()],
    executionPid,
  )[0].toBase58();
}

/** True when the account exists; null when it could not be read. */
export async function accountExists(rpcUrl: string, address: string): Promise<boolean | null> {
  try {
    return (await getAccountData(rpcUrl, address)) != null;
  } catch {
    return null;
  }
}

// ── Fixed layout constants (mirror nave_core state) ──────────────────────────
// TreasuryConstitution layout (byte offsets from account start):
//   8 disc + 1 bump + 32 dao + 1 protocol_count        -> entries @ 42
//   [ProtocolEntry; 10] (52 bytes each = 520)           -> ends   @ 562
//   1 confidence_threshold (u8)                         @ 562
//   8 review_window_secs (i64)                          @ 563
//   2 min_stablecoin_reserve_bps (u16)                  @ 571
//   2 max_total_deployed_bps (u16)                      @ 573
//   2 min_liquidity_bps (u16)                           @ 575
//   8 rebalance_frequency_secs (i64)                    @ 577
//   8 last_rebalance_at (i64)                           @ 585  (LEN = 593)
// ProtocolEntry (52 bytes): protocol_id[16] + protocol_id_len(1) + program_id(32)
//   + max_allocation_bps(u16) + approved(1).
const MAX_CONSTITUTION_PROTOCOLS = 10;
const CONST_PROTOCOL_COUNT_OFF = 41;
const CONST_ENTRIES_OFF = 42;
const ENTRY_SIZE = 52;
const ENTRY_ID_OFF = 0;
const ENTRY_ID_LEN_OFF = 16;
const ENTRY_PROGRAM_ID_OFF = 17;
const ENTRY_MAX_BPS_OFF = 49;
// max_allocation_bps packs the venue risk tier into its two high bits.
import { unpackSolanaAllocation as unpackAllocation } from "./strategyCatalog.ts";
export { unpackAllocation };
const ENTRY_APPROVED_OFF = 51;

// Scalar fields after the protocol array (computed from explicit offsets rather
// than "last byte", which silently broke when later fields were appended).
const CONST_CONFIDENCE_OFF = CONST_ENTRIES_OFF + MAX_CONSTITUTION_PROTOCOLS * ENTRY_SIZE; // 562
const CONST_REVIEW_WINDOW_OFF = CONST_CONFIDENCE_OFF + 1; // 563
const CONST_MIN_RESERVE_BPS_OFF = CONST_REVIEW_WINDOW_OFF + 8; // 571
const CONST_MAX_DEPLOYED_BPS_OFF = CONST_MIN_RESERVE_BPS_OFF + 2; // 573
const CONST_MIN_LIQUIDITY_BPS_OFF = CONST_MAX_DEPLOYED_BPS_OFF + 2; // 575
const CONST_REBALANCE_FREQ_OFF = CONST_MIN_LIQUIDITY_BPS_OFF + 2; // 577
const CONST_LAST_REBALANCE_OFF = CONST_REBALANCE_FREQ_OFF + 8; // 585

// TreasuryVault: current_nav (u64) at 89, deployed_capital (u64) at 121.
const VAULT_CURRENT_NAV_OFF = 89;
const VAULT_DEPLOYED_CAPITAL_OFF = 121;
// TreasuryVault.last_revalued_at (i64) — added on-chain by the parallel NAV
// staleness change. The byte offset is NOT yet known here, so we feature-detect
// via the NAVE_VAULT_LAST_REVALUED_OFF env (set once the field's offset is
// confirmed at cutover). When unset, the field is reported absent and the NAV
// freshness guardrail treats it as not-applicable (fully backward compatible).
const VAULT_LAST_REVALUED_OFF = (() => {
  const raw = Deno.env.get("NAVE_VAULT_LAST_REVALUED_OFF");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
})();

// DaoRegistry: founder (Pubkey) at 17 (8 disc + 1 bump + 8 dao_id).
//   8 disc + 1 bump + 8 dao_id + 32 founder + 32 name + 1 name_len
//   + 1 privacy_mode -> frozen(bool) @ 83, agents_enabled(bool) @ 84.
const DAO_FOUNDER_OFF = 17;
const DAO_FROZEN_OFF = 83;
const DAO_AGENTS_ENABLED_OFF = 84;

// AgentSet (seed ["agent_set", dao_registry]): agents_enabled(bool) @ 185.
//   8 disc + 1 bump + 32 dao + [AgentSlot; 4] (36 bytes each = 144) -> 185.
//   AgentSlot = role(u8) + authority(32) + active(bool) + nullified(bool)
//   + status(u8) = 36 bytes.
const AGENTSET_AGENTS_ENABLED_OFF = 185;

export interface ApprovedProtocol {
  protocolId: string;
  programId: string;
  maxAllocationBps: number;
  riskTier: number;
  approved: boolean;
}

export interface ConstitutionView {
  approvedProtocols: ApprovedProtocol[];
  confidenceThreshold: number;
  // Continuous treasury policy (0 = unset on legacy accounts).
  minStablecoinReserveBps: number;
  maxTotalDeployedBps: number;
  minLiquidityBps: number;
  rebalanceFrequencySecs: number;
  lastRebalanceAt: number;
}

export interface VaultView {
  navBaseUnits: number;
  deployedBaseUnits: number;
  /**
   * Unix seconds the NAV was last revalued (treasury_vault.last_revalued_at).
   * `undefined` when the on-chain field is not exposed yet (feature-detected via
   * NAVE_VAULT_LAST_REVALUED_OFF). Consumers must treat undefined as "unknown"
   * and not as "stale".
   */
  navLastRevaluedAt?: number | null;
}

export function constitutionPda(dao: string): string {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("constitution"), new PublicKey(dao).toBuffer()],
    corePid,
  )[0].toBase58();
}

export function treasuryVaultPda(dao: string): string {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("treasury_vault"), new PublicKey(dao).toBuffer()],
    corePid,
  )[0].toBase58();
}

/**
 * Canonical DaoRegistry PDA: PDA(["dao", founder, dao_id_le_u64], core). Lets
 * callers prove a not-yet-created DAO address belongs to a given founder before
 * the account exists on-chain (used to gate pre-creation agent key generation).
 */
export function daoRegistryPda(founder: string, daoId: number | bigint): string {
  const idBuf = new Uint8Array(8);
  new DataView(idBuf.buffer).setBigUint64(0, BigInt(daoId), true);
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("dao"), new PublicKey(founder).toBuffer(), idBuf],
    corePid,
  )[0].toBase58();
}

async function getAccountData(rpcUrl: string, address: string): Promise<Uint8Array | null> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const json = await resp.json();
  const b64 = json?.result?.value?.data?.[0];
  if (!b64) return null;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToString(bytes: Uint8Array, len: number): string {
  return new TextDecoder().decode(bytes.slice(0, len)).replace(/\0+$/, "");
}

/** Read and decode the DAO's on-chain constitution. Returns null on any failure. */
export async function readConstitution(
  rpcUrl: string,
  dao: string,
): Promise<ConstitutionView | null> {
  try {
    const raw = await getAccountData(rpcUrl, constitutionPda(dao));
    if (!raw || raw.length < CONST_ENTRIES_OFF + 1) return null;

    const count = raw[CONST_PROTOCOL_COUNT_OFF];
    const protocols: ApprovedProtocol[] = [];
    for (let i = 0; i < count; i++) {
      const base = CONST_ENTRIES_OFF + i * ENTRY_SIZE;
      if (base + ENTRY_SIZE > raw.length) break;
      const idLen = raw[base + ENTRY_ID_LEN_OFF];
      const protocolId = bytesToString(
        raw.slice(base + ENTRY_ID_OFF, base + ENTRY_ID_OFF + 16),
        Math.min(idLen, 16),
      );
      const programId = new PublicKey(
        raw.slice(base + ENTRY_PROGRAM_ID_OFF, base + ENTRY_PROGRAM_ID_OFF + 32),
      ).toBase58();
      const dv = new DataView(raw.buffer, raw.byteOffset);
      const { bps: maxAllocationBps, riskTier } = unpackAllocation(
        dv.getUint16(base + ENTRY_MAX_BPS_OFF, true),
      );
      const approved = raw[base + ENTRY_APPROVED_OFF] === 1;
      protocols.push({ protocolId, programId, maxAllocationBps, riskTier, approved });
    }

    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    // Read scalars at explicit offsets; default to 0 ("unset") when the account
    // predates a given appended field (legacy / shorter layouts).
    const u8 = (off: number) => (off < raw.length ? raw[off] : 0);
    const u16 = (off: number) =>
      off + 2 <= raw.length ? dv.getUint16(off, true) : 0;
    const i64 = (off: number) =>
      off + 8 <= raw.length ? Number(dv.getBigInt64(off, true)) : 0;

    const confidenceThreshold = u8(CONST_CONFIDENCE_OFF);
    return {
      approvedProtocols: protocols,
      confidenceThreshold,
      minStablecoinReserveBps: u16(CONST_MIN_RESERVE_BPS_OFF),
      maxTotalDeployedBps: u16(CONST_MAX_DEPLOYED_BPS_OFF),
      minLiquidityBps: u16(CONST_MIN_LIQUIDITY_BPS_OFF),
      rebalanceFrequencySecs: i64(CONST_REBALANCE_FREQ_OFF),
      lastRebalanceAt: i64(CONST_LAST_REBALANCE_OFF),
    };
  } catch {
    return null;
  }
}

// AssetConfig discriminator (nave_core). Same bytes snapshot-treasury filters on.
const ASSET_CONFIG_DISCRIMINATOR = new Uint8Array([57, 112, 247, 166, 247, 64, 140, 23]);

/**
 * Strategy position PDA. nave_core seeds are the 4-seed form
 * `[strategy_position, dao, protocol_id, mint]` (STRATEGY_POSITION_SEED).
 * The legacy 3-seed form does not match any live account.
 */
export function strategyPositionPda(dao: string, protocolId: string, mint: string): string {
  return PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("strategy_position"),
      new PublicKey(dao).toBuffer(),
      new TextEncoder().encode(protocolId),
      new PublicKey(mint).toBuffer(),
    ],
    corePid,
  )[0].toBase58();
}

/** Mints the DAO has registered (AssetConfig.mint). Empty when none or unreadable. */
export async function listRegisteredMints(rpcUrl: string, dao: string): Promise<string[]> {
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          NAVE_CORE_PROGRAM_ID,
          {
            encoding: "base64",
            commitment: "confirmed",
            filters: [
              { memcmp: { offset: 0, bytes: bytesToBase58(ASSET_CONFIG_DISCRIMINATOR) } },
              { memcmp: { offset: 9, bytes: new PublicKey(dao).toBase58() } },
            ],
          },
        ],
      }),
    });
    const json = await resp.json();
    const rows = json?.result as Array<{ account?: { data?: [string, string] } }> | null;
    if (!Array.isArray(rows)) return [];
    const mints: string[] = [];
    for (const row of rows) {
      const b64 = row.account?.data?.[0];
      if (!b64) continue;
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (raw.length < 73) continue;
      mints.push(new PublicKey(raw.slice(41, 73)).toBase58());
    }
    return mints;
  } catch {
    return [];
  }
}

export interface PositionView {
  protocolId: string;
  currentValueBaseUnits: number;
  /** SPL mint of the asset deployed in this position (base58). Populated when
   *  the on-chain StrategyPosition is readable; null when account is missing or
   *  uninitialized.
   *
   * `readStrategyPositions` sums `current_value` at byte offset 194
   * (the live nave_core layout) across registered mints.
   */
  mint: string | null;
}

/**
 * Read per-protocol deployed value (and asset mint) from on-chain
 * StrategyPosition accounts.
 *
 * StrategyPosition current layout (bytes):
 *   [0..8]   discriminator
 *   [8]      bump (u8)
 *   [9..41]  dao (Pubkey, 32)
 *   [41..73] mint (Pubkey, 32)
 *   [73..105] position_token_account (Pubkey)
 *   [105..137] ext_market (Pubkey)
 *   [137..169] ext_reserve (Pubkey)
 *   [169..185] protocol_id ([u8;16])
 *   [185]    protocol_id_len (u8)
 *   [186..194] deposited_amount (u64 LE)
 *   [194..202] current_value (u64 LE)
 *   [202..210] last_updated (i64 LE)
 *
 * Missing/uninitialized positions yield 0 value and null mint.
 */
const POSITION_MINT_OFF         = 41;  // after disc(8) + bump(1) + dao(32)
const POSITION_CURRENT_VALUE_OFF = 194; // full current layout

export async function readStrategyPositions(
  rpcUrl: string,
  dao: string,
  protocolIds: string[],
  mints: string[],
): Promise<PositionView[]> {
  const out: PositionView[] = [];
  for (const protocolId of protocolIds) {
    let currentValueBaseUnits = 0;
    let mint: string | null = null;
    for (const candidate of mints) {
      try {
        const raw = await getAccountData(rpcUrl, strategyPositionPda(dao, protocolId, candidate));
        if (!raw || raw.length < POSITION_CURRENT_VALUE_OFF + 8) continue;
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const value = Number(dv.getBigUint64(POSITION_CURRENT_VALUE_OFF, true));
        if (value <= 0) continue;
        currentValueBaseUnits += value;
        if (!mint && raw.length >= POSITION_MINT_OFF + 32) {
          mint = bytesToBase58(raw.slice(POSITION_MINT_OFF, POSITION_MINT_OFF + 32));
        }
      } catch {
        // Missing account for this (protocol, mint) pair is not a position.
      }
    }
    out.push({ protocolId, currentValueBaseUnits, mint });
  }
  return out;
}

/** Read and decode the DAO's on-chain treasury vault accounting. */
export async function readTreasuryVault(
  rpcUrl: string,
  dao: string,
): Promise<VaultView | null> {
  try {
    const raw = await getAccountData(rpcUrl, treasuryVaultPda(dao));
    if (!raw || raw.length < VAULT_DEPLOYED_CAPITAL_OFF + 8) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset);
    // Feature-detect last_revalued_at: only read when the confirmed offset is
    // configured AND the account is long enough to contain the i64 there.
    let navLastRevaluedAt: number | null | undefined = undefined;
    if (
      VAULT_LAST_REVALUED_OFF !== null &&
      raw.length >= VAULT_LAST_REVALUED_OFF + 8
    ) {
      navLastRevaluedAt = Number(dv.getBigInt64(VAULT_LAST_REVALUED_OFF, true));
    }
    return {
      navBaseUnits: Number(dv.getBigUint64(VAULT_CURRENT_NAV_OFF, true)),
      deployedBaseUnits: Number(dv.getBigUint64(VAULT_DEPLOYED_CAPITAL_OFF, true)),
      navLastRevaluedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Read the on-chain DAO founder (DaoRegistry.founder) for the DAO whose account
 * address is `daoAddress`. Returns the founder pubkey (base58) or null if the
 * account can't be read. Used to bind off-chain registration / key generation to
 * the real founder, not merely to any wallet that can sign.
 */
export async function readDaoFounder(
  rpcUrl: string,
  daoAddress: string,
): Promise<string | null> {
  try {
    const raw = await getAccountData(rpcUrl, daoAddress);
    if (!raw || raw.length < DAO_FOUNDER_OFF + 32) return null;
    return new PublicKey(
      raw.slice(DAO_FOUNDER_OFF, DAO_FOUNDER_OFF + 32),
    ).toBase58();
  } catch {
    return null;
  }
}

/** On-chain agent pause/freeze state read for the deterministic guardrail. */
export interface AgentGateView {
  /** AgentSet.agents_enabled (mirrored on DaoRegistry). null when unreadable. */
  agentsEnabled: boolean | null;
  /** DaoRegistry.frozen emergency freeze. null when unreadable. */
  frozen: boolean | null;
}

/** AgentSet PDA: PDA(["agent_set", dao_registry], core). */
export function agentSetPda(daoAddress: string): string {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("agent_set"), new PublicKey(daoAddress).toBuffer()],
    corePid,
  )[0].toBase58();
}

/**
 * Read the on-chain agent gate (pause state) for a DAO. `daoAddress` is the
 * DaoRegistry account address. Both flags are read from the DaoRegistry mirror
 * (frozen + agents_enabled); if DaoRegistry is unreadable we fall back to the
 * AgentSet account for agents_enabled. A flag is `null` only when it cannot be
 * read from any source, letting callers fail-closed deliberately rather than on
 * a transient read miss.
 */
export async function readAgentGate(
  rpcUrl: string,
  daoAddress: string,
): Promise<AgentGateView> {
  let frozen: boolean | null = null;
  let agentsEnabled: boolean | null = null;

  try {
    const raw = await getAccountData(rpcUrl, daoAddress);
    if (raw && raw.length > DAO_AGENTS_ENABLED_OFF) {
      frozen = raw[DAO_FROZEN_OFF] === 1;
      agentsEnabled = raw[DAO_AGENTS_ENABLED_OFF] === 1;
    }
  } catch {
    // fall through to AgentSet fallback below
  }

  if (agentsEnabled === null) {
    try {
      const raw = await getAccountData(rpcUrl, agentSetPda(daoAddress));
      if (raw && raw.length > AGENTSET_AGENTS_ENABLED_OFF) {
        agentsEnabled = raw[AGENTSET_AGENTS_ENABLED_OFF] === 1;
      }
    } catch {
      // leave agentsEnabled null when neither source is readable
    }
  }

  return { agentsEnabled, frozen };
}

const ASSET_TOKEN_ACCOUNT_OFF = 8 + 1 + 32 + 32;
const ASSET_DEPLOYED_BASE_OFF = ASSET_TOKEN_ACCOUNT_OFF + 32 + 8;
const ASSET_LAST_VALUED_USD_OFF = ASSET_DEPLOYED_BASE_OFF + 8;
const SPL_AMOUNT_OFF = 64;

export interface SolanaMintQuote {
  /** Idle vault balance plus base units deployed from this mint. */
  totalBase: number;
  /** last_valued_usd for that same pile, in micro-USD. */
  totalMicroUsd: number;
  /** Idle vault balance alone, in base units. */
  idleBase: number;
}

/**
 * Last revalue mark for one Solana mint. Caps compare micro-USD, while a
 * request amount is in token base units. The quote is the bridge: micro-USD
 * per base unit = totalMicroUsd / totalBase. Returns null when the asset has
 * not been valued.
 */
export async function readSolanaMintQuote(
  rpcUrl: string,
  dao: string,
  mint: string,
): Promise<SolanaMintQuote | null> {
  try {
    const assetPda = PublicKey.findProgramAddressSync(
      [
        new TextEncoder().encode("treasury_asset"),
        new PublicKey(dao).toBuffer(),
        new PublicKey(mint).toBuffer(),
      ],
      corePid,
    )[0].toBase58();
    const raw = await getAccountData(rpcUrl, assetPda);
    if (!raw || raw.length < ASSET_LAST_VALUED_USD_OFF + 8) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const tokenAccount = bytesToBase58(raw.slice(ASSET_TOKEN_ACCOUNT_OFF, ASSET_TOKEN_ACCOUNT_OFF + 32));
    const deployed = dv.getBigUint64(ASSET_DEPLOYED_BASE_OFF, true);
    const valued = dv.getBigUint64(ASSET_LAST_VALUED_USD_OFF, true);
    if (valued === 0n) return null;
    const tokenRaw = await getAccountData(rpcUrl, tokenAccount);
    const idle = tokenRaw && tokenRaw.length >= SPL_AMOUNT_OFF + 8
      ? new DataView(tokenRaw.buffer, tokenRaw.byteOffset, tokenRaw.byteLength).getBigUint64(SPL_AMOUNT_OFF, true)
      : 0n;
    const total = idle + deployed;
    if (total <= 0n) return null;
    const totalBase = Number(total);
    const totalMicroUsd = Number(valued);
    if (!Number.isSafeInteger(totalBase) || !Number.isSafeInteger(totalMicroUsd)) return null;
    return { totalBase, totalMicroUsd, idleBase: Number(idle) };
  } catch {
    return null;
  }
}

/**
 * Canonical NE-7 payload hash:
 *   sha256(protocol_program(32) ‖ amount u64 LE(8) ‖ mint(32)) = 72-byte preimage.
 *
 * Byte-identical to what nave_execution::create_execution_request binds
 * (programs/nave_execution/src/lib.rs): the proposal commits
 * proposal.payload_hash = sha256(payload), the execution program recomputes the
 * same 72 bytes, and ExecutionRequest.tx_payload_hash carries it forward. The
 * orchestrator threads this on-chain hash as `expected_payload_hash`, so an
 * honest financial / oversight agent's payload hash must equal this value for
 * signing to proceed. The mint is REQUIRED — omitting it (the legacy 40-byte
 * form) produces a hash that can never match the on-chain binding.
 */
export async function canonicalPayloadHash(
  protocolProgram: string,
  amount: number | bigint,
  mint: string,
): Promise<string> {
  const preimage = new Uint8Array(72);
  preimage.set(new PublicKey(protocolProgram).toBytes(), 0);
  const dv = new DataView(preimage.buffer);
  dv.setBigUint64(32, BigInt(amount), true);
  preimage.set(new PublicKey(mint).toBytes(), 40);
  const digest = await crypto.subtle.digest("SHA-256", preimage);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
