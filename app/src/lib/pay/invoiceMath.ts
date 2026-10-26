/**
 * Invoice math ported from nave-books/lib/core.php.
 *
 * Money is integer cents. Quantity is qty * 10000. Tax rate is percent * 1000
 * (8.25% -> 8250). Discount is applied before tax and allocated pro-rata to
 * taxable lines. The server recomputes totals from these inputs and ignores
 * any amount the client already calculated.
 */

export class InvoiceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceInputError';
  }
}

export type InvoiceLifecycle = 'draft' | 'sent' | 'void';
export type InvoiceDisplayStatus = 'draft' | 'open' | 'partial' | 'paid' | 'overdue' | 'void';

export interface InvoiceLineInput {
  description?: string;
  qty?: string | number;
  rate?: string | number;
  taxable?: boolean;
}

export interface InvoiceLine {
  description: string;
  qtyE4: number;
  rateCents: number;
  taxable: boolean;
  amountCents: number;
}

export interface InvoiceTotals {
  lines: InvoiceLine[];
  subtotalCents: number;
  taxableCents: number;
  taxBaseCents: number;
  taxCents: number;
  totalCents: number;
}

/** round(a * b / c), half away from zero. Matches the desktop integer division. */
export function muldivRound(a: number, b: number, c: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c)) {
    throw new InvoiceInputError('Internal: amount out of range');
  }
  if (c <= 0) throw new InvoiceInputError('Internal: bad divisor');
  if (a === 0 || b === 0) return 0;
  const neg = (a < 0) !== (b < 0);
  const product = BigInt(Math.abs(a)) * BigInt(Math.abs(b));
  const divisor = BigInt(c);
  const remainder = product % divisor;
  let rounded = product / divisor;
  if (remainder * 2n >= divisor) rounded += 1n;
  const out = Number(rounded);
  if (!Number.isSafeInteger(out)) throw new InvoiceInputError('Invoice total too large');
  return neg ? -out : out;
}

function padRight(value: string, length: number): string {
  return value.padEnd(length, '0');
}

/** Parse "1,234.56" / "$1234.5" into integer cents. Max 2 decimals. */
export function moneyIn(value: string | number | null | undefined, field: string, allowNeg = false): number {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '');
  let s = raw.replace(/[,$\s]/g, '').trim();
  if (s === '') s = '0';
  const match = s.match(/^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/);
  if (!match) throw new InvoiceInputError(`${field}: invalid amount "${raw}" (max 2 decimals)`);
  let cents = Number(match[2]) * 100 + Number(padRight(match[3] ?? '', 2));
  if (match[1] === '-') {
    if (!allowNeg) throw new InvoiceInputError(`${field}: cannot be negative`);
    cents = -cents;
  }
  return cents;
}

/** Quantity with up to 4 decimals, returned as qty * 10000. */
export function qtyIn(value: string | number | null | undefined, field: string): number {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '');
  let s = raw.replace(/[,\s]/g, '').trim();
  if (s === '') s = '0';
  const match = s.match(/^(-)?(\d{1,9})(?:\.(\d{1,4}))?$/);
  if (!match) throw new InvoiceInputError(`${field}: invalid quantity "${raw}" (max 4 decimals)`);
  const qty = Number(match[2]) * 10000 + Number(padRight(match[3] ?? '', 4));
  return match[1] === '-' ? -qty : qty;
}

/** Percent with up to 3 decimals, returned as percent * 1000. Empty is 0. */
export function rateIn(value: string | number | null | undefined, field: string): number {
  let s = String(value ?? '').trim();
  if (s === '') return 0;
  s = s.replace(/[%\s]+$/g, '');
  const match = s.match(/^(\d{1,3})(?:\.(\d{1,3}))?$/);
  if (!match) throw new InvoiceInputError(`${field}: invalid rate "${value}" (max 3 decimals)`);
  const rate = Number(match[1]) * 1000 + Number(padRight(match[2] ?? '', 3));
  if (rate > 100000) throw new InvoiceInputError(`${field}: cannot exceed 100%`);
  return rate;
}

const MAX_TOTAL = 9_999_999_999_999;

