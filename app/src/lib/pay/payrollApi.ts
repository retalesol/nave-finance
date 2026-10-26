import { supabase, setSupabaseWalletAddress } from '../supabaseClient';
import {
  defaultPayrollSettings,
  emptyPayrollPerson,
  type PayrollCalc,
  type PayrollPerson,
  type PayrollSettings,
  type StubInputs,
} from './payrollCalc';

export interface PayEmployee {
  id: string;
  treasury_group_id: string;
  kind: 'w2' | '1099';
  status: 'candidate' | 'active' | 'terminated';
  first_name: string;
  middle_name: string;
  last_name: string;
  business_name: string;
  email: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  tin_type: 'SSN' | 'EIN' | 'ITIN';
  tin_last4: string;
  tin_hash: string;
  employee_no: string;
  title: string;
  department: string;
  hire_date: string | null;
  term_date: string | null;
  birth_year: number;
  is_officer: boolean;
  flsa_exempt: boolean;
  pay_type: 'salary' | 'hourly';
  pay_rate_cents: number;
  frequency: PayrollPerson['frequency'];
  std_hours_e2: number;
  work_state: string;
  w4_version: '2020' | 'legacy';
  fed_status: PayrollPerson['fed_status'];
  fed_step2: boolean;
  fed_dependents_cents: number;
  fed_other_income_cents: number;
  fed_deductions_cents: number;
  fed_extra_cents: number;
  fed_exempt: boolean;
  fed_allowances: number;
  st_status: PayrollPerson['st_status'];
  st_allowances: number;
  st_est_allowances: number;
  st_extra_cents: number;
  st_exempt: boolean;
  st_flat_bp: number;
  sdi_exempt: boolean;
  fica_exempt: boolean;
  k401_type: PayrollPerson['k401_type'];
  k401_pct_bp: number;
  k401_flat_cents: number;
  k401_prior_high: boolean;
  health_pretax_cents: number;
  health_er_cents: number;
  posttax: { label: string; amount_cents: number; garnishment?: boolean }[];
  pay_method: 'direct_deposit' | 'check';
  dd_bank: string;
  dd_routing: string;
  dd_last4: string;
  dd_account_hash: string;
  dd_type: 'checking' | 'savings';
  sick_policy: PayrollPerson['sick_policy'];
  sick_open_e2: number;
  sick_cap_e2: number;
  pto_per_period_e2: number;
  pto_cap_e2: number;
  pto_open_e2: number;
  backup_wh: boolean;
  contract_rate_cents: number;
  notes: string;
}

export interface PayRun {
  id: string;
  treasury_group_id: string;
  pay_date: string;
  period_start: string;
  period_end: string;
  frequency: PayrollPerson['frequency'];
  kind: 'regular' | 'offcycle' | 'contractor';
  status: 'draft' | 'approved' | 'void';
  memo: string;
  cash_account_id: string | null;
}

export interface PayStub {
  id: string;
  treasury_group_id: string;
  run_id: string;
  employee_id: string;
  pay_date: string;
  status: 'draft' | 'approved' | 'void';
  inputs: StubInputs;
  calc: PayrollCalc;
  gross_cents: number;
  net_cents: number;
  pay_method: 'direct_deposit' | 'check';
  check_number: number | null;
  advice_number: number | null;
}

export interface PayOffer {
  id: string;
  treasury_group_id: string;
  employee_id: string;
  status: 'draft' | 'sent' | 'signed' | 'declined' | 'withdrawn';
  terms: Record<string, unknown>;
  letter_text: string;
  content_hash: string;
  expires_on: string | null;
  sign_method: string;
  signer_typed_name: string;
  signed_hash: string;
}

export interface PayOnboardingItem {
  id: string;
  employee_id: string;
  item: string;
  status: 'todo' | 'done' | 'na';
  done_on: string | null;
  note: string;
}

export interface PayAssetAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

export interface PayrollBundle {
  employees: PayEmployee[];
  runs: PayRun[];
  stubs: PayStub[];
  offers: PayOffer[];
  onboarding: PayOnboardingItem[];
  accounts: PayAssetAccount[];
  settings: PayrollSettings;
}

function wallet(walletAddress: string | null) {
  setSupabaseWalletAddress(walletAddress);
}

