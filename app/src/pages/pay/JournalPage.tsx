import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { formatCents, localToday, moneyIn } from '../../lib/pay/invoiceMath';
import { validateManualJournal, type GlJournalEntry } from '../../lib/pay/gl';
import { centsToInput } from '../../lib/pay/payables';
import {
  deleteManualJournal,
  fetchBooksLock,
  fetchGlAccounts,
  fetchGlEntries,
  glMessage,
  postManualJournal,
} from '../../lib/pay/glApi';
import { PayPage } from './PayDesk';
import { payBody, payCard, payDanger, payInput, payPrimary, paySecondary } from './payStyles';

interface DraftLine {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

const EMPTY_LINE: DraftLine = { accountId: '', debit: '', credit: '', memo: '' };

function entryId(pathname: string): string | null {
  const match = pathname.match(/^\/pay\/journal\/([^/]+)$/);
  if (!match || match[1] === 'new') return null;
  return match[1];
}

export default function JournalPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname.replace(/\/+$/, '') || '/pay/journal';
  const creating = path === '/pay/journal/new';
  const editingId = entryId(path);
  const membership = useDaoMembership();
  const wallet = membership.walletStr;
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

  const selected = (entries.data ?? []).find((entry) => entry.id === editingId) ?? null;
  const loading = accounts.isLoading || entries.isLoading;
  const error = accounts.error || entries.error;

  const posted = entries.data ?? [];
  const manualCount = posted.filter((entry) => entry.sourceType === 'manual').length;
  return (
    <PayPage
      kicker="Books"
      title="Journal"
      purpose={`Manual entries post as source type manual. Invoice, bill, cash, and payroll journals stay on their own documents.${lock.data?.lockedThrough ? ` Closed through ${lock.data.lockedThrough}.` : ''}`}
      actions={(
        <>
          <button type="button" style={paySecondary} onClick={() => navigate('/pay/reports')}>Reports</button>
          {path !== '/pay/journal/new' ? (
            <button type="button" style={payPrimary} onClick={() => navigate('/pay/journal/new')}>New entry</button>
          ) : null}
        </>
      )}
      metrics={[
        { label: 'Entries', value: entries.data ? String(posted.length) : '…', detail: 'Newest 200 are listed' },
        { label: 'Manual', value: entries.data ? String(manualCount) : '…', detail: 'Written on this page' },
        { label: 'Closed through', value: lock.data?.lockedThrough || 'Open', detail: lock.data?.lockedThrough ? 'Earlier dates are rejected' : 'No period is locked' },
      ]}
    >
      {loading ? <p style={payBody}>Loading the journal.</p> : null}
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{glMessage(error)}</p> : null}
      {!loading && !error && (creating || selected) ? (
        <JournalForm
          treasuryGroupId={treasuryGroupId}
          wallet={wallet}
          accounts={accounts.data ?? []}
          entry={creating ? null : selected}
          lockedThrough={lock.data?.lockedThrough ?? null}
          onDone={(id) => navigate(id ? `/pay/journal/${id}` : '/pay/journal')}
        />
      ) : null}
      {!loading && !error && !creating ? (
        <JournalList entries={entries.data ?? []} onOpen={(id) => navigate(`/pay/journal/${id}`)} />
      ) : null}
    </PayPage>
  );
}

