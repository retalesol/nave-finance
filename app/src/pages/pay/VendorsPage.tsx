import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import {
  deletePayVendor,
  fetchPayBills,
  fetchPayCashEntries,
  fetchPayVendor,
  fetchPayVendors,
  payablesMessage,
  savePayVendor,
  type PayVendor,
} from '../../lib/pay/payablesApi';
import { vendorYearCashCents, type VendorCashPayment } from '../../lib/pay/payables';
import { formatCents, localToday } from '../../lib/pay/invoiceMath';
import { PayLedger, PayPage, PayStage, PayStart, payTd, payTh } from './PayDesk';
import { payBody, payCard, payDanger, payField, payInput, payPrimary, paySecondary, payTitle } from './payStyles';

function pathId(pathname: string): string | null {
  const match = pathname.match(/^\/pay\/vendors\/([^/]+)$/);
  if (!match || match[1] === 'new') return null;
  return match[1];
}

export default function VendorsPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const membership = useDaoMembership();
  const path = location.pathname.replace(/\/+$/, '');
  const editingId = pathId(path);
  const creating = path === '/pay/vendors/new';
  const wallet = membership.walletStr;
  const year = Number(localToday().slice(0, 4));

  const vendors = useQuery({
    queryKey: ['payVendors', treasuryGroupId],
    queryFn: () => fetchPayVendors(treasuryGroupId, wallet),
  });
  const bills = useQuery({
    queryKey: ['payBills', treasuryGroupId],
    queryFn: () => fetchPayBills(treasuryGroupId, wallet),
  });
  const cash = useQuery({
    queryKey: ['payCashEntries', treasuryGroupId],
    queryFn: () => fetchPayCashEntries(treasuryGroupId, wallet),
  });

  if (creating || editingId) {
    return (
      <VendorForm
        treasuryGroupId={treasuryGroupId}
        wallet={wallet}
        vendorId={editingId}
        onDone={(id) => navigate(`/pay/vendors/${id}`)}
        onClose={() => navigate('/pay/vendors')}
      />
    );
  }

  const payments: VendorCashPayment[] = [
    ...(bills.data ?? []).flatMap((bill) => (bill.payments ?? []).map((payment) => ({
      vendorId: bill.vendor_id,
      amountCents: payment.amount_cents,
      method: payment.method,
      date: payment.paid_on,
    }))),
    ...(cash.data ?? []).filter((entry) => entry.direction === 'out' && entry.vendor_id).map((entry) => ({
      vendorId: entry.vendor_id as string,
      amountCents: entry.amount_cents,
      method: entry.method,
      date: entry.entry_date,
    })),
  ];
  const rows = (vendors.data ?? []).filter((row) => !row.archived);
  const paidByVendor = rows.map((row) => ({ row, paid: vendorYearCashCents(payments, row.id, year) }));
  const yearPaid = paidByVendor.reduce((sum, item) => sum + item.paid, 0);
  const form1099 = rows.filter((row) => row.is_1099).length;

  return (
    <PayPage
      kicker="Pay"
      title="Vendors"
      purpose={`People and companies this treasury pays. ${year} totals are cash paid, excluding card and payment-app methods.`}
      actions={<button type="button" style={payPrimary} onClick={() => navigate('/pay/vendors/new')}>New vendor</button>}
      metrics={[
        { label: 'Vendors', value: String(rows.length), detail: 'Active' },
        { label: `${year} paid`, value: formatCents(yearPaid), detail: 'Cash methods only' },
        { label: '1099', value: String(form1099), detail: 'Marked for a form' },
      ]}
    >
      {vendors.isLoading ? <p style={payBody}>Loading vendors.</p> : null}
      {vendors.isError ? <p style={{ ...payBody, color: '#B42318' }}>{payablesMessage(vendors.error)}</p> : null}
      {!vendors.isLoading && rows.length === 0 ? (
        <PayStage>
          <PayStart
            title="No vendors yet"
            detail="A vendor is who a bill is paid to. Add them before you record what the treasury owes."
            steps={['Name and payment address are the useful parts.', 'Mark 1099 vendors so year-end cash totals stay with the right form.', 'Open a bill when an invoice arrives.']}
            actionLabel="New vendor"
            onAction={() => navigate('/pay/vendors/new')}
          />
        </PayStage>
      ) : !vendors.isLoading ? (
        <PayStage title="Directory" detail="Click a vendor to edit how they are paid.">
          <PayLedger>
            <thead>
              <tr>
                <th style={payTh}>Name</th>
                <th style={payTh}>Email</th>
                <th style={payTh}>Form</th>
                <th style={{ ...payTh, textAlign: 'right' }}>{year} cash</th>
              </tr>
            </thead>
            <tbody>
              {paidByVendor.map(({ row, paid }) => (
                <tr key={row.id} onClick={() => navigate(`/pay/vendors/${row.id}`)} style={{ cursor: 'pointer' }}>
                  <td style={{ ...payTd, fontWeight: 600 }}>{row.name}</td>
                  <td style={payTd}>{row.email || '—'}</td>
                  <td style={payTd}>{row.is_1099 ? `1099-${row.form_1099 || 'NEC'}` : '—'}</td>
                  <td style={{ ...payTd, textAlign: 'right' }}>{paid > 0 ? formatCents(paid) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </PayLedger>
        </PayStage>
      ) : null}
    </PayPage>
  );
}

function VendorForm({
  treasuryGroupId,
  wallet,
  vendorId,
  onDone,
  onClose,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  vendorId: string | null;
  onDone: (id: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const existing = useQuery({
    queryKey: ['payVendor', treasuryGroupId, vendorId],
    enabled: !!vendorId,
    queryFn: () => fetchPayVendor(vendorId as string, wallet),
  });

  if (vendorId && existing.isLoading) return <p style={payBody}>Loading vendor.</p>;
  if (vendorId && !existing.data) return <p style={payBody}>That vendor is not in this treasury’s books.</p>;

  return (
    <VendorFields
      key={existing.data?.id ?? 'new'}
      treasuryGroupId={treasuryGroupId}
      wallet={wallet}
      existing={existing.data ?? null}
      onSaved={async (id) => {
        await queryClient.invalidateQueries({ queryKey: ['payVendors', treasuryGroupId] });
        await queryClient.invalidateQueries({ queryKey: ['payVendor', treasuryGroupId, id] });
        onDone(id);
      }}
      onClose={onClose}
    />
  );
}

function VendorFields({
  treasuryGroupId,
  wallet,
  existing,
  onSaved,
  onClose,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  existing: PayVendor | null;
  onSaved: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [contact, setContact] = useState(existing?.contact ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [address, setAddress] = useState(existing?.address ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [paymentAddress, setPaymentAddress] = useState(existing?.payment_address ?? '');
  const [is1099, setIs1099] = useState(existing?.is_1099 ?? false);
  const [form1099, setForm1099] = useState(existing?.form_1099 || 'NEC');
  const [legalName, setLegalName] = useState(existing?.legal_name ?? '');
  const [tinType, setTinType] = useState(existing?.tin_type ?? '');
  const [taxId, setTaxId] = useState(existing?.tax_id ?? '');
  const [w9, setW9] = useState(existing?.w9_on_file ?? false);
  const [w9Date, setW9Date] = useState(existing?.w9_date ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const body = {
    id: existing?.id,
    name,
    email,
    contact,
    phone,
    address,
    notes,
    payment_address: paymentAddress,
    is_1099: is1099,
    form_1099: form1099,
    legal_name: legalName,
    tin_type: tinType,
    tax_id: taxId,
    w9_on_file: w9,
    w9_date: w9Date,
    archived: existing?.archived ?? false,
  };

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1 style={payTitle}>{existing ? existing.name : 'New vendor'}</h1>
      <form
        style={{ ...payCard, display: 'grid', gap: '12px', maxWidth: '640px' }}
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          void savePayVendor(treasuryGroupId, wallet, body)
            .then(onSaved)
            .catch((err: unknown) => setError(payablesMessage(err)))
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
        <label style={payField}>Payment address
          <input style={payInput} value={paymentAddress} onChange={(event) => setPaymentAddress(event.target.value)} placeholder="Wallet for a treasury payment proposal" />
        </label>
        <p style={{ ...payBody, margin: 0 }}>
          A treasury bill payment opens a governance proposal to this address. Nave Pay does not send the funds.
        </p>
        <label style={{ ...payField, flexDirection: 'row', alignItems: 'center' }}>
          <input type="checkbox" checked={is1099} onChange={(event) => setIs1099(event.target.checked)} />
          Issue a 1099 to this vendor
        </label>
        <label style={payField}>Form
          <select style={payInput} value={form1099} onChange={(event) => setForm1099(event.target.value)}>
            <option value="NEC">1099-NEC (services)</option>
            <option value="MISC">1099-MISC (rent, other)</option>
          </select>
        </label>
        <label style={payField}>Legal name on the W-9
          <input style={payInput} value={legalName} onChange={(event) => setLegalName(event.target.value)} />
        </label>
        <label style={payField}>TIN type
          <select style={payInput} value={tinType} onChange={(event) => setTinType(event.target.value)}>
            <option value="">—</option>
            <option value="EIN">EIN</option>
            <option value="SSN">SSN</option>
            <option value="ITIN">ITIN</option>
          </select>
        </label>
        <label style={payField}>Tax ID
          <input style={payInput} value={taxId} autoComplete="off" spellCheck={false} onChange={(event) => setTaxId(event.target.value)} />
        </label>
        <label style={{ ...payField, flexDirection: 'row', alignItems: 'center' }}>
          <input type="checkbox" checked={w9} onChange={(event) => setW9(event.target.checked)} />
          W-9 on file
        </label>
        <label style={payField}>W-9 received
          <input style={payInput} type="date" value={w9Date ?? ''} onChange={(event) => setW9Date(event.target.value)} />
        </label>
        <label style={payField}>Notes
          <textarea style={{ ...payInput, minHeight: '72px' }} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button type="submit" style={payPrimary} disabled={saving}>{saving ? 'Saving…' : 'Save vendor'}</button>
          {existing ? (
            <button
              type="button"
              style={paySecondary}
              onClick={() => {
                setSaving(true);
                setError(null);
                void savePayVendor(treasuryGroupId, wallet, { id: existing.id, archived: !existing.archived })
                  .then(async () => {
                    await queryClient.invalidateQueries({ queryKey: ['payVendors', treasuryGroupId] });
                    onClose();
                  })
                  .catch((err: unknown) => setError(payablesMessage(err)))
                  .finally(() => setSaving(false));
              }}
            >
              {existing.archived ? 'Restore' : 'Archive'}
            </button>
          ) : null}
          {existing ? (
            <button
              type="button"
              style={payDanger}
              onClick={() => {
                setSaving(true);
                setError(null);
                void deletePayVendor(existing.id, wallet)
                  .then(async () => {
                    await queryClient.invalidateQueries({ queryKey: ['payVendors', treasuryGroupId] });
                    onClose();
                  })
                  .catch((err: unknown) => setError(payablesMessage(err)))
                  .finally(() => setSaving(false));
              }}
            >
              Delete
            </button>
          ) : null}
          <button type="button" style={paySecondary} onClick={onClose}>Back</button>
        </div>
      </form>
    </div>
  );
}
