import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyPayrollPerson,
  journalBalances,
  lineAmount,
  payrollCompute,
  payrollJournalDraft,
  type PayrollPerson,
} from '../../src/lib/pay/payrollCalc';
import { payrollFilings } from '../../src/lib/pay/payrollFilings';
import { offerCanonical, renderOffer } from '../../src/lib/pay/payrollOffer';
import { auditLine, identifierHash, looksLikeRawIdentifier } from '../../src/lib/pay/payrollSecrets';
import { payrollTables } from '../../src/lib/pay/payrollTables';

function salaried(overrides: Partial<PayrollPerson> = {}): PayrollPerson {
  return {
    ...emptyPayrollPerson('w2'),
    id: 'person',
    status: 'active',
    first_name: 'Ada',
    last_name: 'Lovelace',
    pay_type: 'salary',
    pay_rate_cents: 12_000_000,
    frequency: 'semimonthly',
    flsa_exempt: true,
    work_state: 'CA',
    tin_on_file: true,
    ...overrides,
  };
}

test('Social Security stops at the 2026 wage base', () => {
  const over = payrollCompute(
    salaried(),
    { pay_date: '2026-01-31', kind: 'regular' },
    { salary: '200000.00' },
    [],
  );
  assert.equal(over.wages.ss, 18_450_000);
  assert.equal(lineAmount(over, 'ss'), 1_143_900);
  assert.equal(over.wages.med, 20_000_000);

  const capped = payrollCompute(
    salaried(),
    { pay_date: '2026-02-15', kind: 'regular' },
    { salary: '1000.00' },
    [{
      id: 'prior',
      payDate: '2026-01-15',
      calc: {
        ...over,
        wages: { ...over.wages, ss: 18_450_000, med: 18_450_000, futa: 700_000, sui: 700_000 },
      },
    }],
  );
  assert.equal(capped.wages.ss, 0);
  assert.equal(lineAmount(capped, 'ss'), 0);
  assert.equal(lineAmount(capped, 'med'), 1_450);
});

test('California SDI is 1.3 percent with no wage limit', () => {
  const calc = payrollCompute(
    salaried(),
    { pay_date: '2026-03-15', kind: 'regular' },
    { salary: '1000.00' },
    [],
  );
  assert.equal(calc.wages.sdi, 100_000);
  assert.equal(lineAmount(calc, 'sdi'), 1_300);
  assert.equal(calc.lines.find((line) => line.code === 'sdi')?.note, '1.3%, no wage limit');
});

test('traditional 401(k) stops at the 2026 deferral limit and does not reduce Social Security wages', () => {
  const calc = payrollCompute(
    salaried({ k401_type: 'traditional', k401_pct_bp: 10_000 }),
    { pay_date: '2026-04-15', kind: 'regular' },
    { salary: '30000.00' },
    [],
  );
  assert.equal(lineAmount(calc, 'k401'), 2_450_000);
  assert.equal(calc.wages.fit, 550_000);
  assert.equal(calc.wages.fica, 3_000_000);
  assert.equal(calc.wages.ss, 3_000_000);
  assert.ok(calc.warnings.some((warning) => warning.includes('401(k) capped')));
});

test('catch-up above the base limit is Roth when prior-year FICA wages were high', () => {
  const prior = payrollCompute(salaried(), { pay_date: '2026-01-15', kind: 'regular' }, { salary: '1000.00' }, []);
  prior.lines.push({ code: 'k401', cat: 'pretax', label: '401(k)', amount_cents: 2_450_000, liab: 'pay_401k' });
  const calc = payrollCompute(
    salaried({
      birth_year: 1970,
      k401_type: 'traditional',
      k401_flat_cents: 100_000,
      k401_prior_high: true,
    }),
    { pay_date: '2026-02-15', kind: 'regular' },
    { salary: '1000.00' },
    [{ id: 'prior', payDate: '2026-01-15', calc: prior }],
  );
  assert.equal(lineAmount(calc, 'k401'), 0);
  assert.equal(lineAmount(calc, 'k401roth'), 100_000);
});

test('an off-cycle bonus uses federal 22 percent and California bonus 10.23 percent', () => {
  const calc = payrollCompute(
    salaried({ flsa_exempt: true }),
    { pay_date: '2026-05-15', kind: 'offcycle' },
    { earnings: [{ type: 'bonus', amount: '10000.00', label: 'Bonus' }] },
    [],
  );
  assert.equal(lineAmount(calc, 'fit'), 220_000);
  assert.equal(lineAmount(calc, 'state_wh'), 102_300);
  assert.equal(lineAmount(calc, 'sdi'), 13_000);
});

