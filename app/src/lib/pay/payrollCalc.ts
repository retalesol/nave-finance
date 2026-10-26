/**
 * Payroll calculation ported from nave-books/lib/payroll.php.
 *
 * The app records the result. It does not originate ACH or move money.
 * Withholding uses the 2026 tables only. Prior approved stubs are passed in
 * so wage bases, 401(k) limits, and leave stay deterministic.
 */

import { moneyIn, muldivRound } from './invoiceMath';
import {
  PAY_NO_INCOME_TAX_STATES,
  PAY_PERIODS,
  type PayFrequency,
  type PayrollYearTables,
  payrollTables,
} from './payrollTables';

export type { PayFrequency };

export class PayrollCalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollCalcError';
  }
}

export type WorkerKind = 'w2' | '1099';
export type PersonStatus = 'candidate' | 'active' | 'terminated';
export type PayType = 'salary' | 'hourly';
export type FedStatus = 'single' | 'mfj' | 'hoh';
export type StateStatus = 'single' | 'married' | 'hoh';
export type K401Type = 'none' | 'traditional' | 'roth';
export type RunKind = 'regular' | 'offcycle' | 'contractor';
export type PayMethod = 'direct_deposit' | 'check';
export type SickPolicy = 'accrue' | 'frontload' | 'none';

export interface PostTaxDeduction {
  label: string;
  amount_cents: number;
  garnishment?: boolean;
}

export interface PayrollPerson {
  id: string;
  kind: WorkerKind;
  status: PersonStatus;
  first_name: string;
  middle_name: string;
  last_name: string;
  business_name: string;
  is_officer: boolean;
  flsa_exempt: boolean;
  pay_type: PayType;
  pay_rate_cents: number;
  frequency: PayFrequency;
  std_hours_e2: number;
  work_state: string;
  w4_version: '2020' | 'legacy';
  fed_status: FedStatus;
  fed_step2: boolean;
  fed_dependents_cents: number;
  fed_other_income_cents: number;
  fed_deductions_cents: number;
  fed_extra_cents: number;
  fed_exempt: boolean;
  fed_allowances: number;
  st_status: StateStatus;
  st_allowances: number;
  st_est_allowances: number;
  st_extra_cents: number;
  st_exempt: boolean;
  st_flat_bp: number;
  sdi_exempt: boolean;
  fica_exempt: boolean;
  birth_year: number;
  k401_type: K401Type;
  k401_pct_bp: number;
  k401_flat_cents: number;
  k401_prior_high: boolean;
  health_pretax_cents: number;
  health_er_cents: number;
  posttax: PostTaxDeduction[];
  sick_policy: SickPolicy;
  sick_open_e2: number;
  sick_cap_e2: number;
  pto_per_period_e2: number;
  pto_cap_e2: number;
  pto_open_e2: number;
  backup_wh: boolean;
  tin_on_file: boolean;
  pay_method: PayMethod;
}

export interface PayrollSettings {
  sui: Record<string, { rate_bp: number; base_cents: number; ett_bp: number }>;
  futa_cr_bp: Record<string, number>;
  k401_match_pct_bp: number;
  k401_match_cap_bp: number;
  local_min_wage_cents: number;
  local_min_wage_label: string;
  sick_frontload_e2: number;
  default_frequency: PayFrequency;
}

export interface StubInputs {
  regular_hours?: string | number;
  overtime_hours?: string | number;
  doubletime_hours?: string | number;
  sick_hours?: string | number;
  pto_hours?: string | number;
  holiday_hours?: string | number;
  salary?: string;
  include_regular?: boolean;
  include_benefits?: boolean;
  skip_deductions?: boolean;
  amount?: string;
  description?: string;
  earnings?: { amount?: string; type?: string; label?: string }[];
  reimbursements?: { amount?: string; label?: string; account_id?: string | null }[];
  posttax?: { amount?: string; label?: string }[];
  overrides?: Record<string, string>;
}

export interface PayLine {
  code: string;
  cat: 'earning' | 'reimb' | 'pretax' | 'posttax' | 'tax_ee' | 'tax_er';
  label: string;
  amount_cents: number;
  hours_e2?: number;
  rate_cents?: number;
  ytd_cents?: number;
  ytd_hours_e2?: number;
  liab?: string;
  exp?: string;
  note?: string;
  overridden?: boolean;
  computed_cents?: number;
  supp?: string;
  account_id?: string | null;
}

export interface LeaveBalance {
  sick: { accrued_e2: number; used_e2: number; balance_e2: number; policy: SickPolicy };
  pto: { accrued_e2: number; used_e2: number; balance_e2: number };
  worked_e2: number;
}

export interface PayrollCalc {
  kind: WorkerKind;
  lines: PayLine[];
  wages: Record<string, number>;
  ytd_wages: Record<string, number>;
  gross_cents: number;
  net_cents: number;
  reimb_cents: number;
  pretax_cents?: number;
  tax_ee_cents?: number;
  posttax_cents?: number;
  tax_er_cents?: number;
  hours_e2?: number;
  leave: LeaveBalance | null;
  warnings: string[];
  frequency?: PayFrequency;
  periods?: number;
  tables_year: number;
}

