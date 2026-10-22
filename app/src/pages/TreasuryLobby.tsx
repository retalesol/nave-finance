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
import { Section, Notice } from '../components/calm';
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
  const accessSigner: DaoAccessMessageSigner | undefined = isEvm
    ? (m) => signEvmMessage(wagmiConfig, { message: m })
    : solanaSignMessage
      ? solanaAccessSigner(solanaSignMessage)
      : undefined;
  const { daos: watchedDaos, loading: watchLoading, watchDao, unwatchDao } = useWatchedDaos(walletAddr, accessSigner);

  const networkDaos = useMemo(
    () =>
      watchedDaos.filter((d) => {
        if (typeof d.chainId === 'number' && isEvmChainId(d.chainId)) {
          return evmTarget(d.chainId).family === target.family;
        }
        if (!isEvmAddress(d.daoOnchainAddress)) {
          return target.kind === 'solana';
        }
        return false;
      }),
    [watchedDaos, target.family, target.kind],
  );

  const networkLabel = chainFamilyLabel(target.family);

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
      navigate('/overview', { state: { treasuryAddress: addr } });
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
            <div className="nave-label" style={{ marginBottom: '10px' }}>Treasuries</div>
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '34px',
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                color: 'hsl(var(--foreground))',
                margin: '0 0 10px',
              }}
            >
              Your <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>treasuries.</em>
            </h1>
            <p style={{ fontSize: '14.5px', lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', marginBottom: '24px' }}>
              Connect your wallet to view treasuries you belong to, or join one by DAO name (e.g. nave) or contract address.
            </p>
            <div className="flex flex-col gap-2.5">
              <button
                onClick={openConnect}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-[9px] font-semibold transition-all"
                style={{
                  fontSize: '13.5px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                }}
              >
                {isEvm ? `Connect ${chainFamilyLabel(target.family)} Wallet` : 'Connect Wallet'}
              </button>

              {DEMO_TREASURY_NAV_ENABLED && (
                <button
                  onClick={() => navigate('/overview', { state: { treasuryAddress: MOCK_DAO_ADDRESS } })}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-[9px] border font-semibold transition-all"
                  style={{
                    fontSize: '13.5px',
                    color: 'hsl(var(--foreground))',
                    borderColor: 'hsl(var(--border))',
                    backgroundColor: '#ffffff',
                  }}
                >
                  <Fi icon="eye" style={{ fontSize: '13px' }} />
                  Nave Test DAO (demo)
                </button>
              )}
            </div>
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

      <div className="flex-1 max-w-[680px] mx-auto w-full px-4 sm:px-6 pt-10 pb-20">
        {target.family === 'robinhood' && <RobinhoodTreasuryNotice />}

        {/* Heading */}
        <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
          <div>
            <div className="nave-label" style={{ marginBottom: '10px' }}>Treasuries</div>
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '34px',
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                color: 'hsl(var(--foreground))',
                margin: '0 0 8px',
              }}
            >
              Your <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>treasuries.</em>
            </h1>
            <p style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
              Connected as <span className="nave-mono">{shortAddr}</span>
              {' · '}
              {networkLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/create-dao')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold mt-1"
            style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
          >
            + New treasury
          </button>
        </div>

        {DEMO_TREASURY_NAV_ENABLED && (
          <Notice
            tone="brass"
            actionLabel="Open demo →"
            onAction={() => navigate('/overview', { state: { treasuryAddress: MOCK_DAO_ADDRESS } })}
            className="mb-6"
          >
            <span>
              <strong>Nave Test DAO</strong> — explore the full dashboard without a live on-chain DAO.
            </span>
          </Notice>
        )}

        {/* Treasury list or empty state */}
        {watchLoading ? (
          <div className="space-y-3 mb-8">
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
          </div>
        ) : networkDaos.length > 0 ? (
          <div className="mb-8" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            {networkDaos.map(t => {
              const isRemoving = removingDao === t.daoOnchainAddress;
              const isPendingConfirm = confirmRemove === t.daoOnchainAddress;
              const shareUrl = t.slug ? getDaoPublicUrl(t.slug) : null;
              const shareLabel = t.slug ? formatDaoSlugLabel(t.slug) : `${t.daoOnchainAddress.slice(0, 6)}…${t.daoOnchainAddress.slice(-4)}`;
              function openWatchedDao() {
                if (typeof t.chainId === 'number' && isEvmChainId(t.chainId)) {
                  rememberDaoChain(t.daoOnchainAddress, t.chainId);
                }
                navigate('/overview', { state: { treasuryAddress: t.daoOnchainAddress } });
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
          </div>
        )}

        {/* Join by address */}
        <Section title="Join a treasury">
          <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: '0 0 14px' }}>
            Enter a DAO name like <span className="nave-mono">nave</span> or <span className="nave-mono">nave.dao</span>, or paste the on-chain treasury address. If your wallet holds governance tokens, you can participate in proposals and voting.
          </p>
          {routeState.joinDaoName && routeState.joinInput && (
            <p
              className="mb-3 px-3 py-2 rounded-[10px] border"
              style={{ fontSize: '12.5px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
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
              className="flex-1 px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
              style={{
                fontSize: '14px',
                fontFamily: joinInput.includes('.') && joinInput.length < 32 ? 'var(--font-body)' : 'var(--font-mono)',
                backgroundColor: '#ffffff',
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
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-[9px] font-semibold transition-all flex-shrink-0"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--foreground))',
                color: '#ffffff',
                opacity: joining ? 0.5 : 1,
                cursor: joining ? 'not-allowed' : 'pointer',
              }}
            >
              {joining ? 'Joining…' : 'Join →'}
            </button>
          </div>
          {joinError && (
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))', marginTop: '6px' }}>
              {joinError}
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}

/* ── DAO row ────────────────────────────────────────────── */
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
      className="flex items-start gap-3 py-4 transition-opacity"
      style={{
        borderBottom: '1px solid hsl(var(--surface-2))',
        opacity: isRemoving ? 0.5 : 1,
      }}
      onMouseLeave={onMouseLeave}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={isRemoving}
        className="flex-1 min-w-0 text-left group"
      >
        <div
          className="group-hover:text-brass transition-colors truncate"
          style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))', lineHeight: 1.4 }}
        >
          {name}
        </div>
        <div
          className="flex items-center gap-2 flex-wrap mt-0.5"
          style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
        >
          <span>{chainLabel}</span>
          <span>·</span>
          <span>{govLabel}</span>
          <span>·</span>
          <span className="nave-mono" style={{ fontSize: '12px' }}>
            {shareUrl ? shareUrl.replace(/^https?:\/\//, '') : shareLabel}
          </span>
        </div>
      </button>

      <div className="flex items-center gap-3 ml-auto flex-shrink-0 pt-0.5">
        {shareUrl && (
          <button
            type="button"
            onClick={copyLink}
            title="Copy shareable link"
            className="hover:underline underline-offset-4"
            style={{ fontSize: '12.5px', color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onRemove(); }}
          disabled={isRemoving}
          title={isPendingConfirm ? 'Click again to confirm removal' : 'Remove from Your Treasuries'}
          className="hover:underline underline-offset-4"
          style={{
            fontSize: '12.5px',
            fontWeight: isPendingConfirm ? 600 : 400,
            color: isPendingConfirm ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))',
          }}
        >
          {isPendingConfirm ? 'Confirm remove' : 'Remove…'}
        </button>
        <button
          type="button"
          onClick={onOpen}
          disabled={isRemoving}
          style={{ color: 'hsl(var(--faint))', fontSize: '11px' }}
          aria-label={`Open ${name}`}
        >
          <Fi icon="chevron-right" style={{ fontSize: '11px' }} />
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
      className="sticky top-0 z-50 flex items-center justify-between px-6 py-3.5 border-b"
      style={{
        backgroundColor: 'rgba(250, 248, 243, 0.9)',
        borderColor: 'hsl(var(--surface-2))',
        backdropFilter: 'blur(12px)',
      }}
    >
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-2 no-underline"
        style={{ color: 'hsl(var(--foreground))' }}
      >
        <span
          className="grid place-items-center rounded-[6px]"
          style={{
            width: '20px',
            height: '20px',
            backgroundColor: 'hsl(var(--foreground))',
            color: '#ffffff',
            fontFamily: 'var(--font-display)',
            fontSize: '13px',
          }}
        >
          N
        </span>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: '19px' }}>Nave</span>
      </button>

      <WalletNetworkMenu chains={APP_WALLET_CHAINS} />
    </header>
  );
}