import { createDecipheriv } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, TypedDataDomain } from 'viem';
import { isEvmKekConfigured, unwrapStoredDek } from './kek.js';

// ─── EVM (secp256k1 + EIP-712) GUARDIAN signing for Nave ─────────────────────
//
// Counterpart to the Ed25519 Solana signing in index.ts. Server-custodied
// guardian signers are stored in encrypted_evm_keys and unwrapped via the EVM
// master KEK (NAVE_EVM_MASTER_KEK, fallback NAVE_MASTER_KEK).
//
// IMPORTANT — this module only signs GUARDIAN actions. The four agent roles
// (executive/financial/oversight/operational) do NOT sign EIP-712 on EVM: their
// on-chain approvals are msg.sender-gated TRANSACTIONS on NaveExecution and are
// RELAYED via evmRelayer.ts (/relay-evm), not signed here.
//
// Guardian actions use NaveTreasury's hand-rolled EIP-712 domain:
//   domain = { name: "NaveTreasury", version: "1", chainId, verifyingContract:
//             the per-clone treasury (DAO) address — NaveTreasury._domainSeparator
//             binds to its own address(this) }
//   struct = GuardianAction(uint8 actionType, uint8 agentSlot, uint8 newStatus,
//             address newKey, uint64 nonce)
// The treasury verifies an ARRAY of these signatures (M-of-N bitmask) and
// consumes the digest. Solana flows are entirely unaffected.

export type EvmSignerRole = 'executive' | 'financial' | 'oversight' | 'operational' | 'guardian';

export type EvmChainKind = 'ethereum' | 'base' | 'robinhood' | 'arc';

/** Numeric chain id → kind. Arc mainnet 5042 is not included. */
export const EVM_CHAIN_ID_TO_KIND: Record<number, EvmChainKind> = {
  1: 'ethereum',
  11155111: 'ethereum',
  8453: 'base',
  84532: 'base',
  4663: 'robinhood',
  46630: 'robinhood',
  5042002: 'arc',
};

/**
 * Guardian M-of-N action discriminants — mirrors contracts/evm
 * src/libraries/NaveEnums.sol `GuardianActionType`. These are the uint8
 * `actionType` field of the EIP-712 GuardianAction struct.
 */
export const GUARDIAN_ACTION_TYPE = {
  FREEZE: 0,
  UNFREEZE: 1,
  UPDATE_AGENT_STATUS: 2,
  ROTATE_AGENT_KEY: 3,
  DISABLE_AGENTS: 4,
  CANCEL_RECOVERY: 5,
  /** Parity with Solana nullify_agent; EVM discriminant is 6 (CANCEL_RECOVERY owns 5). */
  NULLIFY_AGENT: 6,
  ENABLE_AGENTS: 7,
  RESTORE_AGENT: 8,
  CANCEL_AGENT_ROTATION: 9,
} as const;

export type GuardianActionName = keyof typeof GUARDIAN_ACTION_TYPE;

export function isEvmChainId(id: number): boolean {
  return Object.prototype.hasOwnProperty.call(EVM_CHAIN_ID_TO_KIND, id);
}

let supabaseSingleton: ReturnType<typeof createClient> | null = null;
function getSupabase(): ReturnType<typeof createClient> {
  if (supabaseSingleton) return supabaseSingleton;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  supabaseSingleton = createClient(url, key);
  return supabaseSingleton;
}

interface EvmKeyRow {
  evm_address: string;
  encrypted_private_key: string;
  encryption_iv: string;
  encryption_tag: string;
  wrapped_dek: string | null;
  dek_wrap_iv: string | null;
  dek_wrap_tag: string | null;
  dek_wrap_version: number | null;
  dek_kek_ref: string | null;
}

