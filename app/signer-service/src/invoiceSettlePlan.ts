/**
 * Decides whether the signer should crank invoice settles.
 * No router and no Solana program id means the whole tick is a no-op.
 * This module does not read keys, RPC endpoints, or env files.
 */

export const INVOICE_SETTLE_BATCH = 10;

export type InvoiceAddressKind = 'solana_vault' | 'solana_ata' | 'evm_forwarder';

export interface InvoiceSettleConfig {
  solanaProgramId: string | null;
  /** chain id -> NavePaymentRouter address */
  routers: Record<string, string>;
}

export interface SettleCandidate {
  chain: string;
  chainId: number | null;
  kind: InvoiceAddressKind;
  address: string;
  asset: string;
  invoiceId: string;
  invoiceIdHex: string;
  dao: string;
  balance: bigint;
}

function addressMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
        out[key] = value.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Null when nothing is configured. Callers must not broadcast in that case. */
export function readInvoiceSettleConfig(
  env: Record<string, string | undefined>,
): InvoiceSettleConfig | null {
  const solana = env.NAVE_PAY_SOLANA_PROGRAM_ID?.trim() || null;
  const routers = addressMap(env.NAVE_PAY_ROUTERS);
  if (!solana && Object.keys(routers).length === 0) return null;
  return { solanaProgramId: solana, routers };
}

export function selectSettleWork(
  config: InvoiceSettleConfig | null,
  candidates: SettleCandidate[],
): SettleCandidate[] {
  if (!config) return [];
  return candidates.filter((row) => {
    if (row.balance <= 0n) return false;
    if (row.kind === 'evm_forwarder') {
      return row.chainId != null && Boolean(config.routers[String(row.chainId)]);
    }
    return Boolean(config.solanaProgramId);
  }).slice(0, INVOICE_SETTLE_BATCH);
}

/**
 * Runs `work` only when settle config is present. An empty env never calls it,
 * so tests can pass a sender that would broadcast and still observe a no-op.
 */
export async function runSettleTick<T>(
  env: Record<string, string | undefined>,
  work: () => Promise<T>,
): Promise<{ status: 'noop'; reason: 'config_absent' } | { status: 'ran'; value: T }> {
  if (!readInvoiceSettleConfig(env)) return { status: 'noop', reason: 'config_absent' };
  return { status: 'ran', value: await work() };
}
