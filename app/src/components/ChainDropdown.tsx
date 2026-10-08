import { useState, useRef, useEffect } from 'react';
import { USER_CHAINS, type ChainFamily } from '../lib/chain/types';
import { chainDisplayLabel } from '../lib/programConfig';
import Fi from './Fi';

/**
 * Compact chain-switcher for the header. Labels disclose the deployment
 * network (Solana Devnet, Ethereum Sepolia, Base/Robinhood Mainnet, etc.).
 */
export default function ChainDropdown({
  value,
  onChange,
}: {
  value: ChainFamily;
  onChange: (family: ChainFamily) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-colors"
        style={{
          fontSize: '12px',
          fontWeight: 500,
          color: 'hsl(var(--muted-foreground))',
          backgroundColor: 'hsl(var(--surface-1))',
          borderColor: 'hsl(var(--border))',
        }}
        onMouseEnter={e => (e.currentTarget.style.color = 'hsl(var(--foreground))')}
        onMouseLeave={e => (e.currentTarget.style.color = 'hsl(var(--muted-foreground))')}
        title="Switch network"
      >
        {chainDisplayLabel(value)}
        <Fi icon="chevron-down" style={{ fontSize: '9px' }} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 rounded-lg border z-50 overflow-hidden"
          style={{
            minWidth: '180px',
            backgroundColor: 'hsl(var(--card))',
            borderColor: 'hsl(var(--border))',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div
            style={{
              padding: '4px 10px 4px',
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'hsl(var(--muted-foreground))',
              borderBottom: '1px solid hsl(var(--border))',
            }}
          >
            Network
          </div>
          {USER_CHAINS.map((family) => {
            const active = family === value;
            return (
              <button
                key={family}
                type="button"
                onClick={() => { onChange(family); setOpen(false); }}
                className="w-full flex items-center justify-between px-3 py-2 text-left transition-colors"
                style={{
                  fontSize: '12.5px',
                  fontWeight: active ? 600 : 400,
                  color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  backgroundColor: active ? 'hsl(var(--surface-1))' : 'transparent',
                }}
                onMouseEnter={e => {
                  if (!active) e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))';
                }}
                onMouseLeave={e => {
                  if (!active) e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {chainDisplayLabel(family)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
