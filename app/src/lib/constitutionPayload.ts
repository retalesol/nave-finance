// ═══════════════════════════════════════════════════════════════════════════════
// Constitution policy proposal payload
//
// When a member proposes a constitution change, the policy parameters are
// serialized into the governance proposal's on-chain `payload` (≤512 bytes).
// After the proposal passes and is finalized, the founder "ratifies" it: the
// payload is decoded and applied on-chain via `update_constitution`, which is
// what binds the autonomous agents to the new policy.
//
// The payload is compact JSON so it stays under the 512-byte on-chain cap
// (`MAX_PROPOSAL_PAYLOAD_LEN`) while remaining trivially decodable on ratify.
// Wire version 2 stores approved protocol ids and caps only. Adapter addresses
// are resolved at ratify time, because embedding them pushes three protocols
// past 512 bytes. Version 1 payloads (full objects, including adapters) still
// decode.
// ═══════════════════════════════════════════════════════════════════════════════

import { decodeAbiParameters, encodeAbiParameters } from 'viem';

/** On-chain-applicable protocol entry (mirrors `ProtocolInput`). */
export interface ConstitutionPayloadProtocol {
  id: string;
  approved: boolean;
  maxAllocationBps: number;
  /** EVM adapter contract address. Solana payloads omit this. */
  adapter?: string;
}

export interface ConstitutionPolicyPayload {
  /** schema version */
  v: 1;
  /** protocol approvals applied via update_constitution */
  protocols: ConstitutionPayloadProtocol[];
  /** Claude confidence threshold (0-100) or null to leave unchanged */
  confidenceThreshold: number | null;
  // ── Treasury policy parameters (applied via set_policy_parameters) ──
  riskPreset?: string;
  /** percentages (0-100); converted to bps on ratify */
  minStablecoin?: number;
  maxDeployment?: number;
  maxLending?: number;
  liquidityReserve?: number;
  /** human label (Hourly/Daily/Weekly/Bi-weekly/Monthly/Manual) */
  rebalanceFreq?: string;
}

/** Convert a rebalance cadence label to seconds (0 = manual / disabled). */
export function rebalanceLabelToSeconds(label: string | undefined): number {
  switch ((label ?? '').toLowerCase()) {
    case 'hourly':
      return 3600;
    case 'daily':
      return 86_400;
    case 'weekly':
      return 604_800;
    case 'bi-weekly':
      return 1_209_600;
    case 'monthly':
      return 2_592_000;
    case 'manual':
    default:
      return 0;
  }
}

/** On-chain `MAX_PROPOSAL_PAYLOAD_LEN`; keep in sync with the governance program. */
export const MAX_PROPOSAL_PAYLOAD_LEN = 512;

const MARKER = 'nave-constitution';

