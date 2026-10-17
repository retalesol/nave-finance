// ─── Chain abstraction types ─────────────────────────────────────────────────
// Nave is multi-chain across Solana, Ethereum, Base, Robinhood Chain, and
// Arc Testnet. The EVM chain-id set is deliberately closed — there is NO
// BNB/BSC, Polygon, Arc mainnet (5042), or any other EVM chain in product
// scope. Adding a chain id here is the single chokepoint that would widen that
// set, so the union types are intentionally narrow.
//
// Robinhood Chain (Arbitrum Nitro L2) hosts full DAO/treasury stacks; primary
// yield for RH/Base treasuries is via agent-automated bridges to Ethereum.

/** Top-level execution model. Solana uses the wallet-adapter/Anchor path; every
 *  EVM chain (Ethereum + Base + Robinhood) uses the wagmi/viem path. */
export type ChainKind = 'solana' | 'evm';

/**
 * The closed set of EVM chain ids Nave supports:
 *   - 1         Ethereum mainnet
 *   - 8453      Base mainnet
 *   - 4663      Robinhood Chain mainnet (Arbitrum Nitro L2)
 *   - 11155111  Ethereum Sepolia (testnet)
 *   - 84532     Base Sepolia (testnet)
 *   - 46630     Robinhood Chain Testnet
 *   - 5042002   Arc Testnet (no Arc mainnet id)
 */
export const EVM_CHAIN_IDS = [1, 8453, 4663, 11155111, 84532, 46630, 5042002] as const;
export type EvmChainId = (typeof EVM_CHAIN_IDS)[number];

/** Human-facing chain "family" used by selectors and routing. */
export type ChainFamily = 'solana' | 'ethereum' | 'base' | 'robinhood' | 'arc';

/** Families whose founder controls (freeze, agents, withdraw, dispatch) are live. */
export function isTreasuryOpsFamily(family: ChainFamily): family is EvmChainFamily {
  return family === 'ethereum' || family === 'base' || family === 'robinhood' || family === 'arc';
}

/** Testnet treasury creation: Solana, Ethereum, Base, Robinhood, and Arc. */
export const TESTNET_USER_CHAINS: readonly ChainFamily[] = ['solana', 'ethereum', 'base', 'robinhood', 'arc'];

/** Mainnet and mixed pickers stay Base observe-only. */
export const MAINNET_USER_CHAINS: readonly ChainFamily[] = ['base'];

export function userChainsFor(mode: EvmDeploymentMode): readonly ChainFamily[] {
  return mode === 'testnet' ? TESTNET_USER_CHAINS : MAINNET_USER_CHAINS;
}

function deploymentModeFromEnv(): EvmDeploymentMode {
  const raw = import.meta.env?.VITE_EVM_NETWORK;
  if (raw === 'mainnet' || raw === 'mixed') return raw;
  return 'testnet';
}

/** DAO-creation chains for the active `VITE_EVM_NETWORK` (default testnet). */
export const USER_CHAINS: readonly ChainFamily[] = userChainsFor(deploymentModeFromEnv());

/**
 * Homepage / lobby / DAO-app wallet switcher — Base + Robinhood only so create
 * and browse stay on the live DAO chains. Bridge & Stake use WALLET_CHAINS.
 */
export const APP_WALLET_CHAINS: readonly ChainFamily[] = USER_CHAINS;

/** Every network the Bridge/Stake wallet switcher offers (Solana + all EVM). */
export const WALLET_CHAINS: readonly ChainFamily[] = ['solana', 'ethereum', 'base', 'robinhood', 'arc'] as const;

/** Brand accent per chain family — used by icons/badges so every surface
 *  colors chains identically: Solana purple, Ethereum grey, Base blue,
 *  Robinhood green. */
export const CHAIN_COLORS: Record<ChainFamily, string> = {
  solana: '#9945FF',
  ethereum: '#8C8C8C',
  base: '#0052FF',
  robinhood: '#00C805',
  arc: '#0F766E',
};

/** A fully-resolved active chain. `evmChainId` is present iff `kind === 'evm'`. */
export interface ChainTarget {
  kind: ChainKind;
  family: ChainFamily;
  /** Set only for EVM targets; always one of EVM_CHAIN_IDS. */
  evmChainId?: EvmChainId;
  /** Display label, e.g. "Ethereum", "Base Sepolia". */
  label: string;
  /** True for Sepolia / Base Sepolia. */
  isTestnet: boolean;
}

/** Which EVM environment a single family is wired to. Mainnet → 1/8453/4663, testnet → 11155111/84532/46630. */
export type EvmNetwork = 'mainnet' | 'testnet';

/**
 * Deployment-wide EVM posture.
 * - `testnet` — all EVM families on testnets
 * - `mainnet` — all EVM families on mainnets
 * - `mixed` — Base + Robinhood mainnet, Ethereum Sepolia (Solana stays on its own RPC network)
 */
export type EvmDeploymentMode = EvmNetwork | 'mixed';

// ─── Per-family chain-id resolution ──────────────────────────────────────────