export function payrollMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Payroll could not be saved.';
  if (message.includes('not_authorized')) return 'This wallet cannot change payroll for this treasury.';
  if (message.includes('payroll_year_unsupported')) return 'Payroll dates outside 2026 are refused. There is no withholding table for that year.';
  if (message.includes('invalid_tax_id')) return 'Enter a valid tax id, or leave the masked value to keep the one on file.';
  if (message.includes('invalid_account_number')) return 'The account number must be 4 to 17 digits.';
  if (message.includes('invalid_routing')) return 'That routing number fails the ABA checksum.';
  if (message.includes('activation_blocked')) return 'Finish the hiring checklist, tax id, home address, and pay rate before this person can be active.';
  if (message.includes('ca_sick_leave_required')) return 'California requires paid sick leave. Choose accrue or front-load.';
  if (message.includes('ca_sick_cap')) return 'California sick leave cannot be capped below 80 hours.';
  if (message.includes('net_negative')) return 'Net pay is negative. Reduce deductions before approving.';
  if (message.includes('nothing_to_pay')) return 'Nothing to pay on a stub. Enter wages or remove that person.';
  if (message.includes('stub_does_not_balance')) return 'That pay stub did not balance, so it was not saved.';
  if (message.includes('employee_not_active')) return 'Only an active person can be added to a pay run.';
  if (message.includes('offer_not_signed')) return 'Sign the offer letter before marking that step done.';
  if (message.includes('ca_exempt_minimum')) return 'A California exempt salary has to meet the 2026 minimum.';
  if (message.includes('ca_minimum_wage')) return 'Hourly pay is below the 2026 California minimum wage.';
  if (message.includes('name_required')) return 'Enter the legal name.';
  return message;
}

export function personFromEmployee(row: PayEmployee): PayrollPerson {
  return {
    ...emptyPayrollPerson(row.kind),
    id: row.id,
    status: row.status,
    first_name: row.first_name,
    middle_name: row.middle_name,
    last_name: row.last_name,
    business_name: row.business_name,
    is_officer: row.is_officer,
    flsa_exempt: row.flsa_exempt,
    pay_type: row.pay_type,
    pay_rate_cents: row.pay_rate_cents,
    frequency: row.frequency,
    std_hours_e2: row.std_hours_e2,
    work_state: row.work_state,
    w4_version: row.w4_version,
    fed_status: row.fed_status,
    fed_step2: row.fed_step2,
    fed_dependents_cents: row.fed_dependents_cents,
    fed_other_income_cents: row.fed_other_income_cents,
    fed_deductions_cents: row.fed_deductions_cents,
    fed_extra_cents: row.fed_extra_cents,
    fed_exempt: row.fed_exempt,
    fed_allowances: row.fed_allowances,
    st_status: row.st_status,
    st_allowances: row.st_allowances,
    st_est_allowances: row.st_est_allowances,
    st_extra_cents: row.st_extra_cents,
    st_exempt: row.st_exempt,
    st_flat_bp: row.st_flat_bp,
    sdi_exempt: row.sdi_exempt,
    fica_exempt: row.fica_exempt,
    birth_year: row.birth_year,
    k401_type: row.k401_type,
    k401_pct_bp: row.k401_pct_bp,
    k401_flat_cents: row.k401_flat_cents,
    k401_prior_high: row.k401_prior_high,
    health_pretax_cents: row.health_pretax_cents,
    health_er_cents: row.health_er_cents,
    posttax: row.posttax ?? [],
    sick_policy: row.sick_policy,
    sick_open_e2: row.sick_open_e2,
    sick_cap_e2: row.sick_cap_e2,
    pto_per_period_e2: row.pto_per_period_e2,
    pto_cap_e2: row.pto_cap_e2,
    pto_open_e2: row.pto_open_e2,
    backup_wh: row.backup_wh,
    tin_on_file: row.tin_hash !== '' || row.tin_last4 !== '',
    pay_method: row.pay_method,
  };
}

export function settingsFromRow(raw: unknown): PayrollSettings {
  const base = defaultPayrollSettings();
  if (!raw || typeof raw !== 'object') return base;
  const row = raw as Partial<PayrollSettings>;
  return {
    ...base,
    ...row,
    sui: { ...base.sui, ...(row.sui ?? {}) },
    futa_cr_bp: { ...base.futa_cr_bp, ...(row.futa_cr_bp ?? {}) },
  };
}

