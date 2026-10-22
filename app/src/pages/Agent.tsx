import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import Fi from '../components/Fi';
import NaveModal from '../components/NaveModal';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import { Section, Stat, Notice, HairlineRow } from '../components/calm';
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
import { isTreasuryOpsFamily } from '../lib/chain/types';
import { PublicKey } from '@solana/web3.js';
import { useAccount, useSignMessage, useSignTypedData } from 'wagmi';
import { clearHaltViaProxy, setAgentsEnabledViaProxyEvm, solanaAccessSigner } from '../lib/edgeFunctionClient';
import { buildEmergencyPauseAgents } from '../lib/transactionBuilders';
import { getExecutionRequestPDA } from '../lib/pdaDerivation';

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
      title={active ? 'Pause the team?' : 'Restart the team?'}
      icon={active ? 'pause' : 'play'}
      maxWidth={460}
    >
      <div className="space-y-4" style={{ padding: '18px 22px 22px' }}>
        <p style={{ fontSize: '13.5px', lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
          {active
            ? 'Pausing disconnects this DAO from the four Nave agents immediately. Your wallet signs a single emergency_pause_agents transaction — no other signatures are required. Funds remain secure, and you can resume the agents later via a governance proposal.'
            : 'Agents will resume all autonomous operations under the current constitutional policy. Any pending operations will execute in sequence.'}
        </p>
        {active && (
          <div className="space-y-1">
            {[
              'Agents stop signing and moving money immediately.',
              'The Watcher keeps monitoring and can still freeze.',
              'Restarting later requires a community vote.',
            ].map((item) => (
              <div
                key={item}
                className="flex items-start gap-2.5"
                style={{
                  fontSize: '13px',
                  padding: '8px 0',
                  borderBottom: '1px solid hsl(var(--surface-2))',
                  color: 'hsl(var(--muted-foreground))',
                  lineHeight: 1.5,
                }}
              >
                <span style={{ color: 'hsl(var(--success))', fontWeight: 700, flexShrink: 0 }}>•</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        )}
        <div
          className="flex items-center justify-end gap-2 pt-4 border-t"
          style={{ borderColor: 'hsl(var(--surface-2))' }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-2 rounded-[9px] transition-colors"
            style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--muted-foreground))' }}
          >
            {active ? 'Keep them running' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-colors"
            style={{
              fontSize: '13px',
              backgroundColor: active ? 'hsl(var(--foreground))' : 'hsl(var(--primary))',
              color: '#ffffff',
            }}
          >
            <Fi icon={active ? 'pause' : 'play'} style={{ fontSize: '11px' }} />
            {active ? 'Pause Agents' : 'Resume Agents'}
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
    summary: 'Turns decisions into plans. Signs first.',
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
    summary: 'Moves money to approved earning places. Signs second.',
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
    summary: 'Checks every move against your rules. Signs last — or refuses.',
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
    summary: 'Watches around the clock. Can freeze everything instantly.',
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

/* ── Agent Row ─────────────────────────────────────────── */
function AgentRow({
  agent,
  frozen = false,
}: {
  agent: Omit<typeof AGENTS[0], 'status'> & { status: string; statusDisplay: AgentStatusDisplay };
  frozen?: boolean;
}) {
  const { statusDisplay } = agent;
  const isHealthy = statusDisplay.enabled && !frozen;
  return (
    <HairlineRow
      title={agent.role}
      subtitle={`${agent.tag} · ${agent.summary}`}
      meta={
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: frozen
              ? 'hsl(var(--destructive))'
              : isHealthy
                ? 'hsl(var(--success))'
                : statusDisplay.color,
            whiteSpace: 'nowrap',
          }}
        >
          {frozen ? 'Frozen' : statusDisplay.label}
        </span>
      }
      when={`${agent.actionsToday} ops · ${agent.lastAction}`}
      expandableContent={
        <div className="space-y-3 pt-1">
          <ul className="space-y-1 pl-4" style={{ listStyle: 'disc', margin: 0 }}>
            {agent.responsibilities.map((r) => (
              <li key={r} style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
                {r}
              </li>
            ))}
          </ul>
          <div
            className="flex flex-wrap items-center gap-6 pt-2.5 border-t"
            style={{ borderColor: 'hsl(var(--surface-2))' }}
          >
            <div>
              <div className="nave-label">Last Action</div>
              <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: 'hsl(var(--foreground))' }}>
                {agent.lastAction}
              </div>
            </div>
            <div>
              <div className="nave-label">24h Ops</div>
              <div className="nave-mono" style={{ fontSize: '12px', marginTop: '2px', color: 'hsl(var(--foreground))' }}>
                {agent.actionsToday} ops
              </div>
            </div>
            <div>
              <div className="nave-label">Signing</div>
              <div
                className="nave-mono"
                style={{
                  fontSize: '12px',
                  marginTop: '2px',
                  color: agent.signsTransactions ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                }}
              >
                {agent.signsTransactions ? 'Yes' : 'No'}
              </div>
            </div>
          </div>
        </div>
      }
    />
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

function LiveExecutionRow({
  exec,
  canClearHalt,
  clearingHalt,
  clearHaltError,
  onClearHalt,
}: {
  exec: ExecutionInfo;
  canClearHalt?: boolean;
  clearingHalt?: boolean;
  clearHaltError?: string | null;
  onClearHalt?: () => void;
}) {
  const { label, tone } = executionStatusLabel(exec.status);
  const currentStageIdx = EXECUTION_STAGES.findIndex((s) => s.status === exec.status);
  const isHalted = exec.status === ExecutionStatus.Halted || exec.operationalHalt;
  const activeStageLabel =
    EXECUTION_STAGES[currentStageIdx]?.label ??
    (isHalted ? `Halted: ${exec.operationalHaltReason || 'flagged by Oversight agent'}` : label);
  const proposalShort =
    exec.proposal.length > 12 ? `${exec.proposal.slice(0, 8)}…${exec.proposal.slice(-4)}` : `#${exec.proposal}`;

  return (
    <HairlineRow
      dotColor={tone === 'complete' ? 'green' : tone === 'halt' ? 'red' : 'brass'}
      title={`${proposalShort} · ${exec.protocolName || 'strategy'}`}
      subtitle={activeStageLabel}
      meta={
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color:
              tone === 'complete'
                ? 'hsl(var(--success))'
                : tone === 'halt'
                  ? 'hsl(var(--destructive))'
                  : 'hsl(var(--warning))',
          }}
        >
          {label}
        </span>
      }
      defaultExpanded={isHalted}
      expandableContent={
        <div className="space-y-2 pt-1">
          {EXECUTION_STAGES.map((stage) => {
            const stageIdx = EXECUTION_STAGES.indexOf(stage);
            const done = currentStageIdx >= 0 && stageIdx < currentStageIdx;
            const active = stageIdx === currentStageIdx;
            return (
              <div key={stage.status} className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{
                    backgroundColor:
                      done || (active && exec.status === ExecutionStatus.Executed)
                        ? 'hsl(var(--success))'
                        : 'hsl(var(--surface-2))',
                    border: active && exec.status !== ExecutionStatus.Executed ? '2px solid hsl(var(--brass))' : 'none',
                  }}
                >
                  {done ? <Fi icon="check" style={{ fontSize: '8px', color: 'white' }} /> : null}
                </div>
                <span
                  style={{
                    fontSize: '12.5px',
                    color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  }}
                >
                  {stage.label}
                </span>
              </div>
            );
          })}
          {isHalted && (
            <div className="flex items-center justify-between gap-2 pt-2">
              <div style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                Halt: {exec.operationalHaltReason || 'flagged by Oversight agent'}
              </div>
              {canClearHalt && onClearHalt && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearHalt();
                  }}
                  disabled={clearingHalt}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] border font-semibold"
                  style={{
                    fontSize: '12px',
                    borderColor: 'hsl(var(--border-strong))',
                    backgroundColor: '#ffffff',
                    color: 'hsl(var(--foreground))',
                    opacity: clearingHalt ? 0.6 : 1,
                  }}
                >
                  <Fi
                    icon={clearingHalt ? 'arrows-rotate' : 'shield-check'}
                    style={{ fontSize: 10 }}
                    className={clearingHalt ? 'animate-spin' : ''}
                  />
                  {clearingHalt ? 'Clearing…' : 'Clear Halt'}
                </button>
              )}
            </div>
          )}
          {clearHaltError && (
            <div style={{ fontSize: '12px', color: 'hsl(var(--destructive))', marginTop: '4px' }}>
              {clearHaltError}
            </div>
          )}
          {exec.status === ExecutionStatus.InReview && exec.timeRemainingSeconds > 0 && (
            <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '4px' }}>
              Review window: {Math.ceil(exec.timeRemainingSeconds / 60)}m remaining
            </div>
          )}
        </div>
      }
    />
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
  canClearHalt,
  clearingProposal,
  clearHaltErrors,
  onClearHalt,
}: {
  executions: ExecutionInfo[];
  loading: boolean;
  canClearHalt?: boolean;
  clearingProposal?: string | null;
  clearHaltErrors?: Record<string, string>;
  onClearHalt?: (exec: ExecutionInfo) => void;
}) {
  return (
    <Section title="Execution Pipeline" hint="3-key autonomous multisig coordination">
      {loading && (
        <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>Loading execution requests…</div>
      )}
      {!loading && executions.length === 0 && (
        <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
          No active execution requests. Passed strategy proposals will appear here as they move through the agent pipeline.
        </div>
      )}
      <div>
        {executions.map((exec) => (
          <LiveExecutionRow
            key={exec.proposal}
            exec={exec}
            canClearHalt={canClearHalt}
            clearingHalt={clearingProposal === exec.proposal}
            clearHaltError={clearHaltErrors?.[exec.proposal] ?? null}
            onClearHalt={onClearHalt ? () => onClearHalt(exec) : undefined}
          />
        ))}
      </div>
    </Section>
  );
}

