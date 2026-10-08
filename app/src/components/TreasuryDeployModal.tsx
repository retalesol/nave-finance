import Fi from './Fi';
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

function stepIcon(status: DeployStepStatus): { icon: string; color: string; spin?: boolean } {
  switch (status) {
    case 'done':
      return { icon: 'circle-check', color: 'hsl(var(--success))' };
    case 'error':
      return { icon: 'circle-xmark', color: 'hsl(var(--destructive))' };
    case 'skipped':
      return { icon: 'circle-minus', color: 'hsl(var(--muted-foreground))' };
    case 'running':
      return { icon: 'arrows-rotate', color: 'hsl(var(--primary))', spin: true };
    default:
      return { icon: 'circle', color: 'hsl(var(--muted-foreground))' };
  }
}

/**
 * Guided overlay for multi-signature treasury deployment. Keeps the wizard on the
 * review step while walking the user through each wallet confirmation.
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
      title="Deploying treasury"
      icon="rocket"
      maxWidth={480}
      hideClose={!canClose}
    >
      <div className="px-5 py-5 space-y-5">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
          Confirm each step in your wallet on <strong style={{ color: 'hsl(var(--foreground))' }}>{chainLabel}</strong>.
          {' '}Stay on this screen — your wallet will open for each signature.
        </p>

        <div className="space-y-2">
          {steps.map((step) => {
            const { icon, color, spin } = stepIcon(step.status);
            return (
              <div
                key={step.id}
                className="flex items-start gap-3 px-3 py-2.5 rounded-lg border"
                style={{
                  borderColor: step.status === 'running' ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                  backgroundColor:
                    step.status === 'running' ? 'hsl(var(--surface-1))' : 'hsl(var(--surface-0))',
                }}
              >
                <Fi
                  icon={icon}
                  className={spin ? 'animate-spin' : undefined}
                  style={{ fontSize: '13px', color, marginTop: '2px', flexShrink: 0 }}
                />
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: '13px', fontWeight: step.status === 'running' ? 600 : 500, color: 'hsl(var(--foreground))' }}>
                    {step.label}
                  </div>
                  {step.detail && (
                    <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '3px', lineHeight: 1.45 }}>
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
            className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg"
            style={{ backgroundColor: 'hsl(var(--accent-muted))', border: '1px solid hsl(var(--border-strong))' }}
          >
            <Fi icon="signature" style={{ fontSize: '13px', color: 'hsl(var(--primary))', flexShrink: 0 }} />
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--accent-muted-foreground))', lineHeight: 1.5 }}>
              {activeHint ?? 'Waiting for your wallet…'}
            </span>
          </div>
        )}

        {error && (
          <div
            className="px-3 py-3 rounded-lg border"
            style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
          >
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))', lineHeight: 1.5 }}>
              {error}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <span style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
            {completed} of {total} steps complete
          </span>
          {error && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-4 py-2 rounded-lg font-medium transition-all"
              style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </NaveModal>
  );
}