function JournalList({ entries, onOpen }: { entries: GlJournalEntry[]; onOpen: (id: string) => void }) {
  const rows = [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 200);
  return (
    <div style={{ ...payCard, overflowX: 'auto', marginTop: '16px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
        <thead>
          <tr style={{ color: '#6B7280', textAlign: 'left' }}>
            <th style={th}>Date</th>
            <th style={th}>Source</th>
            <th style={th}>Memo</th>
            <th style={{ ...th, textAlign: 'right' }}>Debit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => {
            const debit = entry.lines.reduce((sum, line) => sum + line.debitCents, 0);
            return (
              <tr key={entry.id} style={{ borderTop: '1px solid #E7E2D6', cursor: 'pointer' }} onClick={() => onOpen(entry.id)}>
                <td style={td}>{entry.date}</td>
                <td style={td}>{entry.sourceType}</td>
                <td style={td}>{entry.memo || entry.party || entry.ref}</td>
                <td style={{ ...td, textAlign: 'right' }}>{formatCents(debit)}</td>
              </tr>
            );
          })}
          {rows.length === 0 ? <tr><td colSpan={4} style={td}>No journal entries yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

function JournalForm({
  treasuryGroupId, wallet, accounts, entry, lockedThrough, onDone,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  accounts: Awaited<ReturnType<typeof fetchGlAccounts>>;
  entry: GlJournalEntry | null;
  lockedThrough: string | null;
  onDone: (id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const manual = !entry || entry.sourceType === 'manual';
  const activeAccounts = accounts.filter((account) => !account.archived || entry?.lines.some((line) => line.accountId === account.id));
  const [date, setDate] = useState(entry?.date ?? localToday());
  const [memo, setMemo] = useState(entry?.memo ?? '');
  const [ref, setRef] = useState(entry?.ref ?? '');
  const [lines, setLines] = useState<DraftLine[]>(() => entry && entry.lines.length > 0
    ? entry.lines.map((line) => ({
      accountId: line.accountId,
      debit: line.debitCents ? centsToInput(line.debitCents) : '',
      credit: line.creditCents ? centsToInput(line.creditCents) : '',
      memo: line.memo,
    }))
    : [{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const line of lines) {
      try {
        debit += line.debit.trim() ? moneyIn(line.debit, 'Debit') : 0;
        credit += line.credit.trim() ? moneyIn(line.credit, 'Credit') : 0;
      } catch {
        return null;
      }
    }
    return { debit, credit };
  }, [lines]);

  if (!manual && entry) {
    return (
      <div style={payCard}>
        <p style={payBody}>This {entry.sourceType.replaceAll('_', ' ')} entry comes from its source document. Change that document, not the journal line.</p>
        {entry.lines.map((line) => (
          <div key={line.lineNo} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', fontSize: '14px' }}>
            <span>{line.code} {line.name}</span>
            <span>{line.debitCents ? formatCents(line.debitCents) : formatCents(line.creditCents)}</span>
          </div>
        ))}
      </div>
    );
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const parsed = lines.map((line) => ({
        accountId: line.accountId,
        debitCents: line.debit.trim() ? moneyIn(line.debit, 'Debit') : 0,
        creditCents: line.credit.trim() ? moneyIn(line.credit, 'Credit') : 0,
        memo: line.memo,
        archived: accounts.find((account) => account.id === line.accountId)?.archived ?? false,
      }));
      const draft = validateManualJournal({ date, memo, ref, lockedThrough, lines: parsed });
      const id = await postManualJournal(treasuryGroupId, wallet, {
        id: entry?.id,
        date: draft.date,
        memo: draft.memo,
        ref: draft.ref,
        lines: draft.lines.map((line) => ({
          accountId: line.accountId,
          debit: centsToInput(line.debitCents),
          credit: centsToInput(line.creditCents),
          memo: line.memo,
        })),
      });
      await queryClient.invalidateQueries({ queryKey: ['payGlEntries', treasuryGroupId] });
      await queryClient.invalidateQueries({ queryKey: ['payAudit', treasuryGroupId] });
      onDone(id);
    } catch (err) {
      setError(glMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!entry) return;
    if (!window.confirm('Delete this journal entry?')) return;
    setError(null);
    setSaving(true);
    try {
      await deleteManualJournal(wallet, entry.id);
      await queryClient.invalidateQueries({ queryKey: ['payGlEntries', treasuryGroupId] });
      await queryClient.invalidateQueries({ queryKey: ['payAudit', treasuryGroupId] });
      onDone(null);
    } catch (err) {
      setError(glMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={payCard}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <label style={field}>Date <input style={payInput} type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label style={field}>Memo <input style={payInput} value={memo} onChange={(event) => setMemo(event.target.value)} /></label>
        <label style={field}>Ref <input style={payInput} value={ref} onChange={(event) => setRef(event.target.value)} /></label>
      </div>
      <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {lines.map((line, index) => (
          <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) 1fr 1fr 1fr auto', gap: '8px' }}>
            <select
              style={payInput}
              value={line.accountId}
              onChange={(event) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, accountId: event.target.value } : item))}
            >
              <option value="">Account</option>
              {activeAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.code} {account.name}</option>
              ))}
            </select>
            <input style={payInput} inputMode="decimal" placeholder="Debit" value={line.debit} onChange={(event) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, debit: event.target.value } : item))} />
            <input style={payInput} inputMode="decimal" placeholder="Credit" value={line.credit} onChange={(event) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, credit: event.target.value } : item))} />
            <input style={payInput} placeholder="Line memo" value={line.memo} onChange={(event) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, memo: event.target.value } : item))} />
            <button type="button" style={paySecondary} onClick={() => setLines((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '12px', flexWrap: 'wrap' }}>
        <button type="button" style={paySecondary} onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}>Add line</button>
        <span style={{ fontSize: '14px', color: '#111827' }}>
          {totals ? `Debit ${formatCents(totals.debit)} · Credit ${formatCents(totals.credit)}` : 'Check the amounts.'}
        </span>
      </div>
      {error ? <p style={{ ...payBody, color: '#B42318', marginTop: '12px' }}>{error}</p> : null}
      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        <button type="button" style={payPrimary} disabled={saving} onClick={() => void save()}>{saving ? 'Posting…' : 'Post entry'}</button>
        {entry ? <button type="button" style={payDanger} disabled={saving} onClick={() => void remove()}>Delete</button> : null}
        <button type="button" style={paySecondary} onClick={() => onDone(entry?.id ?? null)}>Back</button>
      </div>
    </div>
  );
}

const th = { padding: '8px 8px 8px 0', fontWeight: 600 };
const td = { padding: '10px 8px 10px 0', color: '#111827' };
const field = { display: 'flex', flexDirection: 'column' as const, gap: '6px', fontSize: '13px', color: '#374151' };
