// ─── EVM write layer (Ethereum + Base only) ──────────────────────────────────
// Mirrors src/lib/transactionBuilders.ts for the EVM path. Writers assemble a
// chain-tagged `EvmTxRequest` descriptor consumed by useSendTransaction's EVM
// branch (which calls wagmi's writeContract). A null `request` means "nothing to
// send" — the dispatcher treats it like the Solana null-instruction path
// (mock/error), so the UX behaves identically across chains.
//
// Function names, argument shapes, and the CreateDaoParams / CreateProposalParams
// tuples below are reconciled against the REAL Foundry ABIs (synced via
// `npm run sync-abi`). Keep them in lockstep with src/abi/*.json.

import type { Abi, Address } from 'viem';
import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import { NaveDAOFactoryAbi, NaveTreasuryAbi, NaveGovernorAbi, NaveExecutionAbi, NaveDaoStakeAbi, Erc20Abi } from './contracts';
import { getFactoryAddress, toAddress, assertSupportedChain } from './addresses';
import { isEvmTestnet, type EvmChainId } from '../chain/types';
import { isConfiguredEvmAdapterAddress } from '../programConfig';

/** A single EVM contract write the dispatcher can submit via wagmi. */
export interface EvmTxRequest {
  kind: 'evm';
  chainId: EvmChainId;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Native value (wei) to attach, e.g. the DAO formation fee. */
  value?: bigint;
}

/** Build result: a request to submit, or a null request + error (mirrors Solana TransactionBuildResult). */
export interface EvmBuildResult {
  request: EvmTxRequest | null;
  error?: string;
}

/** Type guard distinguishing EVM requests from Solana TransactionBuildResults at dispatch time. */
export function isEvmTxRequest(value: unknown): value is EvmTxRequest {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'evm';
}

function notConfigured(what: string): EvmBuildResult {
  return { request: null, error: `${what} is not configured for this EVM chain yet.` };
}

const WETH_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

/**
 * Resolve the slippage floor (`minOut`) supplied to the permissionless
 * `NaveExecution.execute` / `executeDirect` / `withdrawFromStrategy` calls
 * (C-3/C-4). `minOut` is caller-supplied at the contract, so the keeper/agent
 * path MUST quote it off-chain — a hardcoded mainnet 0 is sandwichable and the
 * slippage-bearing adapters (Balancer/Curve) revert on `minOut == 0` on mainnet.
 *
 *   - testnet (Sepolia / Base Sepolia): `0` is acceptable (no liquidity to MEV),
 *     so an absent/zero quote relaxes to `0n`.
 *   - mainnet (Ethereum / Base): a POSITIVE off-chain quote is REQUIRED; passing
 *     `0`/undefined throws so we never submit an unbounded swap.
 *
 * Lending adapters (Aave/Compound) ignore `minOut`, but threading it uniformly
 * keeps a single safe code path for every adapter kind.
 */
export function resolveEvmMinOut(chainId: EvmChainId, quotedMinOut?: bigint): bigint {
  assertSupportedChain(chainId);
  if (isEvmTestnet(chainId)) return quotedMinOut !== undefined && quotedMinOut > 0n ? quotedMinOut : 0n;
  if (quotedMinOut === undefined || quotedMinOut <= 0n) {
    throw new Error(
      'A positive off-chain-quoted minOut is required on mainnet (Ethereum/Base) to bound slippage; refusing to submit a strategy execution with minOut = 0.',
    );
  }
  return quotedMinOut;
}

// ─── DAO factory ──────────────────────────────────────────────────────────────

/**
 * Mirror of `NaveDAOFactory.CreateDaoParams`. Field set + order match the
 * Solidity struct exactly (viem maps by component name, but keeping the order
 * identical avoids confusion). NOTE there is no `vaultAsset` or `feeRecipient`
 * here — the treasury registers assets after creation, and fee routing uses
 * `protocolRevenueWallet`.
 */
export interface EvmCreateDaoParams {
  name: string;
  /** 0 = Public, 1 = Restricted, 2 = Private. */
  privacyMode: number;
  guardianWallets: Address[];
  guardianThreshold: number;
  /** Exactly 4 (executive, financial, oversight, operational). */
  agentAuthorities: [Address, Address, Address, Address];
  managementFeeBps: number;
  performanceFeeBps: number;
  frozenManagementFeeBps: number;
  frozenPerformanceFeeBps: number;
  protocolRevenueWallet: Address;
  quorumBps: number;
  /** 0 = wallet governance, 1 = token governance. */
  governanceType: number;
}

/** Build the factory `createDao` call (payable, value = formation fee in wei).
 *  Pass `factoryAddress` explicitly when the address was resolved async (e.g.
 *  fetched from NaveProtocol.factory()) to avoid env-var lookup failures. */
export function buildCreateDaoEvm(
  chainId: EvmChainId,
  params: EvmCreateDaoParams,
  formationFeeWei: bigint,
  factoryAddress?: Address,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const factory = factoryAddress ?? getFactoryAddress(chainId);
  if (!factory) return notConfigured('NaveDAOFactory');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: factory,
      abi: NaveDAOFactoryAbi,
      functionName: 'createDao',
      args: [params],
      value: formationFeeWei,
    },
  };
}

