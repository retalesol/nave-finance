import { createPublicClient, createWalletClient, encodeAbiParameters, formatEther, http, keccak256, parseEther, parseGwei, type Hash, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base, sepolia, baseSepolia } from 'viem/chains';
import type { Chain } from 'viem';
import { loadEvmAccount, isEvmChainId, signEvmApproval, type EvmSignerRole } from './evmSigner.js';
import { arcTestnet, robinhood, robinhoodTestnet } from './evmChains.js';
import { fetchHermesUpdateData } from './evmPythKeeper.js';
import { evmStrategyVotingPeriodSeconds } from './actionDelays.js';

// Scope: Ethereum + Base + Robinhood + Arc Testnet (1/8453/4663 + testnets).

/** chain_id → { viem chain, RPC env var, optional testnet fallback URL }. */
const CHAIN_CONFIG: Record<number, { chain: Chain; rpcEnv: string; fallbackUrl?: string }> = {
  1: { chain: mainnet, rpcEnv: 'EVM_ETHEREUM_RPC_URL' },
  11155111: {
    chain: sepolia,
    rpcEnv: 'EVM_SEPOLIA_RPC_URL',
    fallbackUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  8453: { chain: base, rpcEnv: 'EVM_BASE_RPC_URL' },
  84532: {
    chain: baseSepolia,
    rpcEnv: 'EVM_BASE_SEPOLIA_RPC_URL',
    fallbackUrl: 'https://sepolia.base.org',
  },
  4663: { chain: robinhood, rpcEnv: 'EVM_ROBINHOOD_RPC_URL' },
  46630: {
    chain: robinhoodTestnet,
    rpcEnv: 'EVM_ROBINHOOD_TESTNET_RPC_URL',
    fallbackUrl: 'https://rpc.testnet.chain.robinhood.com',
  },
  5042002: {
    chain: arcTestnet,
    rpcEnv: 'EVM_ARC_TESTNET_RPC_URL',
    fallbackUrl: 'https://rpc.testnet.arc.io',
  },
};

/** Mainnet chain ids — a positive `minOut` slippage floor is REQUIRED here. */
const MAINNET_CHAIN_IDS = new Set<number>([1, 8453, 4663]);

// Minimal NaveTreasury ABI for the agent toggle path. Resume is the Executive
// agent's msg.sender-gated `toggleAgents(true)` (refused on-chain once
// guardians have disabled the pipeline); pause is the guardian M-of-N
// `guardianAction(DISABLE_AGENTS)`, which also locks out Executive re-enable.
const TREASURY_TOGGLE_ABI = [
  { type: 'function', name: 'toggleAgents', stateMutability: 'nonpayable', inputs: [{ name: 'enabled', type: 'bool' }], outputs: [] },
  {
    type: 'function',
    name: 'guardianAction',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'actionType', type: 'uint8' },
          { name: 'agentSlot', type: 'uint8' },
          { name: 'newStatus', type: 'uint8' },
          { name: 'newKey', type: 'address' },
          { name: 'nonce', type: 'uint64' },
          { name: 'deadline', type: 'uint64' },
        ],
      },
      { name: 'signatures', type: 'bytes[]' },
    ],
    outputs: [],
  },
] as const;

/** `GuardianActionType.DISABLE_AGENTS` (contracts/evm/src/libraries/NaveEnums.sol). */
const GUARDIAN_ACTION_DISABLE_AGENTS = 4;

/** Upper bound on custodied guardian slots probed for the pause quorum. */
const MAX_CUSTODIED_GUARDIANS = 10;
/** Default validity of a pause digest (contract stale bound is 7 days). */
const DISABLE_AGENTS_DEADLINE_SECS = 3600;

// Position-oracle tick. The mark is read on-chain from the adapter by
// `NaveExecution.syncPositionValue(adapter)` (founder or Oversight agent, role operational);
// the relayer never supplies a value, and the treasury caps upward drift.
const EXECUTION_POSITION_ABI = [
  {
    type: 'function',
    name: 'syncPositionValue',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'adapter', type: 'address' }],
    outputs: [{ name: 'applied', type: 'uint256' }],
  },
] as const;

