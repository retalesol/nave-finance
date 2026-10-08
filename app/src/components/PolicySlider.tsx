interface PolicySliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  hint?: string;
  accent?: boolean;
}

export default function PolicySlider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  hint,
  accent = false,
}: PolicySliderProps) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>
            {label}
          </span>
          {hint && (
            <div
              style={{
                fontSize: '11.5px',
                color: 'hsl(var(--muted-foreground))',
                marginTop: '1px',
              }}
            >
              {hint}
            </div>
          )}
        </div>
        <span
          className="nave-mono font-semibold px-2 py-0.5 rounded"
          style={{
            fontSize: '13px',
            backgroundColor: accent
              ? 'hsl(var(--accent-muted))'
              : 'hsl(var(--surface-1))',
            color: accent
              ? 'hsl(var(--accent-muted-foreground))'
              : 'hsl(var(--foreground))',
            border: `1px solid ${
              accent ? 'hsl(var(--foreground))' : 'hsl(var(--border))'
            }`,
          }}
        >
          {value}
          {max === 100 ? '%' : ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full"
        aria-label={label}
        style={{
          background: `linear-gradient(to right, hsl(var(--accent)) 0%, hsl(var(--accent)) ${pct}%, hsl(var(--border)) ${pct}%, hsl(var(--border)) 100%)`,
        }}
      />
      <div
        className="flex justify-between"
        style={{
          fontSize: '10px',
          color: 'hsl(var(--muted-foreground))',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span>{min}%</span>
        <span>{max}%</span>
      </div>
    </div>
  );
}