import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { formatCents, localToday } from '../../lib/pay/invoiceMath';
import {
  balanceSheet,
  chartBalances,
  profitAndLoss,
  trialBalance,
  type PnlGroup,
} from '../../lib/pay/gl';
import {
  fetchAuditRows,
  fetchBooksLock,
  fetchExportParties,
  fetchGlAccounts,
  fetchGlEntries,
  glMessage,
  saveBooksLock,
  updateGlAccount,
  verifyAuditChain,
} from '../../lib/pay/glApi';
import {
  balanceSheetCsv,
  chartCsv,
  csvString,
  downloadText,
  generalLedgerCsv,
  journalCsv,
  profitAndLossCsv,
  quickBooksAccountsCsv,
  quickBooksIif,
  quickBooksJournalCsv,
  trialBalanceCsv,
} from '../../lib/pay/glExports';
import { payBody, payCard, payInput, payPrimary, paySecondary, payTitle } from './payStyles';

type Tab = 'tb' | 'bs' | 'pnl' | 'accounts';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'tb', label: 'Trial balance' },
  { id: 'bs', label: 'Balance sheet' },
  { id: 'pnl', label: 'Profit & loss' },
  { id: 'accounts', label: 'Chart of accounts' },
];

const PNL_LABELS: Record<PnlGroup, string> = {
  revenue: 'Revenue',
  cogs: 'Cost of revenue',
  expense: 'Operating expenses',
  other_income: 'Other income',
  other_expense: 'Other expense',
};