// ─── Treasury ──────────────────────────────────────────────────────────────────

/** ERC-20 approve so the treasury can pull `amount` of `asset` on deposit. */
export function buildApproveErc20Evm(
  chainId: EvmChainId,
  token: string,
  spender: string,
  amount: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const tokenAddr = toAddress(token);
  const spenderAddr = toAddress(spender);
  if (!tokenAddr || !spenderAddr) return notConfigured('ERC-20 token/spender');
  return {
    request: { kind: 'evm', chainId, address: tokenAddr, abi: Erc20Abi, functionName: 'approve', args: [spenderAddr, amount] },
  };
}

/** Register a treasury ERC-20 asset (founder-gated). */
export function buildRegisterAssetEvm(
  chainId: EvmChainId,
  treasury: string,
  asset: string,
  pythFeedId: `0x${string}`,
  isStablecoin: boolean,
  assetKind: number,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const assetAddr = toAddress(asset);
  if (!treasuryAddr || !assetAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: treasuryAddr,
      abi: NaveTreasuryAbi,
      functionName: 'registerAsset',
      args: [assetAddr, pythFeedId, isStablecoin, assetKind],
    },
  };
}

/** Wrap native ETH into canonical WETH before approving/depositing WETH. */
export function buildWrapEthEvm(chainId: EvmChainId, weth: string, amount: bigint): EvmBuildResult {
  assertSupportedChain(chainId);
  const wethAddr = toAddress(weth);
  if (!wethAddr) return notConfigured('WETH');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: wethAddr,
      abi: WETH_ABI,
      functionName: 'deposit',
      args: [],
      value: amount,
    },
  };
}

/**
 * Deposit a registered ERC-20 asset into the treasury. `NaveTreasury.deposit`
 * pulls via `transferFrom`, so it is NOT payable — the caller must
 * {buildApproveErc20Evm} first. (Native ETH is not a deposit asset; wrap to
 * WETH and register it if ETH exposure is required.)
 */
export function buildDepositEvm(
  chainId: EvmChainId,
  treasury: string,
  asset: string,
  amount: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const assetAddr = toAddress(asset);
  if (!treasuryAddr || !assetAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: treasuryAddr,
      abi: NaveTreasuryAbi,
      functionName: 'deposit',
      args: [assetAddr, amount],
    },
  };
}

/** Recompute NAV across all registered assets (permissionless, gated by global pause). */
export function buildRevalueTreasuryEvm(chainId: EvmChainId, treasury: string): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: { kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'revalueTreasury', args: [] },
  };
}

/** Collect the time-weighted management fee in-kind for one registered asset. */
export function buildCollectManagementFeeEvm(
  chainId: EvmChainId,
  treasury: string,
  asset: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const assetAddr = toAddress(asset);
  if (!treasuryAddr || !assetAddr) return notConfigured('NaveTreasury');
  return {
    request: { kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'collectManagementFee', args: [assetAddr] },
  };
}

// ─── Governor ───────────────────────────────────────────────────────────────────

/**
 * Mirror of `NaveGovernor.CreateProposalParams`. The governor stores
 * `keccak256(payload)` as the binding payload hash, so callers pass the RAW
 * payload bytes (0x-prefixed) — NOT the hash. `votingMint` is the governance
 * token for token-weighted DAOs (zero address for wallet governance).
 */
export interface EvmCreateProposalParams {
  title: string;
  description: string;
  /** Raw ABI-encoded payload bytes (0x-prefixed). The governor hashes this. */
  payload: `0x${string}`;
  proposalType: number;
  votingPeriodSeconds: number | bigint;
  votingMint: Address;
}

export function buildCreateProposalEvm(
  chainId: EvmChainId,
  governor: string,
  params: EvmCreateProposalParams,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  if (!governorAddr) return notConfigured('NaveGovernor');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: governorAddr,
      abi: NaveGovernorAbi,
      functionName: 'createProposal',
      args: [
        {
          ...params,
          votingPeriodSeconds: BigInt(params.votingPeriodSeconds),
        },
      ],
    },
  };
}

/** ABI-encoded payload for EVM `ProposalType.Transfer` (matches `PayloadHash.transferHash` preimage). */
export function encodeEvmTransferProposalPayload(
  asset: Address,
  recipient: Address,
  amount: bigint,
): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: 'address', name: 'asset' },
      { type: 'address', name: 'recipient' },
      { type: 'uint256', name: 'amount' },
    ],
    [asset, recipient, amount],
  );
}

/** ABI-encoded payload for EVM NFT transfer (matches `PayloadHash.nftTransferHash` preimage). */
export function encodeEvmNftTransferProposalPayload(
  collection: Address,
  recipient: Address,
  tokenId: bigint,
): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: 'string', name: 'domain' },
      { type: 'address', name: 'collection' },
      { type: 'address', name: 'recipient' },
      { type: 'uint256', name: 'tokenId' },
    ],
    ['NFT_TRANSFER', collection, recipient, tokenId],
  );
}

