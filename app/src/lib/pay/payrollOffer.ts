/**
 * Hiring checklist and offer-letter text, ported from nave-books/lib/onboarding.php.
 * Sending an offer freezes this JSON and stores its SHA-256. The letter is not a filing.
 */

import { PAY_NO_INCOME_TAX_STATES, PAYROLL_YEAR, payrollTables, type PayFrequency } from './payrollTables';
import { personName, type PayrollPerson } from './payrollCalc';

export interface ChecklistItem {
  key: string;
  label: string;
  help: string;
  blocks: boolean;
}

export interface OfferTerms {
  letter_date: string;
  title: string;
  department: string;
  manager_name: string;
  manager_title: string;
  start_date: string;
  work_location: string;
  employment_type: 'full_time' | 'part_time';
  pay_type: 'salary' | 'hourly';
  rate_cents: number;
  frequency: PayFrequency;
  exempt: boolean;
  bonus_text: string;
  equity_type: '' | 'option' | 'rsa' | 'rsu' | 'token';
  equity_amount: string;
  equity_vesting: string;
  benefits_text: string;
  pto_text: string;
  background_check: boolean;
  ciiaa: boolean;
  other_contingency: string;
  custom_text: string;
  expires_on: string;
  signer_name: string;
  signer_title: string;
}

export interface OfferLetter {
  version: 1;
  company: { name: string; address: string };
  date: string;
  to: { name: string; address: string[]; email: string };
  salutation: string;
  sections: { h: string; p: string }[];
  closing: { from: string; title: string; company: string };
  acceptance: string;
  expires: string;
}

export function onboardingChecklist(person: Pick<PayrollPerson, 'kind' | 'work_state' | 'flsa_exempt'>): ChecklistItem[] {
  if (person.kind === '1099') {
    return [
      { key: 'w9', label: 'Form W-9 received', help: 'Legal name, TIN, and entity type. Without a valid TIN, backup withholding is 24%.', blocks: true },
      { key: 'agreement', label: 'Contractor agreement signed', help: 'Scope, rate, IP assignment, and confidentiality.', blocks: false },
      { key: 'classification', label: 'Classification checked (ABC test)', help: 'California presumes a worker is an employee unless all three ABC-test prongs are met.', blocks: false },
      { key: 'payment', label: 'Payment details on file', help: 'Address for checks, or bank details confirmed with the person.', blocks: false },
    ];
  }
  const ca = person.work_state === 'CA';
  const items: ChecklistItem[] = [
    { key: 'offer', label: 'Offer letter signed', help: 'The letter below is hashed when it is sent.', blocks: false },
    { key: 'i9', label: 'Form I-9 completed', help: 'Section 1 by the first day of work. Section 2 within 3 business days. Store I-9s apart from the personnel file.', blocks: false },
    { key: 'w4', label: 'Form W-4 received and entered', help: 'Enter filing status and Steps 2 through 4 on the person record.', blocks: true },
  ];
  if (ca) items.push({ key: 'de4', label: 'Form DE 4 received and entered', help: 'California withholding allowances. If they skip it, withhold as single with zero allowances.', blocks: true });
  else if (!(PAY_NO_INCOME_TAX_STATES as readonly string[]).includes(person.work_state)) {
    items.push({ key: 'state_w4', label: 'State withholding form entered', help: `${person.work_state} withholding certificate.`, blocks: true });
  }
  items.push(
    { key: 'direct_deposit', label: 'Direct deposit authorization', help: 'Signed form with routing and account, or a paper check until it is on file.', blocks: false },
    { key: 'ciiaa', label: 'Confidentiality & invention assignment signed', help: 'Before they touch code or keys. California Labor Code 2870 notice must be attached.', blocks: false },
  );
  if (ca && !person.flsa_exempt) {
    items.push({ key: 'wtpa', label: 'Labor Code 2810.5 notice given', help: 'Wage notice for non-exempt employees: rate, payday, employer, and sick leave.', blocks: false });
  }
  return items;
}

export function activationBlockers(
  person: PayrollPerson,
  items: { key: string; blocks: boolean; status: 'todo' | 'done' | 'na' }[],
  hasAccount: boolean,
): string[] {
  if (person.status !== 'candidate') return [];
  const blockers: string[] = [];
  for (const item of items) {
    if (item.blocks && item.status === 'todo') {
      blockers.push(onboardingChecklist(person).find((row) => row.key === item.key)?.label ?? item.key);
    }
  }
  if (person.kind === 'w2') {
    if (!person.tin_on_file) blockers.push('SSN on the employee record');
    if (person.pay_rate_cents <= 0 && !person.is_officer) blockers.push('Pay rate');
    if (person.pay_method === 'direct_deposit' && !hasAccount) blockers.push('Direct deposit account, or switch to a paper check');
  }
  return blockers;
}

export function businessDaysAfter(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return date.toISOString().slice(0, 10);
}

function longDate(iso: string): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [year, month, day] = iso.split('-').map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}