/** Decrypt an AES-256-GCM ciphertext into a 0x-hex secp256k1 private key. */
function decryptPrivateKey(dekBase64: string, ct: string, iv: string, tag: string): Hex {
  const key = Buffer.from(dekBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
  // Accept either 32 raw bytes or a (0x-prefixed) hex string as the plaintext.
  if (plain.length === 32) return `0x${plain.toString('hex')}` as Hex;
  const s = plain.toString('utf8').trim();
  const hex = s.startsWith('0x') ? s : `0x${s}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Decrypted EVM key is not a 32-byte secp256k1 private key');
  }
  return hex as Hex;
}

/**
 * Load + decrypt an EVM signer account from encrypted_evm_keys. Verifies the
 * derived address matches the stored evm_address (wrong-KEK / corruption guard).
 */
export async function loadEvmAccount(
  daoAddress: string,
  chainId: number,
  role: EvmSignerRole,
  guardianIndex?: number,
): Promise<ReturnType<typeof privateKeyToAccount>> {
  if (!isEvmKekConfigured()) {
    throw new Error('No EVM KEK configured (set NAVE_EVM_MASTER_KEK or NAVE_MASTER_KEK)');
  }

  let query = getSupabase()
    .from('encrypted_evm_keys')
    .select(
      'evm_address, encrypted_private_key, encryption_iv, encryption_tag, wrapped_dek, dek_wrap_iv, dek_wrap_tag, dek_wrap_version, dek_kek_ref',
    )
    .eq('dao_onchain_address', daoAddress.toLowerCase())
    .eq('chain_id', chainId)
    .eq('signer_role', role)
    .eq('is_active', true);

  query = guardianIndex === undefined || guardianIndex === null
    ? query.is('guardian_index', null)
    : query.eq('guardian_index', guardianIndex);

  const { data, error } = await query.maybeSingle<EvmKeyRow>();
  if (error || !data) {
    throw new Error(
      `No active EVM key for ${role}${guardianIndex != null ? `#${guardianIndex}` : ''}@${daoAddress} (chain ${chainId}): ${error?.message ?? 'not found'}`,
    );
  }

  if (!data.wrapped_dek || !data.dek_wrap_iv || !data.dek_wrap_tag) {
    throw new Error('EVM key row is missing the wrapped DEK envelope fields');
  }

  const dek = unwrapStoredDek(
    'evm',
    {
      wrapped_dek: data.wrapped_dek,
      dek_wrap_iv: data.dek_wrap_iv,
      dek_wrap_tag: data.dek_wrap_tag,
      dek_wrap_version: data.dek_wrap_version,
      dek_kek_ref: data.dek_kek_ref,
    },
    {
      dao: daoAddress.toLowerCase(),
      role: guardianIndex === undefined || guardianIndex === null ? role : `guardian#${guardianIndex}`,
      chain: `evm:${chainId}`,
    },
  );
  const privKey = decryptPrivateKey(
    dek,
    data.encrypted_private_key,
    data.encryption_iv,
    data.encryption_tag,
  );
  const account = privateKeyToAccount(privKey);
  if (account.address.toLowerCase() !== data.evm_address.toLowerCase()) {
    throw new Error('Decrypted EVM key does not match stored evm_address (wrong KEK?)');
  }
  return account;
}

// ─── EIP-712 typed data ──────────────────────────────────────────────────────
// Canonical schema for the NaveTreasury GUARDIAN action flow. Matches the
// contract exactly (NaveTreasury.GUARDIAN_ACTION_TYPEHASH + _domainSeparator):
//   GuardianAction(uint8 actionType,uint8 agentSlot,uint8 newStatus,address newKey,uint64 nonce,uint64 deadline)
// Only this struct is ever signed: the custodied guardian key never signs
// caller-supplied typed data or a domain other than its own treasury.

// Domain name defaults to the treasury domain. (env override allowed, but the
// contract hard-codes "NaveTreasury" so this should not normally be changed.)
const EIP712_DOMAIN_NAME = process.env.NAVE_EVM_EIP712_NAME || 'NaveTreasury';
const EIP712_DOMAIN_VERSION = process.env.NAVE_EVM_EIP712_VERSION || '1';