/* ── Decision color helpers ─────────────────────────────── */
function decisionColor(decision: string | null): string {
  if (!decision) return 'hsl(var(--muted-foreground))';
  if (decision === 'approve' || decision === 'continue') return 'hsl(var(--success))';
  if (decision === 'reject' || decision === 'halt') return 'hsl(var(--destructive))';
  if (decision === 'request_review' || decision === 'clear_halt') return 'hsl(var(--brass))';
  return 'hsl(var(--muted-foreground))';
}

function decisionLabel(decision: string | null): string {
  if (!decision) return 'Pending';
  return decision.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
              color: val ? 'hsl(var(--success))' : 'hsl(var(--destructive))',
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

/* ── Claude Reasoning Activity Log ("Their diary") ────── */
function ClaudeActivityLog({ logs, onRefresh }: { logs: AgentActionLog[]; onRefresh: () => void }) {
  return (
    <Section
      title="Their diary"
      hint="Plain English · proof on tap"
      action={
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh log"
          className="hover:underline underline-offset-4"
          style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
        >
          Refresh
        </button>
      }
    >
      <div>
        {logs.map((log) => {
          const hasRiskFlags = log.riskFlags && log.riskFlags.length > 0;
          const hasConstitutionCheck = log.constitutionCheck && Object.keys(log.constitutionCheck).length > 0;
          const snippet = log.reasoning.length > 120 ? `${log.reasoning.slice(0, 120)}…` : log.reasoning;
          const timeStr = new Date(log.createdAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

          return (
            <HairlineRow
              key={log.id}
              dotColor={decisionColor(log.decision)}
              title={`${roleLabel(log.agentRole)} — ${snippet}`}
              subtitle={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span>{log.actionType}</span>
                  {log.decision && (
                    <span style={{ color: decisionColor(log.decision), fontWeight: 500 }}>
                      · {decisionLabel(log.decision)}
                    </span>
                  )}
                  {log.confidenceScore !== null && (
                    <span style={{ color: confidenceColor(log.confidenceScore) }}>
                      · {log.confidenceScore}% confident
                    </span>
                  )}
                  {hasRiskFlags && (
                    <span style={{ color: 'hsl(var(--warning))' }}>
                      · {log.riskFlags.length} flag{log.riskFlags.length > 1 ? 's' : ''}
                    </span>
                  )}
                </span>
              }
              when={timeStr}
              expandableContent={
                <div className="space-y-3 pt-2">
                  <div>
                    <div className="nave-label" style={{ fontSize: '9px', marginBottom: '4px' }}>Full Reasoning</div>
                    <p style={{ fontSize: '13px', color: 'hsl(var(--foreground))', lineHeight: 1.6, margin: 0 }}>
                      {log.reasoning}
                    </p>
                  </div>

                  <div
                    className="flex flex-wrap items-center gap-5 pt-2.5 border-t"
                    style={{ borderColor: 'hsl(var(--surface-2))' }}
                  >
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
                      <div
                        className="nave-mono"
                        style={{
                          fontSize: '12px',
                          marginTop: '2px',
                          color:
                            log.status === 'error' || log.status === 'guardrail_blocked'
                              ? 'hsl(var(--destructive))'
                              : 'hsl(var(--foreground))',
                        }}
                      >
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

                  {hasConstitutionCheck && (
                    <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
                      <ConstitutionCheckPanel check={log.constitutionCheck} />
                    </div>
                  )}

                  {hasRiskFlags && (
                    <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
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
                              color: 'hsl(var(--warning))',
                            }}
                          >
                            <Fi icon="triangle-exclamation" style={{ fontSize: '8px' }} />
                            {flag.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {log.payloadHash && log.payloadHash.length > 0 && (
                    <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
                      <div className="nave-label" style={{ fontSize: '9px', marginBottom: '4px' }}>Payload Hash</div>
                      <div className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', wordBreak: 'break-all' }}>
                        {log.payloadHash}
                      </div>
                    </div>
                  )}

                  {log.reasoningHash && log.reasoningHash.length > 0 && (
                    <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
                      <div className="nave-label" style={{ fontSize: '9px', marginBottom: '4px' }}>Reasoning Hash</div>
                      <div className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', wordBreak: 'break-all' }}>
                        {log.reasoningHash}
                      </div>
                    </div>
                  )}

                  {log.txSignature && log.txSignature.length > 0 && (
                    <div className="pt-2 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
                      <div className="nave-label" style={{ fontSize: '9px', marginBottom: '4px' }}>On-chain Signature</div>
                      <div className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--foreground))', wordBreak: 'break-all' }}>
                        {log.txSignature}
                      </div>
                    </div>
                  )}

                  {log.errorMessage && log.errorMessage.length > 0 && (
                    <div
                      className="flex items-start gap-2 p-2.5 rounded-lg"
                      style={{ backgroundColor: 'hsl(var(--destructive-muted))' }}
                    >
                      <Fi icon="circle-exclamation" style={{ fontSize: '11px', color: 'hsl(var(--destructive))', flexShrink: 0, marginTop: '2px' }} />
                      <p style={{ fontSize: '11.5px', color: 'hsl(var(--destructive))', lineHeight: 1.5, margin: 0 }}>
                        {log.errorMessage}
                      </p>
                    </div>
                  )}
                </div>
              }
            />
          );
        })}
      </div>
    </Section>
  );
}

/* ── Legacy Activity Log (fallback when no Claude logs) ── */
function AgentActivityLog({ items }: { items: typeof ACTIVITY_LOG }) {
  return (
    <Section title="Their diary" hint="Plain English · proof on tap">
      <div>
        {items.map((item) => (
          <HairlineRow
            key={item.id}
            dotColor={statusColor(item.status)}
            title={item.desc}
            subtitle={item.agent}
            when={item.time}
            expandableContent={
              <div className="flex items-center gap-6 pt-1">
                <div>
                  <span className="nave-label" style={{ fontSize: '9px' }}>Agent</span>
                  <div className="nave-mono" style={{ color: 'hsl(var(--foreground))', marginTop: '2px', fontSize: '12px' }}>
                    {item.agent}
                  </div>
                </div>
                <div>
                  <span className="nave-label" style={{ fontSize: '9px' }}>Status</span>
                  <div className="nave-mono" style={{ color: statusColor(item.status), marginTop: '2px', fontSize: '12px' }}>
                    {item.status}
                  </div>
                </div>
              </div>
            }
          />
        ))}
      </div>
    </Section>
  );
}

/* ── Agent Gate panel ───────────────────────────────────── */
type GateUiState = 'open' | 'frozen' | 'disabled';

interface GateCapability {
  label: string;
  allowed: boolean;
}

function gateView(state: GateUiState): {
  label: string;
  summary: string;
  color: string;
  capabilities: GateCapability[];
} {
  if (state === 'frozen') {
    return {
      label: 'Frozen',
      summary: 'Emergency freeze: all capital movement is paused. Monitoring stays active — the Oversight agent can still halt and expire requests.',
      color: 'hsl(var(--destructive))',
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
      color: 'hsl(var(--warning))',
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
    color: 'hsl(var(--success))',
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
    <HairlineRow
      dotColor={state === 'open' ? 'green' : state === 'frozen' ? 'red' : 'brass'}
      title={`Agent gate: ${view.label}`}
      subtitle={view.summary}
      meta={
        <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
          What is currently permitted / blocked
        </span>
      }
      expandableContent={
        <div className="pt-2">
          <div className="nave-label" style={{ fontSize: '9px', marginBottom: '8px' }}>
            {state === 'open' ? 'All capabilities active' : 'What is currently permitted / blocked'}
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
                    style={{ fontSize: '8px', color: cap.allowed ? 'hsl(var(--success))' : 'hsl(var(--destructive))' }}
                  />
                </span>
                <span style={{ fontSize: '12.5px', color: cap.allowed ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))', lineHeight: 1.4 }}>
                  {cap.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      }
    />
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

  const { publicKey, signMessage } = useWallet();
  const { isFounder, isGuardian } = useDaoMembership();
  const { chainKind, evmChainId, chainFamily } = useChain();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const tx = useSendTransaction();
  const [clearingProposal, setClearingProposal] = useState<string | null>(null);
  const [clearHaltErrors, setClearHaltErrors] = useState<Record<string, string>>({});

  async function handleClearHalt(exec: ExecutionInfo) {
    if (!daoAddress || clearingProposal) return;
    setClearHaltErrors((prev) => {
      const next = { ...prev };
      delete next[exec.proposal];
      return next;
    });
    setClearingProposal(exec.proposal);
    try {
      if (chainKind === 'evm') {
        if (!evmAddress || !evmChainId || !isTreasuryOpsFamily(chainFamily)) {
          setClearHaltErrors((prev) => ({
            ...prev,
            [exec.proposal]: 'Connect your EVM founder wallet on Ethereum, Base, Robinhood, or Arc.',
          }));
          return;
        }
        const idx = Number(exec.proposal);
        const { error } = await clearHaltViaProxy({
          daoAddress,
          walletAddress: evmAddress,
          executionRequestAddress: exec.proposal,
          signChallenge: (m) => signMessageAsync({ message: m }),
          chain: chainFamily,
          chainId: evmChainId,
          index: Number.isFinite(idx) ? idx : undefined,
        });
        if (error) {
          setClearHaltErrors((prev) => ({ ...prev, [exec.proposal]: error }));
          return;
        }
        executionPipeline.refetch();
        agentStatus.refetch();
        return;
      }
      if (!publicKey || !signMessage) {
        setClearHaltErrors((prev) => ({
          ...prev,
          [exec.proposal]: 'Connect your Solana founder wallet with message signing support.',
        }));
        return;
      }
      const [erPda] = getExecutionRequestPDA(new PublicKey(exec.proposal));
      const { error } = await clearHaltViaProxy({
        daoAddress,
        walletAddress: publicKey.toBase58(),
        executionRequestAddress: erPda.toBase58(),
        signChallenge: solanaAccessSigner(signMessage),
        chain: 'solana',
      });
      if (error) {
        setClearHaltErrors((prev) => ({ ...prev, [exec.proposal]: error }));
        return;
      }
      executionPipeline.refetch();
      agentStatus.refetch();
    } catch (err) {
      setClearHaltErrors((prev) => ({
        ...prev,
        [exec.proposal]: err instanceof Error ? err.message : 'Failed to clear halt.',
      }));
    } finally {
      setClearingProposal(null);
    }
  }

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
        const mock = AGENTS.find((m) => m.id === a.role);
        // Enrich with health data if available
        const healthEntry = agentHealth.agents.find((h) => h.role === a.role) ?? null;
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
    return AGENTS.map((m) => ({
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
      return activityLog.activities.slice(0, 10).map((a) => ({
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
    const healthyCount = agentHealth.agents.filter((a) => getAgentHealthLevel(a) === 'healthy').length;
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
      setToggleError("Only the founder or a guardian can pause this DAO's agents.");
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
    if (!canManageAgents) {
      setToggleError('Only the founder or a guardian can propose enabling the agents.');
      return;
    }
    if (!isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance) {
      setToggleError('Fund the treasury before proposing to enable the agents — they cannot operate on an empty DAO.');
      return;
    }
    if (isMock) {
      setPendingActive(true);
      return;
    }
    navigate('/decisions', {
      state: {
        proposeAgentEnable: {
          title: AGENT_ENABLE_PROPOSAL_TITLE,
          description:
            'Resume the four autonomous agents (Executive, Financial, Operational, Oversight) for this treasury. Once this proposal passes, the founder executes the on-chain enable so the agents reconnect and begin checking the DAO for necessary actions under the current constitution.',
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
    if (chainKind === 'evm') {
      if (!daoAddress) { setToggleError('Select a treasury to pause the agents.'); return; }
      if (!evmChainId || (!isTreasuryOpsFamily(chainFamily))) {
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
    <div className="px-4 sm:px-8 py-7 sm:py-10 animate-fade-in" data-onboarding-id="agent-root">
      <ConfirmAgentToggleModal
        open={showConfirm}
        active={active}
        onConfirm={handleConfirmToggle}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="nave-label" style={{ marginBottom: '10px' }}>Agents</div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 400,
              fontSize: '34px',
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              margin: '0 0 8px',
              color: 'hsl(var(--foreground))',
            }}
          >
            A small team, <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>quietly working.</em>
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))', fontSize: '14.5px', margin: 0, maxWidth: '520px' }}>
            Four specialists who can only act inside your rules. Every move needs three of them to agree.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-1 flex-wrap">
          <button
            type="button"
            onClick={() => navigate('/rules')}
            className="hover:underline underline-offset-4 transition-colors"
            style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
          >
            Rules →
          </button>

          <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
            {isFrozen ? 'Frozen' : active ? 'Active' : 'Paused'}
          </span>

          <button
            type="button"
            role="switch"
            aria-checked={active && !isFrozen}
            aria-label="Pause or resume agents"
            onClick={active ? handlePauseClick : handleProposeEnable}
            disabled={toggling || (!active && startBlocked) || !canManageAgents}
            className="relative flex-shrink-0 rounded-full transition-colors"
            style={{
              width: '42px',
              height: '24px',
              backgroundColor: active && !isFrozen ? 'hsl(var(--foreground))' : '#E5E0D2',
              opacity: toggling || (!active && startBlocked) || !canManageAgents ? 0.5 : 1,
              cursor:
                toggling ? 'wait' : (!active && startBlocked) || !canManageAgents ? 'not-allowed' : 'pointer',
            }}
            title={
              !canManageAgents
                ? 'Only the founder or a guardian can manage the agents'
                : !active && startBlocked
                  ? 'Fund the treasury before proposing to enable the agents'
                  : active
                    ? 'Pause All Agents'
                    : 'Propose to Enable Agents'
            }
          >
            <span
              className="absolute top-[2px] rounded-full bg-white transition-all"
              style={{
                width: '20px',
                height: '20px',
                left: active && !isFrozen ? '20px' : '2px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
              }}
            />
          </button>

          {active ? (
            <button
              type="button"
              onClick={handlePauseClick}
              disabled={toggling || !canManageAgents}
              className="px-3 py-1.5 rounded-[9px] border font-semibold transition-colors"
              style={{
                fontSize: '12.5px',
                borderColor: 'hsl(var(--border))',
                backgroundColor: '#ffffff',
                color: 'hsl(var(--foreground))',
                opacity: toggling || !canManageAgents ? 0.5 : 1,
              }}
            >
              {toggling ? 'Pausing…' : 'Pause All Agents'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleProposeEnable}
              disabled={toggling || startBlocked || !canManageAgents}
              className="px-3.5 py-1.5 rounded-[9px] font-semibold transition-colors"
              style={{
                fontSize: '12.5px',
                backgroundColor: 'hsl(var(--foreground))',
                color: '#ffffff',
                opacity: toggling || startBlocked || !canManageAgents ? 0.5 : 1,
              }}
            >
              Propose to Enable Agents
            </button>
          )}
        </div>
      </div>

      {/* Notices */}
      <div className="mt-6 space-y-2">
        {isFrozen && (
          <Notice
            tone="red"
            actionLabel="Emergency controls →"
            onAction={() => navigate('/settings')}
          >
            <b style={{ fontWeight: 600 }}>Treasury frozen.</b> All agent dispatching and capital movement are suspended. Monitoring continues.
          </Notice>
        )}

        {toggleError && (
          <Notice tone="red">{toggleError}</Notice>
        )}

        {(agentHealth.error || agentStatus.error) && (
          <Notice tone="red">
            <b style={{ fontWeight: 600 }}>Agent data failed to load.</b>{' '}
            {agentHealth.error && <span>Health: {agentHealth.error}. </span>}
            {agentStatus.error && <span>Status: {agentStatus.error}.</span>}
          </Notice>
        )}

        {treasuryWatch && (
          <Notice tone={treasuryWatch.state === 'blocked' ? 'red' : 'brass'}>
            <b style={{ fontWeight: 600 }}>
              {treasuryWatch.state === 'blocked' ? 'Blocked:' : 'Watching:'}
            </b>{' '}
            {treasuryWatch.state === 'blocked'
              ? treasuryWatch.detail
              : 'Agents are watching this treasury. Capital moves only after the constitution check passes.'}
          </Notice>
        )}

        {!active && startBlocked && (
          <Notice
            tone="brass"
            actionLabel="Add funds →"
            onAction={() => navigate('/overview', { state: { openDeposit: true } })}
          >
            <b style={{ fontWeight: 600 }}>Deposit funds before starting the agents.</b> The treasury needs a balance to cover transaction fees and capital for yield strategies.
          </Notice>
        )}

        {!active && !startBlocked && !toggleError && (
          <Notice
            tone="brass"
            actionLabel={canManageAgents ? 'Propose to Enable Agents →' : undefined}
            onAction={canManageAgents ? handleProposeEnable : undefined}
          >
            All agents are paused — treasury operations are halted. Resuming requires a governance vote.
          </Notice>
        )}
      </div>

      {/* 4-stat hairline strip */}
      {displayMetrics.length > 0 && (
        <Section>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-5">
            {displayMetrics.map(({ label, value }) => (
              <Stat key={label} label={label} value={value} />
            ))}
          </div>
        </Section>
      )}

      {/* Agent Rows + Gate */}
      <Section>
        <AgentGatePanel frozen={isFrozen} agentsEnabled={active} />
        {displayAgents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} frozen={isFrozen} />
        ))}
      </Section>

      {/* Execution Pipeline */}
      <ExecutionPipeline
        executions={executionPipeline.executions}
        loading={executionPipeline.loading}
        canClearHalt={isFounder}
        clearingProposal={clearingProposal}
        clearHaltErrors={clearHaltErrors}
        onClearHalt={(exec) => void handleClearHalt(exec)}
      />

      {/* Their diary (Claude Reasoning Log or fallback Activity Log) */}
      {agentStatus.actionLogs.length > 0 ? (
        <ClaudeActivityLog logs={agentStatus.actionLogs} onRefresh={agentStatus.refetch} />
      ) : displayActivity.length > 0 ? (
        <AgentActivityLog items={displayActivity} />
      ) : null}

      {/* Footnote */}
      <p
        style={{
          marginTop: '36px',
          fontSize: '12.5px',
          color: 'hsl(var(--faint))',
          lineHeight: 1.6,
        }}
      >
        Pausing is instant and needs no vote — any founder or guardian can do it. Restarting always takes a community vote.{' '}
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="hover:underline underline-offset-4"
          style={{ color: 'hsl(var(--destructive))', fontSize: '12.5px' }}
        >
          Emergency freeze…
        </button>
      </p>
    </div>
  );
}
