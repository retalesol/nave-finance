import Fi from '../Fi';
import { useAgentStatus } from '../../hooks/useAgentStatus';
import { useAgentHealth, timeAgo } from '../../hooks/useAgentHealth';
import { computeAgentStatus, summarizeAgentStatuses } from '../../lib/agentStatus';

const AGENT_ROLE_META: Record<string, { label: string; description: string }> = {
  executive:   { label: 'The Coordinator', description: 'Turns decisions into plans. Signs first.' },
  financial:   { label: 'The Investor',    description: 'Moves money to approved earning places. Signs second.' },
  oversight:   { label: 'The Guardrail',   description: 'Checks every move against your rules. Signs last — or refuses.' },
  operational: { label: 'The Watcher',     description: 'Watches around the clock. Can freeze everything instantly.' },
};

const AGENT_ROLES_ORDER = ['executive', 'financial', 'oversight', 'operational'] as const;

export default function AgentStatusPanel({
  navigate,
  daoAddress,
  agentStatus,
  frozen,
}: {
  navigate: (p: string) => void;
  daoAddress: string | null;
  agentStatus: ReturnType<typeof useAgentStatus>;
  frozen: boolean;
}) {
  const health = useAgentHealth(daoAddress);
  const hasOnChain = agentStatus.onChainData !== null;

  const rows = AGENT_ROLES_ORDER.map((role) => {
    const onChainAgent = agentStatus.agents.find((a) => a.role === role) ?? null;
    const healthEntry = health.agents.find((a) => a.role === role) ?? null;
    const status = computeAgentStatus({
      agentsEnabled: agentStatus.agentsEnabled,
      frozen,
      hasOnChain,
      onChain: onChainAgent
        ? { active: onChainAgent.active, nullified: onChainAgent.nullified, status: onChainAgent.status }
        : null,
      health: healthEntry,
    });
    return { role, healthEntry, status };
  });

  const summary = summarizeAgentStatuses(rows.map((r) => r.status));
  const operational = summary.level === 'active';
  const critical = summary.level === 'frozen' || summary.level === 'revoked';
  const summaryDot = critical
    ? 'hsl(var(--destructive))'
    : operational
      ? 'hsl(var(--success))'
      : 'hsl(var(--brass))';

  return (
    <div>
      {/* Summary row matching demo #pane-team */}
      <div
        className="flex items-start gap-3"
        style={{
          padding: '14px 0',
          borderBottom: '1px solid hsl(var(--surface-2))',
        }}
      >
        <span
          style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            backgroundColor: summaryDot,
            marginTop: '7px',
            flexShrink: 0,
          }}
        />
        <div className="flex-1 min-w-0">
          <h3
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '14px',
              fontWeight: 500,
              margin: 0,
              lineHeight: 1.4,
              color: 'hsl(var(--foreground))',
            }}
          >
            {summary.label}
          </h3>
          <p
            style={{
              fontSize: '13px',
              color: 'hsl(var(--muted-foreground))',
              margin: '3px 0 0',
              lineHeight: 1.55,
            }}
          >
            {agentStatus.actionLogs.length > 0
              ? `${agentStatus.actionLogs.length} actions logged · every move checked against your rules.`
              : 'Four specialists who can only act inside your constitutional rules.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/agents')}
          aria-label="View agent details"
          className="ml-auto flex-shrink-0 hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
          style={{
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            paddingTop: '2px',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'hsl(var(--foreground))';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
          }}
        >
          Meet them →
        </button>
      </div>

      {/* Individual specialist hairline rows */}
      {rows.map(({ role, healthEntry, status }, idx) => {
        const meta = AGENT_ROLE_META[role] || { label: role, description: '' };
        const isLast = idx === rows.length - 1;
        return (
          <div
            key={role}
            className="flex items-start gap-3"
            style={{
              padding: '13px 0',
              borderBottom: isLast ? 'none' : '1px solid hsl(var(--surface-2))',
            }}
          >
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                backgroundColor: status.color,
                marginTop: '7px',
                flexShrink: 0,
              }}
            />
            <div className="flex-1 min-w-0">
              <div
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: 'hsl(var(--foreground))',
                  lineHeight: 1.4,
                }}
              >
                {meta.label}
              </div>
              <div
                style={{
                  fontSize: '12.5px',
                  color: 'hsl(var(--muted-foreground))',
                  marginTop: '2px',
                  lineHeight: 1.5,
                }}
              >
                {meta.description}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2.5 flex-shrink-0" style={{ paddingTop: '2px' }}>
              {healthEntry?.last_confidence != null && (
                <span
                  className="nave-mono"
                  style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}
                >
                  {healthEntry.last_confidence}%
                </span>
              )}
              <span
                style={{
                  fontSize: '12px',
                  color: 'hsl(var(--faint))',
                  whiteSpace: 'nowrap',
                }}
              >
                {timeAgo(healthEntry?.last_action_at ?? null)}
              </span>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: status.color,
                  whiteSpace: 'nowrap',
                }}
              >
                {status.label}
              </span>
            </div>
          </div>
        );
      })}

      {health.error && (
        <div
          className="mt-2 flex items-start gap-1.5"
          style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}
        >
          <Fi icon="triangle-exclamation" style={{ fontSize: '11px', marginTop: '2px' }} />
          <span>Agent health unavailable — {health.error}</span>
        </div>
      )}
    </div>
  );
}
