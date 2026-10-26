import { supabase, setSupabaseWalletAddress } from '../supabaseClient';
import { payBooksMessage } from './booksApi';
import { asCents } from './payables';

export interface PayVendor {
  id: string;
  treasury_group_id: string;
  name: string;
  contact: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  archived: boolean;
  payment_address: string;
  is_1099: boolean;
  form_1099: 'NEC' | 'MISC' | string;
  legal_name: string;
  tin_type: '' | 'EIN' | 'SSN' | 'ITIN' | string;
  w9_on_file: boolean;
  w9_date: string | null;
  created_at: string;
  tax_id?: string;
}

export interface PayBillPayment {
  id: string;
  paid_on: string;
  amount_cents: number;
  method: string;
  reference: string;
  notes: string;
  cash_account_id: string | null;
}

export interface PayBill {
  id: string;
  treasury_group_id: string;
  vendor_id: string;
  ref: string;
  bill_date: string;
  due_date: string;
  category: string;
  description: string;
  amount_cents: number;
  status: 'open' | 'void';
  notes: string;
  account_id: string | null;
  proposal_dao: string;
  proposal_index: number | null;
  proposal_chain: string;
  proposal_amount_cents: number | null;
  proposal_recipient: string;
  proposal_payment_id: string | null;
  vendor?: { name: string; payment_address: string } | null;
  payments?: PayBillPayment[];
}

export interface PayCashEntry {
  id: string;
  treasury_group_id: string;
  entry_date: string;
  direction: 'in' | 'out';
  amount_cents: number;
  category: string;
  counterparty: string;
  method: string;
  reference: string;
  memo: string;
  account_id: string | null;
  cash_account_id: string | null;
  vendor_id: string | null;
  vendor?: { name: string } | null;
}

export interface PayChartAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
  subtype: string;
}

export interface InvoiceLedgerPayment {
  id: string;
  paid_on: string;
  amount_cents: number;
  method: string;
  reference: string;
  invoice_id: string;
  number: string;
  customer_name: string;
}

const VENDOR_LIST = 'id, treasury_group_id, name, contact, email, phone, address, notes, archived, payment_address, is_1099, form_1099, legal_name, tin_type, w9_on_file, w9_date, created_at';

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function payablesMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/\d{2}-?\d{7}/.test(message) || /\d{3}-\d{2}-\d{4}/.test(message)) {
    return 'The books could not be saved.';
  }
  if (message.includes('vendor_has_bills') || message.includes('vendor_has_entries')) {
    return 'This vendor is used on a bill or an expense. Archive it instead.';
  }
  if (message.includes('bill_has_payments')) return 'This bill has payments. Delete them before voiding.';
  if (message.includes('payment_exceeds_balance')) return 'That payment is larger than the open balance.';
  if (message.includes('amount_below_payments')) return 'The bill amount is less than payments already recorded.';
  if (message.includes('due_before_bill')) return 'The due date cannot be before the bill date.';
  if (message.includes('bill_void')) return 'Reopen this void bill before changing it.';
  if (message.includes('invalid_tin')) return 'TIN must look like an EIN or an SSN.';
  if (message.includes('recipient_mismatch')) return 'The proposal recipient has to match this vendor’s payment address.';
  if (message.includes('proposal_missing')) return 'Open a treasury payment proposal before recording it as paid.';
  if (message.includes('vendor_not_found')) return 'Choose a vendor from this treasury.';
  if (message.includes('vendor_archived')) return 'That vendor is archived.';
  if (message.includes('invalid_account')) return 'That account cannot be used here.';
  if (message.includes('name_required')) return 'A name is required.';
  if (message.includes('invalid_email')) return 'Enter a valid email, or leave it blank.';
  if (message.includes('invalid_direction')) return 'Choose money in or money out.';
  if (message.includes('amount_required') || message.includes('invalid_amount') || message.includes('amount_negative')) {
    return 'Enter an amount greater than zero, with at most two decimals.';
  }
  if (message.includes('chart_missing')) return 'The chart of accounts is missing for this treasury. Turn Pay on again before saving a bill.';
  if (message.includes('invalid_date')) return 'Enter a valid date.';
  if (message.includes('not_authorized')) return 'This wallet cannot change the books for this treasury.';
  if (!message) return 'The books could not be saved.';
  return payBooksMessage(error);
}

export async function fetchPayVendors(treasuryGroupId: string, wallet: string | null): Promise<PayVendor[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_vendors')
    .select(VENDOR_LIST)
    .eq('treasury_group_id', treasuryGroupId)
    .order('name', { ascending: true });
  fail(error);
  return (data ?? []) as PayVendor[];
}

export async function fetchPayVendor(vendorId: string, wallet: string | null): Promise<PayVendor | null> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_vendors')
    .select(`${VENDOR_LIST}, tax_id`)
    .eq('id', vendorId)
    .maybeSingle();
  fail(error);
  return (data as PayVendor | null) ?? null;
}

export async function savePayVendor(
  treasuryGroupId: string,
  wallet: string | null,
  body: Record<string, unknown>,
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_save_vendor', {
    p_treasury: treasuryGroupId,
    p_body: body,
  });
  fail(error);
  return String(data);
}

export async function deletePayVendor(vendorId: string, wallet: string | null): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_delete_vendor', { p_vendor: vendorId });
  fail(error);
}

export async function fetchPayChart(treasuryGroupId: string, wallet: string | null): Promise<PayChartAccount[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_accounts')
    .select('id, code, name, account_type, subtype')
    .eq('treasury_group_id', treasuryGroupId)
    .eq('archived', false)
    .order('code', { ascending: true });
  fail(error);
  return (data ?? []) as PayChartAccount[];
}

