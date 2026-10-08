// ─── NAVE bridge relayer client (trusted-relayer MVP) ────────────────────────
// Thin client for the Nave bridge relayer (signer-service). After the browser
// locks NAVE on Solana or burns WrappedNave on EVM, it POSTs the source tx here;
// the relayer mints/releases on the destination chain.
//
// SECURITY NOTE — no secret in the browser:
//   The relayer's privileged endpoints require an `X-Signer-Secret` header
//   server-side. The browser MUST NOT hold that secret (it would be trivially
//   extractable from the bundle). Instead, `/bridge-relay` is PUBLIC-BUT-VERIFYING:
//   it independently re-derives and verifies the on-chain source transaction
//   (lock transfer into custody / burn event) before acting, so it does not need
//   to trust the caller for whether funds moved. We therefore deliberately send
//   NO secret header here.
//
//   That on-chain check alone does NOT prove who is entitled to name the
//   destination `recipient` — the source tx only proves funds moved, not who
//   authorized the payout address. `payload.senderSignature` closes that gap:
//   the caller must sign the (sourceTx, recipient) pair with the SAME wallet
//   that submitted sourceTx, so a third party who merely observes someone
//   else's public lock/burn cannot redirect the payout to themselves.

import { NAVE_BRIDGE_RELAYER_URL } from '../programConfig';
import { supabase } from '../supabaseClient';
import type { BridgeRelayPayload, BridgeRelayResponse } from './types';

/**
 * Submit a locked/burned source transaction to the relayer for destination-side
 * mint/release. Returns a typed response; any non-2xx or network failure is
 * mapped to `{ status: 'failed', error }` so callers never have to try/catch.
 */
export async function submitBridgeRelay(
  payload: BridgeRelayPayload,
): Promise<BridgeRelayResponse> {
  if (!NAVE_BRIDGE_RELAYER_URL) {
    return { status: 'failed', error: 'Bridge relayer is not configured for this environment.' };
  }

  const endpoint = `${NAVE_BRIDGE_RELAYER_URL.replace(/\/+$/, '')}/bridge-relay`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        // Intentionally no X-Signer-Secret: the endpoint verifies the on-chain
        // source tx itself, so the browser holds no relayer credential.
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    let body: Partial<BridgeRelayResponse> = {};
    try {
      body = (await res.json()) as Partial<BridgeRelayResponse>;
    } catch {
      // Non-JSON body (e.g. gateway error page) — fall through to status handling.
    }

    if (!res.ok) {
      return {
        status: 'failed',
        error: body.error || `Relayer responded ${res.status} ${res.statusText}`.trim(),
      };
    }

    return {
      status: body.status ?? 'submitted',
      destTxHash: body.destTxHash ?? (body as { dest_tx?: string }).dest_tx,
      transferId: body.transferId ?? (body as { id?: string }).id,
      feeRaw: body.feeRaw ?? (body as { fee_raw?: string }).fee_raw,
      netRaw: body.netRaw ?? (body as { net_raw?: string }).net_raw,
      evmChainId: (() => {
        const raw = body.evmChainId ?? (body as { evm_chain_id?: number | string | null }).evm_chain_id;
        return raw == null || raw === '' ? undefined : Number(raw);
      })(),
      error: body.error,
    };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Failed to reach the bridge relayer.',
    };
  }
}

/**
 * Read the live status of a bridge transfer directly from `bridge_transfers`
 * (public read-only via RLS — see the table's migration). Used to poll for
 * completion independently of the original `/bridge-relay` HTTP request, so
 * the UI can keep showing "pending" → "completed"/"failed" even if the
 * browser navigates away/refreshes or the original fetch is interrupted —
 * the relayer's own work (verify + mint/release) continues server-side
 * regardless, and this lets the UI catch up to it.
 */
export async function fetchBridgeTransferStatus(
  sourceTx: string,
): Promise<BridgeRelayResponse | null> {
  const { data, error } = await supabase
    .from('bridge_transfers')
    .select('status, dest_tx, error, fee_raw, net_raw')
    .eq('source_tx', sourceTx)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as {
    status: string;
    dest_tx: string | null;
    error: string | null;
    fee_raw: string | number | null;
    net_raw: string | number | null;
  };
  return {
    status: row.status,
    destTxHash: row.dest_tx ?? undefined,
    feeRaw: row.fee_raw != null ? String(row.fee_raw) : undefined,
    netRaw: row.net_raw != null ? String(row.net_raw) : undefined,
    error: row.error ?? undefined,
  };
}
