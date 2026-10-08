import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import Fi from '../components/Fi';
import { useDaoContext } from '../hooks/useDaoContext';
import { formatDaoSlugLabel, getDaoPublicPath } from '../lib/daoSlug';
import { getAgentSetPDA } from '../lib/pdaDerivation';
import { getNavePrograms } from '../lib/naveProgram';
import { SOLANA_NETWORK } from '../lib/programConfig';
import { daoNetworkLabel, evmExplorerUrl, solanaExplorerUrl } from '../lib/chain/types';

interface SuccessState {
  daoAddress: string;
  name: string;
  slug?: string;
  description?: string;
  logoUrl?: string;
  governanceType: 'token' | 'wallets' | null;
  guardianCount: number;
  guardianThreshold: number;
  votingToken: string | null;
  /** Solana only. */
  daoId?: number;
  /** EVM: chain id (1=Ethereum, 8453=Base, 11155111=Sepolia, 84532=Base Sepolia). */
  chainId?: number;
  /** Non-null if agent-enable encountered a non-fatal error (start from Settings). */
  agentError?: string | null;
  /** Constitution risk preset name chosen in the wizard, e.g. "Balanced". */
  riskPreset?: string;
  /** Protocol IDs that were approved in the wizard, e.g. ["jito", "kamino"]. */
  approvedProtocols?: string[];
}

