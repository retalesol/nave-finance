import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import type { PayBooksSnapshot } from '../../lib/pay/api';
import {
  fetchPayCustomers,
  fetchPayInvoice,
  fetchPayInvoices,
  payBooksMessage,
  type PayInvoice,
} from '../../lib/pay/booksApi';
import { formatCents, invoiceState, localToday } from '../../lib/pay/invoiceMath';
import InvoiceDetail from './InvoiceDetail';
import InvoiceForm from './InvoiceForm';
import { PayChips, PayLedger, PayPage, PayStage, PayStart, PayStatus, payTd, payTh } from './PayDesk';
import { payBody, payPrimary } from './payStyles';

function paidCents(invoice: PayInvoice): number {
  return (invoice.payments ?? []).reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
}

export default function InvoicesPage({
  treasuryGroupId,
  snapshot,
}: {
  treasuryGroupId: string;
  snapshot: PayBooksSnapshot;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const membership = useDaoMembership();
  const path = location.pathname.replace(/\/+$/, '');
  const wallet = membership.walletStr;
  const customers = useQuery({
    queryKey: ['payCustomers', treasuryGroupId],
    queryFn: () => fetchPayCustomers(treasuryGroupId, wallet),
  });
  const invoices = useQuery({
    queryKey: ['payInvoices', treasuryGroupId],
    queryFn: () => fetchPayInvoices(treasuryGroupId, wallet),
  });

  const editMatch = path.match(/^\/pay\/invoices\/([^/]+)\/edit$/);
  const detailMatch = path.match(/^\/pay\/invoices\/([^/]+)$/);
  const invoiceId = editMatch?.[1] ?? (detailMatch && detailMatch[1] !== 'new' ? detailMatch[1] : null);
  const invoiceQuery = useQuery({
    queryKey: ['payInvoice', invoiceId],
    enabled: !!invoiceId,
    queryFn: () => fetchPayInvoice(invoiceId as string, wallet),
  });

  if (path === '/pay/invoices/new' || editMatch) {
    if (editMatch && invoiceQuery.isLoading) return <p style={payBody}>Loading invoice.</p>;
    if (editMatch && !invoiceQuery.data) return <p style={payBody}>That invoice is not in this treasury’s books.</p>;
    return (
      <InvoiceForm
        treasuryGroupId={treasuryGroupId}
        wallet={wallet}
        snapshot={snapshot}
        customers={customers.data ?? []}
        existing={editMatch ? invoiceQuery.data ?? null : null}
      />
    );
  }

  if (invoiceId) {
    if (invoiceQuery.isLoading) return <p style={payBody}>Loading invoice.</p>;
    if (!invoiceQuery.data) return <p style={payBody}>That invoice is not in this treasury’s books.</p>;
    return (
      <InvoiceDetail
        treasuryGroupId={treasuryGroupId}
        wallet={wallet}
        snapshot={snapshot}
        invoice={invoiceQuery.data}
      />
    );
  }

  const today = localToday();
  const [filter, setFilter] = useState<InvoiceFilter>('open');
  const prepared = useMemo(() => {
    let openCents = 0;
    let openCount = 0;
    let overdueCents = 0;
    let overdueCount = 0;
    let draftCount = 0;
    let paidCount = 0;
    const rows = (invoices.data ?? []).map((invoice) => {
      const state = invoiceState(
        {
          status: invoice.status,
          totalCents: invoice.total_cents,
          paidCents: paidCents(invoice),
          dueDate: invoice.due_date,
        },
        today,
      );
      if (state.balanceCents > 0) {
        openCents += state.balanceCents;
        openCount += 1;
      }
      if (state.displayStatus === 'overdue') {
        overdueCents += state.balanceCents;
        overdueCount += 1;
      }
      if (state.displayStatus === 'draft') draftCount += 1;
      if (state.displayStatus === 'paid') paidCount += 1;
      return { invoice, state };
    });
    return { rows, openCents, openCount, overdueCents, overdueCount, draftCount, paidCount };
  }, [invoices.data, today]);
  const visible = prepared.rows.filter(({ state }) => {
    if (filter === 'all') return true;
    if (filter === 'open') return state.displayStatus === 'open' || state.displayStatus === 'partial' || state.displayStatus === 'overdue';
    return state.displayStatus === filter;
  });

  return (
    <PayPage
      kicker="Collect"
      title="Invoices"
      purpose="Draft, send a payment link, and watch the balance until USDC lands in this treasury."
      actions={<button type="button" style={payPrimary} onClick={() => navigate('/pay/invoices/new')}>New invoice</button>}
      metrics={[
        { label: 'Open', value: formatCents(prepared.openCents), detail: prepared.openCount === 1 ? '1 invoice' : `${prepared.openCount} invoices` },
        { label: 'Overdue', value: formatCents(prepared.overdueCents), detail: prepared.overdueCount === 1 ? '1 late' : `${prepared.overdueCount} late`, tone: prepared.overdueCount > 0 ? 'attention' : 'default' },
        { label: 'Drafts', value: String(prepared.draftCount), detail: 'Not sent yet' },
        { label: 'Paid', value: String(prepared.paidCount), detail: 'Settled in full', tone: prepared.paidCount > 0 ? 'good' : 'default' },
      ]}
    >
      {invoices.isLoading ? <p style={payBody}>Loading invoices.</p> : null}
      {invoices.isError ? <p style={{ ...payBody, color: '#B42318' }}>{payBooksMessage(invoices.error)}</p> : null}
      {!invoices.isLoading && prepared.rows.length === 0 ? (
        <PayStage>
          <PayStart
            title="No invoices yet"
            detail="An invoice is how this treasury asks to be paid. The customer gets a link. You record the USDC when it arrives."
            steps={['Add the customer, or pick one you already have.', 'Write the lines and save a draft.', 'Mark it sent when it should be paid.']}
            actionLabel="New invoice"
            onAction={() => navigate('/pay/invoices/new')}
          />
        </PayStage>
      ) : !invoices.isLoading ? (
        <PayStage
          title="Receivables"
          detail="Open shows anything still owed, including partial and late."
          toolbar={(
            <PayChips
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'open', label: 'Open' },
                { id: 'overdue', label: 'Overdue' },
                { id: 'draft', label: 'Drafts' },
                { id: 'paid', label: 'Paid' },
                { id: 'all', label: 'All' },
              ]}
            />
          )}
        >
          {visible.length === 0 ? (
            <p style={{ margin: 0, padding: '18px 16px', fontSize: '14px', color: '#6B7280' }}>Nothing in this view.</p>
          ) : (
            <PayLedger>
              <thead>
                <tr>
                  <th style={payTh}>Number</th>
                  <th style={payTh}>Customer</th>
                  <th style={payTh}>Due</th>
                  <th style={payTh}>Status</th>
                  <th style={{ ...payTh, textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ invoice, state }) => (
                  <tr key={invoice.id} onClick={() => navigate(`/pay/invoices/${invoice.id}`)} style={{ cursor: 'pointer' }}>
                    <td style={{ ...payTd, fontWeight: 600 }}>{invoice.number}</td>
                    <td style={payTd}>{invoice.customer?.name || 'Customer'}</td>
                    <td style={payTd}>
                      {invoice.due_date}
                      {state.daysOverdue > 0 ? ` · ${state.daysOverdue}d late` : ''}
                    </td>
                    <td style={payTd}><PayStatus status={state.displayStatus} /></td>
                    <td style={{ ...payTd, textAlign: 'right' }}>
                      {formatCents(state.displayStatus === 'draft' || state.displayStatus === 'void' ? invoice.total_cents : state.balanceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </PayLedger>
          )}
        </PayStage>
      ) : null}
    </PayPage>
  );
}

type InvoiceFilter = 'open' | 'overdue' | 'draft' | 'paid' | 'all';
