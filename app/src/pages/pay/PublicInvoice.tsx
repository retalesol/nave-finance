import { useMemo, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { INVOICE_FOOTER } from '../../lib/pay/billing';
import { fetchPublicInvoice, type PublicInvoiceView } from '../../lib/pay/booksApi';
import { invoiceCardTarget } from '../../lib/pay/invoiceMoonPay';
import { formatCents } from '../../lib/pay/invoiceMath';
import { payUsdc } from '../../lib/pay/payConfig';
import { supabase } from '../../lib/supabaseClient';
import InvoiceCardPay from './InvoiceCardPay';
import UsdcPayButton from './UsdcPayButton';

const CHAIN_LABEL: Record<string, string> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  base: 'Base',
  robinhood: 'Robinhood',
  arc: 'Arc',
};

export default function PublicInvoice() {
  const { token = '' } = useParams<{ token: string }>();
  const query = useQuery({
    queryKey: ['publicInvoice', token],
    enabled: token.length >= 32,
    queryFn: () => fetchPublicInvoice(token),
  });

  return (
    <div
      className="flex min-h-screen items-center justify-center px-6 py-12"
      style={{ backgroundColor: '#FAF8F3', color: '#111827' }}
    >
      <div style={{ width: '100%', maxWidth: '520px' }}>
        {token.length < 32 ? <p style={muted}>This invoice link is not valid.</p> : null}
        {query.isLoading ? <p style={muted}>Loading invoice.</p> : null}
        {query.isError ? <p style={muted}>This invoice could not be loaded.</p> : null}
        {query.isSuccess && !query.data ? <p style={muted}>This invoice link is not valid.</p> : null}
        {query.data ? <InvoiceCard token={token} invoice={query.data} /> : null}
      </div>
    </div>
  );
}

