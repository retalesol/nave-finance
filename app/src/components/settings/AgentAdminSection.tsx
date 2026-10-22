import { useState, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useSignMessage } from 'wagmi';
import Fi from '../Fi';
import { Section, UnderlineTabs, Notice } from '../calm';
import { useAgentHealth, timeAgo } from '../../hooks/useAgentHealth';
import { useAgentStatus } from '../../hooks/useAgentStatus';
import { computeAgentStatus, summarizeAgentStatuses } from '../../lib/agentStatus';
import { agentRoleLabel } from '../../lib/agentRoleLabel';
import { useAgentSessions, type AgentSession } from '../../hooks/useAgentSessions';
import { useChain } from '../../hooks/useChain';
import { isTreasuryOpsFamily } from '../../lib/chain/types';
import { dispatchViaProxy, type AgentRole } from '../../lib/edgeFunctionClient';

const AGENT_ROLES: { role: AgentRole; label: string; icon: string; desc: string }[] = [
  { role: 'executive', label: 'Executive', icon: 'crown', desc: 'Strategic coordinator — first approval' },
  { role: 'financial', label: 'Financial', icon: 'money-bill-wave', desc: 'Operations layer — second approval' },
  { role: 'oversight', label: 'Operational', icon: 'eye', desc: 'Safeguard layer — final approval' },
  { role: 'operational', label: 'Oversight', icon: 'gear', desc: 'Monitoring — does not sign' },
];

function sessionStatusMeta(status: string): { color: string; label: string } {
  switch (status) {
    case 'active':
      return { color: 'hsl(var(--success))', label: 'Active' };
    case 'completed':
      return { color: 'hsl(var(--foreground))', label: 'Completed' };
    case 'failed':
      return { color: 'hsl(var(--destructive))', label: 'Failed' };
    case 'expired':
      return { color: 'hsl(var(--warning))', label: 'Expired' };
    default:
      return { color: 'hsl(var(--muted-foreground))', label: status };
  }
}