export default function ReportsPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const membership = useDaoMembership();
  const wallet = membership.walletStr;
  const today = localToday();
  const [tab, setTab] = useState<Tab>('tb');
  const [asOf, setAsOf] = useState(today);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [lockDate, setLockDate] = useState('');
  const [lockNote, setLockNote] = useState('');
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [savingLock, setSavingLock] = useState(false);
  const [auditNote, setAuditNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ['payGlAccounts', treasuryGroupId],
    queryFn: () => fetchGlAccounts(treasuryGroupId, wallet),
  });
  const entries = useQuery({
    queryKey: ['payGlEntries', treasuryGroupId],
    queryFn: () => fetchGlEntries(treasuryGroupId, wallet),
  });
  const lock = useQuery({
    queryKey: ['payBooksLock', treasuryGroupId],
    queryFn: () => fetchBooksLock(treasuryGroupId, wallet),
  });
  const audit = useQuery({
    queryKey: ['payAudit', treasuryGroupId],
    queryFn: () => fetchAuditRows(treasuryGroupId, wallet),
  });

  const loading = accounts.isLoading || entries.isLoading;
  const error = accounts.error || entries.error;
  const accountRows = accounts.data ?? [];
  const entryRows = entries.data ?? [];
  const lockedThrough = lock.data?.lockedThrough ?? null;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['payGlAccounts', treasuryGroupId] });
    await queryClient.invalidateQueries({ queryKey: ['payGlEntries', treasuryGroupId] });
    await queryClient.invalidateQueries({ queryKey: ['payBooksLock', treasuryGroupId] });
    await queryClient.invalidateQueries({ queryKey: ['payAudit', treasuryGroupId] });
  }

  async function exportFile(kind: string) {
    setExportError(null);
    try {
      if (kind === 'tb') downloadText(`trial-balance-${asOf}.csv`, 'text/csv;charset=utf-8', trialBalanceCsv(accountRows, entryRows, asOf));
      else if (kind === 'bs') downloadText(`balance-sheet-${asOf}.csv`, 'text/csv;charset=utf-8', balanceSheetCsv(accountRows, entryRows, asOf));
      else if (kind === 'pnl') downloadText(`profit-and-loss-${from}-to-${to}.csv`, 'text/csv;charset=utf-8', profitAndLossCsv(accountRows, entryRows, from, to));
      else if (kind === 'gl') downloadText(`general-ledger-${from}-to-${to}.csv`, 'text/csv;charset=utf-8', generalLedgerCsv(accountRows, entryRows, from, to));
      else if (kind === 'journal') downloadText(`journal-${from}-to-${to}.csv`, 'text/csv;charset=utf-8', journalCsv(entryRows, from, to));
      else if (kind === 'coa') downloadText('chart-of-accounts.csv', 'text/csv;charset=utf-8', chartCsv(accountRows, entryRows));
      else if (kind === 'qbo-accounts') downloadText('quickbooks-accounts.csv', 'text/csv;charset=utf-8', quickBooksAccountsCsv(accountRows));
      else if (kind === 'qbo-journal') downloadText(`quickbooks-journal-${from}-to-${to}.csv`, 'text/csv;charset=utf-8', quickBooksJournalCsv(accountRows, entryRows, from, to));
      else if (kind === 'iif') {
        const parties = await fetchExportParties(treasuryGroupId, wallet);
        downloadText(`nave-pay-${from}-to-${to}.iif`, 'application/qbooks', quickBooksIif(accountRows, entryRows, from, to, parties.customers, parties.vendors));
      } else if (kind === 'audit') {
        const rows = audit.data ?? await fetchAuditRows(treasuryGroupId, wallet);
        const body = csvString(
          ['seq', 'at', 'document', 'op', 'document_id', 'prev_hash', 'hash', 'payload'],
          [...rows].sort((a, b) => a.seq - b.seq).map((row) => [row.seq, row.at, row.documentType, row.op, row.documentId, row.prevHash, row.hash, row.payload]),
        );
        downloadText(`audit-log-${today}.csv`, 'text/csv;charset=utf-8', body);
      }
    } catch (err) {
      setExportError(glMessage(err));
    }
  }

  async function closeBooks(reopenAll = false) {
    setLockError(null);
    setSavingLock(true);
    try {
      await saveBooksLock(
        treasuryGroupId,
        wallet,
        reopenAll ? '' : lockDate,
        lockNote,
        reopenAll || confirmReopen,
      );
      setConfirmReopen(false);
      await refresh();
    } catch (err) {
      setLockError(glMessage(err));
    } finally {
      setSavingLock(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <h1 style={payTitle}>Reports</h1>
          <p style={{ ...payBody, marginBottom: '14px' }}>
            Accrual books from the journal already posted by invoices, bills, cash, and payroll.
            {lockedThrough ? ` Closed through ${lockedThrough}.` : ' No period is closed.'}
          </p>
        </div>
        <button type="button" style={paySecondary} onClick={() => navigate('/pay/journal/new')}>Journal entry</button>
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            style={{ ...paySecondary, backgroundColor: tab === item.id ? '#111827' : '#fff', color: tab === item.id ? '#fff' : '#111827' }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'pnl' ? (
        <div style={{ display: 'flex', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
          <label style={dateLabel}>From <input style={payInput} type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label style={dateLabel}>To <input style={payInput} type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        </div>
      ) : tab === 'tb' || tab === 'bs' ? (
        <label style={{ ...dateLabel, marginBottom: '14px' }}>As of <input style={payInput} type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label>
      ) : null}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <button type="button" style={paySecondary} onClick={() => void exportFile('tb')}>Trial balance</button>
        <button type="button" style={paySecondary} onClick={() => void exportFile('bs')}>Balance sheet</button>
        <button type="button" style={paySecondary} onClick={() => void exportFile('pnl')}>P&amp;L</button>
        <button type="button" style={paySecondary} onClick={() => void exportFile('journal')}>Journal</button>
        <button type="button" style={paySecondary} onClick={() => void exportFile('coa')}>Chart of accounts</button>
        <button type="button" style={paySecondary} onClick={() => void exportFile('gl')}>General ledger</button>
        <button type="button" style={paySecondary} onClick={() => void exportFile('iif')}>QuickBooks IIF</button>
        <button type="button" style={paySecondary} onClick={() => void exportFile('qbo-journal')}>QBO journal</button>
        <button type="button" style={paySecondary} onClick={() => void exportFile('qbo-accounts')}>QBO accounts</button>
      </div>
      {exportError ? <p style={{ ...payBody, color: '#B42318' }}>{exportError}</p> : null}
      {loading ? <p style={payBody}>Loading the journal.</p> : null}
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{glMessage(error)}</p> : null}

      {!loading && !error && tab === 'tb' ? <TrialBalanceView accounts={accountRows} entries={entryRows} asOf={asOf} /> : null}
      {!loading && !error && tab === 'bs' ? <BalanceSheetView accounts={accountRows} entries={entryRows} asOf={asOf} /> : null}
      {!loading && !error && tab === 'pnl' ? <PnlView accounts={accountRows} entries={entryRows} from={from} to={to} /> : null}
      {!loading && !error && tab === 'accounts' ? (
        <ChartView
          accounts={accountRows}
          entries={entryRows}
          onSave={async (accountId, name, active) => {
            await updateGlAccount(wallet, accountId, name, active);
            await refresh();
          }}
        />
      ) : null}

      <section style={{ ...payCard, marginTop: '18px' }}>
        <h2 style={sectionTitle}>Period lock</h2>
        <p style={{ ...payBody, marginBottom: '12px' }}>
          Closed periods are enforced by the database. A journal dated on or before the lock is rejected, so invoice and bill posting into that period fails until you reopen it.
        </p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={dateLabel}>Books closed through
            <input style={payInput} type="date" value={lockDate || lockedThrough || ''} onChange={(event) => setLockDate(event.target.value)} />
          </label>
          <label style={{ ...dateLabel, minWidth: '220px' }}>Note
            <input style={payInput} value={lockNote} onChange={(event) => setLockNote(event.target.value)} placeholder="Q3 close" />
          </label>
        </div>
        <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px', fontSize: '13px', color: '#374151' }}>
          <input type="checkbox" checked={confirmReopen} onChange={(event) => setConfirmReopen(event.target.checked)} />
          Reopen days that are already closed
        </label>
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          <button type="button" style={payPrimary} disabled={savingLock} onClick={() => void closeBooks(false)}>
            {savingLock ? 'Saving…' : 'Close through date'}
          </button>
          {lockedThrough ? (
            <button type="button" style={paySecondary} disabled={savingLock} onClick={() => void closeBooks(true)}>Reopen all</button>
          ) : null}
        </div>
        {lock.data?.lockedAt ? <p style={{ ...payBody, marginTop: '10px' }}>Last changed {lock.data.lockedAt}{lock.data.note ? ` · ${lock.data.note}` : ''}</p> : null}
        {lockError ? <p style={{ ...payBody, color: '#B42318', marginTop: '10px' }}>{lockError}</p> : null}
      </section>

      <section style={{ ...payCard, marginTop: '18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
          <h2 style={sectionTitle}>Audit chain</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              style={paySecondary}
              onClick={() => {
                setAuditNote(null);
                void verifyAuditChain(treasuryGroupId, wallet)
                  .then((result) => setAuditNote(result.ok
                    ? `Chain verified · ${result.rows} rows · ${result.headHash.slice(0, 12)}`
                    : `Chain broken at ${result.brokenAt ?? ''}: ${result.reason ?? 'hash'}`))
                  .catch((err: unknown) => setAuditNote(glMessage(err)));
              }}
            >
              Verify
            </button>
            <button type="button" style={paySecondary} onClick={() => void exportFile('audit')}>Export CSV</button>
          </div>
        </div>
        <p style={{ ...payBody, margin: '8px 0 12px' }}>
          Each row stores the previous hash and a SHA-256 of the document. Tax ids, direct-deposit numbers, and bank tokens are not written here.
        </p>
        {auditNote ? <p style={{ ...payBody, marginBottom: '10px' }}>{auditNote}</p> : null}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ color: '#6B7280', textAlign: 'left' }}>
              <th style={th}>#</th>
              <th style={th}>When</th>
              <th style={th}>Document</th>
              <th style={th}>Op</th>
              <th style={th}>Hash</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data ?? []).slice(0, 12).map((row) => (
              <tr key={row.seq} style={{ borderTop: '1px solid #E7E2D6' }}>
                <td style={td}>{row.seq}</td>
                <td style={td}>{row.at.replace('T', ' ').replace('Z', '')}</td>
                <td style={td}>{row.documentType}</td>
                <td style={td}>{row.op}</td>
                <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{row.hash.slice(0, 12)}</td>
              </tr>
            ))}
            {(audit.data ?? []).length === 0 ? (
              <tr><td colSpan={5} style={td}>No document changes have been chained yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function TrialBalanceView({
  accounts, entries, asOf,
}: {
  accounts: Parameters<typeof trialBalance>[0];
  entries: Parameters<typeof trialBalance>[1];
  asOf: string;
}) {
  const report = trialBalance(accounts, entries, asOf);
  return (
    <div style={{ ...payCard, overflowX: 'auto' }}>
      <h2 style={sectionTitle}>Trial balance · {asOf} {report.balanced ? '· balanced' : '· out of balance'}</h2>
      <table style={table}>
        <thead>
          <tr style={{ color: '#6B7280', textAlign: 'left' }}>
            <th style={th}>#</th><th style={th}>Account</th><th style={th}>Type</th>
            <th style={{ ...th, textAlign: 'right' }}>Debit</th>
            <th style={{ ...th, textAlign: 'right' }}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.accountId} style={{ borderTop: '1px solid #E7E2D6' }}>
              <td style={td}>{row.code}</td>
              <td style={td}>{row.name}</td>
              <td style={td}>{row.accountType}</td>
              <td style={{ ...td, textAlign: 'right' }}>{row.debitCents ? formatCents(row.debitCents) : ''}</td>
              <td style={{ ...td, textAlign: 'right' }}>{row.creditCents ? formatCents(row.creditCents) : ''}</td>
            </tr>
          ))}
          {report.rows.length === 0 ? <tr><td colSpan={5} style={td}>No journal activity through this date.</td></tr> : null}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '1px solid #E7E2D6' }}>
            <td style={td} /><td style={td}>Total</td><td style={td} />
            <td style={{ ...td, textAlign: 'right' }}>{formatCents(report.totalDebit)}</td>
            <td style={{ ...td, textAlign: 'right' }}>{formatCents(report.totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function BalanceSheetView({
  accounts, entries, asOf,
}: {
  accounts: Parameters<typeof balanceSheet>[0];
  entries: Parameters<typeof balanceSheet>[1];
  asOf: string;
}) {
  const report = balanceSheet(accounts, entries, asOf);
  const blocks = [
    ['asset', 'Assets'],
    ['liability', 'Liabilities'],
    ['equity', 'Equity'],
  ] as const;
  return (
    <div style={payCard}>
      <h2 style={sectionTitle}>Balance sheet · {asOf} {report.balanced ? '· A = L + E' : '· does not balance'}</h2>
      {blocks.map(([key, label]) => (
        <div key={key} style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#6B7280' }}>{label}</div>
          {report.sections[key].map((row) => (
            <div key={`${row.code}-${row.name}`} style={line}>
              <span>{row.code ? `${row.code} ` : ''}{row.name}</span>
              <span>{formatCents(row.balanceCents)}</span>
            </div>
          ))}
          <div style={{ ...line, fontWeight: 600 }}>
            <span>Total {label.toLowerCase()}</span>
            <span>{formatCents(report.totals[key])}</span>
          </div>
        </div>
      ))}
      <div style={{ ...line, fontWeight: 600, marginTop: '8px' }}>
        <span>Total liabilities and equity</span>
        <span>{formatCents(report.liabilitiesAndEquity)}</span>
      </div>
      <p style={{ ...payBody, marginTop: '12px' }}>
        Fiscal year starts {report.fyStart}. Net income is computed from income and expense accounts. Retained earnings are prior years plus anything posted to 3900.
      </p>
    </div>
  );
}

function PnlView({
  accounts, entries, from, to,
}: {
  accounts: Parameters<typeof profitAndLoss>[0];
  entries: Parameters<typeof profitAndLoss>[1];
  from: string;
  to: string;
}) {
  const report = profitAndLoss(accounts, entries, from, to);
  return (
    <div style={payCard}>
      <h2 style={sectionTitle}>Profit &amp; loss (accrual) · {from} – {to}</h2>
      {(Object.keys(PNL_LABELS) as PnlGroup[]).filter((group) => report.groups[group].length > 0).map((group) => (
        <div key={group} style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#6B7280' }}>{PNL_LABELS[group]}</div>
          {report.groups[group].map((row) => (
            <div key={row.accountId} style={line}>
              <span>{row.code} {row.name}</span>
              <span>{formatCents(row.amountCents)}</span>
            </div>
          ))}
        </div>
      ))}
      <div style={{ ...line, fontWeight: 600, marginTop: '12px' }}><span>Gross profit</span><span>{formatCents(report.grossProfit)}</span></div>
      <div style={{ ...line, fontWeight: 600 }}><span>Operating income</span><span>{formatCents(report.operatingIncome)}</span></div>
      <div style={{ ...line, fontWeight: 600 }}><span>Net income</span><span>{formatCents(report.netIncome)}</span></div>
      <p style={{ ...payBody, marginTop: '12px' }}>Invoices are revenue when sent. Bills are expenses on the bill date.</p>
    </div>
  );
}

function ChartView({
  accounts, entries, onSave,
}: {
  accounts: Parameters<typeof chartBalances>[0];
  entries: Parameters<typeof chartBalances>[1];
  onSave: (accountId: string, name: string, active: boolean) => Promise<void>;
}) {
  const rows = chartBalances(accounts, entries);
  const [drafts, setDrafts] = useState<Record<string, { name: string; active: boolean }>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  return (
    <div style={{ ...payCard, overflowX: 'auto' }}>
      <h2 style={sectionTitle}>Chart of accounts</h2>
      <p style={{ ...payBody, marginBottom: '12px' }}>Names and the active flag can change. A number that already appears on a journal stays where it is.</p>
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
      <table style={table}>
        <thead>
          <tr style={{ color: '#6B7280', textAlign: 'left' }}>
            <th style={th}>#</th><th style={th}>Name</th><th style={th}>Active</th>
            <th style={{ ...th, textAlign: 'right' }}>Balance</th><th style={th} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const draft = drafts[row.id] ?? { name: row.name, active: !row.archived };
            return (
              <tr key={row.id} style={{ borderTop: '1px solid #E7E2D6' }}>
                <td style={td}>{row.code}{row.systemKey ? ' · system' : ''}</td>
                <td style={td}>
                  <input
                    style={{ ...payInput, minWidth: '220px' }}
                    value={draft.name}
                    onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: { ...draft, name: event.target.value } }))}
                  />
                </td>
                <td style={td}>
                  <input
                    type="checkbox"
                    checked={draft.active}
                    disabled={Boolean(row.systemKey)}
                    onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: { ...draft, active: event.target.checked } }))}
                  />
                </td>
                <td style={{ ...td, textAlign: 'right' }}>{row.used ? formatCents(row.balanceCents) : ''}</td>
                <td style={td}>
                  <button
                    type="button"
                    style={paySecondary}
                    disabled={saving === row.id}
                    onClick={() => {
                      setError(null);
                      setSaving(row.id);
                      void onSave(row.id, draft.name, draft.active)
                        .catch((err: unknown) => setError(glMessage(err)))
                        .finally(() => setSaving(null));
                    }}
                  >
                    Save
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const table = { width: '100%', borderCollapse: 'collapse' as const, fontSize: '14px' };
const th = { padding: '8px 8px 8px 0', fontWeight: 600 };
const td = { padding: '10px 8px 10px 0', color: '#111827', verticalAlign: 'middle' as const };
const sectionTitle = { fontSize: '16px', fontWeight: 600, margin: '0 0 8px', color: '#111827' };
const dateLabel = { display: 'flex', flexDirection: 'column' as const, gap: '6px', fontSize: '13px', color: '#374151' };
const line = { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', fontSize: '14px', color: '#111827' };