function InvoiceCard({ token, invoice }: { token: string; invoice: PublicInvoiceView }) {
  const addresses = invoice.addresses ?? [];
  const [selected, setSelected] = useState(0);
  const [method, setMethod] = useState<'transfer' | 'wallet' | 'card'>('transfer');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [cardProcessing, setCardProcessing] = useState(false);
  const queryClient = useQueryClient();
  const current = addresses[selected] ?? addresses[0];
  const card = useMemo(
    () => invoiceCardTarget(addresses, current?.chain ?? ''),
    [addresses, current?.chain],
  );
  const amount = formatCents(invoice.amount_due_cents);
  const payable = invoice.status === 'open' || invoice.status === 'partial' || invoice.status === 'overdue';
  const usdc = useMemo(
    () => (current ? payUsdc(current.chain, current.chain_id) : null),
    [current],
  );
  const evm = current?.chain !== 'solana';
  const solanaTokenAccount = !evm && current?.unique === true && current.asset !== 'native' && current.asset !== 'treasury';

  return (
    <div style={{ background: '#fff', border: '1px solid #E7E2D6', borderRadius: '16px', padding: '22px' }}>
      {invoice.logo_url ? (
        <img src={invoice.logo_url} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 10 }} />
      ) : null}
      <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 400, fontSize: '32px', margin: '12px 0 4px', letterSpacing: '-0.02em' }}>
        {invoice.company_name}
      </h1>
      <p style={muted}>{invoice.number} · <span style={{ textTransform: 'capitalize' }}>{invoice.status}</span></p>
      <div style={{ fontSize: '28px', margin: '18px 0 4px' }}>{amount}</div>
      <p style={muted}>Amount due{invoice.due_date ? ` · due ${invoice.due_date}` : ''}</p>
      {(invoice.items ?? []).length > 0 ? (
        <div style={{ marginTop: '16px' }}>
          {invoice.items.map((item) => (
            <div key={`${item.description}-${item.amount_cents}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderTop: '1px solid #EFEAE0', fontSize: '14px' }}>
              <span>{item.description || 'Line'}</span>
              <span>{formatCents(item.amount_cents)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <p style={{ ...muted, marginTop: '14px' }}>
        Reference <strong style={{ color: '#111827' }}>{invoice.reference}</strong>
      </p>
      {current ? (
        <>
          <p style={{ ...muted, marginTop: '14px' }}>
            Pay on <strong style={{ color: '#111827' }}>{CHAIN_LABEL[current.chain] ?? current.chain}</strong>
            {addresses.length > 1 ? '. This treasury can also be paid on its other deployed networks.' : '.'}
          </p>
          {addresses.length > 1 ? (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
              {addresses.map((row, index) => (
                <button
                  key={`${row.chain}-${row.asset}-${row.address}`}
                  type="button"
                  onClick={() => { setSelected(index); setError(null); setSent(null); }}
                  style={{
                    borderRadius: '999px',
                    border: index === selected ? '1px solid #111827' : '1px solid #E7E2D6',
                    background: index === selected ? '#111827' : '#fff',
                    color: index === selected ? '#fff' : '#111827',
                    fontSize: '12px',
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  {CHAIN_LABEL[row.chain] ?? row.chain}
                </button>
              ))}
            </div>
          ) : null}
          {payable ? (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' }}>
              {([
                ['transfer', 'Direct transfer'],
                ['wallet', 'Connected wallet'],
                ['card', 'Card with MoonPay'],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setMethod(id); setError(null); }}
                  style={{
                    borderRadius: '999px',
                    border: method === id ? '1px solid #111827' : '1px solid #E7E2D6',
                    background: method === id ? '#111827' : '#fff',
                    color: method === id ? '#fff' : '#111827',
                    fontSize: '12px',
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          {invoice.status === 'overdue' ? (
            <p style={{ ...muted, marginTop: '10px' }}>
              This invoice is past the due date and can still be paid. A MoonPay payment keeps it open until the transfer finishes.
            </p>
          ) : null}
          {method === 'transfer' || !payable ? (
            <>
              <code className="nave-mono" style={{ display: 'block', fontSize: '13px', wordBreak: 'break-all', marginTop: '12px' }}>
                {current.address}
              </code>
              <div style={{ marginTop: '14px' }}>
                <QRCodeSVG value={current.address} size={168} level="M" />
              </div>
              <p style={{ ...muted, marginTop: '8px' }}>Send {amount} to this invoice address. Include reference {invoice.reference}.</p>
            </>
          ) : null}
          {payable && method === 'wallet' ? (
            <div style={{ marginTop: '16px' }}>
              <UsdcPayButton
                label={usdc ? `Pay ${amount} with USDC` : 'USDC is not on this network'}
                evm={evm}
                chainId={current.chain_id}
                destination={current.address}
                solanaTokenAccount={solanaTokenAccount}
                token={usdc}
                cents={invoice.amount_due_cents}
                onError={setError}
                onSent={async (txHash) => {
                  setSent(txHash);
                  setError(null);
                  const { data, error: claimError } = await supabase.functions.invoke('pay-claim', {
                    body: {
                      kind: 'invoice',
                      token,
                      chain: current.chain,
                      chainId: current.chain_id,
                      txHash,
                    },
                  });
                  if (claimError) throw new Error(claimError.message);
                  if (data && typeof data === 'object' && 'error' in data && data.error) {
                    throw new Error(`${String(data.error)}. The transfer was sent as ${txHash}.`);
                  }
                  await queryClient.invalidateQueries({ queryKey: ['publicInvoice', token] });
                }}
              />
              <p style={{ ...muted, marginTop: '8px' }}>Connect a wallet and pay this invoice on the selected network.</p>
            </div>
          ) : null}
          {payable && method === 'card' ? (
            <div style={{ marginTop: '16px' }}>
              {card ? (
                <InvoiceCardPay
                  token={token}
                  target={card}
                  cents={invoice.amount_due_cents}
                  onProcessing={() => {
                    setCardProcessing(true);
                    void queryClient.invalidateQueries({ queryKey: ['publicInvoice', token] });
                  }}
                />
              ) : (
                <p style={muted}>Card payments are available on Solana, Ethereum, and Base for this invoice.</p>
              )}
            </div>
          ) : null}
          {cardProcessing ? <p style={{ ...muted, marginTop: '8px' }}>MoonPay is still processing. This invoice will not time out while that payment is in progress.</p> : null}
          {sent ? <p style={{ ...muted, marginTop: '8px' }}>Sent {sent}</p> : null}
          {error ? <p style={{ ...muted, color: '#B42318', marginTop: '8px' }}>{error}</p> : null}
        </>
      ) : (
        <p style={{ ...muted, marginTop: '14px' }}>No payment address is available for this invoice.</p>
      )}
      <p style={{ ...muted, marginTop: '22px' }}>{INVOICE_FOOTER}</p>
    </div>
  );
}

const muted: CSSProperties = {
  fontSize: '14px',
  color: '#6B7280',
  lineHeight: 1.5,
  margin: 0,
};
