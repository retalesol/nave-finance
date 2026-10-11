import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { motion } from 'framer-motion';
import Fi from '../components/Fi';
import NaveModal from '../components/NaveModal';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import { staggerContainer, staggerChild } from '../components/PageTransition';
import { useDaoContext } from '../hooks/useDaoContext';
import { useAgentStatus, type AgentStatusInfo, type AgentActionLog } from '../hooks/useAgentStatus';
import { useActivityLog } from '../hooks/useActivityLog';
import { useAgentHealth, getAgentHealthLevel, timeAgo } from '../hooks/useAgentHealth';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useDaoMembership } from '../hooks/useDaoMembership';
import { useTreasuryBalance } from '../hooks/useTreasuryBalance';
import { useExecutionPipeline, type ExecutionInfo } from '../hooks/useExecutionPipeline';
import { ExecutionStatus, AgentStatus } from '../lib/onChainTypes';
import { isMockDaoAddress } from '../lib/mockData';
import { AGENT_ENABLE_PROPOSAL_TITLE } from '../lib/programConfig';
import { computeAgentStatus, type AgentStatusDisplay } from '../lib/agentStatus';
import { agentRoleLabel } from '../lib/agentRoleLabel';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { useAccount, useSignMessage, useSignTypedData } from 'wagmi';
import { setAgentsEnabledViaProxyEvm } from '../lib/edgeFunctionClient';
import { buildEmergencyPauseAgents } from '../lib/transactionBuilders';

