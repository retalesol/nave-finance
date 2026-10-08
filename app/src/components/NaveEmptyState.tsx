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
 * Reusable empty-state card matching the Nave design system.
 * Drop into any section where data is absent.
 */
export default function NaveEmptyState({ icon, title, description, action }: NaveEmptyStateProps) {
  return (
    <div
      className="rounded-xl border p-8 text-center"
      style={{
        backgroundColor: 'hsl(var(--surface-0))',
        borderColor: 'hsl(var(--border))',
      }}
    >
      <div
        className="mx-auto mb-4 flex items-center justify-center rounded-xl"
        style={{
          width: '56px',
          height: '56px',
          backgroundColor: 'hsl(var(--surface-1))',
          border: '1px solid hsl(var(--border))',
        }}
      >
        <Fi icon={icon} style={{ fontSize: '22px', color: 'hsl(var(--muted-foreground))' }} />
      </div>
      <h3
        className="text-display font-semibold"
        style={{ fontSize: '16px', color: 'hsl(var(--foreground))', marginBottom: '6px' }}
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
          onClick={action.onClick}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-all mt-5"
          style={{
            fontSize: '13px',
            backgroundColor: 'hsl(var(--primary))',
            color: 'hsl(var(--primary-foreground))',
            boxShadow: 'var(--shadow-sm)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = 'var(--shadow-md)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
          }}
        >
          {action.icon && <Fi icon={action.icon} style={{ fontSize: '12px' }} />}
          {action.label}
        </button>
      )}
    </div>
  );
}
