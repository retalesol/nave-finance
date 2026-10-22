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
}: PolicySliderProps) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div
      style={{
        padding: '14px 0',
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      <div className="flex items-center justify-between" style={{ fontSize: '13.5px' }}>
        <b style={{ fontWeight: 500, color: 'hsl(var(--foreground))' }}>{label}</b>
        <span
          className="nave-mono"
          style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}
        >
          {value}
          {max === 100 ? '%' : ''}
        </span>
      </div>
      {hint && (
        <p
          style={{
            fontSize: '12.5px',
            color: 'hsl(var(--muted-foreground))',
            margin: '4px 0 8px',
          }}
        >
          {hint}
        </p>
      )}
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        aria-label={label}
        style={{
          accentColor: '#111827',
          background: `linear-gradient(to right, #111827 0%, #111827 ${pct}%, hsl(var(--border)) ${pct}%, hsl(var(--border)) 100%)`,
          marginTop: hint ? 0 : '8px',
        }}
      />
    </div>
  );
}