/* ── Confirm Dialog ─────────────────────────────────────── */
function ConfirmAgentToggleModal({
  open,
  active,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  active: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <NaveModal
      open={open}
      onClose={onCancel}
      title={active ? 'Pause All Agents?' : 'Resume All Agents?'}
      icon={active ? 'pause' : 'play'}
      maxWidth={384}
    >
      <div className="px-5 py-4 space-y-4">
        <p style={{ fontSize: '13.5px', lineHeight: 1.6, color: 'hsl(var(--muted-foreground))' }}>
          {active
            ? 'Pausing disconnects this DAO from the four Nave agents immediately. Your wallet signs a single emergency_pause_agents transaction — no other signatures are required. Funds remain secure, and you can resume the agents later via a governance proposal.'
            : 'Agents will resume all autonomous operations under the current constitutional policy. Any pending operations will execute in sequence.'}
        </p>
        {active && (
          <p style={{ fontSize: '12px', lineHeight: 1.5, color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' }}>
            Any founder or guardian can pause instantly. This action is scoped to this DAO only and does not affect other treasuries.
          </p>
        )}
        <div className="flex items-center gap-2 pb-1">
          <button
            onClick={onConfirm}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
            style={{
              fontSize: '13.5px',
              backgroundColor: active ? 'hsl(var(--destructive))' : 'hsl(var(--primary))',
              color: 'white',
            }}
          >
            <Fi icon={active ? 'pause' : 'play'} style={{ fontSize: '12px' }} />
            {active ? 'Pause Agents' : 'Resume Agents'}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-lg border transition-colors"
            style={{ fontSize: '13.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          >
            Cancel
          </button>
        </div>
      </div>
    </NaveModal>
  );
}

/* ── Agent definitions ─────────────────────────────────── */
const AGENTS = [
  {
    id: 'executive',
    role: 'Executive Agent',
    tag: 'Strategic Coordinator',
    icon: 'crown',
    responsibilities: [
      'Interprets DAO governance proposals',
      'Coordinates treasury intent',
      'Validates constitutional alignment',
      'Signs first multisig approval',
    ],
    status: 'active' as const,
    lastAction: '4m ago',
    actionsToday: 3,
    signsTransactions: true,
  },
  {
    id: 'financial',
    role: 'Financial Agent',
    tag: 'Operations Layer',
    icon: 'money-bill-wave',
    responsibilities: [
      'Treasury execution and yield optimization',
      'Capital deployment and allocation',
      'Transaction preparation',
      'Signs second multisig approval',
    ],
    status: 'active' as const,
    lastAction: '2m ago',
    actionsToday: 7,
    signsTransactions: true,
  },
  {
    id: 'oversight',
    role: 'Operational Agent',
    tag: 'Safeguard Layer',
    icon: 'eye',
    responsibilities: [
      'Constitutional policy enforcement',
      'Reviews Executive and Financial decisions',
      'Validates treasury compliance',
      'Signs final multisig approval',
    ],
    status: 'active' as const,
    lastAction: '2m ago',
    actionsToday: 7,
    signsTransactions: true,
  },
  {
    id: 'operational',
    role: 'Oversight Agent',
    tag: 'Monitoring Layer',
    icon: 'gear',
    responsibilities: [
      'Treasury monitoring and accounting',
      'Analytics and optimization recommendations',
      'Suspicious activity detection',
      'Emergency halt capabilities',
    ],
    status: 'active' as const,
    lastAction: '1m ago',
    actionsToday: 14,
    signsTransactions: false,
  },
];

const ACTIVITY_LOG = [
  { id: 1, desc: 'Financial Agent deployed capital to approved yield strategy', agent: 'Financial', time: '2m ago', status: 'success' },
  { id: 2, desc: 'Operational Agent validated: transaction within policy bounds', agent: 'Operational', time: '2m ago', status: 'success' },
  { id: 3, desc: 'Oversight Agent flagged: stablecoin reserve approaching floor', agent: 'Oversight', time: '14m ago', status: 'warning' },
  { id: 4, desc: 'Financial Agent deployed SOL via liquid staking strategy', agent: 'Financial', time: '45m ago', status: 'success' },
  { id: 5, desc: 'Executive Agent initiated rebalance based on governance mandate', agent: 'Executive', time: '1h ago', status: 'success' },
  { id: 6, desc: 'Oversight Agent: policy compliance check passed', agent: 'Oversight', time: '2h ago', status: 'success' },
];

function statusColor(s: string) {
  if (s === 'success' || s === 'complete') return 'hsl(var(--success))';
  if (s === 'warning' || s === 'pending') return 'hsl(var(--warning))';
  return 'hsl(var(--muted-foreground))';
}

/* ── Agent Card ─────────────────────────────────────────── */
function AgentCard({ agent, frozen = false }: { agent: Omit<typeof AGENTS[0], 'status'> & { status: string; statusDisplay: AgentStatusDisplay }; frozen?: boolean }) {
  const { statusDisplay } = agent;
  const enabled = statusDisplay.enabled;
  return (
    <div className="nave-card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center"
            style={{
              backgroundColor: enabled ? 'hsl(var(--primary))' : 'hsl(var(--surface-2))',
              transition: 'background-color 0.2s',
            }}
          >
            <Fi
              icon={agent.icon}
              style={{ fontSize: '16px', color: enabled ? 'white' : 'hsl(var(--muted-foreground))' }}
            />
          </div>
          <div>
            <div style={{ fontSize: '14px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>{agent.role}</div>
            <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))', letterSpacing: '0.04em' }}>
              {agent.tag}
            </div>
          </div>
        </div>
        <span
          className="px-2 py-0.5 rounded-full"
          style={{
            fontSize: '11px',
            fontWeight: 500,
            fontFamily: 'var(--font-mono)',
            color: statusDisplay.color,
            backgroundColor: statusDisplay.bg,
            letterSpacing: '0.04em',
          }}
        >
          {statusDisplay.label}
        </span>
      </div>

      <div className="space-y-1.5 mb-4">
        {agent.responsibilities.map(r => (
          <div key={r} className="flex items-start gap-2">
            <Fi icon="angle-right" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', flexShrink: 0, marginTop: '3px' }} />
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>{r}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-4 pt-3 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
        <div>
          <div className="nave-label" style={{ fontSize: '9px' }}>Last Action</div>
          <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: 'hsl(var(--foreground))' }}>{agent.lastAction}</div>
        </div>
        <div>
          <div className="nave-label" style={{ fontSize: '9px' }}>24h Ops</div>
          <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: 'hsl(var(--foreground))' }}>{agent.actionsToday} ops</div>
        </div>
        <div>
          <div className="nave-label" style={{ fontSize: '9px' }}>Signing</div>
          <div
            className="nave-mono"
            style={{ fontSize: '12px', marginTop: '2px', color: agent.signsTransactions ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}
          >
            {agent.signsTransactions ? 'Yes' : 'No'}
          </div>
        </div>
        {frozen && (
          <div className="ml-auto">
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
              style={{
                fontSize: '9px',
                fontFamily: 'var(--font-mono)',
                backgroundColor: 'hsl(var(--destructive-muted))',
                color: 'hsl(0 60% 40%)',
                letterSpacing: '0.06em',
              }}
            >
              <Fi icon="lock" style={{ fontSize: '7px' }} />
              FROZEN
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Execution Pipeline ─────────────────────────────────── */
const EXECUTION_STAGES: Array<{ status: ExecutionStatus; label: string; agent: string }> = [
  { status: ExecutionStatus.Pending, label: 'Created — awaiting Executive approval', agent: 'Executive' },
  { status: ExecutionStatus.ExecutiveApproved, label: 'Executive approved — awaiting Financial', agent: 'Financial' },
  { status: ExecutionStatus.FinancialApproved, label: 'Financial approved — awaiting Operational', agent: 'Operational' },
  { status: ExecutionStatus.OversightApproved, label: 'Operational approved — entering review', agent: 'Oversight' },
  { status: ExecutionStatus.InReview, label: 'In review window — Oversight monitoring', agent: 'Oversight' },
  { status: ExecutionStatus.Executed, label: 'Executed on-chain', agent: 'Oversight' },
];

function executionStatusLabel(status: ExecutionStatus): { label: string; tone: 'complete' | 'pending' | 'halt' } {
  switch (status) {
    case ExecutionStatus.Executed:
      return { label: 'Executed', tone: 'complete' };
    case ExecutionStatus.Halted:
      return { label: 'Halted', tone: 'halt' };
    case ExecutionStatus.Expired:
      return { label: 'Expired', tone: 'halt' };
    default:
      return { label: 'In progress', tone: 'pending' };
  }
}

function LiveExecutionRow({ exec }: { exec: ExecutionInfo }) {
  const { label, tone } = executionStatusLabel(exec.status);
  const currentStageIdx = EXECUTION_STAGES.findIndex(s => s.status === exec.status);
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'hsl(var(--border))' }}>
      <div className="flex items-center justify-between mb-2">
        <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>
          {exec.proposal.slice(0, 8)}…{exec.proposal.slice(-4)} · {exec.protocolName || 'strategy'}
        </span>
        <span style={{
          fontSize: '11px', fontWeight: 500,
          color: tone === 'complete' ? 'hsl(var(--success))' : tone === 'halt' ? 'hsl(var(--destructive))' : 'hsl(var(--warning))',
        }}>{label}</span>
      </div>
      <div className="space-y-1">
        {EXECUTION_STAGES.map((stage) => {
          const stageIdx = EXECUTION_STAGES.indexOf(stage);
          const done = currentStageIdx >= 0 && stageIdx < currentStageIdx;
          const active = stageIdx === currentStageIdx;
          if (exec.status === ExecutionStatus.Executed && stage.status !== ExecutionStatus.Executed && stageIdx > 0) {
            // collapse intermediate stages once executed
          }
          return (
            <div key={stage.status} className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0" style={{
                backgroundColor: done || (active && exec.status === ExecutionStatus.Executed) ? 'hsl(var(--primary))' : 'hsl(var(--surface-2))',
                border: active && exec.status !== ExecutionStatus.Executed ? '2px solid hsl(var(--warning))' : 'none',
              }}>
                {done ? <Fi icon="check" style={{ fontSize: '8px', color: 'white' }} /> : null}
              </div>
              <span style={{ fontSize: '12px', color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}>{stage.label}</span>
            </div>
          );
        })}
        {exec.operationalHalt && (
          <div style={{ fontSize: '11px', color: 'hsl(var(--destructive))', marginTop: '4px' }}>
            Halt: {exec.operationalHaltReason || 'flagged by Oversight agent'}
          </div>
        )}
        {exec.status === ExecutionStatus.InReview && exec.timeRemainingSeconds > 0 && (
          <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginTop: '4px' }}>
            Review window: {Math.ceil(exec.timeRemainingSeconds / 60)}m remaining
          </div>
        )}
      </div>
    </div>
  );
}

/** Failed-check detail from a persisted constitution_check, or null when it passed. */
function constitutionBlockDetail(check: Record<string, unknown> | null | undefined): string | null {
  if (!check || typeof check !== 'object') return null;
  const checks = check.checks;
  if (Array.isArray(checks)) {
    const failed = checks.filter((entry): entry is { ok?: boolean; indeterminate?: boolean; detail?: string; id?: string } => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as { ok?: boolean; indeterminate?: boolean };
      return row.ok === false || row.indeterminate === true;
    });
    if (failed.length > 0) {
      return failed
        .map((entry) => (typeof entry.detail === 'string' && entry.detail) || (typeof entry.id === 'string' && entry.id) || 'Check failed')
        .join(' ');
    }
    if (check.pass === false) {
      return listedFailures(check) ?? 'A constitution check failed.';
    }
    return null;
  }
  if (check.pass === false) {
    return listedFailures(check) ?? (typeof check.details === 'string' ? check.details : 'A constitution check failed.');
  }
  const failedFlags = Object.entries(check).filter(([key, value]) => key !== 'details' && key !== 'pass' && value === false);
  if (failedFlags.length === 0) return null;
  const names = failedFlags.map(([key]) => key.replace(/_/g, ' ')).join(', ');
  const details = typeof check.details === 'string' ? check.details : '';
  return details ? `${names}: ${details}` : names;
}

function listedFailures(check: Record<string, unknown>): string | null {
  if (!Array.isArray(check.failures)) return null;
  const lines = check.failures.map((item) => String(item)).filter(Boolean);
  return lines.length > 0 ? lines.join(' ') : null;
}

function ExecutionPipeline({
  executions,
  loading,
}: {
  executions: ExecutionInfo[];
  loading: boolean;
}) {
  return (
    <div className="nave-card">
      <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'hsl(var(--border))' }}>
        <div>
          <span style={{ fontSize: '14px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>Execution Pipeline</span>
          <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '1px' }}>3-key autonomous multisig coordination</div>
        </div>
        <Fi icon="lock-keyhole" style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }} />
      </div>
      <div className="p-5 space-y-3">
        {loading && (
          <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>Loading execution requests…</div>
        )}
        {!loading && executions.length === 0 && (
          <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
            No active execution requests. Passed strategy proposals will appear here as they move through the agent pipeline.
          </div>
        )}
        {executions.map((exec) => (
          <LiveExecutionRow key={exec.proposal} exec={exec} />
        ))}
      </div>
    </div>
  );
}