// Minimal NaveExecution ABI for the four-agent pipeline relay. Only the
// functions we actually broadcast are declared (kept in lockstep with
// contracts/evm/src/NaveExecution.sol).
const EXECUTION_ABI = [
  { type: 'function', name: 'executiveApprove', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }, { name: 'reasoningHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'financialApprove', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }, { name: 'txPayloadHash', type: 'bytes32' }, { name: 'reasoningHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'oversightApprove', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }, { name: 'txPayloadHash', type: 'bytes32' }, { name: 'reasoningHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'operationalHalt', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }, { name: 'reasonHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'operationalClear', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }, { name: 'reasonHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'expireRequest', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }], outputs: [] },
  { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }, { name: 'minOut', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'executeDirect', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }, { name: 'minOut', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdrawFromStrategy', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }, { name: 'amount', type: 'uint256' }, { name: 'minOut', type: 'uint256' }], outputs: [] },
  {
    type: 'function',
    name: 'createBridgeRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'proposalIndex', type: 'uint64' },
      { name: 'amount', type: 'uint256' },
      { name: 'adapter', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'destChainId', type: 'uint256' },
      { name: 'destTreasury', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

// ── Relayer safety caps (env-overridable) ─────────────────────────────────────
// A custodied EOA broadcasts these txs, so we fence them: never submit a tx that
// estimates above the gas cap, and never broadcast into a fee spike above the
// max-fee cap. Both are intentionally generous for a single contract call.
// Compound v3 deposits on Sepolia estimate about 1.6M gas. 600k refused a
// real execute. 3M still rejects a runaway estimate.
const DEFAULT_MAX_GAS = 3_000_000n;
const DEFAULT_MAX_FEE_GWEI = 200; // maxFeePerGas ceiling

function maxGasLimit(): bigint {
  const raw = process.env.NAVE_EVM_RELAY_MAX_GAS;
  if (!raw) return DEFAULT_MAX_GAS;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : DEFAULT_MAX_GAS;
  } catch {
    return DEFAULT_MAX_GAS;
  }
}

function maxFeePerGasCap(): bigint {
  const raw = process.env.NAVE_EVM_RELAY_MAX_FEE_GWEI;
  const gwei = raw ? Number(raw) : DEFAULT_MAX_FEE_GWEI;
  return parseGwei(String(Number.isFinite(gwei) && gwei > 0 ? gwei : DEFAULT_MAX_FEE_GWEI));
}

/** Confirmations to wait for the relayed tx receipt (default 1; 0 disables). */
function receiptConfirmations(): number {
  const raw = process.env.NAVE_EVM_RELAY_CONFIRMATIONS;
  const n = raw ? Number(raw) : 1;
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** Timeout (ms) waiting for the relayed tx receipt before giving up. */
function receiptTimeoutMs(): number {
  const raw = process.env.NAVE_EVM_RELAY_RECEIPT_TIMEOUT_MS;
  const n = raw ? Number(raw) : 120_000;
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

export interface EvmRelayToggleRequest {
  chain_id: number;
  /** NaveTreasury (DAO) address. */
  dao_address: string;
  enabled: boolean;
  /**
   * Pause only (enabled=false): additional EIP-712 GuardianAction(DISABLE_AGENTS)
   * signatures produced outside the signer (e.g. the founder's wallet in the
   * browser). They MUST be over the same `nonce` + `deadline` supplied here;
   * the relayer adds every custodied guardian signature it holds and submits
   * the union to `guardianAction(DISABLE_AGENTS)`.
   */
  guardian_signatures?: string[];
  /** GuardianAction.nonce (uint64). Defaults to the current unix time. */
  nonce?: number | string;
  /** GuardianAction.deadline (unix seconds). Defaults to now + 1h. */
  deadline?: number | string;
}

/** Position-oracle tick request (mirrors Solana's `update_strategy_position_value`). */
export interface EvmRelayUpdatePositionValueRequest {
  chain_id: number;
  /** NaveTreasury (DAO) address — used to load the custodied Operational key. */
  dao_address: string;
  /** NaveExecution contract — the tx TARGET. Accepts `target_address` alias. */
  execution_address?: string;
  target_address?: string;
  /** Adapter address the position is keyed by (NaveTreasury.position(adapter)). */
  adapter: string;
  /**
   * Ignored: the value is read on-chain from the adapter. Kept so older
   * callers that still send it are not rejected.
   */
  new_value?: number | string;
}

/** Agent-pipeline relay action names (1:1 with the orchestrator action vocab). */
export type EvmRelayAgentAction =
  | 'executive_approve'
  | 'financial_approve'
  | 'oversight_approve'
  | 'operational_halt'
  | 'operational_clear'
  | 'expire_request'
  | 'execute_strategy'
  | 'execute_strategy_direct'
  | 'withdraw_from_strategy'
  | 'create_bridge_request'
  | 'bridge_outbound';

export interface EvmRelayAgentActionRequest {
  action: EvmRelayAgentAction;
  chain_id: number;
  /** NaveTreasury (DAO) address — used to LOAD the custodied agent EOA key. */
  dao_address: string;
  /**
   * NaveExecution contract address — the tx TARGET (msg.sender-gated calls).
   * Distinct from dao_address (the treasury). Accepts `target_address` alias.
   */
  execution_address?: string;
  target_address?: string;
  /** uint64 execution-request index (the request key on NaveExecution). */
  index: number | string;
  /** bytes32 reasoning/halt-reason hash (approvals + operational_halt). */
  reasoning_hash?: string;
  /**
   * Optional bytes32 payload hash the caller reviewed (financial/oversight).
   * The relayer recomputes the hash from the on-chain request and signs that;
   * a supplied value must match it.
   */
  tx_payload_hash?: string;
  /** uint256 base-unit amount to unwind (withdraw_from_strategy). */
  amount?: number | string;
  /** uint256 slippage floor for adapter join/exit (execute / withdraw). */
  min_out?: number | string;
  /** Bridge request: adapter / asset / dest chain / sister treasury. */
  adapter?: string;
  asset?: string;
  dest_chain_id?: number | string;
  dest_treasury?: string;
}

export interface EvmRelayResult {
  tx_hash: Hash;
  signer: string;
  signer_role: EvmSignerRole;
  /** The NaveTreasury / NaveExecution function that was broadcast. */
  function_name: string;
  chain_id: number;
  /** Block the tx was mined in (from the confirmed receipt). */
  block_number?: string;
  /** Gas actually consumed by the confirmed tx. */
  gas_used?: string;
  /** Receipt status ('success' | 'reverted'); always 'success' on resolve. */
  status: 'success';
  /** Guardian pause only: custodied guardian addresses that signed. */
  guardian_signers?: string[];
  /** Guardian pause only: total signatures submitted (custodied + external). */
  guardian_signature_count?: number;
  /** Guardian pause only: GuardianAction nonce / deadline used. */
  nonce?: string;
  deadline?: string;
}

const RETIRED_ARC_RPC_HOSTS = new Set(['rpc.testnet.arc.network', 'www.rpc.testnet.arc.network']);

/** Ignore the retired Arc host, which does not resolve. */
function usableRpcUrl(chainId: number, url: string | undefined): string | undefined {
  if (!url) return url;
  if (chainId !== 5042002) return url;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (RETIRED_ARC_RPC_HOSTS.has(host)) return 'https://rpc.testnet.arc.io';
  } catch {
    return 'https://rpc.testnet.arc.io';
  }
  return url.replace(/\/$/, '');
}

export function rpcUrlFor(chainId: number): string {
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) throw new Error(`Unsupported chain_id ${chainId} (Ethereum, Base, Robinhood, Arc Testnet)`);
  const url = usableRpcUrl(chainId, process.env[cfg.rpcEnv]?.trim() || cfg.fallbackUrl);
  if (!url) throw new Error(`Relayer RPC not configured: set ${cfg.rpcEnv} for chain ${chainId}`);
  return url;
}

type LoadedAccount = Awaited<ReturnType<typeof loadEvmAccount>>;

/**
 * Minimum gas floor for `syncPositionValue` so block-boundary interest accrual
 * turning SSTORE no-ops into dirty writes never runs out of gas under EIP-150.
 */
export const SYNC_POSITION_VALUE_MIN_GAS = 200_000n;

/**
 * Compute the gas limit for a relayed EVM contract call:
 *  - 30% headroom (`130n / 100n`) over the RPC estimate;
 *  - minimum floor of `200_000n` when `functionName === 'syncPositionValue'`;
 *  - capped at `gasCap`.
 */
export function computeRelayerGasLimit(
  estimatedGas: bigint,
  functionName: string,
  gasCap: bigint = maxGasLimit(),
): bigint {
  const buffered = (estimatedGas * 130n) / 100n;
  const floored =
    functionName === 'syncPositionValue' && buffered < SYNC_POSITION_VALUE_MIN_GAS
      ? SYNC_POSITION_VALUE_MIN_GAS
      : buffered;
  return floored > gasCap ? gasCap : floored;
}

/** In-process per-(chainId, senderAddress) async queue so concurrent calls from the same EOA never race on nonces. */
const senderLocks = new Map<string, Promise<unknown>>();

export async function withSenderLock<T>(
  chainId: number,
  address: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const prev = senderLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = prev.catch(() => {}).then(() => gate);
  senderLocks.set(key, next);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (senderLocks.get(key) === next) {
      senderLocks.delete(key);
    }
  }
}

/**
 * New agent EOAs are created with a zero balance. Fund the broadcaster from the
 * ops wallet before the first toggle, or agent start fails as soon as the
 * treasury exists. No-op when the balance already covers `requiredWei`.
 */
async function fundCustodiedSender(params: {
  chainId: number;
  chain: Chain;
  transport: ReturnType<typeof http>;
  publicClient: PublicClient;
  address: `0x${string}`;
  requiredWei: bigint;
}): Promise<void> {
  const { chainId, chain, transport, publicClient, address, requiredWei } = params;
  if (requiredWei <= 0n) return;
  const balance = await publicClient.getBalance({ address });
  if (balance >= requiredWei) return;

  const ops = loadEvmOpsAccount();
  if (!ops) {
    throw new Error(
      `Custodied signer ${address} has ${formatEther(balance)} native gas on chain ${chainId} ` +
      `but this transaction needs about ${formatEther(requiredWei)}. ` +
      `Set EVM_OPS_PRIVATE_KEY or NAVE_EVM_OPS_PRIVATE_KEY so the relayer can fund agent wallets.`,
    );
  }
  if (ops.address.toLowerCase() === address.toLowerCase()) {
    throw new Error(
      `Ops wallet ${address} on chain ${chainId} has ${formatEther(balance)} native gas and needs about ${formatEther(requiredWei)}.`,
    );
  }

  const cap = parseEther('0.2');
  if (requiredWei > cap) {
    throw new Error(
      `Estimated gas cost ${formatEther(requiredWei)} on chain ${chainId} exceeds the ${formatEther(cap)} relayer top-up cap.`,
    );
  }
  const target = requiredWei * 2n > parseEther('0.005') ? requiredWei * 2n : parseEther('0.005');
  const deficit = requiredWei - balance;

  await withSenderLock(chainId, ops.address, async () => {
    const opsBalance = await publicClient.getBalance({ address: ops.address });
    const reserve = parseEther('0.0005');
    const preferred = target > balance ? target - balance : deficit;
    let amount = 0n;
    if (opsBalance > preferred + reserve) amount = preferred;
    else if (opsBalance > deficit + reserve) amount = deficit;
    if (amount <= 0n) {
      throw new Error(
        `EVM ops wallet ${ops.address} balance ${formatEther(opsBalance)} on chain ${chainId} ` +
        `cannot fund ${address} (needs ${formatEther(deficit)} plus reserve).`,
      );
    }
    const opsWallet = createWalletClient({ account: ops, chain, transport });
    const nonce = await publicClient.getTransactionCount({ address: ops.address, blockTag: 'latest' });
    const hash = await opsWallet.sendTransaction({
      account: ops,
      chain,
      to: address,
      value: amount,
      nonce,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs() });
    if (receipt.status !== 'success') {
      throw new Error(`Gas top-up ${hash} reverted on chain ${chainId}`);
    }
  });
}

/**
 * Shared hardened broadcast for a single contract call from a custodied EOA.
 * Centralizes the relayer safety pattern used by BOTH the treasury toggle and
 * the NaveExecution pipeline relay:
 *  - per-chain client (Ethereum, Base, Robinhood, Arc) from CHAIN_CONFIG;
 *  - in-process per-(chainId, account.address) serialization around nonce read +
 *    broadcast + receipt wait so concurrent calls from the same EOA never race;
 *  - gas estimate with a hard cap (estimateContractGas also surfaces a revert —
 *    e.g. caller is not the authorized agent — BEFORE we spend broadcasting);
 *  - 30% gas headroom + 200k minimum floor on `syncPositionValue` (capped at gasCap);
 *  - EIP-1559 fees with a maxFeePerGas ceiling (refuse to broadcast into a spike);
 *  - `'latest'` nonce tracking with a 20% fee bump when replacing a stuck pending tx;
 *  - wait for the receipt and FAIL if status === 'reverted' (no silent success).
 */
async function broadcastCall(params: {
  chainId: number;
  target: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  account: LoadedAccount;
  /** Payable calls (Pyth `updatePriceFeeds`) attach this msg.value. */
  value?: bigint;
}): Promise<{ txHash: Hash; blockNumber?: bigint; gasUsed?: bigint }> {
  const { chainId, target, abi, functionName, args, account, value } = params;
  const cfg = CHAIN_CONFIG[chainId];
  const transport = http(rpcUrlFor(chainId));
  const publicClient = createPublicClient({ chain: cfg.chain, transport }) as PublicClient;
  const wallet = createWalletClient({ account, chain: cfg.chain, transport });

  return withSenderLock(chainId, account.address, async () => {
    let gas: bigint;
    try {
      gas = await publicClient.estimateContractGas({
        address: target,
        abi: abi as never,
        functionName: functionName as never,
        args: args as never,
        account,
        ...(value !== undefined ? { value } : {}),
      });
    } catch (err) {
      throw new Error(
        `Gas estimation failed for ${functionName} on ${target} (chain ${chainId}) — call would revert: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const gasCap = maxGasLimit();
    if (gas > gasCap) {
      throw new Error(`Estimated gas ${gas} exceeds relayer cap ${gasCap} for ${functionName} (chain ${chainId})`);
    }
    const gasLimit = computeRelayerGasLimit(gas, functionName, gasCap);

    const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
    const feeCap = maxFeePerGasCap();
    if (maxFeePerGas !== undefined && maxFeePerGas > feeCap) {
      throw new Error(
        `Network maxFeePerGas ${maxFeePerGas} exceeds relayer cap ${feeCap} (set NAVE_EVM_RELAY_MAX_FEE_GWEI to override) — refusing to relay during fee spike`,
      );
    }

    const latestNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
    let pendingNonce = latestNonce;
    try {
      pendingNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    } catch {
      pendingNonce = latestNonce;
    }

    const minNormalPriority = parseGwei('0.01') > feeCap ? feeCap : parseGwei('0.01');
    const minNormalMaxFee = parseGwei('0.05') > feeCap ? feeCap : parseGwei('0.05');
    let effectiveMaxPriorityFeePerGas =
      maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas < minNormalPriority
        ? minNormalPriority
        : maxPriorityFeePerGas;
    let effectiveMaxFeePerGas =
      maxFeePerGas !== undefined && maxFeePerGas < minNormalMaxFee
        ? minNormalMaxFee
        : maxFeePerGas;
    if (
      effectiveMaxFeePerGas !== undefined &&
      effectiveMaxPriorityFeePerGas !== undefined &&
      effectiveMaxFeePerGas < effectiveMaxPriorityFeePerGas
    ) {
      effectiveMaxFeePerGas = effectiveMaxPriorityFeePerGas;
    }

    if (pendingNonce > latestNonce) {
      // A prior tx at `latestNonce` is still pending in the mempool; bump fees
      // by 20% and apply a 1.5 gwei priority / 3 gwei maxFee floor (capped at
      // feeCap) so a stuck sub-gwei tx at `latestNonce` is replaced cleanly.
      const minReplacePriority = parseGwei('1.5') > feeCap ? feeCap : parseGwei('1.5');
      const minReplaceMaxFee = parseGwei('3') > feeCap ? feeCap : parseGwei('3');
      if (effectiveMaxFeePerGas !== undefined) {
        const bumped = (effectiveMaxFeePerGas * 120n) / 100n;
        const floored = bumped < minReplaceMaxFee ? minReplaceMaxFee : bumped;
        effectiveMaxFeePerGas = floored > feeCap ? feeCap : floored;
      }
      if (effectiveMaxPriorityFeePerGas !== undefined) {
        const bumped = (effectiveMaxPriorityFeePerGas * 120n) / 100n;
        const floored = bumped < minReplacePriority ? minReplacePriority : bumped;
        effectiveMaxPriorityFeePerGas = floored > feeCap ? feeCap : floored;
        if (effectiveMaxFeePerGas !== undefined && effectiveMaxPriorityFeePerGas > effectiveMaxFeePerGas) {
          effectiveMaxPriorityFeePerGas = effectiveMaxFeePerGas;
        }
      }
    }

    const feePerGas = effectiveMaxFeePerGas ?? 0n;
    if (feePerGas > 0n) {
      await fundCustodiedSender({
        chainId,
        chain: cfg.chain,
        transport,
        publicClient,
        address: account.address,
        requiredWei: gasLimit * feePerGas + (value ?? 0n),
      });
    }

    let txHash!: Hash;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        txHash = await wallet.writeContract({
          address: target,
          abi: abi as never,
          functionName: functionName as never,
          args: args as never,
          chain: cfg.chain,
          account,
          gas: gasLimit,
          nonce: latestNonce,
          ...(value !== undefined ? { value } : {}),
          ...(effectiveMaxFeePerGas !== undefined ? { maxFeePerGas: effectiveMaxFeePerGas } : {}),
          ...(effectiveMaxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: effectiveMaxPriorityFeePerGas } : {}),
        });
        break;
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        const isUnderpriced = msg.includes('replacement transaction underpriced') || msg.includes('underpriced');
        if (!isUnderpriced || attempt === 2) throw err;
        if (effectiveMaxFeePerGas !== undefined) {
          const bumped = effectiveMaxFeePerGas * 2n;
          effectiveMaxFeePerGas = bumped > feeCap ? feeCap : bumped;
        }
        if (effectiveMaxPriorityFeePerGas !== undefined) {
          const bumped = effectiveMaxPriorityFeePerGas * 2n;
          effectiveMaxPriorityFeePerGas = bumped > feeCap ? feeCap : bumped;
          if (effectiveMaxFeePerGas !== undefined && effectiveMaxPriorityFeePerGas > effectiveMaxFeePerGas) {
            effectiveMaxPriorityFeePerGas = effectiveMaxFeePerGas;
          }
        }
      }
    }

    const confirmations = receiptConfirmations();
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: confirmations > 0 ? confirmations : undefined,
      timeout: receiptTimeoutMs(),
    });
    if (receipt.status !== 'success') {
      throw new Error(`Relayed ${functionName} reverted on-chain (tx ${txHash}, chain ${chainId})`);
    }
    return { txHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  });
}

/**
 * Collect EIP-712 GuardianAction(DISABLE_AGENTS) signatures from every
 * custodied guardian slot bound for this treasury (slot 0..N until the first
 * missing slot). Returns the signatures plus the slot-0 account, which
 * broadcasts the transaction (any EOA may submit; the quorum is in the
 * signatures, not msg.sender).
 */
async function collectCustodiedDisableSignatures(
  treasury: string,
  chainId: number,
  nonce: bigint,
  deadline: bigint,
): Promise<{ signatures: `0x${string}`[]; signers: string[]; broadcaster: Awaited<ReturnType<typeof loadEvmAccount>> }> {
  const signatures: `0x${string}`[] = [];
  const signers: string[] = [];
  let broadcaster: Awaited<ReturnType<typeof loadEvmAccount>> | null = null;
  for (let i = 0; i < MAX_CUSTODIED_GUARDIANS; i++) {
    let account: Awaited<ReturnType<typeof loadEvmAccount>>;
    try {
      account = await loadEvmAccount(treasury, chainId, 'guardian', i);
    } catch {
      break; // first missing slot ends the custodied set
    }
    if (!broadcaster) broadcaster = account;
    const signed = await signEvmApproval({
      chain_id: chainId,
      dao_address: treasury,
      agent_role: 'guardian',
      guardian_index: i,
      action_type: 'DISABLE_AGENTS',
      agent_slot: 0,
      new_status: 0,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
    });
    signatures.push(signed.signature);
    signers.push(signed.signer);
  }
  if (!broadcaster) {
    throw new Error(
      `No custodied guardian key bound for ${treasury} (chain ${chainId}); cannot assemble the DISABLE_AGENTS guardian quorum`,
    );
  }
  return { signatures, signers, broadcaster };
}

/**
 * Submit the agent pause/resume toggle on-chain from the appropriate custodied
 * EOA. Resume → Executive agent calls `toggleAgents(true)` (msg.sender-gated).
 * Pause → guardian M-of-N `guardianAction(DISABLE_AGENTS, sigs)`: the
 * relayer signs with every custodied guardian it holds, appends any externally
 * supplied guardian signatures (founder wallet), and broadcasts from the
 * custodied guardian EOA. If the on-chain threshold is not met the call
 * reverts `InvalidGuardianThreshold` — the caller must gather more signatures
 * over the SAME nonce/deadline and retry.
 */
export async function relayEvmAgentToggle(body: EvmRelayToggleRequest): Promise<EvmRelayResult> {
  const { chain_id, enabled } = body;
  if (!isEvmChainId(chain_id)) {
    throw new Error(`Unsupported chain_id ${chain_id} (Ethereum, Base, Robinhood, Arc Testnet: 1, 8453, 4663, 11155111, 84532, 46630, 5042002)`);
  }
  const treasury = body.dao_address;
  if (!EVM_ADDRESS_RE.test(treasury)) {
    throw new Error('dao_address must be a 20-byte EVM treasury address');
  }

  if (enabled) {
    const account = await loadEvmAccount(treasury, chain_id, 'executive');
    const { txHash, blockNumber, gasUsed } = await broadcastCall({
      chainId: chain_id,
      target: treasury as `0x${string}`,
      abi: TREASURY_TOGGLE_ABI,
      functionName: 'toggleAgents',
      args: [true],
      account,
    });
    return {
      tx_hash: txHash,
      signer: account.address,
      signer_role: 'executive',
      function_name: 'toggleAgents',
      chain_id,
      block_number: blockNumber?.toString(),
      gas_used: gasUsed?.toString(),
      status: 'success',
    };
  }

  // ── Pause: guardian M-of-N ────────────────────────────────────────────────
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  const nonce = body.nonce !== undefined && body.nonce !== null && body.nonce !== ''
    ? BigInt(body.nonce)
    : nowSecs;
  const deadline = body.deadline !== undefined && body.deadline !== null && body.deadline !== ''
    ? BigInt(body.deadline)
    : nowSecs + BigInt(DISABLE_AGENTS_DEADLINE_SECS);
  if (deadline <= nowSecs) throw new Error('deadline must be in the future (unix seconds)');

  const external = (body.guardian_signatures ?? []).map((s) => {
    if (typeof s !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(s)) {
      throw new Error('guardian_signatures entries must be 65-byte 0x-hex EIP-712 signatures');
    }
    return s as `0x${string}`;
  });
  if (external.length > 0 && (body.nonce === undefined || body.deadline === undefined)) {
    throw new Error('nonce and deadline are required when guardian_signatures are supplied (all signers must sign the same digest)');
  }

  const custodied = await collectCustodiedDisableSignatures(treasury, chain_id, nonce, deadline);
  const seen = new Set<string>();
  const signatures = [...custodied.signatures, ...external].filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const { txHash, blockNumber, gasUsed } = await broadcastCall({
    chainId: chain_id,
    target: treasury as `0x${string}`,
    abi: TREASURY_TOGGLE_ABI,
    functionName: 'guardianAction',
    args: [
      {
        actionType: GUARDIAN_ACTION_DISABLE_AGENTS,
        agentSlot: 0,
        newStatus: 0,
        newKey: ZERO_ADDRESS,
        nonce,
        deadline,
      },
      signatures,
    ],
    account: custodied.broadcaster,
  });

  return {
    tx_hash: txHash,
    signer: custodied.broadcaster.address,
    signer_role: 'guardian',
    function_name: 'guardianAction',
    chain_id,
    block_number: blockNumber?.toString(),
    gas_used: gasUsed?.toString(),
    status: 'success',
    guardian_signers: custodied.signers,
    guardian_signature_count: signatures.length,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
  };
}

/**
 * Submit a position-oracle tick on-chain: `NaveExecution.syncPositionValue(adapter)`
 * from the custodied Oversight agent EOA (role operational). The contract reads the value from
 * the adapter itself, so the relayer cannot inject a mark.
 */
export async function relayEvmUpdateStrategyPositionValue(
  body: EvmRelayUpdatePositionValueRequest,
): Promise<EvmRelayResult> {
  const { chain_id, dao_address, adapter } = body;
  if (!isEvmChainId(chain_id)) {
    throw new Error(`Unsupported chain_id ${chain_id} (Ethereum, Base, Robinhood, Arc Testnet: 1, 8453, 4663, 11155111, 84532, 46630, 5042002)`);
  }
  if (!EVM_ADDRESS_RE.test(dao_address)) {
    throw new Error('dao_address must be a 20-byte EVM treasury address');
  }
  if (!EVM_ADDRESS_RE.test(adapter)) {
    throw new Error('adapter must be a 20-byte EVM address');
  }
  const target = body.execution_address ?? body.target_address;
  if (!target || !EVM_ADDRESS_RE.test(target)) {
    throw new Error('execution_address (NaveExecution contract) must be a 20-byte EVM address');
  }

  const account = await loadEvmAccount(dao_address, chain_id, 'operational');

  const { txHash, blockNumber, gasUsed } = await broadcastCall({
    chainId: chain_id,
    target: target as `0x${string}`,
    abi: EXECUTION_POSITION_ABI,
    functionName: 'syncPositionValue',
    args: [adapter as `0x${string}`],
    account,
  });

  return {
    tx_hash: txHash,
    signer: account.address,
    signer_role: 'operational',
    function_name: 'syncPositionValue',
    chain_id,
    block_number: blockNumber?.toString(),
    gas_used: gasUsed?.toString(),
    status: 'success',
  };
}

// ── NaveExecution pipeline relay ──────────────────────────────────────────────

interface ActionSpec {
  /** NaveExecution function to call. */
  functionName: string;
  /** Custodied agent role whose EOA must originate the tx (msg.sender gate). */
  role: Exclude<EvmSignerRole, 'guardian'>;
  /** Build the positional args from the (validated) request. */
  buildArgs: (req: EvmRelayAgentActionRequest, chainId: number, request: OnChainRequest | null) => readonly unknown[];
}

function asIndex(v: number | string | undefined): bigint {
  if (v === undefined || v === null || v === '') throw new Error('index is required (uint64 request key)');
  const n = BigInt(v);
  if (n < 0n) throw new Error('index must be a non-negative uint64');
  return n;
}

function asUint(v: number | string | undefined, label: string): bigint {
  if (v === undefined || v === null || v === '') throw new Error(`${label} is required`);
  const n = BigInt(v);
  if (n < 0n) throw new Error(`${label} must be a non-negative uint256`);
  return n;
}

/** Validate a required non-zero bytes32 (contracts revert on the zero hash). */
function requireHash32(v: string | undefined, label: string): `0x${string}` {
  if (!v) throw new Error(`${label} is required (bytes32)`);
  const clean = v.startsWith('0x') ? v : `0x${v}`;
  if (!BYTES32_RE.test(clean)) throw new Error(`${label} must be a 32-byte (64 hex char) value`);
  if (/^0x0{64}$/.test(clean)) throw new Error(`${label} must be non-zero`);
  return clean as `0x${string}`;
}

/** Mirrors NaveConstants.DEPOSIT_SLIPPAGE_BPS. */
const DEFAULT_SLIPPAGE_BPS = 50n;

/**
 * Resolve `minOut`. NaveExecution rejects a zero floor on every strategy
 * deposit/withdraw; on mainnet the caller must quote it explicitly, on
 * testnets `withDefaultMinOut` fills it from the on-chain request amount.
 */
function resolveMinOut(req: EvmRelayAgentActionRequest, chainId: number): bigint {
  const provided = req.min_out;
  if (provided === undefined || provided === null || provided === '') {
    if (MAINNET_CHAIN_IDS.has(chainId)) {
      throw new Error(`min_out is required (> 0) on mainnet chain ${chainId}`);
    }
    // Bridge executes ignore minOut on-chain.
    if (req.action === 'bridge_outbound') return 0n;
    throw new Error('min_out is required (> 0)');
  }
  const n = BigInt(provided);
  if (n <= 0n && req.action !== 'bridge_outbound') throw new Error('min_out must be positive');
  if (n < 0n) throw new Error('min_out must be non-negative');
  return n;
}

const EXECUTION_REQUEST_ABI = [
  {
    type: 'function',
    name: 'getRequest',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint64' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'exists', type: 'bool' },
          { name: 'kind', type: 'uint8' },
          { name: 'status', type: 'uint8' },
          { name: 'bootstrap', type: 'bool' },
          { name: 'proposalIndex', type: 'uint64' },
          { name: 'adapter', type: 'address' },
          { name: 'asset', type: 'address' },
          { name: 'recipient', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'reviewEnd', type: 'uint256' },
          { name: 'reviewWindow', type: 'int64' },
          { name: 'withdrawnAmount', type: 'uint256' },
          { name: 'txPayloadHash', type: 'bytes32' },
          { name: 'executiveReasoningHash', type: 'bytes32' },
          { name: 'financialReasoningHash', type: 'bytes32' },
          { name: 'oversightReasoningHash', type: 'bytes32' },
          { name: 'operationalHaltReasonHash', type: 'bytes32' },
          { name: 'createdAt', type: 'uint256' },
          { name: 'updatedAt', type: 'uint256' },
          { name: 'executedAt', type: 'uint256' },
          { name: 'destChainId', type: 'uint256' },
        ],
      },
    ],
  },
] as const;

const TREASURY_EXECUTION_ABI = [
  { type: 'function', name: 'execution', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'agent',
    stateMutability: 'view',
    inputs: [{ name: 'role', type: 'uint8' }],
    outputs: [{ name: 'authority', type: 'address' }, { name: 'operational', type: 'bool' }],
  },
] as const;

const AGENT_ROLE_INDEX: Record<Exclude<EvmSignerRole, 'guardian'>, number> = {
  executive: 0, financial: 1, oversight: 2, operational: 3,
};

/** The custodied EOA must be the treasury's current, operational agent for `role`. */
async function assertOnChainAgent(
  chainId: number,
  treasury: `0x${string}`,
  role: Exclude<EvmSignerRole, 'guardian'>,
  signer: `0x${string}`,
): Promise<void> {
  const [authority, operational] = await evmPublicClient(chainId).readContract({
    address: treasury,
    abi: TREASURY_EXECUTION_ABI,
    functionName: 'agent',
    args: [AGENT_ROLE_INDEX[role]],
  });
  if (authority.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(`custodied ${role} key ${signer} is not the treasury's ${role} agent (${authority})`);
  }
  if (!operational) throw new Error(`treasury ${role} agent is not operational`);
}

interface OnChainRequest {
  kind: number;
  status: number;
  amount: bigint;
  txPayloadHash: string;
}

type RequestPayloadFields = {
  kind: number;
  adapter: `0x${string}`;
  asset: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
  destChainId: bigint;
};

/** Mirrors PayloadHash.sol: the hash a request of each ExecutionKind must carry. */
export function expectedRequestPayloadHash(r: RequestPayloadFields): `0x${string}` {
  switch (r.kind) {
    case 0:
      return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }],
        [r.adapter, r.amount, r.asset],
      ));
    case 1:
      return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
        [r.asset, r.recipient, r.amount],
      ));
    case 2:
      return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
        [r.adapter, r.amount, r.asset, r.destChainId, r.recipient],
      ));
    default:
      throw new Error(`Unknown execution kind ${r.kind}`);
  }
}