/** Direct post-vote treasury NFT transfer (ERC-721). */
export function buildExecuteNftTransferProposalEvm(
  chainId: EvmChainId,
  governor: string,
  proposalIndex: number | bigint,
  collection: string,
  recipient: string,
  tokenId: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  const collectionAddr = toAddress(collection);
  const recipientAddr = toAddress(recipient);
  if (!governorAddr || !collectionAddr || !recipientAddr) return notConfigured('NaveGovernor');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: governorAddr,
      abi: NaveGovernorAbi,
      functionName: 'executeNftTransferProposal',
      args: [BigInt(proposalIndex), collectionAddr, recipientAddr, tokenId],
    },
  };
}

/** Decode EVM NFT transfer proposal payload. */
export function decodeEvmNftTransferRequestPayload(bytes: Uint8Array | number[] | string): {
  collection: `0x${string}`;
  recipient: `0x${string}`;
  tokenId: bigint;
} {
  const hex = typeof bytes === 'string' ? bytes : `0x${Buffer.from(bytes).toString('hex')}`;
  const [domain, collection, recipient, tokenId] = decodeAbiParameters(
    [
      { type: 'string', name: 'domain' },
      { type: 'address', name: 'collection' },
      { type: 'address', name: 'recipient' },
      { type: 'uint256', name: 'tokenId' },
    ],
    hex as `0x${string}`,
  );
  if (domain !== 'NFT_TRANSFER') {
    throw new Error('Not an NFT transfer payload');
  }
  return { collection: collection as `0x${string}`, recipient: recipient as `0x${string}`, tokenId };
}

/** Direct post-vote treasury transfer (no `NaveExecution` pipeline). */
export function buildExecuteTransferProposalEvm(
  chainId: EvmChainId,
  governor: string,
  proposalIndex: number | bigint,
  asset: string,
  recipient: string,
  amount: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  const assetAddr = toAddress(asset);
  const recipientAddr = toAddress(recipient);
  if (!governorAddr || !assetAddr || !recipientAddr) return notConfigured('NaveGovernor');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: governorAddr,
      abi: NaveGovernorAbi,
      functionName: 'executeTransferProposal',
      args: [BigInt(proposalIndex), assetAddr, recipientAddr, amount],
    },
  };
}

/** Wallet method discriminant matching `NaveEnums.VoteMethod` (0 = Wallet, 1 = Escrow). */
export const EVM_VOTE_METHOD = { wallet: 0, escrow: 1 } as const;

/** Wallet-governance vote (1 guardian = 1 vote). */
export function buildCastVoteWalletEvm(
  chainId: EvmChainId,
  governor: string,
  index: number | bigint,
  choice: number,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  if (!governorAddr) return notConfigured('NaveGovernor');
  return {
    request: { kind: 'evm', chainId, address: governorAddr, abi: NaveGovernorAbi, functionName: 'castVoteWallet', args: [BigInt(index), choice] },
  };
}

/** Token-governance vote: escrow `amount` of the voting mint and record the vote. */
export function buildLockTokensAndVoteEvm(
  chainId: EvmChainId,
  governor: string,
  index: number | bigint,
  amount: bigint,
  choice: number,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  if (!governorAddr) return notConfigured('NaveGovernor');
  return {
    request: { kind: 'evm', chainId, address: governorAddr, abi: NaveGovernorAbi, functionName: 'lockTokensAndVote', args: [BigInt(index), amount, choice] },
  };
}

/**
 * Unified vote builder used by chain-branched hooks. Dispatches to the wallet
 * or escrow governor entrypoint based on `method` (matches Solana's
 * vote/cast-by-method dispatch). `weight` is the escrow amount for token votes
 * and ignored for wallet votes.
 */
export function buildCastVoteEvm(
  chainId: EvmChainId,
  governor: string,
  index: number,
  choice: number,
  method: number,
  weight: bigint,
): EvmBuildResult {
  return method === EVM_VOTE_METHOD.escrow
    ? buildLockTokensAndVoteEvm(chainId, governor, index, weight, choice)
    : buildCastVoteWalletEvm(chainId, governor, index, choice);
}

/** Release escrowed voting tokens after a token-governance proposal concludes. */
export function buildReleaseVoteEscrowEvm(chainId: EvmChainId, governor: string, index: number | bigint): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  if (!governorAddr) return notConfigured('NaveGovernor');
  return {
    request: { kind: 'evm', chainId, address: governorAddr, abi: NaveGovernorAbi, functionName: 'releaseVoteEscrow', args: [BigInt(index)] },
  };
}

export function buildFinalizeProposalEvm(chainId: EvmChainId, governor: string, index: number | bigint): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  if (!governorAddr) return notConfigured('NaveGovernor');
  return {
    request: { kind: 'evm', chainId, address: governorAddr, abi: NaveGovernorAbi, functionName: 'finalizeProposal', args: [BigInt(index)] },
  };
}

export function buildCancelProposalEvm(chainId: EvmChainId, governor: string, index: number | bigint): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  if (!governorAddr) return notConfigured('NaveGovernor');
  return {
    request: { kind: 'evm', chainId, address: governorAddr, abi: NaveGovernorAbi, functionName: 'cancelProposal', args: [BigInt(index)] },
  };
}

// ─── Execution ────────────────────────────────────────────────────────────────

