import Fi from '../Fi';
import { type AssetInfo } from '../../hooks/useTreasuryData';

export default function AssetTable({
  assets,
  onRefresh,
  refreshing,
}: {
  assets: AssetInfo[];
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div>
      <div
        className="flex items-center justify-between gap-3 flex-wrap"
        style={{ marginBottom: '14px' }}
      >
        <h3
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: '14px',
            fontWeight: 600,
            margin: 0,
            color: 'hsl(var(--foreground))',
          }}
        >
          Holdings
        </h3>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 hover:underline underline-offset-4 bg-transparent border-0"
            style={{
              fontSize: '13px',
              color: 'hsl(var(--muted-foreground))',
              cursor: !refreshing ? 'pointer' : 'default',
            }}
          >
            <Fi icon="arrows-rotate" style={{ fontSize: '11px' }} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {assets.length === 0 ? (
        <div
          style={{
            padding: '20px 0',
            borderBottom: '1px solid hsl(var(--surface-2))',
            fontSize: '13.5px',
            color: 'hsl(var(--muted-foreground))',
          }}
        >
          No assets yet. Add funds to deposit SOL or tokens into the treasury.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {(['Asset', 'Balance', 'Value', 'Share'] as const).map((h, i) => (
                  <th
                    key={h}
                    style={{
                      fontSize: '11px',
                      fontWeight: 500,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'hsl(var(--faint))',
                      textAlign: i === 0 ? 'left' : 'right',
                      fontFamily: i === 0 ? 'var(--font-body)' : 'var(--font-mono)',
                      padding: i === 3 ? '8px 0' : '8px 10px 8px 0',
                      borderBottom: '1px solid hsl(var(--border))',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assets.map((a, idx) => {
                const isLast = idx === assets.length - 1;
                const cellBorder = isLast ? 'none' : '1px solid hsl(var(--surface-2))';
                return (
                  <tr key={`${a.symbol}-${a.name}-${idx}`}>
                    <td
                      style={{
                        fontSize: '13.5px',
                        padding: '12px 10px 12px 0',
                        borderBottom: cellBorder,
                        color: 'hsl(var(--foreground))',
                      }}
                    >
                      <strong style={{ fontWeight: 600 }}>{a.symbol}</strong>{' '}
                      <span style={{ color: 'hsl(var(--muted-foreground))' }}>· {a.name}</span>
                    </td>
                    <td
                      className="nave-mono"
                      style={{
                        fontSize: '12.5px',
                        textAlign: 'right',
                        padding: '12px 10px 12px 0',
                        borderBottom: cellBorder,
                        color: 'hsl(var(--foreground))',
                      }}
                    >
                      {a.balance.toLocaleString()}
                    </td>
                    <td
                      className="nave-mono"
                      style={{
                        fontSize: '12.5px',
                        fontWeight: 500,
                        textAlign: 'right',
                        padding: '12px 10px 12px 0',
                        borderBottom: cellBorder,
                        color: 'hsl(var(--foreground))',
                      }}
                    >
                      ${a.valueUsd.toLocaleString()}
                    </td>
                    <td
                      className="nave-mono"
                      style={{
                        fontSize: '12.5px',
                        textAlign: 'right',
                        padding: '12px 0',
                        borderBottom: cellBorder,
                        color: 'hsl(var(--muted-foreground))',
                      }}
                    >
                      {a.allocation.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
