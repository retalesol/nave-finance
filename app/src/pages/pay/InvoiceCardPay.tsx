import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { MoonPayBuyWidget, MoonPayProvider } from '@moonpay/moonpay-react';
import { signMoonPayUrl } from '../../lib/edgeFunctionClient';
import { readViteEnv } from '../../lib/viteEnv';
import { INVOICE_CARD_WATCH_MS, type InvoiceCardTarget } from '../../lib/pay/invoiceMoonPay';

const BRASS = '#B9974F';

function centsToAmount(cents: number): string {
  const abs = Math.max(0, Math.trunc(cents));
  return `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Card checkout that pays the invoice address. Opening it asks Nave to keep
 * the invoice open for 30 days, and the page keeps watching for a day after
 * MoonPay says the payment was submitted.
 */
export default function InvoiceCardPay({
  token,
  target,
  cents,
  onProcessing,
}: {
  token: string;
  target: InvoiceCardTarget;
  cents: number;
  onProcessing: () => void;
}) {
  const publishableKey = (readViteEnv('VITE_MOONPAY_PUBLISHABLE_KEY') ?? '').trim();
  const watchRef = useRef<number | null>(null);
  const [noted, setNoted] = useState(false);

  useEffect(() => () => {
    if (watchRef.current != null) window.clearInterval(watchRef.current);
  }, []);

  const onUrlSignatureRequested = useCallback(async (url: string) => {
    const { data, error } = await signMoonPayUrl(url, '', target.chainId, token);
    if (error || !data?.signature) throw new Error(error || 'Could not sign the MoonPay checkout.');
    setNoted(true);
    return data.signature;
  }, [target.chainId, token]);

  const onTransactionCompleted = useCallback(async () => {
    onProcessing();
    if (watchRef.current != null) window.clearInterval(watchRef.current);
    const started = Date.now();
    watchRef.current = window.setInterval(() => {
      onProcessing();
      if (Date.now() - started > INVOICE_CARD_WATCH_MS && watchRef.current != null) {
        window.clearInterval(watchRef.current);
        watchRef.current = null;
      }
    }, 15_000);
  }, [onProcessing]);

  if (!publishableKey) {
    return <p style={note}>Card payments are not configured for this invoice.</p>;
  }

  const amount = centsToAmount(cents);
  const sandbox = publishableKey.startsWith('pk_test_');

  return (
    <div>
      <p style={note}>
        MoonPay sends USDC to this invoice address. Card and bank payments can take a while.
        This invoice stays open until the payment is recorded.
      </p>
      {sandbox ? <p style={note}>Sandbox does not send real USDC.</p> : null}
      {noted ? <p style={note}>Checkout started. You can leave this page. The invoice will update when MoonPay finishes.</p> : null}
      <MoonPayProvider apiKey={publishableKey}>
        <MoonPayBuyWidget
          variant="embedded"
          visible
          baseCurrencyCode="usd"
          baseCurrencyAmount={amount}
          quoteCurrencyAmount={amount}
          lockAmount="true"
          currencyCode={target.currencyCode}
          walletAddress={target.walletAddress}
          externalTransactionId={token}
          theme="light"
          colorCode={BRASS}
          onUrlSignatureRequested={onUrlSignatureRequested}
          onTransactionCompleted={onTransactionCompleted}
          style={{ width: '100%', maxWidth: '100%', height: '640px', margin: 0, boxSizing: 'border-box' }}
        />
      </MoonPayProvider>
    </div>
  );
}

const note: CSSProperties = {
  fontSize: '13px',
  color: '#6B7280',
  lineHeight: 1.5,
  margin: '0 0 10px',
};