/** The EVM chain families (every ChainFamily except 'solana'). */
export type EvmChainFamily = Exclude<ChainFamily, 'solana'>;

/** EVM families that host Nave DAO contracts. */
export type DaoEvmChainFamily = EvmChainFamily;

/**
 * Mainnet/testnet chain id for the EVM families. Arc has a testnet id only.
 * `evmChainIdFor('arc', 'mainnet')` throws — chain id 5042 is not supported.
 */
export const EVM_CHAIN_ID_BY_FAMILY = {
  ethereum: { mainnet: 1, testnet: 11155111 },
  base: { mainnet: 8453, testnet: 84532 },
  robinhood: { mainnet: 4663, testnet: 46630 },
  arc: { testnet: 5042002 },
} as const;

const EVM_CHAIN_META: Record<EvmChainId, { family: EvmChainFamily; label: string; isTestnet: boolean }> = {
  1: { family: 'ethereum', label: 'Ethereum', isTestnet: false },
  8453: { family: 'base', label: 'Base', isTestnet: false },
  4663: { family: 'robinhood', label: 'Robinhood Chain', isTestnet: false },
  11155111: { family: 'ethereum', label: 'Ethereum Sepolia', isTestnet: true },
  84532: { family: 'base', label: 'Base Sepolia', isTestnet: true },
  46630: { family: 'robinhood', label: 'Robinhood Testnet', isTestnet: true },
  5042002: { family: 'arc', label: 'Arc Testnet', isTestnet: true },
};

/**
 * Block explorers per EVM chain id. Robinhood Chain uses Blockscout (same
 * `/tx/<hash>` and `/address/<addr>` path shape as Etherscan) — URLs match
 * `src/lib/evm/robinhoodChains.ts` / `signer-service/src/evmChains.ts`.
 */
export const EVM_EXPLORERS: Record<EvmChainId, { name: string; url: string }> = {
  1: { name: 'Etherscan', url: 'https://etherscan.io' },
  8453: { name: 'Basescan', url: 'https://basescan.org' },
  4663: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  11155111: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' },
  84532: { name: 'Basescan', url: 'https://sepolia.basescan.org' },
  46630: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  5042002: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.io' },
};

/** Explorer link for a tx hash or address on a supported EVM chain (null for unknown ids). */
export function evmExplorerUrl(
  chainId: number | null | undefined,
  kind: 'tx' | 'address',
  value: string,
): { url: string; label: string } | null {
  if (typeof chainId !== 'number' || !isEvmChainId(chainId)) return null;
  const ex = EVM_EXPLORERS[chainId];
  return { url: `${ex.url}/${kind}/${value}`, label: ex.name };
}

/** Solscan link for a Solana tx or address (cluster suffix for non-mainnet). */
export function solanaExplorerUrl(
  kind: 'tx' | 'address',
  value: string,
  solanaNetwork: 'mainnet' | 'devnet' | 'localnet' = 'devnet',
): { url: string; label: string } {
  const cluster = solanaNetwork === 'mainnet' ? '' : `?cluster=${solanaNetwork === 'localnet' ? 'custom' : 'devnet'}`;
  const path = kind === 'tx' ? 'tx' : 'account';
  return { url: `https://solscan.io/${path}/${value}${cluster}`, label: 'Solscan' };
}

/**
 * Network label for a DAO, driven by its `chain_id` ("Ethereum", "Base",
 * "Robinhood Chain", "Base Sepolia", …). Solana DAOs (no chain id) disclose
 * the RPC network ("Solana Devnet" / "Solana"). Never shows a bare "Chain N".
 */
export function daoNetworkLabel(
  chainId: number | null | undefined,
  solanaNetwork: 'mainnet' | 'devnet' | 'localnet' = 'devnet',
): string {
  if (typeof chainId === 'number' && isEvmChainId(chainId)) return EVM_CHAIN_META[chainId].label;
  if (typeof chainId === 'number') return `EVM chain ${chainId}`;
  if (solanaNetwork === 'mainnet') return 'Solana';
  return solanaNetwork === 'localnet' ? 'Solana Localnet' : 'Solana Devnet';
}

// ─── Type guards / helpers ───────────────────────────────────────────────────

/** Narrowing guard: is `id` one of the six supported EVM chain ids? */
export function isEvmChainId(id: number): id is EvmChainId {
  return (EVM_CHAIN_IDS as readonly number[]).includes(id);
}

/** True for Sepolia (11155111) / Base Sepolia (84532) / Robinhood Testnet (46630). */
export function isEvmTestnet(chainId: EvmChainId): boolean {
  return EVM_CHAIN_META[chainId]?.isTestnet ?? false;
}

/** Resolve the active EVM chain id for a family + network (closed set). */
export function evmChainIdFor(family: EvmChainFamily, network: EvmNetwork): EvmChainId {
  if (family === 'arc') {
    if (network !== 'testnet') {
      throw new Error('Arc mainnet chain id 5042 is not supported');
    }
    return EVM_CHAIN_ID_BY_FAMILY.arc.testnet;
  }
  return EVM_CHAIN_ID_BY_FAMILY[family][network];
}