function normalizeBill(row: Record<string, unknown>): PayBill {
  const vendor = one(row.vendor as PayBill['vendor']);
  const payments = ((row.payments as PayBillPayment[] | null) ?? []).map((payment) => ({
    ...payment,
    amount_cents: asCents(payment.amount_cents),
  }));
  return {
    ...(row as unknown as PayBill),
    amount_cents: asCents(row.amount_cents as number | string),
    proposal_amount_cents: row.proposal_amount_cents == null ? null : asCents(row.proposal_amount_cents as number | string),
    proposal_index: row.proposal_index == null ? null : Number(row.proposal_index),
    vendor,
    payments: payments.sort((a, b) => a.paid_on.localeCompare(b.paid_on)),
  };
}

const BILL_SELECT = `id, treasury_group_id, vendor_id, ref, bill_date, due_date, category, description, amount_cents, status, notes, account_id, proposal_dao, proposal_index, proposal_chain, proposal_amount_cents, proposal_recipient, proposal_payment_id, vendor:pay_vendors(name, payment_address), payments:pay_bill_payments!pay_bill_payments_bill_id_fkey(id, paid_on, amount_cents, method, reference, notes, cash_account_id)`;

export async function fetchPayBills(treasuryGroupId: string, wallet: string | null): Promise<PayBill[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_bills')
    .select(BILL_SELECT)
    .eq('treasury_group_id', treasuryGroupId)
    .order('bill_date', { ascending: false });
  fail(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(normalizeBill);
}

export async function fetchPayBill(billId: string, wallet: string | null): Promise<PayBill | null> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_bills')
    .select(BILL_SELECT)
    .eq('id', billId)
    .maybeSingle();
  fail(error);
  if (!data) return null;
  return normalizeBill(data as unknown as Record<string, unknown>);
}

export async function savePayBill(
  treasuryGroupId: string,
  wallet: string | null,
  body: Record<string, unknown>,
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_save_bill', {
    p_treasury: treasuryGroupId,
    p_body: body,
  });
  fail(error);
  return String(data);
}

export async function setPayBillStatus(billId: string, status: 'open' | 'void', wallet: string | null): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_set_bill_status', { p_bill: billId, p_status: status });
  fail(error);
}

export async function deletePayBill(billId: string, wallet: string | null): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_delete_bill', { p_bill: billId });
  fail(error);
}

export async function recordPayBillPayment(
  billId: string,
  wallet: string | null,
  body: Record<string, unknown>,
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_record_bill_payment', { p_bill: billId, p_body: body });
  fail(error);
  return String(data);
}

export async function deletePayBillPayment(paymentId: string, wallet: string | null): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_delete_bill_payment', { p_payment: paymentId });
  fail(error);
}

export async function linkPayBillProposal(
  billId: string,
  wallet: string | null,
  draft: { dao: string; index: number; chain: string; amountCents: number; recipient: string },
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_link_bill_proposal', {
    p_bill: billId,
    p_dao: draft.dao,
    p_index: draft.index,
    p_chain: draft.chain,
    p_amount_cents: draft.amountCents,
    p_recipient: draft.recipient,
  });
  fail(error);
}

export async function confirmPayBillProposal(billId: string, wallet: string | null): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_confirm_bill_proposal', { p_bill: billId });
  fail(error);
  return String(data);
}

function normalizeCash(row: Record<string, unknown>): PayCashEntry {
  return {
    ...(row as unknown as PayCashEntry),
    amount_cents: asCents(row.amount_cents as number | string),
    vendor: one(row.vendor as PayCashEntry['vendor']),
  };
}

export async function fetchPayCashEntries(treasuryGroupId: string, wallet: string | null): Promise<PayCashEntry[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_cash_entries')
    .select('id, treasury_group_id, entry_date, direction, amount_cents, category, counterparty, method, reference, memo, account_id, cash_account_id, vendor_id, vendor:pay_vendors(name)')
    .eq('treasury_group_id', treasuryGroupId)
    .order('entry_date', { ascending: false });
  fail(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(normalizeCash);
}

export async function savePayCashEntry(
  treasuryGroupId: string,
  wallet: string | null,
  body: Record<string, unknown>,
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_save_cash_entry', {
    p_treasury: treasuryGroupId,
    p_body: body,
  });
  fail(error);
  return String(data);
}

export async function deletePayCashEntry(entryId: string, wallet: string | null): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_delete_cash_entry', { p_entry: entryId });
  fail(error);
}

export async function fetchInvoiceLedgerPayments(
  treasuryGroupId: string,
  wallet: string | null,
): Promise<InvoiceLedgerPayment[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_payments')
    .select('id, paid_on, amount_cents, method, reference, invoice:pay_invoices(id, number, customer:pay_customers(name))')
    .eq('treasury_group_id', treasuryGroupId)
    .order('paid_on', { ascending: false });
  fail(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
    const invoice = one(row.invoice as { id: string; number: string; customer: { name: string } | { name: string }[] | null } | null);
    const customer = invoice ? one(invoice.customer) : null;
    return {
      id: String(row.id),
      paid_on: String(row.paid_on),
      amount_cents: asCents(row.amount_cents as number | string),
      method: String(row.method ?? ''),
      reference: String(row.reference ?? ''),
      invoice_id: invoice?.id ?? '',
      number: invoice?.number ?? '',
      customer_name: customer?.name ?? '',
    };
  });
}
