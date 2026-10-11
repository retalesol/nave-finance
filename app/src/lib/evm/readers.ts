// ─── EVM read layer (Ethereum + Base only) ───────────────────────────────────
// Mirrors src/lib/onChainFetcher.ts for the EVM path. Every reader is defensive:
// if the chain isn't configured or the contracts aren't deployed, it resolves to
// null/empty rather than throwing, so chain-branched hooks render an empty state
// instead of crashing.
//
// Function names + return tuples are reconciled against the REAL Foundry ABIs:
//   - daoCount / formationFee live on NaveProtocol (NOT the factory).
//   - The factory has no getDao; the per-DAO trio is resolved from the treasury
//     clone's `governor()` / `execution()` getters (or the DaoCreated event /
//     EVM indexer for id-based enumeration).
//   - Treasury NAV getter is `currentNav` (NOT `nav`); proposalCount lives on
//     the treasury (NOT the governor).

import { getBalance, getPublicClient, readContract } from '@wagmi/core';
import { createPublicClient, formatUnits, http, type Abi, type Address, type PublicClient } from 'viem';
import { wagmiConfig, WAGMI_CHAIN_BY_ID } from './wagmi';
import { NaveTreasuryAbi, NaveProtocolAbi, NaveGovernorAbi, NaveExecutionAbi, NaveDaoStakeAbi, Erc20Abi } from './contracts';
import { getProtocolAddress, getFactoryAddress, toAddress, assertSupportedChain, type DaoContractAddresses } from './addresses';
import { EVM_RPC_URLS, getConfiguredEvmAdapters, isEvmChainConfigured } from '../programConfig';
import type { EvmChainId } from '../chain/types';
import {
  ProposalStatus,
  ProposalType,
  ExecutionStatus,
  AgentStatus,
  type DaoRegistry,
  type GovernanceType,
  type ProtocolEntry,
  type TokenRegistry,
} from '../onChainTypes';
import type { ProposalInfo } from '../../hooks/useProposals';
import type { ExecutionInfo } from '../../hooks/useExecutionPipeline';
import type { ConstitutionData } from '../../hooks/useConstitution';
import type { AgentStatusInfo } from '../../hooks/useAgentStatus';

/** Narrow a raw daoAddress string to a checksummed EVM treasury address. */
function treasuryAddress(daoAddress: string): Address | null {
  return toAddress(daoAddress);
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

async function safeRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn('[evm/readers] read failed (contracts may not be deployed yet):', err);
    return null;
  }
}

/**
 * Public client pinned to `chainId` (never the wallet's currently-connected
 * chain). Prefer the wagmi-configured transport; fall back to a one-off client
 * on the env RPC so Base/Robinhood stake balances cannot cross-wire.
 */
function publicClientForChain(chainId: EvmChainId): PublicClient {
  assertSupportedChain(chainId);
  const existing = getPublicClient(wagmiConfig, { chainId });
  if (existing) return existing as PublicClient;
  const chain = WAGMI_CHAIN_BY_ID[chainId];
  const rpc = EVM_RPC_URLS[chainId];
  return createPublicClient({
    chain,
    transport: rpc ? http(rpc) : http(),
  }) as PublicClient;
}

/**
 * Resolve the per-DAO contract trio from a treasury clone. The treasury stores
 * its sibling `governor` and `execution` clones as public immutable-ish state,
 * so a DAO known by its treasury address self-describes its trio with no
 * factory/registry round-trip. (Id-based enumeration of brand-new DAOs comes
 * from the DaoCreated event via the EVM indexer.)
 */
export async function fetchDaoContracts(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<DaoContractAddresses | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;
  return safeRead(async () => {
    const [governor, execution] = await Promise.all([
      readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'governor', chainId }) as Promise<Address>,
      readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'execution', chainId }) as Promise<Address>,
    ]);
    return { treasury, governor, execution };
  });
}

/** Read the protocol-wide DAO count for a chain (0 when unconfigured). */
export async function fetchDaoCount(chainId: EvmChainId): Promise<number> {
  assertSupportedChain(chainId);
  const protocol = getProtocolAddress(chainId);
  if (!protocol) return 0;
  const res = await safeRead(() =>
    readContract(wagmiConfig, { address: protocol, abi: NaveProtocolAbi, functionName: 'daoCount', chainId }),
  );
  return res == null ? 0 : Number(res as bigint);
}

/** Read the native DAO formation fee (wei) from NaveProtocol, or null. */
export async function fetchFormationFeeEvm(chainId: EvmChainId): Promise<bigint | null> {
  assertSupportedChain(chainId);
  const protocol = getProtocolAddress(chainId);
  if (!protocol) return null;
  const res = await safeRead(() =>
    readContract(wagmiConfig, { address: protocol, abi: NaveProtocolAbi, functionName: 'formationFee', chainId }),
  );
  return res == null ? null : (res as bigint);
}

