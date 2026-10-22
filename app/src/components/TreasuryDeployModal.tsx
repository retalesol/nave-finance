import NaveModal from './NaveModal';

export type DeployStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface DeployStep {
  id: string;
  label: string;
  status: DeployStepStatus;
  detail?: string;
}

interface TreasuryDeployModalProps {
  open: boolean;
  chainLabel: string;
  steps: DeployStep[];
  /** Shown under the step list while the wallet prompt is active. */
  activeHint?: string;
  error?: string | null;
  deploying: boolean;
  onClose: () => void;
  onRetry?: () => void;
}

/**
 * Guided overlay for multi-signature treasury deployment. Matches demo.html .progstep rows.
 */
export default function TreasuryDeployModal({
  open,
  chainLabel,
  steps,
  activeHint,
  error,
  deploying,
  onClose,
  onRetry,
}: TreasuryDeployModalProps) {
  const canClose = !deploying || !!error;
  const completed = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const total = steps.length;

  return (
    <NaveModal
      open={open}
      onClose={canClose ? onClose : () => {}}
      title="Launching your treasury"
      maxWidth={480}
      hideClose={!canClose}
    >
      <div style={{ padding: '18px 22px 22px' }} className="space-y-4">
        <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
          Confirm each step in your wallet on <strong style={{ color: 'hsl(var(--foreground))' }}>{chainLabel}</strong>.
          {' '}Stay on this screen — your wallet will open for each signature.
        </p>

        <div>
          {steps.map((step, idx) => {
            const isDone = step.status === 'done' || step.status === 'skipped';
            const isDoing = step.status === 'running';
            const isErr = step.status === 'error';
            return (
              <div
                key={step.id}
                className="flex items-start gap-2.5"
                style={{
                  padding: '9px 0',
                  fontSize: '13.5px',
                  color: isDoing
                    ? 'hsl(var(--foreground))'
                    : isDone
                      ? 'hsl(var(--muted-foreground))'
                      : isErr
                        ? 'hsl(var(--destructive))'
                        : 'hsl(var(--faint))',
                }}
              >
                <span
                  className="grid place-items-center flex-shrink-0"
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    border: `1.5px solid ${
                      isDone
                        ? 'hsl(var(--success))'
                        : isDoing
                          ? 'hsl(var(--foreground))'
                          : isErr
                            ? 'hsl(var(--destructive))'
                            : 'hsl(var(--border))'
                    }`,
                    backgroundColor: isDone ? 'hsl(var(--success))' : '#ffffff',
                    color: isDone
                      ? '#ffffff'
                      : isDoing
                        ? 'hsl(var(--foreground))'
                        : isErr
                          ? 'hsl(var(--destructive))'
                          : 'hsl(var(--faint))',
                    fontSize: '11px',
                    fontWeight: 500,
                  }}
                >
                  {isDone ? '✓' : isErr ? '!' : idx + 1}
                </span>
                <div className="flex-1 min-w-0 pt-0.5">
                  <div style={{ fontWeight: isDoing ? 600 : 400 }}>
                    {step.label}
                  </div>
                  {step.detail && (
                    <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '3px', lineHeight: 1.45 }}>
                      {step.detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {deploying && !error && (
          <div
            className="rounded-[12px] border p-3"
            style={{ backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--surface-2))', fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
          >
            {activeHint ?? 'Waiting for your wallet…'}
          </div>
        )}

        {error && (
          <div
            className="rounded-[12px] border p-3"
            style={{ backgroundColor: '#FFF9F8', borderColor: '#F2C7C2' }}
          >
            <p style={{ fontSize: '12.5px', color: '#B42318', lineHeight: 1.5, margin: 0 }}>
              {error}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
          <span style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}>
            {completed} of {total} steps complete
          </span>
          {error && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-4 py-2 rounded-[9px] font-semibold transition-all"
              style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </NaveModal>
  );
}
