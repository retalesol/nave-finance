const BARLINE_PALETTE = [
  'hsl(var(--brass))',
  'hsl(var(--foreground))',
  '#8FAE94',
  '#D6CFBE',
];

export default function AllocationDonut({
  allocation,
  onSelect,
}: {
  allocation: Array<{ name: string; value: number; color: string }>;
  onSelect?: (name: string) => void;
}) {
  if (allocation.length === 0) {
    return (
      <div
        style={{
          padding: '14px 0',
          borderBottom: '1px solid hsl(var(--surface-2))',
          fontSize: '13px',
          color: 'hsl(var(--muted-foreground))',
        }}
      >
        No allocation breakdown yet.
      </div>
    );
  }

  return (
    <div>
      {allocation.map((d, idx) => {
        const isLast = idx === allocation.length - 1;
        const barColor = BARLINE_PALETTE[idx % BARLINE_PALETTE.length];
        return (
          <div
            key={d.name}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onClick={onSelect ? () => onSelect(d.name) : undefined}
            onKeyDown={
              onSelect
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(d.name);
                    }
                  }
                : undefined
            }
            className={onSelect ? 'cursor-pointer group' : undefined}
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 1fr 56px',
              gap: '12px',
              alignItems: 'center',
              padding: '10px 0',
              borderBottom: isLast ? 'none' : '1px solid hsl(var(--surface-2))',
              fontSize: '13px',
            }}
          >
            <span
              className={`truncate ${onSelect ? 'group-hover:text-brass transition-colors' : ''}`}
              style={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}
            >
              {d.name}
            </span>
            <span
              style={{
                height: '5px',
                backgroundColor: 'hsl(var(--surface-2))',
                borderRadius: '99px',
                overflow: 'hidden',
                display: 'block',
              }}
            >
              <i
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.min(100, Math.max(0, d.value))}%`,
                  backgroundColor: barColor,
                  borderRadius: '99px',
                }}
              />
            </span>
            <span
              className="nave-mono"
              style={{
                textAlign: 'right',
                fontSize: '12px',
                color: 'hsl(var(--muted-foreground))',
              }}
            >
              {d.value.toFixed(d.value % 1 === 0 ? 0 : 1)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
