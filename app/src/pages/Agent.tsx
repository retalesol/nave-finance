import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import Fi from '../components/Fi';
import NaveModal from '../components/NaveModal';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import { Section, Notice, HairlineRow } from '../components/calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { useAgentStatus, type AgentStatusInfo, type AgentActionLog } from '../hooks/useAgentStatus';
import { useActivityLog } from '../hooks/useActivityLog';
import { useAgentHealth, timeAgo } from '../hooks/useAgentHealth';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useDaoMembership } from '../hooks/useDaoMembership';
import { useTreasuryBalance } from '../hooks/useTreasuryBalance';
import { useExecutionPipeline, type ExecutionInfo } from '../hooks/useExecutionPipeline';
import { ExecutionStatus, AgentStatus } from '../lib/onChainTypes';
import { isMockDaoAddress } from '../lib/mockData';
import { AGENT_ENABLE_PROPOSAL_TITLE } from '../lib/programConfig';
import { computeAgentStatus, type AgentStatusDisplay } from '../lib/agentStatus';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { isTreasuryOpsFamily } from '../lib/chain/types';
import { PublicKey } from '@solana/web3.js';
import { useAccount, useSignMessage, useSignTypedData } from 'wagmi';
import { clearHaltViaProxy, generateAgentKeys, replaceEvmAgentKeys, setAgentsEnabledViaProxyEvm, solanaAccessSigner } from '../lib/edgeFunctionClient';
import { buildEmergencyPauseAgents } from '../lib/transactionBuilders';
import { buildApplyAgentRotation, buildUpdateAgentSet } from '../lib/serverTransactionBuilders';
import { buildApplyAgentRotationEvm, buildUpdateAgentSetEvm } from '../lib/evm/writers';
import type { EvmChainFamily } from '../lib/chain/types';
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
            ? 'Instant, no vote needed. Any founder or guardian can do this.'
            : 'Restarting always takes a community vote — pausing never does. This starts a decision to resume the four agents under the current rules.'}
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
            {active ? 'Keep them running' : 'Not now'}
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
            {active ? 'Pause the team' : 'Start the vote'}
          </button>
        </div>
      </div>
    </NaveModal>
  );
}

/* ── Specialist definitions ────────────────────────────── */
const AGENTS = [
  {
    id: 'executive',
    role: 'The Coordinator',
    summary: 'Turns decisions into plans. Signs first.',
    icon: 'crown',
    responsibilities: [
      'Reads what the community voted for',
      'Checks the plan matches the vote',
    ],
    lastActionSummary: 'planned the weekly rebalance',
    status: 'active' as const,
    lastAction: '4 min ago',
    actionsToday: 3,
    signsTransactions: true,
  },
  {
    id: 'financial',
    role: 'The Investor',
    summary: 'Moves money to approved earning places. Signs second.',
    icon: 'money-bill-wave',
    responsibilities: [
      'Compares rates across approved places only',
      'Never acts on a plan it made itself',
    ],
    lastActionSummary: 'moved funds to approved earning venue',
    status: 'active' as const,
    lastAction: '2 min ago',
    actionsToday: 7,
    signsTransactions: true,
  },
  {
    id: 'oversight',
    role: 'The Guardrail',
    summary: 'Checks every move against your rules. Signs last — or refuses.',
    icon: 'eye',
    responsibilities: [
      'Blocks any move that would break the reserve or concentration rules',
      'Cannot be overridden except by a community vote',
    ],
    lastActionSummary: 'verified rule compliance',
    status: 'active' as const,
    lastAction: '2 min ago',
    actionsToday: 7,
    signsTransactions: true,
  },
  {
    id: 'operational',
    role: 'The Watcher',
    summary: 'Watches around the clock. Can freeze everything instantly.',
    icon: 'gear',
    responsibilities: [
      'Hourly safety checks, day and night',
      'Keeps the books and writes the diary below',
    ],
    lastActionSummary: 'safety check passed',
    status: 'active' as const,
    lastAction: '12 min ago',
    actionsToday: 14,
    signsTransactions: false,
  },
];

