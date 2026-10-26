import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import Fi from '../components/Fi';
import { Notice } from '../components/calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { formatDaoSlugLabel, getDaoPublicPath } from '../lib/daoSlug';
import { getAgentSetPDA } from '../lib/pdaDerivation';
import { getNavePrograms } from '../lib/naveProgram';
import { SOLANA_NETWORK } from '../lib/programConfig';
import { daoNetworkLabel, evmExplorerUrl, isEvmChainId, solanaExplorerUrl } from '../lib/chain/types';
import ActivateTreasuryChains from '../components/ActivateTreasuryChains';

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
      <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: 'hsl(var(--background))' }}>
        <div className="text-center space-y-4">
          <p style={{ fontSize: 14, color: 'hsl(var(--muted-foreground))' }}>No treasury to display.</p>
          <button
            onClick={() => navigate('/treasuries')}
            className="px-4 py-2 rounded-[9px] font-semibold"
            style={{ fontSize: 13.5, backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
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
    navigate('/overview', { state: { treasuryAddress: state!.daoAddress, startOnboarding: true } });
  }

  const govLabel = state.governanceType === 'token' ? 'Token-Based' : 'Authorized Wallets';
  const explorerLink = getExplorerLink(state.chainId, state.daoAddress);
  const network = networkLabel(state.chainId);
  const isMultiGuardian = state.guardianCount > 1;

  const displayAgentStatus = isEvm
    ? (state.agentError ? 'error' : 'running')
    : agentStatus;
  const displayAgentColor = displayAgentStatus === 'running'
    ? 'hsl(var(--success))'
    : displayAgentStatus === 'error'
      ? 'hsl(var(--destructive))'
      : 'hsl(var(--muted-foreground))';
  const displayAgentLabel = displayAgentStatus === 'running'
    ? 'Agents running ✓'
    : displayAgentStatus === 'error'
      ? 'Agent start failed — enable from Settings'
      : 'Starting agents…';

  const rows: { label: string; value: string; mono?: boolean; copyable?: string; href?: string }[] = [
    ...(state.slug
      ? [{ label: 'Home', value: formatDaoSlugLabel(state.slug), mono: true, copyable: getDaoPublicPath(state.slug) }]
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

  const firstWord = (state.name || 'Treasury').trim().split(/\s+/)[0];

  return (
    <div className="min-h-screen px-4 sm:px-6 py-12" style={{ backgroundColor: 'hsl(var(--background))' }}>
      <div className="max-w-[540px] mx-auto pt-6">
        {/* Tick badge matching #successBlock */}
        <div
          className="grid place-items-center rounded-full mb-4"
          style={{
            width: 44,
            height: 44,
            border: '1px solid #BFE0CC',
            color: 'hsl(var(--success))',
            fontSize: 19,
          }}
        >
          ✓
        </div>

        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 400,
            fontSize: 32,
            letterSpacing: '-0.02em',
            margin: '0 0 8px',
            color: 'hsl(var(--foreground))',
          }}
        >
          Welcome aboard, <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>{firstWord}.</em>
        </h1>
        <p style={{ fontSize: 14, color: 'hsl(var(--muted-foreground))', lineHeight: 1.65, margin: '0 0 24px', maxWidth: 440 }}>
          {state.name || 'Your treasury'} is live on {network} and ready to use.
          {state.description ? ` ${state.description}` : ''}
        </p>

        {/* Single hairline KV summary list */}
        <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between gap-4 py-3"
              style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: 13.5 }}
            >
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>{r.label}</span>
              <span className="flex items-center gap-2">
                {r.href ? (
                  <a
                    href={r.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={r.mono ? 'nave-mono' : ''}
                    style={{ fontSize: r.mono ? 12.5 : 13.5, color: 'hsl(var(--foreground))', fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: '3px' }}
                  >
                    {r.value}
                    <Fi icon="arrow-up-right-from-square" style={{ fontSize: 9, marginLeft: 4 }} />
                  </a>
                ) : (
                  <strong className={r.mono ? 'nave-mono' : ''} style={{ fontSize: r.mono ? 12.5 : 13.5, color: 'hsl(var(--foreground))', fontWeight: 500 }}>
                    {r.value}
                  </strong>
                )}
                {r.copyable && (
                  <button
                    type="button"
                    onClick={() => copy(r.copyable!)}
                    title="Copy"
                    className="hover:underline underline-offset-4"
                    style={{ fontSize: 12, color: copied === r.copyable ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
                  >
                    {copied === r.copyable ? 'Copied' : 'Copy'}
                  </button>
                )}
              </span>
            </div>
          ))}

          {/* Agent status row */}
          <div
            className="flex items-center justify-between gap-4 py-3"
            style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: 13.5 }}
          >
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>Agents</span>
            <span style={{ fontWeight: 600, fontSize: 13, color: displayAgentColor }}>
              {displayAgentLabel}
            </span>
          </div>

          {/* Constitution row */}
          {(state.riskPreset || (state.approvedProtocols && state.approvedProtocols.length > 0)) && (
            <div
              className="flex items-center justify-between gap-4 py-3 flex-wrap"
              style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: 13.5 }}
            >
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>Constitution</span>
              <span className="flex items-center gap-1.5 flex-wrap justify-end">
                {state.riskPreset && (
                  <span
                    className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
                    style={{ backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
                  >
                    {state.riskPreset}
                  </span>
                )}
                {state.approvedProtocols?.map((id) => (
                  <span
                    key={id}
                    className="px-2.5 py-0.5 rounded-full text-xs capitalize border"
                    style={{ backgroundColor: '#ffffff', color: 'hsl(var(--foreground))', borderColor: 'hsl(var(--border))' }}
                  >
                    {id}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>

        {displayAgentStatus === 'error' && state.agentError && (
          <p style={{ fontSize: 12.5, color: 'hsl(var(--destructive))', marginTop: 10, lineHeight: 1.5 }}>
            {state.agentError.length > 280 ? `${state.agentError.slice(0, 280)}…` : state.agentError}
          </p>
        )}

        {isMultiGuardian && (
          <Notice tone="brass" className="mt-4">
            <span style={{ fontSize: 13 }}>
              <strong>Multi-guardian treasury:</strong> Your guardian set must vote to approve the first deployment ({state.guardianThreshold}-of-{state.guardianCount} required).
            </span>
          </Notice>
        )}

        {isEvm && state.chainId && isEvmChainId(state.chainId) && state.slug && (
          <ActivateTreasuryChains
            homeChainId={state.chainId}
            treasury={state.daoAddress}
            slug={state.slug}
            name={state.name}
            description={state.description}
          />
        )}

        {/* CTAs */}
        <div className="flex items-center gap-2.5 flex-wrap mt-7">
          <button
            type="button"
            onClick={openDashboard}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-[9px] font-semibold transition-all"
            style={{ fontSize: 13.5, backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
          >
            Go to Dashboard →
          </button>
          <button
            type="button"
            onClick={() => copy(state.daoAddress)}
            className="px-3.5 py-2.5 rounded-[9px] border font-semibold"
            style={{ fontSize: 13, backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
          >
            {copied === state.daoAddress ? 'Copied address' : 'Copy treasury address'}
          </button>
        </div>
      </div>
    </div>
  );
}
