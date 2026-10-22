export type ProposalPipelineStage = 'vote' | 'finalize' | 'execute' | 'complete';

const STEPS: { key: ProposalPipelineStage; label: string }[] = [
  { key: 'vote', label: 'Voting open' },
  { key: 'finalize', label: 'Finalize tally' },
  { key: 'execute', label: 'Carry out' },
];

function stageIndex(stage: ProposalPipelineStage): number {
  if (stage === 'complete') return STEPS.length;
  return STEPS.findIndex((s) => s.key === stage);
}

export default function ProposalStatusStepper({ stage }: { stage: ProposalPipelineStage }) {
  const current = stageIndex(stage);

  return (
    <div className="flex flex-wrap items-center gap-4" aria-label="Proposal progress">
      {STEPS.map((step, i) => {
        const done = current > i;
        const active = current === i && stage !== 'complete';

        return (
          <div key={step.key} className="inline-flex items-center gap-2">
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                border: `2px solid ${
                  done
                    ? '#2F7D4F'
                    : active
                      ? '#B9974F'
                      : '#CFC8B8'
                }`,
                backgroundColor: done
                  ? '#2F7D4F'
                  : active
                    ? '#B9974F'
                    : '#ffffff',
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: '12px',
                fontWeight: active ? 600 : 400,
                color: done || active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
              }}
            >
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