/** Bind a passed Strategy proposal to an (adapter, amount, asset) execution request. */
export function buildCreateStrategyRequestEvm(
  chainId: EvmChainId,
  execution: string,
  proposalIndex: number | bigint,
  amount: bigint,
  adapter: string,
  asset: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const executionAddr = toAddress(execution);
  const adapterAddr = toAddress(adapter);
  const assetAddr = toAddress(asset);
  if (!executionAddr || !adapterAddr || !assetAddr) return notConfigured('NaveExecution');
  if (!isConfiguredEvmAdapterAddress(chainId, adapterAddr)) {
    return {
      request: null,
      error: `Unsupported or unconfigured EVM adapter on chain ${chainId}: ${adapterAddr}. Configure a supported Nave adapter address before creating a strategy execution request.`,
    };
  }
  return {
    request: {
      kind: 'evm',
      chainId,
      address: executionAddr,
      abi: NaveExecutionAbi,
      functionName: 'createStrategyRequest',
      args: [BigInt(proposalIndex), amount, adapterAddr, assetAddr],
    },
  };
}

/** Bind a passed Transfer (type 8) proposal to an (asset, recipient, amount) request. */
export function buildCreateTransferRequestEvm(
  chainId: EvmChainId,
  execution: string,
  proposalIndex: number | bigint,
  asset: string,
  recipient: string,
  amount: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const executionAddr = toAddress(execution);
  const assetAddr = toAddress(asset);
  const recipientAddr = toAddress(recipient);
  if (!executionAddr || !assetAddr || !recipientAddr) return notConfigured('NaveExecution');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: executionAddr,
      abi: NaveExecutionAbi,
      functionName: 'createTransferRequest',
      args: [BigInt(proposalIndex), assetAddr, recipientAddr, amount],
    },
  };
}

/**
 * One-time founder bootstrap: bind a passed Strategy proposal to an
 * (adapter, amount, asset) request that snapshots a ZERO review window for
 * immediate execution. `NaveExecution.createStrategyRequestBootstrap` is
 * founder-gated and consumes the contract's one-time `bootstrapUsed` latch. Used
 * by the unified creation flow's first auto-activation action (SOL/native →
 * approved adapter); every later request uses the normal review window.
 */
export function buildCreateStrategyRequestBootstrapEvm(
  chainId: EvmChainId,
  execution: string,
  proposalIndex: number | bigint,
  amount: bigint,
  adapter: string,
  asset: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const executionAddr = toAddress(execution);
  const adapterAddr = toAddress(adapter);
  const assetAddr = toAddress(asset);
  if (!executionAddr || !adapterAddr || !assetAddr) return notConfigured('NaveExecution');
  if (!isConfiguredEvmAdapterAddress(chainId, adapterAddr)) {
    return {
      request: null,
      error: `Unsupported or unconfigured EVM adapter on chain ${chainId}: ${adapterAddr}. Configure a supported Nave adapter address before creating a bootstrap strategy request.`,
    };
  }
  return {
    request: {
      kind: 'evm',
      chainId,
      address: executionAddr,
      abi: NaveExecutionAbi,
      functionName: 'createStrategyRequestBootstrap',
      args: [BigInt(proposalIndex), amount, adapterAddr, assetAddr],
    },
  };
}

/**
 * One-time founder bootstrap variant of {buildCreateTransferRequestEvm}: bind a
 * passed Transfer proposal to a zero-review-window request. Founder-gated and
 * consumes the same one-time `bootstrapUsed` latch as the strategy bootstrap.
 */
export function buildCreateTransferRequestBootstrapEvm(
  chainId: EvmChainId,
  execution: string,
  proposalIndex: number | bigint,
  asset: string,
  recipient: string,
  amount: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const executionAddr = toAddress(execution);
  const assetAddr = toAddress(asset);
  const recipientAddr = toAddress(recipient);
  if (!executionAddr || !assetAddr || !recipientAddr) return notConfigured('NaveExecution');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: executionAddr,
      abi: NaveExecutionAbi,
      functionName: 'createTransferRequestBootstrap',
      args: [BigInt(proposalIndex), assetAddr, recipientAddr, amount],
    },
  };
}

/**
 * Permissionless post-review execution of a request keyed by its proposal index.
 * `minOut` is the caller-supplied slippage floor threaded to the adapter join
 * (C-3/C-4). Quote it off-chain and pass it via {resolveEvmMinOut} — never a
 * hardcoded mainnet 0 (ignored for Transfer requests, enforced for Balancer/Curve).
 */
export function buildExecuteEvm(
  chainId: EvmChainId,
  execution: string,
  index: number | bigint,
  minOut: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const executionAddr = toAddress(execution);
  if (!executionAddr) return notConfigured('NaveExecution');
  return {
    request: { kind: 'evm', chainId, address: executionAddr, abi: NaveExecutionAbi, functionName: 'execute', args: [BigInt(index), minOut] },
  };
}

/**
 * Break-glass execution (Executive-gated; allowed only when frozen/agents off).
 * `minOut` threads the deposit slippage floor exactly as {buildExecuteEvm}.
 */
export function buildExecuteDirectEvm(
  chainId: EvmChainId,
  execution: string,
  index: number | bigint,
  minOut: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const executionAddr = toAddress(execution);
  if (!executionAddr) return notConfigured('NaveExecution');
  return {
    request: { kind: 'evm', chainId, address: executionAddr, abi: NaveExecutionAbi, functionName: 'executeDirect', args: [BigInt(index), minOut] },
  };
}

