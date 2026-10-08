import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import Fi from '../components/Fi';
import { CardSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import WalletNetworkMenu from '../components/WalletNetworkMenu';
import RobinhoodTreasuryNotice from '../components/RobinhoodTreasuryNotice';
import { useChain } from '../hooks/useChain';
import { APP_WALLET_CHAINS, chainFamilyLabel, evmTarget, isEvmAddress, isEvmChainId } from '../lib/chain/types';
import { useWatchedDaos } from '../hooks/useWatchedDaos';
import { MOCK_DAO_ADDRESS, DEMO_TREASURY_NAV_ENABLED } from '../lib/mockData';
import { signMessage as signEvmMessage } from '@wagmi/core';
import { formatDaoSlugLabel, getDaoPublicUrl, parseJoinInput, resolveDaoBySlug } from '../lib/daoSlug';
import { checkDaoAccess, solanaAccessSigner, type DaoAccessMessageSigner } from '../lib/edgeFunctionClient';
import { wagmiConfig } from '../lib/evm/wagmi';

interface JoinRouteState {
  joinInput?: string;
  joinAddress?: string;
  joinDaoName?: string;
}

function chainBadgeLabel(chainId: number | null, daoAddress: string): string {
  if (typeof chainId === 'number' && isEvmChainId(chainId)) {
    return evmTarget(chainId).label;
  }
  if (isEvmAddress(daoAddress)) return 'EVM';
  return 'Solana';
}

/* ── Page ───────────────────────────────────────────────── */
export default function TreasuryLobby() {
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = (location.state as JoinRouteState | null) ?? {};
  const { publicKey, connected: solanaConnected, signMessage: solanaSignMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const { address: evmAddress, isConnected: evmConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { target, rememberDaoChain } = useChain();
  const isEvm = target.kind === 'evm';
  const connected = isEvm ? evmConnected : solanaConnected;
  const [joinInput, setJoinInput] = useState(routeState.joinInput ?? '');
  const [joinError, setJoinError] = useState('');
  const [joining, setJoining] = useState(false);
  const [removingDao, setRemovingDao] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const walletAddr = isEvm ? (evmAddress ?? null) : (publicKey?.toBase58() || null);
  // Signs private-DAO access checks and the `watch-dao` challenge. Only invoked
  // from explicit user actions (join), never on page load.
  const accessSigner: DaoAccessMessageSigner | undefined = isEvm
    ? (m) => signEvmMessage(wagmiConfig, { message: m })
    : solanaSignMessage
      ? solanaAccessSigner(solanaSignMessage)
      : undefined;
  const { daos: watchedDaos, loading: watchLoading, watchDao, unwatchDao } = useWatchedDaos(walletAddr, accessSigner);

  // Lobby is scoped to the selected network (Base vs Robinhood). Watched rows
  // are wallet-wide in Supabase; filter here so switching networks shows only
  // treasuries that live on the active chain.
  const networkDaos = useMemo(
    () =>
      watchedDaos.filter((d) => {
        if (typeof d.chainId === 'number' && isEvmChainId(d.chainId)) {
          return evmTarget(d.chainId).family === target.family;
        }
        if (!isEvmAddress(d.daoOnchainAddress)) {
          return target.kind === 'solana';
        }
        // EVM address without registry chain_id — ambiguous across Base/RH.
        return false;
      }),
    [watchedDaos, target.family, target.kind],
  );

  const networkLabel = chainFamilyLabel(target.family);

  /** Open the wallet connect modal for the currently-selected chain. */
  function openConnect() {
    if (isEvm) {
      openConnectModal?.();
    } else {
      setVisible(true);
    }
  }

  useEffect(() => {
    if (routeState.joinInput) {
      setJoinInput(routeState.joinInput);
    }
  }, [routeState.joinInput]);

  async function handleJoin() {
    if (!connected) {
      setJoinError('Connect your wallet before joining a treasury.');
      openConnect();
      return;
    }

    const raw = joinInput.trim();
    if (!raw) {
      setJoinError('Enter a DAO name (e.g. nave) or treasury address.');
      return;
    }

    setJoinError('');
    setJoining(true);

    try {
      let addr = routeState.joinAddress?.trim() || '';
      const parsed = parseJoinInput(raw);

      if (parsed.type === 'slug') {
        const validationMsg =
          parsed.value.length < 3 ? 'Enter a valid DAO name (at least 3 characters).' : '';
        if (validationMsg) {
          setJoinError(validationMsg);
          return;
        }
        const row = await resolveDaoBySlug(parsed.value);
        if (!row) {
          setJoinError(`No treasury found for ${formatDaoSlugLabel(parsed.value)}.`);
          return;
        }
        addr = row.dao_onchain_address;
        const rowChainId = row.chain_id;
        if (typeof rowChainId === 'number' && isEvmChainId(rowChainId)) {
          rememberDaoChain(addr, rowChainId);
        }
      } else {
        addr = parsed.value;
      }

      if (addr.length < 32) {
        setJoinError('Enter a valid DAO name or treasury address.');
        return;
      }

      if (walletAddr) {
        // Private DAOs require proving wallet ownership with a signed message.
        const { data: access, error: accessError } = await checkDaoAccess(addr, walletAddr, accessSigner);
        if (accessError) {
          setJoinError(accessError);
          return;
        }
        const accessReason = access?.reason ?? 'access_denied';
        if (!access?.allowed) {
          if (accessReason === 'wallet_not_authorized') {
            setJoinError('This DAO is private. Your wallet is not in the authorized wallet list.');
          } else if (accessReason === 'wallet_not_token_holder') {
            setJoinError('This DAO is private. Your wallet does not currently hold the governance token.');
          } else {
            setJoinError('This DAO is private and access was denied for this wallet.');
          }
          return;
        }
      }

      await watchDao(addr);
      navigate('/dashboard', { state: { treasuryAddress: addr } });
    } catch {
      setJoinError('Could not join that treasury. Try again.');
    } finally {
      setJoining(false);
    }
  }

  async function handleRemove(daoAddress: string) {
    if (confirmRemove !== daoAddress) {
      setConfirmRemove(daoAddress);
      return;
    }
    setConfirmRemove(null);
    setRemovingDao(daoAddress);
    try {
      await unwatchDao(daoAddress);
    } finally {
      setRemovingDao(null);
    }
  }

  /* ── Not connected ──────────────────────────────────────── */
  if (!connected) {
    return (
      <div
        className="min-h-screen flex flex-col"
        style={{ backgroundColor: 'hsl(var(--background))' }}
      >
        <Header />
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="w-full max-w-md text-center">
            {target.family === 'robinhood' && <RobinhoodTreasuryNotice />}
            <div
              className="mx-auto mb-6 flex items-center justify-center rounded-2xl"
              style={{
                width: '64px',
                height: '64px',
                backgroundColor: 'hsl(var(--surface-1))',
                border: '1px solid hsl(var(--border))',
              }}
            >
              <Fi icon="landmark" style={{ fontSize: '24px', color: 'hsl(var(--foreground))' }} />
            </div>
            <h1
              className="text-display"
              style={{ fontSize: '26px', letterSpacing: '-0.02em', color: 'hsl(var(--foreground))', marginBottom: '8px' }}
            >
              Your Treasuries
            </h1>
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', marginBottom: '20px' }}>
              Connect your wallet to view treasuries you belong to, or join one by DAO name (e.g. nave) or contract address.
            </p>
            <button
              onClick={openConnect}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium transition-all"
              style={{
                fontSize: '14px',
                backgroundColor: 'hsl(var(--primary))',
                color: 'hsl(var(--primary-foreground))',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              {isEvm ? `Connect ${chainFamilyLabel(target.family)} Wallet` : 'Connect Wallet'}
            </button>

            {DEMO_TREASURY_NAV_ENABLED && (
            <button
              onClick={() => navigate('/dashboard', { state: { treasuryAddress: MOCK_DAO_ADDRESS } })}
              className="w-full flex items-center justify-center gap-2 mt-3 py-3 rounded-xl border font-medium transition-all"
              style={{
                fontSize: '13.5px',
                color: 'hsl(var(--foreground))',
                borderColor: 'hsl(var(--border-strong))',
                backgroundColor: 'hsl(var(--surface-0))',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))';
                e.currentTarget.style.borderColor = 'hsl(var(--foreground))';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'hsl(var(--surface-0))';
                e.currentTarget.style.borderColor = 'hsl(var(--border-strong))';
              }}
            >
              <Fi icon="eye" style={{ fontSize: '13px' }} />
              Nave Test DAO (demo)
            </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const shortAddr = walletAddr ? walletAddr.slice(0, 4) + '\u2026' + walletAddr.slice(-4) : '';

  /* ── Connected — show treasuries ────────────────────────── */
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      <Header />

      <div className="flex-1 max-w-2xl mx-auto w-full px-4 sm:px-6 py-10">
        {target.family === 'robinhood' && <RobinhoodTreasuryNotice />}

        {/* Heading */}
        <div className="mb-8">
          <h1
            className="text-display"
            style={{ fontSize: '26px', letterSpacing: '-0.02em', color: 'hsl(var(--foreground))' }}
          >
            Your Treasuries
          </h1>
          <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px' }}>
            Connected as <span className="nave-mono">{shortAddr}</span>
            {' · '}
            {networkLabel}
          </p>
        </div>

        {DEMO_TREASURY_NAV_ENABLED && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => navigate('/dashboard', { state: { treasuryAddress: MOCK_DAO_ADDRESS } })}
            className="w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all"
            style={{
              backgroundColor: 'hsl(var(--surface-0))',
              borderColor: 'hsl(var(--primary) / 0.35)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'hsl(var(--primary))';
              e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'hsl(var(--primary) / 0.35)';
              e.currentTarget.style.backgroundColor = 'hsl(var(--surface-0))';
            }}
          >
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: 'hsl(var(--primary))' }}
            >
              <Fi icon="wand-magic-sparkles" style={{ fontSize: '15px', color: 'white' }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium" style={{ fontSize: '14px', color: 'hsl(var(--foreground))' }}>
                Nave Test DAO
              </div>
              <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                Demo treasury · full dashboard without a live on-chain DAO
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span
                className="px-2 py-0.5 rounded-full"
                style={{
                  fontSize: '11px',
                  backgroundColor: 'hsl(var(--surface-1))',
                  border: '1px solid hsl(var(--border))',
                  color: 'hsl(var(--muted-foreground))',
                }}
              >
                Demo
              </span>
              <Fi icon="chevron-right" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }} />
            </div>
          </button>
        </div>
        )}

        {/* Treasury list or empty state */}
        {watchLoading ? (
          <div className="space-y-3 mb-8">
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
          </div>
        ) : networkDaos.length > 0 ? (
          <div className="space-y-3 mb-8">
            {networkDaos.map(t => {
              const isRemoving = removingDao === t.daoOnchainAddress;
              const isPendingConfirm = confirmRemove === t.daoOnchainAddress;
              const shareUrl = t.slug ? getDaoPublicUrl(t.slug) : null;
              const shareLabel = t.slug ? formatDaoSlugLabel(t.slug) : `${t.daoOnchainAddress.slice(0, 6)}…${t.daoOnchainAddress.slice(-4)}`;
              function openWatchedDao() {
                if (typeof t.chainId === 'number' && isEvmChainId(t.chainId)) {
                  rememberDaoChain(t.daoOnchainAddress, t.chainId);
                }
                navigate('/dashboard', { state: { treasuryAddress: t.daoOnchainAddress } });
              }
              return (
                <DaoCard
                  key={t.daoOnchainAddress}
                  name={t.name}
                  governanceType={t.governanceType}
                  chainLabel={chainBadgeLabel(t.chainId, t.daoOnchainAddress)}
                  shareUrl={shareUrl}
                  shareLabel={shareLabel}
                  isRemoving={isRemoving}
                  isPendingConfirm={isPendingConfirm}
                  onOpen={openWatchedDao}
                  onRemove={() => handleRemove(t.daoOnchainAddress)}
                  onMouseLeave={() => { if (confirmRemove === t.daoOnchainAddress) setConfirmRemove(null); }}
                />
              );
            })}
          </div>
        ) : (
          <div className="mb-8">
            <NaveEmptyState
              icon="landmark"
              title={`No ${networkLabel} treasuries`}
              description={
                DEMO_TREASURY_NAV_ENABLED
                  ? `This wallet has no treasuries on ${networkLabel} yet. Create one, join by name/address, switch networks, or explore a demo.`
                  : `This wallet has no treasuries on ${networkLabel} yet. Create one, join by name/address, or switch networks in the header.`
              }
              action={{ label: 'Create Treasury', icon: 'plus', onClick: () => navigate('/create-dao') }}
            />

            {DEMO_TREASURY_NAV_ENABLED && (
            <button
              onClick={() => navigate('/dashboard', { state: { treasuryAddress: MOCK_DAO_ADDRESS } })}
              className="w-full flex items-center justify-center gap-2.5 mt-3 py-3 rounded-xl border transition-all"
              style={{
                fontSize: '13.5px',
                fontWeight: '500',
                color: 'hsl(var(--foreground))',
                borderColor: 'hsl(var(--border-strong))',
                backgroundColor: 'hsl(var(--surface-0))',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))';
                e.currentTarget.style.borderColor = 'hsl(var(--foreground))';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'hsl(var(--surface-0))';
                e.currentTarget.style.borderColor = 'hsl(var(--border-strong))';
              }}
            >
              <Fi icon="eye" style={{ fontSize: '13px' }} />
              Nave Test DAO (demo)
            </button>
            )}
          </div>
        )}

        {/* Join by address */}
        <div
          className="rounded-xl border p-5"
          style={{
            backgroundColor: 'hsl(var(--surface-0))',
            borderColor: 'hsl(var(--border))',
          }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Fi icon="arrow-right-to-bracket" style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }} />
            <span style={{ fontSize: '13.5px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>
              Join a Treasury
            </span>
          </div>
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5, marginBottom: '12px' }}>
            Enter a DAO name like <span className="nave-mono">nave</span> or <span className="nave-mono">nave.dao</span>, or paste the on-chain treasury address. If your wallet holds governance tokens, you can participate in proposals and voting.
          </p>
          {routeState.joinDaoName && routeState.joinInput && (
            <p
              className="mb-3 px-3 py-2 rounded-lg"
              style={{ fontSize: '12px', backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--foreground))' }}
            >
              Opening <strong>{routeState.joinDaoName}</strong> ({formatDaoSlugLabel(routeState.joinInput.replace(/\.dao$/i, ''))}) — connect your wallet and tap Join.
            </p>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={joinInput}
              onChange={e => { setJoinInput(e.target.value); setJoinError(''); }}
              placeholder="DAO name or treasury address…"
              className="flex-1 px-3 py-2.5 rounded-lg border outline-none transition-colors"
              style={{
                fontSize: '13px',
                fontFamily: joinInput.includes('.') && joinInput.length < 32 ? 'var(--font-body)' : 'var(--font-mono)',
                backgroundColor: 'hsl(var(--surface-0))',
                borderColor: joinError ? 'hsl(var(--destructive))' : 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
              onFocus={e => {
                if (!joinError) e.currentTarget.style.borderColor = 'hsl(var(--ring))';
              }}
              onBlur={e => {
                if (!joinError) e.currentTarget.style.borderColor = 'hsl(var(--border))';
              }}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
            />
            <button
              onClick={handleJoin}
              disabled={joining}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg font-medium transition-all flex-shrink-0"
              style={{
                fontSize: '13px',
                backgroundColor: joining ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
                color: joining ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
                cursor: joining ? 'not-allowed' : 'pointer',
              }}
            >
              <Fi icon="arrow-right" style={{ fontSize: '11px' }} />
              {joining ? 'Joining…' : 'Join'}
            </button>
          </div>
          {joinError && (
            <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', marginTop: '6px' }}>
              {joinError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── DAO card ───────────────────────────────────────────── */
function DaoCard({
  name,
  governanceType,
  chainLabel,
  shareUrl,
  shareLabel,
  isRemoving,
  isPendingConfirm,
  onOpen,
  onRemove,
  onMouseLeave,
}: {
  name: string;
  governanceType: string;
  chainLabel: string;
  shareUrl: string | null;
  shareLabel: string;
  isRemoving: boolean;
  isPendingConfirm: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onMouseLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyLink(e: React.MouseEvent) {
    e.stopPropagation();
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const govLabel = governanceType === 'token'
    ? 'Token Governance'
    : governanceType === 'wallet'
      ? 'Wallet Governance'
      : governanceType;

  return (
    <div
      className="rounded-xl border overflow-hidden transition-all"
      style={{
        backgroundColor: 'hsl(var(--surface-0))',
        borderColor: isPendingConfirm ? 'hsl(var(--destructive))' : 'hsl(var(--border))',
        opacity: isRemoving ? 0.5 : 1,
      }}
      onMouseLeave={onMouseLeave}
    >
      {/* Row 1 — icon + name + open chevron */}
      <button
        className="w-full flex items-center gap-3.5 px-4 py-3.5 text-left transition-colors"
        onClick={onOpen}
        disabled={isRemoving}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      >
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'hsl(var(--primary))' }}
        >
          <Fi icon="landmark" style={{ fontSize: '14px', color: 'white' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate" style={{ fontSize: '14px', color: 'hsl(var(--foreground))' }}>
            {name}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap" style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
            <span>{govLabel}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span
              className="px-1.5 py-0.5 rounded-full"
              style={{
                fontSize: '10px',
                backgroundColor: 'hsl(var(--surface-1))',
                border: '1px solid hsl(var(--border))',
                color: 'hsl(var(--muted-foreground))',
              }}
            >
              {chainLabel}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className="px-2 py-0.5 rounded-full"
            style={{ fontSize: '10.5px', backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
          >
            Member
          </span>
          <Fi icon="chevron-right" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }} />
        </div>
      </button>

      {/* Row 2 — shareable link + copy + remove */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-t"
        style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}
      >
        <Fi icon="link" style={{ fontSize: '10px', color: 'hsl(var(--muted-foreground))', flexShrink: 0 }} />
        <span
          className="nave-mono flex-1 min-w-0 truncate"
          style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}
        >
          {shareUrl
            ? shareUrl.replace(/^https?:\/\//, '')
            : shareLabel}
        </span>
        {shareUrl && (
          <button
            onClick={copyLink}
            title="Copy shareable link"
            className="flex items-center gap-1 px-2 py-0.5 rounded transition-colors flex-shrink-0"
            style={{ fontSize: '10.5px', color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          >
            <Fi icon={copied ? 'check' : 'copy'} style={{ fontSize: '10px' }} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          disabled={isRemoving}
          title={isPendingConfirm ? 'Click again to confirm removal' : 'Remove from Your Treasuries'}
          className="flex items-center gap-1 px-2 py-0.5 rounded transition-colors flex-shrink-0"
          style={{
            fontSize: '10.5px',
            fontWeight: isPendingConfirm ? 600 : 400,
            color: isPendingConfirm ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))';
            e.currentTarget.style.color = 'hsl(var(--destructive))';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.backgroundColor = '';
            e.currentTarget.style.color = isPendingConfirm ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))';
          }}
        >
          <Fi icon={isRemoving ? 'spinner' : 'xmark'} style={{ fontSize: '10px' }} />
          {isPendingConfirm ? 'Confirm remove' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

/* ── Shared header ──────────────────────────────────────── */
function Header() {
  const navigate = useNavigate();

  return (
    <header
      className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 border-b"
      style={{
        backgroundColor: 'hsl(var(--surface-0))',
        borderColor: 'hsl(var(--border))',
        backdropFilter: 'blur(10px)',
      }}
    >
      <button
        onClick={() => navigate('/')}
        className="text-display no-underline"
        style={{ fontSize: '19px', color: 'hsl(var(--foreground))' }}
      >
        Nave
      </button>

      {/* Unified wallet + network control (network selector lives inside the
          dropdown, same as the Bridge/Stake header). */}
      <WalletNetworkMenu chains={APP_WALLET_CHAINS} />
    </header>
  );
}