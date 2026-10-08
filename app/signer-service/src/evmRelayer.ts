import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseGwei, type Hash, type PublicClient } from 'viem';
import { mainnet, base, sepolia, baseSepolia } from 'viem/chains';
import type { Chain } from 'viem';
import { loadEvmAccount, isEvmChainId, signEvmApproval, type EvmSignerRole } from './evmSigner.js';
import { robinhood, robinhoodTestnet } from './evmChains.js';
import { fetchHermesUpdateData } from './evmPythKeeper.js';

// Scope: Ethereum + Base + Robinhood (1/8453/4663 + testnets).

/** chain_id → { viem chain, RPC env var }. */
const CHAIN_CONFIG: Record<number, { chain: Chain; rpcEnv: string }> = {
  1: { chain: mainnet, rpcEnv: 'EVM_ETHEREUM_RPC_URL' },
  11155111: { chain: sepolia, rpcEnv: 'EVM_SEPOLIA_RPC_URL' },
  8453: { chain: base, rpcEnv: 'EVM_BASE_RPC_URL' },
  84532: { chain: baseSepolia, rpcEnv: 'EVM_BASE_SEPOLIA_RPC_URL' },
  4663: { chain: robinhood, rpcEnv: 'EVM_ROBINHOOD_RPC_URL' },
  46630: { chain: robinhoodTestnet, rpcEnv: 'EVM_ROBINHOOD_TESTNET_RPC_URL' },
};

/** Mainnet chain ids — a positive `minOut` slippage floor is REQUIRED here. */
const MAINNET_CHAIN_IDS = new Set<number>([1, 8453, 4663]);

// Minimal NaveTreasury ABI for the agent toggle path. Resume is the Executive
// agent's msg.sender-gated `toggleAgents(true)`; pause is the guardian M-of-N
// EIP-712 `guardianDisableAgents` (the single-actor `emergencyPauseAgents` was
// removed from the contracts — it let one custodied key open the
// `executeDirect` review-window bypass).
const TREASURY_TOGGLE_ABI = [
  { type: 'function', name: 'toggleAgents', stateMutability: 'nonpayable', inputs: [{ name: 'enabled', type: 'bool' }], outputs: [] },
  {
    type: 'function',
    name: 'guardianDisableAgents',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'nonce', type: 'uint64' },
      { name: 'deadline', type: 'uint64' },
      { name: 'signatures', type: 'bytes[]' },
    ],
    outputs: [],
  },
] as const;

/** Upper bound on custodied guardian slots probed for the pause quorum. */
const MAX_CUSTODIED_GUARDIANS = 10;
/** Default validity of a pause digest (contract stale bound is 7 days). */
const DISABLE_AGENTS_DEADLINE_SECS = 3600;

// Minimal NaveTreasury ABI for the position-oracle tick (mirrors Solana's
// `update_strategy_position_value`). `updateStrategyPositionValue` is gated
// on-chain to `founder || Operational agent` (see NaveTreasury.sol); the
// relayer always uses the custodied Operational agent EOA, matching the
// Solana signer's requirement that this action be signed by `operational`.
const TREASURY_POSITION_ABI = [
  {
    type: 'function',
    name: 'updateStrategyPositionValue',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'adapter', type: 'address' }, { name: 'newValue', type: 'uint256' }],
    outputs: [],
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
  { type: 'function', name: 'operationalClear', stateMutability: 'nonpayable', inputs: [{ name: 'index', type: 'uint64' }], outputs: [] },
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
const DEFAULT_MAX_GAS = 600_000n;
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
   * the union to `guardianDisableAgents`.
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
  /** NaveTreasury (DAO) address — also the tx TARGET for this action. */
  dao_address: string;
  /** Adapter address the position is keyed by (NaveTreasury.position(adapter)). */
  adapter: string;
  /** New marked value (base units) for `TreasuryStrategyLib.Position.currentValue`. */
  new_value: number | string;
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
  /** bytes32 tx payload hash bound at request creation (financial/oversight). */
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
  /** guardianDisableAgents only: custodied guardian addresses that signed. */
  guardian_signers?: string[];
  /** guardianDisableAgents only: total signatures submitted (custodied + external). */
  guardian_signature_count?: number;
  /** guardianDisableAgents only: GuardianAction nonce / deadline used. */
  nonce?: string;
  deadline?: string;
}