function humanSpecialistName(role: string | null | undefined): string {
  if (!role) return 'Specialist';
  const r = role.trim().toLowerCase();
  if (r === 'executive' || r === 'coordinator') return 'Coordinator';
  if (r === 'financial' || r === 'investor') return 'Investor';
  if (r === 'oversight' || r === 'operational_guard' || r === 'guardrail') return 'Guardrail';
  if (r === 'operational' || r === 'watcher') return 'Watcher';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface DiaryEntry {
  id: string;
  title: string;
  subtitle: string;
  when: string;
  dotColor: 'green' | 'brass' | 'red' | string;
  body: string;
  decision: string;
  checkedBy: string;
  signatures: string;
  receipt: string;
}

const MOCK_DIARY_ENTRIES: DiaryEntry[] = [
  {
    id: 'investor-1',
    title: 'Investor — “Rates rose, so I moved $4,200 to Aave.”',
    subtitle: 'Guardrail checked 6 rules · all passed.',
    when: '2 min',
    dotColor: 'green',
    body: '“Aave USDC rose to 4.8% while $4,200 sat idle above the reserve. I placed it there; Compound remains as the second venue.”',
    decision: 'Approve · 94% confident',
    checkedBy: 'Guardrail · 6/6 rules passed',
    signatures: 'Coordinator → Investor → Guardrail (3 of 3)',
    receipt: '0xMOCK…MOVE4200',
  },
  {
    id: 'guardrail-2',
    title: 'Guardrail — “I blocked a $22,000 move.”',
    subtitle: 'It would have taken the reserve below its floor. No money moved.',
    when: 'Tuesday',
    dotColor: 'brass',
    body: '“This move would take the reserve to 28%, below the 30% floor in Rule 01. I will not sign. No money moved; I notified the Investor and logged this attempt.”',
    decision: 'Refuse to sign',
    checkedBy: 'Rule 01 — keep at least 30% safe',
    signatures: 'Blocked before signing',
    receipt: '0xMOCK…BLOCK22K',
  },
  {
    id: 'coordinator-3',
    title: 'Coordinator — “Grants vote passed. Payment scheduled.”',
    subtitle: 'Linked to the decision, with all three signatures.',
    when: 'Monday',
    dotColor: '#CBD5E1',
    body: '“Decision #14 passed with 84% in favour. I prepared the $6,000 payment for Friday and handed it to the Investor and Guardrail for their checks and signatures.”',
    decision: 'Plan created',
    checkedBy: 'Guardrail · rules passed',
    signatures: '3 of 3 collected',
    receipt: '0xMOCK…GRANT06',
  },
];

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
  const statusLabel = frozen
    ? 'Frozen'
    : isHealthy
      ? agent.id === 'operational'
        ? 'Watching'
        : 'Active'
      : statusDisplay.label;

  return (
    <HairlineRow
      title={agent.role}
      subtitle={agent.summary}
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
          {statusLabel}
        </span>
      }
      expandableContent={
        <ul className="space-y-1 pl-4" style={{ listStyle: 'disc', margin: '4px 0 0' }}>
          {agent.responsibilities.map((r) => (
            <li key={r} style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
              {r}
            </li>
          ))}
          <li style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
            Last: {agent.lastActionSummary}, {agent.lastAction}
          </li>
        </ul>
      }
    />
  );
}

/* ── Execution Pipeline ─────────────────────────────────── */
const EXECUTION_STAGES: Array<{ status: ExecutionStatus; label: string }> = [
  { status: ExecutionStatus.Pending, label: 'Coordinator signed' },
  { status: ExecutionStatus.ExecutiveApproved, label: 'Investor signed' },
  { status: ExecutionStatus.FinancialApproved, label: 'Guardrail checked' },
  { status: ExecutionStatus.OversightApproved, label: 'Guardrail checked' },
  { status: ExecutionStatus.InReview, label: 'Guardrail checked' },
  { status: ExecutionStatus.Executed, label: 'Completed' },
];

const DISPLAY_PIPELINE_STEPS = [
  'Coordinator signed',
  'Investor signed',
  'Guardrail checked',
  'Completed',
];

function stepIndexForStatus(status: ExecutionStatus): number {
  switch (status) {
    case ExecutionStatus.Pending:
      return 0;
    case ExecutionStatus.ExecutiveApproved:
      return 1;
    case ExecutionStatus.FinancialApproved:
    case ExecutionStatus.OversightApproved:
    case ExecutionStatus.InReview:
      return 2;
    case ExecutionStatus.Executed:
      return 3;
    default:
      return 0;
  }
}

