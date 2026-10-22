import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import Fi from '../components/Fi';
import { useDaoContext } from '../hooks/useDaoContext';
import { useChain } from '../hooks/useChain';
import { signMessage as signEvmMessage } from '@wagmi/core';
import { formatDaoSlugLabel, resolveDaoBySlug } from '../lib/daoSlug';
import { checkDaoAccess, solanaAccessSigner, type DaoAccessMessageSigner } from '../lib/edgeFunctionClient';
import { wagmiConfig } from '../lib/evm/wagmi';
import { isEvmAddress, isEvmChainId } from '../lib/chain/types';
import type { DaoRegistryRow } from '../lib/supabaseClient';

type GateState =
  | { kind: 'loading' }
  | { kind: 'not-found'; slug: string }
  | { kind: 'error'; message: string }
  | { kind: 'private-disconnected'; dao: DaoRegistryRow }
  | { kind: 'not-member'; dao: DaoRegistryRow; reason: string }
  | { kind: 'ready'; dao: DaoRegistryRow };

export default function DaoSlugPage() {
  const { slug: slugParam } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { connected: solanaConnected, publicKey, signMessage: solanaSignMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const { address: evmAddress, isConnected: evmConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { rememberDaoChain } = useChain();
  const { setDaoAddress } = useDaoContext();
  const solanaWalletAddr = publicKey?.toBase58() || null;
  const evmWalletAddr = evmAddress ?? null;
  const [gate, setGate] = useState<GateState>({ kind: 'loading' });

  function walletForDao(dao: DaoRegistryRow): string | null {
    return isEvmAddress(dao.dao_onchain_address) ? evmWalletAddr : solanaWalletAddr;
  }

  function isConnectedForDao(dao: DaoRegistryRow): boolean {
    return isEvmAddress(dao.dao_onchain_address) ? evmConnected : solanaConnected;
  }

  function openWalletForDao(dao: DaoRegistryRow) {
    if (isEvmAddress(dao.dao_onchain_address)) {
      openConnectModal?.();
    } else {
      setVisible(true);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      if (!slugParam) { setGate({ kind: 'not-found', slug: '' }); return; }

      // 1. Resolve slug → DAO row
      let row: DaoRegistryRow | null = null;
      try {
        row = await resolveDaoBySlug(slugParam);
      } catch {
        if (!cancelled) setGate({ kind: 'error', message: 'Could not load this treasury.' });
        return;
      }
      if (cancelled) return;

      if (!row) {
        setGate({ kind: 'not-found', slug: slugParam });
        return;
      }
      const rowChainId = row.chain_id;
      if (typeof rowChainId === 'number' && isEvmChainId(rowChainId)) {
        rememberDaoChain(row.dao_onchain_address, rowChainId);
      }

      const walletAddr = walletForDao(row);
      const connected = isConnectedForDao(row);

      // 2. Not connected + private → gate
      if (!connected || !walletAddr) {
        if (row.privacy_enabled) {
          setGate({ kind: 'private-disconnected', dao: row });
        } else {
          // Public DAO, not connected — let them in, they just can't interact
          setGate({ kind: 'ready', dao: row });
        }
        return;
      }

      // 3. Connected — run access check (private DAOs require a signed
      // ownership message; the signer is only invoked when the server asks).
      const accessSigner: DaoAccessMessageSigner | undefined = isEvmAddress(row.dao_onchain_address)
        ? (m) => signEvmMessage(wagmiConfig, { message: m })
        : solanaSignMessage
          ? solanaAccessSigner(solanaSignMessage)
          : undefined;
      try {
        const { data: access, error: accessError } = await checkDaoAccess(row.dao_onchain_address, walletAddr, accessSigner);
        if (cancelled) return;
        if (accessError || !access) {
          setGate({ kind: 'error', message: accessError || 'Access check failed.' });
          return;
        }
        if (!access.allowed) {
          setGate({ kind: 'not-member', dao: row, reason: access.reason });
          return;
        }
        setGate({ kind: 'ready', dao: row });
      } catch {
        if (!cancelled) setGate({ kind: 'error', message: 'Could not verify your access.' });
      }
    }

    setGate({ kind: 'loading' });
    resolve();
    return () => { cancelled = true; };
  }, [slugParam, solanaConnected, solanaWalletAddr, solanaSignMessage, evmConnected, evmWalletAddr, rememberDaoChain]);

  // Auto-navigate when ready
  useEffect(() => {
    if (gate.kind !== 'ready') return;
    const { dao } = gate;
    async function enter() {
      // NOTE: `watch-dao` now requires a wallet-signed challenge, so we no
      // longer auto-watch on page load (that would spam wallet prompts). Users
      // add the DAO to their watchlist explicitly from the Treasuries lobby.
      setDaoAddress(dao.dao_onchain_address);
      navigate('/overview', { replace: true, state: { treasuryAddress: dao.dao_onchain_address } });
    }
    enter().catch((err) => {
      console.warn('[DaoSlugPage] failed to enter DAO:', err);
    });
  }, [gate, setDaoAddress, navigate]);

  /* ── Loading ─────────────────────────────────────────── */
  if (gate.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'hsl(var(--background))' }}>
        <div className="h-8 w-8 rounded-full border-2 animate-spin" style={{ borderColor: 'hsl(var(--border))', borderTopColor: 'hsl(var(--foreground))' }} />
      </div>
    );
  }

  /* ── Not found ───────────────────────────────────────── */
  if (gate.kind === 'not-found') {
    return (
      <GatePage
        icon="circle-exclamation"
        title="Treasury not found"
        body={`No treasury found for ${gate.slug ? formatDaoSlugLabel(gate.slug) : 'this link'}.`}
        action={{ label: 'Browse treasuries', onClick: () => navigate('/treasuries') }}
      />
    );
  }

  /* ── Generic error ───────────────────────────────────── */
  if (gate.kind === 'error') {
    return (
      <GatePage
        icon="circle-exclamation"
        title="Something went wrong"
        body={gate.message}
        action={{ label: 'Try again', onClick: () => window.location.reload() }}
      />
    );
  }

  /* ── Private — not connected ────────────────────────── */
  if (gate.kind === 'private-disconnected') {
    const { dao } = gate;
    return (
      <GatePage
        icon="lock"
        title={dao.name}
        badge={{ label: 'Private DAO', color: 'hsl(var(--muted-foreground))' }}
        body="This treasury is private. Connect your wallet — if you're a member, you'll be taken straight in."
        action={{
          label: 'Connect Wallet',
          primary: true,
          onClick: () => openWalletForDao(dao),
        }}
        secondary={{ label: 'Back', onClick: () => navigate(-1) }}
      />
    );
  }

  /* ── Connected but not a member ──────────────────────── */
  if (gate.kind === 'not-member') {
    const { dao, reason } = gate;
    const reasonMsg =
      reason === 'wallet_not_authorized'
        ? 'Your wallet is not in the authorized wallet list for this DAO.'
        : reason === 'wallet_not_token_holder'
          ? 'Your wallet does not hold the governance token required to access this DAO.'
          : 'Your wallet is not a member of this DAO.';
    return (
      <GatePage
        icon="shield-halved"
        title={dao.name}
        badge={{ label: 'Private DAO', color: 'hsl(var(--muted-foreground))' }}
        body={reasonMsg}
        action={{ label: 'Back to Treasuries', onClick: () => navigate('/treasuries') }}
      />
    );
  }

  // gate.kind === 'ready' → auto-navigating, show spinner
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'hsl(var(--background))' }}>
      <div className="h-8 w-8 rounded-full border-2 animate-spin" style={{ borderColor: 'hsl(var(--border))', borderTopColor: 'hsl(var(--foreground))' }} />
    </div>
  );
}

/* ── Reusable gate page layout ──────────────────────────── */
function GatePage({
  title,
  badge,
  body,
  action,
  secondary,
}: {
  icon?: string;
  title: string;
  badge?: { label: string; color: string };
  body: string;
  action: { label: string; primary?: boolean; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      <div className="text-center max-w-md w-full space-y-4">
        {badge && (
          <div className="nave-label">
            <Fi icon="lock" style={{ fontSize: '9px', marginRight: '5px' }} />
            {badge.label}
          </div>
        )}

        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 400,
            fontSize: '32px',
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            color: 'hsl(var(--foreground))',
            margin: 0,
          }}
        >
          {title}
        </h1>

        <p style={{ fontSize: '14.5px', lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
          {body}
        </p>

        <div className="flex items-center justify-center gap-2.5 pt-2 flex-wrap">
          <button
            onClick={action.onClick}
            className="px-4 py-2.5 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13.5px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
            }}
          >
            {action.label}
          </button>
          {secondary && (
            <button
              onClick={secondary.onClick}
              className="px-3.5 py-2.5 rounded-[9px] transition-all"
              style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))' }}
            >
              {secondary.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