/**
 * Read the native treasury-seed carve-out (wei) the factory deposits into each
 * new NaveTreasury clone at creation (`NaveProtocol.treasurySeed()`), or null.
 * Mirrors the Solana `TREASURY_SEED_LAMPORTS`; lets the UI surface the live
 * mainnet split amount without hardcoding it.
 */
export async function fetchTreasurySeedEvm(chainId: EvmChainId): Promise<bigint | null> {
  assertSupportedChain(chainId);
  const protocol = getProtocolAddress(chainId);
  if (!protocol) return null;
  const res = await safeRead(() =>
    readContract(wagmiConfig, { address: protocol, abi: NaveProtocolAbi, functionName: 'treasurySeed', chainId }),
  );
  return res == null ? null : (res as bigint);
}

/**
 * Inline ABI for the NaveProtocol NAVE-stake config getters. Declared here (not
 * in the synced NaveProtocol.json) so the recoverable-stake creation path works
 * without re-running the ABI sync; these three views are append-only additions to
 * the protocol singleton.
 */
const NAVE_STAKE_CONFIG_ABI = [
  { type: 'function', name: 'daoStake', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'requiredNaveStake', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'naveStakeToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies Abi;

/** Resolved on-chain DAO-creation NAVE stake config for an EVM chain. */
export interface EvmNaveStakeConfig {
  /** NaveDaoStake escrow/moonlight module (zero ⇒ stake path disabled). */
  module: Address | null;
  /** Wrapped-NAVE ERC-20 the stake is denominated in (zero ⇒ disabled). */
  token: Address | null;
  /** Required wrapped-NAVE base units to stake at creation. */
  amount: bigint;
  /** True only when the module + token are wired and a positive amount is set. */
  active: boolean;
}

/**
 * Read the per-chain DAO-creation NAVE stake config from NaveProtocol. When the
 * bridge/stake path is not yet wired (module/token zero or amount 0) the stake
 * leg is disabled (testnet stays fee-free with no stake). Returns null only when
 * the protocol singleton can't be resolved.
 */
export async function fetchNaveStakeConfigEvm(chainId: EvmChainId): Promise<EvmNaveStakeConfig | null> {
  assertSupportedChain(chainId);
  const protocol = getProtocolAddress(chainId);
  if (!protocol) return null;
  const client = publicClientForChain(chainId);
  const [moduleRaw, amountRaw, tokenRaw] = await Promise.all([
    safeRead(() => client.readContract({ address: protocol, abi: NAVE_STAKE_CONFIG_ABI, functionName: 'daoStake' })),
    safeRead(() => client.readContract({ address: protocol, abi: NAVE_STAKE_CONFIG_ABI, functionName: 'requiredNaveStake' })),
    safeRead(() => client.readContract({ address: protocol, abi: NAVE_STAKE_CONFIG_ABI, functionName: 'naveStakeToken' })),
  ]);
  const module = toAddress((moduleRaw as string | null) ?? null);
  const token = toAddress((tokenRaw as string | null) ?? null);
  const amount = amountRaw == null ? 0n : (amountRaw as bigint);
  const nonZero = (a: Address | null) => !!a && a.toLowerCase() !== ZERO_ADDRESS;
  return {
    module,
    token,
    amount,
    active: nonZero(module) && nonZero(token) && amount > 0n,
  };
}

/** Read an ERC-20 balance for `owner` (base units), or null when unreadable. */
export async function fetchErc20BalanceEvm(
  chainId: EvmChainId,
  token: string,
  owner: string,
): Promise<bigint | null> {
  assertSupportedChain(chainId);
  const tokenAddr = toAddress(token);
  const ownerAddr = toAddress(owner);
  if (!tokenAddr || !ownerAddr) return null;
  const client = publicClientForChain(chainId);
  const res = await safeRead(() =>
    client.readContract({
      address: tokenAddr,
      abi: Erc20Abi,
      functionName: 'balanceOf',
      args: [ownerAddr],
    }),
  );
  return res == null ? null : (res as bigint);
}

/**
 * Read whether a treasury's native seed has been recorded
 * (`NaveTreasury.nativeSeeded()`) and the current native balance the treasury
 * accounts for (`NaveTreasury.nativeBalance()`). Returns nulls when unreadable so
 * the creation flow can decide whether the seed step still needs to run.
 */
export async function fetchTreasuryNativeSeedEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<{ seeded: boolean | null; nativeBalance: bigint | null }> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return { seeded: null, nativeBalance: null };
  const t = { address: treasury, abi: NaveTreasuryAbi, chainId } as const;
  const [seededRaw, balRaw] = await Promise.all([
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'nativeSeeded' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'nativeBalance' })),
  ]);
  return {
    seeded: seededRaw == null ? null : Boolean(seededRaw),
    nativeBalance: balRaw == null ? null : (balRaw as bigint),
  };
}

