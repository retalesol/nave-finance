import { useState, type ReactNode } from 'react';
import Fi from '../Fi';

/* ── Section ────────────────────────────────────────────────── */
export interface SectionProps {
  title?: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  /** When true, omits the top hairline and top margin. */
  first?: boolean;
  className?: string;
  children: ReactNode;
}

export function Section({
  title,
  hint,
  action,
  first = false,
  className = '',
  children,
}: SectionProps) {
  return (
    <section
      className={className}
      style={{
        padding: first ? '0 0 30px' : '30px 0',
        borderTop: first ? 'none' : '1px solid hsl(var(--border))',
        marginTop: first ? 0 : '30px',
      }}
    >
      {(title || hint || action) && (
        <div
          className="flex items-center justify-between gap-3 flex-wrap"
          style={{ marginBottom: '18px' }}
        >
          <div className="flex items-baseline gap-2">
            {title && (
              <h2
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '14px',
                  fontWeight: 600,
                  margin: 0,
                  color: 'hsl(var(--foreground))',
                }}
              >
                {title}
              </h2>
            )}
            {hint && (
              <span
                style={{
                  fontSize: '12.5px',
                  fontWeight: 400,
                  color: 'hsl(var(--faint))',
                }}
              >
                {hint}
              </span>
            )}
          </div>
          {action && <div className="flex items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/* ── Stat ───────────────────────────────────────────────────── */
export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  caption?: ReactNode;
  tooltip?: ReactNode;
  className?: string;
}

export function Stat({
  label,
  value,
  caption,
  tooltip,
  className = '',
}: StatProps) {
  return (
    <div
      className={`relative group ${className}`}
      tabIndex={tooltip ? 0 : undefined}
      style={tooltip ? { cursor: 'help' } : undefined}
    >
      {tooltip && (
        <div
          role="tooltip"
          className="absolute z-30 left-0 right-0 bottom-[calc(100%+8px)] hidden group-hover:block group-focus-within:block"
        >
          <div
            className="rounded-xl border p-3"
            style={{
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            {tooltip}
          </div>
        </div>
      )}
      <div className="nave-label">{label}</div>
      <div
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: '19px',
          fontWeight: 600,
          letterSpacing: '-0.01em',
          margin: '5px 0 3px',
          color: 'hsl(var(--foreground))',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </div>
      {caption && (
        <div
          style={{
            margin: 0,
            fontSize: '12.5px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.5,
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}

/* ── Notice ─────────────────────────────────────────────────── */
export type NoticeTone = 'brass' | 'green' | 'red' | 'muted';

export interface NoticeProps {
  tone?: NoticeTone;
  action?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  children: ReactNode;
}

const NOTICE_DOT_COLORS: Record<NoticeTone, string> = {
  brass: 'hsl(var(--brass))',
  green: 'hsl(var(--success))',
  red: 'hsl(var(--destructive))',
  muted: 'hsl(var(--faint))',
};

export function Notice({
  tone = 'brass',
  action,
  actionLabel,
  onAction,
  className = '',
  children,
}: NoticeProps) {
  return (
    <div
      className={`flex items-center gap-2.5 flex-wrap ${className}`}
      style={{
        padding: '11px 0',
        borderTop: '1px solid hsl(var(--surface-2))',
        borderBottom: '1px solid hsl(var(--surface-2))',
        fontSize: '13.5px',
        color: 'hsl(var(--foreground))',
      }}
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          backgroundColor: NOTICE_DOT_COLORS[tone],
          flexShrink: 0,
        }}
      />
      <div className="flex-1 min-w-0">{children}</div>
      {action ? (
        <div className="ml-auto flex-shrink-0">{action}</div>
      ) : actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="ml-auto flex-shrink-0 hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
          style={{
            color: 'hsl(var(--foreground))',
            fontWeight: 600,
            fontSize: '13px',
            whiteSpace: 'nowrap',
          }}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/* ── HairlineRow ────────────────────────────────────────────── */
export interface HairlineRowProps {
  dotColor?: NoticeTone | string;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  when?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  expandableContent?: ReactNode;
  defaultExpanded?: boolean;
  className?: string;
  children?: ReactNode;
}

export function HairlineRow({
  dotColor,
  title,
  subtitle,
  meta,
  when,
  chevron = false,
  onClick,
  expandableContent,
  defaultExpanded = false,
  className = '',
  children,
}: HairlineRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isExpandable = Boolean(expandableContent);
  const isInteractive = Boolean(onClick || isExpandable);

  const resolvedDotColor = dotColor
    ? (NOTICE_DOT_COLORS[dotColor as NoticeTone] ?? dotColor)
    : undefined;

  function handleRowClick() {
    if (isExpandable) {
      setExpanded((prev) => !prev);
    }
    onClick?.();
  }

  return (
    <div
      className={className}
      style={{
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      <div
        role={isInteractive ? 'button' : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onClick={isInteractive ? handleRowClick : undefined}
        onKeyDown={
          isInteractive
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleRowClick();
                }
              }
            : undefined
        }
        className={`flex items-start gap-3 w-full text-left ${isInteractive ? 'cursor-pointer group' : ''}`}
        style={{ padding: '14px 0' }}
      >
        {resolvedDotColor && (
          <span
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              backgroundColor: resolvedDotColor,
              marginTop: '7px',
              flexShrink: 0,
            }}
          />
        )}
        <div className="flex-1 min-w-0">
          <div
            className={isInteractive ? 'group-hover:text-brass transition-colors' : ''}
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '14px',
              fontWeight: 500,
              lineHeight: 1.4,
              color: 'hsl(var(--foreground))',
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
                marginTop: '3px',
                lineHeight: 1.55,
              }}
            >
              {subtitle}
            </div>
          )}
          {children}
        </div>
        {(meta || when || chevron || isExpandable) && (
          <div
            className="flex items-center gap-2.5 ml-auto flex-shrink-0"
            style={{ paddingTop: '2px' }}
          >
            {meta}
            {when && (
              <span
                style={{
                  fontSize: '12px',
                  color: 'hsl(var(--faint))',
                  whiteSpace: 'nowrap',
                }}
              >
                {when}
              </span>
            )}
            {(chevron || isExpandable) && (
              <span style={{ color: 'hsl(var(--faint))', fontSize: '12px' }}>
                <Fi icon={expanded ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '11px' }} />
              </span>
            )}
          </div>
        )}
      </div>
      {isExpandable && expanded && (
        <div
          style={{
            padding: '2px 0 14px',
            paddingLeft: resolvedDotColor ? '19px' : '0',
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.6,
          }}
        >
          {expandableContent}
        </div>
      )}
    </div>
  );
}

/* ── SummaryLine ────────────────────────────────────────────── */
export interface SummaryLineProps {
  className?: string;
  children: ReactNode;
}

export function SummaryLine({ className = '', children }: SummaryLineProps) {
  return (
    <div
      className={`calm-summary-line ${className}`}
      style={{
        fontFamily: 'var(--font-display)',
        fontSize: '21px',
        lineHeight: 1.45,
        letterSpacing: '-0.01em',
        padding: '20px 0',
        borderTop: '1px solid hsl(var(--surface-2))',
        borderBottom: '1px solid hsl(var(--surface-2))',
        color: 'hsl(var(--foreground))',
      }}
    >
      {children}
    </div>
  );
}

/* ── UnderlineTabs ──────────────────────────────────────────── */
export interface UnderlineTabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  badge?: ReactNode;
}

export interface UnderlineTabsProps<T extends string = string> {
  tabs: readonly UnderlineTabItem<T>[];
  activeTab: T;
  onChange: (id: T) => void;
  className?: string;
}

export function UnderlineTabs<T extends string = string>({
  tabs,
  activeTab,
  onChange,
  className = '',
}: UnderlineTabsProps<T>) {
  return (
    <div
      role="tablist"
      className={`flex gap-5 border-b ${className}`}
      style={{
        borderColor: 'hsl(var(--border))',
        marginBottom: '6px',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className="inline-flex items-center gap-1.5 bg-transparent border-0 cursor-pointer transition-colors"
            style={{
              padding: '9px 1px',
              fontSize: '13.5px',
              fontWeight: active ? 600 : 400,
              color: active ? 'hsl(var(--foreground))' : 'hsl(var(--faint))',
              borderBottom: active
                ? '2px solid hsl(var(--foreground))'
                : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}
