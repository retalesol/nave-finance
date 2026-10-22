import { useState } from 'react';
import Fi from './Fi';

interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  icon?: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}

export default function CollapsibleSection({
  title,
  subtitle,
  icon,
  children,
  collapsible = false,
  defaultOpen = true,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      style={{
        padding: '26px 0',
        borderTop: '1px solid hsl(var(--surface-2))',
      }}
    >
      <button
        type="button"
        className={`w-full flex items-center justify-between gap-3 text-left ${collapsible ? 'cursor-pointer' : 'cursor-default'}`}
        style={{ marginBottom: open ? '16px' : 0 }}
        onClick={() => collapsible && setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={collapsible ? `Toggle ${title}` : undefined}
      >
        <div className="flex items-baseline gap-2.5 flex-wrap">
          {icon && (
            <Fi icon={icon} style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }} />
          )}
          <span
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '14px',
              fontWeight: 600,
              color: 'hsl(var(--foreground))',
            }}
          >
            {title}
          </span>
          {subtitle && (
            <span
              style={{
                fontSize: '12.5px',
                fontWeight: 400,
                color: 'hsl(var(--faint))',
              }}
            >
              {subtitle}
            </span>
          )}
        </div>
        {collapsible && (
          <Fi
            icon={open ? 'chevron-up' : 'chevron-down'}
            style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}
          />
        )}
      </button>
      {open && <div>{children}</div>}
    </section>
  );
}