const GUARDIAN_ACTION_TYPES = {
  GuardianAction: [
    { name: 'actionType', type: 'uint8' },
    { name: 'agentSlot', type: 'uint8' },
    { name: 'newStatus', type: 'uint8' },
    { name: 'newKey', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

const ZERO_ADDRESS: Address = `0x${'0'.repeat(40)}`;

function domainFor(chainId: number, verifyingContract: Address): TypedDataDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

export interface EvmGuardianSignRequest {
  chain?: string;
  chain_id: number;
  /**
   * NaveTreasury (DAO) address. This is BOTH the key-lookup key AND the EIP-712
   * verifyingContract — the treasury computes _domainSeparator() over its own
   * address(this), so the per-clone domain binds to the DAO address.
   */
  dao_address: string;
  /** Must be 'guardian' — the four agent roles relay txs, they do not sign. */
  agent_role: EvmSignerRole;
  /** Which custodied guardian signer to use (M-of-N). Defaults to 0. */
  guardian_index?: number;
  /** Optional; must equal dao_address when given (the domain is pinned to the treasury). */
  verifying_contract?: string;
  /** GuardianAction.actionType — name (e.g. 'FREEZE') or raw uint8 (0-9). */
  action_type?: GuardianActionName | number;
  /** GuardianAction.agentSlot (0-3); 0 for freeze/unfreeze/disable. */
  agent_slot?: number;
  /** GuardianAction.newStatus (AgentStatus 0-3); only for UPDATE_AGENT_STATUS. */
  new_status?: number;
  /** GuardianAction.newKey; only for ROTATE_AGENT_KEY (else address(0)). */
  new_key?: string;
  /** GuardianAction.nonce (uint64) — the treasury consumes the digest to dedupe. */
  nonce?: number | string;
  /**
   * GuardianAction.deadline (uint64 unix seconds). Required for the on-chain
   * EIP-712 digest (matches NaveTreasury GUARDIAN_ACTION_TYPEHASH). All M
   * guardians must sign the SAME deadline.
   */
  deadline?: number | string;
}

export interface EvmSignResult {
  signature: Hex;
  signer: Address;
  primary_type: string;
  chain_id: number;
  domain: TypedDataDomain;
}

function asAddress(v: string, label: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${label} must be a 20-byte EVM address`);
  return v.toLowerCase() as Address;
}

const MAX_GUARDIAN_ACTION_TYPE = Math.max(...Object.values(GUARDIAN_ACTION_TYPE));

/** Resolve a guardian actionType from a name or a raw discriminant. */
function resolveActionType(v: GuardianActionName | number | undefined): number {
  if (v === undefined || v === null) {
    throw new Error(`action_type is required (${Object.keys(GUARDIAN_ACTION_TYPE).join('|')} or 0-${MAX_GUARDIAN_ACTION_TYPE})`);
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > MAX_GUARDIAN_ACTION_TYPE) {
      throw new Error(`Invalid action_type ${v} (expected 0-${MAX_GUARDIAN_ACTION_TYPE})`);
    }
    return v;
  }
  const mapped = GUARDIAN_ACTION_TYPE[v];
  if (mapped === undefined) throw new Error(`Invalid action_type '${v}'`);
  return mapped;
}

/**
 * Produce an EIP-712 GuardianAction signature for one custodied guardian. The
 * guardian's secp256k1 key is loaded from encrypted_evm_keys; the returned
 * signature is what NaveTreasury aggregates on-chain (M-of-N bitmask).
 *
 * Agents do NOT sign on EVM: executive/financial/oversight/operational
 * approvals are msg.sender-gated transactions relayed via /relay-evm
 * (relayEvmAgentAction). Any non-guardian agent_role is rejected here.
 */
export async function signEvmApproval(body: EvmGuardianSignRequest): Promise<EvmSignResult> {
  const { chain_id, dao_address, agent_role } = body;

  if (!isEvmChainId(chain_id)) {
    throw new Error(`Unsupported chain_id ${chain_id} (Ethereum, Base, Robinhood, Arc Testnet: 1, 8453, 4663, 11155111, 84532, 46630, 5042002)`);
  }
  if (agent_role !== 'guardian') {
    throw new Error(
      `agent_role '${agent_role}' cannot sign on EVM: the four agent roles use /relay-evm (msg.sender tx from the agent EOA), not EIP-712 signing. Only 'guardian' signs here.`,
    );
  }

  if ((body as { typed_data?: unknown }).typed_data !== undefined) {
    throw new Error('typed_data is not accepted: the guardian key only signs the canonical GuardianAction struct');
  }
  const verifyingContract = asAddress(dao_address, 'dao_address');
  if (body.verifying_contract !== undefined && asAddress(body.verifying_contract, 'verifying_contract') !== verifyingContract) {
    throw new Error('verifying_contract must equal dao_address');
  }
  const domain = domainFor(chain_id, verifyingContract);

  const account = await loadEvmAccount(dao_address, chain_id, 'guardian', body.guardian_index ?? 0);

  const actionType = resolveActionType(body.action_type);
  const agentSlot = body.agent_slot ?? 0;
  if (!Number.isInteger(agentSlot) || agentSlot < 0 || agentSlot > 3) {
    throw new Error(`Invalid agent_slot ${agentSlot} (expected 0-3)`);
  }
  const newStatus = body.new_status ?? 0;
  if (!Number.isInteger(newStatus) || newStatus < 0 || newStatus > 3) {
    throw new Error(`Invalid new_status ${newStatus} (expected 0-3)`);
  }
  const newKey = body.new_key ? asAddress(body.new_key, 'new_key') : ZERO_ADDRESS;
  const nonce = BigInt(body.nonce ?? 0);
  if (body.deadline === undefined || body.deadline === null || body.deadline === '') {
    throw new Error('deadline is required (unix seconds; all M guardians must sign the same value)');
  }
  const deadline = BigInt(body.deadline);

  const message = {
    actionType,
    agentSlot,
    newStatus,
    newKey,
    nonce,
    deadline,
  };
  const signature = await account.signTypedData({
    domain,
    types: GUARDIAN_ACTION_TYPES,
    primaryType: 'GuardianAction',
    message,
  });
  return { signature, signer: account.address, primary_type: 'GuardianAction', chain_id, domain };
}

/** @deprecated Back-compat alias — `EvmSignRequest` is now guardian-only. */
export type EvmSignRequest = EvmGuardianSignRequest;