export default function AgentAdminSection({ daoAddress, frozen }: { daoAddress: string | null; frozen: boolean }) {
  const { publicKey, signMessage } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { chainKind, evmChainId, chainFamily } = useChain();
  const health = useAgentHealth(daoAddress);
  const agentStatus = useAgentStatus(daoAddress);
  const sessions = useAgentSessions(daoAddress);
  const hasOnChain = agentStatus.onChainData !== null;

  // Single accurate status per role: on-chain enablement refined by activity.
  const roleStatuses = useMemo(
    () =>
      AGENT_ROLES.map(agent => {
        const onChainAgent = agentStatus.agents.find(a => a.role === agent.role) ?? null;
        const healthEntry = health.agents.find(a => a.role === agent.role) ?? null;
        const status = computeAgentStatus({
          agentsEnabled: agentStatus.agentsEnabled,
          frozen,
          hasOnChain,
          onChain: onChainAgent
            ? { active: onChainAgent.active, nullified: onChainAgent.nullified, status: onChainAgent.status }
            : null,
          health: healthEntry,
        });
        return { agent, healthEntry, status };
      }),
    [agentStatus.agents, agentStatus.agentsEnabled, health.agents, frozen, hasOnChain],
  );

  const systemSummary = useMemo(
    () => summarizeAgentStatuses(roleStatuses.map(r => r.status)),
    [roleStatuses],
  );
  const systemOperational = systemSummary.level === 'active';
  const [activeTab, setActiveTab] = useState<'status' | 'sessions' | 'dispatch'>('status');
  const [dispatchRole, setDispatchRole] = useState<AgentRole>('executive');
  const [dispatchExecReq, setDispatchExecReq] = useState('');
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<{ success: boolean; message: string } | null>(null);
  const [sessionFilter, setSessionFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');

  const filteredSessions = useMemo(() => {
    if (sessionFilter === 'all') return sessions.sessions;
    return sessions.sessions.filter(s => s.sessionStatus === sessionFilter);
  }, [sessions.sessions, sessionFilter]);

  async function handleDispatch() {
    if (!dispatchExecReq.trim()) return;
    if (!daoAddress) {
      setDispatchResult({ success: false, message: 'No DAO selected.' });
      return;
    }
    if (chainKind === 'evm') {
      if (!evmAddress || !evmChainId || (!isTreasuryOpsFamily(chainFamily))) {
        setDispatchResult({ success: false, message: 'Connect an Ethereum, Base, or Robinhood founder wallet.' });
        return;
      }
      const raw = dispatchExecReq.trim();
      const hashIdx = raw.includes('#') ? raw.split('#')[1] : raw;
      const index = Number(hashIdx);
      if (!Number.isFinite(index) || index < 0) {
        setDispatchResult({ success: false, message: 'Enter an EVM execution request index (e.g. 0 or 0xExec…#0).' });
        return;
      }
      setDispatchLoading(true);
      setDispatchResult(null);
      try {
        const { dispatchViaProxyEvm } = await import('../../lib/edgeFunctionClient');
        const { data, error } = await dispatchViaProxyEvm(
          daoAddress,
          evmAddress,
          (m) => signMessageAsync({ message: m }),
          raw.includes('#') ? raw : String(index),
          evmChainId,
          chainFamily,
          index,
        );
        if (error || !data?.success) {
          setDispatchResult({ success: false, message: error || 'EVM dispatch failed.' });
        } else {
          setDispatchResult({
            success: true,
            message: `EVM orchestrator processed request #${index} (${data.execution_requests_processed ?? 0} step(s)).`,
          });
        }
      } catch (err) {
        setDispatchResult({ success: false, message: err instanceof Error ? err.message : 'Dispatch failed.' });
      } finally {
        setDispatchLoading(false);
      }
      return;
    }
    if (!publicKey || !signMessage) {
      setDispatchResult({ success: false, message: 'Connect a wallet that supports message signing.' });
      return;
    }
    setDispatchLoading(true);
    setDispatchResult(null);
    try {
      const { data, error } = await dispatchViaProxy(
        daoAddress,
        publicKey.toBase58(),
        signMessage,
        dispatchExecReq.trim(),
      );
      if (error || !data?.success) {
        setDispatchResult({ success: false, message: error || 'Dispatch failed.' });
      } else {
        const processed = data.execution_requests_processed ?? 0;
        setDispatchResult({
          success: true,
          message: `Orchestrator ran for ${dispatchExecReq.slice(0, 8)}…${dispatchExecReq.slice(-4)} — ${processed} request(s) processed${data.errors?.length ? `, ${data.errors.length} error(s)` : ''}.`,
        });
      }
    } catch (err) {
      setDispatchResult({ success: false, message: err instanceof Error ? err.message : 'Dispatch failed.' });
    } finally {
      setDispatchLoading(false);
    }
  }

  return (
    <Section
      title="Agent administration"
      hint={`${systemOperational ? 'System healthy' : systemSummary.label} · ${sessions.activeSessions.length} active session${sessions.activeSessions.length !== 1 ? 's' : ''}`}
    >
      <div className="space-y-4">
        <UnderlineTabs
          tabs={[
            { id: 'status', label: 'Status' },
            { id: 'sessions', label: 'Activity' },
            { id: 'dispatch', label: 'Advanced' },
          ]}
          activeTab={activeTab}
          onChange={setActiveTab}
        />

        {/* ── Tab: Agent Status ─────────────────────────── */}
        {activeTab === 'status' && (
          <div>
            {roleStatuses.map(({ agent, healthEntry: agentHealth, status }) => {
              const color = status.color;

              return (
                <div
                  key={agent.role}
                  className="flex items-start gap-3 py-3.5"
                  style={{
                    borderBottom: '1px solid hsl(var(--surface-2))',
                  }}
                >
                  <span
                    className="rounded-full flex-shrink-0"
                    style={{
                      width: '7px',
                      height: '7px',
                      marginTop: '7px',
                      backgroundColor: color,
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>
                        {agent.label} Agent
                      </span>
                      <span
                        style={{
                          fontSize: '12px',
                          fontWeight: 600,
                          color,
                        }}
                      >
                        {status.label}
                      </span>
                    </div>
                    <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', margin: '3px 0 0', lineHeight: 1.5 }}>
                      {agent.desc}
                    </p>
                  </div>

                  {/* Metrics */}
                  <div className="hidden sm:flex items-center gap-4 flex-shrink-0 text-right pt-0.5">
                    <div>
                      <div className="nave-label" style={{ fontSize: '9px' }}>24h Ops</div>
                      <div className="nave-mono" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>
                        {agentHealth?.actions_24h ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="nave-label" style={{ fontSize: '9px' }}>Errors</div>
                      <div
                        className="nave-mono"
                        style={{
                          fontSize: '12.5px',
                          color: (agentHealth?.errors_24h ?? 0) > 0 ? 'hsl(var(--destructive))' : 'hsl(var(--foreground))',
                        }}
                      >
                        {agentHealth?.errors_24h ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="nave-label" style={{ fontSize: '9px' }}>Last Action</div>
                      <div
                        className="nave-mono"
                        style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
                      >
                        {agentHealth ? timeAgo(agentHealth.last_action_at) : 'Never'}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            <Notice tone={systemOperational ? 'green' : 'brass'} className="mt-2">
              <span style={{ fontSize: '13px' }}>
                {systemOperational
                  ? 'All agents operating within normal parameters'
                  : systemSummary.label}
              </span>
              {health.checkedAt && (
                <span
                  className="ml-2 nave-mono"
                  style={{ fontSize: '11.5px', color: 'hsl(var(--faint))' }}
                >
                  · Checked {timeAgo(health.checkedAt)}
                </span>
              )}
            </Notice>
          </div>
        )}

        {/* ── Tab: Session History ──────────────────────── */}
        {activeTab === 'sessions' && (
          <div className="space-y-3">
            {/* Filter bar */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {(['all', 'active', 'completed', 'failed'] as const).map(f => {
                const active = sessionFilter === f;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setSessionFilter(f)}
                    className="px-3 py-1 rounded-full border transition-all"
                    style={{
                      fontSize: '12px',
                      fontWeight: active ? 600 : 400,
                      backgroundColor: active ? 'hsl(var(--foreground))' : '#ffffff',
                      color: active ? '#ffffff' : 'hsl(var(--muted-foreground))',
                      borderColor: active ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                    }}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                    {f === 'active' && sessions.activeSessions.length > 0 && (
                      <span className="ml-1">({sessions.activeSessions.length})</span>
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={sessions.refetch}
                className="ml-auto hover:underline underline-offset-4"
                style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
              >
                Refresh
              </button>
            </div>

            {/* Session list */}
            {sessions.loading ? (
              <div className="py-4" style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
                Loading sessions…
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="py-6" style={{ color: 'hsl(var(--muted-foreground))', fontSize: '13.5px' }}>
                {sessionFilter === 'all' ? 'No agent sessions recorded.' : `No ${sessionFilter} sessions.`}
              </div>
            ) : (
              <div>
                {filteredSessions.map((session: AgentSession, idx) => {
                  const meta = sessionStatusMeta(session.sessionStatus);
                  const roleInfo = AGENT_ROLES.find(a => a.role === session.agentRole);
                  const duration = session.completedAt
                    ? Math.round((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 1000)
                    : null;

                  return (
                    <div
                      key={session.id}
                      className="flex items-start gap-3 py-3"
                      style={{
                        borderTop: idx === 0 ? '1px solid hsl(var(--surface-2))' : 'none',
                        borderBottom: '1px solid hsl(var(--surface-2))',
                      }}
                    >
                      <span
                        className="rounded-full flex-shrink-0"
                        style={{ width: '7px', height: '7px', marginTop: '7px', backgroundColor: meta.color }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span style={{ fontSize: '13.5px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>
                            {roleInfo?.label || agentRoleLabel(session.agentRole)}
                          </span>
                          {duration !== null && (
                            <span className="nave-mono" style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
                              · {duration}s
                            </span>
                          )}
                        </div>
                        <div
                          className="mt-0.5 flex items-center gap-2 flex-wrap"
                          style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}
                        >
                          <span>
                            {session.executionRequestAddress.slice(0, 6)}…{session.executionRequestAddress.slice(-4)}
                          </span>
                          <span>·</span>
                          <span>
                            {new Date(session.startedAt).toLocaleString(undefined, {
                              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                            })}
                          </span>
                        </div>
                        {session.errorMessage && (
                          <p
                            className="mt-1 mb-0"
                            style={{ fontSize: '12px', color: 'hsl(var(--destructive))', lineHeight: 1.45 }}
                          >
                            {session.errorMessage}
                          </p>
                        )}
                      </div>
                      <span
                        className="ml-auto flex-shrink-0 pt-0.5"
                        style={{ fontSize: '12px', fontWeight: 600, color: meta.color }}
                      >
                        {meta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Session stats footer */}
            {sessions.sessions.length > 0 && (
              <div className="flex items-center justify-between pt-2" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                <span className="nave-mono">
                  {sessions.sessions.length} total session{sessions.sessions.length !== 1 ? 's' : ''}
                </span>
                <div className="flex items-center gap-3 nave-mono">
                  <span style={{ color: 'hsl(var(--success))' }}>
                    {sessions.sessions.filter(s => s.sessionStatus === 'completed').length} completed
                  </span>
                  <span style={{ color: 'hsl(var(--destructive))' }}>
                    {sessions.sessions.filter(s => s.sessionStatus === 'failed').length} failed
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Manual Dispatch ──────────────────────── */}
        {activeTab === 'dispatch' && (
          <div className="space-y-4">
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
              Agents run on their own. Use manual dispatch only if a run got stuck and support asked you to retry it.
            </p>

            {/* Agent role selector */}
            <div>
              <label className="nave-label block mb-2">
                Agent role
              </label>
              <div className="flex flex-wrap gap-2">
                {AGENT_ROLES.map(agent => {
                  const sel = dispatchRole === agent.role;
                  return (
                    <button
                      key={agent.role}
                      type="button"
                      onClick={() => setDispatchRole(agent.role)}
                      className="px-3.5 py-2 rounded-full border transition-all"
                      style={{
                        fontSize: '13px',
                        fontWeight: sel ? 600 : 400,
                        backgroundColor: sel ? 'hsl(var(--foreground))' : '#ffffff',
                        borderColor: sel ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                        color: sel ? '#ffffff' : 'hsl(var(--foreground))',
                      }}
                    >
                      {agent.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Execution request address */}
            <div>
              <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600 }}>
                Execution request address
              </label>
              <input
                type="text"
                value={dispatchExecReq}
                onChange={e => setDispatchExecReq(e.target.value)}
                placeholder={chainKind === 'evm' ? 'Request number (e.g. 0)' : 'Request id from support'}
                className="w-full px-3 py-2.5 rounded-[10px] border transition-colors outline-none"
                style={{
                  fontSize: '13.5px',
                  fontFamily: 'var(--font-mono)',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              />
            </div>

            {/* Dispatch button */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleDispatch}
                disabled={dispatchLoading || !dispatchExecReq.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                  opacity: dispatchLoading || !dispatchExecReq.trim() ? 0.45 : 1,
                  cursor: dispatchLoading || !dispatchExecReq.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {dispatchLoading ? 'Dispatching…' : 'Dispatch agent'}
              </button>
              <span
                className="nave-mono"
                style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
              >
                {dispatchRole} → {dispatchExecReq ? `${dispatchExecReq.slice(0, 8)}…` : 'no target'}
              </span>
            </div>

            {/* Result feedback */}
            {dispatchResult && (
              <Notice tone={dispatchResult.success ? 'green' : 'red'}>
                <span style={{ fontSize: '13px' }}>{dispatchResult.message}</span>
                <button
                  type="button"
                  onClick={() => setDispatchResult(null)}
                  className="ml-2 underline"
                  style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
                >
                  dismiss
                </button>
              </Notice>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