/**
 * Read whether the DAO's one-time zero-review-window bootstrap path has already
 * been consumed (`NaveExecution.bootstrapUsed()`). Returns null when the chain /
 * execution clone can't be resolved. Used by the creation flow to skip the
 * bootstrap step on resume (and by the dashboard to label the bootstrap request).
 */
export async function fetchBootstrapUsedEvm(chainId: EvmChainId, daoAddress: string): Promise<boolean | null> {
  assertSupportedChain(chainId);
  const trio = await fetchDaoContracts(chainId, daoAddress);
  if (!trio) return null;
  const res = await safeRead(() =>
    readContract(wagmiConfig, { address: trio.execution, abi: NaveExecutionAbi, functionName: 'bootstrapUsed', chainId }),
  );
  return res == null ? null : Boolean(res);
}

/**
 * Resolve the NaveDAOFactory address for a chain. First checks the env-var
 * configured address (EVM_FACTORY_ADDRESSES from programConfig); when that is
 * absent (e.g. dev server restarted before env was updated, or factory address
 * not yet in `.env.local`), falls back to reading `NaveProtocol.factory()`
 * on-chain — so the factory is always discoverable as long as the protocol
 * singleton address is configured.
 */
export async function fetchFactoryAddressEvm(chainId: EvmChainId): Promise<Address | null> {
  assertSupportedChain(chainId);
  // Fast path: env var already has it
  const fromEnv = getFactoryAddress(chainId);
  if (fromEnv) return fromEnv;
  // Fallback: read factory() from the protocol singleton so the address is
  // auto-discoverable even when VITE_EVM_*_FACTORY_ADDRESS isn't in .env.local
  // (e.g. dev server wasn't restarted after the env var was added).
  const protocol = getProtocolAddress(chainId);
  if (!protocol) return null;
  const res = await safeRead(() =>
    readContract(wagmiConfig, { address: protocol, abi: NaveProtocolAbi, functionName: 'factory', chainId }),
  );
  return res ? toAddress(res as string) : null;
}

/**
 * Read core DAO/treasury state for an EVM DAO. Returns a DaoRegistry-shaped
 * object so the chain-branched useDaoRegistry hook can consume one type. Returns
 * null when the chain isn't configured or the read fails.
 */
export async function fetchDaoRegistryEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<DaoRegistry | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;

  return safeRead(async () => {
    const t = { address: treasury, abi: NaveTreasuryAbi, chainId } as const;
    const [frozen, agentsEnabled, founder, proposalCount, govType, quorumBps, privacyMode, createdAt] =
      await Promise.all([
        readContract(wagmiConfig, { ...t, functionName: 'frozen' }) as Promise<boolean>,
        readContract(wagmiConfig, { ...t, functionName: 'agentsEnabled' }) as Promise<boolean>,
        readContract(wagmiConfig, { ...t, functionName: 'founder' }) as Promise<Address>,
        readContract(wagmiConfig, { ...t, functionName: 'proposalCount' }) as Promise<bigint>,
        readContract(wagmiConfig, { ...t, functionName: 'governanceType' }) as Promise<number>,
        readContract(wagmiConfig, { ...t, functionName: 'quorumBps' }) as Promise<number>,
        readContract(wagmiConfig, { ...t, functionName: 'privacyMode' }) as Promise<number>,
        readContract(wagmiConfig, { ...t, functionName: 'createdAt' }) as Promise<bigint>,
      ]);

    const registry: DaoRegistry = {
      founder: founder as string,
      daoId: 0,
      governanceType: (Number(govType) === 1 ? 'token' : 'wallet') as GovernanceType,
      frozen,
      proposalCount: Number(proposalCount),
      archivedProposalCount: 0,
      // EVM execution requests are keyed by proposalIndex (1:1 with passed
      // proposals); there is no contract-side request count, so this is left to
      // the indexer to enumerate.
      executionRequestCount: 0,
      privacyMode: Number(privacyMode),
      agentsEnabled,
      quorumBps: Number(quorumBps),
      createdAt: Number(createdAt),
      frozenAt: 0,
      bump: 0,
    };
    return registry;
  });
}

/** Read the treasury proposal count (0 when unconfigured/unavailable). */
export async function fetchProposalCountEvm(chainId: EvmChainId, daoAddress: string): Promise<number> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return 0;
  const res = await safeRead(() =>
    readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'proposalCount', chainId }),
  );
  return res == null ? 0 : Number(res as bigint);
}

/** Read treasury net asset value in micro-USD (1e6), or null. */
export async function fetchNavEvm(chainId: EvmChainId, daoAddress: string): Promise<number | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;
  const res = await safeRead(() =>
    readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'currentNav', chainId }),
  );
  return res == null ? null : Number(res as bigint);
}

/** Read treasury deployed capital in micro-USD (1e6), or null. */
export async function fetchDeployedCapitalEvm(chainId: EvmChainId, daoAddress: string): Promise<number | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;
  const res = await safeRead(() =>
    readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'deployedCapital', chainId }),
  );
  return res == null ? null : Number(res as bigint);
}

