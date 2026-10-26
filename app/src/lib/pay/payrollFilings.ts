/**
 * On-screen 941, 940, DE 9 / DE 9C, and W-2 box totals.
 * These are worksheets. The app does not e-file.
 */

import { muldivRound } from './invoiceMath';
import type { PayrollCalc, WorkerKind } from './payrollCalc';

export interface FilingStub {
  employeeId: string;
  payDate: string;
  status: 'draft' | 'approved' | 'void';
  kind: WorkerKind;
  name: string;
  workState: string;
  isOfficer: boolean;
  tinLast4: string;
  netCents: number;
  calc: PayrollCalc;
}

export interface FilingPacket {
  from: string;
  to: string;
  f941: {
    employees: number;
    line2_wages: number;
    line3_fit: number;
    line5a_ss_wages: number;
    line5a_ss_tax: number;
    line5c_med_wages: number;
    line5c_med_tax: number;
    line5d_addl_wages: number;
    line5d_addl_tax: number;
    line7_fractions: number;
    line12_total: number;
    monthly_liability: Record<number, number>;
  };
  f940: {
    total_payments: number;
    exempt_payments: number;
    over_base: number;
    taxable: number;
    tax: number;
  };
  de9: {
    ui_subject: number;
    ui_taxable: number;
    sdi_taxable: number;
    pit_wages: number;
    ui: number;
    ett: number;
    sdi: number;
    pit: number;
  };
  de9c: { name: string; ssn_masked: string; ui_subject: number; pit_wages: number; pit: number }[];
  w2: {
    employeeId: string;
    name: string;
    ssn_masked: string;
    isOfficer: boolean;
    box1: number;
    box2: number;
    box3: number;
    box4: number;
    box5: number;
    box6: number;
    box12: { D?: number; AA?: number; DD?: number };
    box13_retirement: boolean;
    box14_casdi: number;
    box15: string;
    box16: number;
    box17: number;
  }[];
  note: string;
}

function inRange(stub: FilingStub, from: string, to: string): boolean {
  return stub.status === 'approved' && stub.payDate >= from && stub.payDate <= to;
}

