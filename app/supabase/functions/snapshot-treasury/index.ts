import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { PublicKey } from "npm:@solana/web3.js@1.95.0";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import { ALL_EVM_CHAIN_IDS, SUPPORTED_EVM_CHAIN_IDS } from "../_shared/chain.ts";
import { evmRpcUrlFor } from "../_shared/evmFounder.ts";
import { readEvmTreasurySnapshotMetrics } from "../_shared/evmTreasuryNav.ts";
import { signerSecretFor } from "../_shared/signerAuth.ts";

// ─── Solana RPC helpers ───────────────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000;

// Cluster-correct USDC mint. Mainnet default; override per cluster via env:
//   devnet USDC: Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr
//   localnet: set NAVE_USDC_MINT to whatever test mint you created
const USDC_MINT =
  Deno.env.get("NAVE_USDC_MINT") || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// nave_core program ID — used to derive the vault authority PDA on-chain.
const NAVE_CORE_PROGRAM_ID =
  Deno.env.get("NAVE_CORE_PROGRAM_ID") || "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB";

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const json = await res.json();
  return json.result;
}

/** Get SOL balance in SOL (not lamports) */
async function getSolBalance(
  rpcUrl: string,
  address: string,
): Promise<number> {
  const result = (await rpcCall(rpcUrl, "getBalance", [
    address,
    { commitment: "confirmed" },
  ])) as { value: number } | null;
  if (!result) return 0;
  return result.value / LAMPORTS_PER_SOL;
}

/** Get all SPL token accounts owned by an address */
async function getTokenAccounts(
  rpcUrl: string,
  ownerAddress: string,
): Promise<
  Array<{ mint: string; balance: number; decimals: number; uiAmount: number }>
> {
  const result = (await rpcCall(rpcUrl, "getTokenAccountsByOwner", [
    ownerAddress,
    { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    {
      encoding: "jsonParsed",
      commitment: "confirmed",
    },
  ])) as {
    value: Array<{
      account: {
        data: {
          parsed: {
            info: {
              mint: string;
              tokenAmount: {
                amount: string;
                decimals: number;
                uiAmount: number;
              };
            };
          };
        };
      };
    }>;
  } | null;

  if (!result?.value) return [];

  return result.value.map((acc) => ({
    mint: acc.account.data.parsed.info.mint,
    balance: Number(acc.account.data.parsed.info.tokenAmount.amount),
    decimals: acc.account.data.parsed.info.tokenAmount.decimals,
    uiAmount: acc.account.data.parsed.info.tokenAmount.uiAmount,
  }));
}

/**
 * Fetch SOL price (USD). On success, cache it in `price_cache`. On failure
 * (CoinGecko rate limits / transient errors), fall back to the last cached
 * price so a treasury snapshot never collapses to $0 from a price-API blip.
 */
// deno-lint-ignore no-explicit-any
async function getSolPrice(supabase: any): Promise<number> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    );
    const json = await res.json();
    const price = Number(json?.solana?.usd);
    if (Number.isFinite(price) && price > 0) {
      // Persist the latest good price for future fallbacks (best-effort).
      await supabase
        .from("price_cache")
        .upsert(
          { symbol: "solana", price_usd: price, updated_at: new Date().toISOString() },
          { onConflict: "symbol" },
        );
      return price;
    }
  } catch (e) {
    console.error("getSolPrice: live fetch failed, falling back to cache:", e);
  }

  // Fallback: last known good price.
  try {
    const { data } = await supabase
      .from("price_cache")
      .select("price_usd")
      .eq("symbol", "solana")
      .maybeSingle();
    const cached = Number(data?.price_usd);
    if (Number.isFinite(cached) && cached > 0) return cached;
  } catch (e) {
    console.error("getSolPrice: cache read failed:", e);
  }

  return 0;
}

// ─── Vault PDA derivation ────────────────────────────────────────────────
// The vault authority PDA owns the vault token account. We derive it on-chain
// from the DAO registry address and the nave_core program ID — the same seeds
// the program uses (["vault_authority", dao]). This removes the need for
// callers to supply (and the risk of them spoofing) vault authority addresses.

const corePid = new PublicKey(NAVE_CORE_PROGRAM_ID);

function deriveVaultAuthority(daoAddress: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vault_authority"), new PublicKey(daoAddress).toBytes()],
    corePid,
  );
  return pda.toBase58();
}

// ─── Reconciliation helpers (RECONCILIATION.md) ───────────────────────────
// Protocol ids whose escrow + strategy position are reconciled.
// Kamino, Jito, MarginFi use the adapter path (execute_strategy → escrow).
// Jupiter uses the direct nave_core CPI path (jupiter_deposit → vault_authority ATAs).
// All four are included so NAV snapshots reflect deployed positions.
const RECONCILE_PROTOCOLS = ["kamino", "jito", "marginfi", "jupiter"];

function pdaFor(seedParts: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seedParts, corePid)[0];
}
const seed = (s: string) => new TextEncoder().encode(s);

