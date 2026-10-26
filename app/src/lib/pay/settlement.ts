/**
 * Books a chain settlement against an invoice without trusting a client total.
 *
 * USDC converts at par. Any other asset uses a price from the cache when one
 * is supplied. With no price, the raw amount is kept and USD is left for a
 * manual payment. Amounts above the open balance are an unclassified inflow,
 * not an overpayment that would close the invoice the wrong way.
 */

import { formatCents } from './invoiceMath';

export interface SettlementQuoteInput {
  openCents: number;
  rawAmount: bigint;
  decimals: number;
  /** Null when the price cache has no row for this asset. */
  priceUsd: number | null;
  stable: boolean;
  /** Void invoices cannot take a payment. The whole receipt is unclassified. */
  voided?: boolean;
  assetLabel?: string;
}

export interface SettlementQuote {
  usdBooked: boolean;
  quotedCents: number;
  appliedCents: number;
  excessCents: number;
  excessNote: string;
  rawAmount: string;
}

function divRoundHalfAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('bad divisor');
  const neg = numerator < 0n;
  const value = neg ? -numerator : numerator;
  const quotient = value / denominator;
  const remainder = value % denominator;
  const rounded = quotient + (remainder * 2n >= denominator ? 1n : 0n);
  return neg ? -rounded : rounded;
}

/** USD cents for an atomic amount at a positive USD price. Half away from zero. */
export function rawToCents(rawAmount: bigint, decimals: number, priceUsd: number): number {
  if (rawAmount <= 0n || !(priceUsd > 0) || decimals < 0 || decimals > 36) return 0;
  const priceE8 = BigInt(Math.round(priceUsd * 1e8));
  if (priceE8 <= 0n) return 0;
  const denominator = 10n ** BigInt(decimals) * 100_000_000n;
  const cents = divRoundHalfAway(rawAmount * priceE8 * 100n, denominator);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('settlement amount is too large');
  }
  return Number(cents);
}

export function quoteSettlement(input: SettlementQuoteInput): SettlementQuote {
  const rawAmount = input.rawAmount < 0n ? 0n : input.rawAmount;
  const label = input.assetLabel?.trim() || 'asset';
  const base = {
    rawAmount: rawAmount.toString(),
    quotedCents: 0,
    appliedCents: 0,
    excessCents: 0,
    excessNote: '',
    usdBooked: false,
  };
  if (rawAmount === 0n) {
    return { ...base, excessNote: 'Zero amount. Nothing was booked.' };
  }

  const price = input.stable ? 1 : input.priceUsd;
  if (price == null || !(price > 0)) {
    return {
      ...base,
      excessNote: `Unpriced ${label} receipt of ${rawAmount.toString()} base units. USD booking is left for a manual payment.`,
    };
  }

  const quoted = rawToCents(rawAmount, input.decimals, price);
  if (quoted <= 0) {
    return {
      ...base,
      excessNote: `Unpriced ${label} receipt of ${rawAmount.toString()} base units. The USD value rounds to zero, so it is left for a manual payment.`,
    };
  }

  const open = input.voided ? 0 : Math.max(0, Math.trunc(input.openCents));
  const applied = Math.min(quoted, open);
  const excess = quoted - applied;
  let excessNote = '';
  if (input.voided) {
    excessNote = `Unclassified inflow of ${formatCents(quoted)}. The invoice is void, so none of it was applied.`;
  } else if (excess > 0) {
    excessNote = `Unclassified inflow of ${formatCents(excess)} above the open invoice balance. The excess was not applied to the invoice.`;
  }

  return {
    usdBooked: true,
    quotedCents: quoted,
    appliedCents: applied,
    excessCents: excess,
    excessNote,
    rawAmount: rawAmount.toString(),
  };
}
