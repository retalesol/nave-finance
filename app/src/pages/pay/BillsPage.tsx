import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import NaveEmptyState from '../../components/NaveEmptyState';
import { CreateTransactionModal, type PayProposalDraft } from '../../components/TreasuryActions';
import { useChain } from '../../hooks/useChain';
import { useDaoContext } from '../../hooks/useDaoContext';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { useDaoRegistry } from '../../hooks/useDaoRegistry';
import { useTokenRegistry } from '../../hooks/useTokenRegistry';
import { useTreasuryAssets } from '../../hooks/useTreasuryAssets';
import { useTreasuryNfts } from '../../hooks/useTreasuryNfts';
import { formatCents, localToday } from '../../lib/pay/invoiceMath';
import {
  billState,
  billVoidBlocked,
  centsToInput,
  EXPENSE_CATEGORIES,
  inputMatchesCents,
  parseUsdCents,
  PAYMENT_METHODS,
  samePayee,
} from '../../lib/pay/payables';
import {
  confirmPayBillProposal,
  deletePayBill,
  deletePayBillPayment,
  fetchPayBills,
  fetchPayChart,
  fetchPayVendors,
  linkPayBillProposal,
  payablesMessage,
  recordPayBillPayment,
  savePayBill,
  setPayBillStatus,
  type PayBill,
  type PayChartAccount,
} from '../../lib/pay/payablesApi';
import { payBody, payCard, payDanger, payField, payInput, payPrimary, paySecondary, payTitle, statusColor } from './payStyles';

const FILTERS = ['all', 'open', 'partial', 'overdue', 'paid', 'void'] as const;
const CASH_SUBTYPES = new Set(['bank', 'cash', 'credit_card', 'digital_asset']);

function billIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/pay\/bills\/([^/]+)$/);
  if (!match || match[1] === 'new') return null;
  return match[1];
}

export default function BillsPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const membership = useDaoMembership();
  const path = location.pathname.replace(/\/+$/, '');
  const creating = path === '/pay/bills/new';
  const editingId = billIdFromPath(path);
  const wallet = membership.walletStr;

  const bills = useQuery({
    queryKey: ['payBills', treasuryGroupId],
    queryFn: () => fetchPayBills(treasuryGroupId, wallet),
  });
  const vendors = useQuery({
    queryKey: ['payVendors', treasuryGroupId],
    queryFn: () => fetchPayVendors(treasuryGroupId, wallet),
  });
  const chart = useQuery({
    queryKey: ['payChart', treasuryGroupId],
    queryFn: () => fetchPayChart(treasuryGroupId, wallet),
  });

  if (creating) {
    return (
      <BillEditor
        treasuryGroupId={treasuryGroupId}
        wallet={wallet}
        bill={null}
        vendors={vendors.data ?? []}
        chart={chart.data ?? []}
        presetVendorId={params.get('vendor')}
        onDone={(id) => navigate(`/pay/bills/${id}`)}
        onClose={() => navigate('/pay/bills')}
      />
    );
  }

  if (editingId) {
    const bill = bills.data?.find((row) => row.id === editingId) ?? null;
    if (!bills.isSuccess) return <p style={payBody}>Loading bill.</p>;
    if (!bill) return <p style={payBody}>That bill is not in this treasury’s books.</p>;
    return (
      <BillDetail
        key={bill.id}
        treasuryGroupId={treasuryGroupId}
        wallet={wallet}
        bill={bill}
        vendors={vendors.data ?? []}
        chart={chart.data ?? []}
        onClose={() => navigate('/pay/bills')}
      />
    );
  }

  return (
    <BillList
      loading={bills.isLoading}
      error={bills.error}
      bills={bills.data ?? []}
      onNew={() => navigate('/pay/bills/new')}
      onOpen={(id) => navigate(`/pay/bills/${id}`)}
    />
  );
}

