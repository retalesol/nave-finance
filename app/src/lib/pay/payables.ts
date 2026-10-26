import type { PostingLine } from './invoiceMath';

export type BillStatus = 'open' | 'void';
export type BillDisplayStatus = 'open' | 'partial' | 'paid' | 'overdue' | 'void';
export type CashDirection = 'in' | 'out';

/** Expense categories and the chart codes from Nave Books. */
export const EXPENSE_CATEGORY_CODES: Readonly<Record<string, string>> = {
  'Software & SaaS': '6000',
  'Infrastructure & RPC': '6010',
  'Audits & Security': '6020',
  Legal: '6030',
  Accounting: '6040',
  Contractors: '6050',
  Payroll: '6060',
  Marketing: '6070',
  Travel: '6080',
  Office: '6090',
  'Bank & Network Fees': '6100',
  Taxes: '6120',
  Other: '6900',
};

/** Income categories and the chart codes from Nave Books. */
export const INCOME_CATEGORY_CODES: Readonly<Record<string, string>> = {
  'Invoice payments': '4000',
  'Protocol revenue': '4010',
  Grants: '7010',
  'Investment (SAFE/Equity)': '2500',
  Refunds: '6900',
  Interest: '7000',
  Other: '4900',
};

export const EXPENSE_CATEGORIES = Object.keys(EXPENSE_CATEGORY_CODES);
export const INCOME_CATEGORIES = Object.keys(INCOME_CATEGORY_CODES);

export const PAYMENT_METHODS = [
  'ACH',
  'Wire',
  'Check',
  'USDC',
  'Other crypto',
  'Card',
  'Cash',
  'Other',
  'Treasury',
] as const;

const CARD_METHODS = new Set(['card', 'paypal', 'stripe', 'venmo']);

export const AP_CODE = '2000';
export const DIGITAL_ASSET_CODE = '1200';
export const DEFAULT_CASH_CODE = '1000';
export const UNCATEGORIZED_EXPENSE_CODE = '6900';
export const UNCATEGORIZED_INCOME_CODE = '4900';

function lookupCode(map: Readonly<Record<string, string>>, category: string, fallback: string): string {
  const key = category.trim().toLowerCase();
  const hit = Object.entries(map).find(([name]) => name.toLowerCase() === key);
  return hit?.[1] ?? fallback;
}

export function expenseCodeForBill(category: string, overrideCode?: string | null): string {
  const override = overrideCode?.trim();
  if (override) return override;
  return lookupCode(EXPENSE_CATEGORY_CODES, category, UNCATEGORIZED_EXPENSE_CODE);
}

export function incomeCodeForDeposit(category: string, overrideCode?: string | null): string {
  const override = overrideCode?.trim();
  if (override) return override;
  return lookupCode(INCOME_CATEGORY_CODES, category, UNCATEGORIZED_INCOME_CODE);
}

/**
 * Cash account for a payment. An explicit code wins. Crypto and treasury
 * payments land on digital assets 1200. Everything else uses checking 1000.
 */
export function cashAccountCode(method: string, explicitCode?: string | null): string {
  const explicit = explicitCode?.trim();
  if (explicit) return explicit;
  const normalized = method.trim().toLowerCase();
  if (
    normalized.includes('usdc')
    || normalized.includes('crypto')
    || normalized.includes('treasury')
    || normalized === 'sol'
    || normalized === 'solana'
    || normalized === 'eth'
    || normalized === 'ethereum'
  ) {
    return DIGITAL_ASSET_CODE;
  }
  return DEFAULT_CASH_CODE;
}

