import type { CSSProperties, ReactNode } from 'react';
import { subscriptionLabel } from '../../lib/compass/format';

export const pageStyle: CSSProperties = {
  minHeight: '100vh',
  backgroundColor: 'hsl(var(--background))',
  color: 'hsl(var(--foreground))',
  fontFamily: 'var(--font-body)',
};

export const wrapStyle: CSSProperties = {
  width: 'min(1120px, calc(100% - 32px))',
  margin: '0 auto',
  padding: '28px 0 72px',
};

export const cardStyle: CSSProperties = {
  backgroundColor: 'hsl(var(--surface-0))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '12px',
  boxShadow: 'var(--shadow-xs)',
};

export const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid hsl(var(--border-strong))',
  borderRadius: '9px',
  backgroundColor: 'hsl(var(--surface-0))',
  color: 'hsl(var(--foreground))',
  font: 'inherit',
  fontSize: '14px',
  padding: '10px 12px',
};

export const buttonStyle: CSSProperties = {
  border: '1px solid hsl(var(--foreground))',
  borderRadius: '9px',
  backgroundColor: 'hsl(var(--foreground))',
  color: 'hsl(var(--primary-foreground))',
  font: 'inherit',
  fontSize: '13px',
  fontWeight: 600,
  padding: '9px 14px',
  cursor: 'pointer',
};

export const quietButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: 'transparent',
  color: 'hsl(var(--foreground))',
};

export const labelStyle: CSSProperties = {
  display: 'block',
  marginBottom: '6px',
  fontSize: '12px',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'hsl(var(--muted-foreground))',
};

export function sectionTitleStyle(): CSSProperties {
  return {
    fontFamily: 'var(--font-display)',
    fontSize: '32px',
    fontWeight: 400,
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
    margin: '0 0 8px',
  };
}

const pillColors: Record<string, { color: string; background: string }> = {
  active: { color: 'hsl(var(--success))', background: 'hsl(var(--success-muted))' },
  grace: { color: 'hsl(var(--warning))', background: 'hsl(var(--warning-muted))' },
  locked: { color: 'hsl(var(--destructive))', background: 'hsl(var(--destructive-muted))' },
  purged: { color: 'hsl(var(--muted-foreground))', background: 'hsl(var(--surface-1))' },
  none: { color: 'hsl(var(--muted-foreground))', background: 'hsl(var(--surface-1))' },
  private: { color: 'hsl(var(--foreground))', background: 'hsl(var(--surface-2))' },
};

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  const colors = pillColors[tone] ?? pillColors.none;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: '999px',
        padding: '2px 8px',
        fontSize: '12px',
        fontWeight: 600,
        color: colors?.color,
        backgroundColor: colors?.background,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function StatePill({ state }: { state: string }) {
  return <Pill tone={state}>{subscriptionLabel(state)}</Pill>;
}

export function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div style={{ ...cardStyle, padding: '14px 16px' }}>
      <div style={labelStyle}>{label}</div>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '30px',
          lineHeight: 1,
          letterSpacing: '-0.03em',
        }}
      >
        {value}
      </div>
      {detail ? (
        <div style={{ marginTop: '8px', color: 'hsl(var(--muted-foreground))', fontSize: '12px', lineHeight: 1.4 }}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: '12px 0 0', color: 'hsl(var(--destructive))', fontSize: '14px' }} role="alert">
      {children}
    </p>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, color: 'hsl(var(--muted-foreground))', fontSize: '14px', lineHeight: 1.5 }}>{children}</p>;
}