/** Read the EVM DAO token registry as a TokenRegistry-shaped singleton list. */
export async function fetchTokenRegistryEvm(
  chainId: EvmChainId,
  daoAddress: string,
  fallbackVotingToken?: string | null,
): Promise<TokenRegistry | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;

  const tokenFromTreasury = await safeRead(() =>
    readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'votingToken', chainId }),
  );
  const token = toAddress((tokenFromTreasury as string | null) ?? null) ?? toAddress(fallbackVotingToken);

  if (!token || token.toLowerCase() === ZERO_ADDRESS) {
    return { dao: daoAddress, tokens: [], tokenCount: 0, bump: 0 };
  }

  const [nameRaw, symbolRaw, decimalsRaw, supplyRaw, registeredRaw] = await Promise.all([
    safeRead(() => readContract(wagmiConfig, { address: token, abi: Erc20Abi, functionName: 'name', chainId })),
    safeRead(() => readContract(wagmiConfig, { address: token, abi: Erc20Abi, functionName: 'symbol', chainId })),
    safeRead(() => readContract(wagmiConfig, { address: token, abi: Erc20Abi, functionName: 'decimals', chainId })),
    safeRead(() => readContract(wagmiConfig, { address: token, abi: Erc20Abi, functionName: 'totalSupply', chainId })),
    safeRead(() => readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'isTokenRegistered', args: [token], chainId })),
  ]);

  const decimals = decimalsRaw == null ? 18 : Number(decimalsRaw as number);
  const supply = supplyRaw == null ? 0 : Number(formatUnits(supplyRaw as bigint, decimals));
  const isRegistered = registeredRaw == null ? false : Boolean(registeredRaw);

  return {
    dao: daoAddress,
    tokenCount: 1,
    bump: 0,
    tokens: [{
      mint: token,
      name: typeof nameRaw === 'string' ? nameRaw : 'Governance Token',
      symbol: typeof symbolRaw === 'string' ? symbolRaw : 'TOKEN',
      decimals,
      supply,
      isMinted: true,
      isNaveManaged: isRegistered,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      metadataAuthorityRevoked: false,
      canReceiveProposals: isRegistered,
      createdAt: 0,
    }],
  };
}

export async function fetchRegisteredAssetsEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<EvmRegisteredAsset[]> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return [];
  const assets = await safeRead(() =>
    readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'getRegisteredAssets', chainId }),
  );
  const addresses = (assets as Address[] | null) ?? [];
  const rows = await Promise.all(
    addresses.map(async (asset) => {
      const [infoRaw, balanceRaw] = await Promise.all([
        safeRead(() =>
          readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'assetInfo', args: [asset], chainId }),
        ),
        safeRead(() =>
          readContract(wagmiConfig, { address: asset, abi: Erc20Abi, functionName: 'balanceOf', args: [treasury], chainId }),
        ),
      ]);
      const info = infoRaw as unknown as EvmAssetInfoTuple | null;
      if (!info) return null;
      const pythFeed = info.pythFeedId ?? info[4] ?? '0x';
      return {
        address: asset,
        registered: Boolean(info.registered ?? info[0]),
        enabled: Boolean(info.enabled ?? info[1]),
        isStablecoin: Boolean(info.isStablecoin ?? info[2]),
        assetKind: Number(info.assetKind ?? info[3] ?? 2),
        pythFeedHex: pythFeed.replace(/^0x/, '').padStart(64, '0'),
        decimals: Number(info.decimals ?? info[5] ?? 18),
        idleBalance: (balanceRaw as bigint | null) ?? 0n,
      } satisfies EvmRegisteredAsset;
    }),
  );
  return rows.filter((row): row is EvmRegisteredAsset => row !== null);
}

export async function fetchTreasuryHasBalanceEvm(chainId: EvmChainId, daoAddress: string): Promise<boolean> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return false;
  const [nav, nativeBalance, registeredAssets] = await Promise.all([
    fetchNavEvm(chainId, daoAddress),
    chainId === 5042002
      ? Promise.resolve(null)
      : getBalance(wagmiConfig, { address: treasury, chainId }).catch(() => null),
    fetchRegisteredAssetsEvm(chainId, daoAddress),
  ]);
  if ((nav ?? 0) > 0) return true;
  if (nativeBalance && nativeBalance.value > 0n) return true;
  return registeredAssets.some((asset) => asset.idleBalance > 0n);
}

// ─── Enumerated reads (proposals + execution requests) ───────────────────────
// Proposals and execution requests are enumerable by index 0..(count-1) via the
// governor's getProposal / execution's getRequest getters. Each per-index read
// is wrapped in safeRead so a single missing slot can't sink the whole batch.