function shorten(addr: string) {
  return addr.length > 16 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

/** Chain-id driven explorer link (Etherscan / Basescan / Robinhood Blockscout / Solscan). */
function getExplorerLink(chainId: number | undefined, address: string): string | null {
  if (!chainId) return solanaExplorerUrl('address', address, SOLANA_NETWORK).url;
  return evmExplorerUrl(chainId, 'address', address)?.url ?? null;
}

function networkLabel(chainId: number | undefined): string {
  return daoNetworkLabel(chainId ?? null, SOLANA_NETWORK);
}

export default function DaoCreated() {
  const navigate = useNavigate();
  const location = useLocation();
  const { connection } = useConnection();
  const { setDaoAddress } = useDaoContext();
  const state = location.state as SuccessState | null;
  const [copied, setCopied] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<'starting' | 'running' | 'error'>(
    state?.agentError ? 'error' : 'starting',
  );

  const isEvm = !!state?.chainId;

  // Poll for agent-enabled on Solana (every 5s, up to 60s). Non-blocking.
  useEffect(() => {
    if (!state?.daoAddress || isEvm || state.agentError) return;
    if (agentStatus === 'running') return;

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 12; // 60 seconds

    async function poll() {
      if (cancelled || attempts >= MAX_ATTEMPTS) return;
      attempts++;
      try {
        const dao = new PublicKey(state!.daoAddress);
        const { core } = getNavePrograms(connection);
        const [agentSet] = getAgentSetPDA(dao);
        const acc = await core.account.agentSet.fetchNullable(agentSet);
        if (acc && Boolean((acc as { agentsEnabled?: boolean }).agentsEnabled)) {
          if (!cancelled) setAgentStatus('running');
          return;
        }
      } catch {
        // ignore transient RPC errors; keep polling
      }
      if (!cancelled) setTimeout(poll, 5_000);
    }

    const timer = setTimeout(poll, 3_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state?.daoAddress, isEvm, state?.agentError, connection]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state?.daoAddress) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'hsl(var(--background))' }}>
        <div className="text-center space-y-4">
          <p style={{ fontSize: 14, color: 'hsl(var(--muted-foreground))' }}>No treasury to display.</p>
          <button
            onClick={() => navigate('/treasuries')}
            className="px-5 py-2.5 rounded-lg font-medium"
            style={{ fontSize: 14, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
          >
            Go to Treasuries
          </button>
        </div>
      </div>
    );
  }

  function copy(value: string) {
    navigator.clipboard?.writeText(value);
    setCopied(value);
    setTimeout(() => setCopied(null), 1500);
  }

  function openDashboard() {
    setDaoAddress(state!.daoAddress);
    navigate('/dashboard', { state: { treasuryAddress: state!.daoAddress, startOnboarding: true } });
  }

  const govLabel = state.governanceType === 'token' ? 'Token-Based' : 'Authorized Wallets';
  const explorerLink = getExplorerLink(state.chainId, state.daoAddress);
  const network = networkLabel(state.chainId);
  const isMultiGuardian = state.guardianCount > 1;

  const rows: { label: string; value: string; mono?: boolean; copyable?: string; href?: string }[] = [
    ...(state.slug
      ? [{ label: 'DAO name', value: formatDaoSlugLabel(state.slug), mono: true, copyable: getDaoPublicPath(state.slug) }]
      : []),
    {
      label: 'Treasury address',
      value: shorten(state.daoAddress),
      mono: true,
      copyable: state.daoAddress,
      href: explorerLink ?? undefined,
    },
    { label: 'Network', value: network },
    { label: 'Governance', value: govLabel },
    ...(state.governanceType === 'wallets'
      ? [{ label: 'Guardians', value: `${state.guardianThreshold}-of-${state.guardianCount}` }]
      : []),
    ...(state.votingToken
      ? [{ label: 'Voting token', value: shorten(state.votingToken), mono: true, copyable: state.votingToken }]
      : []),
  ];

  // Agent status display
  const agentStatusColor =
    agentStatus === 'running'
      ? 'hsl(var(--success, 142 70% 40%))'
      : agentStatus === 'error'
      ? 'hsl(var(--destructive))'
      : 'hsl(var(--primary))';
  const agentStatusIcon =
    agentStatus === 'running' ? 'circle-check'
    : agentStatus === 'error' ? 'circle-xmark'
    : 'arrows-rotate';
  const agentStatusLabel =
    agentStatus === 'running' ? 'Agents running'
    : agentStatus === 'error' ? 'Agent start failed'
    : 'Starting agents…';

  // For EVM: use optimistic "running" (we just called enable; can't poll on-chain easily without a provider here)
  const displayAgentStatus = isEvm
    ? (state.agentError ? 'error' : 'running')
    : agentStatus;
  const displayAgentIcon = displayAgentStatus === 'running' ? 'circle-check'
    : displayAgentStatus === 'error' ? 'circle-xmark'
    : 'arrows-rotate';
  const displayAgentColor = displayAgentStatus === 'running'
    ? 'hsl(var(--success, 142 70% 40%))'
    : displayAgentStatus === 'error'
    ? 'hsl(var(--destructive))'
    : 'hsl(var(--primary))';
  const displayAgentLabel = displayAgentStatus === 'running' ? 'Agents running'
    : displayAgentStatus === 'error' ? 'Agent start failed — enable from Settings'
    : 'Starting agents…';

  void agentStatusColor; void agentStatusIcon; void agentStatusLabel; // used via display variants above

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" style={{ backgroundColor: 'hsl(var(--background))' }}>
      <div className="w-full" style={{ maxWidth: 520 }}>
        {/* Success header */}
        <div className="text-center mb-8">
          <div
            className="mx-auto mb-5 flex items-center justify-center rounded-full"
            style={{ width: 64, height: 64, backgroundColor: 'hsl(var(--success-muted, 142 70% 95%))' }}
          >
            <Fi icon="check" style={{ fontSize: 26, color: 'hsl(var(--success, 142 70% 40%))' }} />
          </div>
          <h1 className="text-display" style={{ fontSize: 28, letterSpacing: '-0.01em', marginBottom: 6 }}>
            {state.name || 'Untitled Treasury'}
          </h1>
          <p style={{ fontSize: 14.5, color: 'hsl(var(--muted-foreground))' }}>
            Your treasury is live on {network} and ready to use.
          </p>
        </div>

        {/* Identity card */}
        <div className="nave-card overflow-hidden mb-5">
          <div className="flex items-center gap-3.5 px-5 py-4 border-b" style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}>
            <div
              className="flex items-center justify-center rounded-xl overflow-hidden"
              style={{ width: 48, height: 48, backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))', flexShrink: 0 }}
            >
              {state.logoUrl ? (
                <img src={state.logoUrl} alt={state.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <Fi icon="building-columns" style={{ fontSize: 18, color: 'hsl(var(--muted-foreground))' }} />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-display font-semibold truncate" style={{ fontSize: 16 }}>{state.name || 'Untitled Treasury'}</div>
              {state.slug && (
                <div className="nave-mono truncate" style={{ fontSize: 12, color: 'hsl(var(--primary))' }}>
                  {formatDaoSlugLabel(state.slug)}
                </div>
              )}
              {state.description && (
                <div className="truncate" style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>{state.description}</div>
              )}
            </div>
          </div>
          <div className="divide-y" style={{ borderColor: 'hsl(var(--border))' }}>
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between px-5 py-3">
                <span style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>{r.label}</span>
                <span className="flex items-center gap-2">
                  {r.href ? (
                    <a
                      href={r.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={r.mono ? 'nave-mono' : ''}
                      style={{ fontSize: 13, color: 'hsl(var(--primary))', fontWeight: 500, textDecoration: 'underline' }}
                    >
                      {r.value}
                      <Fi icon="arrow-up-right-from-square" style={{ fontSize: 10, marginLeft: 4 }} />
                    </a>
                  ) : (
                    <span className={r.mono ? 'nave-mono' : ''} style={{ fontSize: 13, color: 'hsl(var(--foreground))', fontWeight: 500 }}>
                      {r.value}
                    </span>
                  )}
                  {r.copyable && (
                    <button onClick={() => copy(r.copyable!)} title="Copy" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <Fi icon={copied === r.copyable ? 'check' : 'copy'} style={{ fontSize: 12 }} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Agent status */}
        <div
          className="nave-card px-5 py-4 mb-4 flex items-center gap-3"
          style={{ borderColor: 'hsl(var(--border))' }}
        >
          <Fi
            icon={displayAgentIcon}
            className={displayAgentStatus === 'starting' ? 'animate-spin' : undefined}
            style={{ fontSize: 16, color: displayAgentColor, flexShrink: 0 }}
          />
          <div className="flex-1 min-w-0">
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'hsl(var(--foreground))' }}>
              Agent Status
            </div>
            <div style={{ fontSize: 12.5, color: displayAgentColor }}>
              {displayAgentLabel}
            </div>
          </div>
        </div>

        {/* Constitution summary */}
        {(state.riskPreset || (state.approvedProtocols && state.approvedProtocols.length > 0)) && (
          <div className="nave-card px-5 py-4 mb-4 space-y-2">
            <div style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--foreground))', marginBottom: 6 }}>
              <Fi icon="shield" style={{ fontSize: 12, marginRight: 6 }} />
              Constitution
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {state.riskPreset && (
                <span
                  className="px-2.5 py-1 rounded-lg text-xs font-medium"
                  style={{ backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                >
                  {state.riskPreset}
                </span>
              )}
              {state.approvedProtocols?.map((id) => (
                <span
                  key={id}
                  className="px-2.5 py-1 rounded-lg text-xs capitalize"
                  style={{ backgroundColor: 'hsl(var(--accent-muted))', color: 'hsl(var(--accent-muted-foreground))', border: '1px solid hsl(var(--border-strong))' }}
                >
                  {id}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Multi-guardian note */}
        {isMultiGuardian && (
          <div
            className="flex items-start gap-2.5 p-4 rounded-xl border mb-4"
            style={{ backgroundColor: 'hsl(var(--accent-muted))', borderColor: 'hsl(var(--border-strong))' }}
          >
            <Fi icon="users" style={{ fontSize: 14, color: 'hsl(var(--accent))', flexShrink: 0, marginTop: 2 }} />
            <p style={{ fontSize: 12.5, color: 'hsl(var(--accent-muted-foreground))', lineHeight: 1.6 }}>
              <strong>Multi-guardian treasury:</strong> Agents are enabled and will propose strategies.
              Your guardian set must vote to approve the first deployment ({state.guardianThreshold}-of-{state.guardianCount} required).
            </p>
          </div>
        )}

        {/* CTAs */}
        <button
          onClick={openDashboard}
          className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl font-semibold transition-all mb-3"
          style={{ fontSize: 15, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', boxShadow: 'var(--shadow-md)' }}
        >
          <Fi icon="gauge" style={{ fontSize: 14 }} />
          Go to Dashboard
        </button>
        <p className="text-center mb-3" style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>
          Your dashboard includes an activation checklist to guide funding, rules, and agents.
        </p>
        <button
          onClick={() => copy(state.daoAddress)}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border"
          style={{ fontSize: 13.5, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
        >
          <Fi icon={copied === state.daoAddress ? 'check' : 'copy'} style={{ fontSize: 12 }} />
          {copied === state.daoAddress ? 'Copied treasury address' : 'Copy treasury address'}
        </button>
      </div>
    </div>
  );
}
