import { type ActivityEntry } from '../../hooks/useActivityLog';
import { agentRoleLabel } from '../../lib/agentRoleLabel';
import { HairlineRow } from '../calm';

const STATUS_DOT: Record<string, string> = {
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--brass))',
  info:    '#CBD5E1',
};

function formatActivityTime(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ActivityFeed({
  activities,
  onViewAll,
}: {
  activities: ActivityEntry[];
  onViewAll?: () => void;
}) {
  if (activities.length === 0) {
    return (
      <div
        style={{
          padding: '24px 0',
          borderBottom: '1px solid hsl(var(--surface-2))',
          fontSize: '13.5px',
          color: 'hsl(var(--muted-foreground))',
        }}
      >
        No activity yet. Treasury actions and proposals will appear here.
      </div>
    );
  }

  return (
    <div>
      <div>
        {activities.slice(0, 8).map((item) => {
          const status = item.agentRole ? 'success' : 'info';
          const whenStr = formatActivityTime(item.blockTime ?? item.createdAt);
          return (
            <HairlineRow
              key={item.id}
              dotColor={STATUS_DOT[status]}
              title={item.description}
              subtitle={item.agentRole ? agentRoleLabel(item.agentRole) : item.eventType}
              when={whenStr}
            />
          );
        })}
      </div>
      {onViewAll && (
        <div style={{ paddingTop: '14px' }}>
          <button
            type="button"
            onClick={onViewAll}
            className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
            style={{
              fontSize: '13px',
              color: 'hsl(var(--muted-foreground))',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'hsl(var(--foreground))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
            }}
          >
            View all activity →
          </button>
        </div>
      )}
    </div>
  );
}