/**
 * Unwind `amount` base units from a previously executed Strategy request
 * (Executive-gated). `minOut` is the caller-supplied minimum underlying to
 * receive from the adapter exit — quote it off-chain via {resolveEvmMinOut}.
 */
export function buildWithdrawFromStrategyEvm(
  chainId: EvmChainId,
  execution: string,
  index: number | bigint,
  amount: bigint,
  minOut: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const executionAddr = toAddress(execution);
  if (!executionAddr) return notConfigured('NaveExecution');
  return {
    request: { kind: 'evm', chainId, address: executionAddr, abi: NaveExecutionAbi, functionName: 'withdrawFromStrategy', args: [BigInt(index), amount, minOut] },
  };
}

// ─── Treasury: founder-gated config (parity wiring) ──────────────────────────
// These map the Solana founder-gated config instructions to their EVM treasury
// functions so the corresponding app pages are USABLE on EVM (not just compiled).
// They are direct `msg.sender == founder` calls, submitted from the founder's
// connected wallet via sendEvm — no signer-service relay needed.

/** `update_guardian_config` → NaveTreasury.updateGuardianConfig(wallets, threshold).
 *  Founder one-shot bootstrap only; after guardiansBootstrapped use Permission proposals. */
export function buildUpdateGuardianConfigEvm(
  chainId: EvmChainId,
  treasury: string,
  wallets: string[],
  threshold: number,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  const walletAddrs: Address[] = [];
  for (const w of wallets) {
    const a = toAddress(w);
    if (!a) return { request: null, error: `Invalid guardian wallet address: ${w}` };
    walletAddrs.push(a);
  }
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'updateGuardianConfig', args: [walletAddrs, threshold],
    },
  };
}

/** Passed Permission proposal → NaveGovernor.executePermissionProposal. */
export function buildExecutePermissionProposalEvm(
  chainId: EvmChainId,
  governor: string,
  proposalIndex: bigint | number,
  wallets: string[],
  threshold: number,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  if (!governorAddr) return notConfigured('NaveGovernor');
  const walletAddrs: Address[] = [];
  for (const w of wallets) {
    const a = toAddress(w);
    if (!a) return { request: null, error: `Invalid guardian wallet address: ${w}` };
    walletAddrs.push(a);
  }
  return {
    request: {
      kind: 'evm',
      chainId,
      address: governorAddr,
      abi: NaveGovernorAbi,
      functionName: 'executePermissionProposal',
      args: [BigInt(proposalIndex), walletAddrs, threshold],
    },
  };
}

/** Founder registers sister treasury for agent bridges. */
export function buildSetLinkedTreasuryEvm(
  chainId: EvmChainId,
  treasury: string,
  destChainId: number | bigint,
  destTreasury: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const dest = toAddress(destTreasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  if (!dest) return { request: null, error: `Invalid destination treasury: ${destTreasury}` };
  return {
    request: {
      kind: 'evm',
      chainId,
      address: treasuryAddr,
      abi: NaveTreasuryAbi,
      functionName: 'setLinkedTreasury',
      args: [BigInt(destChainId), dest],
    },
  };
}

/** EVM-H1: queue guardian recovery while frozen. */
export function buildQueueGuardianRecoveryEvm(
  chainId: EvmChainId,
  treasury: string,
  wallets: string[],
  threshold: number,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  const walletAddrs: Address[] = [];
  for (const w of wallets) {
    const a = toAddress(w);
    if (!a) return { request: null, error: `Invalid guardian wallet address: ${w}` };
    walletAddrs.push(a);
  }
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'queueGuardianRecovery', args: [walletAddrs, threshold],
    },
  };
}

export function buildExecuteGuardianRecoveryEvm(
  chainId: EvmChainId,
  treasury: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'executeGuardianRecovery', args: [],
    },
  };
}

export function buildCancelGuardianRecoveryEvm(
  chainId: EvmChainId,
  treasury: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'cancelGuardianRecovery', args: [],
    },
  };
}

/** Guardian M-of-N veto of a queued recovery (CANCEL_RECOVERY). */
export function buildGuardianVetoRecoveryEvm(
  chainId: EvmChainId,
  treasury: string,
  nonce: number | bigint,
  deadline: number | bigint = defaultGuardianActionDeadline(),
  signatures: readonly `0x${string}`[] = [],
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: treasuryAddr,
      abi: NaveTreasuryAbi,
      functionName: 'guardianVetoRecovery',
      args: [BigInt(nonce), BigInt(deadline), signatures],
    },
  };
}

/**
 * Permission proposal payload: `abi.encode(wallets, threshold)` — must match
 * `PayloadHash.permissionHash` / `executePermissionProposal` binding.
 * (`applyGuardianConfigFromGovernor` is reached only via governor execute.)
 */
export function encodeEvmPermissionPayload(
  wallets: readonly string[],
  threshold: number,
): `0x${string}` {
  const addrs: Address[] = [];
  for (const w of wallets) {
    const a = toAddress(w);
    if (!a) throw new Error(`Invalid guardian wallet address: ${w}`);
    addrs.push(a);
  }
  return encodeAbiParameters(
    [{ type: 'address[]' }, { type: 'uint8' }],
    [addrs, threshold],
  );
}

