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
    <div className="nave-card overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-4 border-b text-left"
        style={{ borderColor: 'hsl(var(--border))' }}
        onClick={() => collapsible && setOpen(o => !o)}
        aria-expanded={open}
        aria-label={collapsible ? `Toggle ${title}` : undefined}
      >
        <div className="flex items-center gap-2.5">
          {icon && (
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: 'hsl(var(--surface-2))' }}
            >
              <Fi icon={icon} style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }} />
            </div>
          )}
          <div>
          <span
            className="text-display font-semibold"
            style={{ fontSize: '14px' }}
          >
            {title}
          </span>
          {subtitle && (
            <div
              style={{
                fontSize: '12px',
                color: 'hsl(var(--muted-foreground))',
                marginTop: '2px',
              }}
            >
              {subtitle}
            </div>
          )}
          </div>
        </div>
        {collapsible && (
          <Fi
            icon={open ? 'chevron-up' : 'chevron-down'}
            style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))' }}
          />
        )}
      </button>
      {open && <div className="p-5">{children}</div>}
    </div>
  );
}