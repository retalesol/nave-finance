import { useMemo, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { formatCents, localToday } from '../../lib/pay/invoiceMath';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../../lib/pay/payables';
import {
  addIsoDays,
  mercurySuggest,
  type ExistingBookLink,
  type MercurySuggestion,
} from '../../../supabase/functions/_shared/mercury.ts';
import {
  autoClearRecon,
  autoMatchMercury,
  clearAccountLock,
  connectMercury,
  disconnectMercury,
  fetchGlAccounts,
  fetchMatchBooks,
  fetchMercuryStatus,
  fetchMercuryTransactions,
  fetchReconAccounts,
  fetchReconDetail,
  finishRecon,
  linkMercuryAccount,
  matchMercury,
  mercuryMessage,
  saveMercurySettings,
  setReconCleared,
  startRecon,
  syncMercury,
  undoRecon,
  unmatchMercury,
  type MercuryTxnRow,
} from '../../lib/pay/mercuryApi';
import { PayPage } from './PayDesk';
import { payBody, payCard, payDanger, payField, payInput, payPrimary, paySecondary, payTitle } from './payStyles';

const KIND_LABEL: Record<string, string> = {
  incomingDomesticWire: 'Wire',
  incomingInternationalWire: 'Wire (intl)',
  externalTransfer: 'ACH',
  checkDeposit: 'Check',
  outgoingPayment: 'ACH / Wire',
  debitCardTransaction: 'Card',
  creditCardTransaction: 'Card',
  internalTransfer: 'Internal transfer',
  treasuryTransfer: 'Treasury transfer',
  wireFee: 'Bank fee',
  interestPayment: 'Interest',
};

const VIEWS = [
  ['unmatched', 'Needs review'],
  ['pending', 'Pending'],
  ['matched', 'Matched'],
  ['ignored', 'Ignored'],
  ['all', 'All'],
] as const;

type View = (typeof VIEWS)[number][0];

function utcDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function withinWeek(day: string, center: string): boolean {
  return day >= addIsoDays(center, -7) && day <= addIsoDays(center, 7);
}

export default function BankPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const membership = useDaoMembership();
  const wallet = membership.walletStr;
  const [params, setParams] = useSearchParams();
  const reconId = params.get('recon');
  const status = useQuery({
    queryKey: ['payMercury', treasuryGroupId, wallet],
    queryFn: () => fetchMercuryStatus(treasuryGroupId, wallet),
  });

  if (reconId) {
    return (
      <ReconWorksheet
        reconId={reconId}
        wallet={wallet}
        onBack={() => setParams({})}
      />
    );
  }

  const connected = status.data?.connected ?? false;
  return (
    <PayPage
      kicker="Match"
      title="Bank feed"
      purpose="Mercury is read-only. Match bank lines to invoices, bills, and cash entries. Nave Pay does not send payments from the bank."
      metrics={[
        { label: 'Connection', value: status.isLoading ? '…' : connected ? 'On' : 'Off', detail: connected ? 'Balances and transactions' : 'Paste a read token to start', tone: connected ? 'good' : 'default' },
      ]}
    >
      {status.isLoading ? <p style={payBody}>Loading the bank feed.</p> : null}
      {status.isError ? <p style={{ ...payBody, color: '#B42318' }}>{mercuryMessage(status.error)}</p> : null}
      {status.data ? (
        <BankFeed
          treasuryGroupId={treasuryGroupId}
          wallet={wallet}
          status={status.data}
          onOpen={(id) => setParams({ recon: id })}
        />
      ) : null}
    </PayPage>
  );
}

