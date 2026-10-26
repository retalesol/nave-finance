import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { formatCents, localToday } from '../../lib/pay/invoiceMath';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, PAYMENT_METHODS, centsToInput } from '../../lib/pay/payables';
import {
  deletePayCashEntry,
  fetchPayCashEntries,
  fetchPayChart,
  fetchPayVendors,
  payablesMessage,
  savePayCashEntry,
  type PayCashEntry,
  type PayChartAccount,
} from '../../lib/pay/payablesApi';
import { PayLedger, PayPage, PayStage, PayStart, payTd, payTh } from './PayDesk';
import { payBody, payCard, payDanger, payField, payInput, payPrimary, paySecondary, payTitle } from './payStyles';

const CASH_SUBTYPES = new Set(['bank', 'cash', 'credit_card', 'digital_asset']);

function entryId(pathname: string): string | null {
  const match = pathname.match(/^\/pay\/transactions\/([^/]+)$/);
  if (!match || match[1] === 'new') return null;
  return match[1];
}

export default function TransactionsPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const membership = useDaoMembership();
  const path = location.pathname.replace(/\/+$/, '');
  const creating = path === '/pay/transactions/new';
  const editingId = entryId(path);
  const wallet = membership.walletStr;
  const entries = useQuery({
    queryKey: ['payCashEntries', treasuryGroupId],
    queryFn: () => fetchPayCashEntries(treasuryGroupId, wallet),
  });
  const vendors = useQuery({
    queryKey: ['payVendors', treasuryGroupId],
    queryFn: () => fetchPayVendors(treasuryGroupId, wallet),
  });
  const chart = useQuery({
    queryKey: ['payChart', treasuryGroupId],
    queryFn: () => fetchPayChart(treasuryGroupId, wallet),
  });

  if (creating || editingId) {
    const existing = entries.data?.find((row) => row.id === editingId) ?? null;
    if (editingId && !entries.isSuccess) return <p style={payBody}>Loading entry.</p>;
    if (editingId && !existing) return <p style={payBody}>That entry is not in this treasury’s books.</p>;
    const direction = existing?.direction ?? (params.get('direction') === 'out' ? 'out' : 'in');
    return (
      <CashForm
        key={existing?.id ?? direction}
        treasuryGroupId={treasuryGroupId}
        wallet={wallet}
        existing={existing}
        direction={direction}
        vendors={vendors.data ?? []}
        chart={chart.data ?? []}
        onClose={() => navigate('/pay/transactions')}
      />
    );
  }

  const rows = entries.data ?? [];
  const moneyIn = rows.filter((row) => row.direction === 'in').reduce((sum, row) => sum + row.amount_cents, 0);
  const moneyOut = rows.filter((row) => row.direction === 'out').reduce((sum, row) => sum + row.amount_cents, 0);

  return (
    <PayPage
      kicker="Record"
      title="Deposits & expenses"
      purpose="Money in or out that is not an invoice payment or a bill payment."
      actions={(
        <>
          <button type="button" style={paySecondary} onClick={() => navigate('/pay/transactions/new?direction=out')}>Expense</button>
          <button type="button" style={payPrimary} onClick={() => navigate('/pay/transactions/new?direction=in')}>Deposit</button>
        </>
      )}
      metrics={[
        { label: 'In', value: formatCents(moneyIn), detail: 'Deposits', tone: moneyIn > 0 ? 'good' : 'default' },
        { label: 'Out', value: formatCents(moneyOut), detail: 'Expenses', tone: moneyOut > 0 ? 'attention' : 'default' },
        { label: 'Net', value: formatCents(moneyIn - moneyOut), detail: `${rows.length} entries` },
      ]}
    >
      {entries.isLoading ? <p style={payBody}>Loading entries.</p> : null}
      {entries.isError ? <p style={{ ...payBody, color: '#B42318' }}>{payablesMessage(entries.error)}</p> : null}
      {!entries.isLoading && rows.length === 0 ? (
        <PayStage>
          <PayStart
            title="No deposits or expenses"
            detail="Use this when money moves and there is no invoice or bill to hang it on."
            steps={['A deposit is a grant, refund, or other income.', 'An expense is a cost paid without a vendor bill.', 'Both post to the cash ledger and the journal.']}
            actionLabel="New deposit"
            onAction={() => navigate('/pay/transactions/new?direction=in')}
          />
        </PayStage>
      ) : !entries.isLoading ? (
        <PayStage title="Entries" detail="Newest stay in the order they were loaded.">
          <PayLedger>
            <thead>
              <tr>
                <th style={payTh}>Date</th>
                <th style={payTh}>Type</th>
                <th style={payTh}>Who</th>
                <th style={payTh}>Category</th>
                <th style={{ ...payTh, textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onClick={() => navigate(`/pay/transactions/${row.id}`)} style={{ cursor: 'pointer' }}>
                  <td style={payTd}>{row.entry_date}</td>
                  <td style={{ ...payTd, fontWeight: 600 }}>{row.direction === 'in' ? 'Deposit' : 'Expense'}</td>
                  <td style={payTd}>{row.vendor?.name || row.counterparty || row.memo || '—'}</td>
                  <td style={payTd}>{row.category || 'Uncategorized'}</td>
                  <td style={{ ...payTd, textAlign: 'right', color: row.direction === 'in' ? '#166534' : '#B42318', fontWeight: 600 }}>
                    {row.direction === 'out' ? '−' : ''}{formatCents(row.amount_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </PayLedger>
        </PayStage>
      ) : null}
    </PayPage>
  );
}

function CashForm({
  treasuryGroupId,
  wallet,
  existing,
  direction,
  vendors,
  chart,
  onClose,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  existing: PayCashEntry | null;
  direction: 'in' | 'out';
  vendors: { id: string; name: string; archived: boolean; is_1099: boolean }[];
  chart: PayChartAccount[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [dir, setDir] = useState<'in' | 'out'>(existing?.direction ?? direction);
  const [date, setDate] = useState(existing?.entry_date ?? localToday());
  const [amount, setAmount] = useState(existing ? centsToInput(existing.amount_cents) : '');
  const [category, setCategory] = useState(existing?.category ?? '');
  const [counterparty, setCounterparty] = useState(existing?.counterparty ?? '');
  const [method, setMethod] = useState(existing?.method || 'ACH');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [vendorId, setVendorId] = useState(existing?.vendor_id ?? '');
  const [cashAccount, setCashAccount] = useState(existing?.cash_account_id ?? '');
  const [accountId, setAccountId] = useState(existing?.account_id ?? '');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const categories = useMemo(
    () => [...new Set([...(dir === 'in' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES), category].filter(Boolean))],
    [dir, category],
  );
  const cashAccounts = chart.filter((account) => (account.account_type === 'asset' || account.account_type === 'liability') && CASH_SUBTYPES.has(account.subtype));
  const glAccounts = chart.filter((account) => ['income', 'expense', 'asset', 'liability', 'equity'].includes(account.account_type));
  const vendorChoices = vendors.filter((vendor) => !vendor.archived || vendor.id === vendorId);

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1 style={payTitle}>{existing ? 'Edit entry' : dir === 'in' ? 'New deposit' : 'New expense'}</h1>
      <form
        style={{ ...payCard, display: 'grid', gap: '12px', maxWidth: '640px' }}
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          void savePayCashEntry(treasuryGroupId, wallet, {
            id: existing?.id,
            direction: dir,
            date,
            amount,
            category,
            counterparty,
            method,
            reference,
            vendor_id: vendorId,
            cash_account_id: cashAccount,
            account_id: accountId,
            memo,
          }).then(async () => {
            await queryClient.invalidateQueries({ queryKey: ['payCashEntries', treasuryGroupId] });
            onClose();
          }).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setSaving(false));
        }}
      >
        <label style={payField}>Type
          <select style={payInput} value={dir} onChange={(event) => { setDir(event.target.value === 'out' ? 'out' : 'in'); setCategory(''); }}>
            <option value="in">Deposit (money in)</option>
            <option value="out">Expense (money out)</option>
          </select>
        </label>
        <label style={payField}>Date
          <input style={payInput} type="date" value={date} required onChange={(event) => setDate(event.target.value)} />
        </label>
        <label style={payField}>Amount
          <input style={payInput} value={amount} required placeholder="0.00" onChange={(event) => setAmount(event.target.value)} />
        </label>
        <label style={payField}>Category
          <select style={payInput} value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">—</option>
            {categories.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label style={payField}>Counterparty
          <input style={payInput} value={counterparty} onChange={(event) => setCounterparty(event.target.value)} />
        </label>
        <label style={payField}>Method
          <select style={payInput} value={method} onChange={(event) => setMethod(event.target.value)}>
            {PAYMENT_METHODS.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label style={payField}>Reference
          <input style={payInput} value={reference} onChange={(event) => setReference(event.target.value)} />
        </label>
        <label style={payField}>Vendor
          <select style={payInput} value={vendorId ?? ''} onChange={(event) => setVendorId(event.target.value)}>
            <option value="">—</option>
            {vendorChoices.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}{vendor.is_1099 ? ' · 1099' : ''}</option>)}
          </select>
        </label>
        <label style={payField}>Cash account
          <select style={payInput} value={cashAccount ?? ''} onChange={(event) => setCashAccount(event.target.value)}>
            <option value="">Automatic (by method)</option>
            {cashAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
          </select>
        </label>
        <label style={payField}>Income or expense override
          <select style={payInput} value={accountId ?? ''} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">From category</option>
            {glAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
          </select>
        </label>
        <label style={payField}>Memo
          <textarea style={{ ...payInput, minHeight: '72px' }} value={memo} onChange={(event) => setMemo(event.target.value)} />
        </label>
        {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button type="submit" style={payPrimary} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          {existing ? (
            <button type="button" style={payDanger} onClick={() => {
              setSaving(true);
              void deletePayCashEntry(existing.id, wallet).then(async () => {
                await queryClient.invalidateQueries({ queryKey: ['payCashEntries', treasuryGroupId] });
                onClose();
              }).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setSaving(false));
            }}>Delete</button>
          ) : null}
          <button type="button" style={paySecondary} onClick={onClose}>Back</button>
        </div>
      </form>
    </div>
  );
}