export function billState(
  bill: { status: BillStatus; amountCents: number; paidCents: number; dueDate: string },
  today: string,
): { displayStatus: BillDisplayStatus; balanceCents: number; daysOverdue: number } {
  const paid = bill.paidCents;
  const balance = bill.amountCents - paid;
  let daysOverdue = 0;
  let displayStatus: BillDisplayStatus;
  if (bill.status === 'void') displayStatus = 'void';
  else if (balance <= 0) displayStatus = 'paid';
  else if (bill.dueDate < today) {
    displayStatus = 'overdue';
    daysOverdue = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${bill.dueDate}T00:00:00Z`)) / 86400000,
    );
  } else if (paid > 0) displayStatus = 'partial';
  else displayStatus = 'open';

  return {
    displayStatus,
    balanceCents: displayStatus === 'void' ? 0 : Math.max(0, balance),
    daysOverdue,
  };
}

/** Void is blocked once any payment exists. The stored status stays open or void. */
export function billVoidBlocked(paidCents: number): string | null {
  if (paidCents > 0) return 'Bill has payments. Delete them before voiding.';
  return null;
}

/** Open bill on the bill date: Dr expense, Cr accounts payable 2000. Voids post nothing. */
export function billJournal(
  status: BillStatus,
  amountCents: number,
  expenseCode: string,
): PostingLine[] {
  if (status !== 'open' || amountCents <= 0) return [];
  return [
    { code: expenseCode, debitCents: amountCents, creditCents: 0, memo: '' },
    { code: AP_CODE, debitCents: 0, creditCents: amountCents, memo: '' },
  ];
}

/** Bill payment: Dr accounts payable 2000, Cr the cash account the money left. */
export function billPaymentJournal(amountCents: number, cashCode: string): PostingLine[] {
  if (amountCents <= 0) return [];
  return [
    { code: AP_CODE, debitCents: amountCents, creditCents: 0, memo: '' },
    { code: cashCode, debitCents: 0, creditCents: amountCents, memo: '' },
  ];
}

/** Deposit: Dr cash, Cr income. Expense: Dr expense, Cr cash. */
export function cashMovementJournal(
  direction: CashDirection,
  amountCents: number,
  categoryCode: string,
  cashCode: string,
): PostingLine[] {
  if (amountCents <= 0) return [];
  if (direction === 'in') {
    return [
      { code: cashCode, debitCents: amountCents, creditCents: 0, memo: '' },
      { code: categoryCode, debitCents: 0, creditCents: amountCents, memo: '' },
    ];
  }
  return [
    { code: categoryCode, debitCents: amountCents, creditCents: 0, memo: '' },
    { code: cashCode, debitCents: 0, creditCents: amountCents, memo: '' },
  ];
}

export interface CashLedgerSource {
  date: string;
  direction: CashDirection;
  amountCents: number;
  type: string;
  ref: string;
  party: string;
  category: string;
  method: string;
  reference: string;
  linkType: 'invoice' | 'bill' | 'transaction';
  linkId: string;
  src: string;
  srcId: string;
}

export interface CashLedgerRow extends CashLedgerSource {
  inCents: number;
  outCents: number;
  balanceCents: number;
}

/**
 * Cash-basis running balance. Rows before `from` roll into the opening balance.
 * Invoice payments, bill payments, and deposits/expenses are the only sources.
 */
export function cashLedger(
  sources: CashLedgerSource[],
  from?: string | null,
  to?: string | null,
): { openingCents: number; rows: CashLedgerRow[] } {
  const sorted = [...sources].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.src !== b.src) return a.src < b.src ? -1 : 1;
    if (a.srcId !== b.srcId) return a.srcId < b.srcId ? -1 : 1;
    return 0;
  });
  let balance = 0;
  let opening = 0;
  const rows: CashLedgerRow[] = [];
  for (const source of sorted) {
    balance += source.direction === 'in' ? source.amountCents : -source.amountCents;
    if (from && source.date < from) {
      opening = balance;
      continue;
    }
    if (to && source.date > to) continue;
    rows.push({
      ...source,
      inCents: source.direction === 'in' ? source.amountCents : 0,
      outCents: source.direction === 'out' ? source.amountCents : 0,
      balanceCents: balance,
    });
  }
  return { openingCents: opening, rows };
}

export interface VendorCashPayment {
  vendorId: string;
  amountCents: number;
  method: string;
  date: string;
}

/** Cash paid to a vendor in a calendar year. Card-network methods are left out. */
export function vendorYearCashCents(payments: VendorCashPayment[], vendorId: string, year: number): number {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  return payments.reduce((sum, payment) => {
    if (payment.vendorId !== vendorId) return sum;
    if (payment.date < from || payment.date > to) return sum;
    if (CARD_METHODS.has(payment.method.trim().toLowerCase())) return sum;
    return sum + payment.amountCents;
  }, 0);
}

/** Activity text for a vendor document. Callers must not pass a tax id. */
export function payableActivityText(
  kind: 'bill' | 'bill_payment' | 'proposal',
  vendorName: string,
  ref = '',
): string {
  const name = vendorName.trim() || 'Vendor';
  const suffix = ref.trim() ? ` ${ref.trim()}` : '';
  if (kind === 'bill_payment') return `Bill payment${suffix} to ${name}`;
  if (kind === 'proposal') return `Treasury proposal opened for ${name}${suffix}`;
  return `Bill${suffix} for ${name}`;
}

export function samePayee(left: string, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  if (a.toLowerCase().startsWith('0x') || b.toLowerCase().startsWith('0x')) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** True when a proposal amount is the same USD value as the bill payment. */
export function inputMatchesCents(input: string, cents: number): boolean {
  const trimmed = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return false;
  const [whole, fraction = ''] = trimmed.split('.');
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > 2) return false;
  const parsed = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return parsed === cents;
}

export function parseUsdCents(input: string): number | null {
  const trimmed = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

export function centsToInput(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function asCents(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
