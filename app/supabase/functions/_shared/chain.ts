// Shared multi-chain discriminator helpers for the Nave edge functions.
//
// Nave runs on Solana (existing) plus EVM on Ethereum, Base and Robinhood
// Chain ONLY — mainnets (1 / 8453 / 4663) and their testnets Sepolia
// (11155111), Base Sepolia (84532) and Robinhood Testnet (46630). There is NO
// other EVM network in scope (no BSC / Polygon). These helpers keep that fence
// in one place so every function validates identically and Solana stays the
// default for backward compatibility.
//
// NOTE: Robinhood Chain hosts full DAO/treasury stacks as well as bridge +
// staking. Encrypted EVM agent keys and DAO creation accept robinhood.

export type ChainKind = "solana" | "ethereum" | "base" | "robinhood";

type EvmChainKind = Exclude<ChainKind, "solana">;

/** EVM numeric chain ids Nave supports, grouped by chain kind. */
export const EVM_CHAIN_IDS: Record<EvmChainKind, { mainnet: number; testnet: number }> = {
  ethereum: { mainnet: 1, testnet: 11155111 }, // Ethereum / Sepolia
  base: { mainnet: 8453, testnet: 84532 }, // Base / Base Sepolia
  robinhood: { mainnet: 4663, testnet: 46630 }, // Robinhood Chain / its testnet
};

/** Flat set of every supported EVM chain id (1, 8453, 4663, 11155111, 84532, 46630). */
export const SUPPORTED_EVM_CHAIN_IDS = new Set<number>([
  EVM_CHAIN_IDS.ethereum.mainnet,
  EVM_CHAIN_IDS.ethereum.testnet,
  EVM_CHAIN_IDS.base.mainnet,
  EVM_CHAIN_IDS.base.testnet,
  EVM_CHAIN_IDS.robinhood.mainnet,
  EVM_CHAIN_IDS.robinhood.testnet,
]);

/** Mainnet EVM chain ids (1, 8453, 4663). Canonical allowlist — do not hardcode elsewhere. */
export const EVM_MAINNET_CHAIN_IDS: readonly number[] = [
  EVM_CHAIN_IDS.ethereum.mainnet,
  EVM_CHAIN_IDS.base.mainnet,
  EVM_CHAIN_IDS.robinhood.mainnet,
];

/** Testnet EVM chain ids (11155111, 84532, 46630). */
export const EVM_TESTNET_CHAIN_IDS: readonly number[] = [
  EVM_CHAIN_IDS.ethereum.testnet,
  EVM_CHAIN_IDS.base.testnet,
  EVM_CHAIN_IDS.robinhood.testnet,
];

/** Ordered list form of SUPPORTED_EVM_CHAIN_IDS (mainnets first, then testnets). */
export const ALL_EVM_CHAIN_IDS: readonly number[] = [...EVM_MAINNET_CHAIN_IDS, ...EVM_TESTNET_CHAIN_IDS];

/** True when `chainId` is a supported EVM mainnet id. */
export function isEvmMainnetChainId(chainId: number): boolean {
  return EVM_MAINNET_CHAIN_IDS.includes(chainId);
}

/** chain_id → expected chain kind. Used to validate (chain, chain_id) pairing. */
const CHAIN_ID_TO_KIND: Record<number, EvmChainKind> = Object.fromEntries(
  (Object.entries(EVM_CHAIN_IDS) as [EvmChainKind, { mainnet: number; testnet: number }][])
    .flatMap(([kind, ids]) => [[ids.mainnet, kind], [ids.testnet, kind]]),
) as Record<number, EvmChainKind>;

/** Chain kind for a supported EVM chain id, or null when unsupported. */
export function evmChainKindFor(chainId: number): EvmChainKind | null {
  return CHAIN_ID_TO_KIND[chainId] ?? null;
}

export interface ChainSelector {
  chain: ChainKind;
  /** EVM numeric chain id; null for Solana. */
  chain_id: number | null;
}

/** Deployment network tag stored on `dao_registry.network` for homepage stats. */
export type DaoNetwork = "mainnet" | "testnet" | "devnet";

const EVM_MAINNET_IDS = new Set<number>(EVM_MAINNET_CHAIN_IDS);

/**
 * Resolve `dao_registry.network` for a (chain, chain_id) pair.
 * EVM: mainnet ids 1/8453/4663 → mainnet; Sepolia/Base Sepolia/RH testnet → testnet.
 * Solana: pass `solanaIsMainnet` from `isMainnetCluster()` (or false when unknown).
 */
export function daoNetworkFor(
  selector: ChainSelector,
  solanaIsMainnet = false,
): DaoNetwork {
  if (selector.chain === "solana") {
    return solanaIsMainnet ? "mainnet" : "devnet";
  }
  if (selector.chain_id != null && EVM_MAINNET_IDS.has(selector.chain_id)) {
    return "mainnet";
  }
  return "testnet";
}

/**
 * Which chain kinds a caller may use.
 * - "dao" (default): DAO-scoped surfaces — solana/ethereum/base/robinhood.
 * - "indexer": event-ingestion surfaces — same set (kept for call-site clarity).
 */
export type ChainScope = "dao" | "indexer";

export function isEvmChain(chain: ChainKind): boolean {
  return chain === "ethereum" || chain === "base" || chain === "robinhood";
}

/**
 * Validate + normalize a (chain, chain_id) pair from a request body.
 * Defaults to Solana when both are absent (preserves existing Solana flows).
 * Throws on any unsupported value or mismatched pair.
 */
export function normalizeChain(chain?: unknown, chainId?: unknown, scope: ChainScope = "dao"): ChainSelector {
  void scope;
  // Default: Solana (no chain_id). Keeps all pre-existing callers working.
  if (chain === undefined || chain === null || chain === "") {
    if (chainId !== undefined && chainId !== null) {
      throw new Error("chain_id provided without chain");
    }
    return { chain: "solana", chain_id: null };
  }

  if (typeof chain !== "string") {
    throw new Error("chain must be a string");
  }
  const normalized = chain.toLowerCase().trim() as ChainKind;

  if (normalized === "solana") {
    if (chainId !== undefined && chainId !== null) {
      throw new Error("Solana does not use a numeric chain_id");
    }
    return { chain: "solana", chain_id: null };
  }

  if (normalized !== "ethereum" && normalized !== "base" && normalized !== "robinhood") {
    throw new Error(`Unsupported chain '${chain}'. Allowed: solana, ethereum, base, robinhood`);
  }

  // EVM: a supported numeric chain_id is required and must match the kind.
  const idNum = typeof chainId === "string" ? Number(chainId) : (chainId as number);
  if (!Number.isInteger(idNum) || !SUPPORTED_EVM_CHAIN_IDS.has(idNum)) {
    throw new Error(
      `Unsupported or missing chain_id for ${normalized}. Allowed EVM ids: ${ALL_EVM_CHAIN_IDS.join(", ")}`,
    );
  }
  if (CHAIN_ID_TO_KIND[idNum] !== normalized) {
    throw new Error(`chain_id ${idNum} does not belong to chain '${normalized}'`);
  }
  return { chain: normalized, chain_id: idNum };
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase + validate an EVM 20-byte address. Throws on malformed input. */
export function normalizeEvmAddress(addr: string): string {
  if (typeof addr !== "string" || !EVM_ADDRESS_RE.test(addr)) {
    throw new Error(`Invalid EVM address: ${addr}`);
  }
  return addr.toLowerCase();
}
