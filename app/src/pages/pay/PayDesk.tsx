import type { CSSProperties, ReactNode } from 'react';
import { payBody, payCard, payPrimary, paySecondary, payTitle, statusColor } from './payStyles';

export type PayMetric = {
  label: string;
  value: string;
  detail?: string;
  tone?: 'default' | 'attention' | 'good';
};

export function PayPage({
  kicker = 'Nave Pay',
  title,
  purpose,
  actions,
  metrics,
  children,
}: {
  kicker?: string;
  title: string;
  purpose?: string;
  actions?: ReactNode;
  metrics?: PayMetric[];
  children?: ReactNode;
}) {
  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div className="nave-label" style={{ marginBottom: '8px' }}>{kicker}</div>
          <h1 style={{ ...payTitle, margin: 0 }}>{title}</h1>
          {purpose ? <p style={{ ...payBody, marginTop: '8px' }}>{purpose}</p> : null}
        </div>
        {actions ? <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>{actions}</div> : null}
      </header>
      {metrics && metrics.length > 0 ? (
        <section
          data-onboarding-id="pay-metrics"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))',
            gap: '10px',
          }}
        >
          {metrics.map((metric) => (
            <div key={metric.label} style={metricCard}>
              <div className="nave-label">{metric.label}</div>
              <div style={{ ...metricValue, color: metricTone(metric.tone) }}>{metric.value}</div>
              {metric.detail ? <div style={{ fontSize: '12.5px', color: '#6B7280', marginTop: '4px' }}>{metric.detail}</div> : null}
            </div>
          ))}
        </section>
      ) : null}
      {children}
    </div>
  );
}

export function PayChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            style={{
              ...(selected ? payPrimary : paySecondary),
              padding: '6px 10px',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function PayStage({
  title,
  detail,
  toolbar,
  children,
}: {
  title?: string;
  detail?: string;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={{ ...payCard, padding: 0, overflow: 'hidden' }}>
      {title || toolbar ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '12px',
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '14px 16px',
            borderBottom: '1px solid #EFEAE0',
          }}
        >
          <div>
            {title ? <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>{title}</div> : null}
            {detail ? <div style={{ fontSize: '12.5px', color: '#6B7280', marginTop: '2px' }}>{detail}</div> : null}
          </div>
          {toolbar}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PayLedger({ children }: { children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>{children}</table>
    </div>
  );
}

export function PayStatus({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: '99px',
        padding: '2px 8px',
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.01em',
        textTransform: 'capitalize',
        color,
        backgroundColor: `${color}14`,
      }}
    >
      {status}
    </span>
  );
}

export function PayStart({
  title,
  detail,
  steps,
  actionLabel,
  onAction,
}: {
  title: string;
  detail: string;
  steps: readonly string[];
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div style={{ padding: '28px 22px 24px' }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 400, fontSize: '26px', margin: '0 0 8px', letterSpacing: '-0.02em', color: '#111827' }}>
        {title}
      </h2>
      <p style={{ ...payBody, marginBottom: '16px' }}>{detail}</p>
      <ol style={{ margin: '0 0 18px', padding: 0, listStyle: 'none', display: 'grid', gap: '8px' }}>
        {steps.map((step, index) => (
          <li key={step} style={{ display: 'flex', gap: '10px', alignItems: 'baseline', fontSize: '14px', color: '#374151' }}>
            <span style={{ fontFamily: 'var(--font-display)', color: '#B9974F', minWidth: '18px' }}>{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {actionLabel && onAction ? (
        <button type="button" style={payPrimary} onClick={onAction}>{actionLabel}</button>
      ) : null}
    </div>
  );
}

export function PayWork({
  title,
  detail,
  action,
  onClick,
}: {
  title: string;
  detail: string;
  action: string;
  onClick?: () => void;
}) {
  const style: CSSProperties = {
    textAlign: 'left',
    background: '#ffffff',
    border: '1px solid #E7E2D6',
    borderRadius: '12px',
    padding: '14px 16px',
    cursor: onClick ? 'pointer' : 'default',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    minHeight: '124px',
    font: 'inherit',
    width: '100%',
  };
  const body = (
    <>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: '22px', color: '#111827', letterSpacing: '-0.02em' }}>{title}</span>
      <span style={{ fontSize: '13px', lineHeight: 1.5, color: '#6B7280' }}>{detail}</span>
      <span style={{ marginTop: 'auto', fontSize: '13px', fontWeight: 600, color: '#111827' }}>{action}</span>
    </>
  );
  if (!onClick) return <div style={style}>{body}</div>;
  return (
    <button type="button" onClick={onClick} style={style}>
      {body}
    </button>
  );
}

export const payTh: CSSProperties = {
  padding: '10px 14px',
  fontWeight: 600,
  fontSize: '11px',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: '#6B7280',
  textAlign: 'left',
  background: '#F7F4EE',
  borderBottom: '1px solid #E7E2D6',
  whiteSpace: 'nowrap',
};

export const payTd: CSSProperties = {
  padding: '12px 14px',
  color: '#111827',
  borderTop: '1px solid #EFEAE0',
  verticalAlign: 'middle',
};

const metricCard: CSSProperties = {
  background: '#ffffff',
  border: '1px solid #E7E2D6',
  borderRadius: '12px',
  padding: '12px 14px 13px',
};

const metricValue: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '26px',
  lineHeight: 1.15,
  letterSpacing: '-0.02em',
  marginTop: '8px',
  color: '#111827',
};

function metricTone(tone: PayMetric['tone']): string {
  if (tone === 'attention') return '#B42318';
  if (tone === 'good') return '#166534';
  return '#111827';
}