/** Decode Permission proposal payload produced by {encodeEvmPermissionPayload}. */
export function decodeEvmPermissionPayload(bytes: Uint8Array | number[] | string): {
  wallets: `0x${string}`[];
  threshold: number;
} {
  const hex = typeof bytes === 'string' ? bytes : `0x${Buffer.from(bytes).toString('hex')}`;
  const [wallets, threshold] = decodeAbiParameters(
    [{ type: 'address[]' }, { type: 'uint8' }],
    hex as `0x${string}`,
  );
  return {
    wallets: [...wallets] as `0x${string}`[],
    threshold: Number(threshold),
  };
}

/** Create Bridge execution request (Strategy proposal with bridgeHash payload). */
export function buildCreateBridgeRequestEvm(
  chainId: EvmChainId,
  execution: string,
  proposalIndex: bigint | number,
  amount: bigint,
  adapter: string,
  asset: string,
  destChainId: number | bigint,
  destTreasury: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const execAddr = toAddress(execution);
  const adapterAddr = toAddress(adapter);
  const assetAddr = toAddress(asset);
  const dest = toAddress(destTreasury);
  if (!execAddr) return notConfigured('NaveExecution');
  if (!adapterAddr || !assetAddr || !dest) {
    return { request: null, error: 'Invalid adapter, asset, or destination treasury address' };
  }
  return {
    request: {
      kind: 'evm',
      chainId,
      address: execAddr,
      abi: NaveExecutionAbi,
      functionName: 'createBridgeRequest',
      args: [
        BigInt(proposalIndex),
        amount,
        adapterAddr,
        assetAddr,
        BigInt(destChainId),
        dest,
      ],
    },
  };
}

/** `set_review_window` → NaveTreasury.setReviewWindow(int64 secs). */
export function buildSetReviewWindowEvm(
  chainId: EvmChainId,
  treasury: string,
  secs: number | bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'setReviewWindow', args: [BigInt(secs)],
    },
  };
}

/** `set_policy_parameters` → NaveTreasury.setPolicyParameters(reserve, deployed, liquidity, rebalanceFreq). */
export function buildSetPolicyParametersEvm(
  chainId: EvmChainId,
  treasury: string,
  reserveBps: number,
  deployedBps: number,
  liquidityBps: number,
  rebalanceFreqSecs: number | bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'setPolicyParameters',
      args: [reserveBps, deployedBps, liquidityBps, BigInt(rebalanceFreqSecs)],
    },
  };
}

/** A single approved-adapter allocation target for {buildUpdateConstitutionEvm}. */
export interface EvmConstitutionAdapter {
  adapter: string;
  maxAllocationBps: number;
  approved: boolean;
  protocolId: string;
}

/**
 * `update_constitution` → NaveTreasury.updateConstitution(adapters[],
 * maxAllocationBps[], approved[], protocolIds[], confidenceThreshold). This is
 * the EVM analogue of the per-adapter allocation/approval set (the strategy
 * "targets" on EVM are the approved adapter addresses + their caps; the adapter
 * itself encodes its underlying pool — see the configure_position_targets ❎ note).
 */
export function buildUpdateConstitutionEvm(
  chainId: EvmChainId,
  treasury: string,
  adapters: EvmConstitutionAdapter[],
  confidenceThreshold: number,
  agentThresholdUsd?: number,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  const addrs: Address[] = [];
  const caps: number[] = [];
  const approvedFlags: boolean[] = [];
  const ids: string[] = [];
  for (const a of adapters) {
    const addr = toAddress(a.adapter);
    if (!addr) return { request: null, error: `Invalid adapter address: ${a.adapter}` };
    addrs.push(addr);
    caps.push(a.maxAllocationBps);
    approvedFlags.push(a.approved);
    ids.push(a.protocolId);
  }
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'updateConstitution',
      args: [addrs, caps, approvedFlags, ids, confidenceThreshold, BigInt(agentThresholdUsd ?? 0)],
    },
  };
}

/** `set_dao_privacy` → NaveTreasury.setDaoPrivacy(uint8 mode). */
export function buildSetDaoPrivacyEvm(chainId: EvmChainId, treasury: string, mode: number): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: { kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'setDaoPrivacy', args: [mode] },
  };
}

/** Default guardian-action signature deadline: 6 days out, safely under the
 *  contract's 7-day GUARDIAN_ACTION_STALE_SECS cap (the on-chain check rejects a
 *  deadline more than 7 days in the future). All guardians must sign the SAME
 *  deadline (it is part of the EIP-712 digest), so it should be coordinated
 *  alongside the nonce. */
export function defaultGuardianActionDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60);
}

/** `emergency_freeze` → NaveTreasury.emergencyFreeze(nonce, deadline, signatures). */
export function buildEmergencyFreezeEvm(
  chainId: EvmChainId,
  treasury: string,
  nonce: number | bigint,
  deadline: number | bigint = defaultGuardianActionDeadline(),
  signatures: readonly `0x${string}`[] = [],
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: treasuryAddr,
      abi: NaveTreasuryAbi,
      functionName: 'emergencyFreeze',
      args: [BigInt(nonce), BigInt(deadline), signatures],
    },
  };
}