/** Raw account data via getAccountInfo (base64) → Uint8Array, or null. */
async function getAccountData(rpcUrl: string, address: string): Promise<Uint8Array | null> {
  const result = (await rpcCall(rpcUrl, "getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ])) as { value: { data: [string, string] } | null } | null;
  const b64 = result?.value?.data?.[0];
  if (!b64) return null;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function u64At(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

// TreasuryVault byte offsets (8 disc + bump 1 + dao 32 = 41):
//   vault_token_account @41..73, current_nav @89, deployed_capital @121.
function decodeTreasuryVault(data: Uint8Array): { currentNav: bigint; deployedCapital: bigint } | null {
  if (data.length < 129) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { currentNav: u64At(dv, 89), deployedCapital: u64At(dv, 121) };
}

// StrategyPosition layout (state/strategy_position.rs):
//   disc 8 | bump 1 | dao 32 | mint 32 | position_token_account 32 | ext_market 32
//   | ext_reserve 32 | protocol_id 16 | protocol_id_len 1 | deposited_amount 8
//   | current_value 8 | last_updated 8   → current_value @194 (LEN 210).
const STRATEGY_POSITION_CURRENT_VALUE_OFF = 8 + 1 + 32 + 32 + 32 + 32 + 32 + 16 + 1 + 8;
function decodeStrategyPositionValue(data: Uint8Array): bigint | null {
  if (data.length < STRATEGY_POSITION_CURRENT_VALUE_OFF + 8) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return u64At(dv, STRATEGY_POSITION_CURRENT_VALUE_OFF);
}
function decodeStrategyPositionDeposited(data: Uint8Array): bigint | null {
  if (data.length < STRATEGY_POSITION_CURRENT_VALUE_OFF) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return u64At(dv, STRATEGY_POSITION_CURRENT_VALUE_OFF - 8);
}

// TreasuryAsset layout (state/treasury_asset.rs):
//   disc 8 | bump 1 | dao 32 | mint 32 | token_account 32 | deposited 8
//   | deployed_capital 8 | last_valued_usd 8 | last_valued_at 8 | last_management_fee_at 8
const TREASURY_ASSET_DEPLOYED_OFF = 8 + 1 + 32 + 32 + 32 + 8;
function decodeTreasuryAssetDeployed(data: Uint8Array): bigint | null {
  if (data.length < TREASURY_ASSET_DEPLOYED_OFF + 8) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return u64At(dv, TREASURY_ASSET_DEPLOYED_OFF);
}

// TreasuryConstitution: protocol_count @41; protocols[] @42, 52 bytes each
// (protocol_id 16, len 1, program_id 32, max_allocation_bps 2, approved 1).
const CONST_MAX_DEPLOYED_BPS_OFF = 573;
const CONST_MIN_LIQUIDITY_BPS_OFF = 575;
function decodeMaxAllocationBps(data: Uint8Array, protocolId: string): number | null {
  if (data.length < 42) return null;
  const count = data[41];
  const ENTRY = 52;
  const idBytes = seed(protocolId);
  for (let i = 0; i < count && i < 10; i++) {
    const base = 42 + i * ENTRY;
    const len = data[base + 16];
    const approved = data[base + 51] === 1;
    if (!approved || len !== idBytes.length) continue;
    let match = true;
    for (let j = 0; j < len; j++) {
      if (data[base + j] !== idBytes[j]) { match = false; break; }
    }
    if (!match) continue;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // High two bits carry the venue risk tier.
    return dv.getUint16(base + 16 + 1 + 32, true) & 0x3fff;
  }
  return null;
}

function decodePolicyBps(data: Uint8Array): {
  maxTotalDeployedBps: number;
  minLiquidityBps: number;
} {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const maxTotalDeployedBps =
    CONST_MAX_DEPLOYED_BPS_OFF + 2 <= data.length
      ? dv.getUint16(CONST_MAX_DEPLOYED_BPS_OFF, true)
      : 0;
  const minLiquidityBps =
    CONST_MIN_LIQUIDITY_BPS_OFF + 2 <= data.length
      ? dv.getUint16(CONST_MIN_LIQUIDITY_BPS_OFF, true)
      : 0;
  return { maxTotalDeployedBps, minLiquidityBps };
}

/** SPL token base-unit balance for a token account, or 0n if missing. */
async function tokenBaseUnits(rpcUrl: string, account: string): Promise<bigint> {
  const result = (await rpcCall(rpcUrl, "getTokenAccountBalance", [
    account,
    { commitment: "confirmed" },
  ])) as { value: { amount: string } } | null;
  if (!result?.value?.amount) return 0n;
  try {
    return BigInt(result.value.amount);
  } catch {
    return 0n;
  }
}

// ─── Multi-asset treasury (AssetConfig / asset_vault) ─────────────────────────
// AssetConfig discriminator (from the IDL) — anchors the getProgramAccounts
// filter so we only enumerate per-(dao, mint) asset configs, never other
// account types that also carry `dao` at offset 9.
const ASSET_CONFIG_DISCRIMINATOR = [57, 112, 247, 166, 247, 64, 140, 23];

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Minimal base58 encoder for getProgramAccounts memcmp filters. */
function base58Encode(bytes: Uint8Array | number[]): string {
  const input = Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out || "1";
}

interface RegisteredAsset {
  mint: string;
  decimals: number;
  pythFeedHex: string; // 64-char hex (no 0x); all-zero for stablecoins
  isStablecoin: boolean;
  assetKind: number; // 0=Stable, 1=SolLike, 2=Other
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Enumerate every AssetConfig the DAO has registered (one per held mint), via a
 * discriminator + dao memcmp filtered getProgramAccounts. Returns [] if none.
 *
 * AssetConfig layout (offsets incl. 8-byte disc):
 *   disc 0..8, bump 8, dao 9..41, mint 41..73, decimals 73,
 *   pyth_feed_id 74..106, is_stablecoin 106, asset_kind 107.
 */
async function enumerateRegisteredAssets(
  rpcUrl: string,
  daoAddress: string,
): Promise<RegisteredAsset[]> {
  const daoB58 = new PublicKey(daoAddress).toBase58();
  const discB58 = base58Encode(ASSET_CONFIG_DISCRIMINATOR);
  const result = (await rpcCall(rpcUrl, "getProgramAccounts", [
    NAVE_CORE_PROGRAM_ID,
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: discB58 } },
        { memcmp: { offset: 9, bytes: daoB58 } },
      ],
    },
  ])) as Array<{ account: { data: [string, string] } }> | null;
  if (!result || result.length === 0) return [];

  const assets: RegisteredAsset[] = [];
  for (const entry of result) {
    const b64 = entry.account?.data?.[0];
    if (!b64) continue;
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (data.length < 108) continue;
    assets.push({
      mint: new PublicKey(data.slice(41, 73)).toBase58(),
      decimals: data[73],
      pythFeedHex: bytesToHex(data.slice(74, 106)),
      isStablecoin: data[106] === 1,
      assetKind: data[107],
    });
  }
  return assets;
}

/** asset_vault PDA (["asset_vault", dao, mint]) — vault-owned holding account. */
function assetVaultPda(daoAddress: string, mint: string): string {
  return pdaFor([seed("asset_vault"), new PublicKey(daoAddress).toBytes(), new PublicKey(mint).toBytes()])
    .toBase58();
}

/**
 * Best-effort EVM `revalue_treasury` through the signer `/relay-evm` route.
 * Same enablement gate as the Solana path. Never throws.
 */
async function maybeRevalueEvmViaSigner(
  chainId: number,
  daoAddress: string,
): Promise<{ ok: boolean; signature?: string; error?: string }> {
  const enabled = (Deno.env.get("NAVE_SNAPSHOT_REVALUE_ENABLED") || "").toLowerCase() === "true";
  const signerUrl = Deno.env.get("NAVE_SIGNER_URL");
  const signerSecret = Deno.env.get("NAVE_SIGNER_SECRET");
  if (!enabled || !signerUrl || !signerSecret) {
    return { ok: false, error: "revalue disabled or signer not configured" };
  }
  try {
    const res = await fetch(`${signerUrl.replace(/\/$/, "")}/relay-evm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signer-Secret": signerSecretFor("operational") ?? signerSecret },
      body: JSON.stringify({
        action: "revalue_treasury",
        chain_id: chainId,
        dao_address: daoAddress,
        agent_role: "operational",
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json?.error || `signer ${res.status}` };
    return { ok: true, signature: json?.signature };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "signer call failed" };
  }
}

/**
 * Best-effort Solana `revalue_treasury` via the signer `/sign` route so
 * `treasury_vault.current_nav` is fresh before we read it. Gated by env;
 * never throws.
 */
async function maybeRevalueViaSigner(
  daoAddress: string,
  assets: RegisteredAsset[],
): Promise<{ ok: boolean; signature?: string; error?: string }> {
  const enabled = (Deno.env.get("NAVE_SNAPSHOT_REVALUE_ENABLED") || "").toLowerCase() === "true";
  const signerUrl = Deno.env.get("NAVE_SIGNER_URL");
  const signerSecret = Deno.env.get("NAVE_SIGNER_SECRET");
  if (!enabled || !signerUrl || !signerSecret || assets.length === 0) {
    return { ok: false, error: "revalue disabled or signer not configured" };
  }
  try {
    const res = await fetch(`${signerUrl.replace(/\/$/, "")}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signer-Secret": signerSecretFor("operational") ?? signerSecret },
      body: JSON.stringify({
        action: "revalue_treasury",
        dao_address: daoAddress,
        agent_role: "operational",
        // The signer resolves each mint's feed + stablecoin flag on-chain and
        // self-posts fresh Pyth updates; we only need to pass the mint list.
        assets: assets.map((a) => ({ mint: a.mint })),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json?.error || `signer ${res.status}` };
    return { ok: true, signature: json?.signature };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "signer call failed" };
  }
}

export interface ReconciliationBreach {
  invariant: string;
  expected: string;
  actual: string;
  delta: string;
  protocol?: string;
  mint?: string;
}

interface StrategyPositionSnapshot {
  protocol_id: string;
  mint: string;
  escrow_balance_base_units: string;
  current_value_base_units: string;
  /** Principal on the position; current / deposited across snapshots gives the measured APY. */
  deposited_base_units: string;
}

/**
 * "ok"      — invariants computed; see `breaches`.
 * "suspect" — treasury_vault.deployed_capital > 0 but EVERY escrow / position /
 *             asset_vault read back zero. Almost always means our PDA
 *             derivation or layout offsets drifted from the program (the
 *             failure mode this self-test exists to catch), not a real drain.
 */
type ReconciliationStatus = "ok" | "suspect";

interface ReconciliationResult {
  status: ReconciliationStatus;
  breaches: ReconciliationBreach[];
  strategyPositions: StrategyPositionSnapshot[];
  /** asset_vault base-unit balance per mint (reused by the snapshot breakdown). */
  vaultBalancesByMint: Map<string, bigint>;
}

/**
 * Compute the RECONCILIATION.md invariants for one DAO from authoritative
 * on-chain state. Returns the breaches (empty array = healthy), or null if the
 * treasury_vault could not be read (separately surfaced as an error).
 *
 * Strategy escrow / position PDAs are per (dao, protocol, MINT):
 *   ["strategy_escrow",   dao, protocol_id, mint]
 *   ["strategy_position", dao, protocol_id, mint]
 * (programs/nave_core/src/instructions/strategy.rs). We iterate every
 * registered asset mint; a DAO with no AssetConfig yet (pre-multi-asset) is
 * reconciled against the legacy USDC mint + `treasury_vault.vault_token_account`.
 */
async function reconcileDao(
  rpcUrl: string,
  daoAddress: string,
  registered: RegisteredAsset[],
): Promise<ReconciliationResult | null> {
  const dao = new PublicKey(daoAddress);
  const tvData = await getAccountData(rpcUrl, pdaFor([seed("treasury_vault"), dao.toBytes()]).toBase58());
  if (!tvData) return null;
  const tv = decodeTreasuryVault(tvData);
  if (!tv) return null;

  // constitution for per-protocol caps (invariant 3).
  const constData = await getAccountData(rpcUrl, pdaFor([seed("constitution"), dao.toBytes()]).toBase58());

  const breaches: ReconciliationBreach[] = [];
  const strategyPositions: StrategyPositionSnapshot[] = [];
  const vaultBalancesByMint = new Map<string, bigint>();
  const policy = constData ? decodePolicyBps(constData) : {
    maxTotalDeployedBps: 0,
    minLiquidityBps: 0,
  };

  const legacy = registered.length === 0;
  // Legacy single-mint DAO: the only holding account is the one recorded on
  // treasury_vault (offset 41..73) and it holds USDC.
  const mints: Array<{ mint: string; decimals: number; isStablecoin: boolean; vault: string }> = legacy
    ? [{
      mint: USDC_MINT,
      decimals: 6,
      isStablecoin: true,
      vault: new PublicKey(tvData.slice(41, 73)).toBase58(),
    }]
    : registered.map((a) => ({
      mint: a.mint,
      decimals: a.decimals,
      isStablecoin: a.isStablecoin,
      vault: assetVaultPda(daoAddress, a.mint),
    }));

  let vaultTotal = 0n; // base units, summed only for the self-test
  let escrowTotal = 0n; // base units, summed only for the self-test
  let positionTotal = 0n; // base units, summed only for the self-test
  // Per-protocol marked value scaled to micro-USD for STABLECOIN mints only
  // (base units × 10^(6-decimals)). Non-stable assets are priced on-chain by
  // revalue_treasury and cannot be reproduced here without Pyth.
  const protocolMicroUsd = new Map<string, bigint>();
  // Legacy USDC-only DAOs: base units == micro-USD, so the vault-level NAV /
  // deployed conservation invariants can be checked exactly.
  let legacyVaultBalance = 0n;
  let legacyEscrowTotal = 0n;
  let legacyPositionTotal = 0n;

  for (const m of mints) {
    const mintPk = new PublicKey(m.mint);
    const vaultBal = await tokenBaseUnits(rpcUrl, m.vault);
    vaultBalancesByMint.set(m.mint, vaultBal);
    vaultTotal += vaultBal;

    let mintPositionTotal = 0n;
    for (const protocol of RECONCILE_PROTOCOLS) {
      // nave_core strategy PDAs are 4 seeds: [kind, dao, protocol_id, mint].
      const escrowPda = pdaFor([seed("strategy_escrow"), dao.toBytes(), seed(protocol), mintPk.toBytes()]);
      const positionPda = pdaFor([seed("strategy_position"), dao.toBytes(), seed(protocol), mintPk.toBytes()]);
      const escrowBal = await tokenBaseUnits(rpcUrl, escrowPda.toBase58());
      escrowTotal += escrowBal;

      const posData = await getAccountData(rpcUrl, positionPda.toBase58());
      const positionValue = posData ? (decodeStrategyPositionValue(posData) ?? 0n) : 0n;
      positionTotal += positionValue;
      mintPositionTotal += positionValue;
      strategyPositions.push({
        protocol_id: protocol,
        mint: m.mint,
        escrow_balance_base_units: escrowBal.toString(),
        current_value_base_units: positionValue.toString(),
        deposited_base_units: (posData ? (decodeStrategyPositionDeposited(posData) ?? 0n) : 0n).toString(),
      });

      if (m.isStablecoin && m.decimals <= 6) {
        const scale = 10n ** BigInt(6 - m.decimals);
        protocolMicroUsd.set(protocol, (protocolMicroUsd.get(protocol) ?? 0n) + positionValue * scale);
      }
    }

    if (legacy) {
      legacyVaultBalance = vaultBal;
      legacyEscrowTotal = escrowTotal;
      legacyPositionTotal = positionTotal;
    } else {
      // Invariant 2 (per asset): Σ position.current_value == treasury_asset.deployed_capital.
      const taData = await getAccountData(
        rpcUrl,
        pdaFor([seed("treasury_asset"), dao.toBytes(), mintPk.toBytes()]).toBase58(),
      );
      const taDeployed = taData ? decodeTreasuryAssetDeployed(taData) : null;
      if (taDeployed !== null && mintPositionTotal !== taDeployed) {
        breaches.push({
          invariant: "deployed_conservation",
          mint: m.mint,
          expected: taDeployed.toString(),
          actual: mintPositionTotal.toString(),
          delta: (mintPositionTotal - taDeployed).toString(),
        });
      }
    }
  }

  // Invariant 3: per-protocol cap (micro-USD vs micro-USD).
  if (constData) {
    for (const protocol of RECONCILE_PROTOCOLS) {
      const bps = decodeMaxAllocationBps(constData, protocol);
      const value = protocolMicroUsd.get(protocol);
      if (bps === null || value === undefined) continue;
      const cap = (tv.currentNav * BigInt(bps)) / 10_000n;
      if (value > cap) {
        breaches.push({
          invariant: "per_protocol_cap",
          protocol,
          expected: `<= ${cap}`,
          actual: value.toString(),
          delta: (value - cap).toString(),
        });
      }
    }
  }

  if (legacy) {
    // Invariant 1: NAV conservation (USDC base units == micro-USD).
    const navLhs = legacyVaultBalance + legacyEscrowTotal;
    if (navLhs !== tv.currentNav) {
      breaches.push({
        invariant: "nav_conservation",
        expected: tv.currentNav.toString(),
        actual: navLhs.toString(),
        delta: (navLhs - tv.currentNav).toString(),
      });
    }
    // Invariant 2: deployed-capital conservation.
    if (legacyPositionTotal !== tv.deployedCapital) {
      breaches.push({
        invariant: "deployed_conservation",
        expected: tv.deployedCapital.toString(),
        actual: legacyPositionTotal.toString(),
        delta: (legacyPositionTotal - tv.deployedCapital).toString(),
      });
    }
  }

  // Self-test: the program says capital is deployed, yet every account we
  // derived reads zero. That is far more likely a PDA-seed / layout drift on
  // OUR side than a real state — flag the snapshot rather than trusting it.
  let status: ReconciliationStatus = "ok";
  if (tv.deployedCapital > 0n && escrowTotal === 0n && positionTotal === 0n && vaultTotal === 0n) {
    status = "suspect";
    console.error(
      `[snapshot] RECONCILIATION SUSPECT for ${daoAddress}: treasury_vault.deployed_capital=${tv.deployedCapital} ` +
        `but all ${mints.length} asset_vault / ${strategyPositions.length} escrow+position reads are zero ` +
        `(mints=${mints.map((m) => m.mint).join(",")}). Check PDA seeds / account layouts.`,
    );
    breaches.push({
      invariant: "reconciliation_suspect",
      expected: "non-zero escrow/position/vault when deployed_capital > 0",
      actual: "all zero",
      delta: tv.deployedCapital.toString(),
    });
  }

  // Invariant 5: global deployment cap.
  if (policy.maxTotalDeployedBps > 0) {
    const maxAllowed = (tv.currentNav * BigInt(policy.maxTotalDeployedBps)) / 10_000n;
    if (tv.deployedCapital > maxAllowed) {
      breaches.push({
        invariant: "global_deployment_cap",
        expected: `<= ${maxAllowed}`,
        actual: tv.deployedCapital.toString(),
        delta: (tv.deployedCapital - maxAllowed).toString(),
      });
    }
  }

  // Invariant 6: liquidity floor.
  if (policy.minLiquidityBps > 0) {
    const minLiquidity = (tv.currentNav * BigInt(policy.minLiquidityBps)) / 10_000n;
    const availableLiquidity = tv.currentNav >= tv.deployedCapital
      ? tv.currentNav - tv.deployedCapital
      : 0n;
    if (availableLiquidity < minLiquidity) {
      breaches.push({
        invariant: "liquidity_floor",
        expected: `>= ${minLiquidity}`,
        actual: availableLiquidity.toString(),
        delta: (minLiquidity - availableLiquidity).toString(),
      });
    }
  }

  return { status, breaches, strategyPositions, vaultBalancesByMint };
}

/** POST a breach to ALERT_WEBHOOK_URL (best-effort). */
async function postAlert(payload: Record<string, unknown>): Promise<void> {
  const url = Deno.env.get("ALERT_WEBHOOK_URL");
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("ALERT_WEBHOOK_URL post failed:", e instanceof Error ? e.message : e);
  }
}

interface DaoRecord {
  dao_onchain_address: string;
  name: string;
  governance_type: string;
  /** Row discriminator; null/legacy rows are treated as Solana. */
  chain?: string | null;
  chain_id?: number | null;
}

interface RequestPayload {
  indexer_secret?: string; // legacy body field; prefer the X-Indexer-Secret header
  // Optional: snapshot only specific DAOs. If empty, snapshots all active DAOs.
  dao_addresses?: string[];
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // ── Lightweight health check (no auth, no secrets leaked) ──────────────
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("health") === "1") {
      return jsonResponse({
        ok: true,
        service: "snapshot-treasury",
        config: {
          supabase: Boolean(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
          indexerSecret: Boolean(Deno.env.get("NAVE_INDEXER_SECRET")),
          rpc: Boolean(Deno.env.get("SOLANA_RPC_URL")),
          // One entry per supported EVM chain id (1, 8453, 4663, 11155111, 84532, 46630).
          evmRpc: Object.fromEntries(
            ALL_EVM_CHAIN_IDS.map((id) => [String(id), Boolean(evmRpcUrlFor(id))]),
          ),
        },
      });
    }

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const body: RequestPayload = await req.json();
    const { dao_addresses } = body;
    // Prefer the X-Indexer-Secret header (kept out of body logs); fall back to
    // the legacy body field for mid-rollout deploy-order safety.
    const indexer_secret = req.headers.get("X-Indexer-Secret") ?? body.indexer_secret;

    // Auth (constant-time)
    const expectedSecret = Deno.env.get("NAVE_INDEXER_SECRET");
    if (!expectedSecret) {
      return jsonResponse({ error: "Service not configured: NAVE_INDEXER_SECRET" }, 500);
    }
    if (!secretsMatch(indexer_secret, expectedSecret)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Fail CLOSED: a devnet fallback here would silently snapshot the wrong
    // cluster and corrupt every downstream NAV/balance read. Require an explicit
    // RPC, matching generate-agent-keys / orchestrator-proxy.
    const rpcUrl = Deno.env.get("SOLANA_RPC_URL");
    if (!rpcUrl) {
      return jsonResponse(
        { error: "Service not configured: SOLANA_RPC_URL" },
        500,
      );
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Get DAOs to snapshot ─────────────────────────────────────────────
    let query = supabase
      .from("dao_registry")
      .select("dao_onchain_address, name, governance_type, chain, chain_id");

    if (dao_addresses && dao_addresses.length > 0) {
      query = query.in("dao_onchain_address", dao_addresses);
    }

    const { data: daos, error: daoError } = await query;

    if (daoError) {
      return jsonResponse({ error: "Failed to fetch DAOs" }, 500);
    }

    if (!daos || daos.length === 0) {
      return jsonResponse({
        success: true,
        snapshots_created: 0,
        message: "No DAOs found",
      });
    }

    const solPrice = await getSolPrice(supabase);
    const now = new Date().toISOString();
    const snapshots: Array<Record<string, unknown>> = [];
    const errors: Array<{ dao: string; error: string }> = [];
    const reconciliationByDao = new Map<string, ReconciliationResult | null>();

    for (const dao of daos as DaoRecord[]) {
      try {
        const rowChain = (dao.chain ?? "solana").toLowerCase();
        const cid = dao.chain_id ?? null;
        const isEvm =
          cid != null &&
          SUPPORTED_EVM_CHAIN_IDS.has(Number(cid)) &&
          (rowChain === "ethereum" || rowChain === "base" || rowChain === "robinhood") &&
          /^0x[0-9a-fA-F]{40}$/.test(dao.dao_onchain_address.trim());

        if (isEvm) {
          const treasury = dao.dao_onchain_address.trim().toLowerCase() as `0x${string}`;
          if (rowChain === "base" || rowChain === "robinhood" || rowChain === "ethereum") {
            const revalue = await maybeRevalueEvmViaSigner(Number(cid), treasury);
            if (!revalue.ok) {
              console.warn(`[snapshot-evm] revalue skipped for ${treasury}: ${revalue.error}`);
            }
          }
          const metrics = await readEvmTreasurySnapshotMetrics(Number(cid), treasury);
          if (!metrics) {
            errors.push({
              dao: dao.dao_onchain_address,
              error: "EVM treasury read failed (RPC unset or contract unreadable)",
            });
            reconciliationByDao.set(dao.dao_onchain_address, null);
            continue;
          }
          reconciliationByDao.set(dao.dao_onchain_address, null);
          snapshots.push({
            dao_onchain_address: dao.dao_onchain_address,
            total_value_usd: metrics.navUsd,
            sol_balance: metrics.nativeEth,
            usdc_balance: 0,
            strategy_positions: metrics.positions,
            token_balances: [
              {
                kind: "evm_native_eth",
                balance: metrics.nativeEth,
                note: "Native ETH on NaveTreasury; NAV from currentNav (micro-USD)",
              },
            ],
            snapshot_at: now,
            chain: rowChain,
            chain_id: Number(cid),
          });
          console.log(
            `[snapshot-evm] ${dao.dao_onchain_address} chain=${cid} nav≈$${metrics.navUsd.toFixed(4)} eth=${metrics.nativeEth}`,
          );
          continue;
        }

        // Derive the vault authority PDA on-chain (owner of the vault token account).
        let vaultAuth: string;
        try {
          vaultAuth = deriveVaultAuthority(dao.dao_onchain_address);
        } catch (e) {
          errors.push({
            dao: dao.dao_onchain_address,
            error: `Failed to derive vault authority: ${e instanceof Error ? e.message : "invalid address"}`,
          });
          continue;
        }

        // Fetch on-chain balances + reconciliation source data
        const solBalance = await getSolBalance(rpcUrl, vaultAuth);
        const tokenAccounts = await getTokenAccounts(rpcUrl, vaultAuth);

        // ── Multi-asset USD NAV ───────────────────────────────────────────
        // Enumerate the DAO's registered assets (AssetConfig PDAs). When present
        // this is the authoritative treasury composition; otherwise we fall back
        // to the legacy SOL+USDC heuristic for un-migrated DAOs. The list also
        // drives reconciliation (escrow/position PDAs are per mint).
        const registered = await enumerateRegisteredAssets(rpcUrl, dao.dao_onchain_address);
        const reconciliation = await reconcileDao(rpcUrl, dao.dao_onchain_address, registered);
        reconciliationByDao.set(dao.dao_onchain_address, reconciliation);

        // Find USDC balance (kept for the legacy column + dual-asset fallback)
        const usdcAccount = tokenAccounts.find((t) => t.mint === USDC_MINT);
        const usdcBalance = usdcAccount ? usdcAccount.uiAmount : 0;

        // Optionally refresh the on-chain USD NAV before reading it (self-posts
        // Pyth prices via the signer). Best-effort; failures don't block snapshot.
        let revalue: { ok: boolean; signature?: string; error?: string } = { ok: false };
        if (registered.length > 0) {
          revalue = await maybeRevalueViaSigner(dao.dao_onchain_address, registered);
        }

        // Read the authoritative on-chain USD NAV (micro-USD) post-revalue.
        let onchainNavUsd: number | null = null;
        const tvData = await getAccountData(
          rpcUrl,
          pdaFor([seed("treasury_vault"), new PublicKey(dao.dao_onchain_address).toBytes()]).toBase58(),
        );
        const tvDecoded = tvData ? decodeTreasuryVault(tvData) : null;
        if (tvDecoded && tvDecoded.currentNav > 0n) {
          onchainNavUsd = Number(tvDecoded.currentNav) / 1_000_000; // micro-USD → USD
        }

        // Per-asset breakdown for display. For the off-chain USD estimate we
        // price stablecoins at $1, SOL-like assets via the SOL spot price, and
        // leave "other" assets unpriced off-chain (the on-chain NAV is the
        // source of truth for those).
        const assetBreakdown: Array<Record<string, unknown>> = [];
        let heuristicNavUsd = 0;
        if (registered.length > 0) {
          for (const a of registered) {
            // Reuse the per-asset asset_vault read from reconciliation when available.
            const baseUnits = reconciliation?.vaultBalancesByMint.get(a.mint) ??
              await tokenBaseUnits(rpcUrl, assetVaultPda(dao.dao_onchain_address, a.mint));
            const uiAmount = Number(baseUnits) / Math.pow(10, a.decimals);
            let usdValue = 0;
            if (a.isStablecoin) usdValue = uiAmount;
            else if (a.assetKind === 1) usdValue = uiAmount * solPrice; // SolLike
            heuristicNavUsd += usdValue;
            assetBreakdown.push({
              mint: a.mint,
              balance: uiAmount,
              decimals: a.decimals,
              usd_value: usdValue,
              is_stablecoin: a.isStablecoin,
              asset_kind: a.assetKind,
              registered: true,
              is_usdc: a.mint === USDC_MINT,
            });
          }
        }

        // Token balances list: registered breakdown when available, else the
        // legacy wallet-scan view. Always include a meta marker for the UI.
        const tokenBalances: Array<Record<string, unknown>> = registered.length > 0
          ? assetBreakdown
          : tokenAccounts.map((t) => ({
              mint: t.mint,
              balance: t.uiAmount,
              decimals: t.decimals,
              is_usdc: t.mint === USDC_MINT,
            }));
        // Reconciliation status marker. Also written to the dedicated
        // `treasury_snapshots.reconciliation_status` column (migration
        // 1784400000); kept in the jsonb list for consumers that only read
        // token_balances. "suspect" means deployed_capital > 0 but every
        // escrow/position/vault read zero.
        tokenBalances.push({
          kind: "reconciliation_meta",
          reconciliation_status: reconciliation?.status ?? "unavailable",
          breach_count: reconciliation?.breaches.length ?? null,
        });

        // Authoritative NAV: prefer the on-chain micro-USD NAV, then the
        // multi-asset heuristic, then the legacy SOL+USDC heuristic.
        const legacyNavUsd = solBalance * solPrice + usdcBalance;
        const totalValueUsd = onchainNavUsd ?? (registered.length > 0 ? heuristicNavUsd : legacyNavUsd);

        snapshots.push({
          dao_onchain_address: dao.dao_onchain_address,
          total_value_usd: totalValueUsd,
          sol_balance: solBalance,
          usdc_balance: usdcBalance,
          strategy_positions: reconciliation?.strategyPositions ?? [],
          token_balances: tokenBalances,
          reconciliation_status: reconciliation?.status ?? "unavailable",
          snapshot_at: now,
          chain: "solana",
          chain_id: null,
        });

        if (registered.length > 0) {
          console.log(
            `[snapshot] ${dao.dao_onchain_address}: ${registered.length} assets, ` +
            `onchain NAV ${onchainNavUsd != null ? `$${onchainNavUsd.toFixed(4)}` : "n/a"}, ` +
            `revalue ${revalue.ok ? `ok(${revalue.signature?.slice(0, 8)})` : `skip(${revalue.error})`}`,
          );
        }
      } catch (e) {
        errors.push({
          dao: dao.dao_onchain_address,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    // ── Insert snapshots ─────────────────────────────────────────────────
    if (snapshots.length > 0) {
      const { error: insertError } = await supabase
        .from("treasury_snapshots")
        .insert(snapshots);

      if (insertError) {
        console.error("Failed to insert snapshots:", insertError);
        return jsonResponse(
          { error: "Failed to insert snapshots" },
          500,
        );
      }
    }

    // ── Reconciliation invariants + alerting (RECONCILIATION.md) ─────────
    // For every DAO with a fresh snapshot, recompute NAV/deployed conservation
    // and per-protocol caps from authoritative on-chain state. Breaches are
    // recorded as activity_logs `reconciliation_alert` rows AND posted to
    // ALERT_WEBHOOK_URL (if set) so they are visible even when one channel is
    // down. Best-effort: a reconciliation failure never blocks snapshotting.
    const reconciliationAlerts: Array<Record<string, unknown>> = [];
    let reconciledDaos = 0;
    let breachCount = 0;

    for (const dao of daos as DaoRecord[]) {
      try {
        const reconciliation = reconciliationByDao.get(dao.dao_onchain_address) ?? null;
        if (reconciliation === null) continue; // treasury_vault unreadable (pre-init DAO)
        const breaches = reconciliation.breaches;
        reconciledDaos += 1;
        for (const b of breaches) {
          breachCount += 1;
          const payload = {
            dao: dao.dao_onchain_address,
            invariant: b.invariant,
            expected: b.expected,
            actual: b.actual,
            delta: b.delta,
            protocol: b.protocol,
            mint: b.mint,
            reconciliation_status: reconciliation.status,
            snapshot_at: now,
          };
          const scope = b.protocol ?? b.mint;
          reconciliationAlerts.push({
            dao_onchain_address: dao.dao_onchain_address,
            event_type: "reconciliation_alert",
            description: `Reconciliation breach: ${b.invariant}${scope ? ` (${scope})` : ""} expected ${b.expected} actual ${b.actual}`,
            actor: "snapshot-treasury",
            tx_signature: `recon:${dao.dao_onchain_address}:${b.invariant}:${scope ?? ""}:${now}`,
            slot: 0,
            block_time: now,
            raw_data: payload,
          });
          await postAlert(payload);
        }
      } catch (e) {
        console.error(`reconcileDao failed for ${dao.dao_onchain_address}:`, e);
      }
    }

    // Staleness: any DAO that failed to produce a snapshot this run signals the
    // agents may be acting on stale state (RECONCILIATION.md paging criterion).
    for (const err of errors) {
      const payload = {
        dao: err.dao,
        invariant: "snapshot_staleness",
        expected: "fresh snapshot",
        actual: err.error,
        delta: "n/a",
        snapshot_at: now,
      };
      reconciliationAlerts.push({
        dao_onchain_address: err.dao,
        event_type: "reconciliation_alert",
        description: `Snapshot staleness: ${err.error}`,
        actor: "snapshot-treasury",
        tx_signature: `recon:${err.dao}:staleness:${now}`,
        slot: 0,
        block_time: now,
        raw_data: payload,
      });
      await postAlert(payload);
    }

    if (reconciliationAlerts.length > 0) {
      // tx_signature is indexed but not unique, so dedupe explicitly (same
      // pattern as index-events) against the synthetic recon signatures so
      // repeated runs in the same window don't produce duplicate alert rows.
      const sigs = reconciliationAlerts.map((a) => a.tx_signature as string);
      const { data: existing } = await supabase
        .from("activity_logs")
        .select("tx_signature")
        .in("tx_signature", sigs);
      const existingSigs = new Set(
        (existing ?? []).map((r: { tx_signature: string }) => r.tx_signature),
      );
      const fresh = reconciliationAlerts.filter(
        (a) => !existingSigs.has(a.tx_signature as string),
      );
      if (fresh.length > 0) {
        const { error: alertErr } = await supabase.from("activity_logs").insert(fresh);
        if (alertErr) {
          console.error("Failed to write reconciliation_alert rows:", alertErr);
        }
      }
    }

    // ── Check if we need to aggregate monthly reports ──────────────────
    const currentDate = new Date();
    const currentYear = currentDate.getUTCFullYear();
    const currentMonth = currentDate.getUTCMonth() + 1;

    for (const dao of daos as DaoRecord[]) {
      try {
        // Check if a report exists for this month
        const { data: existingReport } = await supabase
          .from("monthly_reports")
          .select("id")
          .eq("dao_onchain_address", dao.dao_onchain_address)
          .eq("year", currentYear)
          .eq("month", currentMonth)
          .maybeSingle();

        if (!existingReport) {
          // Get the latest snapshot for capital_end
          const currentSnapshot = snapshots.find(
            (s) => s.dao_onchain_address === dao.dao_onchain_address,
          );

          // Get last month's report for capital_start
          const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
          const lastYear = currentMonth === 1 ? currentYear - 1 : currentYear;
          const { data: prevReport } = await supabase
            .from("monthly_reports")
            .select("capital_end")
            .eq("dao_onchain_address", dao.dao_onchain_address)
            .eq("year", lastYear)
            .eq("month", lastMonth)
            .maybeSingle();

          const capitalEnd = currentSnapshot
            ? Number(currentSnapshot.total_value_usd)
            : 0;
          const capitalStart = prevReport
            ? Number(prevReport.capital_end)
            : capitalEnd;

          await supabase.from("monthly_reports").insert({
            dao_onchain_address: dao.dao_onchain_address,
            year: currentYear,
            month: currentMonth,
            capital_start: capitalStart,
            capital_end: capitalEnd,
            yield_earned: 0, // Will be accumulated as events come in
            fees_collected: 0,
            agent_actions_count: 0,
            wallet_actions_count: 0,
            proposals_count: 0,
            summary: {},
            chain: (dao.chain ?? "solana").toLowerCase(),
            chain_id: dao.chain_id ?? null,
          });
        }
      } catch (e) {
        // Non-fatal: log and continue
        console.error(
          `Failed to create monthly report for ${dao.dao_onchain_address}:`,
          e,
        );
      }
    }

    return jsonResponse({
      success: true,
      snapshots_created: snapshots.length,
      sol_price_usd: solPrice,
      reconciled_daos: reconciledDaos,
      reconciliation_breaches: breachCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("snapshot-treasury error:", error);
    return jsonResponse(
      {
        error: error instanceof Error
          ? error.message
          : "Internal server error",
      },
      500,
    );
  }
});