export function employeeName(row: Pick<PayEmployee, 'kind' | 'business_name' | 'first_name' | 'middle_name' | 'last_name'>): string {
  if (row.kind === '1099' && row.business_name.trim()) return row.business_name.trim();
  return [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ');
}

async function unwrap<T>(result: { data: T | null; error: { message: string } | null }): Promise<T> {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

export async function fetchPayrollBundle(treasuryGroupId: string, walletAddress: string | null): Promise<PayrollBundle> {
  wallet(walletAddress);
  const [employees, runs, stubs, offers, onboarding, accounts, settings] = await Promise.all([
    supabase.from('pay_employees').select('*').eq('treasury_group_id', treasuryGroupId).order('last_name'),
    supabase.from('pay_runs').select('*').eq('treasury_group_id', treasuryGroupId).order('pay_date', { ascending: false }),
    supabase.from('pay_stubs').select('*').eq('treasury_group_id', treasuryGroupId).order('pay_date'),
    supabase.from('pay_offer_letters').select('*').eq('treasury_group_id', treasuryGroupId).order('created_at', { ascending: false }),
    supabase.from('pay_onboarding_items').select('*').eq('treasury_group_id', treasuryGroupId),
    supabase.from('pay_accounts').select('id, code, name, account_type').eq('treasury_group_id', treasuryGroupId).order('code'),
    supabase.from('pay_payroll_settings').select('settings').eq('treasury_group_id', treasuryGroupId).maybeSingle(),
  ]);
  for (const result of [employees, runs, stubs, offers, onboarding, accounts, settings]) {
    if (result.error) throw new Error(result.error.message);
  }
  return {
    employees: (employees.data ?? []) as PayEmployee[],
    runs: (runs.data ?? []) as PayRun[],
    stubs: (stubs.data ?? []) as PayStub[],
    offers: (offers.data ?? []) as PayOffer[],
    onboarding: (onboarding.data ?? []) as PayOnboardingItem[],
    accounts: (accounts.data ?? []) as PayAssetAccount[],
    settings: settingsFromRow(settings.data?.settings),
  };
}

export async function saveEmployee(treasuryGroupId: string, walletAddress: string | null, body: Record<string, unknown>) {
  wallet(walletAddress);
  return unwrap(await supabase.rpc('pay_payroll_save_employee', { p_treasury: treasuryGroupId, p_body: body }));
}

export async function revealEmployee(treasuryGroupId: string, walletAddress: string | null, employeeId: string) {
  wallet(walletAddress);
  return unwrap<{ tin: string; dd_account: string }>(
    await supabase.rpc('pay_payroll_reveal_employee', { p_treasury: treasuryGroupId, p_employee: employeeId }),
  );
}

export async function createRun(treasuryGroupId: string, walletAddress: string | null, body: Record<string, unknown>) {
  wallet(walletAddress);
  return unwrap<string>(await supabase.rpc('pay_payroll_create_run', { p_treasury: treasuryGroupId, p_body: body }));
}

export async function saveStub(
  treasuryGroupId: string,
  walletAddress: string | null,
  stubId: string,
  body: { inputs: StubInputs; calc: PayrollCalc; pay_method: string },
) {
  wallet(walletAddress);
  return unwrap(await supabase.rpc('pay_payroll_save_stub', { p_treasury: treasuryGroupId, p_stub: stubId, p_body: body }));
}

export async function approveRun(treasuryGroupId: string, walletAddress: string | null, runId: string) {
  wallet(walletAddress);
  return unwrap(await supabase.rpc('pay_payroll_approve_run', { p_treasury: treasuryGroupId, p_run: runId }));
}

export async function voidRun(treasuryGroupId: string, walletAddress: string | null, runId: string, reason: string) {
  wallet(walletAddress);
  return unwrap(await supabase.rpc('pay_payroll_void_run', {
    p_treasury: treasuryGroupId,
    p_run: runId,
    p_reason: reason,
  }));
}

export async function deleteRun(treasuryGroupId: string, walletAddress: string | null, runId: string) {
  wallet(walletAddress);
  const result = await supabase.rpc('pay_payroll_delete_run', { p_treasury: treasuryGroupId, p_run: runId });
  if (result.error) throw new Error(result.error.message);
}

export async function setOnboarding(
  treasuryGroupId: string,
  walletAddress: string | null,
  employeeId: string,
  item: string,
  status: 'todo' | 'done' | 'na',
) {
  wallet(walletAddress);
  return unwrap(await supabase.rpc('pay_payroll_set_onboarding', {
    p_treasury: treasuryGroupId,
    p_employee: employeeId,
    p_item: item,
    p_status: status,
    p_note: '',
  }));
}

export async function activateEmployee(treasuryGroupId: string, walletAddress: string | null, employeeId: string) {
  wallet(walletAddress);
  return unwrap(await supabase.rpc('pay_payroll_activate_employee', {
    p_treasury: treasuryGroupId,
    p_employee: employeeId,
  }));
}

export async function saveOffer(treasuryGroupId: string, walletAddress: string | null, body: Record<string, unknown>) {
  wallet(walletAddress);
  return unwrap<PayOffer>(await supabase.rpc('pay_payroll_save_offer', { p_treasury: treasuryGroupId, p_body: body }));
}

export async function sendOffer(treasuryGroupId: string, walletAddress: string | null, offerId: string, letterText: string) {
  wallet(walletAddress);
  return unwrap<PayOffer>(await supabase.rpc('pay_payroll_send_offer', {
    p_treasury: treasuryGroupId,
    p_offer: offerId,
    p_letter_text: letterText,
  }));
}

export async function signOffer(treasuryGroupId: string, walletAddress: string | null, offerId: string, typedName: string) {
  wallet(walletAddress);
  return unwrap(await supabase.rpc('pay_payroll_sign_offer', {
    p_treasury: treasuryGroupId,
    p_offer: offerId,
    p_typed_name: typedName,
  }));
}
