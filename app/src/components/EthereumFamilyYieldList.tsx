// Ethereum venues a Base, Robinhood, or Arc treasury can see. Display only:
// nothing here approves a protocol or sends a transaction.

import { useMemo } from 'react';
import { useStrategyRates } from '../hooks/useStrategyRates';
import { effectiveApy, type StrategyRate } from '../../supabase/functions/_shared/strategyCatalog.ts';
import {
  ethereumFamilyOpportunities,
  seesEthereumFamilyYield,
} from '../../supabase/functions/_shared/ethereumFamilyYield.ts';
import type { YieldOpportunity } from '../../supabase/functions/_shared/policy.ts';

export interface EthereumFamilyYieldListProps {
  homeChainId?: number | null;
  linkedEthereumTreasury?: boolean;
  outboundBridgeEnabled?: boolean;
}

function liveApyBps(rates: Map<string, StrategyRate>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, rate] of rates) {
    if (rate.baseApy == null || !Number.isFinite(rate.baseApy)) continue;
    out[id] = Math.round(effectiveApy(rate, rate.baseApy) * 100);
  }
  return out;
}

function formatNet(row: YieldOpportunity): string {
  if (row.apyRead === false || row.netApyBps == null) return 'Rate not read';
  const pct = row.netApyBps / 100;
  const abs = Math.abs(pct).toFixed(2);
  return `${pct < 0 ? '-' : ''}${abs}%/yr after bridge`;
}

function bandLabel(row: YieldOpportunity): string | null {
  if (row.yieldBand === 'in-band') return '6–12% band';
  if (row.yieldBand === 'below-band') return 'Below 6%';
  if (row.yieldBand === 'above-band') return 'Above 12%';
  return null;
}

export default function EthereumFamilyYieldList({
  homeChainId,
  linkedEthereumTreasury = false,
  outboundBridgeEnabled = false,
}: EthereumFamilyYieldListProps) {
  const show = homeChainId != null && seesEthereumFamilyYield(homeChainId);
  const { rates } = useStrategyRates(show ? 'ethereum' : null);
  const rows = useMemo(() => {
    if (!show || homeChainId == null) return [];
    return ethereumFamilyOpportunities(homeChainId, {
      liveApyBps: liveApyBps(rates),
      linkedEthereumTreasury,
      outboundBridgeEnabled,
    });
  }, [show, homeChainId, rates, linkedEthereumTreasury, outboundBridgeEnabled]);

  if (!show || rows.length === 0) return null;
  const where = rows[0]?.venueChainLabel ?? 'Ethereum';

  return (
    <div data-testid="ethereum-family-yield" style={{ marginTop: '18px' }}>
      <label
        style={{
          display: 'block',
          fontSize: '13px',
          fontWeight: 600,
          marginBottom: '6px',
          color: 'hsl(var(--foreground))',
        }}
      >
        Ethereum yield
      </label>
      <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: '0 0 8px' }}>
        These places are on {where}. Moving funds there needs a bridge. The rate is the venue
        rate minus the bridge cost over a 30-day hold. A place below 6% stays on the list.
      </p>
      <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
        {rows.map((row) => {
          const band = bandLabel(row);
          const executable = row.executable === true;
          return (
            <div
              key={row.protocolId}
              data-testid={`ethereum-yield-${row.protocolId}`}
              className="flex items-start justify-between gap-3"
              style={{
                padding: '13px 0',
                borderBottom: '1px solid hsl(var(--surface-2))',
              }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>
                    {row.label ?? row.protocolId}
                  </span>
                  <span className="nave-mono" style={{ fontSize: '12px', color: '#2F7D4F', fontWeight: 500 }}>
                    {formatNet(row)}
                  </span>
                  {band && (
                    <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>{band}</span>
                  )}
                </div>
                <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', lineHeight: 1.45 }}>
                  Bridge required · {row.bridgeLabel ?? 'bridge'}
                  {row.venueChainLabel ? ` · ${row.venueChainLabel}` : ''}
                  {row.source?.includes('testnet-rate') ? ' · testnet rate' : ''}
                </div>
              </div>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: executable ? '#2F7D4F' : 'hsl(var(--muted-foreground))',
                  whiteSpace: 'nowrap',
                  paddingTop: '2px',
                }}
              >
                {row.executionLabel ?? (executable ? 'executable' : 'not executable')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
