import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { NAVE_DECIMALS } from '../lib/programConfig';

interface OdometerNumberProps {
  /** Last chain-synced value in base units. */
  value: bigint;
  /** Base units accrued per second (extrapolated between polls). */
  ratePerSec: number;
  /** Timestamp (ms) when `value` was last synced from chain. */
  lastSyncedAt: number;
  /** Optional suffix, e.g. " NAVE". */
  suffix?: string;
}

function formatNave(raw: bigint): string {
  const s = formatUnits(raw, NAVE_DECIMALS);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Extrapolate pending rewards between RPC polls. */
function extrapolateValue(value: bigint, ratePerSec: number, lastSyncedAt: number, nowMs: number): bigint {
  if (ratePerSec <= 0 || !Number.isFinite(ratePerSec)) return value;
  const elapsedSec = Math.max(0, (nowMs - lastSyncedAt) / 1000);
  const delta = BigInt(Math.floor(ratePerSec * elapsedSec));
  return value + delta;
}

/**
 * Animated counter that ticks up between chain polls. Each digit rolls vertically
 * when its displayed character changes.
 */
export default function OdometerNumber({ value, ratePerSec, lastSyncedAt, suffix = '' }: OdometerNumberProps) {
  const [displayRaw, setDisplayRaw] = useState(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      setDisplayRaw(extrapolateValue(value, ratePerSec, lastSyncedAt, Date.now()));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, ratePerSec, lastSyncedAt]);

  const formatted = useMemo(() => formatNave(displayRaw), [displayRaw]);
  const chars = formatted.split('');

  return (
    <span
      className="inline-flex items-baseline"
      style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'hsl(var(--foreground))' }}
      aria-live="polite"
    >
      {chars.map((char, index) => (
        <span
          key={`${index}-${char}`}
          className="inline-block overflow-hidden"
          style={{
            height: '1.1em',
            lineHeight: '1.1em',
            transition: 'transform 180ms ease-out',
            transform: 'translateY(0)',
          }}
        >
          {char}
        </span>
      ))}
      {suffix ? (
        // Render with an explicit left margin — a leading space in the suffix
        // string is collapsed away by the inline-flex layout, which is why the
        // ticker rendered flush against the number (e.g. "0.00907wNAVE").
        <span style={{ fontWeight: 500, marginLeft: '0.3em' }}>{suffix.trimStart()}</span>
      ) : null}
    </span>
  );
}