function BillList({
  loading,
  error,
  bills,
  onNew,
  onOpen,
}: {
  loading: boolean;
  error: unknown;
  bills: PayBill[];
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const today = localToday();
  const rows = bills.filter((bill) => {
    if (filter === 'all') return true;
    return billState(viewOf(bill), today).displayStatus === filter;
  });

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-end' }}>
        <h1 style={payTitle}>Bills</h1>
        <button type="button" style={payPrimary} onClick={onNew}>New bill</button>
      </div>
      <p style={{ ...payBody, margin: '0 0 16px' }}>Money this treasury owes. Status follows the payments, not a stored paid flag.</p>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {FILTERS.map((item) => (
          <button key={item} type="button" onClick={() => setFilter(item)} style={filter === item ? payPrimary : paySecondary}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      {loading ? <p style={payBody}>Loading bills.</p> : null}
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{payablesMessage(error)}</p> : null}
      {!loading && rows.length === 0 ? (
        <NaveEmptyState icon="receipt" title="No bills here" description="Record a vendor bill to track what the treasury owes." action={{ label: 'New bill', onClick: onNew }} />
      ) : (
        <div style={{ ...payCard, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ color: '#6B7280', textAlign: 'left' }}>
                <th style={th}>Vendor</th>
                <th style={th}>Ref</th>
                <th style={th}>Due</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((bill) => {
                const state = billState(viewOf(bill), today);
                return (
                  <tr key={bill.id} onClick={() => onOpen(bill.id)} style={{ cursor: 'pointer', borderTop: '1px solid #EFEAE0' }}>
                    <td style={td}>{bill.vendor?.name || 'Vendor'}</td>
                    <td style={td}>{bill.ref || '—'}</td>
                    <td style={td}>{bill.due_date}{state.daysOverdue > 0 ? ` · ${state.daysOverdue}d late` : ''}</td>
                    <td style={{ ...td, color: statusColor(state.displayStatus), textTransform: 'capitalize' }}>{state.displayStatus}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{formatCents(state.balanceCents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BillDetail({
  treasuryGroupId,
  wallet,
  bill,
  vendors,
  chart,
  onClose,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  bill: PayBill;
  vendors: { id: string; name: string; archived: boolean; payment_address: string }[];
  chart: PayChartAccount[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { daoAddress } = useDaoContext();
  const dao = useDaoRegistry(daoAddress);
  const { chainKind } = useChain();
  const assets = useTreasuryAssets(daoAddress);
  const nfts = useTreasuryNfts(daoAddress);
  const tokens = useTokenRegistry(daoAddress);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(localToday());
  const [payMethod, setPayMethod] = useState('ACH');
  const [payAccount, setPayAccount] = useState('');
  const [proposing, setProposing] = useState<{ cents: number; recipient: string } | null>(null);
  const today = localToday();
  const paid = (bill.payments ?? []).reduce((sum, payment) => sum + payment.amount_cents, 0);
  const state = billState(viewOf(bill), today);
  const vendor = vendors.find((row) => row.id === bill.vendor_id) ?? null;
  const cashAccounts = chart.filter((account) => (account.account_type === 'asset' || account.account_type === 'liability') && CASH_SUBTYPES.has(account.subtype));
  const blocked = billVoidBlocked(paid);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['payBills', treasuryGroupId] });
    await queryClient.invalidateQueries({ queryKey: ['payCashEntries', treasuryGroupId] });
  }

  const proposalCount = typeof dao.dao?.nextProposalIndex === 'number'
    ? dao.dao.nextProposalIndex
    : (dao.dao?.proposalCount ?? 0) + (dao.dao?.archivedProposalCount ?? 0);

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1 style={payTitle}>{bill.vendor?.name || 'Bill'}</h1>
      <p style={{ ...payBody, marginBottom: '16px' }}>
        {formatCents(bill.amount_cents)} · {bill.ref || 'No reference'} · <span style={{ color: statusColor(state.displayStatus), textTransform: 'capitalize' }}>{state.displayStatus}</span>
        {state.balanceCents > 0 ? ` · ${formatCents(state.balanceCents)} open` : ''}
      </p>
      {bill.status === 'open' ? (
        <BillEditor
          treasuryGroupId={treasuryGroupId}
          wallet={wallet}
          bill={bill}
          vendors={vendors}
          chart={chart}
          presetVendorId={null}
          onDone={async () => { await refresh(); }}
          onClose={onClose}
        />
      ) : (
        <p style={payBody}>This bill is void. Reopen it to edit or pay it.</p>
      )}
      <div style={{ ...payCard, marginTop: '16px' }}>
        <h2 style={sectionTitle}>Payments</h2>
        {(bill.payments ?? []).length === 0 ? <p style={payBody}>No payments yet.</p> : (bill.payments ?? []).map((payment) => (
          <div key={payment.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderTop: '1px solid #EFEAE0' }}>
            <span>{payment.paid_on} · {payment.method || 'Payment'} {payment.reference ? `· ${payment.reference}` : ''}</span>
            <span>
              {formatCents(payment.amount_cents)}
              <button type="button" style={{ ...payDanger, marginLeft: '8px', padding: '4px 8px' }} onClick={() => {
                setBusy(true);
                void deletePayBillPayment(payment.id, wallet).then(refresh).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setBusy(false));
              }}>Remove</button>
            </span>
          </div>
        ))}
        {state.balanceCents > 0 ? (
          <form
            style={{ display: 'grid', gap: '10px', marginTop: '14px' }}
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              void recordPayBillPayment(bill.id, wallet, {
                date: payDate,
                amount: payAmount || centsToInput(state.balanceCents),
                method: payMethod,
                cash_account_id: payAccount,
                reference: '',
                notes: '',
              }).then(async () => {
                setPayAmount('');
                await refresh();
              }).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setBusy(false));
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
              <label style={payField}>Date
                <input style={payInput} type="date" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
              </label>
              <label style={payField}>Amount
                <input style={payInput} value={payAmount} placeholder={centsToInput(state.balanceCents)} onChange={(event) => setPayAmount(event.target.value)} />
              </label>
              <label style={payField}>Method
                <select style={payInput} value={payMethod} onChange={(event) => setPayMethod(event.target.value)}>
                  {PAYMENT_METHODS.map((method) => <option key={method}>{method}</option>)}
                </select>
              </label>
              <label style={payField}>Paid from
                <select style={payInput} value={payAccount} onChange={(event) => setPayAccount(event.target.value)}>
                  <option value="">Automatic</option>
                  {cashAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button type="submit" style={payPrimary} disabled={busy}>Record payment</button>
              <button
                type="button"
                style={paySecondary}
                disabled={busy || !vendor?.payment_address}
                onClick={() => {
                  if (!vendor?.payment_address) return;
                  const amountCents = parseUsdCents(payAmount.trim() || centsToInput(state.balanceCents));
                  if (amountCents == null || amountCents <= 0 || amountCents > state.balanceCents) {
                    setError('Enter an amount up to the open balance.');
                    return;
                  }
                  setError(null);
                  setProposing({ cents: amountCents, recipient: vendor.payment_address });
                }}
              >
                Pay from treasury
              </button>
            </div>
            {!vendor?.payment_address ? <p style={payBody}>Add a payment address on the vendor before proposing a treasury payment.</p> : (
              <p style={payBody}>Pay from treasury opens a governance proposal. It does not move funds. After the proposal executes, record it here.</p>
            )}
          </form>
        ) : null}
        {bill.proposal_index != null && !bill.proposal_payment_id ? (
          <div style={{ marginTop: '12px' }}>
            <p style={payBody}>
              Proposal {bill.proposal_index} is stored for {formatCents(bill.proposal_amount_cents ?? 0)}. When that transfer has executed, record the books entry. This does not send a transaction.
            </p>
            <button type="button" style={{ ...payPrimary, marginTop: '8px' }} disabled={busy} onClick={() => {
              setBusy(true);
              setError(null);
              void confirmPayBillProposal(bill.id, wallet).then(refresh).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setBusy(false));
            }}>Proposal executed — record payment</button>
          </div>
        ) : null}
        {error ? <p style={{ ...payBody, color: '#B42318', marginTop: '10px' }}>{error}</p> : null}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }}>
          {bill.status === 'void' ? (
            <button type="button" style={paySecondary} onClick={() => { setBusy(true); void setPayBillStatus(bill.id, 'open', wallet).then(refresh).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setBusy(false)); }}>Reopen</button>
          ) : (
            <button type="button" style={payDanger} disabled={!!blocked} title={blocked ?? undefined} onClick={() => {
              if (blocked) { setError(blocked); return; }
              setBusy(true);
              void setPayBillStatus(bill.id, 'void', wallet).then(refresh).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setBusy(false));
            }}>Void</button>
          )}
          <button type="button" style={payDanger} disabled={!!blocked} onClick={() => {
            if (blocked) { setError(blocked); return; }
            setBusy(true);
            void deletePayBill(bill.id, wallet).then(async () => { await refresh(); onClose(); }).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setBusy(false));
          }}>Delete</button>
          <button type="button" style={paySecondary} onClick={onClose}>Back</button>
        </div>
      </div>
      {proposing && daoAddress ? (
        <CreateTransactionModal
          daoAddress={daoAddress}
          proposalCount={proposalCount}
          governanceType={dao.dao?.governanceType ?? 'wallet'}
          votingMint={tokens.tokens[0]?.mint ?? null}
          assets={assets.assets}
          nfts={nfts.nfts}
          initialRecipient={proposing.recipient}
          initialAmount={centsToInput(proposing.cents)}
          initialReason={`Pay ${bill.vendor?.name || 'vendor'}`}
          billId={bill.id}
          preferredSymbol="USDC"
          onClose={() => setProposing(null)}
          onCreated={(draft) => {
            void acceptProposal(draft, proposing, bill.id, daoAddress, chainKind, wallet, treasuryGroupId, queryClient)
              .then(() => setProposing(null))
              .catch((err: unknown) => {
                setError(payablesMessage(err));
                setProposing(null);
              });
          }}
        />
      ) : null}
    </div>
  );
}

async function acceptProposal(
  draft: PayProposalDraft | undefined,
  proposing: { cents: number; recipient: string },
  billId: string,
  daoAddress: string,
  chain: string,
  wallet: string | null,
  treasuryGroupId: string,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  if (!draft) return;
  if (!samePayee(draft.recipient, proposing.recipient) || !inputMatchesCents(draft.amount, proposing.cents)) {
    throw new Error('The proposal amount or address was changed, so the books were not updated.');
  }
  await linkPayBillProposal(billId, wallet, {
    dao: daoAddress,
    index: draft.proposalIndex,
    chain,
    amountCents: proposing.cents,
    recipient: draft.recipient,
  });
  await queryClient.invalidateQueries({ queryKey: ['payBills', treasuryGroupId] });
}

function BillEditor({
  treasuryGroupId,
  wallet,
  bill,
  vendors,
  chart,
  presetVendorId,
  onDone,
  onClose,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  bill: PayBill | null;
  vendors: { id: string; name: string; archived: boolean }[];
  chart: PayChartAccount[];
  presetVendorId: string | null;
  onDone: (id: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const choices = vendors.filter((vendor) => !vendor.archived || vendor.id === bill?.vendor_id);
  const expenseAccounts = chart.filter((account) => ['expense', 'asset', 'liability', 'equity'].includes(account.account_type));
  const cashAccounts = chart.filter((account) => (account.account_type === 'asset' || account.account_type === 'liability') && CASH_SUBTYPES.has(account.subtype));
  const [vendorId, setVendorId] = useState(bill?.vendor_id ?? presetVendorId ?? '');
  const [ref, setRef] = useState(bill?.ref ?? '');
  const [amount, setAmount] = useState(bill ? centsToInput(bill.amount_cents) : '');
  const [billDate, setBillDate] = useState(bill?.bill_date ?? localToday());
  const [dueDate, setDueDate] = useState(bill?.due_date ?? '');
  const [category, setCategory] = useState(bill?.category ?? '');
  const [accountId, setAccountId] = useState(bill?.account_id ?? '');
  const [description, setDescription] = useState(bill?.description ?? '');
  const [notes, setNotes] = useState(bill?.notes ?? '');
  const [payNow, setPayNow] = useState(false);
  const [payMethod, setPayMethod] = useState('ACH');
  const [payAccount, setPayAccount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const categories = useMemo(() => [...new Set([...EXPENSE_CATEGORIES, category].filter(Boolean))], [category]);

  return (
    <form
      style={{ ...payCard, display: 'grid', gap: '12px', maxWidth: bill ? '100%' : '720px' }}
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        void savePayBill(treasuryGroupId, wallet, {
          id: bill?.id,
          vendor_id: vendorId,
          ref,
          amount,
          bill_date: billDate,
          due_date: dueDate || billDate,
          category,
          account_id: accountId,
          description,
          notes,
          pay_now: !bill && payNow,
          pay_method: payMethod,
          pay_account_id: payAccount,
        }).then(onDone).catch((err: unknown) => setError(payablesMessage(err))).finally(() => setSaving(false));
      }}
    >
      {!bill ? <h1 style={payTitle}>New bill</h1> : <h2 style={sectionTitle}>Bill details</h2>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <label style={payField}>Vendor
          <select style={payInput} value={vendorId} required onChange={(event) => setVendorId(event.target.value)}>
            <option value="">Select vendor…</option>
            {choices.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
          </select>
        </label>
        <label style={payField}>Vendor invoice / ref
          <input style={payInput} value={ref} onChange={(event) => setRef(event.target.value)} />
        </label>
        <label style={payField}>Amount
          <input style={payInput} value={amount} required placeholder="0.00" onChange={(event) => setAmount(event.target.value)} />
        </label>
        <label style={payField}>Bill date
          <input style={payInput} type="date" value={billDate} required onChange={(event) => setBillDate(event.target.value)} />
        </label>
        <label style={payField}>Due date
          <input style={payInput} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </label>
        <label style={payField}>Category
          <select style={payInput} value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">—</option>
            {categories.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label style={payField}>GL account override
          <select style={payInput} value={accountId ?? ''} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">From category</option>
            {expenseAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
          </select>
        </label>
      </div>
      <label style={payField}>Description
        <input style={payInput} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label style={payField}>Notes
        <textarea style={{ ...payInput, minHeight: '64px' }} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      {!bill ? (
        <>
          <label style={{ ...payField, flexDirection: 'row', alignItems: 'center' }}>
            <input type="checkbox" checked={payNow} onChange={(event) => setPayNow(event.target.checked)} />
            Already paid in full
          </label>
          {payNow ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <label style={payField}>Paid via
                <select style={payInput} value={payMethod} onChange={(event) => setPayMethod(event.target.value)}>
                  {PAYMENT_METHODS.map((method) => <option key={method}>{method}</option>)}
                </select>
              </label>
              <label style={payField}>Paid from
                <select style={payInput} value={payAccount} onChange={(event) => setPayAccount(event.target.value)}>
                  <option value="">Automatic</option>
                  {cashAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
                </select>
              </label>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="submit" style={payPrimary} disabled={saving}>{saving ? 'Saving…' : 'Save bill'}</button>
        {!bill ? <button type="button" style={paySecondary} onClick={onClose}>Back</button> : null}
      </div>
    </form>
  );
}

function viewOf(bill: PayBill) {
  const paid = (bill.payments ?? []).reduce((sum, payment) => sum + payment.amount_cents, 0);
  return { status: bill.status, amountCents: bill.amount_cents, paidCents: paid, dueDate: bill.due_date };
}

const th = { padding: '8px 8px 8px 0', fontWeight: 600 };
const td = { padding: '10px 8px 10px 0', color: '#111827' };
const sectionTitle = { fontSize: '16px', margin: '0 0 8px', color: '#111827' };
