// ─── NAVE devnet faucet client ────────────────────────────────────────────────
// Thin client for the signer-service's /faucet-claim endpoint. Reuses the same
// relayer base URL as the bridge (same signer-service instance) — there is no
// separate faucet deployment.

import { NAVE_BRIDGE_RELAYER_URL } from './programConfig';

export interface FaucetClaimResponse {
  success: boolean;
  signature?: string;
  amountRaw?: string;
  error?: string;
  retry_after_seconds?: number;
  dimension?: 'address' | 'ip' | 'global';
}

/**
 * Request 0.1 NAVE (devnet) for `address`. Maps any non-2xx or network
 * failure into `{ success: false, error }` so callers never need to try/catch.
 */
export async function submitFaucetClaim(address: string): Promise<FaucetClaimResponse> {
  return postFaucetClaim('/faucet-claim', address);
}

/**
 * Request 0.05 devnet SOL for `address` (same faucet wallet, separate
 * endpoint + cooldown from the NAVE claim).
 */
export async function submitSolFaucetClaim(address: string): Promise<FaucetClaimResponse> {
  return postFaucetClaim('/faucet-claim-sol', address);
}

async function postFaucetClaim(path: string, address: string): Promise<FaucetClaimResponse> {
  if (!NAVE_BRIDGE_RELAYER_URL) {
    return { success: false, error: 'Faucet is not configured for this environment.' };
  }

  const endpoint = `${NAVE_BRIDGE_RELAYER_URL.replace(/\/+$/, '')}${path}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });

    let body: Partial<FaucetClaimResponse> = {};
    try {
      body = (await res.json()) as Partial<FaucetClaimResponse>;
    } catch {
      // Non-JSON body — fall through to status handling.
    }

    if (!res.ok) {
      return {
        success: false,
        error: body.error || `Faucet responded ${res.status} ${res.statusText}`.trim(),
        retry_after_seconds: body.retry_after_seconds,
        dimension: body.dimension,
      };
    }

    return { success: true, signature: body.signature, amountRaw: body.amountRaw };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to reach the faucet.',
    };
  }
}
