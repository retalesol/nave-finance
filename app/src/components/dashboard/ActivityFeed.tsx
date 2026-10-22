import { useState } from 'react';
import { type ActivityEntry } from '../../hooks/useActivityLog';
import { agentRoleLabel } from '../../lib/agentRoleLabel';
import { HairlineRow } from '../calm';
import NaveModal from '../NaveModal';

const STATUS_DOT: Record<string, string> = {
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--brass))',
  info: '#CBD5E1',
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

function humanizeEventType(eventType: string): string {
  return eventType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function rulesCheckedForActivity(item: ActivityEntry): string[] {
  if (item.agentRole === 'financial') {
    return [
      'Reserve stays at or above constitutional floor',
      'Destination is an approved earning place',
      'Position stays within single-place and total deployed caps',
    ];
  }
  if (item.agentRole === 'oversight') {
    return [
      'Guardrail verified every constitutional parameter',
      'Payload matches the approved action plan',
      'Reserve and concentration limits respected',
    ];
  }
  if (item.agentRole === 'executive') {
    return [
      'Action aligned with passed community decision',
      'Handed to Financial and Guardrail specialists for verification',
    ];
  }
  if (item.agentRole === 'operational') {
    return [
      'Watcher acted within Rule 06 monitoring powers',
      'Event written to the activity log automatically',
    ];
  }
  return [
    'Recorded on-chain in the treasury audit trail',
    'Verified against treasury governance rules',
  ];
}

export default function ActivityFeed({
  activities,
  onViewAll,
}: {
  activities: ActivityEntry[];
  onViewAll?: () => void;
}) {
  const [selectedItem, setSelectedItem] = useState<ActivityEntry | null>(null);
  const [showAllModal, setShowAllModal] = useState(false);
  const [copiedReceipt, setCopiedReceipt] = useState(false);

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

  function handleCopyReceipt(sig: string) {
    navigator.clipboard.writeText(sig);
    setCopiedReceipt(true);
    setTimeout(() => setCopiedReceipt(false), 1600);
  }

  const receiptValue = selectedItem
    ? selectedItem.txSignature || `act-${selectedItem.id}`
    : '';

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
              subtitle={
                item.agentRole
                  ? `${agentRoleLabel(item.agentRole)} · All rules checked`
                  : humanizeEventType(item.eventType)
              }
              when={whenStr}
              onClick={() => {
                setCopiedReceipt(false);
                setSelectedItem(item);
              }}
            />
          );
        })}
      </div>

      <div style={{ paddingTop: '14px' }}>
        <button
          type="button"
          onClick={() => {
            if (activities.length > 0) {
              setShowAllModal(true);
            } else {
              onViewAll?.();
            }
          }}
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

      {/* Activity detail modal */}
      {selectedItem && (
        <NaveModal
          open
          title={selectedItem.description}
          subtitle={formatActivityTime(selectedItem.blockTime ?? selectedItem.createdAt)}
          onClose={() => setSelectedItem(null)}
          maxWidth={480}
        >
          <div style={{ padding: '18px 22px 22px' }}>
            <p
              style={{
                fontSize: '13.5px',
                color: 'hsl(var(--muted-foreground))',
                lineHeight: 1.65,
                marginTop: 0,
              }}
            >
              {selectedItem.agentRole
                ? `${agentRoleLabel(selectedItem.agentRole)} carried out this action within your constitutional guardrails.`
                : `Recorded treasury event (${humanizeEventType(selectedItem.eventType)}).`}
            </p>

            <div className="nave-label" style={{ margin: '16px 0 6px' }}>
              Rules checked
            </div>
            <div>
              {rulesCheckedForActivity(selectedItem).map((check) => (
                <div
                  key={check}
                  className="flex items-start gap-2.5"
                  style={{
                    padding: '9px 0',
                    borderBottom: '1px solid hsl(var(--surface-2))',
                    fontSize: '13px',
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  <span style={{ color: 'hsl(var(--success))', fontWeight: 700 }}>✓</span>
                  <span>{check}</span>
                </div>
              ))}
            </div>

            <div
              className="flex items-center justify-between gap-4"
              style={{
                padding: '11px 0',
                borderBottom: '1px solid hsl(var(--surface-2))',
                fontSize: '13.5px',
                marginTop: '8px',
              }}
            >
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>By</span>
              <b style={{ fontWeight: 500, color: 'hsl(var(--foreground))' }}>
                {selectedItem.agentRole
                  ? agentRoleLabel(selectedItem.agentRole)
                  : selectedItem.actor
                    ? `${selectedItem.actor.slice(0, 6)}…${selectedItem.actor.slice(-4)}`
                    : 'Treasury'}
              </b>
            </div>

            <div
              className="flex items-center justify-between gap-4"
              style={{
                padding: '11px 0',
                borderBottom: '1px solid hsl(var(--surface-2))',
                fontSize: '13.5px',
              }}
            >
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>Receipt</span>
              <b
                className="nave-mono truncate"
                style={{
                  fontWeight: 500,
                  fontSize: '11.5px',
                  color: 'hsl(var(--foreground))',
                  maxWidth: '240px',
                }}
              >
                {receiptValue}
              </b>
            </div>

            <div
              className="flex items-center justify-end gap-2"
              style={{
                marginTop: '18px',
                paddingTop: '14px',
                borderTop: '1px solid hsl(var(--surface-2))',
              }}
            >
              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                className="px-3.5 py-2 rounded-[9px] font-semibold"
                style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => handleCopyReceipt(receiptValue)}
                className="px-3.5 py-2 rounded-[9px] border font-semibold"
                style={{
                  fontSize: '13px',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: copiedReceipt ? 'hsl(var(--success))' : 'hsl(var(--foreground))',
                }}
              >
                {copiedReceipt ? 'Copied ✓' : 'Copy receipt'}
              </button>
            </div>
          </div>
        </NaveModal>
      )}

      {/* All activity modal */}
      {showAllModal && (
        <NaveModal
          open
          title="All activity"
          subtitle="Every entry has a receipt."
          onClose={() => setShowAllModal(false)}
          maxWidth={540}
        >
          <div style={{ padding: '14px 22px 22px' }}>
            <div className="max-h-[380px] overflow-y-auto">
              {activities.map((item) => {
                const status = item.agentRole ? 'success' : 'info';
                const whenStr = formatActivityTime(item.blockTime ?? item.createdAt);
                return (
                  <HairlineRow
                    key={item.id}
                    dotColor={STATUS_DOT[status]}
                    title={item.description}
                    subtitle={
                      item.agentRole
                        ? agentRoleLabel(item.agentRole)
                        : humanizeEventType(item.eventType)
                    }
                    when={whenStr}
                    onClick={() => {
                      setShowAllModal(false);
                      setCopiedReceipt(false);
                      setSelectedItem(item);
                    }}
                  />
                );
              })}
            </div>
            <div
              className="flex justify-end"
              style={{
                marginTop: '16px',
                paddingTop: '14px',
                borderTop: '1px solid hsl(var(--surface-2))',
              }}
            >
              <button
                type="button"
                onClick={() => setShowAllModal(false)}
                className="px-4 py-2 rounded-[9px] font-semibold"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                }}
              >
                Done
              </button>
            </div>
          </div>
        </NaveModal>
      )}
    </div>
  );
}
