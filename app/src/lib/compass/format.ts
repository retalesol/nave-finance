import { evmTarget, isEvmChainId } from '../chain/types';

export function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatCount(value: unknown): string {
  return new Intl.NumberFormat('en-US').format(asNumber(value));
}

export function formatCents(value: unknown): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(asNumber(value) / 100);
}

export function formatUsd(value: unknown): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(asNumber(value));
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(time);
}

export function chainLabel(chain: string, chainId: number | null): string {
  if (chain === 'solana' || chainId == null) return 'Solana';
  if (isEvmChainId(chainId)) return evmTarget(chainId).label;
  return chain || `Chain ${chainId}`;
}

export function shortAddress(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function subscriptionLabel(state: string): string {
  if (state === 'active') return 'Active';
  if (state === 'grace') return 'Grace';
  if (state === 'locked') return 'Locked';
  if (state === 'purged') return 'Purged';
  return 'None';
}

export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function recordEntries(record: Record<string, number> | null | undefined): [string, number][] {
  return Object.entries(record ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
}
