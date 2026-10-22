import Fi from './Fi';

interface NaveEmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: string;
  };
}

/**
 * Reusable empty-state block matching the calm demo.html aesthetic:
 * plain centered block with hairline top/bottom, serif/clean heading, and ink CTA.
 */
export default function NaveEmptyState({ icon, title, description, action }: NaveEmptyStateProps) {
  return (
    <div
      className="py-10 px-6 text-center border-t border-b"
      style={{
        borderColor: 'hsl(var(--surface-2))',
      }}
    >
      <div
        className="mx-auto mb-3 flex items-center justify-center rounded-full"
        style={{
          width: '40px',
          height: '40px',
          backgroundColor: '#ffffff',
          border: '1px solid hsl(var(--border))',
        }}
      >
        <Fi icon={icon} style={{ fontSize: '16px', color: 'hsl(var(--muted-foreground))' }} />
      </div>
      <h3
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: '15px',
          fontWeight: 600,
          color: 'hsl(var(--foreground))',
          margin: '0 0 6px',
        }}
      >
        {title}
      </h3>
      <p
        style={{
          fontSize: '13px',
          color: 'hsl(var(--muted-foreground))',
          lineHeight: 1.6,
          maxWidth: '400px',
          margin: '0 auto',
        }}
      >
        {description}
      </p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-colors mt-4"
          style={{
            fontSize: '13px',
            backgroundColor: '#111827',
            color: '#ffffff',
            border: '1px solid #111827',
          }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#1F2937')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#111827')}
        >
          {action.icon && <Fi icon={action.icon} style={{ fontSize: '12px' }} />}
          {action.label}
        </button>
      )}
    </div>
  );
}