/** Raw NaveGovernor.Proposal tuple (struct output ⇒ wagmi returns a named object). */
interface EvmProposalTuple {
  proposalIndex: bigint;
  proposer: Address;
  proposalType: number;
  status: number;
  votingMint: Address;
  payloadHash: `0x${string}`;
  snapshotSupply: bigint;
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
  votingEnd: bigint;
  createdAt: bigint;
  finalizedAt: bigint;
}

/** Raw NaveExecution.ExecutionRequest tuple (struct output ⇒ named object).
 *  NOTE: the on-chain struct gained a `bool bootstrap` field immediately AFTER
 *  `status` (one-time founder zero-review-window first action), so it is decoded
 *  here in that exact position. */
interface EvmExecutionTuple {
  exists: boolean;
  kind: number;
  status: number;
  bootstrap: boolean;
  proposalIndex: bigint;
  adapter: Address;
  asset: Address;
  recipient: Address;
  amount: bigint;
  reviewEnd: bigint;
  reviewWindow: bigint;
  withdrawnAmount: bigint;
  txPayloadHash: `0x${string}`;
  executiveReasoningHash: `0x${string}`;
  financialReasoningHash: `0x${string}`;
  oversightReasoningHash: `0x${string}`;
  operationalHaltReasonHash: `0x${string}`;
  createdAt: bigint;
  updatedAt: bigint;
  executedAt: bigint;
}

interface EvmAssetInfoTuple {
  0: boolean;
  1: boolean;
  2: boolean;
  3: number;
  4: `0x${string}`;
  5: number;
  registered?: boolean;
  enabled?: boolean;
  isStablecoin?: boolean;
  assetKind?: number;
  pythFeedId?: `0x${string}`;
  decimals?: number;
}

interface EvmAgentDetailsTuple {
  0: Address;
  1: boolean;
  2: boolean;
  3: number;
  4: boolean;
  authority?: Address;
  active?: boolean;
  nullified?: boolean;
  status?: number;
  operational?: boolean;
}

export interface EvmRegisteredAsset {
  address: Address;
  registered: boolean;
  enabled: boolean;
  isStablecoin: boolean;
  assetKind: number;
  pythFeedHex: string;
  decimals: number;
  idleBalance: bigint;
}

/** Short 0x… label used where no human-readable name is stored on-chain. */
function shortHex(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Enumerate governor proposals 0..(count-1) and map each into the hook's
 * `ProposalInfo` shape. Title/description are NOT stored on-chain (only a
 * payloadHash), so title is synthesized and description left empty. Resolves to
 * [] when the chain isn't configured, the trio can't be resolved, or count<=0.
 */
/** Read a single proposal's authoritative on-chain payload hash. Used to verify
 *  a payload recovered from the off-chain payload index before it is submitted. */
export async function fetchEvmProposalPayloadHash(
  chainId: EvmChainId,
  daoAddress: string,
  index: number,
): Promise<`0x${string}` | null> {
  assertSupportedChain(chainId);
  if (!isEvmChainConfigured(chainId)) return null;
  const trio = await fetchDaoContracts(chainId, daoAddress);
  if (!trio) return null;
  const res = await safeRead(() =>
    readContract(wagmiConfig, {
      address: trio.governor,
      abi: NaveGovernorAbi,
      functionName: 'getProposal',
      args: [BigInt(index)],
      chainId,
    }),
  );
  if (res == null) return null;
  return (res as unknown as EvmProposalTuple).payloadHash;
}

export async function fetchProposalsEvm(
  chainId: EvmChainId,
  daoAddress: string,
  count: number,
): Promise<ProposalInfo[]> {
  assertSupportedChain(chainId);
  if (count <= 0) return [];
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return [];
  const trio = await fetchDaoContracts(chainId, daoAddress);
  if (!trio) return [];

  // DAO-wide quorum is stored on the treasury, not per-proposal on the governor.
  const quorumRaw = await safeRead(() =>
    readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'quorumBps', chainId }),
  );
  const quorumBps = quorumRaw == null ? 0 : Number(quorumRaw as number);

  const reads = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      safeRead(() =>
        readContract(wagmiConfig, {
          address: trio.governor,
          abi: NaveGovernorAbi,
          functionName: 'getProposal',
          args: [BigInt(index)],
          chainId,
        }),
      ).then((res) => ({ index, res })),
    ),
  );

  const proposals: ProposalInfo[] = [];
  for (const { index, res } of reads) {
    if (res == null) continue;
    const p = res as unknown as EvmProposalTuple;
    proposals.push({
      index,
      proposer: p.proposer,
      proposalType: Number(p.proposalType) as ProposalType,
      title: `Proposal #${index + 1}`,
      description: '',
      votesFor: Number(p.votesFor),
      votesAgainst: Number(p.votesAgainst),
      voterCount: 0,
      status: Number(p.status) as ProposalStatus,
      voteTokenMint: p.votingMint,
      snapshotSlot: 0,
      snapshotSupply: Number(p.snapshotSupply),
      quorumBps,
      threshold: 0,
      votingEnd: Number(p.votingEnd),
      createdAt: Number(p.createdAt),
      executedAt: Number(p.finalizedAt),
      payloadHash: p.payloadHash,
      archived: false,
      pda: `${daoAddress}#${index}`,
    });
  }
  return proposals;
}

