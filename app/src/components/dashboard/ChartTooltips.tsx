export function TreasuryTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number; name: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-[10px] border px-3 py-2.5"
      style={{
        backgroundColor: '#ffffff',
        borderColor: 'hsl(var(--border))',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div
        style={{
          fontSize: '10.5px',
          color: 'hsl(var(--faint))',
          fontFamily: 'var(--font-mono)',
          marginBottom: '4px',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      {payload.map(p => (
        <div
          key={p.name}
          className="flex items-center gap-2"
          style={{
            fontSize: '13px',
            color: 'hsl(var(--foreground))',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span style={{ fontWeight: 600 }}>
            {p.name === 'value' ? '$' + p.value.toLocaleString() : '+$' + p.value}
          </span>
          <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: '11px' }}>
            {p.name === 'value' ? 'balance' : 'yield'}
          </span>
        </div>
      ))}
    </div>
  );
}

export function YieldTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-[10px] border px-3 py-2"
      style={{
        backgroundColor: '#ffffff',
        borderColor: 'hsl(var(--border))',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div
        style={{
          fontSize: '10.5px',
          color: 'hsl(var(--faint))',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '13px',
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          color: 'hsl(var(--success))',
          marginTop: '2px',
        }}
      >
        +${payload[0].value.toLocaleString()}
      </div>
    </div>
  );
}