function bytesToHex(bytes: Uint8Array | number[]): `0x${string}` {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return `0x${Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Invalid hex payload length.');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function assertEvmAddress(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    throw new Error(`${label} must be a valid EVM address.`);
  }
  return value.trim() as `0x${string}`;
}

/**
 * Serialize a constitution policy into proposal payload bytes.
 * Throws if the encoded payload exceeds the on-chain limit.
 * Only approved protocols are stored; ratification replaces the on-chain set.
 */
export function encodeConstitutionPayload(payload: ConstitutionPolicyPayload): number[] {
  const approved = payload.protocols.filter((p) => p.approved);
  const body: Record<string, unknown> = {
    k: MARKER,
    v: 2,
    p: approved.map((p) => [p.id, p.maxAllocationBps]),
    c: payload.confidenceThreshold,
  };
  if (payload.riskPreset) body.r = payload.riskPreset;
  if (
    payload.minStablecoin != null
    || payload.maxDeployment != null
    || payload.maxLending != null
    || payload.liquidityReserve != null
  ) {
    body.m = [
      payload.minStablecoin ?? 0,
      payload.maxDeployment ?? 0,
      payload.maxLending ?? 0,
      payload.liquidityReserve ?? 0,
    ];
  }
  if (payload.rebalanceFreq) body.f = payload.rebalanceFreq;
  const json = JSON.stringify(body);
  const bytes = Array.from(new TextEncoder().encode(json));
  if (bytes.length > MAX_PROPOSAL_PAYLOAD_LEN) {
    throw new Error(
      `Constitution payload is ${bytes.length} bytes — exceeds the ${MAX_PROPOSAL_PAYLOAD_LEN}-byte on-chain limit. Reduce the number of approved protocols.`,
    );
  }
  return bytes;
}

/**
 * Decode proposal payload bytes (or a UTF-8 string) back into a policy.
 * Returns null when the payload is empty or not a recognized constitution payload.
 */
export function decodeConstitutionPayload(
  payload: Uint8Array | number[] | string | null | undefined,
): ConstitutionPolicyPayload | null {
  if (payload == null) return null;
  let json: string;
  if (typeof payload === 'string') {
    json = payload;
  } else {
    const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
    if (bytes.length === 0) return null;
    json = new TextDecoder().decode(bytes);
    while (json.endsWith('\0')) {
      json = json.slice(0, -1);
    }
  }
  json = json.trim();
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (obj.k !== MARKER) return null;
    if (obj.v === 2 && Array.isArray(obj.p)) {
      const metrics = Array.isArray(obj.m) ? obj.m : [];
      return {
        v: 1,
        protocols: obj.p.flatMap((entry) => {
          if (!Array.isArray(entry) || entry.length < 2) return [];
          return [{
            id: String(entry[0]),
            approved: true,
            maxAllocationBps: Number(entry[1]) || 0,
          }];
        }),
        confidenceThreshold: obj.c == null ? null : Number(obj.c),
        riskPreset: obj.r != null ? String(obj.r) : undefined,
        minStablecoin: metrics[0] != null ? Number(metrics[0]) : undefined,
        maxDeployment: metrics[1] != null ? Number(metrics[1]) : undefined,
        maxLending: metrics[2] != null ? Number(metrics[2]) : undefined,
        liquidityReserve: metrics[3] != null ? Number(metrics[3]) : undefined,
        rebalanceFreq: obj.f != null ? String(obj.f) : undefined,
      };
    }
    if (!Array.isArray(obj.protocols)) return null;
    return {
      v: 1,
      protocols: (obj.protocols as ConstitutionPayloadProtocol[]).map((p) => ({
        id: String(p.id),
        approved: !!p.approved,
        maxAllocationBps: Number(p.maxAllocationBps) || 0,
        adapter: p.adapter != null ? String(p.adapter) : undefined,
      })),
      confidenceThreshold:
        obj.confidenceThreshold == null ? null : Number(obj.confidenceThreshold),
      riskPreset: obj.riskPreset != null ? String(obj.riskPreset) : undefined,
      minStablecoin: obj.minStablecoin != null ? Number(obj.minStablecoin) : undefined,
      maxDeployment: obj.maxDeployment != null ? Number(obj.maxDeployment) : undefined,
      maxLending: obj.maxLending != null ? Number(obj.maxLending) : undefined,
      liquidityReserve: obj.liquidityReserve != null ? Number(obj.liquidityReserve) : undefined,
      rebalanceFreq: obj.rebalanceFreq != null ? String(obj.rebalanceFreq) : undefined,
    };
  } catch {
    return null;
  }
}

// ── EVM proposal payloads ────────────────────────────────────────────────────
// These encodings intentionally use EVM ABI-shaped data, never Solana PublicKey
// byte layouts. They mirror the post-pass EVM ratification writers.

export interface EvmTokenMintPayload {
  mint: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
}

export function encodeEvmTokenMintPayload(payload: EvmTokenMintPayload): number[] {
  const hex = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [
      assertEvmAddress(payload.mint, 'Token mint'),
      assertEvmAddress(payload.to, 'Mint recipient'),
      payload.amount,
    ],
  );
  return Array.from(hexToBytes(hex));
}

export function decodeEvmTokenMintPayload(bytes: Uint8Array | number[] | string): EvmTokenMintPayload {
  const hex = typeof bytes === 'string' ? bytes as `0x${string}` : bytesToHex(bytes);
  const [mint, to, amount] = decodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    hex,
  );
  return { mint, to, amount };
}

export interface EvmSwitchVotingPayload {
  governanceType: 0 | 1;
  votingToken: `0x${string}`;
}

export function encodeEvmSwitchVotingPayload(payload: EvmSwitchVotingPayload): number[] {
  const hex = encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'address' }],
    [payload.governanceType, assertEvmAddress(payload.votingToken, 'Voting token')],
  );
  return Array.from(hexToBytes(hex));
}

export interface EvmStrategyRequestPayload {
  adapter: `0x${string}`;
  asset: `0x${string}`;
  amount: bigint;
}

export function decodeEvmStrategyRequestPayload(bytes: Uint8Array | number[] | string): EvmStrategyRequestPayload {
  const hex = typeof bytes === 'string' ? bytes as `0x${string}` : bytesToHex(bytes);
  const [adapter, asset, amount] = decodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    hex,
  );
  return { adapter, asset, amount };
}

export interface EvmTransferRequestPayload {
  asset: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
}

export function decodeEvmTransferRequestPayload(bytes: Uint8Array | number[] | string): EvmTransferRequestPayload {
  const hex = typeof bytes === 'string' ? bytes as `0x${string}` : bytesToHex(bytes);
  const [asset, recipient, amount] = decodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    hex,
  );
  return { asset, recipient, amount };
}

export function encodeEvmTransferRequestPayload(payload: EvmTransferRequestPayload): number[] {
  const hex = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [
      assertEvmAddress(payload.asset, 'Asset'),
      assertEvmAddress(payload.recipient, 'Recipient'),
      payload.amount,
    ],
  );
  return Array.from(hexToBytes(hex));
}
