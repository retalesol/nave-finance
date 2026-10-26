import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { chainFamilyLabel, type ChainFamily } from '../../lib/chain/types';
import { useDaoContext } from '../../hooks/useDaoContext';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { useDaoRegistry } from '../../hooks/useDaoRegistry';
import type { PayBooksSnapshot, PayWalletAddressRow } from '../../lib/pay/api';
import {
  fetchPayActivity,
  fetchPayInvoices,
  payBooksMessage,
  updatePayRails,
  type PayActivity,
  type PayInvoice,
} from '../../lib/pay/booksApi';
import { formatCents, invoiceState, localToday } from '../../lib/pay/invoiceMath';
import { billState } from '../../lib/pay/payables';
import { fetchPayBills, type PayBill } from '../../lib/pay/payablesApi';
import { PayLedger, PayPage, PayStage, PayStatus, PayWork, payTd, payTh } from './PayDesk';

function chainLabel(chain: string): string {
  if (chain === 'solana' || chain === 'ethereum' || chain === 'base' || chain === 'robinhood' || chain === 'arc') {
    return chainFamilyLabel(chain as ChainFamily);
  }
  return chain;
}

function shorten(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function addressCaption(row: PayWalletAddressRow): string {
  return row.chain === 'solana' ? 'Vault authority' : 'Treasury';
}

export default function PayHome({
  snapshot,
  treasuryGroupId,
  preview,
}: {
  snapshot: PayBooksSnapshot;
  treasuryGroupId: string;
  /** Static books for the walkthrough. Skips the books API. */
  preview?: {
    invoices: PayInvoice[];
    bills: PayBill[];
    activity: PayActivity[];
  };
}) {
  const navigate = useNavigate();
  const membership = useDaoMembership();
  const wallet = membership.walletStr;
  const today = localToday();
  const activity = useQuery({
    queryKey: ['payActivity', treasuryGroupId],
    queryFn: () => fetchPayActivity(treasuryGroupId, wallet),
    enabled: !preview,
  });
  const invoices = useQuery({
    queryKey: ['payInvoices', treasuryGroupId],
    queryFn: () => fetchPayInvoices(treasuryGroupId, wallet),
    enabled: !preview,
  });
  const bills = useQuery({
    queryKey: ['payBills', treasuryGroupId],
    queryFn: () => fetchPayBills(treasuryGroupId, wallet),
    enabled: !preview,
  });
  const invoiceRows = preview?.invoices ?? invoices.data ?? [];
  const billRows = preview?.bills ?? bills.data ?? [];
  const activityRows = preview?.activity ?? activity.data ?? [];
  const booksLoading = !preview && (invoices.isLoading || bills.isLoading);
  const activityLoading = !preview && activity.isLoading;
  const legalName = snapshot.company?.legal_name || 'This treasury';
  const address = snapshot.company?.address?.trim() ?? '';
  const ein = snapshot.company?.ein?.trim() ?? '';
  const cash = snapshot.cashAccount;

  const desk = useMemo(() => {
    let collect = 0;
    let collectCount = 0;
    let overdueInvoices = 0;
    let overdueInvoiceCount = 0;
    const attention: Array<{ id: string; href: string; who: string; what: string; amount: number; status: string; rank: number }> = [];
    for (const invoice of invoiceRows) {
      const paid = (invoice.payments ?? []).reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
      const state = invoiceState(
        { status: invoice.status, totalCents: invoice.total_cents, paidCents: paid, dueDate: invoice.due_date },
        today,
      );
      if (state.balanceCents > 0) {
        collect += state.balanceCents;
        collectCount += 1;
      }
      if (state.displayStatus === 'overdue') {
        overdueInvoices += state.balanceCents;
        overdueInvoiceCount += 1;
      }
      if (state.displayStatus === 'overdue' || state.displayStatus === 'open' || state.displayStatus === 'partial') {
        attention.push({
          id: invoice.id,
          href: `/pay/invoices/${invoice.id}`,
          who: invoice.customer?.name || 'Customer',
          what: `Invoice ${invoice.number}`,
          amount: state.balanceCents,
          status: state.displayStatus,
          rank: state.displayStatus === 'overdue' ? 0 : 1,
        });
      }
    }
    let owe = 0;
    let oweCount = 0;
    let overdueBills = 0;
    for (const bill of billRows) {
      const paid = (bill.payments ?? []).reduce((sum, row) => sum + row.amount_cents, 0);
      const state = billState(
        { status: bill.status, amountCents: bill.amount_cents, paidCents: paid, dueDate: bill.due_date },
        today,
      );
      if (state.balanceCents > 0) {
        owe += state.balanceCents;
        oweCount += 1;
      }
      if (state.displayStatus === 'overdue') overdueBills += 1;
      if (state.displayStatus === 'overdue' || state.displayStatus === 'open' || state.displayStatus === 'partial') {
        attention.push({
          id: bill.id,
          href: `/pay/bills/${bill.id}`,
          who: bill.vendor?.name || 'Vendor',
          what: bill.ref ? `Bill ${bill.ref}` : 'Bill',
          amount: state.balanceCents,
          status: state.displayStatus,
          rank: state.displayStatus === 'overdue' ? 0 : 2,
        });
      }
    }
    attention.sort((a, b) => a.rank - b.rank || b.amount - a.amount);
    return { collect, collectCount, overdueInvoices, overdueInvoiceCount, owe, oweCount, overdueBills, attention: attention.slice(0, 6) };
  }, [billRows, invoiceRows, today]);

  return (
    <PayPage
      kicker="Today"
      title={legalName}
      purpose="Collect what customers owe, pay what is due, and keep every chain of this treasury on the same books."
      metrics={[
        { label: 'To collect', value: formatCents(desk.collect), detail: desk.collectCount === 1 ? '1 open invoice' : `${desk.collectCount} open invoices` },
        { label: 'Overdue', value: formatCents(desk.overdueInvoices), detail: desk.overdueInvoiceCount === 1 ? '1 invoice late' : `${desk.overdueInvoiceCount} invoices late`, tone: desk.overdueInvoiceCount > 0 ? 'attention' : 'default' },
        { label: 'To pay', value: formatCents(desk.owe), detail: desk.oweCount === 1 ? '1 open bill' : `${desk.oweCount} open bills`, tone: desk.overdueBills > 0 ? 'attention' : 'default' },
        { label: 'Chains', value: String(snapshot.addresses.length), detail: cash ? `${cash.name} · ${cash.code}` : 'Digital assets · 1200' },
      ]}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
        <PayWork title="Invoice" detail="Draft a bill for a customer, send the link, and get paid in USDC." action="New invoice" onClick={() => navigate('/pay/invoices/new')} />
        <PayWork title="Bill" detail="Record what a vendor is owed before you propose a treasury payment." action="New bill" onClick={() => navigate('/pay/bills/new')} />
        <PayWork title="Other money" detail="Grants, fees, and costs that are not an invoice payment or a bill payment." action="Record a deposit" onClick={() => navigate('/pay/transactions/new?direction=in')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px', alignItems: 'start' }}>
        <PayStage title="Needs a decision" detail="Open invoices and bills, late ones first.">
          {booksLoading ? <p style={{ margin: 0, padding: '16px', fontSize: '13.5px', color: '#6B7280' }}>Loading the books.</p> : null}
          {!booksLoading && desk.attention.length === 0 ? (
            <p style={{ margin: 0, padding: '18px 16px', fontSize: '14px', color: '#6B7280', lineHeight: 1.5 }}>
              Nothing is waiting. Send an invoice when you are owed, or record a bill when the treasury owes someone.
            </p>
          ) : (
            <PayLedger>
              <thead>
                <tr>
                  <th style={payTh}>Who</th>
                  <th style={payTh}>Document</th>
                  <th style={payTh}>Status</th>
                  <th style={{ ...payTh, textAlign: 'right' }}>Open</th>
                </tr>
              </thead>
              <tbody>
                {desk.attention.map((row) => (
                  <tr key={`${row.href}`} onClick={() => navigate(row.href)} style={{ cursor: 'pointer' }}>
                    <td style={{ ...payTd, fontWeight: 600 }}>{row.who}</td>
                    <td style={payTd}>{row.what}</td>
                    <td style={payTd}><PayStatus status={row.status} /></td>
                    <td style={{ ...payTd, textAlign: 'right' }}>{formatCents(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </PayLedger>
          )}
        </PayStage>

        <PayStage title="Recent activity" detail="Payments recorded in these books.">
          {activityLoading ? <p style={{ margin: 0, padding: '16px', fontSize: '13.5px', color: '#6B7280' }}>Loading activity.</p> : null}
          {!activityLoading && activityRows.length === 0 ? (
            <p style={{ margin: 0, padding: '16px', fontSize: '13.5px', color: '#6B7280', lineHeight: 1.5 }}>No payment activity yet.</p>
          ) : (
            activityRows.slice(0, 6).map((row) => (
              <div key={row.id} style={{ padding: '12px 16px', borderTop: '1px solid #EFEAE0', fontSize: '13.5px', color: '#111827', lineHeight: 1.45 }}>
                {row.summary}
              </div>
            ))
          )}
        </PayStage>
      </div>

      <PayStage title="How customers pay" detail={cash ? `${cash.name} (${cash.code}). Watch-only until a bank is connected.` : 'Digital assets (1200). Watch-only until a bank is connected.'}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <div>
            {snapshot.addresses.length === 0 ? (
              <p style={{ margin: 0, padding: '14px 16px', fontSize: '13.5px', color: '#6B7280' }}>
                No chain deployments were on this treasury when Pay was turned on.
              </p>
            ) : snapshot.addresses.map((row) => (
              <div
                key={`${row.chain}-${row.chain_id ?? 'solana'}-${row.address}`}
                style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '12px 16px', borderTop: '1px solid #EFEAE0', fontSize: '13.5px' }}
              >
                <span style={{ color: '#6B7280' }}>
                  {chainLabel(row.chain)}
                  <span style={{ color: '#9CA3AF' }}> · {addressCaption(row)}</span>
                </span>
                <code className="nave-mono" style={{ color: '#111827', fontSize: '12px' }}>{shorten(row.address)}</code>
              </div>
            ))}
            <p style={{ margin: 0, padding: '12px 16px 14px', fontSize: '12.5px', color: '#9CA3AF', lineHeight: 1.5 }}>
              Legal address: {address || 'not set'}. EIN: {ein || 'not set'}.
            </p>
          </div>
          <div style={{ padding: '14px 16px 16px', borderLeft: '1px solid #EFEAE0' }}>
            <CarriedLogo fallback={snapshot.company?.logo_url ?? ''} />
          </div>
        </div>
        <details style={{ borderTop: '1px solid #EFEAE0', padding: '12px 16px 14px' }}>
          <summary style={{ cursor: 'pointer', fontSize: '13px', color: '#6B7280' }}>Wire and ACH instructions</summary>
          <RailsEditor
            treasuryGroupId={treasuryGroupId}
            wallet={wallet}
            wire={snapshot.company?.wire_instructions ?? ''}
            ach={snapshot.company?.ach_instructions ?? ''}
          />
        </details>
      </PayStage>
    </PayPage>
  );
}

function CarriedLogo({ fallback }: { fallback: string }) {
  const { daoAddress } = useDaoContext();
  const { dao } = useDaoRegistry(daoAddress);
  const logoUrl = dao?.logoUrl || fallback;

  return (
    <section style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
      {logoUrl ? (
        <img src={logoUrl} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 10 }} />
      ) : (
        <div style={{ width: 48, height: 48, borderRadius: 10, background: '#E7E2D6' }} />
      )}
      <div>
        <div style={{ fontSize: '14px', color: '#111827' }}>Treasury logo</div>
        <p style={{ fontSize: '13px', color: '#6B7280', margin: '2px 0 0', lineHeight: 1.45 }}>
          Taken from treasury settings and printed on invoices.{' '}
          <Link to="/settings" style={{ color: '#111827' }}>Change it in settings</Link>
        </p>
      </div>
    </section>
  );
}

function RailsEditor({
  treasuryGroupId,
  wallet,
  wire,
  ach,
}: {
  treasuryGroupId: string;
  wallet: string | null;
  wire: string;
  ach: string;
}) {
  const queryClient = useQueryClient();
  const [wireText, setWireText] = useState(wire);
  const [achText, setAchText] = useState(ach);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section style={{ marginTop: '22px', maxWidth: '560px' }}>
      <div className="nave-label" style={{ marginBottom: '8px' }}>Wire and ACH</div>
      <p style={{ fontSize: '13px', color: '#6B7280', margin: '0 0 10px', lineHeight: 1.5 }}>
        Optional. A sent invoice freezes this text with the treasury address. It is not shown on the public payment page.
      </p>
      <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '10px' }}>
        Wire instructions
        <textarea
          value={wireText}
          onChange={(event) => setWireText(event.target.value)}
          style={railInput}
        />
      </label>
      <label style={{ display: 'block', fontSize: '13px', color: '#374151' }}>
        ACH instructions
        <textarea
          value={achText}
          onChange={(event) => setAchText(event.target.value)}
          style={railInput}
        />
      </label>
      {message ? <p style={{ fontSize: '13px', color: '#6B7280', margin: '8px 0 0' }}>{message}</p> : null}
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setSaving(true);
          setMessage(null);
          void updatePayRails(treasuryGroupId, wallet, wireText, achText)
            .then(async () => {
              await queryClient.invalidateQueries({ queryKey: ['payBooks', treasuryGroupId] });
              setMessage('Saved.');
            })
            .catch((err: unknown) => setMessage(payBooksMessage(err)))
            .finally(() => setSaving(false));
        }}
        style={{
          marginTop: '10px',
          fontSize: '13px',
          fontWeight: 600,
          borderRadius: '9px',
          padding: '8px 14px',
          border: '1px solid #111827',
          backgroundColor: '#111827',
          color: '#ffffff',
        }}
      >
        {saving ? 'Saving…' : 'Save instructions'}
      </button>
    </section>
  );
}

const railInput = {
  display: 'block',
  width: '100%',
  marginTop: '6px',
  minHeight: '72px',
  border: '1px solid #E7E2D6',
  borderRadius: '9px',
  padding: '8px 10px',
  fontSize: '14px',
  fontFamily: 'inherit',
} as const;