function moneyWords(cents: number): string {
  const dollars = Math.trunc(cents / 100);
  const rem = Math.abs(cents % 100);
  const body = dollars.toLocaleString('en-US');
  return rem ? `$${body}.${String(rem).padStart(2, '0')}` : `$${body}`;
}

const FREQ_WORDS: Record<PayFrequency, string> = {
  weekly: 'weekly',
  biweekly: 'every two weeks',
  semimonthly: 'twice a month',
  monthly: 'monthly',
};

export function renderOffer(
  terms: OfferTerms,
  person: Pick<PayrollPerson, 'kind' | 'first_name' | 'middle_name' | 'last_name' | 'business_name'>,
  company: { legal_name: string; address: string },
  address: string[] = [],
  workState = 'CA',
): OfferLetter {
  const tables = payrollTables(PAYROLL_YEAR);
  if (workState === 'CA' && terms.exempt && terms.employment_type === 'full_time' && terms.pay_type === 'salary' && terms.rate_cents < tables.CA.exempt_salary_cents) {
    throw new Error('A California exempt salary must meet the 2026 minimum. Raise it or mark the role non-exempt.');
  }
  if (workState === 'CA' && terms.pay_type === 'hourly' && terms.rate_cents < tables.CA.min_wage_cents) {
    throw new Error('Hourly pay is below the 2026 California minimum wage.');
  }
  const companyName = company.legal_name.trim() || 'the Company';
  const first = person.first_name || personName(person);
  const freq = FREQ_WORDS[terms.frequency];
  const sections: { h: string; p: string }[] = [];
  sections.push({
    h: 'Position',
    p: `We are pleased to offer you the position of ${terms.title}${terms.department ? ` on the ${terms.department} team` : ''} at ${companyName} (the "Company")${terms.manager_name ? `, reporting to ${terms.manager_name}${terms.manager_title ? `, ${terms.manager_title}` : ''}` : ''}. This is a ${terms.employment_type === 'full_time' ? 'full-time' : 'part-time'} position. Your anticipated start date is ${longDate(terms.start_date)}, and your work location will be ${terms.work_location}.`,
  });
  sections.push({
    h: 'Compensation',
    p: terms.pay_type === 'salary'
      ? `You will be paid an annual base salary of ${moneyWords(terms.rate_cents)}, paid ${freq} in accordance with the Company's normal payroll practices and subject to applicable withholdings and deductions. This position is classified as ${terms.exempt ? 'exempt' : 'non-exempt'} under federal and California wage and hour law${terms.exempt ? ', and you will not be eligible for overtime pay.' : ', and you will be paid overtime as required by law.'}`
      : `You will be paid ${moneyWords(terms.rate_cents)} per hour, paid ${freq} in accordance with the Company's normal payroll practices and subject to applicable withholdings and deductions. This position is classified as non-exempt, and you will be paid overtime as required by federal and California law.`,
  });
  if (terms.equity_type) {
    const grant = {
      option: `an option to purchase ${terms.equity_amount} shares of the Company's common stock`,
      rsa: `${terms.equity_amount} shares of the Company's common stock as a restricted stock award`,
      rsu: `${terms.equity_amount} restricted stock units`,
      token: `${terms.equity_amount} tokens under the Company's token grant program`,
    }[terms.equity_type];
    sections.push({
      h: 'Equity',
      p: `Subject to approval by the Company's Board of Directors, you will be granted ${grant}, ${terms.equity_vesting}. The grant will be governed by the applicable plan and grant agreement. Nothing in this letter is a promise of any particular value.`,
    });
  }
  sections.push({
    h: 'Benefits',
    p: `${terms.benefits_text} You will accrue paid sick leave as required by California law.${terms.pto_text ? ` ${terms.pto_text}` : ''}`,
  });
  const conditions = ['verification of your identity and authorization to work in the United States (Form I-9)'];
  if (terms.ciiaa) conditions.push("your signing the Company's Confidential Information and Invention Assignment Agreement");
  if (terms.other_contingency) conditions.push(terms.other_contingency);
  sections.push({ h: 'Conditions', p: `This offer is contingent on ${conditions.join('; ')}.` });
  sections.push({
    h: 'At-will employment',
    p: 'Your employment with the Company is at will. You may resign at any time, and the Company may end your employment at any time, with or without cause or notice. The at-will nature of your employment may only be changed in a written agreement signed by you and the Company.',
  });
  sections.push({
    h: '',
    p: `To accept, please sign below by ${longDate(terms.expires_on)}, after which this offer expires.`,
  });
  return {
    version: 1,
    company: { name: companyName, address: company.address },
    date: longDate(terms.letter_date),
    to: { name: personName(person), address, email: '' },
    salutation: `Dear ${first},`,
    sections,
    closing: { from: terms.signer_name, title: terms.signer_title, company: companyName },
    acceptance: 'I accept this offer of employment on the terms above. I understand my employment is at will and that this letter is the complete agreement about its terms.',
    expires: longDate(terms.expires_on),
  };
}

/** Exact JSON frozen into the offer hash. Key order is part of the hash. */
export function offerCanonical(letter: OfferLetter): string {
  return JSON.stringify(letter);
}
