import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useChain } from '../../hooks/useChain';
import type { PayBooksSnapshot } from '../../lib/pay/api';
import { choosePayable } from '../../lib/pay/addresses';
import {
  deletePayInvoice,
  deletePayPayment,
  duplicatePayInvoice,
  fetchPayCashAccounts,
  invoiceAddressesFor,
  payBooksMessage,
  recordPayPayment,
  setPayInvoiceStatus,
  type PayInvoice,
} from '../../lib/pay/booksApi';
import { invoiceEmailAvailability } from '../../lib/pay/email';
import { invoiceDocumentHtml, printInvoiceDocument } from '../../lib/pay/invoiceDocument';
import {
  formatCents,
  invoiceState,
  localToday,
  randomInvoiceIdHex,
  voidBlockedReason,
} from '../../lib/pay/invoiceMath';
import { payBody, payCard, payDanger, payField, payInput, payPrimary, paySecondary, payTitle, statusColor } from './payStyles';

const CHAIN_LABEL: Record<string, string> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  base: 'Base',
  robinhood: 'Robinhood',
  arc: 'Arc',
};

export default function InvoiceDetail({
  treasuryGroupId,
  wallet,
  snapshot,
  invoice,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  snapshot: PayBooksSnapshot;
  invoice: PayInvoice;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { chainFamily } = useChain();
  const [error, setError] = useState<string | null>(null);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(localToday());
  const [method, setMethod] = useState('Crypto');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const accounts = useQuery({
    queryKey: ['payCashAccounts', treasuryGroupId],
    queryFn: () => fetchPayCashAccounts(treasuryGroupId, wallet),
  });
  const paid = (invoice.payments ?? []).reduce((sum, row) => sum + row.amount_cents, 0);
  const state = invoiceState(
    { status: invoice.status, totalCents: invoice.total_cents, paidCents: paid, dueDate: invoice.due_date },
    localToday(),
  );
  const stored = invoice.addresses ?? [];
  const canonical = snapshot.addresses.find((row) => row.chain === chainFamily)?.address ?? null;
  const payable = choosePayable(chainFamily, stored, canonical);
  const publicPath = `/pay/i/${invoice.public_token}`;
  const voidReason = voidBlockedReason(invoice.status, paid);
  const defaultCash = accounts.data?.find((row) => row.code === (method === 'Crypto' ? '1200' : '1000'))?.id ?? '';
  const [cashAccount, setCashAccount] = useState('');

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['payInvoice', invoice.id] });
    await queryClient.invalidateQueries({ queryKey: ['payInvoices', treasuryGroupId] });
    await queryClient.invalidateQueries({ queryKey: ['payActivity', treasuryGroupId] });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(payBooksMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const rails = payableRows(invoice, snapshot);

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 style={payTitle}>{invoice.number}</h1>
          <p style={payBody}>{invoice.customer?.name || invoice.customer_snapshot?.name || 'Customer'}</p>
        </div>
        <div style={{ fontWeight: 700, color: statusColor(state.displayStatus), textTransform: 'capitalize' }}>
          {state.displayStatus}
          {state.daysOverdue > 0 ? ` · ${state.daysOverdue} days` : ''}
        </div>
      </div>

      <section style={{ ...payCard, marginTop: '18px', maxWidth: '720px' }}>
        <div className="nave-label" style={{ marginBottom: '8px' }}>Amount due</div>
        <div style={{ fontSize: '28px', color: '#111827' }}>{formatCents(state.balanceCents)}</div>
        <p style={{ ...payBody, marginTop: '6px' }}>
          Total {formatCents(invoice.total_cents)} · Paid {formatCents(paid)}
          {invoice.discount_cents ? ` · Discount ${formatCents(invoice.discount_cents)}` : ''}
          {invoice.tax_cents ? ` · ${invoice.tax_label} ${formatCents(invoice.tax_cents)}` : ''}
        </p>
        <p style={{ ...payBody, marginTop: '8px' }}>
          Issued {invoice.issue_date} · Due {invoice.due_date}
          {invoice.po_number ? ` · PO ${invoice.po_number}` : ''}
        </p>
      </section>

      <section style={{ ...payCard, marginTop: '12px', maxWidth: '720px' }}>
        <div className="nave-label" style={{ marginBottom: '8px' }}>
          This network · {CHAIN_LABEL[chainFamily] ?? chainFamily}
        </div>
        {payable.address ? (
          <>
            <code className="nave-mono" style={{ display: 'block', fontSize: '13px', wordBreak: 'break-all', color: '#111827' }}>
              {payable.address}
            </code>
            <p style={{ ...payBody, marginTop: '8px' }}>
              Reference <strong style={{ color: '#111827' }}>{invoice.reference_code}</strong>.
              {payable.unique
                ? ' This address belongs to the invoice and settles into the treasury.'
                : ' No unique forwarder is configured for this chain. Pay the treasury address and include the reference.'}
            </p>
            <div style={{ marginTop: '12px', background: '#fff', width: 'fit-content', padding: '8px' }}>
              <QRCodeSVG value={payable.address} size={132} level="M" />
            </div>
          </>
        ) : (
          <p style={payBody}>This treasury has no receive address on {CHAIN_LABEL[chainFamily] ?? chainFamily}.</p>
        )}
        <p style={{ ...payBody, marginTop: '12px' }}>
          Customer link{' '}
          <Link to={publicPath}>{publicPath}</Link>
        </p>
        {rails.length > 1 ? (
          <div style={{ marginTop: '10px' }}>
            {rails.map((row) => (
              <div key={`${row.chain}-${row.asset}`} style={{ fontSize: '12.5px', color: '#6B7280', padding: '4px 0' }}>
                {CHAIN_LABEL[row.chain] ?? row.chain} · {row.unique ? 'invoice address' : 'treasury address'}
                <div className="nave-mono" style={{ color: '#111827', wordBreak: 'break-all' }}>{row.address}</div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section style={{ ...payCard, marginTop: '12px', maxWidth: '720px' }}>
        {(invoice.items ?? []).map((item) => (
          <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderTop: '1px solid #EFEAE0', fontSize: '13.5px' }}>
            <span>{item.description || 'Line'}{item.taxable ? ' · taxable' : ''}</span>
            <span>{formatCents(item.amount_cents)}</span>
          </div>
        ))}
        {invoice.notes ? <p style={{ ...payBody, marginTop: '10px' }}>{invoice.notes}</p> : null}
        {invoice.terms ? <p style={{ ...payBody, marginTop: '6px' }}>{invoice.terms}</p> : null}
      </section>

      {(invoice.payments ?? []).length > 0 ? (
        <section style={{ ...payCard, marginTop: '12px', maxWidth: '720px' }}>
          <div className="nave-label" style={{ marginBottom: '8px' }}>Payments</div>
          {(invoice.payments ?? []).map((payment) => (
            <div key={payment.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '8px 0', borderTop: '1px solid #EFEAE0', fontSize: '13.5px' }}>
              <span>{payment.paid_on} · {payment.method || 'Payment'} {payment.reference}</span>
              <span>
                {formatCents(payment.amount_cents)}
                {payment.method !== 'crypto' ? (
                  <button
                    type="button"
                    style={{ ...payDanger, marginLeft: '8px', padding: '4px 8px' }}
                    onClick={() => {
                      if (!window.confirm('Delete this payment? The invoice balance will reopen.')) return;
                      void run(() => deletePayPayment(payment.id, wallet));
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {invoice.status !== 'void' && state.displayStatus !== 'paid' ? (
        <section style={{ ...payCard, marginTop: '12px', maxWidth: '720px', display: 'grid', gap: '10px' }}>
          <div className="nave-label">Record payment</div>
          {invoice.status === 'draft' ? (
            <p style={payBody}>Recording a payment marks this draft as sent and freezes the invoice.</p>
          ) : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
            <label style={payField}>Amount
              <input style={payInput} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
            </label>
            <label style={payField}>Date
              <input style={payInput} type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} />
            </label>
            <label style={payField}>Method
              <select style={payInput} value={method} onChange={(event) => setMethod(event.target.value)}>
                <option>Crypto</option>
                <option>Wire</option>
                <option>ACH</option>
                <option>Other</option>
              </select>
            </label>
          </div>
          <label style={payField}>Cash account
            <select style={payInput} value={cashAccount || defaultCash} onChange={(event) => setCashAccount(event.target.value)}>
              {(accounts.data ?? []).map((account) => (
                <option key={account.id} value={account.id}>{account.code} {account.name}</option>
              ))}
            </select>
          </label>
          <label style={payField}>Reference
            <input style={payInput} value={reference} onChange={(event) => setReference(event.target.value)} />
          </label>
          <button
            type="button"
            style={payPrimary}
            disabled={busy || paying}
            onClick={() => {
              setPaying(true);
              void run(async () => {
                await recordPayPayment(invoice.id, wallet, {
                  amount,
                  date: paidOn,
                  method,
                  reference,
                  notes,
                  cash_account_id: cashAccount || defaultCash || null,
                  addresses: invoice.status === 'draft'
                    ? invoiceAddressesFor(invoice.invoice_id_hex, snapshot.addresses)
                    : undefined,
                });
                setAmount('');
              }).finally(() => setPaying(false));
            }}
          >
            Record payment
          </button>
        </section>
      ) : null}

      {error ? <p style={{ ...payBody, color: '#B42318', marginTop: '12px' }}>{error}</p> : null}
      {emailNote ? <p style={{ ...payBody, marginTop: '12px' }}>{emailNote}</p> : null}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }}>
        {invoice.status !== 'void' ? (
          <button type="button" style={paySecondary} onClick={() => navigate(`/pay/invoices/${invoice.id}/edit`)}>Edit</button>
        ) : null}
        {invoice.status === 'draft' ? (
          <button
            type="button"
            style={payPrimary}
            disabled={busy}
            onClick={() => void run(() => setPayInvoiceStatus(
              invoice.id,
              wallet,
              'sent',
              invoiceAddressesFor(invoice.invoice_id_hex, snapshot.addresses),
            ))}
          >
            Mark sent
          </button>
        ) : null}
        <button
          type="button"
          style={paySecondary}
          disabled={busy}
          onClick={() => void run(async () => {
            const id = await duplicatePayInvoice(invoice.id, wallet, randomInvoiceIdHex());
            navigate(`/pay/invoices/${id}/edit`);
          })}
        >
          Duplicate
        </button>
        <button
          type="button"
          style={paySecondary}
          onClick={() => printInvoiceDocument(invoiceDocumentHtml(invoice, rails))}
        >
          PDF
        </button>
        <button
          type="button"
          style={paySecondary}
          onClick={() => setEmailNote(invoiceEmailAvailability().reason)}
        >
          Email
        </button>
        {invoice.status !== 'void' ? (
          <button
            type="button"
            style={payDanger}
            disabled={busy || voidReason !== null}
            title={voidReason ?? ''}
            onClick={() => {
              if (voidReason) {
                setError(voidReason);
                return;
              }
              if (!window.confirm(`Void invoice ${invoice.number}? It stays on record with a zero balance.`)) return;
              void run(() => setPayInvoiceStatus(invoice.id, wallet, 'void'));
            }}
          >
            Void
          </button>
        ) : (
          <button type="button" style={paySecondary} disabled={busy} onClick={() => void run(() => setPayInvoiceStatus(invoice.id, wallet, 'reopen'))}>
            Reopen
          </button>
        )}
        {invoice.status === 'draft' ? (
          <button
            type="button"
            style={payDanger}
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Delete draft ${invoice.number}?`)) return;
              void run(async () => {
                await deletePayInvoice(invoice.id, wallet);
                navigate('/pay/invoices');
              });
            }}
          >
            Delete draft
          </button>
        ) : null}
        <button type="button" style={paySecondary} onClick={() => navigate('/pay/invoices')}>All invoices</button>
      </div>
    </div>
  );
}

function payableRows(invoice: PayInvoice, snapshot: PayBooksSnapshot) {
  const unique = invoice.addresses ?? [];
  const rows = unique.map((row) => ({
    chain: row.chain,
    asset: row.asset,
    address: row.address,
    unique: true,
  }));
  for (const wallet of snapshot.addresses) {
    if (rows.some((row) => row.chain === wallet.chain)) continue;
    rows.push({ chain: wallet.chain, asset: 'treasury', address: wallet.address, unique: false });
  }
  return rows;
}