/**
 * Enumerate execution requests 0..(count-1) and map each into the hook's
 * `ExecutionInfo` shape. Only requests with `exists === true` are returned.
 * Resolves to [] when the chain isn't configured / trio can't be resolved.
 */
export async function fetchExecutionRequestsEvm(
  chainId: EvmChainId,
  daoAddress: string,
  count: number,
): Promise<ExecutionInfo[]> {
  assertSupportedChain(chainId);
  if (count <= 0) return [];
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return [];
  const trio = await fetchDaoContracts(chainId, daoAddress);
  if (!trio) return [];

  const reads = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      safeRead(() =>
        readContract(wagmiConfig, {
          address: trio.execution,
          abi: NaveExecutionAbi,
          functionName: 'getRequest',
          args: [BigInt(index)],
          chainId,
        }),
      ).then((res) => ({ index, res })),
    ),
  );

  const now = Math.floor(Date.now() / 1000);
  const requests: ExecutionInfo[] = [];
  for (const { index, res } of reads) {
    if (res == null) continue;
    const r = res as unknown as EvmExecutionTuple;
    if (!r.exists) continue;
    const status = Number(r.status) as ExecutionStatus;
    const reviewWindowEndsAt = Number(r.reviewEnd);
    const updatedAt = Number(r.updatedAt);
    const zeroHash = /^0x0{64}$/i;
    const haltReasonHash = r.operationalHaltReasonHash ?? '0x';
    requests.push({
      proposal: `${index}`,
      protocolProgram: r.adapter,
      status,
      executiveApprovedAt: status >= ExecutionStatus.ExecutiveApproved ? updatedAt : 0,
      financialApprovedAt: status >= ExecutionStatus.FinancialApproved ? updatedAt : 0,
      oversightApprovedAt: status >= ExecutionStatus.OversightApproved ? updatedAt : 0,
      txPayloadHash: r.txPayloadHash,
      operationalHalt: status === ExecutionStatus.Halted,
      operationalHaltReason: status === ExecutionStatus.Halted && !zeroHash.test(haltReasonHash)
        ? `Reason hash ${haltReasonHash.slice(0, 10)}…${haltReasonHash.slice(-8)}`
        : '',
      operationalCleared: status !== ExecutionStatus.Halted && !zeroHash.test(haltReasonHash),
      reviewWindowEndsAt,
      executedAt: Number(r.executedAt),
      agentsBypassed: false,
      amount: Number(r.amount),
      protocolName: shortHex(r.adapter),
      timeRemainingSeconds: Math.max(0, reviewWindowEndsAt - now),
    });
  }
  return requests;
}

// ─── Guardian / constitution / agent reads ───────────────────────────────────
// Guardians are enumerable via getGuardians(). Labels still come from Supabase.

/** Read guardian threshold + wallets from the treasury (empty when unavailable). */
export async function fetchGuardianConfigEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<{
  threshold: number;
  walletCount: number;
  wallets: string[];
  bootstrapped: boolean;
}> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) {
    return { threshold: 0, walletCount: 0, wallets: [], bootstrapped: false };
  }
  const t = { address: treasury, abi: NaveTreasuryAbi, chainId } as const;
  const [guardiansRaw, bootstrappedRaw] = await Promise.all([
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'getGuardians' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'guardiansBootstrapped' })),
  ]);
  if (guardiansRaw == null) {
    return { threshold: 0, walletCount: 0, wallets: [], bootstrapped: false };
  }
  const [wallets, threshold] = guardiansRaw as [readonly `0x${string}`[], number | bigint];
  return {
    threshold: Number(threshold),
    walletCount: wallets.length,
    wallets: wallets.map((w) => w),
    bootstrapped: Boolean(bootstrappedRaw),
  };
}

/** Queued guardian-recovery view (`executableAt == 0` ⇒ nothing pending). */
export async function fetchGuardianRecoveryPendingEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<{ executableAt: bigint; pendingThreshold: number; pendingWalletCount: number } | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;
  const raw = await safeRead(() =>
    readContract(wagmiConfig, {
      address: treasury,
      abi: NaveTreasuryAbi,
      functionName: 'guardianRecoveryPending',
      chainId,
    }),
  );
  if (raw == null) return null;
  const [executableAt, pendingThreshold, pendingWalletCount] = raw as readonly [
    bigint,
    number | bigint,
    bigint | number,
  ];
  return {
    executableAt: BigInt(executableAt),
    pendingThreshold: Number(pendingThreshold),
    pendingWalletCount: Number(pendingWalletCount),
  };
}

