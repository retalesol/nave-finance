import {
  balanceSheet,
  chartBalances,
  generalLedger,
  journalInRange,
  profitAndLoss,
  trialBalance,
  type GlAccount,
  type GlJournalEntry,
  type PnlGroup,
} from './gl';

/**
 * CPA exports for one treasury. Columns follow nave-books/lib/exports.php.
 * QuickBooks names and dates use that file's shape. Vendor tax ids are left
 * blank; the books do not put them in an export.
 */

export interface ExportParty {
  name: string;
  is1099?: boolean;
}

const PNL_LABELS: Record<PnlGroup, string> = {
  revenue: 'Revenue',
  cogs: 'Cost of revenue',
  expense: 'Operating expenses',
  other_income: 'Other income',
  other_expense: 'Other expense',
};

export function centsStr(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${negative ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (text !== '' && !/^-?\d+(\.\d+)?$/.test(text) && '=+-@\t\r'.includes(text[0])) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvString(header: Array<string | number>, rows: Array<Array<string | number>>): string {
  return [header, ...rows].map((row) => row.map((cell) => csvCell(cell)).join(',')).join('\n') + '\n';
}

export function downloadText(filename: string, mime: string, body: string): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function trialBalanceCsv(accounts: GlAccount[], entries: GlJournalEntry[], asOf: string): string {
  const report = trialBalance(accounts, entries, asOf);
  const rows = report.rows.map((row) => [row.code, row.name, row.accountType, centsStr(row.debitCents), centsStr(row.creditCents)]);
  rows.push(['', 'TOTAL', '', centsStr(report.totalDebit), centsStr(report.totalCredit)]);
  return csvString(['Account #', 'Account', 'Type', 'Debit', 'Credit'], rows);
}

export function balanceSheetCsv(accounts: GlAccount[], entries: GlJournalEntry[], asOf: string): string {
  const report = balanceSheet(accounts, entries, asOf);
  const rows: Array<Array<string | number>> = [];
  const labels = { asset: 'ASSETS', liability: 'LIABILITIES', equity: 'EQUITY' } as const;
  for (const key of ['asset', 'liability', 'equity'] as const) {
    rows.push([labels[key], '', '']);
    for (const row of report.sections[key]) rows.push([row.code, row.name, centsStr(row.balanceCents)]);
    rows.push(['', `Total ${labels[key].toLowerCase()}`, centsStr(report.totals[key])]);
  }
  rows.push(['', 'Total liabilities and equity', centsStr(report.liabilitiesAndEquity)]);
  return csvString([`Balance sheet as of ${asOf}`, '', ''], rows);
}

export function profitAndLossCsv(accounts: GlAccount[], entries: GlJournalEntry[], from: string, to: string): string {
  const report = profitAndLoss(accounts, entries, from, to);
  const rows: Array<Array<string | number>> = [];
  for (const group of Object.keys(PNL_LABELS) as PnlGroup[]) {
    if (report.groups[group].length === 0) continue;
    rows.push([PNL_LABELS[group], '', '']);
    for (const row of report.groups[group]) rows.push([row.code, row.name, centsStr(row.amountCents)]);
    const total = report.groups[group].reduce((sum, row) => sum + row.amountCents, 0);
    rows.push(['', `Total ${PNL_LABELS[group].toLowerCase()}`, centsStr(total)]);
  }
  rows.push(['', 'Gross profit', centsStr(report.grossProfit)]);
  rows.push(['', 'Operating income', centsStr(report.operatingIncome)]);
  rows.push(['', 'NET INCOME', centsStr(report.netIncome)]);
  return csvString([`Profit & loss (accrual) ${from} to ${to}`, '', ''], rows);
}

export function generalLedgerCsv(accounts: GlAccount[], entries: GlJournalEntry[], from: string, to: string): string {
  const rows: Array<Array<string | number>> = [];
  for (const account of generalLedger(accounts, entries, from, to)) {
    rows.push([`${account.code} ${account.name}`, '', '', '', '', '', '', centsStr(account.openingCents)]);
    for (const row of account.rows) {
      const source = `${row.sourceType}${row.sourceId ? ` #${row.sourceId}` : ` JE${row.entryId}`}`;
      const memo = `${row.memo}${row.lineMemo ? ` · ${row.lineMemo}` : ''}`.trim();
      rows.push(['', row.date, source, row.ref, row.party, memo, centsStr(row.debitCents - row.creditCents), centsStr(row.balanceCents)]);
    }
    rows.push([`Total ${account.code}`, '', '', '', '', '', '', centsStr(account.closingCents)]);
  }
  return csvString(['Account', 'Date', 'Source', 'Ref', 'Name', 'Memo', 'Amount (Dr+/Cr-)', 'Balance'], rows);
}

export function journalCsv(entries: GlJournalEntry[], from: string, to: string): string {
  const rows: Array<Array<string | number>> = [];
  for (const entry of journalInRange(entries, from, to)) {
    for (const line of entry.lines) {
      rows.push([
        `JE${entry.id}`,
        entry.date,
        entry.sourceType,
        entry.ref,
        entry.party,
        entry.memo,
        line.code ?? '',
        line.name ?? '',
        line.debitCents ? centsStr(line.debitCents) : '',
        line.creditCents ? centsStr(line.creditCents) : '',
        line.memo,
      ]);
    }
  }
  return csvString(['Entry', 'Date', 'Source', 'Ref', 'Name', 'Memo', 'Account #', 'Account', 'Debit', 'Credit', 'Line memo'], rows);
}

export function chartCsv(accounts: GlAccount[], entries: GlJournalEntry[]): string {
  const rows = chartBalances(accounts, entries).map((account) => [
    account.code,
    account.name,
    account.accountType,
    account.subtype,
    account.taxLine,
    centsStr(account.balanceCents),
    account.archived ? 'yes' : '',
  ]);
  return csvString(['Account #', 'Account', 'Type', 'Detail type', 'Tax line (1120 hint)', 'Balance', 'Archived'], rows);
}

function qbType(account: GlAccount): [string, string, string] {
  switch (account.subtype) {
    case 'bank':
    case 'cash':
      return ['BANK', 'Bank', 'Checking'];
    case 'ar':
      return ['AR', 'Accounts receivable (A/R)', 'Accounts Receivable (A/R)'];
    case 'digital_asset':
    case 'other_current_asset':
      return ['OCASSET', 'Other Current Assets', 'Other Current Assets'];
    case 'fixed_asset':
      return ['FIXASSET', 'Fixed Assets', 'Machinery & Equipment'];
    case 'other_asset':
      return ['OASSET', 'Other Assets', 'Other Long-term Assets'];
    case 'ap':
      return ['AP', 'Accounts payable (A/P)', 'Accounts Payable (A/P)'];
    case 'credit_card':
      return ['CCARD', 'Credit Card', 'Credit Card'];
    case 'current_liability':
      return ['OCLIAB', 'Other Current Liabilities', 'Other Current Liabilities'];
    case 'long_term_liability':
      return ['LTLIAB', 'Long Term Liabilities', 'Other Long Term Liabilities'];
    case 'equity':
      return ['EQUITY', 'Equity', "Owner's Equity"];
    case 'retained_earnings':
      return ['EQUITY', 'Equity', 'Retained Earnings'];
    case 'revenue':
      return ['INC', 'Income', 'Service/Fee Income'];
    case 'other_income':
      return ['EXINC', 'Other Income', 'Other Miscellaneous Income'];
    case 'cogs':
      return ['COGS', 'Cost of Goods Sold', 'Other Costs of Services - COS'];
    case 'other_expense':
      return ['EXEXP', 'Other Expense', 'Other Miscellaneous Expense'];
    default:
      return ['EXP', 'Expenses', 'Other Miscellaneous Service Cost'];
  }
}

function qbName(name: string): string {
  return name.replaceAll(':', '-').replaceAll('\t', ' ').replaceAll('\n', ' ').slice(0, 31);
}

function iifClean(value: string): string {
  return value.replaceAll('\t', ' ').replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('"', "'");
}

function qbDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${month}/${day}/${year}`;
}

function needsParty(account: GlAccount | undefined): boolean {
  return account?.systemKey === 'ar' || account?.systemKey === 'ap' || account?.code === '1100' || account?.code === '2000';
}

export function quickBooksIif(
  accounts: GlAccount[],
  entries: GlJournalEntry[],
  from: string,
  to: string,
  customers: string[],
  vendors: ExportParty[],
): string {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const names = new Map(accounts.map((account) => [account.id, qbName(account.name)]));
  const lines: string[] = ['!ACCNT\tNAME\tACCNTTYPE\tDESC\tACCNUM'];
  for (const account of [...accounts].sort((a, b) => a.code.localeCompare(b.code))) {
    lines.push(`ACCNT\t${iifClean(names.get(account.id) ?? '')}\t${qbType(account)[0]}\t${iifClean(account.description)}\t${iifClean(account.code)}`);
  }
  lines.push('!CUST\tNAME');
  for (const name of [...customers].sort((a, b) => a.localeCompare(b))) lines.push(`CUST\t${iifClean(name.slice(0, 41))}`);
  lines.push('!VEND\tNAME\tTAXID\t1099');
  for (const vendor of [...vendors].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`VEND\t${iifClean(vendor.name.slice(0, 41))}\t\t${vendor.is1099 ? 'Y' : 'N'}`);
  }
  lines.push('!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
  lines.push('!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
  lines.push('!ENDTRNS');
  for (const entry of journalInRange(entries, from, to)) {
    const date = qbDate(entry.date);
    const doc = `NB${entry.id.replaceAll('-', '').slice(0, 8)}`;
    entry.lines.forEach((line, index) => {
      const account = byId.get(line.accountId);
      const amount = centsStr(line.debitCents - line.creditCents);
      const party = needsParty(account) ? iifClean(entry.party.slice(0, 41)) : '';
      const memo = iifClean(`${entry.memo} ${line.memo}`.trim().slice(0, 200));
      const prefix = index === 0 ? 'TRNS' : 'SPL';
      lines.push(`${prefix}\t\tGENERAL JOURNAL\t${date}\t${iifClean(names.get(line.accountId) ?? '')}\t${party}\t${amount}\t${doc}\t${memo}`);
    });
    lines.push('ENDTRNS');
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function quickBooksJournalCsv(accounts: GlAccount[], entries: GlJournalEntry[], from: string, to: string): string {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const rows: Array<Array<string | number>> = [];
  for (const entry of journalInRange(entries, from, to)) {
    for (const line of entry.lines) {
      const account = byId.get(line.accountId);
      const label = `${line.code ?? account?.code ?? ''} ${line.name ?? account?.name ?? ''}`.trim();
      const memo = `${entry.memo}${line.memo ? ` · ${line.memo}` : ''}`.trim().slice(0, 4000);
      rows.push([
        `NB${entry.id.replaceAll('-', '').slice(0, 8)}`,
        qbDate(entry.date),
        label,
        line.debitCents ? centsStr(line.debitCents) : '',
        line.creditCents ? centsStr(line.creditCents) : '',
        memo,
        needsParty(account) ? entry.party : '',
      ]);
    }
  }
  return csvString(['Journal No', 'Journal Date', 'Account', 'Debits', 'Credits', 'Description', 'Name'], rows);
}

export function quickBooksAccountsCsv(accounts: GlAccount[]): string {
  const rows = [...accounts]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((account) => {
      const [, type, detail] = qbType(account);
      return [account.code, account.name, type, detail, account.description];
    });
  return csvString(['Account Number', 'Account Name', 'Account Type', 'Detail Type', 'Description'], rows);
}
