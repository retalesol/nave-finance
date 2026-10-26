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
import { PayLedger, PayPage, PayStage, payTd as deskTd, payTh as deskTh } from './PayDesk';
import { payBody, payInput } from './payStyles';

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
    <PayPage
      kicker="Record"
      title="Cash ledger"
      purpose="Every dollar in and out: invoice payments, bill payments, deposits, and expenses."
      metrics={[
        { label: 'Opening', value: formatCents(ledger.openingCents), detail: from ? `Before ${from}` : 'From the first entry' },
        { label: 'In', value: formatCents(moneyIn), detail: 'In this range', tone: 'good' },
        { label: 'Out', value: formatCents(moneyOut), detail: 'In this range', tone: moneyOut > 0 ? 'attention' : 'default' },
        { label: 'Closing', value: formatCents(closing), detail: `${ledger.rows.length} entries` },
      ]}
    >
      <PayStage
        title="Running balance"
        detail="Click a row to open the invoice, bill, or cash entry."
        toolbar={(
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '13px', color: '#374151' }}>From
              <input style={{ ...payInput, marginLeft: '8px' }} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label style={{ fontSize: '13px', color: '#374151' }}>To
              <input style={{ ...payInput, marginLeft: '8px' }} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </div>
        )}
      >
        {loading ? <p style={{ ...payBody, padding: '16px' }}>Loading the ledger.</p> : null}
        {error ? <p style={{ ...payBody, color: '#B42318', padding: '16px' }}>{payablesMessage(error)}</p> : null}
        <PayLedger>
          <thead>
            <tr>
              <th style={deskTh}>Date</th>
              <th style={deskTh}>Type</th>
              <th style={deskTh}>Party</th>
              <th style={deskTh}>Category</th>
              <th style={{ ...deskTh, textAlign: 'right' }}>In</th>
              <th style={{ ...deskTh, textAlign: 'right' }}>Out</th>
              <th style={{ ...deskTh, textAlign: 'right' }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={6} style={{ ...deskTd, color: '#6B7280' }}>Opening balance</td>
              <td style={{ ...deskTd, textAlign: 'right' }}>{formatCents(ledger.openingCents)}</td>
            </tr>
            {ledger.rows.map((row) => (
              <tr
                key={`${row.src}:${row.srcId}`}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  if (row.linkType === 'invoice' && row.linkId) navigate(`/pay/invoices/${row.linkId}`);
                  else if (row.linkType === 'bill') navigate(`/pay/bills/${row.linkId}`);
                  else navigate(`/pay/transactions/${row.linkId}`);
                }}
              >
                <td style={deskTd}>{row.date}</td>
                <td style={deskTd}>{row.type}</td>
                <td style={deskTd}>{row.party || '—'}</td>
                <td style={deskTd}>{row.category}</td>
                <td style={{ ...deskTd, textAlign: 'right', color: '#166534' }}>{row.inCents ? formatCents(row.inCents) : ''}</td>
                <td style={{ ...deskTd, textAlign: 'right', color: '#B42318' }}>{row.outCents ? formatCents(row.outCents) : ''}</td>
                <td style={{ ...deskTd, textAlign: 'right', fontWeight: 600 }}>{formatCents(row.balanceCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ ...deskTd, color: '#6B7280' }}>{ledger.rows.length} entries</td>
              <td style={{ ...deskTd, textAlign: 'right' }}>{formatCents(moneyIn)}</td>
              <td style={{ ...deskTd, textAlign: 'right' }}>{formatCents(moneyOut)}</td>
              <td style={{ ...deskTd, textAlign: 'right', fontWeight: 600 }}>{formatCents(closing)}</td>
            </tr>
          </tfoot>
        </PayLedger>
      </PayStage>
    </PayPage>
  );
}
