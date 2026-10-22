import { useState } from 'react';
import {
  ASK_ANOTHER_CHECK_LABEL,
  CUSTOMER_STATUS_LABEL,
  HOW_CHECKED_LABEL,
  counterevidenceError,
  type CustomerStatus,
  everydaySentence,
} from '../../../supabase/functions/_shared/genlayerCharter.ts';

export interface CharterCheckStatusProps {
  status: CustomerStatus | null;
  /** Everyday sentence. Shown only when the check needs a closer look. */
  summary?: string;
  txId?: string;
  onAskAnother?: (counterevidence: string) => void;
  asking?: boolean;
  askError?: string | null;
}

const STATUS_COLOR: Record<CustomerStatus, string> = {
  checked: '#2F7D4F',
  needs_closer_look: '#9A7414',
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
  askError = null,
}: CharterCheckStatusProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  if (!status) return null;
  const label = CUSTOMER_STATUS_LABEL[status];
  const sentence = status === 'needs_closer_look' ? everydaySentence(summary) : '';
  const tx = (txId ?? '').trim();
  const evidenceProblem = counterevidenceError(draft);
  const canSend = Boolean(onAskAnother) && !asking && !evidenceProblem;

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
          onClick={() => {
            if (!onAskAnother || asking) return;
            setOpen(true);
          }}
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
      {open && onAskAnother && (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const evidence = draft.trim();
            if (counterevidenceError(evidence) || asking) return;
            onAskAnother(evidence);
          }}
        >
          <label className="block" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
            What is new
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={2}
              required
              disabled={asking}
              className="mt-1 w-full rounded-md border px-2 py-1.5"
              style={{
                fontSize: '13px',
                color: 'hsl(var(--foreground))',
                borderColor: 'hsl(var(--border))',
                background: 'hsl(var(--surface-0))',
              }}
            />
          </label>
          <button
            type="submit"
            disabled={!canSend}
            style={{
              fontSize: '12.5px',
              color: 'hsl(var(--foreground))',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: canSend ? 'pointer' : 'default',
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
            }}
          >
            {asking ? 'Sending' : 'Send'}
          </button>
        </form>
      )}
      {askError && (
        <p style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))' }}>{askError}</p>
      )}
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
