import { supabase, setSupabaseWalletAddress } from '../supabaseClient';
import type { PayWalletAddressRow } from './api';
import {
  buildInvoiceAddresses,
  type InvoiceAddressDraft,
} from './addresses';
import { payEvmRouters, payEvmUsdc, paySolanaUsdcMint } from './payConfig';
import { NAVE_CORE_PROGRAM_ID } from '../programConfig';
import type { InvoiceLifecycle } from './invoiceMath';

export interface PayCustomer {
  id: string;
  treasury_group_id: string;
  name: string;
  contact: string;
  email: string;
  phone: string;
  address: string;
  tax_id: string;
  notes: string;
  archived: boolean;
  created_at: string;
}

export interface PayInvoiceItem {
  id: string;
  position: number;
  description: string;
  qty_e4: number;
  rate_cents: number;
  taxable: boolean;
  amount_cents: number;
}

export interface PayPayment {
  id: string;
  paid_on: string;
  amount_cents: number;
  method: string;
  reference: string;
  notes: string;
  cash_account_id: string | null;
}

export interface PayInvoiceAddress {
  chain: string;
  chain_id: number | null;
  asset: string;
  kind: 'solana_vault' | 'solana_ata' | 'evm_forwarder';
  address: string;
  dao_onchain_address: string;
}

export interface PayInvoice {
  id: string;
  treasury_group_id: string;
  customer_id: string;
  number: string;
  status: InvoiceLifecycle;
  issue_date: string;
  due_date: string;
  po_number: string;
  currency: string;
  tax_label: string;
  tax_rate_e3: number;
  discount_cents: number;
  subtotal_cents: number;
  taxable_cents: number;
  tax_cents: number;
  total_cents: number;
  notes: string;
  terms: string;
  footer: string;
  company_snapshot: { legal_name?: string; address?: string; ein?: string; email?: string; logo_url?: string } | null;
  customer_snapshot: { name?: string; email?: string; address?: string; contact?: string } | null;
  rails_snapshot: {
    wire_instructions?: string;
    ach_instructions?: string;
    reference_code?: string;
    treasury_addresses?: PayWalletAddressRow[];
  } | null;
  public_token: string;
  reference_code: string;
  invoice_id_hex: string;
  sent_at: string | null;
  voided_at: string | null;
  customer?: { name: string; email: string } | null;
  items?: PayInvoiceItem[];
  payments?: PayPayment[];
  addresses?: PayInvoiceAddress[];
}

export interface PayAccountChoice {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

export interface PayActivity {
  id: string;
  kind: string;
  summary: string;
  created_at: string;
}

export interface PublicInvoiceView {
  company_name: string;
  logo_url: string;
  number: string;
  amount_due_cents: number;
  total_cents: number;
  currency: string;
  status: string;
  days_overdue: number;
  due_date: string;
  reference: string;
  addresses: { chain: string; chain_id: number | null; asset: string; address: string; unique: boolean }[];
  items: { description: string; amount_cents: number }[];
}

export interface InvoiceSaveBody {
  id?: string;
  customer_id: string;
  invoice_id_hex?: string;
  number?: string;
  issue_date: string;
  due_date: string;
  po_number?: string;
  tax_label?: string;
  tax_rate?: string;
  discount?: string;
  notes?: string;
  terms?: string;
  footer?: string;
  mark_sent?: boolean;
  items: { description: string; qty: string; rate: string; taxable: boolean }[];
  addresses?: InvoiceAddressDraft[];
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export function payBooksMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The books could not be saved.';
  if (message.includes('PERIOD_LOCKED')) {
    return 'That date is in a closed period. Reopen the books before changing it.';
  }
  if (message.includes('payment_exceeds_balance')) {
    return 'That payment is larger than the open balance. The excess has to be recorded separately.';
  }
  if (message.includes('payments_exist')) {
    return 'This invoice has payments, so it cannot be voided or deleted.';
  }
  if (message.includes('discount_exceeds_subtotal')) return 'Discount cannot exceed the subtotal.';
  if (message.includes('lines_required')) return 'Add at least one line item.';
  if (message.includes('invalid_amount')) return 'Enter an amount with at most two decimals.';
  if (message.includes('invalid_quantity')) return 'Enter a quantity with at most four decimals.';
  if (message.includes('invalid_rate') || message.includes('rate_over_100')) return 'Enter a tax rate up to 100%, with at most three decimals.';
  if (message.includes('due_before_issue')) return 'The due date cannot be before the issue date.';
  if (message.includes('customer_not_found')) return 'Choose a customer from this treasury.';
  if (message.includes('customer_archived')) return 'That customer is archived.';
  if (message.includes('name_required')) return 'A customer name is required.';
  if (message.includes('invalid_email')) return 'Enter a valid email, or leave it blank.';
  if (message.includes('invoice_number_taken')) return 'That invoice number is already used.';
  if (message.includes('invoice_void')) return 'Reopen this void invoice before editing it.';
  if (message.includes('total_below_payments')) return 'The new total is less than payments already recorded.';
  if (message.includes('draft_only')) return 'Only a draft invoice can be deleted. Void a sent invoice instead.';
  if (message.includes('not_authorized')) return 'This wallet cannot change the books for this treasury.';
  if (message.includes('total_negative')) return 'The invoice total cannot be negative.';
  return message;
}

export function invoiceAddressesFor(
  invoiceIdHex: string,
  wallets: PayWalletAddressRow[],
): InvoiceAddressDraft[] {
  return buildInvoiceAddresses({
    invoiceIdHex,
    wallets,
    solanaProgramId: NAVE_CORE_PROGRAM_ID,
    solanaUsdcMint: paySolanaUsdcMint(),
    routers: payEvmRouters(),
    evmUsdc: payEvmUsdc(),
  });
}

export async function fetchPayCustomers(treasuryGroupId: string, wallet: string | null): Promise<PayCustomer[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_customers')
    .select('id, treasury_group_id, name, contact, email, phone, address, tax_id, notes, archived, created_at')
    .eq('treasury_group_id', treasuryGroupId)
    .order('name', { ascending: true });
  fail(error);
  return (data ?? []) as PayCustomer[];
}

export async function savePayCustomer(
  treasuryGroupId: string,
  wallet: string | null,
  body: Partial<PayCustomer> & { name: string },
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_save_customer', {
    p_treasury: treasuryGroupId,
    p_body: body,
  });
  fail(error);
  return String(data);
}