/** Sister treasury registered for agent bridges on `destChainId` (zero ⇒ unset). */
export async function fetchLinkedTreasuryEvm(
  chainId: EvmChainId,
  daoAddress: string,
  destChainId: number | bigint,
): Promise<Address | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;
  const raw = await safeRead(() =>
    readContract(wagmiConfig, {
      address: treasury,
      abi: NaveTreasuryAbi,
      functionName: 'linkedTreasury',
      args: [BigInt(destChainId)],
      chainId,
    }),
  );
  if (raw == null) return null;
  const addr = raw as Address;
  return addr.toLowerCase() === ZERO_ADDRESS ? null : addr;
}

/**
 * Read the treasury policy params and map them into the hook's
 * `ConstitutionData` shape. Approved EVM adapters are enumerated from the
 * treasury getter, with configured adapter addresses as a fallback while a DAO
 * has not written an adapter constitution yet.
 */
export async function fetchConstitutionEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<ConstitutionData | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;
  const t = { address: treasury, abi: NaveTreasuryAbi, chainId } as const;

  const [policyRaw, reviewWindowRaw, rebalanceRaw, maxDeployedRaw, minStableRaw, confidenceRaw, adaptersRaw] = await Promise.all([
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'policyBps' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'reviewWindowSecs' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'rebalanceFrequencySecs' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'maxTotalDeployedBps' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'minStablecoinReserveBps' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'confidenceThreshold' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'getApprovedAdapters' })),
  ]);

  // policyBps() ⇒ [minStableReserveBps, maxTotalDeployedBps_, minLiquidityBps_]
  const policy = (policyRaw as readonly [number, number, number] | null) ?? null;
  const minLiquidityBps = policy ? Number(policy[2]) : 0;
  const maxTotalDeployedBps =
    maxDeployedRaw != null ? Number(maxDeployedRaw as number) : policy ? Number(policy[1]) : 0;
  const minStablecoinReserveBps =
    minStableRaw != null ? Number(minStableRaw as number) : policy ? Number(policy[0]) : 0;

  const adapterTuple = adaptersRaw as readonly [Address[], number[], boolean[], string[]] | null;
  const approvedProtocols: ProtocolEntry[] = adapterTuple && adapterTuple[0].length > 0
    ? adapterTuple[0].map((adapter, i) => ({
        protocolId: adapterTuple[3][i] || shortHex(adapter),
        programId: adapter,
        maxAllocationBps: Number(adapterTuple[1][i] ?? 0),
        approved: Boolean(adapterTuple[2][i]),
      }))
    : getConfiguredEvmAdapters(chainId).map((adapter) => ({
        protocolId: adapter.protocolId,
        programId: adapter.address,
        maxAllocationBps: 0,
        approved: false,
      }));
  const maxSingleAllocationBps = approvedProtocols.reduce(
    (max, protocol) => Math.max(max, protocol.maxAllocationBps),
    0,
  );
  return {
    riskPreset: 'custom',
    maxSingleAllocationBps,
    maxTotalDeployedBps,
    rebalanceFrequencySeconds: rebalanceRaw == null ? 0 : Number(rebalanceRaw as bigint),
    approvedProtocols,
    protocolCount: approvedProtocols.length,
    // minReservesBps stays the historical alias. minLiquidityBps is only the
    // on-chain liquidity floor, with no stablecoin-reserve substitution.
    minReservesBps: minLiquidityBps || minStablecoinReserveBps,
    minLiquidityBps: policy ? minLiquidityBps : undefined,
    minStablecoinReserveBps,
    reviewWindowSecs: reviewWindowRaw == null ? 0 : Number(reviewWindowRaw as bigint),
    confidenceThreshold: confidenceRaw == null ? 0 : Number(confidenceRaw as number),
  };
}

/**
 * A queued review-window reduction (`NaveTreasury.pendingReviewWindow()`).
 * Reductions are delayed until the current window has elapsed; `null` when
 * nothing is pending (secs == 0) or the getter is unavailable.
 */
export interface PendingReviewWindowEvm {
  secs: number;
  /** Unix seconds when the pending value takes effect. */
  effectiveAt: number;
}

export async function fetchPendingReviewWindowEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<PendingReviewWindowEvm | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;
  const raw = await safeRead(() =>
    readContract(wagmiConfig, { address: treasury, abi: NaveTreasuryAbi, functionName: 'pendingReviewWindow', chainId }),
  );
  const tuple = raw as readonly [bigint, bigint] | null;
  if (!tuple) return null;
  const secs = Number(tuple[0]);
  if (secs <= 0) return null;
  return { secs, effectiveAt: Number(tuple[1]) };
}

/** Mapped EVM agent set: enabled flag, review window, and the 4 agent slots. */
export interface EvmAgentSet {
  agentsEnabled: boolean;
  reviewWindowSeconds: number;
  agents: AgentStatusInfo[];
}

const EVM_AGENT_ROLES: AgentStatusInfo['role'][] = ['executive', 'financial', 'oversight', 'operational'];