export function payrollFilings(stubs: FilingStub[], from: string, to: string): FilingPacket {
  const people = new Map<string, {
    id: string;
    name: string;
    kind: WorkerKind;
    workState: string;
    isOfficer: boolean;
    tinLast4: string;
    w: Record<string, number>;
    l: Record<string, number>;
    months: Record<number, number>;
  }>();

  for (const stub of stubs) {
    if (!inRange(stub, from, to)) continue;
    let row = people.get(stub.employeeId);
    if (!row) {
      row = {
        id: stub.employeeId,
        name: stub.name,
        kind: stub.kind,
        workState: stub.workState,
        isOfficer: stub.isOfficer,
        tinLast4: stub.tinLast4,
        w: {},
        l: {},
        months: {},
      };
      people.set(stub.employeeId, row);
    }
    for (const [key, value] of Object.entries(stub.calc.wages ?? {})) row.w[key] = (row.w[key] ?? 0) + value;
    for (const line of stub.calc.lines ?? []) row.l[line.code] = (row.l[line.code] ?? 0) + line.amount_cents;
    if (stub.kind === 'w2') {
      const month = Number(stub.payDate.slice(5, 7));
      let federal = 0;
      for (const line of stub.calc.lines ?? []) {
        if (['fit', 'ss', 'med', 'addl_med', 'er_ss', 'er_med'].includes(line.code)) federal += line.amount_cents;
      }
      row.months[month] = (row.months[month] ?? 0) + federal;
    }
  }

  const rows = [...people.values()];
  const sum = (part: 'w' | 'l', key: string, kind: WorkerKind | null = 'w2') => rows.reduce((total, row) => {
    if (kind != null && row.kind !== kind) return total;
    return total + (row[part][key] ?? 0);
  }, 0);

  const w2 = rows.filter((row) => row.kind === 'w2');
  const ssW = sum('w', 'ss');
  const medW = sum('w', 'med');
  const addlW = sum('w', 'addl_med');
  const fit = sum('l', 'fit');
  const ssTaxCalc = muldivRound(ssW, 1240, 10000);
  const medTaxCalc = muldivRound(medW, 290, 10000);
  const addlCalc = muldivRound(addlW, 90, 10000);
  const ssActual = sum('l', 'ss') + sum('l', 'er_ss');
  const medActual = sum('l', 'med') + sum('l', 'er_med');
  const addlActual = sum('l', 'addl_med');
  const months: Record<number, number> = {};
  for (const row of w2) {
    for (const [month, value] of Object.entries(row.months)) months[Number(month)] = (months[Number(month)] ?? 0) + value;
  }
  const futaSubject = sum('w', 'futa_subject');
  const ca = w2.filter((row) => row.workState === 'CA');
  const caSum = (part: 'w' | 'l', key: string) => ca.reduce((total, row) => total + (row[part][key] ?? 0), 0);

  return {
    from,
    to,
    f941: {
      employees: w2.length,
      line2_wages: sum('w', 'fit'),
      line3_fit: fit,
      line5a_ss_wages: ssW,
      line5a_ss_tax: ssTaxCalc,
      line5c_med_wages: medW,
      line5c_med_tax: medTaxCalc,
      line5d_addl_wages: addlW,
      line5d_addl_tax: addlCalc,
      line7_fractions: ssActual + medActual + addlActual - (ssTaxCalc + medTaxCalc + addlCalc),
      line12_total: fit + ssActual + medActual + addlActual,
      monthly_liability: months,
    },
    f940: {
      total_payments: sum('w', 'gross'),
      exempt_payments: sum('w', 'gross') - futaSubject,
      over_base: futaSubject - sum('w', 'futa'),
      taxable: sum('w', 'futa'),
      tax: sum('l', 'futa'),
    },
    de9: {
      ui_subject: caSum('w', 'sui_subject'),
      ui_taxable: caSum('w', 'sui'),
      sdi_taxable: caSum('w', 'sdi'),
      pit_wages: caSum('w', 'state_wh'),
      ui: caSum('l', 'sui'),
      ett: caSum('l', 'ett'),
      sdi: caSum('l', 'sdi'),
      pit: caSum('l', 'state_wh'),
    },
    de9c: ca.map((row) => ({
      name: row.name,
      ssn_masked: row.tinLast4 ? `•••-••-${row.tinLast4}` : '',
      ui_subject: row.w.sui_subject ?? 0,
      pit_wages: row.w.state_wh ?? 0,
      pit: row.l.state_wh ?? 0,
    })),
    w2: w2.map((row) => {
      const box12 = {
        D: row.l.k401 || undefined,
        AA: row.l.k401roth || undefined,
        DD: (row.l.health125 || 0) + (row.l.health_er || 0) || undefined,
      };
      return {
        employeeId: row.id,
        name: row.name,
        ssn_masked: row.tinLast4 ? `•••-••-${row.tinLast4}` : '',
        isOfficer: row.isOfficer,
        box1: row.w.fit ?? 0,
        box2: row.l.fit ?? 0,
        box3: row.w.ss ?? 0,
        box4: row.l.ss ?? 0,
        box5: row.w.med ?? 0,
        box6: (row.l.med ?? 0) + (row.l.addl_med ?? 0),
        box12,
        box13_retirement: ((row.l.k401 ?? 0) + (row.l.k401roth ?? 0) + (row.l.k401_match ?? 0)) > 0,
        box14_casdi: row.l.sdi ?? 0,
        box15: row.workState,
        box16: row.w.state_wh ?? 0,
        box17: row.l.state_wh ?? 0,
      };
    }),
    note: 'These are on-screen totals for Form 941, Form 940, DE 9 / DE 9C, and W-2 boxes. They are not an e-file. Review them before filing.',
  };
}