export function computeInvoice(items: InvoiceLineInput[], discountCents: number, rateE3: number): InvoiceTotals {
  if (!Number.isInteger(discountCents) || !Number.isInteger(rateE3)) {
    throw new InvoiceInputError('Discount and tax rate must be integers');
  }
  if (rateE3 < 0 || rateE3 > 100000) throw new InvoiceInputError('Tax rate: cannot exceed 100%');

  let subtotal = 0;
  let taxable = 0;
  const lines: InvoiceLine[] = [];
  items.forEach((item, index) => {
    const n = index + 1;
    const description = String(item.description ?? '').trim().slice(0, 4000);
    const qty = qtyIn(item.qty ?? '1', `Line ${n} qty`);
    const rate = moneyIn(item.rate ?? '0', `Line ${n} rate`, true);
    if (Math.abs(qty) > 10_000_000_000) throw new InvoiceInputError(`Line ${n}: quantity too large`);
    const amount = muldivRound(qty, rate, 10000);
    if (description === '' && amount === 0) return;
    const lineTaxable = item.taxable === true;
    subtotal += amount;
    if (lineTaxable) taxable += amount;
    lines.push({
      description,
      qtyE4: qty,
      rateCents: rate,
      taxable: lineTaxable,
      amountCents: amount,
    });
  });

  if (lines.length === 0) throw new InvoiceInputError('Invoice needs at least one line item');
  if (discountCents < 0) throw new InvoiceInputError('Discount cannot be negative');
  if (discountCents > 0 && discountCents > subtotal) {
    throw new InvoiceInputError('Discount cannot exceed the subtotal');
  }

  const taxDiscount = subtotal > 0 && taxable > 0 ? muldivRound(discountCents, taxable, subtotal) : 0;
  const taxBase = Math.max(0, taxable - taxDiscount);
  const tax = muldivRound(taxBase, rateE3, 100000);
  const total = subtotal - discountCents + tax;
  if (total < 0) throw new InvoiceInputError('Invoice total cannot be negative');
  if (total > MAX_TOTAL) throw new InvoiceInputError('Invoice total too large');

  return {
    lines,
    subtotalCents: subtotal,
    taxableCents: taxable,
    taxBaseCents: taxBase,
    taxCents: tax,
    totalCents: total,
  };
}

export function invoiceState(
  invoice: { status: InvoiceLifecycle; totalCents: number; paidCents: number; dueDate: string },
  today: string,
): { displayStatus: InvoiceDisplayStatus; balanceCents: number; daysOverdue: number } {
  const paid = invoice.paidCents;
  const total = invoice.totalCents;
  const balance = total - paid;
  let daysOverdue = 0;
  let displayStatus: InvoiceDisplayStatus;
  if (invoice.status === 'void') displayStatus = 'void';
  else if (invoice.status === 'draft') displayStatus = 'draft';
  else if (balance <= 0) displayStatus = 'paid';
  else if (invoice.dueDate < today) {
    displayStatus = 'overdue';
    daysOverdue = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / 86400000);
  } else if (paid > 0) displayStatus = 'partial';
  else displayStatus = 'open';

  return {
    displayStatus,
    balanceCents: displayStatus === 'void' || displayStatus === 'draft' ? 0 : Math.max(0, balance),
    daysOverdue,
  };
}

/** Void is blocked once any payment exists. A void invoice stays void until reopened. */
export function voidBlockedReason(status: InvoiceLifecycle, paidCents: number): string | null {
  if (paidCents > 0) return 'Invoice has payments recorded. Delete the payments before voiding.';
  if (status === 'void') return 'This invoice is already void.';
  return null;
}

export interface PostingLine {
  code: string;
  debitCents: number;
  creditCents: number;
  memo: string;
}

/**
 * Sent-invoice journal. Debit AR for the total, credit revenue for the
 * subtotal, debit sales discounts, credit sales tax payable. Drafts and voids
 * post nothing. The lines balance to the cent.
 */
export function sentInvoicePosting(totals: {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  taxLabel?: string;
}): PostingLine[] {
  const lines: PostingLine[] = [];
  const push = (code: string, debit: number, credit: number, memo = '') => {
    if (debit === 0 && credit === 0) return;
    if (debit < 0 || credit < 0) throw new InvoiceInputError('Internal: negative posting amount');
    lines.push({ code, debitCents: debit, creditCents: credit, memo });
  };
  const { subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: total } = totals;
  if (total > 0) push('1100', total, 0);
  else if (total < 0) push('1100', 0, -total);
  if (subtotal > 0) push('4000', 0, subtotal);
  else if (subtotal < 0) push('4000', -subtotal, 0);
  if (discount > 0) push('4090', discount, 0, 'Discount');
  if (tax > 0) push('2300', 0, tax, totals.taxLabel || 'Sales tax');
  else if (tax < 0) push('2300', -tax, 0, totals.taxLabel || 'Sales tax');
  return lines;
}

export function postingBalances(lines: PostingLine[]): boolean {
  const debit = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditCents, 0);
  return debit === credit;
}

export function paymentPosting(amountCents: number, cashCode: string): PostingLine[] {
  if (amountCents <= 0) return [];
  return [
    { code: cashCode, debitCents: amountCents, creditCents: 0, memo: '' },
    { code: '1100', debitCents: 0, creditCents: amountCents, memo: '' },
  ];
}

export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const body = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return `${neg ? '-' : ''}$${body}`;
}

export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function randomInvoiceIdHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
