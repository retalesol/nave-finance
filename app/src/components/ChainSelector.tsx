import { USER_CHAINS, type ChainFamily } from '../lib/chain/types';
import { chainDisplayLabel } from '../lib/programConfig';

/**
 * Chain picker offering EXACTLY the three Nave targets: Solana, Ethereum, Base.
 * There is intentionally no entry for any other chain. Used by CreateDAO and
 * TreasuryLobby to set the active chain family.
 */
export default function ChainSelector({
  value,
  onChange,
  label = 'Chain',
  hint,
  chains = USER_CHAINS,
}: {
  value: ChainFamily;
  onChange: (family: ChainFamily) => void;
  label?: string;
  hint?: string;
  /** Networks offered in this picker. Create passes Base only. */
  chains?: readonly ChainFamily[];
}) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500 }}>
          {label}
        </label>
      )}
      {hint && (
        <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}>
          {hint}
        </p>
      )}
      <div
        className="inline-flex items-center rounded-lg border p-0.5 gap-0.5"
        style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}
      >
        {chains.map((family) => {
          const sel = value === family;
          return (
            <button
              key={family}
              type="button"
              onClick={() => onChange(family)}
              className="px-3 py-1.5 rounded-md transition-all"
              style={{
                fontSize: '12.5px',
                fontWeight: sel ? 600 : 400,
                backgroundColor: sel ? 'hsl(var(--background))' : 'transparent',
                color: sel ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                boxShadow: sel ? '0 1px 3px hsl(var(--border) / 0.6)' : 'none',
                border: sel ? '1px solid hsl(var(--border))' : '1px solid transparent',
              }}
            >
              {chainDisplayLabel(family)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
