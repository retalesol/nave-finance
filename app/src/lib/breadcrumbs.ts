export type Crumb = {
  label: string;
  /** Omit on the current page. */
  to?: string;
};

const NAVE_SECTIONS: Record<string, string> = {
  '/overview': 'Overview',
  '/money': 'Money',
  '/agents': 'Agents',
  '/decisions': 'Decisions',
  '/rules': 'Rules',
  '/bridge': 'Bridge',
  '/stake': 'Stake',
  '/settings': 'Settings',
  '/tokens': 'Tokens',
};

const NAVE_ALIASES: Record<string, string> = {
  '/dashboard': '/overview',
  '/assets': '/money',
  '/agent': '/agents',
  '/automation': '/agents',
  '/policy': '/rules',
  '/team': '/settings',
  '/governance': '/decisions',
  '/votes': '/decisions',
};

const PAY_SECTIONS: Array<{
  prefix: string;
  label: string;
  create: string;
  detail: string;
}> = [
  { prefix: '/pay/invoices', label: 'Invoices', create: 'New invoice', detail: 'Invoice' },
  { prefix: '/pay/customers', label: 'Customers', create: 'New customer', detail: 'Customer' },
  { prefix: '/pay/bills', label: 'Bills', create: 'New bill', detail: 'Bill' },
  { prefix: '/pay/vendors', label: 'Vendors', create: 'New vendor', detail: 'Vendor' },
  { prefix: '/pay/transactions', label: 'Deposits & expenses', create: 'New record', detail: 'Record' },
  { prefix: '/pay/ledger', label: 'Cash ledger', create: 'New entry', detail: 'Entry' },
  { prefix: '/pay/activity', label: 'Treasury activity', create: 'New activity', detail: 'Activity' },
  { prefix: '/pay/bank', label: 'Bank feed', create: 'New account', detail: 'Account' },
  { prefix: '/pay/reports', label: 'Reports', create: 'New report', detail: 'Report' },
  { prefix: '/pay/journal', label: 'Journal', create: 'New entry', detail: 'Entry' },
];

function cleanPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function naveCrumbs(pathname: string): Crumb[] {
  const path = cleanPath(pathname);
  const aliased = NAVE_ALIASES[path] ?? path;
  const decision = aliased.match(/^\/(?:decisions|governance|votes)\/([^/]+)$/);
  const sectionPath = decision ? '/decisions' : aliased;
  const section = NAVE_SECTIONS[sectionPath] ?? 'Overview';
  const crumbs: Crumb[] = [
    { label: 'Home', to: '/' },
    { label: 'Nave', to: '/overview' },
  ];
  if (decision) {
    crumbs.push({ label: 'Decisions', to: '/decisions' }, { label: 'Decision' });
    return crumbs;
  }
  crumbs.push({ label: section });
  return crumbs;
}

function payCrumbs(pathname: string, search: string): Crumb[] {
  const path = cleanPath(pathname);
  const crumbs: Crumb[] = [
    { label: 'Home', to: '/' },
    { label: 'Nave Pay', to: '/pay' },
  ];
  if (path === '/pay') {
    crumbs[1] = { label: 'Nave Pay' };
    return crumbs;
  }

  if (path.startsWith('/pay/payroll')) {
    crumbs.push(path === '/pay/payroll' ? { label: 'Payroll' } : { label: 'Payroll', to: '/pay/payroll' });
    if (path === '/pay/payroll/runs/new') crumbs.push({ label: 'New pay run' });
    else if (path === '/pay/payroll/people/new') crumbs.push({ label: 'People', to: '/pay/payroll/people' }, { label: 'New person' });
    else if (path.startsWith('/pay/payroll/people/')) crumbs.push({ label: 'People', to: '/pay/payroll/people' }, { label: 'Person' });
    else if (path === '/pay/payroll/people') crumbs.push({ label: 'People' });
    else if (path.startsWith('/pay/payroll/hiring')) crumbs.push({ label: 'Hiring' });
    else if (path.startsWith('/pay/payroll/filings')) crumbs.push({ label: 'Filings' });
    else if (path !== '/pay/payroll') crumbs.push({ label: 'Details' });
    return crumbs;
  }

  const section = PAY_SECTIONS.find((item) => path === item.prefix || path.startsWith(`${item.prefix}/`));
  if (!section) {
    crumbs[1] = { label: 'Nave Pay' };
    return crumbs;
  }

  if (path === section.prefix) {
    crumbs.push({ label: section.label });
    return crumbs;
  }

  crumbs.push({ label: section.label, to: section.prefix });
  if (path === `${section.prefix}/new`) {
    if (section.prefix === '/pay/transactions') {
      const direction = new URLSearchParams(search).get('direction');
      crumbs.push({ label: direction === 'out' ? 'New expense' : 'New deposit' });
    } else {
      crumbs.push({ label: section.create });
    }
    return crumbs;
  }
  if (path.endsWith('/edit')) {
    crumbs.push({ label: `Edit ${section.detail.toLowerCase()}` });
    return crumbs;
  }
  crumbs.push({ label: section.detail });
  return crumbs;
}

/** Product, then section, then the page. The last crumb is the current page. */
export function appBreadcrumbs(pathname: string, search = ''): Crumb[] {
  const path = cleanPath(pathname);
  if (path === '/pay' || path.startsWith('/pay/')) return payCrumbs(path, search);
  return naveCrumbs(path);
}
