import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { PayBooksSnapshot } from '../../lib/pay/api';
import {
  invoiceAddressesFor,
  payBooksMessage,
  savePayInvoice,
  type PayCustomer,
  type PayInvoice,
} from '../../lib/pay/booksApi';
import {
  addDays,
  computeInvoice,
  formatCents,
  localToday,
  moneyIn,
  randomInvoiceIdHex,
  rateIn,
} from '../../lib/pay/invoiceMath';
import { payBody, payCard, payField, payInput, payPrimary, paySecondary, payTitle } from './payStyles';

interface LineDraft {
  description: string;
  qty: string;
  rate: string;
  taxable: boolean;
}

function emptyLine(): LineDraft {
  return { description: '', qty: '1', rate: '', taxable: false };
}

function qtyText(qtyE4: number): string {
  const neg = qtyE4 < 0;
  const abs = Math.abs(qtyE4);
  const frac = String(abs % 10000).padStart(4, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${Math.trunc(abs / 10000)}${frac ? `.${frac}` : ''}`;
}

function centsText(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function rateText(rateE3: number): string {
  const frac = String(rateE3 % 1000).padStart(3, '0').replace(/0+$/, '');
  return frac ? `${Math.trunc(rateE3 / 1000)}.${frac}` : String(Math.trunc(rateE3 / 1000));
}

export default function InvoiceForm({
  treasuryGroupId,
  wallet,
  snapshot,
  customers,
  existing,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  snapshot: PayBooksSnapshot;
  customers: PayCustomer[];
  existing: PayInvoice | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = localToday();
  const termsDays = snapshot.company?.invoice_terms_days ?? 30;
  const [customerId, setCustomerId] = useState(existing?.customer_id ?? customers.find((row) => !row.archived)?.id ?? '');
  const [issueDate, setIssueDate] = useState(existing?.issue_date ?? today);
  const [dueDate, setDueDate] = useState(existing?.due_date ?? addDays(today, termsDays));
  const [po, setPo] = useState(existing?.po_number ?? '');
  const [taxLabel, setTaxLabel] = useState(existing?.tax_label ?? 'Tax');
  const [taxRate, setTaxRate] = useState(existing ? rateText(existing.tax_rate_e3) : '0');
  const [discount, setDiscount] = useState(existing ? centsText(existing.discount_cents) : '0.00');
  const [notes, setNotes] = useState(existing?.notes ?? snapshot.company?.default_notes ?? '');
  const [terms, setTerms] = useState(existing?.terms ?? snapshot.company?.default_terms ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    existing?.items?.length
      ? existing.items.map((item) => ({
          description: item.description,
          qty: qtyText(item.qty_e4),
          rate: centsText(item.rate_cents),
          taxable: item.taxable,
        }))
      : [emptyLine()],
  );
  const [invoiceIdHex] = useState(existing?.invoice_id_hex ?? randomInvoiceIdHex());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => {
    try {
      return computeInvoice(
        lines.map((line) => ({ ...line })),
        moneyIn(discount, 'Discount'),
        rateIn(taxRate, 'Tax rate'),
      );
    } catch {
      return null;
    }
  }, [lines, discount, taxRate]);

  async function save(markSent: boolean) {
    setSaving(true);
    setError(null);
    try {
      const id = await savePayInvoice(treasuryGroupId, wallet, {
        id: existing?.id,
        customer_id: customerId,
        invoice_id_hex: invoiceIdHex,
        issue_date: issueDate,
        due_date: dueDate,
        po_number: po,
        tax_label: taxLabel,
        tax_rate: taxRate,
        discount,
        notes,
        terms,
        mark_sent: markSent,
        items: lines,
        addresses: invoiceAddressesFor(invoiceIdHex, snapshot.addresses),
      });
      await queryClient.invalidateQueries({ queryKey: ['payInvoices', treasuryGroupId] });
      await queryClient.invalidateQueries({ queryKey: ['payInvoice', id] });
      navigate(`/pay/invoices/${id}`);
    } catch (err) {
      setError(payBooksMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1 style={payTitle}>{existing ? existing.number : 'New invoice'}</h1>
      <p style={{ ...payBody, marginBottom: '18px' }}>
        Totals are recalculated when this is saved. Discount comes off before tax.
      </p>
      <div style={{ ...payCard, display: 'grid', gap: '12px', maxWidth: '760px' }}>
        <label style={payField}>Customer
          <select style={payInput} value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">Choose a customer</option>
            {customers.filter((row) => !row.archived || row.id === customerId).map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </select>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
          <label style={payField}>Issue date
            <input style={payInput} type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
          </label>
          <label style={payField}>Due date
            <input style={payInput} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </label>
          <label style={payField}>PO number
            <input style={payInput} value={po} onChange={(event) => setPo(event.target.value)} />
          </label>
        </div>
        {lines.map((line, index) => (
          <div key={index} style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.6fr 0.8fr auto auto', gap: '8px', alignItems: 'end' }}>
            <label style={payField}>Description
              <input style={payInput} value={line.description} onChange={(event) => update(index, { description: event.target.value })} />
            </label>
            <label style={payField}>Qty
              <input style={payInput} value={line.qty} onChange={(event) => update(index, { qty: event.target.value })} />
            </label>
            <label style={payField}>Rate
              <input style={payInput} value={line.rate} onChange={(event) => update(index, { rate: event.target.value })} />
            </label>
            <label style={{ ...payField, alignItems: 'center' }}>Taxable
              <input type="checkbox" checked={line.taxable} onChange={(event) => update(index, { taxable: event.target.checked })} />
            </label>
            <button type="button" style={paySecondary} onClick={() => setLines(lines.filter((_, i) => i !== index))}>Remove</button>
          </div>
        ))}
        <button type="button" style={paySecondary} onClick={() => setLines([...lines, emptyLine()])}>Add line</button>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
          <label style={payField}>Discount
            <input style={payInput} value={discount} onChange={(event) => setDiscount(event.target.value)} />
          </label>
          <label style={payField}>Tax label
            <input style={payInput} value={taxLabel} onChange={(event) => setTaxLabel(event.target.value)} />
          </label>
          <label style={payField}>Tax rate %
            <input style={payInput} value={taxRate} onChange={(event) => setTaxRate(event.target.value)} />
          </label>
        </div>
        <label style={payField}>Notes
          <textarea style={{ ...payInput, minHeight: '64px' }} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <label style={payField}>Terms
          <textarea style={{ ...payInput, minHeight: '64px' }} value={terms} onChange={(event) => setTerms(event.target.value)} />
        </label>
        <p style={{ ...payBody, color: '#111827' }}>
          {preview
            ? `Subtotal ${formatCents(preview.subtotalCents)} · Tax ${formatCents(preview.taxCents)} · Total ${formatCents(preview.totalCents)}`
            : 'Enter quantities and rates to preview the total. The saved total is computed on the server.'}
        </p>
        {error ? <p style={{ ...payBody, color: '#B42318' }}>{error}</p> : null}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button type="button" style={payPrimary} disabled={saving || !customerId} onClick={() => void save(false)}>
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button type="button" style={paySecondary} disabled={saving || !customerId} onClick={() => void save(true)}>
            Save and mark sent
          </button>
          <button type="button" style={paySecondary} onClick={() => navigate('/pay/invoices')}>Back</button>
        </div>
      </div>
    </div>
  );

  function update(index: number, patch: Partial<LineDraft>) {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }
}
