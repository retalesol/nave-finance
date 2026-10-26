/**
 * 2026 payroll tax figures, copied from nave-books/lib/payroll_tables.php.
 *
 * Money is integer cents. Federal bracket rates are whole percent. California
 * bracket rates are thousandths of a percent (1100 = 1.100%). Flat rates are
 * basis points (2200 = 22.00%). A pay date outside 2026 is refused. There is
 * no estimated table for any other year.
 */

export const PAYROLL_YEAR = 2026;

export const PAY_PERIODS = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
} as const;

export type PayFrequency = keyof typeof PAY_PERIODS;

/** States with no wage income tax to withhold. PFML and local taxes are not computed. */
export const PAY_NO_INCOME_TAX_STATES = ['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY'] as const;

export class PayrollTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollTableError';
  }
}

type Bracket = readonly [atLeastCents: number, tentativeCents: number, rate: number];

export interface PayrollYearTables {
  year: number;
  fed: {
    standard: Record<'mfj' | 'single' | 'hoh', readonly Bracket[]>;
    checkbox: Record<'mfj' | 'single' | 'hoh', readonly Bracket[]>;
    line1g: { mfj: number; other: number };
    allowance: number;
    supplemental_bp: number;
    supplemental_over_1m_bp: number;
    backup_bp: number;
  };
  fica: {
    ss_base: number;
    ss_bp: number;
    med_bp: number;
    addl_med_threshold: number;
    addl_med_bp: number;
  };
  futa: { base: number; net_bp: number; credit_reduction_bp: { CA: number } };
  k401: {
    deferral: number;
    catchup50: number;
    catchup6063: number;
    annual_additions: number;
    comp_limit: number;
    roth_catchup_threshold: number;
  };
  CA: {
    sdi_bp: number;
    ui_base: number;
    ett_bp: number;
    ui_new_bp: number;
    min_wage_cents: number;
    exempt_salary_cents: number;
    supp_bp: number;
    bonus_bp: number;
    low_income: Record<PayFrequency, readonly [number, number]>;
    est_deduction_annual: number;
    std_deduction_annual: readonly [number, number];
    exemption_annual: number;
    rates: Record<'single' | 'married' | 'hoh', readonly Bracket[]>;
  };
}

const TABLES_2026: PayrollYearTables = {
  year: 2026,
  fed: {
    standard: {
      mfj: [[0, 0, 0], [1930000, 0, 10], [4410000, 248000, 12], [12010000, 1160000, 22], [23070000, 3593200, 24], [42285000, 8204800, 32], [53175000, 11689600, 35], [78800000, 20658350, 37]],
      single: [[0, 0, 0], [750000, 0, 10], [1990000, 124000, 12], [5790000, 580000, 22], [11320000, 1796600, 24], [20927500, 4102400, 32], [26372500, 5844800, 35], [64810000, 19297925, 37]],
      hoh: [[0, 0, 0], [1555000, 0, 10], [3325000, 177000, 12], [8300000, 774000, 22], [12125000, 1615500, 24], [21730000, 3920700, 32], [27175000, 5663100, 35], [65615000, 19117100, 37]],
    },
    checkbox: {
      mfj: [[0, 0, 0], [1610000, 0, 10], [2850000, 124000, 12], [6650000, 580000, 22], [12180000, 1796600, 24], [21787500, 4102400, 32], [27232500, 5844800, 35], [40045000, 10329175, 37]],
      single: [[0, 0, 0], [805000, 0, 10], [1425000, 62000, 12], [3325000, 290000, 22], [6090000, 898300, 24], [10893800, 2051200, 32], [13616300, 2922400, 35], [32835000, 9648963, 37]],
      hoh: [[0, 0, 0], [1207500, 0, 10], [2092500, 88500, 12], [4580000, 387000, 22], [6492500, 807750, 24], [11295000, 1960350, 32], [14017500, 2831550, 35], [33237500, 9558550, 37]],
    },
    line1g: { mfj: 1290000, other: 860000 },
    allowance: 430000,
    supplemental_bp: 2200,
    supplemental_over_1m_bp: 3700,
    backup_bp: 2400,
  },
  fica: { ss_base: 18450000, ss_bp: 620, med_bp: 145, addl_med_threshold: 20000000, addl_med_bp: 90 },
  futa: { base: 700000, net_bp: 60, credit_reduction_bp: { CA: 150 } },
  k401: {
    deferral: 2450000,
    catchup50: 800000,
    catchup6063: 1125000,
    annual_additions: 7200000,
    comp_limit: 36000000,
    roth_catchup_threshold: 15000000,
  },
  CA: {
    sdi_bp: 130,
    ui_base: 700000,
    ett_bp: 10,
    ui_new_bp: 340,
    min_wage_cents: 1690,
    exempt_salary_cents: 7030400,
    supp_bp: 660,
    bonus_bp: 1023,
    low_income: {
      weekly: [36300, 72700],
      biweekly: [72700, 145400],
      semimonthly: [78700, 157500],
      monthly: [157500, 314900],
    },
    est_deduction_annual: 100000,
    std_deduction_annual: [570600, 1141200],
    exemption_annual: 16830,
    rates: {
      single: [[0, 0, 1100], [1107900, 12187, 2200], [2626400, 45594, 4400], [4145200, 112421, 6600], [5754200, 218615, 8800], [7272400, 352217, 10230], [37147900, 3408481, 11330], [44577100, 4250209, 12430], [74295300, 7944181, 13530], [100000000, 11422027, 14630]],
      married: [[0, 0, 1100], [2215800, 24374, 2200], [5252800, 91188, 4400], [8290400, 224842, 6600], [11508400, 437230, 8800], [14544800, 704433, 10230], [74295800, 6816960, 11330], [89154200, 8500417, 12430], [100000000, 9848550, 13530], [148590600, 16422858, 14630]],
      hoh: [[0, 0, 1100], [2217300, 24390, 2200], [5253000, 91175, 4400], [6771600, 157993, 6600], [8380500, 264180, 8800], [9899000, 397808, 10230], [50520800, 4553418, 11330], [60625100, 5698235, 12430], [100000000, 10592535, 13530], [101041700, 10733477, 14630]],
    },
  },
};

export function payrollTableYears(): number[] {
  return [PAYROLL_YEAR];
}

export function payrollTables(year: number): PayrollYearTables {
  if (year !== PAYROLL_YEAR) {
    throw new PayrollTableError(
      `No payroll tax tables for ${year}. Payroll dated in ${year} is refused. Withholding is published for ${PAYROLL_YEAR} only.`,
    );
  }
  return TABLES_2026;
}