function executionStatusLabel(status: ExecutionStatus): { label: string; tone: 'complete' | 'pending' | 'halt' } {
  switch (status) {
    case ExecutionStatus.Executed:
      return { label: 'Completed', tone: 'complete' };
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
  const currentStepIdx = stepIndexForStatus(exec.status);
  const isHalted = exec.status === ExecutionStatus.Halted || exec.operationalHalt;
  const stageMatch = EXECUTION_STAGES.find((s) => s.status === exec.status);
  const activeStageLabel = isHalted
    ? `Halted: ${exec.operationalHaltReason || 'flagged by the Watcher'}`
    : stageMatch?.label ?? label;
  const propMatch = /^Prop(\d+)/i.exec(exec.proposal);
  const proposalShort = propMatch
    ? `Decision #${propMatch[1]}`
    : exec.proposal.length > 12
      ? `Move ${exec.proposal.slice(0, 6)}…${exec.proposal.slice(-4)}`
      : `Decision #${exec.proposal}`;
  const rawPlace = (exec.protocolName || 'Treasury move').replace(/_/g, ' ');
  const humanPlace = rawPlace.charAt(0).toUpperCase() + rawPlace.slice(1);

  return (
    <HairlineRow
      dotColor={tone === 'complete' ? 'green' : tone === 'halt' ? 'red' : 'brass'}
      title={`${proposalShort} · ${humanPlace}`}
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
          <div className="flex flex-wrap items-center gap-3">
            {DISPLAY_PIPELINE_STEPS.map((stepLabel, idx) => {
              const done = idx < currentStepIdx || exec.status === ExecutionStatus.Executed;
              const active = idx === currentStepIdx && exec.status !== ExecutionStatus.Executed;
              return (
                <div key={stepLabel} className="inline-flex items-center gap-2">
                  <div
                    className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{
                      backgroundColor: done ? 'hsl(var(--success))' : 'hsl(var(--surface-2))',
                      border: active ? '2px solid hsl(var(--brass))' : 'none',
                    }}
                  >
                    {done ? <Fi icon="check" style={{ fontSize: '8px', color: 'white' }} /> : null}
                  </div>
                  <span
                    style={{
                      fontSize: '12.5px',
                      fontWeight: active ? 600 : 400,
                      color: done || active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                    }}
                  >
                    {stepLabel}
                  </span>
                </div>
              );
            })}
          </div>
          {isHalted && (
            <div className="flex items-center justify-between gap-2 pt-2">
              <div style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                Halt: {exec.operationalHaltReason || 'flagged by the Watcher'}
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
  canClearHalt,
  clearingProposal,
  clearHaltErrors,
  onClearHalt,
}: {
  executions: ExecutionInfo[];
  canClearHalt?: boolean;
  clearingProposal?: string | null;
  clearHaltErrors?: Record<string, string>;
  onClearHalt?: (exec: ExecutionInfo) => void;
}) {
  if (executions.length === 0) return null;

  return (
    <Section title="In progress" hint="Coordinator signed → Investor signed → Guardrail checked → Completed">
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

/* ── Decision & Diary helpers ───────────────────────────── */
function decisionDot(decision: string | null): 'green' | 'brass' | 'red' | string {
  if (!decision) return '#CBD5E1';
  if (decision === 'approve' || decision === 'continue') return 'green';
  if (decision === 'reject' || decision === 'halt') return 'red';
  return 'brass';
}

function decisionLabel(decision: string | null, confidenceScore: number | null): string {
  const base = !decision
    ? 'Reviewed'
    : decision === 'approve'
      ? 'Approve'
      : decision === 'reject'
        ? 'Refuse to sign'
        : decision.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return confidenceScore !== null ? `${base} · ${confidenceScore}% confident` : base;
}

function summarizeConstitutionCheck(check: Record<string, unknown> | null | undefined): string {
  if (!check || typeof check !== 'object') return 'Guardrail checked rules · all passed';
  const blockDetail = constitutionBlockDetail(check);
  if (blockDetail) return `Guardrail flagged · ${blockDetail}`;
  const entries = Object.entries(check).filter(([k]) => k !== 'details' && k !== 'pass');
  if (entries.length > 0) {
    return `Guardrail checked ${entries.length} rules · all passed`;
  }
  return 'Guardrail checked rules · all passed';
}

function shortReceipt(sig: string | null | undefined): string {
  if (!sig) return 'Recorded on-chain';
  if (sig.length <= 16) return sig;
  return `${sig.slice(0, 6)}…${sig.slice(-6)}`;
}

function mapActionLogToDiaryEntry(log: AgentActionLog): DiaryEntry {
  const specialist = humanSpecialistName(log.agentRole);
  const firstSentence = log.reasoning.split(/(?<=[.!?])\s+/)[0] || log.reasoning;
  const snippet = firstSentence.length > 96 ? `${firstSentence.slice(0, 96)}…` : firstSentence;
  const checkSummary = summarizeConstitutionCheck(log.constitutionCheck);
  const timeStr = new Date(log.createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const receiptRaw = log.txSignature || log.payloadHash || log.id;

  return {
    id: log.id,
    title: `${specialist} — “${snippet}”`,
    subtitle: `${checkSummary}.`,
    when: timeStr,
    dotColor: decisionDot(log.decision),
    body: `“${log.reasoning}”`,
    decision: decisionLabel(log.decision, log.confidenceScore),
    checkedBy: checkSummary,
    signatures:
      log.decision === 'reject' || log.decision === 'halt'
        ? 'Blocked before signing'
        : 'Coordinator → Investor → Guardrail (3 of 3)',
    receipt: receiptRaw,
  };
}

function DiaryDetailModal({
  entry,
  onClose,
}: {
  entry: DiaryEntry | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [entry?.id]);

  if (!entry) return null;

  const kvRows = [
    { label: 'Decision', value: entry.decision },
    { label: 'Checked by', value: entry.checkedBy },
    { label: 'Signatures', value: entry.signatures },
    { label: 'Receipt', value: shortReceipt(entry.receipt) },
  ];

  function handleCopy() {
    if (!entry) return;
    void navigator.clipboard?.writeText(entry.receipt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <NaveModal
      open={Boolean(entry)}
      onClose={onClose}
      title={entry.title.replace(/[“”]/g, '')}
      subtitle="Agent diary · plain English first, proof below"
      maxWidth={480}
    >
      <div style={{ padding: '18px 22px 22px' }}>
        <p
          style={{
            fontSize: '13.5px',
            lineHeight: 1.7,
            color: 'hsl(var(--foreground))',
            marginTop: 0,
            marginBottom: '16px',
          }}
        >
          {entry.body}
        </p>

        <div className="border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
          {kvRows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-4 py-2.5 border-b"
              style={{ borderColor: 'hsl(var(--surface-2))', fontSize: '13px' }}
            >
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>{row.label}</span>
              <b style={{ color: 'hsl(var(--foreground))', fontWeight: 600, textAlign: 'right' }}>{row.value}</b>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 rounded-[9px] transition-colors"
            style={{ fontSize: '13px', fontWeight: 500, color: 'hsl(var(--muted-foreground))' }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="px-3.5 py-2 rounded-[9px] border font-semibold transition-colors"
            style={{
              fontSize: '13px',
              borderColor: 'hsl(var(--border))',
              backgroundColor: '#ffffff',
              color: 'hsl(var(--foreground))',
            }}
          >
            {copied ? 'Copied ✓' : 'Copy receipt'}
          </button>
        </div>
      </div>
    </NaveModal>
  );
}

/* ── Their diary section ────────────────────────────────── */
function AgentDiarySection({
  entries,
  onSelect,
}: {
  entries: DiaryEntry[];
  onSelect: (entry: DiaryEntry) => void;
}) {
  if (entries.length === 0) return null;

  return (
    <Section title="Their diary" hint="Plain English · proof on tap">
      <div>
        {entries.map((entry) => (
          <HairlineRow
            key={entry.id}
            dotColor={entry.dotColor}
            title={entry.title}
            subtitle={entry.subtitle}
            when={entry.when}
            onClick={() => onSelect(entry)}
          />
        ))}
      </div>
    </Section>
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
  const [selectedDiary, setSelectedDiary] = useState<DiaryEntry | null>(null);

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

  async function handleReassignKeys() {
    if (!daoAddress || !isFounder || reassigning) return;
    setReassignError('');
    setReassignNote('');
    setReassigning(true);
    try {
      if (chainKind === 'evm') {
        if (!evmAddress || !evmChainId || !isTreasuryOpsFamily(chainFamily)) {
          setReassignError('Connect the founder wallet on this treasury’s chain.');
          return;
        }
        const treasury = daoAddress.toLowerCase();
        const message = `nave-evm-keyreplace|${treasury}|${evmChainId}|${Date.now()}`;
        const signature = await signMessageAsync({ message });
        const { data, error } = await replaceEvmAgentKeys(
          treasury,
          evmAddress,
          evmChainId,
          chainFamily as EvmChainFamily,
          message,
          signature,
        );
        if (error || !data) {
          setReassignError(error || 'Could not store the new agent keys.');
          return;
        }
        const scheduled = await tx.sendEvm(
          buildUpdateAgentSetEvm(evmChainId, treasury, [
            data.agents.executive.address,
            data.agents.financial.address,
            data.agents.oversight.address,
            data.agents.operational.address,
          ]),
          { successLabel: 'Agent rotation scheduled', quietToast: true },
        );
        if (scheduled.status !== 'success') {
          setReassignError(scheduled.error || 'The new keys are stored, but the chain rotation was not scheduled.');
          return;
        }
        setReassignNote('Rotation is scheduled. Applying it after the testnet delay.');
        await new Promise((resolve) => setTimeout(resolve, 75_000));
        for (const role of [0, 1, 2, 3]) {
          const applied = await tx.sendEvm(
            buildApplyAgentRotationEvm(evmChainId, treasury, role),
            { successLabel: 'Agent rotation applied', quietToast: true },
          );
          if (applied.status !== 'success') {
            setReassignError(applied.error || 'The rotation is stored. Apply it again once the delay has passed.');
            return;
          }
        }
        setReassignNote('New agent keys are active on this chain.');
        agentStatus.refetch();
        return;
      }

      if (!publicKey || !signMessage) {
        setReassignError('Connect the Solana founder wallet.');
        return;
      }
      const { data, error } = await generateAgentKeys(
        daoAddress,
        publicKey.toBase58(),
        signMessage,
        undefined,
        { replace: true },
      );
      if (error || !data) {
        setReassignError(error || 'Could not store the new agent keys.');
        return;
      }
      const authorities = (['executive', 'financial', 'oversight', 'operational'] as const).map(
        (role) => new PublicKey(data.agents[role].pubkey),
      );
      const scheduled = await tx.send(
        await buildUpdateAgentSet(new PublicKey(daoAddress), publicKey, authorities),
        { successLabel: 'Agent rotation scheduled' },
      );
      if (scheduled.status !== 'success') {
        setReassignError(scheduled.error || 'The new keys are stored, but the chain rotation was not scheduled.');
        return;
      }
      setReassignNote('Rotation is scheduled. Applying it after the devnet delay.');
      await new Promise((resolve) => setTimeout(resolve, 75_000));
      for (const role of [0, 1, 2, 3]) {
        const applied = await tx.send(
          await buildApplyAgentRotation(new PublicKey(daoAddress), publicKey, role),
          { successLabel: 'Agent rotation applied' },
        );
        if (applied.status !== 'success') {
          setReassignError(applied.error || 'The rotation is stored. Apply it again once the delay has passed.');
          return;
        }
      }
      setReassignNote('New agent keys are active for this treasury.');
      agentStatus.refetch();
    } catch (err) {
      setReassignError(err instanceof Error ? err.message : 'Could not reassign the agent keys.');
    } finally {
      setReassigning(false);
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
  const [reassigning, setReassigning] = useState(false);
  const [reassignNote, setReassignNote] = useState('');
  const [reassignError, setReassignError] = useState('');

  // Clear any optimistic value once fresh on-chain state arrives.
  useEffect(() => {
    setPendingActive(null);
  }, [agentStatus.agentsEnabled]);

  // Build display-ready agent list from live data, falling back to mock
  const displayAgents = useMemo(() => {
    if (agentStatus.agents.length > 0) {
      return agentStatus.agents.map((a: AgentStatusInfo) => {
        const mock = AGENTS.find((m) => m.id === a.role) ?? AGENTS[0];
        const healthEntry = agentHealth.agents.find((h) => h.role === a.role) ?? null;
        const statusDisplay = computeAgentStatus({
          agentsEnabled: active,
          frozen: isFrozen,
          hasOnChain: true,
          onChain: { active: a.active, nullified: a.nullified, status: a.status },
          health: healthEntry,
        });
        return {
          ...mock,
          status: (a.active ? 'active' : 'paused') as 'active' | 'paused',
          statusDisplay,
          actionsToday: healthEntry ? healthEntry.actions_24h : a.actionsCount,
          lastAction: healthEntry?.last_action_at
            ? timeAgo(healthEntry.last_action_at)
            : a.lastActionAt
              ? `${Math.round((Date.now() / 1000 - a.lastActionAt) / 60)} min ago`
              : mock.lastAction,
        };
      });
    }
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

  // Build display-ready diary entries from live Claude logs or activity log, falling back to demo entries
  const diaryEntries = useMemo<DiaryEntry[]>(() => {
    if (agentStatus.actionLogs.length > 0) {
      return agentStatus.actionLogs.map(mapActionLogToDiaryEntry);
    }
    if (activityLog.activities.length > 0) {
      return activityLog.activities.slice(0, 10).map((a) => {
        const specialist = humanSpecialistName(a.agentRole || a.actor);
        const isWarn = a.eventType.includes('error') || a.eventType.includes('halt');
        return {
          id: String(a.id),
          title: `${specialist} — “${a.description}”`,
          subtitle: isWarn ? 'Flagged by Guardrail.' : 'Guardrail checked rules · all passed.',
          when: new Date(a.createdAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
          dotColor: isWarn ? 'brass' : 'green',
          body: `“${a.description}”`,
          decision: isWarn ? 'Flagged for review' : 'Approved',
          checkedBy: 'Guardrail · rules passed',
          signatures: 'Coordinator → Investor → Guardrail (3 of 3)',
          receipt: a.txSignature || String(a.id),
        };
      });
    }
    return isMock ? MOCK_DIARY_ENTRIES : [];
  }, [agentStatus.actionLogs, activityLog.activities, isMock]);

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
            'Resume the four autonomous agents (The Coordinator, The Investor, The Guardrail, The Watcher) for this treasury. Once this proposal passes, the founder activates it so the agents reconnect under the current rules.',
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
      if (!evmChainId || !isTreasuryOpsFamily(chainFamily)) {
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
          description="Connect to a treasury to view agent coordination status and diary."
          action={{ label: 'Browse treasuries', icon: 'arrow-right', onClick: () => navigate('/treasuries') }}
        />
      </div>
    );
  }

  return (
    <div className="animate-fade-in" data-onboarding-id="agent-root">
      <ConfirmAgentToggleModal
        open={showConfirm}
        active={active}
        onConfirm={handleConfirmToggle}
        onCancel={() => setShowConfirm(false)}
      />

      <DiaryDetailModal
        entry={selectedDiary}
        onClose={() => setSelectedDiary(null)}
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

        <div className="flex items-center gap-2.5 pt-1">
          <span id="agentState" style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
            {isFrozen ? 'Frozen' : active ? 'Active' : 'Paused'}
          </span>

          <button
            id="agentSwitch"
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
                    ? 'Pause the team'
                    : 'Restart the team'
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
        </div>
      </div>

      {/* Notices */}
      <div className="mt-6 space-y-2">
        {isFounder && !isMock && (
          <Notice
            tone="brass"
            actionLabel={reassigning ? 'Reassigning…' : 'Reassign agent keys'}
            onAction={reassigning ? undefined : handleReassignKeys}
          >
            <b style={{ fontWeight: 600 }}>Signer keys.</b>{' '}
            {reassignError || reassignNote || 'Assign a new agent set the current signer can open, then rotate it on-chain.'}
          </Notice>
        )}

        {isFrozen && (
          <Notice
            tone="red"
            actionLabel="Emergency controls →"
            onAction={() => navigate('/settings')}
          >
            <b style={{ fontWeight: 600 }}>Treasury frozen.</b> No money can move. Monitoring continues.
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
            actionLabel={canManageAgents ? 'Start resume vote →' : undefined}
            onAction={canManageAgents ? handleProposeEnable : undefined}
          >
            All agents are paused — no money will move until a vote restarts the team. Monitoring continues.
          </Notice>
        )}
      </div>

      {/* 4 Specialist Rows */}
      <Section>
        {displayAgents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} frozen={isFrozen} />
        ))}
      </Section>

      {/* In-Progress Execution Pipeline (only when executions exist) */}
      <ExecutionPipeline
        executions={executionPipeline.executions}
        canClearHalt={isFounder}
        clearingProposal={clearingProposal}
        clearHaltErrors={clearHaltErrors}
        onClearHalt={(exec) => void handleClearHalt(exec)}
      />

      {/* Their diary */}
      <AgentDiarySection
        entries={diaryEntries}
        onSelect={(entry) => setSelectedDiary(entry)}
      />

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
