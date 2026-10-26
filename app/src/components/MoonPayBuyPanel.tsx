import { useCallback, useEffect, useRef, useState } from 'react';
import { MoonPayBuyWidget, MoonPayProvider } from '@moonpay/moonpay-react';
import { useQueryClient } from '@tanstack/react-query';
import { useChain } from '../hooks/useChain';
import { toast } from '../hooks/use-toast';
import { signMoonPayUrl } from '../lib/edgeFunctionClient';
import { moonPayBuyTarget } from '../lib/moonpay';
import { readViteEnv } from '../lib/viteEnv';

/** App shell brass from index.css (`--brass` / `#B9974F`). */
const BRASS_FALLBACK = '#B9974F';

const BALANCE_WATCH_MS = 2 * 60 * 1000;
const BALANCE_WATCH_INTERVAL_MS = 10_000;

function brassColorCode(): string {
  if (typeof document === 'undefined') return BRASS_FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--brass').trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return BRASS_FALLBACK;
  const h = Number(parts[0]);
  const s = Number(parts[1].replace('%', '')) / 100;
  const l = Number(parts[2].replace('%', '')) / 100;
  if (![h, s, l].every((n) => Number.isFinite(n))) return BRASS_FALLBACK;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

function BuyNotice({ children }: { children: string }) {
  return (
    <div
      style={{
        backgroundColor: 'hsl(var(--background))',
        border: '1px solid hsl(var(--surface-2))',
        borderRadius: '12px',
        padding: '12px 14px',
        fontSize: '13px',
        color: 'hsl(var(--muted-foreground))',
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Embedded MoonPay checkout locked to USDC on the open treasury.
 * The provider loads only while the Buy tab is mounted.
 */
export function MoonPayBuyPanel({ daoAddress }: { daoAddress: string }) {
  const { chainKind, evmChainId } = useChain();
  const queryClient = useQueryClient();
  const [colorCode] = useState(brassColorCode);
  const watchRef = useRef<{ interval: number; stop: number } | null>(null);

  const clearWatch = useCallback(() => {
    if (!watchRef.current) return;
    window.clearInterval(watchRef.current.interval);
    window.clearTimeout(watchRef.current.stop);
    watchRef.current = null;
  }, []);

  useEffect(() => clearWatch, [clearWatch]);

  const target = moonPayBuyTarget(chainKind, evmChainId, daoAddress);
  const publishableKey = (readViteEnv('VITE_MOONPAY_PUBLISHABLE_KEY') ?? '').trim();

  const onUrlSignatureRequested = useCallback(async (url: string) => {
    const { data, error } = await signMoonPayUrl(
      url,
      daoAddress,
      chainKind === 'solana' ? null : evmChainId,
    );
    if (error || !data?.signature) {
      throw new Error(error || 'Could not sign the MoonPay checkout.');
    }
    return data.signature;
  }, [chainKind, daoAddress, evmChainId]);

  const onTransactionCompleted = useCallback(async () => {
    toast({
      title: 'Purchase complete',
      description: 'USDC appears after the transfer confirms.',
    });
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['treasuryAssets', daoAddress] });
      void queryClient.invalidateQueries({ queryKey: ['treasuryBalance', daoAddress] });
    };
    refresh();
    clearWatch();
    const interval = window.setInterval(refresh, BALANCE_WATCH_INTERVAL_MS);
    const stop = window.setTimeout(() => {
      window.clearInterval(interval);
      if (watchRef.current?.interval === interval) watchRef.current = null;
    }, BALANCE_WATCH_MS);
    watchRef.current = { interval, stop };
  }, [clearWatch, daoAddress, queryClient]);

  if (!target) {
    return (
      <BuyNotice>
        Card purchases are not available on this network. Receive and Wallet still work.
      </BuyNotice>
    );
  }

  if (!publishableKey) {
    return (
      <BuyNotice>
        Card purchases are not configured. Set VITE_MOONPAY_PUBLISHABLE_KEY.
      </BuyNotice>
    );
  }

  const sandbox = publishableKey.startsWith('pk_test_');

  return (
    <div>
      {sandbox && (
        <p
          style={{
            fontSize: '12.5px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.5,
            margin: '0 0 12px',
          }}
        >
          Sandbox does not send real USDC.
        </p>
      )}
      <MoonPayProvider apiKey={publishableKey}>
        <MoonPayBuyWidget
          variant="embedded"
          visible
          baseCurrencyCode="usd"
          currencyCode={target.currencyCode}
          walletAddress={target.walletAddress}
          externalTransactionId={daoAddress}
          theme="light"
          colorCode={colorCode}
          onUrlSignatureRequested={onUrlSignatureRequested}
          onTransactionCompleted={onTransactionCompleted}
          style={{
            width: '100%',
            maxWidth: '100%',
            height: '640px',
            margin: 0,
            boxSizing: 'border-box',
          }}
        />
      </MoonPayProvider>
    </div>
  );
}