/* ── Decision color helpers ─────────────────────────────── */
function decisionColor(decision: string | null): string {
  if (!decision) return 'hsl(var(--muted-foreground))';
  if (decision === 'approve' || decision === 'continue') return 'hsl(var(--success))';
  if (decision === 'reject' || decision === 'halt') return 'hsl(var(--destructive))';
  if (decision === 'request_review' || decision === 'clear_halt') return 'hsl(var(--warning))';
  return 'hsl(var(--muted-foreground))';
}

function decisionLabel(decision: string | null): string {
  if (!decision) return 'Pending';
  return decision.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function confidenceColor(score: number | null): string {
  if (score === null) return 'hsl(var(--muted-foreground))';
  if (score >= 80) return 'hsl(var(--success))';
  if (score >= 60) return 'hsl(var(--warning))';
  return 'hsl(var(--destructive))';
}

function roleLabel(role: string): string {
  return agentRoleLabel(role);
}

/* ── Constitution Check Display ────────────────────────── */
function ConstitutionCheckPanel({ check }: { check: Record<string, unknown> }) {
  const entries = Object.entries(check).filter(([k]) => k !== 'details');
  const details = check.details as string | undefined;
  if (entries.length === 0 && !details) return null;

  return (
    <div className="mt-2">
      <div className="nave-label" style={{ fontSize: '9px', marginBottom: '6px' }}>Constitution Check</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([key, val]) => (
          <span
            key={key}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
            style={{
              fontSize: '10.5px',
              fontFamily: 'var(--font-mono)',
              backgroundColor: val ? 'hsl(var(--success-muted))' : 'hsl(var(--destructive-muted))',
              color: val ? 'hsl(152 50% 28%)' : 'hsl(0 60% 40%)',
              letterSpacing: '0.02em',
            }}
          >
            <Fi icon={val ? 'check' : 'xmark'} style={{ fontSize: '8px' }} />
            {key.replace(/_/g, ' ')}
          </span>
        ))}
      </div>
      {details && (
        <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '6px', lineHeight: 1.5, fontStyle: 'italic' }}>
          {details}
        </p>
      )}
    </div>
  );
}

