import {
  ASK_ANOTHER_CHECK_LABEL,
  CUSTOMER_STATUS_LABEL,
  HOW_CHECKED_LABEL,
  type CustomerStatus,
  everydaySentence,
} from '../../../supabase/functions/_shared/genlayerCharter.ts';

export interface CharterCheckStatusProps {
  status: CustomerStatus | null;
  /** Everyday sentence. Shown only when the check needs a closer look. */
  summary?: string;
  txId?: string;
  onAskAnother?: () => void;
  asking?: boolean;
}

const STATUS_COLOR: Record<CustomerStatus, string> = {
  checked: 'hsl(var(--success))',
  needs_closer_look: 'hsl(var(--warning))',
  still_checking: 'hsl(var(--muted-foreground))',
};

/**
 * One charter status for every chain. The words are Checked, Needs a closer
 * look, Still checking, and the action Ask for another check.
 */
export default function CharterCheckStatus({
  status,
  summary,
  txId,
  onAskAnother,
  asking = false,
}: CharterCheckStatusProps) {
  if (!status) return null;
  const label = CUSTOMER_STATUS_LABEL[status];
  const sentence = status === 'needs_closer_look' ? everydaySentence(summary) : '';
  const tx = (txId ?? '').trim();

  return (
    <div className="space-y-1.5" data-charter-status={status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className="inline-flex items-center gap-1.5"
          style={{ fontSize: '12.5px', color: STATUS_COLOR[status] }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATUS_COLOR[status] }} />
          {label}
        </span>
        <button
          type="button"
          onClick={onAskAnother}
          disabled={!onAskAnother || asking}
          style={{
            fontSize: '12.5px',
            color: 'hsl(var(--muted-foreground))',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: onAskAnother && !asking ? 'pointer' : 'default',
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
          }}
        >
          {ASK_ANOTHER_CHECK_LABEL}
        </button>
      </div>
      {sentence && (
        <p style={{ fontSize: '13px', color: 'hsl(var(--foreground))', lineHeight: 1.45 }}>
          {sentence}
        </p>
      )}
      {tx && (
      <details>
        <summary
          style={{
            fontSize: '11.5px',
            color: 'hsl(var(--muted-foreground))',
            cursor: 'pointer',
            width: 'fit-content',
          }}
        >
          {HOW_CHECKED_LABEL}
        </summary>
        <p
          className="mt-1"
          style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}
        >
          {`Transaction ${tx}`}
        </p>
      </details>
      )}
    </div>
  );
}
