import { keccak256, toHex } from 'viem';
import { supabase } from './supabaseClient';
import { fetchEvmProposalPayloadHash } from './evm/readers';
import type { EvmChainId } from './chain/types';

/**
 * Server-side EVM proposal payload index.
 *
 * The EVM governor stores only `keccak256(payload)` on-chain, so ratifying or
 * executing a proposal requires recovering the original payload bytes. The
 * creator writes them here; any device reads them back. Every recovered payload
 * is verified against the authoritative on-chain `payloadHash` before use, so a
 * malicious/garbage row is harmless (it fails verification and is skipped).
 */

const TABLE = 'evm_proposal_payloads';

function bytesToHex(payload: number[]): `0x${string}` {
  return toHex(Uint8Array.from(payload.map((b) => b & 0xff)));
}

/** Persist a proposal payload to the server index (best-effort, fire-and-forget). */
export async function storeEvmProposalPayloadRemote(
  chainId: EvmChainId,
  daoAddress: string,
  proposalIndex: number,
  type: string,
  payload: number[],
): Promise<void> {
  if (!payload.length) return;
  try {
    await supabase.from(TABLE).insert({
      chain_id: chainId,
      dao_address: daoAddress.toLowerCase(),
      proposal_index: proposalIndex,
      proposal_type: type,
      payload_hex: bytesToHex(payload),
    });
  } catch {
    /* best-effort: localStorage remains the primary cache */
  }
}

/**
 * Recover a proposal payload from the server index, VERIFIED against the
 * on-chain payload hash. Returns the byte array, or null if no candidate
 * matches the on-chain hash.
 */
export async function loadEvmProposalPayloadRemote(
  chainId: EvmChainId,
  daoAddress: string,
  proposalIndex: number,
): Promise<number[] | null> {
  try {
    const onchainHash = await fetchEvmProposalPayloadHash(chainId, daoAddress, proposalIndex);
    if (!onchainHash) return null;

    const { data, error } = await supabase
      .from(TABLE)
      .select('payload_hex')
      .eq('chain_id', chainId)
      .eq('dao_address', daoAddress.toLowerCase())
      .eq('proposal_index', proposalIndex);
    if (error || !data) return null;

    for (const row of data as { payload_hex: string }[]) {
      const hex = row.payload_hex as `0x${string}`;
      if (!hex || !hex.startsWith('0x')) continue;
      // Only trust a candidate whose keccak256 matches the on-chain hash.
      if (keccak256(hex).toLowerCase() !== onchainHash.toLowerCase()) continue;
      const body = hex.slice(2);
      const bytes: number[] = [];
      for (let i = 0; i < body.length; i += 2) {
        bytes.push(parseInt(body.slice(i, i + 2), 16));
      }
      return bytes;
    }
    return null;
  } catch {
    return null;
  }
}