/* ── Claude Reasoning Activity Log ────────────────────── */
function ClaudeActivityLog({ logs, onRefresh }: { logs: AgentActionLog[]; onRefresh: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="nave-card">
      <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'hsl(var(--border))' }}>
        <div>
          <span style={{ fontSize: '14px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>Agent Reasoning Log</span>
          <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '1px' }}>Claude Sonnet-powered autonomous decisions</div>
        </div>
        <button onClick={onRefresh} aria-label="Refresh log" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <Fi icon="arrows-rotate" style={{ fontSize: '12px' }} />
        </button>
      </div>
      <div className="divide-y" style={{ borderColor: 'hsl(var(--border))' }}>
        {logs.map(log => {
          const isExpanded = expandedId === log.id;
          const hasRiskFlags = log.riskFlags && log.riskFlags.length > 0;
          const hasConstitutionCheck = log.constitutionCheck && Object.keys(log.constitutionCheck).length > 0;

          return (
            <div key={log.id}>
              <button
                className="w-full flex items-start gap-3 px-5 py-3.5 text-left transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                {/* Status dot */}
                <div
                  className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0"
                  style={{ backgroundColor: decisionColor(log.decision) }}
                />

                {/* Main content */}
                <div className="flex-1 min-w-0">
                  <p style={{ fontSize: '13px', color: 'hsl(var(--foreground))', lineHeight: 1.5 }}>
                    {log.reasoning.length > 120 ? `${log.reasoning.slice(0, 120)}...` : log.reasoning}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                      style={{
                        fontSize: '10px',
                        fontFamily: 'var(--font-mono)',
                        backgroundColor: 'hsl(var(--surface-2))',
                        color: 'hsl(var(--foreground))',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {roleLabel(log.agentRole)}
                    </span>
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                      style={{
                        fontSize: '10px',
                        fontFamily: 'var(--font-mono)',
                        backgroundColor: 'hsl(var(--surface-2))',
                        color: 'hsl(var(--muted-foreground))',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {log.actionType}
                    </span>
                    {log.decision && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full"
                        style={{
                          fontSize: '10px',
                          fontFamily: 'var(--font-mono)',
                          color: decisionColor(log.decision),
                          backgroundColor:
                            log.decision === 'approve' || log.decision === 'continue'
                              ? 'hsl(var(--success-muted))'
                              : log.decision === 'reject' || log.decision === 'halt'
                                ? 'hsl(var(--destructive-muted))'
                                : 'hsl(var(--warning-muted))',
                        }}
                      >
                        <Fi
                          icon={
                            log.decision === 'approve' || log.decision === 'continue'
                              ? 'check'
                              : log.decision === 'reject' || log.decision === 'halt'
                                ? 'xmark'
                                : 'clock'
                          }
                          style={{ fontSize: '7px' }}
                        />
                        {decisionLabel(log.decision)}
                      </span>
                    )}
                    {log.confidenceScore !== null && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                        style={{
                          fontSize: '10px',
                          fontFamily: 'var(--font-mono)',
                          color: confidenceColor(log.confidenceScore),
                          backgroundColor: 'hsl(var(--surface-2))',
                        }}
                      >
                        <Fi icon="signal" style={{ fontSize: '7px' }} />
                        {log.confidenceScore}%
                      </span>
                    )}
                    {hasRiskFlags && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full"
                        style={{
                          fontSize: '10px',
                          fontFamily: 'var(--font-mono)',
                          color: 'hsl(var(--warning))',
                          backgroundColor: 'hsl(var(--warning-muted))',
                        }}
                      >
                        <Fi icon="triangle-exclamation" style={{ fontSize: '7px' }} />
                        {log.riskFlags.length} flag{log.riskFlags.length > 1 ? 's' : ''}
                      </span>
                    )}
                    <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>
                      {new Date(log.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>

                {/* Expand icon */}
                <Fi
                  icon={isExpanded ? 'chevron-up' : 'chevron-down'}
                  style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', flexShrink: 0 }}
                />
              </button>

              {/* Expanded reasoning panel */}
              {isExpanded && (
                <div className="px-5 pb-4 pt-0 ml-8">
                  <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}>
                    {/* Full reasoning */}
                    <div>
                      <div className="nave-label" style={{ fontSize: '9px', marginBottom: '4px' }}>Full Reasoning</div>
                      <p style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))', lineHeight: 1.6 }}>
                        {log.reasoning}
                      </p>
                    </div>

                    {/* Metadata row */}
                    <div className="flex flex-wrap items-center gap-4 pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                      <div>
                        <span className="nave-label" style={{ fontSize: '9px' }}>Decision</span>
                        <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: decisionColor(log.decision) }}>
                          {decisionLabel(log.decision)}
                        </div>
                      </div>
                      {log.confidenceScore !== null && (
                        <div>
                          <span className="nave-label" style={{ fontSize: '9px' }}>Confidence</span>
                          <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: confidenceColor(log.confidenceScore) }}>
                            {log.confidenceScore}%
                          </div>
                        </div>
                      )}
                      {log.claudeModel && (
                        <div>
                          <span className="nave-label" style={{ fontSize: '9px' }}>Model</span>
                          <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: 'hsl(var(--muted-foreground))' }}>
                            {log.claudeModel.replace('claude-', '').replace(/-\d{8}$/, '')}
                          </div>
                        </div>
                      )}
                      <div>
                        <span className="nave-label" style={{ fontSize: '9px' }}>Status</span>
                        <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: log.status === 'error' || log.status === 'guardrail_blocked' ? 'hsl(var(--destructive))' : 'hsl(var(--foreground))' }}>
                          {log.status}
                        </div>
                      </div>
                      {log.retryCount > 0 && (
                        <div>
                          <span className="nave-label" style={{ fontSize: '9px' }}>Retries</span>
                          <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: 'hsl(var(--warning))' }}>
                            {log.retryCount}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Constitution check */}
                    {hasConstitutionCheck && (
                      <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                        <ConstitutionCheckPanel check={log.constitutionCheck} />
                      </div>
                    )}

                    {/* Risk flags */}
                    {hasRiskFlags && (
                      <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                        <div className="nave-label" style={{ fontSize: '9px', marginBottom: '6px' }}>Risk Flags</div>
                        <div className="flex flex-wrap gap-1.5">
                          {log.riskFlags.map((flag, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                              style={{
                                fontSize: '10.5px',
                                fontFamily: 'var(--font-mono)',
                                backgroundColor: 'hsl(var(--warning-muted))',
                                color: 'hsl(38 60% 30%)',
                              }}
                            >
                              <Fi icon="triangle-exclamation" style={{ fontSize: '8px' }} />
                              {flag.replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Payload hash */}
                    {log.payloadHash && log.payloadHash.length > 0 && (
                      <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                        <div className="nave-label" style={{ fontSize: '9px', marginBottom: '4px' }}>Payload Hash</div>
                        <div className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', wordBreak: 'break-all' }}>
                          {log.payloadHash}
                        </div>
                      </div>
                    )}

                    {/* Reasoning hash (deterministic integrity commitment) */}
                    {log.reasoningHash && log.reasoningHash.length > 0 && (
                      <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                        <div className="nave-label" style={{ fontSize: '9px', marginBottom: '4px' }}>Reasoning Hash</div>
                        <div className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', wordBreak: 'break-all' }}>
                          {log.reasoningHash}
                        </div>
                      </div>
                    )}

                    {/* On-chain signer outcome */}
                    {log.txSignature && log.txSignature.length > 0 && (
                      <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                        <div className="nave-label" style={{ fontSize: '9px', marginBottom: '4px' }}>On-chain Signature</div>
                        <div className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--primary))', wordBreak: 'break-all' }}>
                          {log.txSignature}
                        </div>
                      </div>
                    )}

                    {/* Error message */}
                    {log.errorMessage && log.errorMessage.length > 0 && (
                      <div
                        className="flex items-start gap-2 p-2.5 rounded-lg"
                        style={{ backgroundColor: 'hsl(var(--destructive-muted))' }}
                      >
                        <Fi icon="circle-exclamation" style={{ fontSize: '11px', color: 'hsl(var(--destructive))', flexShrink: 0, marginTop: '2px' }} />
                        <p style={{ fontSize: '11.5px', color: 'hsl(0 60% 35%)', lineHeight: 1.5 }}>
                          {log.errorMessage}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Legacy Activity Log (fallback when no Claude logs) ── */
function AgentActivityLog({ items }: { items: typeof ACTIVITY_LOG }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="nave-card">
      <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'hsl(var(--border))' }}>
        <span style={{ fontSize: '14px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>Agent Activity Log</span>
        <button aria-label="Refresh log" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <Fi icon="arrows-rotate" style={{ fontSize: '12px' }} />
        </button>
      </div>
      <div className="divide-y" style={{ borderColor: 'hsl(var(--border))' }}>
        {items.map(item => (
          <div key={item.id}>
            <button
              className="w-full flex items-start gap-3 px-5 py-3.5 text-left transition-colors"
              onClick={() => setExpanded(expanded === item.id ? null : item.id)}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0" style={{ backgroundColor: statusColor(item.status) }} />
              <div className="flex-1 min-w-0">
                <p style={{ fontSize: '13px', color: 'hsl(var(--foreground))', lineHeight: 1.5 }}>{item.desc}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>{item.agent}</span>
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>{item.time}</span>
                </div>
              </div>
              <Fi
                icon={expanded === item.id ? 'chevron-up' : 'chevron-down'}
                style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', flexShrink: 0 }}
              />
            </button>
            {expanded === item.id && (
              <div className="px-5 pb-3.5 pt-0 ml-8">
                <div className="flex items-center gap-4 p-3 rounded-lg" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
                  <div>
                    <span className="nave-label" style={{ fontSize: '9px' }}>Agent</span>
                    <div className="nave-mono" style={{ color: 'hsl(var(--foreground))', marginTop: '2px', fontSize: '12px' }}>{item.agent}</div>
                  </div>
                  <div>
                    <span className="nave-label" style={{ fontSize: '9px' }}>Status</span>
                    <div className="nave-mono" style={{ color: statusColor(item.status), marginTop: '2px', fontSize: '12px' }}>{item.status}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Agent Gate panel ───────────────────────────────────── */
// Surfaces the on-chain agent gate (agents_enabled + frozen) and a plain-language
// breakdown of exactly which agent capabilities are currently permitted vs.
// blocked, mirroring the orchestrator's gate matrix:
//   frozen        → all capital movement paused; monitoring (halt/expire) active.
//   agents paused → no new approvals/executions; halts allowed.
//   open          → all actions permitted under constitutional policy.
type GateUiState = 'open' | 'frozen' | 'disabled';

interface GateCapability {
  label: string;
  allowed: boolean;
}

function gateView(state: GateUiState): {
  label: string;
  summary: string;
  color: string;
  bg: string;
  border: string;
  icon: string;
  capabilities: GateCapability[];
} {
  if (state === 'frozen') {
    return {
      label: 'Frozen',
      summary: 'Emergency freeze: all capital movement is paused. Monitoring stays active — the Oversight agent can still halt and expire requests.',
      color: 'hsl(0 60% 40%)',
      bg: 'hsl(var(--destructive-muted))',
      border: 'hsl(0 72% 80%)',
      icon: 'lock',
      capabilities: [
        { label: 'New multisig approvals', allowed: false },
        { label: 'Strategy execution / capital deployment', allowed: false },
        { label: 'Withdraw / yield compounding', allowed: false },
        { label: 'Atomic rebalances', allowed: false },
        { label: 'Oversight monitoring & halts', allowed: true },
        { label: 'Expire stale requests', allowed: true },
      ],
    };
  }
  if (state === 'disabled') {
    return {
      label: 'Agents Paused',
      summary: 'Agents are disabled: no new approvals or executions will be signed. Emergency halts and expiry of timed-out requests remain allowed.',
      color: 'hsl(38 60% 30%)',
      bg: 'hsl(var(--warning-muted))',
      border: 'hsl(38 92% 75%)',
      icon: 'pause',
      capabilities: [
        { label: 'New multisig approvals', allowed: false },
        { label: 'Strategy execution / capital deployment', allowed: false },
        { label: 'Withdraw / yield compounding', allowed: false },
        { label: 'Atomic rebalances', allowed: false },
        { label: 'Oversight monitoring & halts', allowed: true },
        { label: 'Expire stale requests', allowed: true },
      ],
    };
  }
  return {
    label: 'Active',
    summary: 'Agent gate open: the four agents operate normally under the current constitutional policy.',
    color: 'hsl(152 50% 28%)',
    bg: 'hsl(var(--success-muted))',
    border: 'hsl(152 40% 70%)',
    icon: 'circle-check',
    capabilities: [
      { label: 'New multisig approvals', allowed: true },
      { label: 'Strategy execution / capital deployment', allowed: true },
      { label: 'Withdraw / yield compounding', allowed: true },
      { label: 'Atomic rebalances', allowed: true },
      { label: 'Oversight monitoring & halts', allowed: true },
      { label: 'Expire stale requests', allowed: true },
    ],
  };
}

function AgentGatePanel({ frozen, agentsEnabled }: { frozen: boolean; agentsEnabled: boolean }) {
  const state: GateUiState = frozen ? 'frozen' : !agentsEnabled ? 'disabled' : 'open';
  const view = gateView(state);
  return (
    <div className="nave-card">
      <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'hsl(var(--border))' }}>
        <div>
          <span style={{ fontSize: '14px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>Agent Gate</span>
          <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '1px' }}>
            On-chain pause / freeze state and what it permits
          </div>
        </div>
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full"
          style={{ fontSize: '11px', fontWeight: 500, fontFamily: 'var(--font-mono)', color: view.color, backgroundColor: view.bg, border: `1px solid ${view.border}`, letterSpacing: '0.04em' }}
        >
          <Fi icon={view.icon} style={{ fontSize: '9px' }} />
          {view.label}
        </span>
      </div>
      <div className="p-5">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, marginBottom: '14px' }}>
          {view.summary}
        </p>
        <div className="nave-label" style={{ fontSize: '9px', marginBottom: '8px' }}>
          {state === 'open' ? 'All capabilities active' : 'What is currently blocked'}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {view.capabilities.map((cap) => (
            <div key={cap.label} className="flex items-center gap-2">
              <span
                className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: cap.allowed ? 'hsl(var(--success-muted))' : 'hsl(var(--destructive-muted))' }}
              >
                <Fi
                  icon={cap.allowed ? 'check' : 'xmark'}
                  style={{ fontSize: '8px', color: cap.allowed ? 'hsl(152 50% 28%)' : 'hsl(0 60% 40%)' }}
                />
              </span>
              <span style={{ fontSize: '12.5px', color: cap.allowed ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))', lineHeight: 1.4 }}>
                {cap.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────── */
export default function Agent() {
  const navigate = useNavigate();
  const { daoAddress } = useDaoContext();

  // ─── Live data hooks ─────────────────────────────────────────────────
  const agentStatus = useAgentStatus(daoAddress);
  const activityLog = useActivityLog(daoAddress);
  const agentHealth = useAgentHealth(daoAddress);
  const daoRegistry = useDaoRegistry(daoAddress);
  const treasuryBalance = useTreasuryBalance(daoAddress);
  const isFrozen = daoRegistry.dao?.frozen ?? false;
  const isMock = isMockDaoAddress(daoAddress);
  const executionPipeline = useExecutionPipeline(daoAddress, daoRegistry.dao?.proposalCount ?? 0);

  const { publicKey } = useWallet();
  const { isFounder, isGuardian } = useDaoMembership();
  const { chainKind, evmChainId, chainFamily } = useChain();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const tx = useSendTransaction();

  // Only the founder or a guardian may pause the agents or propose to enable them.
  // Mock DAOs stay interactive for the demo.
  const canManageAgents = isMock || isFounder || isGuardian;

  // The displayed state is the AUTHORITATIVE on-chain `agents_enabled` flag.
  const [pendingActive, setPendingActive] = useState<boolean | null>(null);
  const active = pendingActive ?? agentStatus.agentsEnabled;
  const startBlocked = !active && !isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance;
  const [showConfirm, setShowConfirm] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Clear any optimistic value once fresh on-chain state arrives.
  useEffect(() => {
    setPendingActive(null);
  }, [agentStatus.agentsEnabled]);

  // Build display-ready agent list from live data, falling back to mock
  const displayAgents = useMemo(() => {
    if (agentStatus.agents.length > 0) {
      return agentStatus.agents.map((a: AgentStatusInfo) => {
        const mock = AGENTS.find(m => m.id === a.role);
        // Enrich with health data if available
        const healthEntry = agentHealth.agents.find(h => h.role === a.role) ?? null;
        // Per-agent status grounded in on-chain enablement (not the global toggle).
        const statusDisplay = computeAgentStatus({
          agentsEnabled: active,
          frozen: isFrozen,
          hasOnChain: true,
          onChain: { active: a.active, nullified: a.nullified, status: a.status },
          health: healthEntry,
        });
        return {
          ...mock!,
          status: (a.active ? 'active' : 'paused') as 'active' | 'paused',
          statusDisplay,
          actionsToday: healthEntry ? healthEntry.actions_24h : a.actionsCount,
          lastAction: healthEntry?.last_action_at
            ? timeAgo(healthEntry.last_action_at)
            : a.lastActionAt
              ? `${Math.round((Date.now() / 1000 - a.lastActionAt) / 60)}m ago`
              : '—',
        };
      });
    }
    // Only fall back to illustrative agents for the demo DAO; real DAOs with no
    // agents render an empty state rather than fake data.
    if (!isMock) return [];
    return AGENTS.map(m => ({
      ...m,
      statusDisplay: computeAgentStatus({
        agentsEnabled: active,
        frozen: isFrozen,
        hasOnChain: true,
        onChain: { active: true, nullified: false, status: AgentStatus.Active },
        health: null,
      }),
    }));
  }, [agentStatus.agents, agentHealth.agents, isMock, active, isFrozen]);

  // Build display-ready activity log from live data, falling back to mock
  const displayActivity = useMemo(() => {
    if (activityLog.activities.length > 0) {
      return activityLog.activities.slice(0, 10).map(a => ({
        id: Number(a.id) || Math.random(),
        desc: a.description,
        agent: a.agentRole || a.actor,
        time: new Date(a.createdAt).toLocaleString(),
        status: a.eventType.includes('error') ? 'warning' : 'success',
      }));
    }
    return isMock ? ACTIVITY_LOG : [];
  }, [activityLog.activities, isMock]);

  // Live health metrics only. Demo dollar and uptime figures are not shown.
  const displayMetrics = useMemo(() => {
    if (agentHealth.agents.length === 0) return [];
    const totalActions24h = agentHealth.agents.reduce((s, a) => s + a.actions_24h, 0);
    const totalErrors24h = agentHealth.agents.reduce((s, a) => s + a.errors_24h, 0);
    const healthyCount = agentHealth.agents.filter(a => getAgentHealthLevel(a) === 'healthy').length;
    const uptimePct = ((healthyCount / agentHealth.agents.length) * 100).toFixed(1);
    return [
      { label: 'Actions (24h)', value: totalActions24h.toString() },
      { label: 'Errors (24h)', value: totalErrors24h.toString() },
      { label: 'System Health', value: agentHealth.systemHealthy ? 'Healthy' : 'Degraded' },
      { label: 'Agent Uptime', value: `${uptimePct}%` },
    ];
  }, [agentHealth.agents, agentHealth.systemHealthy]);

  const treasuryWatch = useMemo(() => {
    if (isMock) return null;
    const latest = agentStatus.actionLogs.find((log) => log.constitutionCheck && Object.keys(log.constitutionCheck).length > 0);
    const detail = latest ? constitutionBlockDetail(latest.constitutionCheck) : null;
    if (detail) return { state: 'blocked' as const, detail };
    return { state: 'watching' as const, detail: null };
  }, [agentStatus.actionLogs, isMock]);

  /** Pause click — opens the confirm dialog. Only founder/guardian may pause. */
  function handlePauseClick() {
    setToggleError(null);
    if (!canManageAgents) {
      setToggleError('Only the founder or a guardian can pause this DAO\'s agents.');
      return;
    }
    setShowConfirm(true);
  }

  /**
   * Propose to enable the agents. Resuming is gated behind a governance vote:
   * we create a General proposal (canonical title) via the Governance review
   * flow, then the founder executes it once it passes.
   */
  function handleProposeEnable() {
    setToggleError(null);
    // EVM enabling mirrors Solana: a governance proposal gates the resume, then
    // the founder executes it (Governance.handleExecuteEnableAgents → the EVM
    // relay calls Executive toggleAgents(true)). Proposal creation is EVM-wired,
    // so we let the navigate proceed for both chains.
    if (!canManageAgents) {
      setToggleError('Only the founder or a guardian can propose enabling the agents.');
      return;
    }
    // Agents have nothing to manage on an empty treasury — fund it first.
    if (!isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance) {
      setToggleError('Fund the treasury before proposing to enable the agents — they cannot operate on an empty DAO.');
      return;
    }
    if (isMock) {
      // Demo: optimistically reflect the enabled state without a real proposal.
      setPendingActive(true);
      return;
    }
    navigate('/governance', {
      state: {
        proposeAgentEnable: {
          title: AGENT_ENABLE_PROPOSAL_TITLE,
          description:
            'Resume the four autonomous agents (Executive, Financial, Operational, Oversight) for this treasury. Once this proposal passes, the founder executes the on-chain enable so the agents reconnect and begin checking the DAO for necessary actions under the current constitution.',
          // 1-byte marker tags this as an agent-enable proposal in addition to the title.
          payload: [1],
        },
      },
    });
  }

  /** Confirm the pause — instant single-actor emergency_pause_agents. */
  async function handleConfirmToggle() {
    setShowConfirm(false);

    if (isMock) {
      setPendingActive(false);
      return;
    }
    // ── EVM: guardian M-of-N pause via the founder-signed agent-admin →
    // /relay-evm path. The founder wallet is itself a guardian, so it signs the
    // EIP-712 GuardianAction(DISABLE_AGENTS) here; the signer adds the custodied
    // guardian signature(s) and broadcasts guardianAction(DISABLE_AGENTS, sigs). ──
    if (chainKind === 'evm') {
      if (!daoAddress) { setToggleError('Select a treasury to pause the agents.'); return; }
      if (!evmChainId || (chainFamily !== 'ethereum' && chainFamily !== 'base' && chainFamily !== 'robinhood')) {
        setToggleError('Select an Ethereum, Base, or Robinhood network.');
        return;
      }
      if (!evmAddress) { setToggleError('Connect your EVM founder wallet to pause the agents.'); return; }
      setToggling(true);
      setToggleError(null);
      setPendingActive(false);
      try {
        const { data, error } = await setAgentsEnabledViaProxyEvm(
          daoAddress,
          evmAddress,
          (m) => signMessageAsync({ message: m }),
          false,
          evmChainId,
          chainFamily,
          {
            signGuardianAction: (typed) =>
              signTypedDataAsync({
                domain: typed.domain,
                types: typed.types,
                primaryType: typed.primaryType,
                message: typed.message,
              }),
          },
        );
        if (error || !data?.success) {
          setPendingActive(null);
          setToggleError(error || data?.error || 'Failed to pause the agents on-chain.');
          return;
        }
        agentStatus.refetch();
      } catch (err) {
        setPendingActive(null);
        setToggleError(err instanceof Error ? err.message : 'Failed to pause the agents on-chain.');
      } finally {
        setToggling(false);
      }
      return;
    }
    if (!daoAddress || !publicKey) {
      setToggleError('Connect your wallet to pause the agents.');
      return;
    }

    setToggling(true);
    setToggleError(null);
    setPendingActive(false);

    try {
      // Instant pause: either the founder or any single guardian may sign a
      // single emergency_pause_agents transaction. No M-of-N, no window.
      // This is PER-DAO — it cannot affect other DAOs' agent states.
      const { PublicKey: PK } = await import('@solana/web3.js');
      const daoPubkey = new PK(daoAddress);
      const result = await buildEmergencyPauseAgents(daoPubkey, publicKey);
      const outcome = await tx.send(result, { successLabel: 'Agents paused' });
      if (outcome.status !== 'success' && outcome.status !== 'mock') {
        setPendingActive(null);
        const errMsg = outcome.error ?? 'Failed to pause the agents.';
        setToggleError(
          errMsg.toLowerCase().includes('unauthorized')
            ? `${errMsg} — only the founder or a guardian of this DAO can pause the agents.`
            : errMsg,
        );
        return;
      }

      agentStatus.refetch();
    } catch (err) {
      setPendingActive(null);
      setToggleError(err instanceof Error ? err.message : 'Failed to pause the agents on-chain.');
    } finally {
      setToggling(false);
    }
  }

  // ─── Loading skeleton ─────────────────────────────────────────────
  if (agentStatus.loading && agentStatus.agents.length === 0) {
    return <PageSkeleton variant="agent" />;
  }

  // ─── Empty state ─────────────────────────────────────────────────
  if (!daoAddress) {
    return (
      <div className="p-6 animate-fade-in">
        <NaveEmptyState
          icon="robot"
          title="No Treasury Selected"
          description="Connect to a treasury to view agent coordination status and execution pipeline."
          action={{ label: 'Browse treasuries', icon: 'arrow-right', onClick: () => navigate('/treasuries') }}
        />
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 sm:space-y-6 animate-fade-in" data-onboarding-id="agent-root">
      <ConfirmAgentToggleModal
        open={showConfirm}
        active={active}
        onConfirm={handleConfirmToggle}
        onCancel={() => setShowConfirm(false)}
      />
      {/* Emergency freeze banner */}
      {isFrozen && (
        <div
          className="flex items-center gap-3 px-4 py-3.5 rounded-xl border"
          style={{
            backgroundColor: 'hsl(var(--destructive-muted))',
            borderColor: 'hsl(0 72% 80%)',
          }}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: 'hsl(var(--destructive))' }}
          >
            <Fi icon="shield-halved" style={{ fontSize: '14px', color: 'white' }} />
          </div>
          <div className="flex-1 min-w-0">
            <div style={{ fontSize: '13.5px', fontWeight: '600', color: 'hsl(0 60% 35%)' }}>
              All Agents Halted — Emergency Freeze Active
            </div>
            <div style={{ fontSize: '12px', color: 'hsl(0 40% 45%)', marginTop: '1px' }}>
              Agent dispatching, signing, and monitoring are suspended. Treasury operations frozen by guardian action.
            </div>
          </div>
          <div
            className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md flex-shrink-0"
            style={{ backgroundColor: 'hsl(0 60% 92%)', fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'hsl(0 60% 40%)', letterSpacing: '0.04em' }}
          >
            <Fi icon="lock" style={{ fontSize: '8px' }} />
            FROZEN
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-display" style={{ fontSize: '24px', letterSpacing: '-0.01em' }}>
            Multi-Agent Coordination
          </h1>
          <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px' }}>
            Identity-bound fiduciary operators acting under constitutional mandates
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/policy')}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border transition-colors"
            style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', fontSize: '12.5px' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          >
            <Fi icon="castle" style={{ fontSize: '12px' }} />
            Constitution
            <Fi icon="arrow-right" style={{ fontSize: '11px' }} />
          </button>
          {active ? (
            <button
              onClick={handlePauseClick}
              disabled={toggling || !canManageAgents}
              className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--destructive-muted))',
                color: 'hsl(var(--destructive))',
                border: '1px solid hsl(0 72% 80%)',
                opacity: toggling || !canManageAgents ? 0.6 : 1,
                cursor: toggling ? 'wait' : !canManageAgents ? 'not-allowed' : 'pointer',
              }}
              title={!canManageAgents ? 'Only the founder or a guardian can pause the agents' : undefined}
            >
              <Fi icon={toggling ? 'spinner' : 'pause'} style={{ fontSize: '12px' }} />
              {toggling ? 'Pausing…' : 'Pause All Agents'}
            </button>
          ) : (
            <button
              onClick={handleProposeEnable}
              disabled={toggling || startBlocked || !canManageAgents}
              className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--primary))',
                color: 'white',
                border: 'none',
                opacity: toggling || startBlocked || !canManageAgents ? 0.6 : 1,
                cursor: startBlocked || !canManageAgents ? 'not-allowed' : 'pointer',
              }}
              title={
                !canManageAgents
                  ? 'Only the founder or a guardian can propose enabling the agents'
                  : startBlocked
                    ? 'Fund the treasury before proposing to enable the agents'
                    : undefined
              }
            >
              <Fi icon="scale-balanced" style={{ fontSize: '12px' }} />
              Propose to Enable Agents
            </button>
          )}
        </div>
      </div>

      {/* Toggle error */}
      {toggleError && (
        <div
          className="flex items-start gap-2.5 p-3.5 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
        >
          <Fi icon="triangle-exclamation" style={{ fontSize: '13px', color: 'hsl(var(--destructive))', flexShrink: 0, marginTop: '2px' }} />
          <p style={{ fontSize: '12.5px', color: 'hsl(0 60% 35%)', lineHeight: 1.5 }}>{toggleError}</p>
        </div>
      )}

      {/* Agent data fetch errors — surfaced instead of console-only */}
      {(agentHealth.error || agentStatus.error) && (
        <div
          className="flex items-start gap-2.5 p-3.5 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
        >
          <Fi icon="triangle-exclamation" style={{ fontSize: '13px', color: 'hsl(var(--destructive))', flexShrink: 0, marginTop: '2px' }} />
          <p style={{ fontSize: '12.5px', color: 'hsl(0 60% 35%)', lineHeight: 1.5 }}>
            <strong>Agent data failed to load.</strong>{' '}
            {agentHealth.error && <span>Health: {agentHealth.error}. </span>}
            {agentStatus.error && <span>Status: {agentStatus.error}.</span>}
          </p>
        </div>
      )}

      {treasuryWatch && (
        <div
          className="flex items-start gap-3 px-4 py-3.5 rounded-xl border"
          style={{
            backgroundColor: treasuryWatch.state === 'blocked' ? 'hsl(var(--destructive-muted))' : 'hsl(var(--accent-muted))',
            borderColor: treasuryWatch.state === 'blocked' ? 'hsl(0 72% 80%)' : 'hsl(var(--border-strong))',
          }}
        >
          <Fi
            icon={treasuryWatch.state === 'blocked' ? 'ban' : 'eye'}
            style={{
              fontSize: '14px',
              color: treasuryWatch.state === 'blocked' ? 'hsl(var(--destructive))' : 'hsl(var(--accent))',
              flexShrink: 0,
              marginTop: '2px',
            }}
          />
          <div>
            <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
              {treasuryWatch.state === 'blocked' ? 'Blocked' : 'Watching'}
            </div>
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', lineHeight: 1.5 }}>
              {treasuryWatch.state === 'blocked'
                ? treasuryWatch.detail
                : 'Agents are watching this treasury. Capital moves only after the constitution check passes.'}
            </p>
          </div>
        </div>
      )}

      {displayMetrics.length > 0 && (
      <motion.div
        className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 gap-3"
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        {displayMetrics.map(({ label, value }) => (
          <motion.div key={label} className="nave-card p-4" variants={staggerChild}>
            <div className="nave-label mb-1.5" style={{ fontSize: '9.5px' }}>{label}</div>
            <div style={{ fontSize: '22px', fontFamily: 'var(--font-display)', color: 'hsl(var(--foreground))' }}>{value}</div>
          </motion.div>
        ))}
      </motion.div>
      )}

      {/* Agent gate — explicit pause/freeze state + what it permits */}
      <AgentGatePanel frozen={isFrozen} agentsEnabled={active} />

      {/* Status banners when not active */}
      {!active && startBlocked && (
        <div
          className="flex items-start gap-2.5 p-4 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--warning-muted))', borderColor: 'hsl(38 92% 75%)' }}
        >
          <Fi icon="circle-info" style={{ fontSize: '14px', color: 'hsl(var(--warning))', flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '13px', color: 'hsl(38 50% 28%)', lineHeight: 1.55 }}>
            <strong>Deposit funds before starting the agents.</strong> The treasury needs a balance to cover
            transaction fees and capital for yield strategies.{' '}
            <button
              type="button"
              onClick={() => navigate('/dashboard', { state: { openDeposit: true } })}
              style={{ fontWeight: 600, textDecoration: 'underline', background: 'none', border: 'none', padding: 0, color: 'inherit', cursor: 'pointer' }}
            >
              Add funds
            </button>
            , then return here to start the agents.
          </div>
        </div>
      )}
      {!active && !startBlocked && !toggleError && (
        <div
          className="flex items-start gap-2.5 p-4 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--warning-muted))', borderColor: 'hsl(38 92% 75%)' }}
        >
          <Fi icon="triangle-exclamation" style={{ fontSize: '14px', color: 'hsl(var(--warning))', flexShrink: 0, marginTop: '2px' }} />
          <p style={{ fontSize: '13px', color: 'hsl(38 50% 28%)', lineHeight: 1.55 }}>
            All agents are paused — treasury operations are halted. Resuming requires a governance vote: click <strong>Propose to Enable Agents</strong> to put it to the DAO.
          </p>
        </div>
      )}

      {/* 4 Agent cards */}
      <motion.div
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        {displayAgents.map(agent => (
          <motion.div key={agent.id} variants={staggerChild}>
            <AgentCard agent={agent} frozen={isFrozen} />
          </motion.div>
        ))}
      </motion.div>

      {!isMock && (
        <ExecutionPipeline
          executions={executionPipeline.executions}
          loading={executionPipeline.loading}
        />
      )}

      {/* Claude Reasoning Log — shown when action logs exist */}
      {agentStatus.actionLogs.length > 0 ? (
        <ClaudeActivityLog logs={agentStatus.actionLogs} onRefresh={agentStatus.refetch} />
      ) : displayActivity.length > 0 ? (
        <AgentActivityLog items={displayActivity} />
      ) : null}
    </div>
  );
}