export async function updatePayRails(
  treasuryGroupId: string,
  wallet: string | null,
  wire: string,
  ach: string,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_update_company_settings', {
    p_treasury: treasuryGroupId,
    p_wire: wire,
    p_ach: ach,
  });
  fail(error);
}

export async function fetchPayActivity(treasuryGroupId: string, wallet: string | null): Promise<PayActivity[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_activity')
    .select('id, kind, summary, created_at')
    .eq('treasury_group_id', treasuryGroupId)
    .order('created_at', { ascending: false })
    .limit(8);
  fail(error);
  return (data ?? []) as PayActivity[];
}

export async function fetchPayInvoices(treasuryGroupId: string, wallet: string | null): Promise<PayInvoice[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_invoices')
    .select('id, treasury_group_id, customer_id, number, status, issue_date, due_date, total_cents, public_token, reference_code, invoice_id_hex, po_number, currency, tax_label, tax_rate_e3, discount_cents, subtotal_cents, taxable_cents, tax_cents, notes, terms, footer, company_snapshot, customer_snapshot, rails_snapshot, sent_at, voided_at, customer:pay_customers(name, email), payments:pay_payments(amount_cents)')
    .eq('treasury_group_id', treasuryGroupId)
    .order('issue_date', { ascending: false });
  fail(error);
  return ((data ?? []) as unknown as PayInvoice[]).map((row) => ({
    ...row,
    payments: row.payments ?? [],
  }));
}

export async function fetchPayInvoice(invoiceId: string, wallet: string | null): Promise<PayInvoice | null> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_invoices')
    .select('*, customer:pay_customers(name, email), items:pay_invoice_items(*), payments:pay_payments(*), addresses:pay_invoice_addresses(*)')
    .eq('id', invoiceId)
    .maybeSingle();
  fail(error);
  if (!data) return null;
  const invoice = data as unknown as PayInvoice;
  invoice.items = [...(invoice.items ?? [])].sort((a, b) => a.position - b.position);
  invoice.payments = [...(invoice.payments ?? [])].sort((a, b) => a.paid_on.localeCompare(b.paid_on));
  return invoice;
}

export async function fetchPayCashAccounts(treasuryGroupId: string, wallet: string | null): Promise<PayAccountChoice[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_accounts')
    .select('id, code, name, account_type')
    .eq('treasury_group_id', treasuryGroupId)
    .eq('archived', false)
    .in('account_type', ['asset', 'liability'])
    .order('code', { ascending: true });
  fail(error);
  return (data ?? []) as PayAccountChoice[];
}

export async function savePayInvoice(
  treasuryGroupId: string,
  wallet: string | null,
  body: InvoiceSaveBody,
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_save_invoice', {
    p_treasury: treasuryGroupId,
    p_body: body,
  });
  fail(error);
  return String(data);
}

export async function setPayInvoiceStatus(
  invoiceId: string,
  wallet: string | null,
  status: 'sent' | 'void' | 'reopen',
  addresses?: InvoiceAddressDraft[],
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_set_invoice_status', {
    p_invoice: invoiceId,
    p_status: status,
    p_addresses: addresses ?? null,
  });
  fail(error);
}

export async function deletePayInvoice(invoiceId: string, wallet: string | null): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_delete_invoice', { p_invoice: invoiceId });
  fail(error);
}

export async function duplicatePayInvoice(
  invoiceId: string,
  wallet: string | null,
  invoiceIdHex: string,
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_duplicate_invoice', {
    p_invoice: invoiceId,
    p_invoice_id_hex: invoiceIdHex,
  });
  fail(error);
  return String(data);
}

export async function recordPayPayment(
  invoiceId: string,
  wallet: string | null,
  body: {
    amount: string;
    date: string;
    method: string;
    reference: string;
    notes: string;
    cash_account_id: string | null;
    addresses?: InvoiceAddressDraft[];
  },
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_record_payment', {
    p_invoice: invoiceId,
    p_body: body,
  });
  fail(error);
}

export async function deletePayPayment(paymentId: string, wallet: string | null): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_delete_payment', { p_payment: paymentId });
  fail(error);
}

export async function fetchPublicInvoice(token: string): Promise<PublicInvoiceView | null> {
  setSupabaseWalletAddress(null);
  const { data, error } = await supabase.rpc('pay_public_invoice', { p_token: token });
  fail(error);
  if (!data || typeof data !== 'object') return null;
  return data as PublicInvoiceView;
}