/** `emergency_unfreeze` → NaveTreasury.emergencyUnfreeze(nonce, deadline, signatures). */
export function buildEmergencyUnfreezeEvm(
  chainId: EvmChainId,
  treasury: string,
  nonce: number | bigint,
  deadline: number | bigint = defaultGuardianActionDeadline(),
  signatures: readonly `0x${string}`[] = [],
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: treasuryAddr,
      abi: NaveTreasuryAbi,
      functionName: 'emergencyUnfreeze',
      args: [BigInt(nonce), BigInt(deadline), signatures],
    },
  };
}

/**
 * Guardian M-of-N agent pause → NaveTreasury.guardianDisableAgents(nonce, deadline, signatures).
 * Replaces the removed single-actor `emergencyPauseAgents()`. Every signature
 * must be an EIP-712 `GuardianAction(DISABLE_AGENTS)` over the SAME nonce/deadline
 * (see `buildGuardianDisableAgentsTypedData` in edgeFunctionClient). The normal
 * UI path is the founder-signed `agent-admin` proxy, which collects the custodied
 * guardian signature(s) and broadcasts; this builder is the direct-wallet route.
 */
export function buildGuardianDisableAgentsEvm(
  chainId: EvmChainId,
  treasury: string,
  nonce: number | bigint,
  deadline: number | bigint,
  signatures: readonly `0x${string}`[],
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  if (!treasuryAddr) return notConfigured('NaveTreasury');
  if (signatures.length === 0) {
    return { request: null, error: 'guardianDisableAgents requires at least one guardian signature' };
  }
  return {
    request: {
      kind: 'evm',
      chainId,
      address: treasuryAddr,
      abi: NaveTreasuryAbi,
      functionName: 'guardianDisableAgents',
      args: [BigInt(nonce), BigInt(deadline), signatures],
    },
  };
}

/** `set_asset_enabled`-equivalent → NaveTreasury.setAssetEnabled(asset, enabled). */
export function buildSetAssetEnabledEvm(chainId: EvmChainId, treasury: string, asset: string, enabled: boolean): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const assetAddr = toAddress(asset);
  if (!treasuryAddr || !assetAddr) return notConfigured('NaveTreasury');
  return {
    request: { kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'setAssetEnabled', args: [assetAddr, enabled] },
  };
}

// ─── Tokens (parity wiring) ──────────────────────────────────────────────────

/**
 * `register_dao_token` → NaveTreasury.registerDaoToken(name, symbol, decimals,
 * initialSupply, initialRecipient). Payable: pass the native token-mint fee
 * (NaveProtocol.tokenMintFee) as `feeWei`.
 */
export function buildRegisterDaoTokenEvm(
  chainId: EvmChainId,
  treasury: string,
  name: string,
  symbol: string,
  decimals: number,
  initialSupply: bigint,
  initialRecipient: string,
  feeWei: bigint = 0n,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const recipientAddr = toAddress(initialRecipient);
  if (!treasuryAddr || !recipientAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'registerDaoToken',
      args: [name, symbol, decimals, initialSupply, recipientAddr],
      value: feeWei,
    },
  };
}

/** Register an existing ERC-20 for token-weighted governance (no deploy). */
export function buildRegisterExternalDaoTokenEvm(
  chainId: EvmChainId,
  treasury: string,
  mint: string,
  name: string,
  symbol: string,
  decimals: number,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const mintAddr = toAddress(mint);
  if (!treasuryAddr || !mintAddr) return notConfigured('NaveTreasury');
  return {
    request: {
      kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi,
      functionName: 'registerExternalDaoToken',
      args: [mintAddr, name, symbol, decimals],
    },
  };
}

/** `revoke_token_authority` → NaveTreasury.revokeTokenAuthority(mint). */
export function buildRevokeTokenAuthorityEvm(chainId: EvmChainId, treasury: string, mint: string): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const mintAddr = toAddress(mint);
  if (!treasuryAddr || !mintAddr) return notConfigured('NaveTreasury');
  return {
    request: { kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'revokeTokenAuthority', args: [mintAddr] },
  };
}

/** `update_token_metadata` → NaveTreasury.updateTokenMetadata(mint, name, symbol). */
export function buildUpdateTokenMetadataEvm(
  chainId: EvmChainId,
  treasury: string,
  mint: string,
  name: string,
  symbol: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const treasuryAddr = toAddress(treasury);
  const mintAddr = toAddress(mint);
  if (!treasuryAddr || !mintAddr) return notConfigured('NaveTreasury');
  return {
    request: { kind: 'evm', chainId, address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'updateTokenMetadata', args: [mintAddr, name, symbol] },
  };
}

/**
 * `mint_additional_tokens` → NaveGovernor.mintAdditionalTokens(proposalIndex,
 * mint, to, amount). H-1: minting now requires a PASSED TokenMint proposal whose
 * payload binds exactly keccak256(abi.encode(mint, to, amount)); the proposal is
 * consumed (marked Executed) to prevent replay. This is the post-pass ratify
 * step (a normal call — the governor checks the proposal, not msg.sender).
 */
