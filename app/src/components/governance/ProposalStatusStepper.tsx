import Fi from '../Fi';

export type ProposalPipelineStage = 'vote' | 'finalize' | 'execute' | 'complete';

const STEPS: { key: ProposalPipelineStage; label: string }[] = [
  { key: 'vote', label: 'Vote' },
  { key: 'finalize', label: 'Finalize' },
  { key: 'execute', label: 'Execute' },
];

function stageIndex(stage: ProposalPipelineStage): number {
  if (stage === 'complete') return STEPS.length;
  return STEPS.findIndex((s) => s.key === stage);
}

export default function ProposalStatusStepper({ stage }: { stage: ProposalPipelineStage }) {
  const current = stageIndex(stage);

  return (
    <div className="flex items-center gap-1" aria-label="Proposal progress">
      {STEPS.map((step, i) => {
        const done = current > i;
        const active = current === i && stage !== 'complete';
        const upcoming = current < i;

        return (
          <div key={step.key} className="flex items-center gap-1 flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 border"
                style={{
                  fontSize: '9px',
                  fontFamily: 'var(--font-mono)',
                  backgroundColor: done
                    ? 'hsl(var(--accent))'
                    : active
                      ? 'hsl(var(--primary))'
                      : 'hsl(var(--surface-1))',
                  borderColor: done || active ? 'transparent' : 'hsl(var(--border))',
                  color: done || active ? 'white' : 'hsl(var(--muted-foreground))',
                }}
              >
                {done ? (
                  <Fi icon="check" style={{ fontSize: '9px' }} />
                ) : (
                  i + 1
                )}
              </div>
              <span
                className="truncate"
                style={{
                  fontSize: '11px',
                  fontWeight: active ? 600 : 400,
                  color: upcoming ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
                }}
              >
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className="flex-1 h-px mx-1"
                style={{
                  backgroundColor: done ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                  minWidth: '8px',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
