export type PayNavItem = {
  icon: string;
  label: string;
  path: string;
  onboardingId: string;
};

/**
 * Books modules. Home, customers, invoices, treasury activity, vendors, bills,
 * deposits, the cash ledger, the bank feed, reports, and the journal are live.
 */
/** Everyday books. The rest stays one click away. */
export const PAY_NAV_PRIMARY: readonly PayNavItem[] = [
  { icon: 'house', label: 'Home', path: '/pay', onboardingId: 'pay-home' },
  { icon: 'file-lines', label: 'Invoices', path: '/pay/invoices', onboardingId: 'pay-invoices' },
  { icon: 'users', label: 'Customers', path: '/pay/customers', onboardingId: 'pay-customers' },
  { icon: 'receipt', label: 'Bills', path: '/pay/bills', onboardingId: 'pay-bills' },
];

export const PAY_NAV_ADVANCED: readonly PayNavItem[] = [
  { icon: 'store', label: 'Vendors', path: '/pay/vendors', onboardingId: 'pay-vendors' },
  { icon: 'right-left', label: 'Deposits & expenses', path: '/pay/transactions', onboardingId: 'pay-transactions' },
  { icon: 'building-columns', label: 'Bank feed', path: '/pay/bank', onboardingId: 'pay-bank' },
  { icon: 'money-check', label: 'Payroll', path: '/pay/payroll', onboardingId: 'pay-payroll' },
  { icon: 'book', label: 'Cash ledger', path: '/pay/ledger', onboardingId: 'pay-ledger' },
  { icon: 'coins', label: 'Treasury activity', path: '/pay/activity', onboardingId: 'pay-activity' },
  { icon: 'book-open', label: 'Journal', path: '/pay/journal', onboardingId: 'pay-journal' },
  { icon: 'chart-line', label: 'Reports', path: '/pay/reports', onboardingId: 'pay-reports' },
];

export const PAY_NAV: readonly PayNavItem[] = [...PAY_NAV_PRIMARY, ...PAY_NAV_ADVANCED];

export function payNavLabel(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PAY_NAV.find((item) => item.path === path)?.label ?? 'Nave Pay';
}