function BankFeed({
  treasuryGroupId,
  wallet,
  status,
  onOpen,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  status: Awaited<ReturnType<typeof fetchMercuryStatus>>;
  onOpen: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [syncStart, setSyncStart] = useState(status.sync_start ?? '');
  const [autoMatch, setAutoMatch] = useState(status.auto_match);
  const [forget, setForget] = useState(false);
  const [view, setView] = useState<View>('unmatched');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [matching, setMatching] = useState<string | null>(null);
  const txns = useQuery({
    queryKey: ['payMercuryTx', treasuryGroupId, wallet],
    queryFn: () => fetchMercuryTransactions(treasuryGroupId, wallet),
  });
  const accounts = useQuery({
    queryKey: ['payGl', treasuryGroupId, wallet],
    queryFn: () => fetchGlAccounts(treasuryGroupId, wallet),
  });
  const books = useQuery({
    queryKey: ['payMatchBooks', treasuryGroupId, wallet],
    queryFn: () => fetchMatchBooks(treasuryGroupId, wallet),
  });
  const recon = useQuery({
    queryKey: ['payRecon', treasuryGroupId, wallet],
    queryFn: () => fetchReconAccounts(treasuryGroupId, wallet),
  });

  const paidByInvoice = useMemo(() => {
    const totals = new Map<string, number>();
    for (const payment of books.data?.payments ?? []) {
      totals.set(payment.invoice_id, (totals.get(payment.invoice_id) ?? 0) + payment.amount_cents);
    }
    return totals;
  }, [books.data]);
  const paidByBill = useMemo(() => {
    const totals = new Map<string, number>();
    for (const payment of books.data?.billPayments ?? []) {
      totals.set(payment.bill_id, (totals.get(payment.bill_id) ?? 0) + payment.amount_cents);
    }
    return totals;
  }, [books.data]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['payMercury', treasuryGroupId] });
    await queryClient.invalidateQueries({ queryKey: ['payMercuryTx', treasuryGroupId] });
    await queryClient.invalidateQueries({ queryKey: ['payRecon', treasuryGroupId] });
    await queryClient.invalidateQueries({ queryKey: ['payMatchBooks', treasuryGroupId] });
  }

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setNotice(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setNotice(mercuryMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const cashAccounts = (accounts.data ?? []).filter((account) =>
    ['bank', 'cash', 'credit_card', 'digital_asset'].includes(account.subtype),
  );
  const linked = useMemo(() => ({
    payments: new Set((txns.data ?? []).filter((row) => row.match_type === 'payment' && row.match_id).map((row) => row.match_id as string)),
    bills: new Set((txns.data ?? []).filter((row) => row.match_type === 'bill_payment' && row.match_id).map((row) => row.match_id as string)),
    cash: new Set((txns.data ?? []).filter((row) => row.match_type === 'cash_entry' && row.match_id).map((row) => row.match_id as string)),
  }), [txns.data]);

  const rows = (txns.data ?? []).filter((row) => {
    if (view === 'pending') return row.status === 'pending';
    if (view === 'matched') return row.match_type != null;
    if (view === 'ignored') return row.ignored && row.match_type == null;
    if (view === 'all') return true;
    return row.status === 'sent' && !row.ignored && row.match_type == null;
  });

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <section style={payCard}>
        <div className="nave-label" style={{ marginBottom: '8px' }}>Connection</div>
        <p style={{ ...payBody, marginBottom: '12px' }}>
          {status.connected
            ? `Connected to Mercury ${status.environment ?? ''} · token ${status.token_hint}`
            : 'Not connected. Paste a read-only token from Mercury → Settings → API Tokens.'}
        </p>
        {status.last_error ? <p style={{ ...payBody, color: '#B42318', marginBottom: '12px' }}>{status.last_error}</p> : null}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="secret-token:mercury_production_…"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            style={{ ...payInput, minWidth: '280px', flex: '1 1 280px' }}
          />
          <button
            type="button"
            style={payPrimary}
            disabled={busy != null || !wallet}
            onClick={() => {
              const value = token;
              setToken('');
              void run('connect', async () => {
                await connectMercury(treasuryGroupId, wallet as string, value);
                setNotice('Connected. Sync when you want the latest transactions.');
              });
            }}
          >
            {busy === 'connect' ? 'Checking…' : status.connected ? 'Replace token' : 'Connect'}
          </button>
          {status.connected ? (
            <button
              type="button"
              style={payPrimary}
              disabled={busy != null || !wallet}
              onClick={() => void run('sync', async () => {
                const result = await syncMercury(treasuryGroupId, wallet as string);
                let matched = 0;
                if (autoMatch) matched = await autoMatchMercury(treasuryGroupId, wallet);
                setNotice(`Synced ${result.accounts} accounts: ${result.new} new, ${result.updated} updated${matched ? `, ${matched} auto-matched` : ''}.`);
              })}
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
          ) : null}
        </div>
        <p style={{ ...payBody, marginTop: '10px' }}>
          The token is checked with a GET, then stored encrypted for this treasury. It is not shown again and it is not kept in the browser.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginTop: '14px' }}>
          <label style={payField}>
            Import from
            <input type="date" value={syncStart} onChange={(event) => setSyncStart(event.target.value)} style={payInput} />
          </label>
          <label style={{ ...payField, justifyContent: 'flex-end' }}>
            <span>
              <input type="checkbox" checked={autoMatch} onChange={(event) => setAutoMatch(event.target.checked)} /> Auto-match on sync
            </span>
          </label>
        </div>
        <p style={{ ...payBody, marginTop: '8px' }}>
          Auto-match runs only when the invoice number is in the memo and the amount equals the open balance. A blank start date uses the last 90 days, then a 14-day overlap.
        </p>
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
          <button
            type="button"
            style={paySecondary}
            disabled={busy != null}
            onClick={() => void run('settings', async () => {
              await saveMercurySettings(treasuryGroupId, wallet, syncStart, autoMatch);
              setNotice('Sync settings saved.');
            })}
          >
            Save sync settings
          </button>
          <button
            type="button"
            style={paySecondary}
            disabled={busy != null}
            onClick={() => void run('auto', async () => {
              const matched = await autoMatchMercury(treasuryGroupId, wallet);
              setNotice(matched ? `Matched ${matched} transaction${matched === 1 ? '' : 's'}.` : 'No high-confidence matches.');
            })}
          >
            Auto-match
          </button>
          {status.connected ? (
            <button
              type="button"
              style={payDanger}
              disabled={busy != null}
              onClick={() => {
                if (!window.confirm('Disconnect Mercury? Matched payments stay in the books.')) return;
                void run('disconnect', async () => {
                  await disconnectMercury(treasuryGroupId, wallet, forget);
                  setNotice('Mercury disconnected.');
                });
              }}
            >
              Disconnect
            </button>
          ) : null}
          {status.connected ? (
            <label style={{ ...payBody, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" checked={forget} onChange={(event) => setForget(event.target.checked)} />
              Also forget unmatched feed rows
            </label>
          ) : null}
        </div>
        {notice ? <p style={{ ...payBody, marginTop: '12px' }}>{notice}</p> : null}
      </section>

      {status.accounts.length > 0 ? (
        <section style={payCard}>
          <div className="nave-label" style={{ marginBottom: '8px' }}>Account mapping</div>
          <p style={{ ...payBody, marginBottom: '12px' }}>
            Checking maps to 1000 Mercury Checking. Savings or treasury maps to 1010 when that account is on the chart.
          </p>
          {status.accounts.map((account) => (
            <label key={account.id} style={{ ...payField, marginBottom: '10px' }}>
              {(account.nickname || account.name || 'Mercury')}{account.last4 ? ` ··${account.last4}` : ''} · {formatCents(account.current_cents)}
              <select
                value={account.gl_account_id ?? ''}
                style={payInput}
                onChange={(event) => void run('map', () => linkMercuryAccount(
                  treasuryGroupId,
                  wallet,
                  account.mercury_id,
                  event.target.value || null,
                ))}
              >
                <option value="">Default cash account</option>
                {cashAccounts.map((gl) => (
                  <option key={gl.id} value={gl.id}>{gl.code} {gl.name}</option>
                ))}
              </select>
            </label>
          ))}
        </section>
      ) : null}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
        <Metric label="Mercury available" value={formatCents(status.total_available_cents)} detail={`Current ${formatCents(status.total_current_cents)}`} />
        <Metric label="Needs review" value={String(status.unmatched)} detail={`${status.pending} pending at the bank`} />
      </section>

      <section style={{ ...payCard, padding: 0 }}>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid #EFEAE0' }}>
          {VIEWS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              style={{ ...paySecondary, backgroundColor: view === key ? '#111827' : '#fff', color: view === key ? '#fff' : '#111827' }}
            >
              {label}
            </button>
          ))}
        </div>
        {rows.length === 0 ? (
          <p style={{ ...payBody, padding: '16px' }}>
            {view === 'unmatched' ? 'Nothing to review. Every posted transaction is matched or ignored.' : 'No transactions here.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13.5px' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#6B7280' }}>
                  <th style={th}>Date</th>
                  <th style={th}>Description</th>
                  <th style={th}>Amount</th>
                  <th style={th}>Match</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const suggestion = suggestionFor(row, books.data, paidByInvoice, paidByBill, linked);
                  const account = status.accounts.find((item) => item.id === row.account_id);
                  return (
                    <tr key={row.id} style={{ borderTop: '1px solid #EFEAE0', verticalAlign: 'top' }}>
                      <td style={td}>{utcDay(row.posted_at ?? row.mercury_created_at) ?? '—'}</td>
                      <td style={td}>
                        <div style={{ fontWeight: 600 }}>{row.counterparty || row.bank_description || '—'}</div>
                        <div style={{ color: '#6B7280' }}>
                          {[row.bank_description !== row.counterparty ? row.bank_description : '', row.external_memo, row.note].filter(Boolean).join(' · ')}
                        </div>
                        <div style={{ color: '#9CA3AF' }}>
                          {KIND_LABEL[row.kind] ?? row.kind} · {account?.nickname || account?.name || 'Mercury'}
                          {row.dashboard_link ? <> · <a href={row.dashboard_link} target="_blank" rel="noreferrer">Open in Mercury</a></> : null}
                        </div>
                      </td>
                      <td style={{ ...td, color: row.amount_cents >= 0 ? '#166534' : '#B42318', whiteSpace: 'nowrap' }}>
                        {row.amount_cents > 0 ? '+' : ''}{formatCents(row.amount_cents)}
                      </td>
                      <td style={td}>
                        {row.match_type ? <span>Matched · {row.match_type.replace('_', ' ')}</span> : null}
                        {!row.match_type && row.status !== 'sent' ? <span>{row.status || 'unknown'}</span> : null}
                        {!row.match_type && row.ignored ? <span>Ignored</span> : null}
                        {!row.match_type && !row.ignored && row.status === 'sent' && suggestion
                          ? <span>{suggestion.label} · {suggestion.confidence}</span>
                          : null}
                        {!row.match_type && !row.ignored && row.status === 'sent' && !suggestion ? <span style={{ color: '#9CA3AF' }}>No suggestion</span> : null}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {row.match_type ? (
                          <button type="button" style={paySecondary} onClick={() => {
                            if (!window.confirm('Unmatch this transaction? Only the book row this feed created is deleted.')) return;
                            void run('unmatch', () => unmatchMercury(treasuryGroupId, wallet, row.mercury_id));
                          }}>Unmatch</button>
                        ) : null}
                        {!row.match_type && row.status === 'sent' && row.ignored ? (
                          <button type="button" style={paySecondary} onClick={() => void run('restore', () => matchMercury(treasuryGroupId, wallet, row.mercury_id, { type: 'unignore' }))}>Restore</button>
                        ) : null}
                        {!row.match_type && row.status === 'sent' && !row.ignored ? (
                          <span style={{ display: 'inline-flex', gap: '6px' }}>
                            {suggestion ? (
                              <button type="button" style={payPrimary} onClick={() => void run('apply', () => matchMercury(treasuryGroupId, wallet, row.mercury_id, {
                                type: suggestion.type,
                                target_id: suggestion.id,
                                link_type: suggestion.link_type ?? '',
                              }))}>Apply</button>
                            ) : null}
                            <button type="button" style={paySecondary} onClick={() => setMatching(matching === row.mercury_id ? null : row.mercury_id)}>Match</button>
                            <button type="button" style={paySecondary} onClick={() => void run('ignore', () => matchMercury(treasuryGroupId, wallet, row.mercury_id, { type: 'ignore' }))}>Ignore</button>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {matching ? (
          <MatchForm
            txn={(txns.data ?? []).find((row) => row.mercury_id === matching) ?? null}
            books={books.data}
            paidByInvoice={paidByInvoice}
            paidByBill={paidByBill}
            payables={status.payables}
            busy={busy != null}
            onClose={() => setMatching(null)}
            onSave={(body) => void run('match', async () => {
              await matchMercury(treasuryGroupId, wallet, matching, body);
              setMatching(null);
              setNotice('Matched.');
            })}
          />
        ) : null}
      </section>

      <section style={payCard}>
        <div className="nave-label" style={{ marginBottom: '8px' }}>Reconcile</div>
        <p style={{ ...payBody, marginBottom: '12px' }}>
          Statement periods for bank, cash, card, and digital-asset accounts. Finishing can lock that account only.
        </p>
        <ReconcileStarter
          accounts={recon.data ?? []}
          busy={busy != null}
          onStart={(accountId, date, balance, notes) => void run('start', async () => {
            const id = await startRecon(treasuryGroupId, wallet, accountId, date, balance, notes);
            onOpen(id);
          })}
          onOpen={onOpen}
        />
      </section>
    </div>
  );
}

function suggestionFor(
  row: MercuryTxnRow,
  books: Awaited<ReturnType<typeof fetchMatchBooks>> | undefined,
  paidByInvoice: Map<string, number>,
  paidByBill: Map<string, number>,
  linked: { payments: Set<string>; bills: Set<string>; cash: Set<string> },
): MercurySuggestion | null {
  if (!books || row.status !== 'sent' || row.ignored || row.match_type) return null;
  const day = utcDay(row.posted_at ?? row.mercury_created_at);
  const existing: ExistingBookLink[] = [];
  if (day && row.amount_cents > 0) {
    for (const payment of books.payments) {
      if (linked.payments.has(payment.id) || payment.amount_cents !== row.amount_cents || !withinWeek(payment.paid_on, day)) continue;
      existing.push({ id: payment.id, link_type: 'payment', label: `Already recorded: ${payment.number} ${payment.paid_on}` });
    }
    for (const entry of books.cash) {
      if (entry.direction !== 'in' || linked.cash.has(entry.id) || entry.amount_cents !== row.amount_cents || !withinWeek(entry.entry_date, day)) continue;
      existing.push({ id: entry.id, link_type: 'cash_entry', label: `Already recorded: deposit ${entry.entry_date}` });
    }
  }
  if (day && row.amount_cents < 0) {
    const abs = -row.amount_cents;
    for (const payment of books.billPayments) {
      if (linked.bills.has(payment.id) || payment.amount_cents !== abs || !withinWeek(payment.paid_on, day)) continue;
      existing.push({ id: payment.id, link_type: 'bill_payment', label: `Already recorded: ${payment.vendor_name} ${payment.paid_on}` });
    }
    for (const entry of books.cash) {
      if (entry.direction !== 'out' || linked.cash.has(entry.id) || entry.amount_cents !== abs || !withinWeek(entry.entry_date, day)) continue;
      existing.push({ id: entry.id, link_type: 'cash_entry', label: `Already recorded: expense ${entry.entry_date}` });
    }
  }
  const openInvoices = books.invoices
    .map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      customer_name: invoice.customer_name,
      balance_cents: invoice.total_cents - (paidByInvoice.get(invoice.id) ?? 0),
    }))
    .filter((invoice) => invoice.balance_cents > 0);
  const openBills = books.bills.map((bill) => ({
    id: bill.id,
    vendor_name: bill.vendor_name,
    ref: bill.ref,
    balance_cents: bill.amount_cents - (paidByBill.get(bill.id) ?? 0),
  })).filter((bill) => bill.balance_cents > 0);
  return mercurySuggest(row, openInvoices, openBills, existing);
}

function MatchForm({
  txn,
  books,
  paidByInvoice,
  paidByBill,
  payables,
  busy,
  onClose,
  onSave,
}: {
  txn: MercuryTxnRow | null;
  books: Awaited<ReturnType<typeof fetchMatchBooks>> | undefined;
  paidByInvoice: Map<string, number>;
  paidByBill: Map<string, number>;
  payables: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const inflow = (txn?.amount_cents ?? 0) > 0;
  const abs = Math.abs(txn?.amount_cents ?? 0);
  const docs = inflow
    ? (books?.invoices ?? [])
      .map((invoice) => ({ id: invoice.id, label: `${invoice.number} · ${invoice.customer_name}`, balance: invoice.total_cents - (paidByInvoice.get(invoice.id) ?? 0) }))
      .filter((invoice) => invoice.balance > 0)
    : (books?.bills ?? [])
      .map((bill) => ({ id: bill.id, label: `${bill.vendor_name}${bill.ref ? ` · ${bill.ref}` : ''}`, balance: bill.amount_cents - (paidByBill.get(bill.id) ?? 0) }))
      .filter((bill) => bill.balance > 0);
  const [mode, setMode] = useState(docs.length > 0 && (inflow || payables) ? (inflow ? 'invoice' : 'bill') : (inflow ? 'deposit' : 'expense'));
  const [target, setTarget] = useState(docs.find((doc) => doc.balance >= abs)?.id ?? docs[0]?.id ?? '');
  const [category, setCategory] = useState(inflow ? INCOME_CATEGORIES[INCOME_CATEGORIES.length - 1] : EXPENSE_CATEGORIES[EXPENSE_CATEGORIES.length - 1]);
  const [counterparty, setCounterparty] = useState(txn?.counterparty ?? '');
  if (!txn) return null;
  const categories = inflow ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  return (
    <form
      style={{ padding: '16px', borderTop: '1px solid #EFEAE0' }}
      onSubmit={(event) => {
        event.preventDefault();
        if (mode === 'invoice' || mode === 'bill') onSave({ type: mode, target_id: target });
        else onSave({ type: mode, category, counterparty });
      }}
    >
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        {(inflow || payables) ? (
          <label style={payField}>
            <span><input type="radio" checked={mode === (inflow ? 'invoice' : 'bill')} onChange={() => setMode(inflow ? 'invoice' : 'bill')} /> {inflow ? 'Invoice payment' : 'Bill payment'}</span>
            <select value={target} onChange={(event) => setTarget(event.target.value)} style={payInput}>
              {docs.map((doc) => (
                <option key={doc.id} value={doc.id} disabled={doc.balance < abs}>
                  {doc.label} · {formatCents(doc.balance)}{doc.balance < abs ? ' (too small)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label style={payField}>
          <span><input type="radio" checked={mode === (inflow ? 'deposit' : 'expense')} onChange={() => setMode(inflow ? 'deposit' : 'expense')} /> {inflow ? 'Other deposit' : 'Expense'}</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)} style={payInput}>
            {categories.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <input value={counterparty} onChange={(event) => setCounterparty(event.target.value)} style={payInput} placeholder="Counterparty" />
        </label>
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button type="submit" style={payPrimary} disabled={busy}>Match</button>
        <button type="button" style={paySecondary} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function ReconcileStarter({
  accounts,
  busy,
  onStart,
  onOpen,
}: {
  accounts: Awaited<ReturnType<typeof fetchReconAccounts>>;
  busy: boolean;
  onStart: (accountId: string, date: string, balance: string, notes: string) => void;
  onOpen: (id: string) => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [date, setDate] = useState(localToday());
  const [balance, setBalance] = useState('');
  const [notes, setNotes] = useState('');
  const selected = accounts.find((account) => account.id === accountId) ?? accounts[0];
  return (
    <div>
      {accounts.length === 0 ? <p style={payBody}>No cash accounts to reconcile.</p> : (
        <div style={{ display: 'grid', gap: '8px' }}>
          {accounts.map((account) => (
            <div key={account.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', borderTop: '1px solid #EFEAE0', padding: '10px 0' }}>
              <span>{account.code} {account.name} · book {formatCents(account.balance_cents)}</span>
              {account.open_recon ? (
                <button type="button" style={payPrimary} onClick={() => onOpen(account.open_recon as string)}>Continue</button>
              ) : (
                <span style={{ color: '#6B7280' }}>{account.last_reconciled ? `Last ${account.last_reconciled}` : 'Never reconciled'}</span>
              )}
            </div>
          ))}
          <form
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginTop: '8px' }}
            onSubmit={(event) => {
              event.preventDefault();
              if (selected && !selected.open_recon) onStart(selected.id, date, balance, notes);
            }}
          >
            <label style={payField}>Account
              <select value={selected?.id ?? ''} onChange={(event) => setAccountId(event.target.value)} style={payInput}>
                {accounts.filter((account) => !account.open_recon).map((account) => (
                  <option key={account.id} value={account.id}>{account.code} {account.name}</option>
                ))}
              </select>
            </label>
            <label style={payField}>Statement end
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} style={payInput} />
            </label>
            <label style={payField}>Ending balance
              <input value={balance} onChange={(event) => setBalance(event.target.value)} placeholder="0.00" style={payInput} />
            </label>
            <label style={payField}>Notes
              <input value={notes} onChange={(event) => setNotes(event.target.value)} style={payInput} />
            </label>
            <button type="submit" style={{ ...payPrimary, alignSelf: 'end' }} disabled={busy || !selected || !!selected.open_recon}>Start</button>
          </form>
        </div>
      )}
    </div>
  );
}

function ReconWorksheet({
  reconId,
  wallet,
  onBack,
}: {
  reconId: string;
  wallet: string | null;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['payReconDetail', reconId, wallet],
    queryFn: () => fetchReconDetail(wallet, reconId),
  });
  const [lock, setLock] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ['payReconDetail', reconId] });
      await queryClient.invalidateQueries({ queryKey: ['payRecon'] });
    } catch (err) {
      setNotice(mercuryMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const data = detail.data;
  if (detail.isLoading) return <p style={payBody}>Loading the statement.</p>;
  if (detail.isError || !data) return <p style={{ ...payBody, color: '#B42318' }}>{mercuryMessage(detail.error)}</p>;
  const open = data.recon.status === 'open';
  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1 style={payTitle}>Reconcile · {data.account.name}</h1>
      <p style={{ ...payBody, marginBottom: '16px' }}>{data.account.code} · {open ? 'In progress' : 'Finished'}</p>
      <button type="button" style={{ ...paySecondary, marginBottom: '16px' }} onClick={onBack}>Back to bank feed</button>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
        <Metric label={`Statement ${data.recon.statement_date}`} value={formatCents(data.recon.statement_balance_cents)} detail="Ending balance" />
        <Metric label="Opening" value={formatCents(data.recon.begin_balance_cents)} detail="Last reconciled balance" />
        <Metric label="Cleared" value={formatCents(data.cleared_balance_cents)} detail={`Plus ${formatCents(data.cleared_cents)}`} />
        <Metric label="Difference" value={formatCents(data.difference_cents)} detail={data.difference_cents === 0 ? 'Ties out' : 'Must be 0.00 to finish'} />
      </div>
      {data.locked_through ? (
        <p style={{ ...payBody, marginTop: '12px' }}>
          This account is locked through {data.locked_through}.
          <button type="button" style={{ ...paySecondary, marginLeft: '8px' }} disabled={busy} onClick={() => void run(() => clearAccountLock(wallet, data.account.id))}>Clear this account lock</button>
        </p>
      ) : null}
      {notice ? <p style={{ ...payBody, color: '#B42318', marginTop: '12px' }}>{notice}</p> : null}
      {data.flags.length > 0 ? (
        <ul style={{ marginTop: '12px', paddingLeft: '18px', color: '#374151' }}>
          {data.flags.map((flag, index) => <li key={`${flag.key ?? 'note'}-${index}`}>{flag.text}</li>)}
        </ul>
      ) : null}
      <div style={{ ...payCard, marginTop: '16px', padding: 0 }}>
        <div style={{ display: 'flex', gap: '8px', padding: '12px 16px' }}>
          {open ? (
            <>
              <button type="button" style={paySecondary} disabled={busy} onClick={() => void run(async () => {
                const count = await autoClearRecon(wallet, reconId);
                setNotice(`${count} line${count === 1 ? '' : 's'} cleared from Mercury.`);
              })}>Auto-clear Mercury</button>
              <button type="button" style={paySecondary} disabled={busy} onClick={() => void run(() => setReconCleared(wallet, reconId, data.items.filter((item) => !item.cleared).map((item) => item.clear_key), true))}>Clear all</button>
              <button type="button" style={paySecondary} disabled={busy} onClick={() => void run(() => setReconCleared(wallet, reconId, data.items.filter((item) => item.cleared).map((item) => item.clear_key), false))}>Unclear all</button>
            </>
          ) : null}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13.5px' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6B7280' }}>
              <th style={th} />
              <th style={th}>Date</th>
              <th style={th}>Memo</th>
              <th style={th}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.clear_key} style={{ borderTop: '1px solid #EFEAE0' }}>
                <td style={td}>
                  <input
                    type="checkbox"
                    checked={item.cleared}
                    disabled={!open || busy}
                    onChange={(event) => void run(() => setReconCleared(wallet, reconId, [item.clear_key], event.target.checked))}
                  />
                </td>
                <td style={td}>{item.date}</td>
                <td style={td}>{item.party || item.memo}{item.mercury ? ` · Mercury ${item.mercury.status}` : ''}</td>
                <td style={td}>{formatCents(item.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.items.length === 0 ? <p style={{ ...payBody, padding: '16px' }}>Nothing to reconcile in this period.</p> : null}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        {open ? (
          <>
            <label style={payBody}>
              <input type="checkbox" checked={lock} onChange={(event) => setLock(event.target.checked)} /> Lock this account through {data.recon.statement_date}
            </label>
            <button type="button" style={payDanger} disabled={busy} onClick={() => {
              if (!window.confirm('Discard this in-progress reconciliation?')) return;
              void run(async () => {
                await undoRecon(wallet, reconId);
                onBack();
              });
            }}>Discard</button>
            <button
              type="button"
              style={payPrimary}
              disabled={busy || data.difference_cents !== 0}
              onClick={() => void run(async () => {
                const result = await finishRecon(wallet, reconId, lock);
                setNotice(result.locked_through ? `Finished. This account is locked through ${result.locked_through}.` : 'Finished.');
              })}
            >
              Finish reconciliation
            </button>
          </>
        ) : (
          <button type="button" style={paySecondary} disabled={busy} onClick={() => void run(() => undoRecon(wallet, reconId))}>Undo reconciliation</button>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div style={payCard}>
      <div className="nave-label">{label}</div>
      <div style={{ fontSize: '22px', margin: '6px 0' }}>{value}</div>
      <div style={{ color: '#6B7280', fontSize: '13px' }}>{detail}</div>
    </div>
  );
}

const th: CSSProperties = { padding: '8px 12px', fontWeight: 500 };
const td: CSSProperties = { padding: '10px 12px' };