/** ExecutionStatus values each action may start from, plus the required ExecutionKind. */
const ACTION_PRECONDITIONS: Partial<Record<EvmRelayAgentAction, { from: number[]; kind?: number }>> = {
  executive_approve: { from: [0] },
  financial_approve: { from: [1] },
  oversight_approve: { from: [2] },
  operational_halt: { from: [3, 4] },
  operational_clear: { from: [6] },
  expire_request: { from: [4] },
  execute_strategy: { from: [3, 4], kind: 0 },
  execute_strategy_direct: { from: [3, 4], kind: 0 },
  withdraw_from_strategy: { from: [5], kind: 0 },
  bridge_outbound: { from: [3, 4], kind: 2 },
};

/**
 * Refuse to sign unless the target is the treasury's own NaveExecution and the
 * request is in a state the action can legally leave. Catches a misrouted or
 * replayed relay before a custodied key is loaded.
 */
async function preflightEvmAgentAction(
  body: EvmRelayAgentActionRequest,
  target: `0x${string}`,
): Promise<OnChainRequest | null> {
  const client = evmPublicClient(body.chain_id);
  const execution = await client.readContract({
    address: body.dao_address as `0x${string}`,
    abi: TREASURY_EXECUTION_ABI,
    functionName: 'execution',
  });
  if (execution.toLowerCase() !== target.toLowerCase()) {
    throw new Error(`execution_address ${target} is not this treasury's NaveExecution (${execution})`);
  }
  const pre = ACTION_PRECONDITIONS[body.action];
  if (!pre) return null;
  const r = await client.readContract({
    address: target,
    abi: EXECUTION_REQUEST_ABI,
    functionName: 'getRequest',
    args: [asIndex(body.index)],
  });
  if (!r.exists) throw new Error(`execution request ${body.index} does not exist`);
  if (!pre.from.includes(r.status)) {
    throw new Error(`${body.action} cannot run from request status ${r.status}`);
  }
  if (pre.kind !== undefined && r.kind !== pre.kind) {
    throw new Error(`${body.action} requires request kind ${pre.kind}, found ${r.kind}`);
  }
  if (body.action === 'financial_approve' || body.action === 'oversight_approve') {
    const recomputed = expectedRequestPayloadHash(r);
    if (recomputed.toLowerCase() !== r.txPayloadHash.toLowerCase()) {
      throw new Error('on-chain request payload hash does not match its (adapter, asset, amount, recipient) fields');
    }
    if (body.tx_payload_hash && body.tx_payload_hash.toLowerCase() !== recomputed.toLowerCase()) {
      throw new Error('tx_payload_hash does not match the on-chain request payload');
    }
    if (body.adapter && body.adapter.toLowerCase() !== r.adapter.toLowerCase()) {
      throw new Error('adapter does not match the on-chain request');
    }
    if (body.asset && body.asset.toLowerCase() !== r.asset.toLowerCase()) {
      throw new Error('asset does not match the on-chain request');
    }
    if (body.amount !== undefined && body.amount !== null && body.amount !== '' && BigInt(body.amount) !== r.amount) {
      throw new Error('amount does not match the on-chain request');
    }
    return { kind: r.kind, status: r.status, amount: r.amount, txPayloadHash: recomputed };
  }
  return { kind: r.kind, status: r.status, amount: r.amount, txPayloadHash: r.txPayloadHash };
}