export function buildMintAdditionalTokensEvm(
  chainId: EvmChainId,
  governor: string,
  proposalIndex: number | bigint,
  mint: string,
  to: string,
  amount: bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const governorAddr = toAddress(governor);
  const mintAddr = toAddress(mint);
  const toAddr = toAddress(to);
  if (!governorAddr || !mintAddr || !toAddr) return notConfigured('NaveGovernor');
  return {
    request: {
      kind: 'evm', chainId, address: governorAddr, abi: NaveGovernorAbi,
      functionName: 'mintAdditionalTokens', args: [BigInt(proposalIndex), mintAddr, toAddr, amount],
    },
  };
}

// ─── NaveDaoStake (moonlighting lifecycle) ───────────────────────────────────

function stakeModuleOrError(module: string | null | undefined): Address | null {
  return toAddress(module ?? null);
}

/** Record a PASSED MoonlightRequest (type 9) on NaveDaoStake. */
export function buildRecordMoonlightRequestEvm(
  chainId: EvmChainId,
  stakeModule: string,
  treasury: string,
  governor: string,
  proposalIndex: number | bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const module = stakeModuleOrError(stakeModule);
  const treasuryAddr = toAddress(treasury);
  const governorAddr = toAddress(governor);
  if (!module || !treasuryAddr || !governorAddr) return notConfigured('NaveDaoStake');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: module,
      abi: NaveDaoStakeAbi,
      functionName: 'recordMoonlightRequest',
      args: [treasuryAddr, governorAddr, BigInt(proposalIndex)],
    },
  };
}

/** Distribution wizard step 1: set the approved moonlight recipient. */
export function buildSetMoonlightRecipientEvm(
  chainId: EvmChainId,
  stakeModule: string,
  treasury: string,
  recipient: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const module = stakeModuleOrError(stakeModule);
  const treasuryAddr = toAddress(treasury);
  const recipientAddr = toAddress(recipient);
  if (!module || !treasuryAddr || !recipientAddr) return notConfigured('NaveDaoStake');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: module,
      abi: NaveDaoStakeAbi,
      functionName: 'setMoonlightRecipient',
      args: [treasuryAddr, recipientAddr],
    },
  };
}

/** Release creation stake to the approved recipient after MoonlightDistribution passes. */
export function buildExecuteMoonlightDistributionEvm(
  chainId: EvmChainId,
  stakeModule: string,
  treasury: string,
  governor: string,
  proposalIndex: number | bigint,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const module = stakeModuleOrError(stakeModule);
  const treasuryAddr = toAddress(treasury);
  const governorAddr = toAddress(governor);
  if (!module || !treasuryAddr || !governorAddr) return notConfigured('NaveDaoStake');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: module,
      abi: NaveDaoStakeAbi,
      functionName: 'executeMoonlightDistribution',
      args: [treasuryAddr, governorAddr, BigInt(proposalIndex)],
    },
  };
}

/** Finalize moonlighting (hide DAO from participants). */
export function buildFinalizeMoonlightEvm(
  chainId: EvmChainId,
  stakeModule: string,
  treasury: string,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const module = stakeModuleOrError(stakeModule);
  const treasuryAddr = toAddress(treasury);
  if (!module || !treasuryAddr) return notConfigured('NaveDaoStake');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: module,
      abi: NaveDaoStakeAbi,
      functionName: 'finalizeMoonlight',
      args: [treasuryAddr],
    },
  };
}

/** Founder restake to reopen a moonlighted DAO. */
export function buildRestoreDaoEvm(
  chainId: EvmChainId,
  stakeModule: string,
  treasury: string,
  amount: bigint,
  priceUsdMicro: bigint = 0n,
): EvmBuildResult {
  assertSupportedChain(chainId);
  const module = stakeModuleOrError(stakeModule);
  const treasuryAddr = toAddress(treasury);
  if (!module || !treasuryAddr) return notConfigured('NaveDaoStake');
  return {
    request: {
      kind: 'evm',
      chainId,
      address: module,
      abi: NaveDaoStakeAbi,
      functionName: 'restoreDao',
      args: [treasuryAddr, amount, priceUsdMicro],
    },
  };
}

/** EIP-712 typed data for a NaveTreasury GuardianAction (matches on-chain TYPEHASH). */
export function buildGuardianActionTypedData(
  chainId: EvmChainId,
  treasury: Address,
  params: {
    actionType: number;
    agentSlot?: number;
    newStatus?: number;
    newKey?: Address;
    nonce: bigint;
    deadline: bigint;
  },
) {
  return {
    domain: {
      name: 'NaveTreasury',
      version: '1',
      chainId,
      verifyingContract: treasury,
    },
    types: {
      GuardianAction: [
        { name: 'actionType', type: 'uint8' },
        { name: 'agentSlot', type: 'uint8' },
        { name: 'newStatus', type: 'uint8' },
        { name: 'newKey', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'GuardianAction' as const,
    message: {
      actionType: params.actionType,
      agentSlot: params.agentSlot ?? 0,
      newStatus: params.newStatus ?? 0,
      newKey: (params.newKey ?? `0x${'0'.repeat(40)}`) as Address,
      nonce: params.nonce,
      deadline: params.deadline,
    },
  };
}
