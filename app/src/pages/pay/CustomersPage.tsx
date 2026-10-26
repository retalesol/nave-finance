import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import {
  fetchPayCustomers,
  fetchPayInvoices,
  payBooksMessage,
  savePayCustomer,
  type PayCustomer,
} from '../../lib/pay/booksApi';
import { formatCents, invoiceState, localToday } from '../../lib/pay/invoiceMath';
import { PayLedger, PayPage, PayStage, PayStart, payTd, payTh } from './PayDesk';
import { payBody, payCard, payDanger, payField, payInput, payPrimary, paySecondary, payTitle } from './payStyles';

function pathId(pathname: string): string | null {
  const match = pathname.match(/^\/pay\/customers\/([^/]+)$/);
  if (!match || match[1] === 'new') return null;
  return match[1];
}

export default function CustomersPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const membership = useDaoMembership();
  const path = location.pathname.replace(/\/+$/, '');
  const editingId = pathId(path);
  const creating = path === '/pay/customers/new';

  const customers = useQuery({
    queryKey: ['payCustomers', treasuryGroupId],
    queryFn: () => fetchPayCustomers(treasuryGroupId, membership.walletStr),
  });
  const invoices = useQuery({
    queryKey: ['payInvoices', treasuryGroupId],
    queryFn: () => fetchPayInvoices(treasuryGroupId, membership.walletStr),
  });
  const today = localToday();
  const openByCustomer = useMemo(() => {
    const totals = new Map<string, number>();
    for (const invoice of invoices.data ?? []) {
      const paid = (invoice.payments ?? []).reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
      const state = invoiceState(
        { status: invoice.status, totalCents: invoice.total_cents, paidCents: paid, dueDate: invoice.due_date },
        today,
      );
      if (state.balanceCents <= 0) continue;
      totals.set(invoice.customer_id, (totals.get(invoice.customer_id) ?? 0) + state.balanceCents);
    }
    return totals;
  }, [invoices.data, today]);

  if (creating || editingId) {
    const existing = customers.data?.find((row) => row.id === editingId) ?? null;
    if (editingId && !customers.isSuccess) {
      return <p style={payBody}>Loading customer.</p>;
    }
    if (editingId && !existing) {
      return <p style={payBody}>That customer is not in this treasury’s books.</p>;
    }
    return (
      <CustomerForm
        treasuryGroupId={treasuryGroupId}
        wallet={membership.walletStr}
        existing={existing}
        onDone={(id) => navigate(`/pay/customers/${id}`)}
        onClose={() => navigate('/pay/customers')}
      />
    );
  }

  const rows = (customers.data ?? []).filter((row) => !row.archived);
  const withBalance = rows.filter((row) => (openByCustomer.get(row.id) ?? 0) > 0).length;
  const missingEmail = rows.filter((row) => !row.email.trim()).length;

  return (
    <PayPage
      kicker="Collect"
      title="Customers"
      purpose="The people and companies this treasury invoices. Open balance is what they still owe."
      actions={<button type="button" style={payPrimary} onClick={() => navigate('/pay/customers/new')}>New customer</button>}
      metrics={[
        { label: 'Customers', value: String(rows.length), detail: 'Active' },
        { label: 'With a balance', value: String(withBalance), detail: 'Still owe this treasury' },
        { label: 'Missing email', value: String(missingEmail), detail: 'A link needs an address', tone: missingEmail > 0 ? 'attention' : 'default' },
      ]}
    >
      {customers.isLoading ? <p style={payBody}>Loading customers.</p> : null}
      {customers.isError ? <p style={{ ...payBody, color: '#B42318' }}>{payBooksMessage(customers.error)}</p> : null}
      {!customers.isLoading && rows.length === 0 ? (
        <PayStage>
          <PayStart
            title="No customers yet"
            detail="A customer is who the invoice is addressed to. Add them once, then reuse them on every invoice."
            steps={['Name and email are enough to start.', 'The email is where you send the payment link.', 'Open an invoice for them when you are ready to be paid.']}
            actionLabel="New customer"
            onAction={() => navigate('/pay/customers/new')}
          />
        </PayStage>
      ) : !customers.isLoading ? (
        <PayStage title="Directory" detail="Click a customer to edit their details.">
          <PayLedger>
            <thead>
              <tr>
                <th style={payTh}>Name</th>
                <th style={payTh}>Email</th>
                <th style={{ ...payTh, textAlign: 'right' }}>Open balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = openByCustomer.get(row.id) ?? 0;
                return (
                  <tr key={row.id} onClick={() => navigate(`/pay/customers/${row.id}`)} style={{ cursor: 'pointer' }}>
                    <td style={{ ...payTd, fontWeight: 600 }}>{row.name}</td>
                    <td style={payTd}>{row.email || 'No email'}</td>
                    <td style={{ ...payTd, textAlign: 'right' }}>{open > 0 ? formatCents(open) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </PayLedger>
        </PayStage>
      ) : null}
    </PayPage>
  );
}

function CustomerForm({
  treasuryGroupId,
  wallet,
  existing,
  onDone,
  onClose,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  existing: PayCustomer | null;
  onDone: (id: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [contact, setContact] = useState(existing?.contact ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [address, setAddress] = useState(existing?.address ?? '');
  const [taxId, setTaxId] = useState(existing?.tax_id ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1 style={payTitle}>{existing ? existing.name : 'New customer'}</h1>
      <form
        style={{ ...payCard, display: 'grid', gap: '12px', maxWidth: '560px' }}
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          void savePayCustomer(treasuryGroupId, wallet, {
            id: existing?.id,
            name,
            email,
            contact,
            phone,
            address,
            tax_id: taxId,
            notes,
            archived: existing?.archived ?? false,
          })
            .then(async (id) => {
              await queryClient.invalidateQueries({ queryKey: ['payCustomers', treasuryGroupId] });
              onDone(id);
            })
            .catch((err: unknown) => setError(payBooksMessage(err)))
            .finally(() => setSaving(false));
        }}
      >
        <label style={payField}>Name
          <input style={payInput} value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label style={payField}>Email
          <input style={payInput} value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label style={payField}>Contact
          <input style={payInput} value={contact} onChange={(event) => setContact(event.target.value)} />
        </label>
        <label style={payField}>Phone
          <input style={payInput} value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label style={payField}>Address
          <textarea style={{ ...payInput, minHeight: '72px' }} value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <label style={payField}>Tax ID
          <input style={payInput} value={taxId} onChange={(event) => setTaxId(event.target.value)} />
        </label>
        <label style={payField}>Notes
          <textarea style={{ ...payInput, minHeight: '72px' }} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button type="submit" style={payPrimary} disabled={saving}>{saving ? 'Saving…' : 'Save customer'}</button>
          {existing ? (
            <button
              type="button"
              style={payDanger}
              onClick={() => {
                setSaving(true);
                void savePayCustomer(treasuryGroupId, wallet, { ...existing, archived: !existing.archived })
                  .then(async () => {
                    await queryClient.invalidateQueries({ queryKey: ['payCustomers', treasuryGroupId] });
                    onClose();
                  })
                  .catch((err: unknown) => setError(payBooksMessage(err)))
                  .finally(() => setSaving(false));
              }}
            >
              {existing.archived ? 'Restore' : 'Archive'}
            </button>
          ) : null}
          <button type="button" style={paySecondary} onClick={onClose}>Back</button>
        </div>
      </form>
    </div>
  );
}