function rpcUrlFor(chainId: number): string {
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) throw new Error(`Unsupported chain_id ${chainId} (Ethereum, Base, Robinhood)`);
  const url = process.env[cfg.rpcEnv];
  if (!url) throw new Error(`Relayer RPC not configured: set ${cfg.rpcEnv} for chain ${chainId}`);
  return url;
}

type LoadedAccount = Awaited<ReturnType<typeof loadEvmAccount>>;

/**
 * Shared hardened broadcast for a single contract call from a custodied EOA.
 * Centralizes the relayer safety pattern used by BOTH the treasury toggle and
 * the NaveExecution pipeline relay:
 *  - per-chain client (Ethereum vs Base, mainnet vs testnet) from CHAIN_CONFIG;
 *  - gas estimate with a hard cap (estimateContractGas also surfaces a revert —
 *    e.g. caller is not the authorized agent — BEFORE we spend broadcasting);
 *  - 12% gas headroom (never above the cap);
 *  - EIP-1559 fees with a maxFeePerGas ceiling (refuse to broadcast into a spike);
 *  - explicit pending nonce so back-to-back relays don't collide;
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
  const gasLimit = (() => {
    const buffered = (gas * 112n) / 100n;
    return buffered > gasCap ? gasCap : buffered;
  })();

  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  const feeCap = maxFeePerGasCap();
  if (maxFeePerGas !== undefined && maxFeePerGas > feeCap) {
    throw new Error(
      `Network maxFeePerGas ${maxFeePerGas} exceeds relayer cap ${feeCap} (set NAVE_EVM_RELAY_MAX_FEE_GWEI to override) — refusing to relay during fee spike`,
    );
  }

  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });

  const txHash = await wallet.writeContract({
    address: target,
    abi: abi as never,
    functionName: functionName as never,
    args: args as never,
    chain: cfg.chain,
    account,
    gas: gasLimit,
    nonce,
    ...(value !== undefined ? { value } : {}),
    ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
    ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
  });

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
      `No custodied guardian key bound for ${treasury} (chain ${chainId}); cannot assemble the guardianDisableAgents quorum`,
    );
  }
  return { signatures, signers, broadcaster };
}

/**
 * Submit the agent pause/resume toggle on-chain from the appropriate custodied
 * EOA. Resume → Executive agent calls `toggleAgents(true)` (msg.sender-gated).
 * Pause → guardian M-of-N `guardianDisableAgents(nonce, deadline, sigs)`: the
 * relayer signs with every custodied guardian it holds, appends any externally
 * supplied guardian signatures (founder wallet), and broadcasts from the
 * custodied guardian EOA. If the on-chain threshold is not met the call
 * reverts `InvalidGuardianThreshold` — the caller must gather more signatures
 * over the SAME nonce/deadline and retry.
 */