export interface PayrollRunSlice {
  pay_date: string;
  kind: RunKind;
}

export interface ApprovedStubRef {
  id: string;
  payDate: string;
  calc: PayrollCalc;
}

export interface JournalDraftLine {
  systemKey: string;
  debitCents: number;
  creditCents: number;
  memo: string;
}

export function defaultPayrollSettings(): PayrollSettings {
  return {
    sui: { CA: { rate_bp: 340, base_cents: 700000, ett_bp: 10 } },
    futa_cr_bp: { CA: 150 },
    k401_match_pct_bp: 0,
    k401_match_cap_bp: 0,
    local_min_wage_cents: 0,
    local_min_wage_label: '',
    sick_frontload_e2: 4000,
    default_frequency: 'semimonthly',
  };
}

export function emptyPayrollPerson(kind: WorkerKind): PayrollPerson {
  return {
    id: '',
    kind,
    status: kind === 'w2' ? 'candidate' : 'active',
    first_name: '',
    middle_name: '',
    last_name: '',
    business_name: '',
    is_officer: false,
    flsa_exempt: kind === 'w2',
    pay_type: 'salary',
    pay_rate_cents: 0,
    frequency: 'semimonthly',
    std_hours_e2: 0,
    work_state: 'CA',
    w4_version: '2020',
    fed_status: 'single',
    fed_step2: false,
    fed_dependents_cents: 0,
    fed_other_income_cents: 0,
    fed_deductions_cents: 0,
    fed_extra_cents: 0,
    fed_exempt: false,
    fed_allowances: 0,
    st_status: 'single',
    st_allowances: 0,
    st_est_allowances: 0,
    st_extra_cents: 0,
    st_exempt: false,
    st_flat_bp: 0,
    sdi_exempt: false,
    fica_exempt: false,
    birth_year: 0,
    k401_type: 'none',
    k401_pct_bp: 0,
    k401_flat_cents: 0,
    k401_prior_high: false,
    health_pretax_cents: 0,
    health_er_cents: 0,
    posttax: [],
    sick_policy: 'accrue',
    sick_open_e2: 0,
    sick_cap_e2: 8000,
    pto_per_period_e2: 0,
    pto_cap_e2: 0,
    pto_open_e2: 0,
    backup_wh: false,
    tin_on_file: false,
    pay_method: kind === '1099' ? 'check' : 'direct_deposit',
  };
}

export function personName(person: Pick<PayrollPerson, 'kind' | 'business_name' | 'first_name' | 'middle_name' | 'last_name'>): string {
  if (person.kind === '1099' && person.business_name.trim() !== '') return person.business_name.trim();
  return [person.first_name, person.middle_name, person.last_name].filter((part) => part.trim() !== '').join(' ');
}

export function payrollPeriodFor(freq: PayFrequency, payDate: string): { start: string; end: string } {
  const d = utcDate(payDate);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const addDays = (n: number) => {
    const next = new Date(d);
    next.setUTCDate(next.getUTCDate() + n);
    return next;
  };
  if (freq === 'weekly') return { start: iso(addDays(-13)), end: iso(addDays(-7)) };
  if (freq === 'biweekly') return { start: iso(addDays(-20)), end: iso(addDays(-7)) };
  if (freq === 'monthly') {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return { start: iso(start), end: iso(end) };
  }
  if (d.getUTCDate() <= 15) {
    return {
      start: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))),
      end: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15))),
    };
  }
  return {
    start: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 16))),
    end: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))),
  };
}

export function lineAmount(calc: PayrollCalc, code: string): number {
  return calc.lines.filter((line) => line.code === code).reduce((sum, line) => sum + line.amount_cents, 0);
}

export function bp(amount: number, basisPoints: number): number {
  return muldivRound(amount, basisPoints, 10000);
}

function utcDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new PayrollCalcError('Pay date must be YYYY-MM-DD');
  return new Date(`${iso}T00:00:00Z`);
}

function money(value: string | number | undefined, label: string): number {
  try {
    return moneyIn(value ?? '0', label);
  } catch (err) {
    throw new PayrollCalcError(err instanceof Error ? err.message : `${label}: invalid amount`);
  }
}

function hoursIn(value: string | number | undefined, field: string, max = 100000): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const s = String(value ?? '').trim();
  if (s === '') return 0;
  const match = s.match(/^(\d{1,4})(?:\.(\d{1,2}))?$/);
  if (!match) throw new PayrollCalcError(`${field}: invalid hours "${s}" (max 2 decimals)`);
  const hours = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (hours > max) throw new PayrollCalcError(`${field}: too many hours`);
  return hours;
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function exemptHoursE2(freq: PayFrequency): number {
  if (freq === 'weekly') return 4000;
  if (freq === 'biweekly') return 8000;
  if (freq === 'monthly') return 17333;
  return 8667;
}

type Bracket = readonly [number, number, number];

function bracketRow(table: readonly Bracket[], amount: number, inclusive: boolean): Bracket {
  let row = table[0];
  for (const entry of table) {
    if (inclusive ? amount >= entry[0] : amount > entry[0]) row = entry;
  }
  return row;
}