/** Testnet default: floor = amount × (1 − DEPOSIT_SLIPPAGE_BPS). */
function withDefaultMinOut(
  body: EvmRelayAgentActionRequest,
  request: OnChainRequest | null,
): EvmRelayAgentActionRequest {
  const omitted = body.min_out === undefined || body.min_out === null || body.min_out === '';
  if (!omitted || MAINNET_CHAIN_IDS.has(body.chain_id)) return body;
  let base: bigint | null = null;
  if (body.action === 'execute_strategy' || body.action === 'execute_strategy_direct') {
    base = request?.amount ?? null;
  } else if (body.action === 'withdraw_from_strategy' && body.amount !== undefined) {
    base = BigInt(body.amount);
  }
  if (base === null || base <= 0n) return body;
  const floor = (base * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n;
  return { ...body, min_out: (floor > 0n ? floor : 1n).toString() };
}

const ACTION_SPECS: Record<EvmRelayAgentAction, ActionSpec> = {
  executive_approve: {
    functionName: 'executiveApprove',
    role: 'executive',
    buildArgs: (r) => [asIndex(r.index), requireHash32(r.reasoning_hash, 'reasoning_hash')],
  },
  financial_approve: {
    functionName: 'financialApprove',
    role: 'financial',
    buildArgs: (r, _chainId, request) => [
      asIndex(r.index),
      requireHash32(request?.txPayloadHash, 'tx_payload_hash'),
      requireHash32(r.reasoning_hash, 'reasoning_hash'),
    ],
  },
  oversight_approve: {
    functionName: 'oversightApprove',
    role: 'oversight',
    buildArgs: (r, _chainId, request) => [
      asIndex(r.index),
      requireHash32(request?.txPayloadHash, 'tx_payload_hash'),
      requireHash32(r.reasoning_hash, 'reasoning_hash'),
    ],
  },
  operational_halt: {
    functionName: 'operationalHalt',
    role: 'operational',
    buildArgs: (r) => [asIndex(r.index), requireHash32(r.reasoning_hash, 'reasoning_hash')],
  },
  operational_clear: {
    functionName: 'operationalClear',
    role: 'operational',
    buildArgs: (r) => [asIndex(r.index), requireHash32(r.reasoning_hash, 'reasoning_hash')],
  },
  expire_request: {
    functionName: 'expireRequest',
    role: 'operational',
    buildArgs: (r) => [asIndex(r.index)],
  },
  // Post-review `execute` is Executive-only on-chain.
  execute_strategy: {
    functionName: 'execute',
    role: 'executive',
    buildArgs: (r, chainId) => [asIndex(r.index), resolveMinOut(r, chainId)],
  },
  // Break-glass direct execute is Executive-gated on-chain.
  execute_strategy_direct: {
    functionName: 'executeDirect',
    role: 'executive',
    buildArgs: (r, chainId) => [asIndex(r.index), resolveMinOut(r, chainId)],
  },
  // Strategy unwind is Executive-gated on-chain.
  withdraw_from_strategy: {
    functionName: 'withdrawFromStrategy',
    role: 'executive',
    buildArgs: (r, chainId) => [asIndex(r.index), asUint(r.amount, 'amount'), resolveMinOut(r, chainId)],
  },
  // Cross-chain bridge outbound: create request bound to bridgeHash payload.
  create_bridge_request: {
    functionName: 'createBridgeRequest',
    role: 'financial',
    buildArgs: (r) => {
      if (!r.adapter || !EVM_ADDRESS_RE.test(r.adapter)) {
        throw new Error('create_bridge_request requires adapter (20-byte address)');
      }
      if (!r.asset || !EVM_ADDRESS_RE.test(r.asset)) {
        throw new Error('create_bridge_request requires asset (20-byte address)');
      }
      if (!r.dest_treasury || !EVM_ADDRESS_RE.test(r.dest_treasury)) {
        throw new Error('create_bridge_request requires dest_treasury (20-byte address)');
      }
      if (r.dest_chain_id === undefined || r.dest_chain_id === null || r.dest_chain_id === '') {
        throw new Error('create_bridge_request requires dest_chain_id');
      }
      return [
        asIndex(r.index),
        asUint(r.amount, 'amount'),
        r.adapter as `0x${string}`,
        r.asset as `0x${string}`,
        BigInt(r.dest_chain_id),
        r.dest_treasury as `0x${string}`,
      ];
    },
  },
  // Post-review bridge execution (same Executive-only NaveExecution.execute).
  bridge_outbound: {
    functionName: 'execute',
    role: 'executive',
    buildArgs: (r, chainId) => [asIndex(r.index), resolveMinOut(r, chainId)],
  },
};

/**
 * Signing role behind each /relay-evm action (the custodied EOA or guardian
 * that will sign), used to pick the caller credential. Null = unknown action.
 */
export function evmRelaySignerRole(action: string): EvmSignerRole | null {
  if (action === 'toggle_agents') return 'guardian';
  if (
    action === 'update_strategy_position_value'
    || action === 'revalue_treasury'
    || action === 'create_proposal'
    || action === 'create_strategy_request'
    || action === 'finalize_proposal'
  ) {
    return 'operational';
  }
  return ACTION_SPECS[action as EvmRelayAgentAction]?.role ?? null;
}

/**
 * Relay a four-agent NaveExecution pipeline action as a transaction from the
 * custodied agent EOA. The EOA is loaded by (dao_address, chain_id, role) where
 * role is derived from the action; the tx TARGET is the per-DAO NaveExecution
 * contract (`execution_address` / `target_address`), NOT the treasury. Uses the
 * same hardened broadcast as the toggle path.
 */
export async function relayEvmAgentAction(body: EvmRelayAgentActionRequest): Promise<EvmRelayResult> {
  const { chain_id, action } = body;
  if (!isEvmChainId(chain_id)) {
    throw new Error(`Unsupported chain_id ${chain_id} (Ethereum, Base, Robinhood, Arc Testnet: 1, 8453, 4663, 11155111, 84532, 46630, 5042002)`);
  }
  const spec = ACTION_SPECS[action];
  if (!spec) {
    throw new Error(`Unsupported relay action '${action}'`);
  }
  if (!EVM_ADDRESS_RE.test(body.dao_address)) {
    throw new Error('dao_address must be a 20-byte EVM treasury address');
  }
  const target = body.execution_address ?? body.target_address;
  if (!target || !EVM_ADDRESS_RE.test(target)) {
    throw new Error('execution_address (NaveExecution contract) must be a 20-byte EVM address');
  }

  const request = await preflightEvmAgentAction(body, target as `0x${string}`);

  // Build + validate args BEFORE loading the key, so a malformed request fails
  // fast without touching the KEK / database.
  const args = spec.buildArgs(withDefaultMinOut(body, request), chain_id, request);

  // The EOA is custodied per (dao, chain, role); agents are never guardians.
  const account = await loadEvmAccount(body.dao_address, chain_id, spec.role);
  await assertOnChainAgent(chain_id, body.dao_address as `0x${string}`, spec.role, account.address);

  const { txHash, blockNumber, gasUsed } = await broadcastCall({
    chainId: chain_id,
    target: target as `0x${string}`,
    abi: EXECUTION_ABI,
    functionName: spec.functionName,
    args,
    account,
  });

  return {
    tx_hash: txHash,
    signer: account.address,
    signer_role: spec.role,
    function_name: spec.functionName,
    chain_id,
    block_number: blockNumber?.toString(),
    gas_used: gasUsed?.toString(),
    status: 'success',
  };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_FEED = `0x${'00'.repeat(32)}` as const;

const TREASURY_READ_ABI = [
  { type: 'function', name: 'governor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'governanceType', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'nextProposalIndex', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'execution', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getRegisteredAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  {
    type: 'function',
    name: 'assetInfo',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'registered', type: 'bool' },
      { name: 'enabled', type: 'bool' },
      { name: 'isStablecoin', type: 'bool' },
      { name: 'assetKind', type: 'uint8' },
      { name: 'pythFeedId', type: 'bytes32' },
      { name: 'decimals', type: 'uint8' },
    ],
  },
  { type: 'function', name: 'revalueTreasury', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const;

const ORACLE_PYTH_ABI = [
  { type: 'function', name: 'pyth', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const PYTH_UPDATE_ABI = [
  {
    type: 'function',
    name: 'getUpdateFee',
    stateMutability: 'view',
    inputs: [{ name: 'updateData', type: 'bytes[]' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'updatePriceFeeds',
    stateMutability: 'payable',
    inputs: [{ name: 'updateData', type: 'bytes[]' }],
    outputs: [],
  },
] as const;

const CREATE_PROPOSAL_ABI = [
  {
    type: 'function',
    name: 'createProposal',
    stateMutability: 'nonpayable',
    inputs: [{
      name: 'p',
      type: 'tuple',
      components: [
        { name: 'title', type: 'string' },
        { name: 'description', type: 'string' },
        { name: 'payload', type: 'bytes' },
        { name: 'proposalType', type: 'uint8' },
        { name: 'votingPeriodSeconds', type: 'uint256' },
        { name: 'votingMint', type: 'address' },
      ],
    }],
    outputs: [{ name: 'index', type: 'uint64' }],
  },
] as const;

const CREATE_STRATEGY_REQUEST_ABI = [
  {
    type: 'function',
    name: 'createStrategyRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'proposalIndex', type: 'uint64' },
      { name: 'amount', type: 'uint256' },
      { name: 'adapter', type: 'address' },
      { name: 'asset', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const FINALIZE_PROPOSAL_ABI = [
  {
    type: 'function',
    name: 'finalizeProposal',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'index', type: 'uint64' }],
    outputs: [],
  },
] as const;

/** Permissionless NaveGovernor.finalizeProposal. Reverts while voting is open and the outcome is not yet certain. */
export async function relayEvmFinalizeProposal(body: {
  chain_id: number;
  dao_address: string;
  proposal_index: string | number | bigint;
}): Promise<{ txHash: Hash }> {
  const { chain_id, dao_address } = body;
  if (!isEvmChainId(chain_id)) throw new Error(`Unsupported chain_id ${chain_id}`);
  if (!EVM_ADDRESS_RE.test(dao_address)) throw new Error('dao_address must be a 20-byte EVM address');
  const index = BigInt(body.proposal_index);
  if (index < 0n) throw new Error('proposal_index must be non-negative');
  const client = evmPublicClient(chain_id);
  const governor = await client.readContract({
    address: dao_address as `0x${string}`,
    abi: TREASURY_READ_ABI,
    functionName: 'governor',
  });
  if (!EVM_ADDRESS_RE.test(governor) || governor === ZERO_ADDRESS) throw new Error('Treasury governor is unset');
  const account = await loadEvmAccount(dao_address, chain_id, 'operational');
  const { txHash } = await broadcastCall({
    chainId: chain_id,
    target: governor,
    abi: FINALIZE_PROPOSAL_ABI,
    functionName: 'finalizeProposal',
    args: [index],
    account,
  });
  return { txHash };
}

export interface EvmCreateStrategyRequest {
  chain_id: number;
  dao_address: string;
  proposal_index: string | number | bigint;
  adapter: string;
  asset: string;
  amount: string | number | bigint;
}

/**
 * Permissionless NaveExecution.createStrategyRequest for a passed Strategy
 * proposal. The contract rejects anything but a passed proposal whose payload
 * hash equals (adapter, amount, asset). The request index is the proposal index.
 */
export async function relayEvmCreateStrategyRequest(
  body: EvmCreateStrategyRequest,
): Promise<{ txHash: Hash; executionAddress: string; index: string }> {
  const { chain_id, dao_address } = body;
  if (!isEvmChainId(chain_id)) throw new Error(`Unsupported chain_id ${chain_id}`);
  if (!EVM_ADDRESS_RE.test(dao_address) || !EVM_ADDRESS_RE.test(body.adapter) || !EVM_ADDRESS_RE.test(body.asset)) {
    throw new Error('dao_address, adapter, and asset must be 20-byte EVM addresses');
  }
  const amount = BigInt(body.amount);
  const index = BigInt(body.proposal_index);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (index < 0n) throw new Error('proposal_index must be non-negative');

  const client = evmPublicClient(chain_id);
  const execution = await client.readContract({
    address: dao_address as `0x${string}`,
    abi: TREASURY_READ_ABI,
    functionName: 'execution',
  });
  if (!EVM_ADDRESS_RE.test(execution) || execution === ZERO_ADDRESS) {
    throw new Error('Treasury execution contract is unset');
  }
  const account = await loadEvmAccount(dao_address, chain_id, 'operational');
  const { txHash } = await broadcastCall({
    chainId: chain_id,
    target: execution,
    abi: CREATE_STRATEGY_REQUEST_ABI,
    functionName: 'createStrategyRequest',
    args: [index, amount, body.adapter as `0x${string}`, body.asset as `0x${string}`],
    account,
  });
  return { txHash, executionAddress: execution.toLowerCase(), index: index.toString() };
}

export interface EvmCreateProposalRequest {
  chain_id: number;
  dao_address: string;
  adapter: string;
  asset: string;
  amount: string | number | bigint;
  title?: string;
  description?: string;
  voting_mint?: string;
}

export interface EvmCreateProposalResult {
  txHash: Hash;
  proposalAddress: string;
  proposalIndex: string;
  payloadHash: string;
  signer: string;
}

function evmPublicClient(chainId: number): PublicClient {
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) throw new Error(`Unsupported chain_id ${chainId}`);
  return createPublicClient({ chain: cfg.chain, transport: http(rpcUrlFor(chainId)) }) as PublicClient;
}

/**
 * Permissionless NaveGovernor.createProposal for a strategy payload
 * `abi.encode(adapter, amount, asset)`. Signed by the custodied operational
 * EOA (createProposal is not role-gated; planner keys are Solana-only).
 */
export async function relayEvmCreateProposal(body: EvmCreateProposalRequest): Promise<EvmCreateProposalResult> {
  const { chain_id, dao_address } = body;
  if (!isEvmChainId(chain_id)) {
    throw new Error(`Unsupported chain_id ${chain_id}`);
  }
  if (!EVM_ADDRESS_RE.test(dao_address) || !EVM_ADDRESS_RE.test(body.adapter) || !EVM_ADDRESS_RE.test(body.asset)) {
    throw new Error('dao_address, adapter, and asset must be 20-byte EVM addresses');
  }
  const amount = BigInt(body.amount);
  if (amount < 0n) throw new Error('amount must be non-negative');

  const client = evmPublicClient(chain_id);
  const treasury = dao_address as `0x${string}`;
  const [governor, govType, proposalIndex] = await Promise.all([
    client.readContract({ address: treasury, abi: TREASURY_READ_ABI, functionName: 'governor' }),
    client.readContract({ address: treasury, abi: TREASURY_READ_ABI, functionName: 'governanceType' }),
    client.readContract({ address: treasury, abi: TREASURY_READ_ABI, functionName: 'nextProposalIndex' }),
  ]);
  if (!EVM_ADDRESS_RE.test(governor) || governor === ZERO_ADDRESS) {
    throw new Error('Treasury governor is unset');
  }

  const votingMint = govType === 0
    ? ZERO_ADDRESS
    : (body.voting_mint ?? '');
  if (govType !== 0 && !EVM_ADDRESS_RE.test(votingMint)) {
    throw new Error('token governance requires voting_mint');
  }

  const payload = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }],
    [body.adapter as `0x${string}`, amount, body.asset as `0x${string}`],
  );
  const payloadHash = keccak256(payload);
  const title = (body.title || 'Strategy').slice(0, 64);
  const description = (body.description || title).slice(0, 256);

  const account = await loadEvmAccount(dao_address, chain_id, 'operational');
  const { txHash } = await broadcastCall({
    chainId: chain_id,
    target: governor,
    abi: CREATE_PROPOSAL_ABI,
    functionName: 'createProposal',
    args: [{
      title,
      description,
      payload,
      proposalType: 1,
      votingPeriodSeconds: evmStrategyVotingPeriodSeconds(chain_id, true),
      votingMint: votingMint as `0x${string}`,
    }],
    account,
  });

  return {
    txHash,
    proposalAddress: `evm:${chain_id}:${governor}:${proposalIndex.toString()}`,
    proposalIndex: proposalIndex.toString(),
    payloadHash,
    signer: account.address,
  };
}

export interface EvmRevalueResult extends EvmRelayResult {
  price_update_tx?: string;
}

/**
 * Post Hermes updates to the treasury's Pyth contract (when assets have a
 * non-zero feed), then call revalueTreasury from the operational EOA.
 * Throws with a `pyth price post failed` prefix when the keeper cannot post,
 * so the orchestrator parks the deploy on the existing stale-NAV reason.
 */
export async function relayEvmRevalueTreasury(body: { chain_id: number; dao_address: string }): Promise<EvmRevalueResult> {
  const { chain_id, dao_address } = body;
  if (!isEvmChainId(chain_id)) throw new Error(`Unsupported chain_id ${chain_id}`);
  if (!EVM_ADDRESS_RE.test(dao_address)) throw new Error('dao_address must be a 20-byte EVM treasury address');

  const client = evmPublicClient(chain_id);
  const treasury = dao_address as `0x${string}`;
  const account = await loadEvmAccount(dao_address, chain_id, 'operational');

  let priceUpdateTx: Hash | undefined;
  try {
    const [oracle, assets] = await Promise.all([
      client.readContract({ address: treasury, abi: TREASURY_READ_ABI, functionName: 'oracle' }),
      client.readContract({ address: treasury, abi: TREASURY_READ_ABI, functionName: 'getRegisteredAssets' }),
    ]);
    const feedIds: string[] = [];
    for (const asset of assets) {
      const info = await client.readContract({
        address: treasury,
        abi: TREASURY_READ_ABI,
        functionName: 'assetInfo',
        args: [asset],
      });
      const feed = info[4];
      if (feed && feed.toLowerCase() !== ZERO_FEED) feedIds.push(feed);
    }
    if (feedIds.length > 0) {
      if (!EVM_ADDRESS_RE.test(oracle) || oracle === ZERO_ADDRESS) {
        throw new Error('treasury oracle is unset');
      }
      const pyth = await client.readContract({
        address: oracle,
        abi: ORACLE_PYTH_ABI,
        functionName: 'pyth',
      });
      if (!EVM_ADDRESS_RE.test(pyth) || pyth === ZERO_ADDRESS) {
        throw new Error('Pyth contract is unset on the oracle');
      }
      const updateData = await fetchHermesUpdateData(feedIds);
      const fee = await client.readContract({
        address: pyth,
        abi: PYTH_UPDATE_ABI,
        functionName: 'getUpdateFee',
        args: [updateData],
      });
      const posted = await broadcastCall({
        chainId: chain_id,
        target: pyth,
        abi: PYTH_UPDATE_ABI,
        functionName: 'updatePriceFeeds',
        args: [updateData],
        account,
        value: fee,
      });
      priceUpdateTx = posted.txHash;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`pyth price post failed: ${detail}`);
  }

  const { txHash, blockNumber, gasUsed } = await broadcastCall({
    chainId: chain_id,
    target: treasury,
    abi: TREASURY_READ_ABI,
    functionName: 'revalueTreasury',
    args: [],
    account,
  });

  return {
    tx_hash: txHash,
    signer: account.address,
    signer_role: 'operational',
    function_name: 'revalueTreasury',
    chain_id,
    block_number: blockNumber?.toString(),
    gas_used: gasUsed?.toString(),
    status: 'success',
    ...(priceUpdateTx ? { price_update_tx: priceUpdateTx } : {}),
  };
}

// ── EVM agent wallet gas replenishment ────────────────────────────────────────

export interface EvmAgentWalletResult {
  role: string;
  address: string;
  balanceWei: bigint;
  toppedUp: boolean;
  topUpWei: bigint;
  txHash?: Hash;
}

const DEFAULT_EVM_AGENT_MIN_GAS = '0.002';
const DEFAULT_EVM_AGENT_TARGET_GAS = '0.005';
const EVM_OPS_RESERVE_WEI = parseEther('0.0005');

function parseEtherEnv(envName: string, defaultEther: string): bigint {
  const raw = process.env[envName]?.trim();
  if (!raw) return parseEther(defaultEther);
  try {
    const val = parseEther(raw);
    return val > 0n ? val : parseEther(defaultEther);
  } catch {
    return parseEther(defaultEther);
  }
}

function loadEvmOpsAccount(): ReturnType<typeof privateKeyToAccount> | null {
  const raw = (process.env.NAVE_EVM_OPS_PRIVATE_KEY || process.env.EVM_OPS_PRIVATE_KEY || '').trim();
  if (!raw) return null;
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    console.error('[evm-relayer] EVM_OPS_PRIVATE_KEY / NAVE_EVM_OPS_PRIVATE_KEY is set but not a 32-byte hex key.');
    return null;
  }
  try {
    return privateKeyToAccount(hex);
  } catch {
    return null;
  }
}

/**
 * Check native gas balances of the DAO's custodied `executive`, `financial`,
 * `oversight`, `operational`, and `guardian` EOAs on `chainId` (`11155111`,
 * `84532`, `46630`, `5042002`, etc.) and top them up from the relayer ops
 * wallet (`EVM_OPS_PRIVATE_KEY` / `NAVE_EVM_OPS_PRIVATE_KEY`) when below the
 * safe minimum (`0.002` native gas by default).
 */
export async function replenishEvmAgentWallets(
  daoAddress: string,
  chainId: number,
): Promise<EvmAgentWalletResult[]> {
  if (!isEvmChainId(chainId) || !CHAIN_CONFIG[chainId]) {
    throw new Error(`Unsupported EVM chain_id ${chainId}`);
  }
  if (!EVM_ADDRESS_RE.test(daoAddress)) {
    throw new Error('daoAddress must be a 20-byte EVM address');
  }

  const cfg = CHAIN_CONFIG[chainId];
  const transport = http(rpcUrlFor(chainId));
  const publicClient = createPublicClient({ chain: cfg.chain, transport }) as PublicClient;
  const opsAccount = loadEvmOpsAccount();
  const minBalanceWei = parseEtherEnv('NAVE_EVM_AGENT_MIN_GAS', DEFAULT_EVM_AGENT_MIN_GAS);
  const rawTargetWei = parseEtherEnv('NAVE_EVM_AGENT_TARGET_GAS', DEFAULT_EVM_AGENT_TARGET_GAS);
  const targetBalanceWei = rawTargetWei > minBalanceWei ? rawTargetWei : minBalanceWei * 2n;

  const targets: Array<{ label: string; account: LoadedAccount }> = [];
  const seenAddresses = new Set<string>();

  const pipelineRoles: Array<Exclude<EvmSignerRole, 'guardian'>> = [
    'executive',
    'financial',
    'oversight',
    'operational',
  ];
  for (const role of pipelineRoles) {
    try {
      const account = await loadEvmAccount(daoAddress, chainId, role);
      const addrKey = account.address.toLowerCase();
      if (!seenAddresses.has(addrKey)) {
        seenAddresses.add(addrKey);
        targets.push({ label: role, account });
      }
    } catch {
      // Key not custodied for this role — skip gracefully.
    }
  }

  for (let i = 0; i < MAX_CUSTODIED_GUARDIANS; i++) {
    try {
      const account = await loadEvmAccount(daoAddress, chainId, 'guardian', i);
      const addrKey = account.address.toLowerCase();
      if (!seenAddresses.has(addrKey)) {
        seenAddresses.add(addrKey);
        targets.push({ label: `guardian#${i}`, account });
      }
    } catch {
      break; // first missing guardian slot ends the custodied guardian set
    }
  }

  const results: EvmAgentWalletResult[] = [];
  for (const { label, account } of targets) {
    try {
      const balanceWei = await publicClient.getBalance({ address: account.address });
      if (balanceWei >= minBalanceWei) {
        results.push({
          role: label,
          address: account.address,
          balanceWei,
          toppedUp: false,
          topUpWei: 0n,
        });
        continue;
      }

      const neededWei = targetBalanceWei - balanceWei;
      if (!opsAccount) {
        console.warn(
          `[evm-relayer] ${label}@${daoAddress} (chain ${chainId}) balance ${formatEther(balanceWei)} < ${formatEther(minBalanceWei)}, ` +
          `but EVM_OPS_PRIVATE_KEY / NAVE_EVM_OPS_PRIVATE_KEY is not configured.`,
        );
        results.push({
          role: label,
          address: account.address,
          balanceWei,
          toppedUp: false,
          topUpWei: 0n,
        });
        continue;
      }

      if (opsAccount.address.toLowerCase() === account.address.toLowerCase()) {
        results.push({
          role: label,
          address: account.address,
          balanceWei,
          toppedUp: false,
          topUpWei: 0n,
        });
        continue;
      }

      const txHash = await withSenderLock(chainId, opsAccount.address, async () => {
        const opsBalance = await publicClient.getBalance({ address: opsAccount.address });
        if (opsBalance < neededWei + EVM_OPS_RESERVE_WEI) {
          throw new Error(
            `EVM ops wallet ${opsAccount.address} balance ${formatEther(opsBalance)} on chain ${chainId} ` +
            `is insufficient to top up ${label} (${account.address}) by ${formatEther(neededWei)}`,
          );
        }
        const wallet = createWalletClient({ account: opsAccount, chain: cfg.chain, transport });
        const nonce = await publicClient.getTransactionCount({ address: opsAccount.address, blockTag: 'latest' });
        const hash = await wallet.sendTransaction({
          account: opsAccount,
          chain: cfg.chain,
          to: account.address,
          value: neededWei,
          nonce,
        });
        const confirmations = receiptConfirmations();
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: confirmations > 0 ? confirmations : undefined,
          timeout: receiptTimeoutMs(),
        });
        if (receipt.status !== 'success') {
          throw new Error(`EVM top-up tx ${hash} reverted on chain ${chainId}`);
        }
        return hash;
      });

      const finalBalanceWei = await publicClient.getBalance({ address: account.address });
      console.log(
        `[evm-relayer] Replenished ${label}@${daoAddress} (chain ${chainId}): +${formatEther(neededWei)} ` +
        `(${formatEther(balanceWei)} → ${formatEther(finalBalanceWei)}, tx ${txHash})`,
      );
      results.push({
        role: label,
        address: account.address,
        balanceWei: finalBalanceWei,
        toppedUp: true,
        topUpWei: neededWei,
        txHash,
      });
    } catch (err) {
      console.error(
        `[evm-relayer] replenishEvmAgentWallets ${label}@${daoAddress} (chain ${chainId}):`,
        err instanceof Error ? err.message : err,
      );
      results.push({
        role: label,
        address: account.address,
        balanceWei: -1n,
        toppedUp: false,
        topUpWei: 0n,
      });
    }
  }

  return results;
}