export async function relayEvmAgentToggle(body: EvmRelayToggleRequest): Promise<EvmRelayResult> {
  const { chain_id, enabled } = body;
  if (!isEvmChainId(chain_id)) {
    throw new Error(`Unsupported chain_id ${chain_id} (Ethereum, Base, Robinhood: 1, 8453, 4663, 11155111, 84532, 46630)`);
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
    functionName: 'guardianDisableAgents',
    args: [nonce, deadline, signatures],
    account: custodied.broadcaster,
  });

  return {
    tx_hash: txHash,
    signer: custodied.broadcaster.address,
    signer_role: 'guardian',
    function_name: 'guardianDisableAgents',
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
 * Submit a position-oracle tick on-chain: `NaveTreasury.updateStrategyPositionValue`
 * from the custodied Operational agent EOA. Unlike the NaveExecution pipeline
 * relay below, the tx TARGET is the treasury itself (`dao_address`), not a
 * `NaveExecution` clone — mirrors Solana's `update_strategy_position_value`,
 * which is also signed by the operational agent.
 */
export async function relayEvmUpdateStrategyPositionValue(
  body: EvmRelayUpdatePositionValueRequest,
): Promise<EvmRelayResult> {
  const { chain_id, dao_address, adapter } = body;
  if (!isEvmChainId(chain_id)) {
    throw new Error(`Unsupported chain_id ${chain_id} (Ethereum, Base, Robinhood: 1, 8453, 4663, 11155111, 84532, 46630)`);
  }
  if (!EVM_ADDRESS_RE.test(dao_address)) {
    throw new Error('dao_address must be a 20-byte EVM treasury address');
  }
  if (!EVM_ADDRESS_RE.test(adapter)) {
    throw new Error('adapter must be a 20-byte EVM address');
  }
  const newValue = asUint(body.new_value, 'new_value');

  const account = await loadEvmAccount(dao_address, chain_id, 'operational');

  const { txHash, blockNumber, gasUsed } = await broadcastCall({
    chainId: chain_id,
    target: dao_address as `0x${string}`,
    abi: TREASURY_POSITION_ABI,
    functionName: 'updateStrategyPositionValue',
    args: [adapter as `0x${string}`, newValue],
    account,
  });

  return {
    tx_hash: txHash,
    signer: account.address,
    signer_role: 'operational',
    function_name: 'updateStrategyPositionValue',
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
  buildArgs: (req: EvmRelayAgentActionRequest, chainId: number) => readonly unknown[];
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

/**
 * Resolve `minOut`. On mainnet a positive slippage floor is REQUIRED (an
 * unbounded minOut=0 join/exit invites sandwiching); testnets may pass 0.
 */
function resolveMinOut(req: EvmRelayAgentActionRequest, chainId: number): bigint {
  const provided = req.min_out;
  if (MAINNET_CHAIN_IDS.has(chainId)) {
    if (provided === undefined || provided === null || provided === '') {
      throw new Error(`min_out is required (> 0) on mainnet chain ${chainId}`);
    }
    const n = BigInt(provided);
    if (n <= 0n) throw new Error(`min_out must be positive on mainnet chain ${chainId}`);
    return n;
  }
  // Testnet: default to 0 when omitted.
  if (provided === undefined || provided === null || provided === '') return 0n;
  const n = BigInt(provided);
  if (n < 0n) throw new Error('min_out must be non-negative');
  return n;
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
    buildArgs: (r) => [
      asIndex(r.index),
      requireHash32(r.tx_payload_hash, 'tx_payload_hash'),
      requireHash32(r.reasoning_hash, 'reasoning_hash'),
    ],
  },
  oversight_approve: {
    functionName: 'oversightApprove',
    role: 'oversight',
    buildArgs: (r) => [
      asIndex(r.index),
      requireHash32(r.tx_payload_hash, 'tx_payload_hash'),
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
    buildArgs: (r) => [asIndex(r.index)],
  },
  expire_request: {
    functionName: 'expireRequest',
    role: 'operational',
    buildArgs: (r) => [asIndex(r.index)],
  },
  // `execute` is permissionless on-chain, but it still needs a funded EOA to
  // originate + pay; we relay it from the Operational agent (matches the Solana
  // orchestrator, which drives post-review execution from the operational role).
  execute_strategy: {
    functionName: 'execute',
    role: 'operational',
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
  // Post-review bridge execution (same NaveExecution.execute as strategy).
  bridge_outbound: {
    functionName: 'execute',
    role: 'operational',
    buildArgs: (r, chainId) => [asIndex(r.index), resolveMinOut(r, chainId)],
  },
};

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
    throw new Error(`Unsupported chain_id ${chain_id} (Ethereum, Base, Robinhood: 1, 8453, 4663, 11155111, 84532, 46630)`);
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

  // Build + validate args BEFORE loading the key, so a malformed request fails
  // fast without touching the KEK / database.
  const args = spec.buildArgs(body, chain_id);

  // The EOA is custodied per (dao, chain, role); agents are never guardians.
  const account = await loadEvmAccount(body.dao_address, chain_id, spec.role);

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
/** 7 days — inside NaveConstants MIN_VOTING_PERIOD (1h) and MAX (30d). */
const EVM_STRATEGY_VOTING_PERIOD = 604_800n;

const TREASURY_READ_ABI = [
  { type: 'function', name: 'governor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'governanceType', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'nextProposalIndex', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
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
      votingPeriodSeconds: EVM_STRATEGY_VOTING_PERIOD,
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