/** Pub. 15-T 2026 Worksheet 1A. `taxable` is this period's federal taxable wages. */
export function fedWithholding(person: PayrollPerson, taxable: number, periods: number, tables: PayrollYearTables): { amount: number; note: string } {
  if (person.fed_exempt) return { amount: 0, note: 'Exempt (W-4)' };
  const annual = taxable * periods;
  let adjusted = 0;
  let table: readonly Bracket[];
  if (person.w4_version === 'legacy') {
    adjusted = Math.max(0, annual - person.fed_allowances * tables.fed.allowance);
    const status = person.fed_status === 'mfj' ? 'mfj' : 'single';
    table = tables.fed.standard[status];
  } else {
    const step2 = person.fed_step2;
    const line1g = step2 ? 0 : (person.fed_status === 'mfj' ? tables.fed.line1g.mfj : tables.fed.line1g.other);
    adjusted = Math.max(0, annual + person.fed_other_income_cents - (person.fed_deductions_cents + line1g));
    table = tables.fed[step2 ? 'checkbox' : 'standard'][person.fed_status];
  }
  const row = bracketRow(table, adjusted, true);
  const tentativeAnnual = row[1] + muldivRound(adjusted - row[0], row[2], 100);
  const tentative = muldivRound(tentativeAnnual, 1, periods);
  const credit = person.w4_version === 'legacy' ? 0 : muldivRound(person.fed_dependents_cents, 1, periods);
  return {
    amount: Math.max(0, tentative - credit) + person.fed_extra_cents,
    note: `Adjusted annual wage ${adjusted}; tentative ${tentative}/period`,
  };
}

/** California DE 44 Method B, annualized. */
export function caWithholding(
  person: PayrollPerson,
  pitWages: number,
  freq: PayFrequency,
  periods: number,
  tables: PayrollYearTables,
): { amount: number; note: string } {
  const ca = tables.CA;
  if (person.st_exempt) return { amount: 0, note: 'Exempt (DE 4)' };
  const high = person.st_status === 'hoh' || (person.st_status === 'married' && person.st_allowances >= 2);
  const low = ca.low_income[freq][high ? 1 : 0];
  if (pitWages <= low) return { amount: person.st_extra_cents, note: `Below low-income exemption (${low})` };
  let annual = pitWages * periods;
  annual -= person.st_est_allowances * ca.est_deduction_annual;
  const taxable = Math.max(0, annual - ca.std_deduction_annual[high ? 1 : 0]);
  const status = person.st_status === 'married' ? 'married' : person.st_status === 'hoh' ? 'hoh' : 'single';
  const row = bracketRow(ca.rates[status], taxable, false);
  let tax = row[1] + muldivRound(taxable - row[0], row[2], 100000);
  const regular = Math.max(0, person.st_allowances - person.st_est_allowances);
  tax = Math.max(0, tax - regular * ca.exemption_annual);
  return { amount: muldivRound(tax, 1, periods) + person.st_extra_cents, note: `DE 44 Method B, taxable ${taxable}/yr` };
}

function summedPrior(prior: ApprovedStubRef[], payDate: string, throughYearEnd: boolean) {
  const year = payDate.slice(0, 4);
  const cutoff = throughYearEnd ? `${year}-12-31` : payDate;
  const lines: Record<string, number> = {};
  const hours: Record<string, number> = {};
  const wages: Record<string, number> = {};
  for (const stub of prior) {
    if (stub.payDate.slice(0, 4) !== year || stub.payDate > cutoff) continue;
    for (const line of stub.calc.lines ?? []) {
      lines[line.code] = (lines[line.code] ?? 0) + line.amount_cents;
      if (line.hours_e2 != null) hours[line.code] = (hours[line.code] ?? 0) + line.hours_e2;
    }
    for (const [key, value] of Object.entries(stub.calc.wages ?? {})) {
      wages[key] = (wages[key] ?? 0) + value;
    }
  }
  return { lines, hours, wages };
}

function leaveBefore(person: PayrollPerson, prior: ApprovedStubRef[], payDate: string) {
  const earlier = prior.filter((stub) => stub.payDate <= payDate).sort((a, b) => (a.payDate < b.payDate ? 1 : a.payDate > b.payDate ? -1 : 0));
  const latest = earlier[0];
  if (latest) {
    return {
      sick: latest.calc.leave?.sick.balance_e2 ?? 0,
      pto: latest.calc.leave?.pto.balance_e2 ?? 0,
      lastDate: latest.payDate,
    };
  }
  return { sick: person.sick_open_e2, pto: person.pto_open_e2, lastDate: null as string | null };
}

