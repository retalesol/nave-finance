interface ToggleProps {
  value: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  desc?: string;
}

export default function Toggle({ value, onChange, label, desc }: ToggleProps) {
  const hasText = label || desc;

  const track = (
    <button
      onClick={() => onChange(!value)}
      className="flex-shrink-0 relative rounded-full"
      aria-label={label ?? 'Toggle'}
      aria-checked={value}
      role="switch"
      style={{
        width: '40px',
        height: '22px',
        backgroundColor: value ? 'hsl(var(--accent))' : 'hsl(var(--border))',
        transition: 'background-color 0.2s',
      }}
    >
      <span
        className="absolute top-1 rounded-full"
        style={{
          width: '14px',
          height: '14px',
          backgroundColor: 'white',
          left: value ? '22px' : '4px',
          transition: 'left 0.2s',
        }}
      />
    </button>
  );

  if (!hasText) return track;

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        {label && (
          <div style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>
            {label}
          </div>
        )}
        {desc && (
          <div
            style={{
              fontSize: '12px',
              color: 'hsl(var(--muted-foreground))',
              marginTop: '1px',
            }}
          >
            {desc}
          </div>
        )}
      </div>
      {track}
    </div>
  );
}
