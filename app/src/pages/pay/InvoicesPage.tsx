import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import NaveEmptyState from '../../components/NaveEmptyState';
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
import { payBody, payCard, payPrimary, payTitle, statusColor } from './payStyles';

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
  const rows = invoices.data ?? [];

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-end' }}>
        <h1 style={payTitle}>Invoices</h1>
        <button type="button" style={payPrimary} onClick={() => navigate('/pay/invoices/new')}>New invoice</button>
      </div>
      <p style={{ ...payBody, margin: '0 0 20px' }}>Drafts, open balances, and what has been paid into this treasury.</p>
      {invoices.isLoading ? <p style={payBody}>Loading invoices.</p> : null}
      {invoices.isError ? <p style={{ ...payBody, color: '#B42318' }}>{payBooksMessage(invoices.error)}</p> : null}
      {!invoices.isLoading && rows.length === 0 ? (
        <NaveEmptyState
          icon="file-lines"
          title="No invoices yet"
          description="Create a draft, then mark it sent when it should be paid."
          action={{ label: 'New invoice', onClick: () => navigate('/pay/invoices/new') }}
        />
      ) : (
        <div style={payCard}>
          {rows.map((invoice) => {
            const state = invoiceState(
              {
                status: invoice.status,
                totalCents: invoice.total_cents,
                paidCents: paidCents(invoice),
                dueDate: invoice.due_date,
              },
              today,
            );
            return (
              <button
                key={invoice.id}
                type="button"
                onClick={() => navigate(`/pay/invoices/${invoice.id}`)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.1fr 1.4fr 0.8fr 0.8fr',
                  gap: '8px',
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 0',
                  border: 0,
                  borderTop: '1px solid #EFEAE0',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: '13.5px',
                }}
              >
                <span style={{ fontWeight: 600, color: '#111827' }}>{invoice.number}</span>
                <span style={{ color: '#6B7280' }}>{invoice.customer?.name || 'Customer'}</span>
                <span style={{ color: statusColor(state.displayStatus), textTransform: 'capitalize' }}>{state.displayStatus}</span>
                <span style={{ textAlign: 'right', color: '#111827' }}>
                  {formatCents(state.displayStatus === 'draft' || state.displayStatus === 'void' ? invoice.total_cents : state.balanceCents)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