export function payrollCompute(
  person: PayrollPerson,
  run: PayrollRunSlice,
  inputs: StubInputs,
  prior: ApprovedStubRef[],
  settings: PayrollSettings = defaultPayrollSettings(),
): PayrollCalc {
  utcDate(run.pay_date);
  const year = Number(run.pay_date.slice(0, 4));
  const tables = payrollTables(year);
  const freq: PayFrequency = person.frequency in PAY_PERIODS ? person.frequency : settings.default_frequency;
  const periods = PAY_PERIODS[freq];
  const printed = summedPrior(prior, run.pay_date, false);
  const limits = summedPrior(prior, run.pay_date, true);
  const backdated = prior.filter((stub) => stub.payDate.slice(0, 4) === String(year) && stub.payDate > run.pay_date).length;
  const overrides = inputs.overrides ?? {};
  const warnings: string[] = [];
  const lines: PayLine[] = [];
  const push = (line: PayLine) => { lines.push(line); };

  if (person.kind === '1099') {
    const amount = money(inputs.amount, 'Contractor payment');
    const description = clip(inputs.description ?? '', 120) || 'Services';
    if (amount > 0) push({ code: 'contract', cat: 'earning', label: description, amount_cents: amount });
    let reimb = 0;
    for (const [index, row] of (inputs.reimbursements ?? []).entries()) {
      const value = money(row.amount, `Reimbursement ${index + 1}`);
      if (value <= 0) continue;
      push({
        code: `reimb${index}`,
        cat: 'reimb',
        label: clip(row.label ?? '', 60) || 'Reimbursement',
        amount_cents: value,
        account_id: row.account_id ?? null,
      });
      reimb += value;
    }
    let backup = 0;
    if (person.backup_wh && amount > 0) {
      const overridden = Object.prototype.hasOwnProperty.call(overrides, 'backup') && overrides.backup !== '';
      backup = overridden ? money(overrides.backup, 'Backup withholding override') : bp(amount, tables.fed.backup_bp);
      push({
        code: 'backup',
        cat: 'tax_ee',
        label: 'Federal backup withholding (24%)',
        amount_cents: backup,
        liab: 'pay_fed',
        overridden,
      });
    }
    if (!person.tin_on_file) warnings.push('No TIN on file. Get a W-9 before paying; without one you must withhold 24% backup withholding.');
    if (amount + reimb <= 0) warnings.push('Nothing to pay.');
    for (const line of lines) line.ytd_cents = (printed.lines[line.code] ?? 0) + line.amount_cents;
    return {
      kind: '1099',
      lines,
      gross_cents: amount,
      net_cents: amount + reimb - backup,
      reimb_cents: reimb,
      wages: { nec: amount, backup },
      ytd_wages: { nec: (printed.wages.nec ?? 0) + amount },
      warnings,
      leave: null,
      tables_year: year,
    };
  }

  const rate = person.pay_rate_cents;
  let regH = hoursIn(inputs.regular_hours, 'Regular hours');
  const otH = hoursIn(inputs.overtime_hours, 'Overtime hours');
  const dtH = hoursIn(inputs.doubletime_hours, 'Doubletime hours');
  const sickH = hoursIn(inputs.sick_hours, 'Sick hours');
  const ptoH = hoursIn(inputs.pto_hours, 'Pto hours');
  const holH = hoursIn(inputs.holiday_hours, 'Holiday hours');
  const skipRegular = run.kind !== 'regular' && !inputs.include_regular;
  const inputsBlank = Object.values(inputs).every((value) => value == null || value === '');
  let worked = 0;

  if (person.pay_type === 'salary') {
    let period = skipRegular ? 0 : muldivRound(rate, 1, periods);
    if (inputs.salary != null && inputs.salary.trim() !== '') {
      period = money(inputs.salary, 'Salary this period');
      if (!skipRegular) warnings.push('Salary adjusted for a partial period.');
    }
    const hourlyEq = muldivRound(rate, 1, 2080);
    const sickAmt = Math.min(period, muldivRound(sickH, hourlyEq, 100));
    const ptoAmt = Math.min(period - sickAmt, muldivRound(ptoH, hourlyEq, 100));
    const holAmt = Math.min(period - sickAmt - ptoAmt, muldivRound(holH, hourlyEq, 100));
    const salary = period - sickAmt - ptoAmt - holAmt;
    if (salary > 0 || (period === 0 && !skipRegular)) push({ code: 'salary', cat: 'earning', label: 'Salary', amount_cents: salary });
    if (sickAmt) push({ code: 'sick', cat: 'earning', label: 'Sick pay', amount_cents: sickAmt, hours_e2: sickH, rate_cents: hourlyEq });
    if (ptoAmt) push({ code: 'pto', cat: 'earning', label: 'Vacation / PTO', amount_cents: ptoAmt, hours_e2: ptoH, rate_cents: hourlyEq });
    if (holAmt) push({ code: 'holiday', cat: 'earning', label: 'Holiday', amount_cents: holAmt, hours_e2: holH, rate_cents: hourlyEq });
    worked = skipRegular ? 0 : (person.flsa_exempt ? exemptHoursE2(freq) : Math.max(0, (regH || exemptHoursE2(freq)) - sickH - ptoH - holH));
    if (!person.flsa_exempt && (otH || dtH)) {
      if (otH) push({ code: 'ot', cat: 'earning', label: 'Overtime 1.5x', amount_cents: muldivRound(otH, hourlyEq * 3, 200), hours_e2: otH, rate_cents: muldivRound(hourlyEq, 3, 2) });
      if (dtH) push({ code: 'dt', cat: 'earning', label: 'Double time 2x', amount_cents: muldivRound(dtH, hourlyEq * 2, 100), hours_e2: dtH, rate_cents: hourlyEq * 2 });
      worked += otH + dtH;
    }
    if (person.work_state === 'CA' && person.flsa_exempt && rate > 0 && rate < tables.CA.exempt_salary_cents) {
      warnings.push(`Annual salary is below the 2026 California exempt minimum (${tables.CA.exempt_salary_cents} cents). This employee cannot be classified exempt.`);
    }
    if (person.is_officer && rate === 0 && !skipRegular) {
      warnings.push('Officer salary is $0. The IRS expects reasonable compensation for shareholder-officers who perform services.');
    }
  } else {
    if (rate <= 0) throw new PayrollCalcError(`${personName(person) || 'Employee'}: hourly rate is not set`);
    if (!skipRegular && regH === 0 && inputsBlank) regH = person.std_hours_e2;
    if (regH) push({ code: 'regular', cat: 'earning', label: 'Regular', amount_cents: muldivRound(regH, rate, 100), hours_e2: regH, rate_cents: rate });
    if (otH) push({ code: 'ot', cat: 'earning', label: 'Overtime 1.5x', amount_cents: muldivRound(otH, rate * 3, 200), hours_e2: otH, rate_cents: muldivRound(rate, 3, 2) });
    if (dtH) push({ code: 'dt', cat: 'earning', label: 'Double time 2x', amount_cents: muldivRound(dtH, rate * 2, 100), hours_e2: dtH, rate_cents: rate * 2 });
    if (sickH) push({ code: 'sick', cat: 'earning', label: 'Sick pay', amount_cents: muldivRound(sickH, rate, 100), hours_e2: sickH, rate_cents: rate });
    if (ptoH) push({ code: 'pto', cat: 'earning', label: 'Vacation / PTO', amount_cents: muldivRound(ptoH, rate, 100), hours_e2: ptoH, rate_cents: rate });
    if (holH) push({ code: 'holiday', cat: 'earning', label: 'Holiday', amount_cents: muldivRound(holH, rate, 100), hours_e2: holH, rate_cents: rate });
    worked = regH + otH + dtH;
    const minimum = Math.max(person.work_state === 'CA' ? tables.CA.min_wage_cents : 0, settings.local_min_wage_cents);
    if (minimum && rate < minimum) {
      warnings.push(`Hourly rate is below the minimum wage${settings.local_min_wage_label ? ` (${settings.local_min_wage_label})` : ''}.`);
    }
    const weeklyCap = { weekly: 4000, biweekly: 8000, semimonthly: 8667, monthly: 17334 }[freq];
    if (person.work_state === 'CA' && regH > 0 && !otH && regH > weeklyCap) {
      warnings.push('More than 40 hours/week of regular time. California requires overtime over 8 hours in a day or 40 in a week.');
    }
  }

  let supplemental = 0;
  for (const [index, extra] of (inputs.earnings ?? []).entries()) {
    const amount = money(extra.amount, `Earning ${index + 1}`);
    if (amount <= 0) continue;
    const type = extra.type === 'bonus' || extra.type === 'commission' || extra.type === 'other' ? extra.type : 'other';
    push({
      code: `${type}${index}`,
      cat: 'earning',
      label: clip(extra.label ?? '', 60) || type.charAt(0).toUpperCase() + type.slice(1),
      amount_cents: amount,
      supp: type,
    });
    if (type !== 'other' || run.kind === 'offcycle') supplemental += amount;
    if (type !== 'other' && (otH || dtH)) {
      warnings.push(`A ${type} paid with overtime changes the regular rate; check the overtime rate (non-discretionary bonuses count).`);
    }
  }

  const gross = lines.filter((line) => line.cat === 'earning').reduce((sum, line) => sum + line.amount_cents, 0);
  let reimb = 0;
  for (const [index, row] of (inputs.reimbursements ?? []).entries()) {
    const amount = money(row.amount, `Reimbursement ${index + 1}`);
    if (amount <= 0) continue;
    push({
      code: `reimb${index}`,
      cat: 'reimb',
      label: clip(row.label ?? '', 60) || 'Expense reimbursement',
      amount_cents: amount,
      account_id: row.account_id ?? null,
    });
    reimb += amount;
  }

  const skipDed = inputs.skip_deductions === true;
  const skipBenefits = skipDed || (run.kind === 'offcycle' && !inputs.include_benefits);
  const health = skipBenefits ? 0 : Math.min(gross, person.health_pretax_cents);
  if (health) push({ code: 'health125', cat: 'pretax', label: 'Health insurance (pre-tax)', amount_cents: health, liab: 'pay_health' });

  const limits401 = tables.k401;
  const age = person.birth_year ? year - person.birth_year : 0;
  const catchup = age >= 60 && age <= 63 ? limits401.catchup6063 : age >= 50 ? limits401.catchup50 : 0;
  const ytdDeferral = (limits.lines.k401 ?? 0) + (limits.lines.k401roth ?? 0);
  let traditional = 0;
  let roth = 0;
  if (person.k401_type !== 'none' && !skipDed) {
    let want = person.k401_pct_bp ? bp(gross, person.k401_pct_bp) : Math.min(gross, person.k401_flat_cents);
    const overridden = Object.prototype.hasOwnProperty.call(overrides, 'k401') && overrides.k401 !== '';
    if (overridden) want = money(overrides.k401, '401(k) override');
    const room = Math.max(0, limits401.deferral + catchup - ytdDeferral);
    if (want > room) {
      warnings.push(`401(k) capped at the ${year} limit (${limits401.deferral + catchup} cents incl. catch-up).`);
      want = room;
    }
    want = Math.min(want, gross - health);
    const baseRoom = Math.max(0, limits401.deferral - ytdDeferral);
    const catchPart = Math.max(0, want - baseRoom);
    if (person.k401_type === 'roth') roth = want;
    else if (person.k401_prior_high && catchPart > 0) {
      traditional = want - catchPart;
      roth = catchPart;
      warnings.push(`Catch-up portion made Roth (prior-year FICA wages over ${limits401.roth_catchup_threshold} cents).`);
    } else traditional = want;
    if (traditional) push({ code: 'k401', cat: 'pretax', label: '401(k)', amount_cents: traditional, liab: 'pay_401k', overridden });
    if (roth) push({ code: 'k401roth', cat: 'posttax', label: 'Roth 401(k)', amount_cents: roth, liab: 'pay_401k' });
  }

  const wages: Record<string, number> = {};
  wages.gross = gross;
  wages.fit = Math.max(0, gross - health - traditional);
  wages.fica = person.fica_exempt ? 0 : Math.max(0, gross - health);
  wages.ss = Math.max(0, Math.min(wages.fica, tables.fica.ss_base - (limits.wages.ss ?? 0)));
  wages.med = wages.fica;
  wages.futa_subject = Math.max(0, gross - health);
  wages.futa = Math.max(0, Math.min(wages.futa_subject, tables.futa.base - (limits.wages.futa ?? 0)));
  wages.state_wh = Math.max(0, gross - health - traditional);
  wages.sdi = person.work_state === 'CA' && !person.sdi_exempt ? Math.max(0, gross - health) : 0;
  wages.sui_subject = Math.max(0, gross - health);
  const sui = settings.sui[person.work_state] ?? null;
  const suiBase = sui ? sui.base_cents : 0;
  wages.sui = sui ? (suiBase > 0 ? Math.max(0, Math.min(wages.sui_subject, suiBase - (limits.wages.sui ?? 0))) : wages.sui_subject) : 0;
  wages.supp = supplemental;
  wages.k401_def = traditional + roth;

  const taxLine = (code: string, label: string, computed: number, liab: string, note = '') => {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, code) && overrides[code] !== '' && overrides[code] != null;
    const amount = overridden ? money(overrides[code], `${label} override`) : computed;
    push({
      code,
      cat: 'tax_ee',
      label,
      amount_cents: amount,
      liab,
      computed_cents: computed,
      overridden,
      note,
    });
    return amount;
  };

  let fitSupp = 0;
  let fitReg = 0;
  let fitNote = '';
  const suppFit = Math.min(wages.fit, run.kind === 'offcycle' ? supplemental : 0);
  if (run.kind === 'offcycle' && suppFit > 0 && !person.fed_exempt) {
    const ytdSupp = limits.wages.supp ?? 0;
    const over = Math.max(0, ytdSupp + suppFit - 100000000);
    fitSupp = bp(suppFit - over, tables.fed.supplemental_bp) + bp(over, tables.fed.supplemental_over_1m_bp);
    fitNote = 'Supplemental flat 22%';
  }
  const regularFitWages = wages.fit - suppFit;
  if (regularFitWages > 0) {
    const federal = fedWithholding(person, regularFitWages, periods, tables);
    fitReg = run.kind === 'regular' ? federal.amount : Math.max(0, federal.amount - person.fed_extra_cents);
    fitNote = `${fitNote} ${federal.note}`.trim();
  } else if (run.kind === 'regular' && !person.fed_exempt) {
    fitReg = person.fed_extra_cents;
  }
  const fit = taxLine('fit', 'Federal income tax', fitSupp + fitReg, 'pay_fed', fitNote);
  const socialSecurity = taxLine('ss', 'Social Security', bp(wages.ss, tables.fica.ss_bp), 'pay_fed', `6.2% up to ${tables.fica.ss_base} cents YTD`);
  const medicare = taxLine('med', 'Medicare', bp(wages.med, tables.fica.med_bp), 'pay_fed', '1.45%');
  const ytdMed = limits.wages.med ?? 0;
  const addlBase = Math.max(0, ytdMed + wages.med - Math.max(ytdMed, tables.fica.addl_med_threshold));
  wages.addl_med = addlBase;
  const additional = addlBase
    ? taxLine('addl_med', 'Additional Medicare', bp(addlBase, tables.fica.addl_med_bp), 'pay_fed', '0.9% over $200,000 YTD')
    : 0;

  const state = person.work_state;
  let stateWithholding = 0;
  let sdi = 0;
  if (state === 'CA') {
    const suppCa = run.kind === 'offcycle' ? Math.min(wages.state_wh, supplemental) : 0;
    let caSupp = 0;
    if (suppCa && !person.st_exempt) {
      for (const line of lines) {
        if (line.supp && line.cat === 'earning') caSupp += bp(line.amount_cents, line.supp === 'bonus' ? tables.CA.bonus_bp : tables.CA.supp_bp);
      }
      caSupp = Math.min(caSupp, bp(suppCa, tables.CA.bonus_bp));
    }
    let caReg = 0;
    let note = caSupp ? 'Supplemental flat (bonus 10.23% / other 6.6%)' : '';
    if (wages.state_wh - suppCa > 0) {
      const california = caWithholding(person, wages.state_wh - suppCa, freq, periods, tables);
      caReg = california.amount;
      note = `${note} ${california.note}`.trim();
    }
    stateWithholding = taxLine('state_wh', 'CA income tax', caSupp + caReg, 'pay_state_wh', note);
    sdi = wages.sdi ? taxLine('sdi', 'CA SDI', bp(wages.sdi, tables.CA.sdi_bp), 'pay_sdi', '1.3%, no wage limit') : 0;
  } else if ((PAY_NO_INCOME_TAX_STATES as readonly string[]).includes(state)) {
    if (state === 'WA') warnings.push('Washington PFML and WA Cares premiums are not calculated here; add them as post-tax deductions / employer costs.');
  } else {
    const flat = person.st_flat_bp;
    stateWithholding = taxLine(
      'state_wh',
      `${state} income tax`,
      person.st_exempt ? 0 : bp(wages.state_wh, flat) + person.st_extra_cents,
      'pay_state_wh',
      flat ? `Flat ${flat / 100}% (set on the employee)` : '',
    );
    warnings.push(`${state} withholding uses a flat percent you set, not that state's tables.`);
  }
  if (!sui && wages.sui_subject > 0) warnings.push(`No unemployment insurance rate set for ${state}. Add it in payroll settings.`);

  const employeeTax = fit + socialSecurity + medicare + additional + stateWithholding + sdi;
  let net = gross - health - traditional - roth - employeeTax;
  const post = skipBenefits ? [] : [...person.posttax];
  for (const row of inputs.posttax ?? []) {
    const amount = money(row.amount, 'One-time deduction');
    if (amount > 0) post.push({ label: clip(row.label ?? '', 60) || 'Deduction', amount_cents: amount });
  }
  for (const [index, row] of post.entries()) {
    let amount = row.amount_cents;
    if (amount > net) {
      warnings.push(`"${row.label}" reduced so net pay is not negative.`);
      amount = Math.max(0, net);
    }
    if (!amount) continue;
    push({ code: `post${index}`, cat: 'posttax', label: row.label, amount_cents: amount, liab: 'pay_other' });
    if (row.garnishment) warnings.push(`Garnishment "${row.label}": confirm it is within the order and the disposable-earnings limits.`);
    net -= amount;
  }
  if (net < 0) warnings.push('Net pay is negative. Reduce deductions or overrides before approving.');
  net += reimb;

  const employer = (code: string, label: string, amount: number, liab: string, exp: string, note = '') => {
    if (amount) push({ code, cat: 'tax_er', label, amount_cents: amount, liab, exp, note });
    return amount;
  };
  employer('er_ss', 'Social Security (employer)', bp(wages.ss, tables.fica.ss_bp), 'pay_fed', 'payroll_taxes');
  employer('er_med', 'Medicare (employer)', bp(wages.med, tables.fica.med_bp), 'pay_fed', 'payroll_taxes');
  const creditReduction = settings.futa_cr_bp[state] ?? tables.futa.credit_reduction_bp[state as 'CA'] ?? 0;
  employer(
    'futa',
    'FUTA',
    bp(wages.futa, tables.futa.net_bp + creditReduction),
    'pay_futa',
    'payroll_taxes',
    creditReduction ? `0.6% + ${creditReduction / 100}% ${state} credit reduction` : '0.6%',
  );
  if (sui) {
    employer('sui', `${state} unemployment (SUI)`, bp(wages.sui, sui.rate_bp), 'pay_sui', 'payroll_taxes', `${sui.rate_bp / 100}%`);
    if (state === 'CA') employer('ett', 'CA ETT', bp(wages.sui, sui.ett_bp), 'pay_sui', 'payroll_taxes', `${sui.ett_bp / 100}%`);
  }
  if (person.k401_type !== 'none' && settings.k401_match_pct_bp && settings.k401_match_cap_bp && traditional + roth > 0) {
    const comp = Math.max(0, Math.min(gross, limits401.comp_limit - (limits.wages.gross ?? 0)));
    const match = bp(Math.min(traditional + roth, bp(comp, settings.k401_match_cap_bp)), settings.k401_match_pct_bp);
    employer('k401_match', '401(k) employer match', match, 'pay_401k', 'pension');
    wages.k401_match = match;
    const additions = (limits.lines.k401 ?? 0) + (limits.lines.k401roth ?? 0) + (limits.lines.k401_match ?? 0) + traditional + roth + match;
    if (additions > limits401.annual_additions + catchup) warnings.push('401(k) annual additions exceed the 415(c) limit.');
  }
  if (!skipBenefits && person.health_er_cents) {
    employer('health_er', 'Health insurance (employer)', person.health_er_cents, 'pay_health', 'benefits');
  }

  const before = leaveBefore(person, prior, run.pay_date);
  let sickBal = before.sick;
  let sickAcc = 0;
  if (person.sick_policy === 'frontload') {
    const newYear = before.lastDate == null || before.lastDate.slice(0, 4) !== String(year);
    if (newYear) sickAcc = Math.max(0, settings.sick_frontload_e2 - sickBal);
  } else if (person.sick_policy === 'accrue') {
    sickAcc = Math.floor(worked / 30);
    if (person.sick_cap_e2 > 0) sickAcc = Math.max(0, Math.min(sickAcc, person.sick_cap_e2 - sickBal));
  }
  sickBal += sickAcc - sickH;
  if (sickBal < 0) warnings.push('Sick hours used exceed the available balance.');
  let ptoAcc = run.kind === 'regular' ? person.pto_per_period_e2 : 0;
  if (person.pto_cap_e2 > 0) ptoAcc = Math.max(0, Math.min(ptoAcc, person.pto_cap_e2 - before.pto));
  const ptoBal = before.pto + ptoAcc - ptoH;
  if (ptoBal < 0) warnings.push('PTO used exceeds the available balance.');

  const leave: LeaveBalance = {
    sick: { accrued_e2: sickAcc, used_e2: sickH, balance_e2: sickBal, policy: person.sick_policy },
    pto: { accrued_e2: ptoAcc, used_e2: ptoH, balance_e2: ptoBal },
    worked_e2: worked,
  };
  for (const line of lines) {
    line.ytd_cents = (printed.lines[line.code] ?? 0) + line.amount_cents;
    if (line.hours_e2 != null) line.ytd_hours_e2 = (printed.hours[line.code] ?? 0) + line.hours_e2;
  }
  const ytdWages: Record<string, number> = {};
  for (const [key, value] of Object.entries(wages)) ytdWages[key] = (printed.wages[key] ?? 0) + value;
  const sumCat = (cat: PayLine['cat']) => lines.filter((line) => line.cat === cat).reduce((sum, line) => sum + line.amount_cents, 0);
  if (gross === 0 && reimb === 0) warnings.push('Nothing to pay this period.');
  if (backdated) warnings.push(`Backdated: ${backdated} approved stub(s) dated after this one already exist.`);

  return {
    kind: 'w2',
    lines,
    wages,
    ytd_wages: ytdWages,
    gross_cents: gross,
    net_cents: net,
    reimb_cents: reimb,
    pretax_cents: sumCat('pretax'),
    tax_ee_cents: sumCat('tax_ee'),
    posttax_cents: sumCat('posttax'),
    tax_er_cents: sumCat('tax_er'),
    hours_e2: regH + otH + dtH + sickH + ptoH + holH,
    leave,
    warnings: [...new Set(warnings)],
    frequency: freq,
    periods,
    tables_year: year,
  };
}