test('Section 125 health reduces Social Security and SDI wages', () => {
  const calc = payrollCompute(
    salaried({ health_pretax_cents: 10_000 }),
    { pay_date: '2026-06-15', kind: 'regular' },
    { salary: '1000.00' },
    [],
  );
  assert.equal(lineAmount(calc, 'health125'), 10_000);
  assert.equal(calc.wages.ss, 90_000);
  assert.equal(lineAmount(calc, 'ss'), 5_580);
  assert.equal(calc.wages.sdi, 90_000);
  assert.equal(lineAmount(calc, 'sdi'), 1_170);
});

test('a regular California paycheck matches Worksheet 1A and DE 44 Method B', () => {
  const calc = payrollCompute(salaried(), { pay_date: '2026-01-15', kind: 'regular' }, {}, []);
  assert.equal(calc.gross_cents, 500_000);
  assert.equal(lineAmount(calc, 'fit'), 73_208);
  assert.equal(lineAmount(calc, 'ss'), 31_000);
  assert.equal(lineAmount(calc, 'med'), 7_250);
  assert.equal(lineAmount(calc, 'state_wh'), 32_395);
  assert.equal(lineAmount(calc, 'sdi'), 6_500);
  const journal = payrollJournalDraft(calc, salaried(), 'wages_payable');
  assert.equal(journalBalances(journal), true);
  assert.ok(journal.some((line) => line.systemKey === 'wages' && line.debitCents === 500_000));
  assert.ok(journal.some((line) => line.systemKey === 'pay_wages' && line.memo === 'Net pay recorded, not sent'));
});

test('California sick leave accrues one hour per thirty hours worked', () => {
  const calc = payrollCompute(
    salaried({
      pay_type: 'hourly',
      pay_rate_cents: 1_690,
      flsa_exempt: false,
      std_hours_e2: 0,
      sick_policy: 'accrue',
      sick_cap_e2: 8_000,
    }),
    { pay_date: '2026-01-16', kind: 'regular' },
    { regular_hours: '30' },
    [],
  );
  assert.equal(calc.leave?.sick.accrued_e2, 100);
  assert.equal(calc.leave?.sick.balance_e2, 100);
});

test('years other than 2026 are refused', () => {
  assert.throws(() => payrollTables(2025), /2026/);
  assert.throws(() => payrollTables(2027), /2026/);
  assert.throws(
    () => payrollCompute(salaried(), { pay_date: '2027-01-15', kind: 'regular' }, {}, []),
    /2026/,
  );
});

test('filing worksheets are box totals and do not include a raw identifier', () => {
  const calc = payrollCompute(salaried(), { pay_date: '2026-01-15', kind: 'regular' }, {}, []);
  const packet = payrollFilings([{
    employeeId: 'person',
    payDate: '2026-01-15',
    status: 'approved',
    kind: 'w2',
    name: 'Ada Lovelace',
    workState: 'CA',
    isOfficer: false,
    tinLast4: '0000',
    netCents: calc.net_cents,
    calc,
  }], '2026-01-01', '2026-03-31');
  assert.equal(packet.f941.employees, 1);
  assert.equal(packet.f941.line5a_ss_wages, 500_000);
  assert.equal(packet.w2[0]?.box1, 500_000);
  assert.equal(packet.w2[0]?.box3, 500_000);
  assert.equal(packet.w2[0]?.ssn_masked, '•••-••-0000');
  assert.equal(packet.de9.sdi, 6_500);
  assert.equal(looksLikeRawIdentifier(JSON.stringify(packet)), false);
  assert.match(packet.note, /not an e-file/);
});

test('audit text stores a hash and refuses a raw identifier', async () => {
  const hash = await identifierHash('sample-account-value');
  assert.equal(hash.length, 64);
  assert.equal(hash.includes('sample-account-value'), false);
  const line = auditLine('identifier_updated', hash);
  assert.equal(line.includes('sample-account-value'), false);
  assert.throws(() => auditLine('note 000-00-0000', hash), /audit_has_raw_identifier/);
});

test('an offer letter freezes to a stable hash payload', () => {
  const person = salaried();
  const letter = renderOffer({
    letter_date: '2026-01-05',
    title: 'Engineer',
    department: '',
    manager_name: '',
    manager_title: '',
    start_date: '2026-02-02',
    work_location: 'Remote (California)',
    employment_type: 'full_time',
    pay_type: 'salary',
    rate_cents: 16_000_000,
    frequency: 'semimonthly',
    exempt: true,
    bonus_text: '',
    equity_type: '',
    equity_amount: '',
    equity_vesting: '',
    benefits_text: 'You will be eligible for the benefit plans the Company offers.',
    pto_text: '',
    background_check: false,
    ciiaa: true,
    other_contingency: '',
    custom_text: '',
    expires_on: '2026-01-12',
    signer_name: 'Grace Hopper',
    signer_title: 'Chief Executive Officer',
  }, person, { legal_name: 'Example Treasury', address: '1 Market' });
  const canonical = offerCanonical(letter);
  assert.equal(offerCanonical(letter), canonical);
  assert.equal(canonical.includes('Engineer'), true);
  assert.equal(looksLikeRawIdentifier(canonical), false);
});