/** Gas token symbol. Arc charges gas in 18-decimal native USDC, not ETH. */
export function evmNativeGasSymbol(chainId: EvmChainId): string {
  return chainId === 5042002 ? 'USDC' : 'ETH';
}

/** Build a ChainTarget for Solana. */
export function solanaTarget(): ChainTarget {
  return { kind: 'solana', family: 'solana', label: 'Solana', isTestnet: false };
}

/** Typical sister-treasury destination for agent bridges (RH/Base → Ethereum). */
export function recommendedSisterChainId(from: EvmChainId): EvmChainId {
  switch (from) {
    case 4663: return 1;
    case 46630: return 11155111;
    case 8453: return 1;
    case 84532: return 11155111;
    case 1: return 8453;
    case 11155111: return 84532;
    case 5042002: return 11155111;
  }
}

/** Other supported EVM destinations a founder can link from `from`. */
export function sisterDestChainIds(from: EvmChainId): EvmChainId[] {
  return EVM_CHAIN_IDS.filter((id) => id !== from);
}

/** Build a ChainTarget for a supported EVM chain id. Throws on out-of-scope ids. */
export function evmTarget(chainId: EvmChainId): ChainTarget {
  const meta = EVM_CHAIN_META[chainId];
  if (!meta) {
    throw new Error(`Unsupported EVM chain id ${chainId}. Nave supports only ${EVM_CHAIN_IDS.join(', ')}.`);
  }
  return { kind: 'evm', family: meta.family, evmChainId: chainId, label: meta.label, isTestnet: meta.isTestnet };
}

/**
 * Chain family label for agent-admin / activation payloads
 * (`'ethereum' | 'base' | 'robinhood'`). Prefer this over binary ethereum/base maps.
 */
export function evmActivationChainFamily(chainId: EvmChainId): EvmChainFamily {
  return EVM_CHAIN_META[chainId].family;
}

/** True when the connected wallet family can run EVM DAO / agent ops. */
export function isEvmDaoOpsFamily(family: ChainFamily | null | undefined): boolean {
  return family === 'ethereum' || family === 'base' || family === 'robinhood' || family === 'arc';
}

/** Build a ChainTarget from a family + EVM network selection. */
export function targetForFamily(family: ChainFamily, network: EvmNetwork): ChainTarget {
  if (family === 'solana') return solanaTarget();
  return evmTarget(evmChainIdFor(family, network));
}

/**
 * Infer the chain kind from an on-chain address string. EVM addresses are
 * 0x-prefixed 40-hex-char strings; everything else is treated as Solana
 * (base58). This lets data hooks branch by chain without threading context
 * through every call site — the DAO address itself carries the discriminator.
 */
export function chainKindFromAddress(address: string | null | undefined): ChainKind {
  if (!address) return 'solana';
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim()) ? 'evm' : 'solana';
}

/** True when an address looks like an EVM (0x…) address. */
export function isEvmAddress(address: string | null | undefined): boolean {
  return chainKindFromAddress(address) === 'evm';
}

/** Friendly label for a family, network-agnostic (bare "Ethereum"/"Base"). */
export function chainFamilyLabel(family: ChainFamily): string {
  switch (family) {
    case 'solana':
      return 'Solana';
    case 'ethereum':
      return 'Ethereum';
    case 'base':
      return 'Base';
    case 'robinhood':
      return 'Robinhood Chain';
    case 'arc':
      return 'Arc';
  }
}

/**
 * Friendly label that DISCLOSES the active network for each family so the
 * switcher never implies the wrong environment by omission.
 *
 * Pass either a single `EvmNetwork` (legacy uniform deployments) or a
 * per-family map (required for `mixed`: Ethereum Sepolia + Base/Robinhood mainnet).
 * For Solana, pass `solanaNetwork` (`devnet` / `mainnet` / `localnet`).
 */
export function chainFamilyLabelWithNetwork(
  family: ChainFamily,
  evmNetwork: EvmNetwork | Record<EvmChainFamily, EvmNetwork>,
  solanaNetwork: 'mainnet' | 'devnet' | 'localnet' = 'devnet',
): string {
  if (family === 'solana') {
    if (solanaNetwork === 'mainnet') return 'Solana (Mainnet)';
    if (solanaNetwork === 'localnet') return 'Solana (Localnet)';
    return 'Solana (Devnet)';
  }

  const network = typeof evmNetwork === 'string' ? evmNetwork : evmNetwork[family];
  switch (family) {
    case 'ethereum':
      return network === 'mainnet' ? 'Ethereum (Mainnet)' : 'Ethereum (Sepolia)';
    case 'base':
      return network === 'mainnet' ? 'Base (Mainnet)' : 'Base (Base Sepolia)';
    case 'robinhood':
      return network === 'mainnet' ? 'Robinhood Chain (Mainnet)' : 'Robinhood Chain (Testnet)';
    case 'arc':
      return 'Arc (Testnet)';
  }
}
