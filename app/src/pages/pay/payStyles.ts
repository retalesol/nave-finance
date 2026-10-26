import type { CSSProperties } from 'react';

export const payTitle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 400,
  fontSize: '34px',
  lineHeight: 1.1,
  letterSpacing: '-0.02em',
  margin: '0 0 8px',
  color: '#111827',
};

export const payBody: CSSProperties = {
  fontSize: '14.5px',
  lineHeight: 1.6,
  color: '#6B7280',
  margin: 0,
  maxWidth: '640px',
};

export const payCard: CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #E7E2D6',
  borderRadius: '12px',
  padding: '16px',
};

export const payField: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  fontSize: '13px',
  color: '#374151',
};

export const payInput: CSSProperties = {
  border: '1px solid #E7E2D6',
  borderRadius: '9px',
  padding: '8px 10px',
  fontSize: '14px',
  color: '#111827',
  backgroundColor: '#fff',
  fontFamily: 'inherit',
};

export const payPrimary: CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  borderRadius: '9px',
  padding: '8px 14px',
  border: '1px solid #111827',
  backgroundColor: '#111827',
  color: '#ffffff',
  cursor: 'pointer',
};

export const paySecondary: CSSProperties = {
  ...payPrimary,
  backgroundColor: '#ffffff',
  color: '#111827',
};

export const payDanger: CSSProperties = {
  ...paySecondary,
  color: '#B42318',
  borderColor: '#F3C7C3',
};

export function statusColor(status: string): string {
  if (status === 'paid') return '#166534';
  if (status === 'overdue') return '#B42318';
  if (status === 'partial') return '#92400E';
  if (status === 'open') return '#1D4ED8';
  if (status === 'void') return '#6B7280';
  return '#374151';
}
