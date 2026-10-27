/**
 * Parse a treasury amount into base units.
 *
 * Accepts what people actually type: "0.5", ".5", "0,5", and a trailing dot.
 * Extra digits past the asset precision are rounded to that precision so a
 * valid amount is not rejected for floating-point residue.
 */

export function parseUiAmount(value: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const normalized = normalizeUiAmount(value);
  if (normalized == null) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const rounded = roundToDecimals(whole, fraction, decimals);
  const frac = rounded.fraction.padEnd(decimals, '0');
  const raw = `${rounded.whole}${frac}`.replace(/^0+/, '') || '0';
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** Display form of an accepted amount, without trailing zeros. */
export function completeUiAmount(value: string, decimals: number): string | null {
  const units = parseUiAmount(value, decimals);
  if (units == null) return null;
  return formatBaseUnits(units, decimals);
}

export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) return amount.toString();
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  if (decimals === 0) return `${negative ? '-' : ''}${abs.toString()}`;
  const text = abs.toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals).replace(/^0+/, '') || '0';
  const frac = text.slice(text.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

function normalizeUiAmount(value: string): string | null {
  let text = value.trim().replace(/\s+/g, '').replace(/\$/g, '');
  if (!text) return null;
  if (text.includes(',') && text.includes('.')) text = text.replace(/,/g, '');
  else if (text.includes(',')) text = text.replace(',', '.');
  text = text.replace(/[．﹒]/g, '.');
  if (text.endsWith('.')) text = text.slice(0, -1);
  if (text.startsWith('.')) text = `0${text}`;
  if (/e/i.test(text)) {
    const asNumber = Number(text);
    if (!Number.isFinite(asNumber) || asNumber < 0) return null;
    text = asNumber.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
  }
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return match[2] != null ? `${match[1]}.${match[2]}` : match[1];
}

function roundToDecimals(whole: string, fraction: string, decimals: number): { whole: string; fraction: string } {
  if (fraction.length <= decimals) return { whole, fraction };
  const roundUp = fraction[decimals] >= '5';
  const kept = fraction.slice(0, decimals);
  if (!roundUp) return { whole, fraction: kept };
  const digits = `${whole}${kept}`.replace(/^0+/, '') || '0';
  const bumped = (BigInt(digits) + 1n).toString();
  if (decimals === 0) return { whole: bumped, fraction: '' };
  const padded = bumped.padStart(decimals + 1, '0');
  return {
    whole: padded.slice(0, padded.length - decimals).replace(/^0+/, '') || '0',
    fraction: padded.slice(padded.length - decimals),
  };
}