/**
 * One journal per approved stub. Net pay credits cash when a cash account is
 * chosen, otherwise wages payable. The credit records the amount. It is not a payment.
 */
export function payrollJournalDraft(
  calc: PayrollCalc,
  person: Pick<PayrollPerson, 'kind' | 'is_officer'>,
  settleNetTo: 'cash' | 'wages_payable',
): JournalDraftLine[] {
  const debits = new Map<string, JournalDraftLine>();
  const credits = new Map<string, JournalDraftLine>();
  const add = (bucket: Map<string, JournalDraftLine>, systemKey: string, amount: number, memo: string, side: 'debit' | 'credit') => {
    if (!amount) return;
    const key = `${systemKey}|${memo}`;
    const existing = bucket.get(key);
    if (existing) {
      if (side === 'debit') existing.debitCents += amount;
      else existing.creditCents += amount;
      return;
    }
    bucket.set(key, {
      systemKey,
      debitCents: side === 'debit' ? amount : 0,
      creditCents: side === 'credit' ? amount : 0,
      memo,
    });
  };
  const wageKey = person.kind === '1099' ? 'contractors' : person.is_officer ? 'officer_comp' : 'wages';
  for (const line of calc.lines) {
    if (line.cat === 'earning') add(debits, wageKey, line.amount_cents, 'Gross pay', 'debit');
    else if (line.cat === 'reimb') add(debits, 'reimb', line.amount_cents, line.label, 'debit');
    else if (line.cat === 'pretax' || line.cat === 'posttax' || line.cat === 'tax_ee') {
      add(credits, line.liab || 'pay_other', line.amount_cents, line.label, 'credit');
    } else if (line.cat === 'tax_er') {
      add(debits, line.exp || 'payroll_taxes', line.amount_cents, line.label, 'debit');
      add(credits, line.liab || 'pay_other', line.amount_cents, line.label, 'credit');
    }
  }
  if (calc.net_cents > 0) {
    add(credits, settleNetTo === 'cash' ? 'cash' : 'pay_wages', calc.net_cents, 'Net pay recorded, not sent', 'credit');
  }
  return [...debits.values(), ...credits.values()];
}

export function journalBalances(lines: JournalDraftLine[]): boolean {
  const debit = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditCents, 0);
  return debit === credit && debit >= 0;
}
