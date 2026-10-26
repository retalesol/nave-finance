import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { formatCents } from '../../lib/pay/invoiceMath';
import { cashLedger, type CashLedgerSource } from '../../lib/pay/payables';
import {
  fetchInvoiceLedgerPayments,
  fetchPayBills,
  fetchPayCashEntries,
  payablesMessage,
} from '../../lib/pay/payablesApi';
import { payBody, payCard, payInput, payTitle } from './payStyles';

export default function CashLedgerPage({ treasuryGroupId }: { treasuryGroupId: string }) {
  const navigate = useNavigate();
  const membership = useDaoMembership();
  const wallet = membership.walletStr;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const bills = useQuery({
    queryKey: ['payBills', treasuryGroupId],
    queryFn: () => fetchPayBills(treasuryGroupId, wallet),
  });
  const cash = useQuery({
    queryKey: ['payCashEntries', treasuryGroupId],
    queryFn: () => fetchPayCashEntries(treasuryGroupId, wallet),
  });
  const invoices = useQuery({
    queryKey: ['payLedgerPayments', treasuryGroupId],
    queryFn: () => fetchInvoiceLedgerPayments(treasuryGroupId, wallet),
  });

  const sources = useMemo<CashLedgerSource[]>(() => {
    const invoiceRows: CashLedgerSource[] = (invoices.data ?? []).map((payment) => ({
      date: payment.paid_on,
      direction: 'in',
      amountCents: payment.amount_cents,
      type: 'Invoice payment',
      ref: payment.number,
      party: payment.customer_name,
      category: 'Invoice payments',
      method: payment.method,
      reference: payment.reference,
      linkType: 'invoice',
      linkId: payment.invoice_id,
      src: 'payment',
      srcId: payment.id,
    }));
    const billRows: CashLedgerSource[] = (bills.data ?? []).flatMap((bill) => (bill.payments ?? []).map((payment) => ({
      date: payment.paid_on,
      direction: 'out' as const,
      amountCents: payment.amount_cents,
      type: 'Bill payment',
      ref: bill.ref,
      party: bill.vendor?.name || '',
      category: bill.category || 'Uncategorized',
      method: payment.method,
      reference: payment.reference,
      linkType: 'bill' as const,
      linkId: bill.id,
      src: 'bill_payment',
      srcId: payment.id,
    })));
    const cashRows: CashLedgerSource[] = (cash.data ?? []).map((entry) => ({
      date: entry.entry_date,
      direction: entry.direction,
      amountCents: entry.amount_cents,
      type: entry.direction === 'in' ? 'Deposit' : 'Expense',
      ref: entry.reference,
      party: entry.vendor?.name || entry.counterparty,
      category: entry.category || 'Uncategorized',
      method: entry.method,
      reference: entry.reference,
      linkType: 'transaction',
      linkId: entry.id,
      src: 'transaction',
      srcId: entry.id,
    }));
    return [...invoiceRows, ...billRows, ...cashRows];
  }, [invoices.data, bills.data, cash.data]);

  const ledger = cashLedger(sources, from || null, to || null);
  const moneyIn = ledger.rows.reduce((sum, row) => sum + row.inCents, 0);
  const moneyOut = ledger.rows.reduce((sum, row) => sum + row.outCents, 0);
  const closing = ledger.openingCents + moneyIn - moneyOut;
  const loading = bills.isLoading || cash.isLoading || invoices.isLoading;
  const error = bills.error || cash.error || invoices.error;

  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>Nave Pay</div>
      <h1 style={payTitle}>Cash ledger</h1>
      <p style={{ ...payBody, margin: '0 0 16px' }}>
        Every dollar in and out: invoice payments, bill payments, deposits, and expenses.
      </p>
      <div style={{ display: 'flex', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '13px', color: '#374151' }}>From
          <input style={{ ...payInput, marginLeft: '8px' }} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label style={{ fontSize: '13px', color: '#374151' }}>To
          <input style={{ ...payInput, marginLeft: '8px' }} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>
      {loading ? <p style={payBody}>Loading the ledger.</p> : null}
      {error ? <p style={{ ...payBody, color: '#B42318' }}>{payablesMessage(error)}</p> : null}
      <div style={{ ...payCard, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
          <thead>
            <tr style={{ color: '#6B7280', textAlign: 'left' }}>
              <th style={th}>Date</th>
              <th style={th}>Type</th>
              <th style={th}>Party</th>
              <th style={th}>Category</th>
              <th style={{ ...th, textAlign: 'right' }}>In</th>
              <th style={{ ...th, textAlign: 'right' }}>Out</th>
              <th style={{ ...th, textAlign: 'right' }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={6} style={{ ...td, color: '#6B7280' }}>Opening balance</td>
              <td style={{ ...td, textAlign: 'right' }}>{formatCents(ledger.openingCents)}</td>
            </tr>
            {ledger.rows.map((row) => (
              <tr
                key={`${row.src}:${row.srcId}`}
                style={{ cursor: 'pointer', borderTop: '1px solid #EFEAE0' }}
                onClick={() => {
                  if (row.linkType === 'invoice' && row.linkId) navigate(`/pay/invoices/${row.linkId}`);
                  else if (row.linkType === 'bill') navigate(`/pay/bills/${row.linkId}`);
                  else navigate(`/pay/transactions/${row.linkId}`);
                }}
              >
                <td style={td}>{row.date}</td>
                <td style={td}>{row.type}</td>
                <td style={td}>{row.party || '—'}</td>
                <td style={td}>{row.category}</td>
                <td style={{ ...td, textAlign: 'right', color: '#166534' }}>{row.inCents ? formatCents(row.inCents) : ''}</td>
                <td style={{ ...td, textAlign: 'right', color: '#B42318' }}>{row.outCents ? formatCents(row.outCents) : ''}</td>
                <td style={{ ...td, textAlign: 'right' }}>{formatCents(row.balanceCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '1px solid #E7E2D6' }}>
              <td colSpan={4} style={td}>{ledger.rows.length} entries</td>
              <td style={{ ...td, textAlign: 'right' }}>{formatCents(moneyIn)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{formatCents(moneyOut)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{formatCents(closing)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

const th = { padding: '8px 8px 8px 0', fontWeight: 600 };
const td = { padding: '10px 8px 10px 0', color: '#111827' };