/**
 * Read the agents-enabled flag, review window and the four agent slot
 * authorities/statuses (roles 0..3) from the treasury. Returns null when the
 * chain/treasury can't be resolved.
 */
export async function fetchAgentSetEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<EvmAgentSet | null> {
  assertSupportedChain(chainId);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !isEvmChainConfigured(chainId)) return null;
  const t = { address: treasury, abi: NaveTreasuryAbi, chainId } as const;

  const [enabledRaw, reviewWindowRaw, ...agentReads] = await Promise.all([
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'agentsEnabled' })),
    safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'reviewWindowSecs' })),
    ...EVM_AGENT_ROLES.map((_, role) =>
      safeRead(() => readContract(wagmiConfig, { ...t, functionName: 'agentDetails', args: [role] })),
    ),
  ]);

  const agents: AgentStatusInfo[] = agentReads.map((raw, i) => {
    const tuple = (raw as unknown as EvmAgentDetailsTuple | null) ?? null;
    const authority = tuple ? ((tuple.authority ?? tuple[0]) as string) : '';
    const active = tuple ? Boolean(tuple.active ?? tuple[1]) : false;
    const nullified = tuple ? Boolean(tuple.nullified ?? tuple[2]) : false;
    const status = tuple ? Number(tuple.status ?? tuple[3]) as AgentStatus : AgentStatus.Revoked;
    const operational = tuple ? Boolean(tuple.operational ?? tuple[4]) : false;
    return {
      role: EVM_AGENT_ROLES[i],
      pubkey: authority,
      active: operational,
      nullified,
      canSign: operational,
      status: active && !nullified ? status : AgentStatus.Revoked,
      actionsCount: 0,
      lastActionAt: 0,
    };
  });

  return {
    agentsEnabled: enabledRaw == null ? false : Boolean(enabledRaw),
    reviewWindowSeconds: reviewWindowRaw == null ? 0 : Number(reviewWindowRaw as bigint),
    agents,
  };
}

// ─── NaveDaoStake moonlight + strategy positions ─────────────────────────────

export interface EvmMoonlightStake {
  founder: Address;
  token: Address;
  amount: bigint;
  released: boolean;
  priceUsdMicro: bigint;
  moonlightStatus: number;
  recipient: Address;
  initiatedBy: Address;
  requestProposal: number;
  distributionProposal: number;
}

/** Read per-DAO moonlight/stake state from NaveDaoStake (null when unwired). */
export async function fetchMoonlightStakeEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<EvmMoonlightStake | null> {
  assertSupportedChain(chainId);
  const stakeCfg = await fetchNaveStakeConfigEvm(chainId);
  const module = stakeCfg?.module;
  const treasury = treasuryAddress(daoAddress);
  if (!module || !treasury || !stakeCfg?.active) return null;
  const raw = await safeRead(() =>
    readContract(wagmiConfig, {
      address: module,
      abi: NaveDaoStakeAbi,
      functionName: 'stakes',
      args: [treasury],
      chainId,
    }),
  );
  if (!raw) return null;
  // stakes() returns a tuple matching StakeRecord.
  const t = raw as readonly [
    Address, Address, bigint, boolean, bigint, number, Address, Address, bigint, bigint,
  ];
  return {
    founder: t[0],
    token: t[1],
    amount: t[2],
    released: t[3],
    priceUsdMicro: t[4],
    moonlightStatus: Number(t[5]),
    recipient: t[6],
    initiatedBy: t[7],
    requestProposal: Number(t[8]),
    distributionProposal: Number(t[9]),
  };
}

export interface EvmStrategyPosition {
  adapter: Address;
  asset: Address;
  depositedAmount: bigint;
  currentValue: bigint;
}

/** Live strategy positions for each approved adapter on an EVM treasury. */
export async function fetchStrategyPositionsEvm(
  chainId: EvmChainId,
  daoAddress: string,
): Promise<EvmStrategyPosition[]> {
  assertSupportedChain(chainId);
  const constitution = await fetchConstitutionEvm(chainId, daoAddress);
  const treasury = treasuryAddress(daoAddress);
  if (!treasury || !constitution) return [];
  const adapters = constitution.approvedProtocols
    .filter((p) => p.approved && p.programId)
    .map((p) => p.programId as Address);
  const out: EvmStrategyPosition[] = [];
  for (const adapter of adapters) {
    const raw = await safeRead(() =>
      readContract(wagmiConfig, {
        address: treasury,
        abi: NaveTreasuryAbi,
        functionName: 'position',
        args: [adapter],
        chainId,
      }),
    );
    if (!raw) continue;
    const tuple = raw as readonly [Address, bigint, bigint];
    const currentValue = tuple[2] ?? 0n;
    if (currentValue === 0n && (tuple[1] ?? 0n) === 0n) continue;
    out.push({
      adapter,
      asset: tuple[0],
      depositedAmount: tuple[1],
      currentValue,
    });
  }
  return out;
}
