import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import NaveEmptyState from '../../components/NaveEmptyState';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import {
  fetchPayCustomers,
  payBooksMessage,
  savePayCustomer,
  type PayCustomer,
} from '../../lib/pay/booksApi';
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

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-end' }}>
        <h1 style={payTitle}>Customers</h1>
        <button type="button" style={payPrimary} onClick={() => navigate('/pay/customers/new')}>New customer</button>
      </div>
      <p style={{ ...payBody, margin: '0 0 20px' }}>People and companies this treasury invoices.</p>
      {customers.isLoading ? <p style={payBody}>Loading customers.</p> : null}
      {customers.isError ? <p style={{ ...payBody, color: '#B42318' }}>{payBooksMessage(customers.error)}</p> : null}
      {!customers.isLoading && rows.length === 0 ? (
        <NaveEmptyState
          icon="users"
          title="No customers yet"
          description="Add a customer before you create an invoice."
          action={{ label: 'New customer', onClick: () => navigate('/pay/customers/new') }}
        />
      ) : (
        <div style={payCard}>
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => navigate(`/pay/customers/${row.id}`)}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                width: '100%',
                textAlign: 'left',
                gap: '12px',
                padding: '12px 0',
                border: 0,
                borderTop: '1px solid #EFEAE0',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <span style={{ color: '#111827', fontWeight: 600 }}>{row.name}</span>
              <span style={{ color: '#6B7280', fontSize: '13px' }}>{row.email || 'No email'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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
