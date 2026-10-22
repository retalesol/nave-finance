import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useSignMessage } from 'wagmi';
import Fi from '../components/Fi';
import { CardSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import MetricCard from '../components/MetricCard';
import { Notice, Section, UnderlineTabs } from '../components/calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { useTreasuryAssets, type TreasuryAssetRow } from '../hooks/useTreasuryAssets';
import { useTreasuryNfts, type TreasuryNft } from '../hooks/useTreasuryNfts';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { DepositFlowModal } from '../components/DepositFlow';
import NaveModal from '../components/NaveModal';
import { toast } from '../hooks/use-toast';
import { describeTransactionError } from '../lib/errorMessages';
import { buildRegisterAssetEvm } from '../lib/evm/writers';
import {
  buildInitStrategyPosition,
  buildInitStrategyEscrow,
  buildConfigurePositionTargets,
  buildConfigureMarginfiPosition,
  buildRegisterAsset,
  buildRegisterNftAsset,
  buildSetFeeAsset,
} from '../lib/transactionBuilders';
import { evmAllowedAssets, resolveAsset, riskLabel, type AllowedAsset, type EvmAllowedAsset } from '../lib/allowedAssets';
import { fetchYieldData, solanaAccessSigner } from '../lib/edgeFunctionClient';
import { getSolanaRegisterAssetPlan } from '../lib/solanaTreasuryRegistrationDefaults';
import { getSolanaStrategyStatuses } from '../lib/strategyReadiness';

const MARGINFI_STRATEGY_ENABLED = getSolanaStrategyStatuses().find((s) => s.id === 'marginfi')?.supported ?? false;
const JUPITER_STRATEGY_BADGE = getSolanaStrategyStatuses().find((s) => s.id === 'jupiter')?.badge ?? null;

const USD = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FIELD_STYLE: React.CSSProperties = {
  width: '100%',
  fontSize: '14px',
  padding: '11px 13px',
  borderRadius: '10px',
  backgroundColor: '#ffffff',
  border: '1px solid hsl(var(--border))',
  color: 'hsl(var(--foreground))',
  outline: 'none',
};

function ModalShell({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <NaveModal open title={title} subtitle={subtitle} onClose={onClose} maxWidth={480}>
      <div style={{ padding: '18px 22px 22px' }} className="space-y-4">
        {children}
      </div>
    </NaveModal>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label
        style={{
          fontSize: '12.5px',
          fontWeight: 600,
          color: 'hsl(var(--foreground))',
          marginBottom: '7px',
          display: 'block',
        }}
      >
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          ...FIELD_STYLE,
          fontSize: mono ? '12.5px' : '14px',
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-body)',
        }}
      />
    </div>
  );
}

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', margin: 0 }}>{msg}</p>;
}

function PrimaryBtn({
  onClick,
  busy,
  disabled,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const isDisabled = busy || !!disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className="px-4 py-2 rounded-[9px] font-semibold transition-all"
      style={{
        fontSize: '13px',
        backgroundColor: 'hsl(var(--foreground))',
        color: '#ffffff',
        opacity: isDisabled ? 0.45 : 1,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const ZERO_PYTH_FEED = '0'.repeat(64);

function evmAssetKind(asset: EvmAllowedAsset): number {
  if (asset.assetClass === 'stablecoin') return 0;
  if (asset.assetClass === 'sol-like' || asset.symbol.toUpperCase().includes('ETH')) return 1;
  return 2;
}

function normalizePythFeed(feed: string): `0x${string}` | null {
  const hex = feed.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `0x${hex}` as `0x${string}`;
}

/* ── Pool discovery helper ───────────────────────────────────── */
interface DiscoveredPool {
  poolId: string;
  symbol: string;
  extMarket: string;
  extReserve: string;
  collateralMint?: string;
  apyBps: number;
  riskScore: number;
  adjustedScore: number;
  tvlUsd: number;
  source: string;
}

async function discoverPoolsForAsset(
  protocol: string,
  mint: string,
): Promise<DiscoveredPool[]> {
  const { data } = await fetchYieldData();
  if (!data) return [];
  return (data.opportunities ?? []).filter(
    (o) => o.protocolId === protocol && o.mint === mint && o.extMarket && o.extReserve,
  );
}

/* ── Configure position targets (adaptive) ──────────────────── */
function ConfigureTargetsModal({
  daoAddress,
  founder,
  asset,
  onClose,
  onDone,
}: {
  daoAddress: string;
  founder: PublicKey | null;
  asset: TreasuryAssetRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const tx = useSendTransaction();
  const { chainKind } = useChain();
  const [protocol, setProtocol] = useState('kamino');
  const [collateralMint, setCollateralMint] = useState('');
  const [extMarket, setExtMarket] = useState('');
  const [extReserve, setExtReserve] = useState('');
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredPools, setDiscoveredPools] = useState<DiscoveredPool[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const allowedAsset: AllowedAsset | undefined = resolveAsset(asset.mint);

  useEffect(() => {
    void handleDiscover();
    // Auto-discover best pool when the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.mint, protocol]);

  async function handleDiscover() {
    setErr(null);
    setDiscovering(true);
    setDiscoveredPools([]);
    try {
      const pools = await discoverPoolsForAsset(protocol, asset.mint);
      if (pools.length === 0) {
        setErr(`No live pools found for ${asset.symbol} on ${protocol}. Enter addresses manually.`);
      } else {
        setDiscoveredPools(pools);
        const best = pools[0];
        setSelectedPoolId(best.poolId);
        setExtMarket(best.extMarket);
        setExtReserve(best.extReserve);
        if (best.collateralMint) setCollateralMint(best.collateralMint);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  }

  function selectPool(pool: DiscoveredPool) {
    setSelectedPoolId(pool.poolId);
    setExtMarket(pool.extMarket);
    setExtReserve(pool.extReserve);
    if (pool.collateralMint) setCollateralMint(pool.collateralMint);
  }

  async function submit() {
    setErr(null);
    if (chainKind === 'evm') {
      toast({
        variant: 'destructive',
        title: 'Solana-only step',
        description:
          'EVM adapters self-target their pool — approve adapters and set caps via the Policy constitution instead.',
      });
      return;
    }
    if (!founder) {
      setErr('Connect your wallet to configure strategy targets on-chain.');
      return;
    }
    let market: PublicKey, reserve: PublicKey;
    try {
      market = new PublicKey(extMarket.trim());
      reserve = new PublicKey(extReserve.trim());
    } catch {
      setErr('Market and reserve must be valid Solana addresses');
      return;
    }
    setBusy(true);
    try {
      const dao = new PublicKey(daoAddress);
      const mintKey = new PublicKey(asset.mint);
      const initPos = await buildInitStrategyPosition(dao, founder, protocol, mintKey);
      const initEsc = await buildInitStrategyEscrow(dao, founder, protocol, mintKey);
      if (protocol === 'marginfi') {
        const configure = await buildConfigureMarginfiPosition(dao, founder, mintKey, market, reserve);
        const out = await tx.sendGrouped([[initPos, initEsc, configure]], {
          successLabel: 'MarginFi position configured',
        });
        if (out.status === 'success' || out.status === 'mock') {
          onDone();
          onClose();
        } else setErr(out.error || 'Configuration failed');
        return;
      }
      let collateral: PublicKey;
      try {
        collateral = new PublicKey((collateralMint || extMarket).trim());
      } catch {
        setErr('Collateral mint must be a valid Solana address');
        return;
      }
      const configure = await buildConfigurePositionTargets(
        dao,
        founder,
        protocol,
        mintKey,
        collateral,
        market,
        reserve,
      );
      const out = await tx.sendGrouped([[initPos, initEsc, configure]], {
        successLabel: 'Strategy targets configured',
      });
      if (out.status === 'success' || out.status === 'mock') {
        onDone();
        onClose();
      } else setErr(out.error || 'Configuration failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Configuration failed');
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!extMarket && !!extReserve;
  const fieldLabels: Record<string, { collateral: string; market: string; reserve: string }> = {
    kamino:   { collateral: 'Reserve collateral mint', market: 'Lending market', reserve: 'Reserve' },
    jito:     { collateral: 'Pool mint (poolSOL)',     market: 'Stake pool',     reserve: 'Reserve stake' },
    marginfi: { collateral: 'Collateral mint',         market: 'MarginFi group', reserve: 'Bank address' },
    jupiter:  { collateral: 'jlToken (fToken) mint',   market: 'Lending PDA',    reserve: 'Liquidity vault' },
  };
  const labels = fieldLabels[protocol] ?? fieldLabels.kamino;

  return (
    <ModalShell
      title={`Configure ${asset.symbol} strategy targets`}
      subtitle={`We pick the best yield pool for ${asset.symbol}. Confirm to continue.`}
      onClose={onClose}
    >
      {/* Protocol selector */}
      <div>
        <label
          style={{
            fontSize: '12.5px',
            fontWeight: 600,
            color: 'hsl(var(--foreground))',
            marginBottom: '7px',
            display: 'block',
          }}
        >
          Protocol
        </label>
        <select
          value={protocol}
          onChange={(e) => {
            setProtocol(e.target.value);
            setDiscoveredPools([]);
            setSelectedPoolId(null);
          }}
          style={FIELD_STYLE}
        >
          <option value="kamino">Kamino (klend)</option>
          <option value="jito">Jito (SPL stake pool)</option>
          {MARGINFI_STRATEGY_ENABLED && <option value="marginfi">MarginFi (lending)</option>}
          <option value="jupiter">
            Jupiter (Lend Earn){JUPITER_STRATEGY_BADGE === 'beta' ? ' — Beta' : ''}
          </option>
        </select>
        {discovering && (
          <p
            style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '6px' }}
            className="flex items-center gap-1.5"
          >
            <Fi icon="arrows-rotate" className="animate-spin" style={{ fontSize: 10 }} />
            Scanning live pools…
          </p>
        )}
      </div>

      {/* Discovered pools list */}
      {discoveredPools.length > 0 && (
        <div>
          <label
            style={{
              fontSize: '12.5px',
              fontWeight: 600,
              color: 'hsl(var(--foreground))',
              marginBottom: '7px',
              display: 'block',
            }}
          >
            Live pools found — ranked by risk-adjusted yield
          </label>
          <div
            className="max-h-44 overflow-y-auto"
            style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
          >
            {discoveredPools.map((pool) => {
              const rl = riskLabel(pool.riskScore);
              const selected = pool.poolId === selectedPoolId;
              return (
                <button
                  type="button"
                  key={pool.poolId}
                  onClick={() => selectPool(pool)}
                  className="w-full flex items-center justify-between text-left transition-colors"
                  style={{
                    padding: '10px 4px',
                    borderBottom: '1px solid hsl(var(--surface-2))',
                    fontSize: '12.5px',
                  }}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      style={{
                        width: '15px',
                        height: '15px',
                        borderRadius: '50%',
                        border: `1.5px solid ${selected ? 'hsl(var(--foreground))' : '#CFC8B8'}`,
                        display: 'grid',
                        placeItems: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {selected && (
                        <span
                          style={{
                            width: '7px',
                            height: '7px',
                            borderRadius: '50%',
                            backgroundColor: 'hsl(var(--foreground))',
                          }}
                        />
                      )}
                    </span>
                    <span className="nave-mono truncate" style={{ color: 'hsl(var(--foreground))' }}>
                      {pool.source}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                    <span className="nave-mono" style={{ fontSize: '11.5px', color: 'hsl(var(--success))', fontWeight: 600 }}>
                      {(pool.apyBps / 100).toFixed(2)}% APY
                    </span>
                    <span style={{ fontSize: '11px', color: rl.color, fontFamily: 'var(--font-mono)' }}>
                      {rl.label} risk
                    </span>
                    {pool.tvlUsd > 0 && (
                      <span style={{ fontSize: '11px', color: 'hsl(var(--faint))', fontFamily: 'var(--font-mono)' }}>
                        ${(pool.tvlUsd / 1e6).toFixed(0)}M TVL
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Manual fields — Advanced */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left"
        style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={showAdvanced ? 'chevron-up' : 'chevron-down'} style={{ fontSize: 10 }} />
        Advanced — manual pool addresses
      </button>
      {showAdvanced && (
        <div
          className="space-y-3 pt-3"
          style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
        >
          <button
            type="button"
            onClick={handleDiscover}
            disabled={discovering || busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border font-semibold"
            style={{
              fontSize: '12px',
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          >
            <Fi
              icon={discovering ? 'arrows-rotate' : 'magnifying-glass'}
              style={{ fontSize: 11 }}
              className={discovering ? 'animate-spin' : ''}
            />
            {discovering ? 'Scanning…' : 'Re-scan pools'}
          </button>
          {protocol !== 'marginfi' && (
            <Field
              label={labels.collateral}
              value={collateralMint}
              onChange={setCollateralMint}
              placeholder="cToken / pool / jlToken mint…"
              mono
            />
          )}
          <Field
            label={labels.market}
            value={extMarket}
            onChange={setExtMarket}
            placeholder="ext market / lending PDA…"
            mono
          />
          <Field
            label={labels.reserve}
            value={extReserve}
            onChange={setExtReserve}
            placeholder="ext reserve / vault…"
            mono
          />
        </div>
      )}

      {allowedAsset && (
        <div
          style={{
            backgroundColor: 'hsl(var(--background))',
            border: '1px solid hsl(var(--surface-2))',
            borderRadius: '12px',
            padding: '11px 13px',
            fontSize: '12px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.55,
          }}
        >
          <strong style={{ color: 'hsl(var(--foreground))' }}>{allowedAsset.symbol}</strong> is in the curated allowlist — asset class: {allowedAsset.assetClass}, max risk: {allowedAsset.maxRisk}/100.
        </div>
      )}

      <Err msg={err} />
      <div
        className="flex items-center justify-end gap-2"
        style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid hsl(var(--surface-2))',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="px-3.5 py-2 rounded-[9px] font-semibold"
          style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
        >
          Cancel
        </button>
        <PrimaryBtn onClick={submit} busy={busy} disabled={!canSubmit}>
          {busy ? 'Configuring…' : 'Configure targets'}
        </PrimaryBtn>
      </div>
    </ModalShell>
  );
}

/* ── Register EVM asset ───────────────────────────────────── */
function RegisterEvmAssetModal({
  daoAddress,
  onClose,
  onDone,
}: {
  daoAddress: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const tx = useSendTransaction();
  const { evmChainId } = useChain();
  const assets = evmChainId ? evmAllowedAssets(evmChainId) : [];
  const [selected, setSelected] = useState(assets[0]?.address ?? '');
  const asset = assets.find((a) => a.address === selected) ?? assets[0] ?? null;
  const defaultFeed = asset?.assetClass === 'stablecoin' ? ZERO_PYTH_FEED : asset?.pythFeedId ?? '';
  const [pythFeed, setPythFeed] = useState(defaultFeed);
  const pythPresetLocked = !!(asset?.assetClass === 'stablecoin' || asset?.pythFeedId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function selectAsset(address: string) {
    const next = assets.find((a) => a.address === address) ?? null;
    setSelected(address);
    setPythFeed(next?.assetClass === 'stablecoin' ? ZERO_PYTH_FEED : next?.pythFeedId ?? '');
    setErr(null);
  }

  async function submit() {
    setErr(null);
    if (!evmChainId) {
      setErr('Select an Ethereum or Base network.');
      return;
    }
    if (!asset) {
      setErr('Select an asset to register.');
      return;
    }
    const feedHex = pythPresetLocked ? defaultFeed : pythFeed;
    const feed = normalizePythFeed(feedHex);
    if (!feed) {
      setErr('Pyth feed id must be 32 bytes / 64 hex chars. Stablecoins use all zeros.');
      return;
    }
    setBusy(true);
    try {
      const out = await tx.sendEvm(
        buildRegisterAssetEvm(
          evmChainId,
          daoAddress,
          asset.address,
          feed,
          asset.assetClass === 'stablecoin',
          evmAssetKind(asset),
        ),
        { successLabel: `${asset.symbol} registered` },
      );
      if (out.status === 'success' || out.status === 'mock') {
        onDone();
        onClose();
      } else setErr(out.error || 'Registration failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="Add a token"
      subtitle="Choose a supported token. Setup happens automatically so you can deposit next."
      onClose={onClose}
    >
      <div>
        <label
          style={{
            fontSize: '12.5px',
            fontWeight: 600,
            color: 'hsl(var(--foreground))',
            marginBottom: '7px',
            display: 'block',
          }}
        >
          Asset
        </label>
        <select
          value={asset?.address ?? ''}
          onChange={(e) => selectAsset(e.target.value)}
          style={FIELD_STYLE}
        >
          {assets.map((a) => (
            <option key={a.address} value={a.address}>
              {a.symbol} — {a.name}
            </option>
          ))}
        </select>
      </div>
      {!pythPresetLocked && (
        <details style={{ borderTop: '1px solid hsl(var(--surface-2))', paddingTop: '12px' }}>
          <summary
            style={{
              fontSize: '12.5px',
              fontWeight: 600,
              color: 'hsl(var(--muted-foreground))',
              cursor: 'pointer',
            }}
          >
            Advanced
          </summary>
          <div className="pt-3">
            <Field
              label="Price feed id"
              value={pythFeed}
              onChange={setPythFeed}
              placeholder={ZERO_PYTH_FEED}
              mono
            />
          </div>
        </details>
      )}
      <Err msg={err} />
      <div
        className="flex items-center justify-end gap-2"
        style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid hsl(var(--surface-2))',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="px-3.5 py-2 rounded-[9px] font-semibold"
          style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
        >
          Cancel
        </button>
        <PrimaryBtn onClick={submit} busy={busy} disabled={!asset}>
          {busy ? 'Adding…' : 'Add token'}
        </PrimaryBtn>
      </div>
    </ModalShell>
  );
}

/* ── Register SPL treasury asset (lazy / guided) ─────────── */
function RegisterSolanaHeldAssetModal({
  daoAddress,
  founder,
  asset,
  onClose,
  onDone,
}: {
  daoAddress: string;
  founder: PublicKey;
  asset: TreasuryAssetRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const tx = useSendTransaction();
  const [advancedFeed, setAdvancedFeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const plan = getSolanaRegisterAssetPlan(asset.mint, asset.symbol, asset.name);

  async function submit() {
    setErr(null);
    let pythHex: string;
    let isStable: boolean;
    let assetKind: number;
    if (plan.mode === 'ready') {
      pythHex = plan.pythFeedHex;
      isStable = plan.isStablecoin;
      assetKind = plan.assetKind;
    } else {
      const h = advancedFeed.trim().replace(/^0x/i, '');
      if (!/^[0-9a-fA-F]{64}$/.test(h)) {
        setErr(
          'Pyth price feed id must be 32 bytes (64 hex characters). Use the feed id from Pyth for this token.',
        );
        return;
      }
      pythHex = h;
      isStable = false;
      assetKind = plan.assetKind;
    }
    setBusy(true);
    try {
      const dao = new PublicKey(daoAddress);
      const mint = new PublicKey(asset.mint);
      const r = await buildRegisterAsset(dao, founder, mint, pythHex, isStable, assetKind);
      const out = await tx.send(r, { successLabel: `${asset.symbol} enabled for treasury` });
      if (out.status === 'success' || out.status === 'mock') {
        onDone();
        onClose();
      } else
        setErr(
          describeTransactionError(out.error, {
            programHint: 'core',
            fallback: 'Registration failed',
          }),
        );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title={`Enable ${asset.symbol}`}
      subtitle={`Enables ${asset.symbol} for deposits and transfers from this treasury.`}
      onClose={onClose}
    >
      {plan.mode === 'needs_pyth_feed' && (
        <details open style={{ borderTop: '1px solid hsl(var(--surface-2))', paddingTop: '12px' }}>
          <summary
            style={{
              fontSize: '12.5px',
              fontWeight: 600,
              color: 'hsl(var(--muted-foreground))',
              cursor: 'pointer',
            }}
          >
            Advanced — price feed
          </summary>
          <div className="pt-3">
            <Field
              label="Price feed id"
              value={advancedFeed}
              onChange={setAdvancedFeed}
              placeholder="64 hex characters"
              mono
            />
          </div>
        </details>
      )}
      {plan.mode === 'ready' && (
        <div
          style={{
            backgroundColor: 'hsl(var(--background))',
            border: '1px solid hsl(var(--surface-2))',
            borderRadius: '12px',
            padding: '12px 14px',
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.55,
          }}
        >
          <strong style={{ color: 'hsl(var(--foreground))' }}>{asset.symbol}</strong> is ready to enable.
        </div>
      )}
      <Err msg={err} />
      <div
        className="flex items-center justify-end gap-2"
        style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid hsl(var(--surface-2))',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="px-3.5 py-2 rounded-[9px] font-semibold"
          style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
        >
          Cancel
        </button>
        <PrimaryBtn onClick={submit} busy={busy}>
          {busy ? 'Confirming…' : 'Enable asset'}
        </PrimaryBtn>
      </div>
    </ModalShell>
  );
}

function treasuryAssetDexScreenerUrl(
  asset: TreasuryAssetRow,
  chainKind: 'solana' | 'evm',
  evmChainId: number | null | undefined,
): string | null {
  if (chainKind === 'solana' && asset.mint !== 'SOL' && asset.mint.length > 20) {
    return `https://dexscreener.com/solana/${asset.mint}`;
  }
  if (chainKind === 'evm' && /^0x[0-9a-fA-F]{40}$/i.test(asset.mint)) {
    if (evmChainId === 4663 || evmChainId === 46630 || evmChainId === 5042 || evmChainId === 5042002) {
      return null;
    }
    const seg = evmChainId === 8453 || evmChainId === 84532 ? 'base' : 'ethereum';
    return `https://dexscreener.com/${seg}/${asset.mint}`;
  }
  return null;
}

/* ── Asset row (calm hairline style replacing heavy card) ─── */
function AssetCard({
  asset,
  canManage,
  onAction,
  hidden = false,
}: {
  asset: TreasuryAssetRow;
  canManage: boolean;
  onAction: (a: string, asset: TreasuryAssetRow) => void;
  hidden?: boolean;
}) {
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copiedMint, setCopiedMint] = useState(false);
  const depositBlocked = chainKind === 'evm' && asset.mint === 'ETH';
  const dexHref = treasuryAssetDexScreenerUrl(asset, chainKind, evmChainId);
  const inUseUi = asset.deployedCapital / Math.pow(10, asset.decimals);

  function copyMint() {
    navigator.clipboard.writeText(asset.mint);
    setCopiedMint(true);
    setTimeout(() => setCopiedMint(false), 1400);
  }

  return (
    <div
      style={{
        padding: '15px 0',
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: '14.5px',
                fontWeight: 600,
                color: 'hsl(var(--foreground))',
              }}
            >
              {asset.symbol}
            </span>
            <span style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))' }}>
              · {asset.name}
            </span>
            <span
              className="nave-mono"
              style={{
                fontSize: '10px',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'hsl(var(--faint))',
              }}
            >
              {asset.assetKindLabel}
            </span>
            {asset.onChainRegistered && !asset.enabled && (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'hsl(var(--destructive))',
                }}
              >
                Disabled
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: '12.5px',
              color: 'hsl(var(--muted-foreground))',
              marginTop: '3px',
              lineHeight: 1.5,
            }}
          >
            Available:{' '}
            <span className="nave-mono" style={{ color: 'hsl(var(--foreground))' }}>
              {asset.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </span>
            {' · '}
            In use:{' '}
            <span className="nave-mono" style={{ color: 'hsl(var(--foreground))' }}>
              {inUseUi.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </span>
          </div>
        </div>

        <div className="text-right flex-shrink-0">
          <div
            className="nave-mono"
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: 'hsl(var(--foreground))',
            }}
          >
            {USD(asset.valueUsd)}
          </div>
          <div
            className="nave-mono"
            style={{
              fontSize: '12px',
              color: 'hsl(var(--muted-foreground))',
              marginTop: '2px',
            }}
          >
            {asset.allocationPct.toFixed(1)}% of NAV
          </div>
        </div>
      </div>

      {/* Quiet hairline actions + details toggle */}
      <div className="flex items-center gap-3 flex-wrap mt-2.5">
        {canManage && (
          <>
            <button
              type="button"
              onClick={() => onAction('deposit', asset)}
              disabled={depositBlocked}
              title={depositBlocked ? 'Use WETH to add ETH to the treasury.' : undefined}
              className="hover:underline underline-offset-4 bg-transparent border-0"
              style={{
                fontSize: '12.5px',
                fontWeight: 600,
                color: depositBlocked ? 'hsl(var(--faint))' : 'hsl(var(--foreground))',
                cursor: depositBlocked ? 'not-allowed' : 'pointer',
              }}
            >
              Add funds
            </button>
            <span style={{ color: 'hsl(var(--border))' }}>·</span>
            <button
              type="button"
              onClick={() => onAction('configure', asset)}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{
                fontSize: '12.5px',
                color: 'hsl(var(--muted-foreground))',
              }}
            >
              Yield setup
            </button>
            {chainKind !== 'evm' && asset.onChainRegistered && asset.isStablecoin && (
              <>
                <span style={{ color: 'hsl(var(--border))' }}>·</span>
                <button
                  type="button"
                  onClick={() => onAction('feeAsset', asset)}
                  disabled={tx.status === 'signing'}
                  className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
                  style={{
                    fontSize: '12.5px',
                    color: 'hsl(var(--muted-foreground))',
                  }}
                >
                  Set as fee asset
                </button>
              </>
            )}
            {chainKind === 'solana' && !asset.onChainRegistered && asset.mint !== 'SOL' && (
              <>
                <span style={{ color: 'hsl(var(--border))' }}>·</span>
                <button
                  type="button"
                  onClick={() => onAction('registerSolana', asset)}
                  className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
                  style={{
                    fontSize: '12.5px',
                    color: 'hsl(var(--brass))',
                    fontWeight: 500,
                  }}
                >
                  Enable
                </button>
              </>
            )}
            <span style={{ color: 'hsl(var(--border))' }}>·</span>
            <button
              type="button"
              onClick={() => onAction(hidden ? 'unhide' : 'hide', asset)}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{
                fontSize: '12.5px',
                color: 'hsl(var(--muted-foreground))',
              }}
              title={
                hidden
                  ? 'Show this asset in the default view'
                  : 'Hide this asset (e.g. airdrop spam) from the default view'
              }
            >
              {hidden ? 'Unhide' : 'Hide'}
            </button>
            <span style={{ color: 'hsl(var(--border))' }}>·</span>
          </>
        )}
        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
          style={{
            fontSize: '12.5px',
            color: 'hsl(var(--faint))',
          }}
        >
          {detailsOpen ? 'Hide details' : 'Details'}
        </button>
      </div>

      {detailsOpen && (
        <div
          className="mt-3 flex items-center justify-between gap-3 flex-wrap rounded-[10px] border px-3 py-2"
          style={{
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--surface-2))',
          }}
        >
          <code
            style={{
              fontSize: '11.5px',
              color: 'hsl(var(--foreground))',
              fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all',
            }}
          >
            {asset.mint}
          </code>
          <div className="flex items-center gap-3 ml-auto flex-shrink-0">
            <button
              type="button"
              onClick={copyMint}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{
                fontSize: '12px',
                color: copiedMint ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))',
              }}
              title="Copy"
            >
              {copiedMint ? 'Copied ✓' : 'Copy'}
            </button>
            {dexHref && (
              <a
                href={dexHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:underline underline-offset-4"
                style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
              >
                Market <Fi icon="arrow-up-right-from-square" style={{ fontSize: 10 }} />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── NFT row (calm hairline item replacing heavy card) ───── */
function NftCard({
  nft,
  canManage,
  onAction,
}: {
  nft: TreasuryNft;
  canManage: boolean;
  onAction: (action: string, nft: TreasuryNft) => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 flex-wrap"
      style={{
        padding: '14px 0',
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      <div className="flex items-center gap-3.5 min-w-0 flex-1">
        <div
          className="w-11 h-11 rounded-[10px] overflow-hidden flex items-center justify-center flex-shrink-0 border"
          style={{
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--muted-foreground))',
          }}
        >
          {nft.image ? (
            <img src={nft.image} alt={nft.name} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <Fi icon="image" style={{ fontSize: 16 }} />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="truncate"
              style={{
                fontSize: '14px',
                fontWeight: 500,
                color: 'hsl(var(--foreground))',
              }}
            >
              {nft.name}
            </span>
            {nft.compressed && (
              <span
                className="nave-mono"
                style={{
                  fontSize: '10px',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'hsl(var(--faint))',
                }}
              >
                Compressed
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span
              className="nave-mono truncate"
              style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}
            >
              {nft.mint.slice(0, 6)}…{nft.mint.slice(-4)}
            </span>
            {nft.collection && (
              <span style={{ fontSize: '11.5px', color: 'hsl(var(--faint))' }}>
                · Collection {nft.collection.slice(0, 4)}…{nft.collection.slice(-4)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {canManage && !nft.compressed && (
          <button
            type="button"
            onClick={() => onAction('sendNft', nft)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] border font-semibold transition-colors"
            style={{
              fontSize: '12.5px',
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          >
            Send via governance →
          </button>
        )}
        {nft.compressed && (
          <span style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}>
            cNFT transfers coming soon
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Assets (Money) page ────────────────────────────────────── */
export default function Assets() {
  const navigate = useNavigate();
  const { daoAddress, isMockMode } = useDaoContext();
  const { publicKey, signMessage } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { chainKind } = useChain();
  const tx = useSendTransaction();
  const {
    assets,
    visibleAssets,
    hiddenAssets,
    onchainNavUsd,
    deployedUsd,
    loading,
    error,
    refetch,
    hideAsset,
    unhideAsset,
  } = useTreasuryAssets(daoAddress);
  const {
    nfts,
    loading: nftsLoading,
    error: nftsError,
    unsupported: nftsUnsupported,
    refetch: refetchNfts,
  } = useTreasuryNfts(daoAddress);
  const [depositAsset, setDepositAsset] = useState<TreasuryAssetRow | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [configureAsset, setConfigureAsset] = useState<TreasuryAssetRow | null>(null);
  const [registerEvmAsset, setRegisterEvmAsset] = useState(false);
  const [registerSolanaAsset, setRegisterSolanaAsset] = useState<TreasuryAssetRow | null>(null);
  const [tab, setTab] = useState<'tokens' | 'hidden' | 'nfts'>('tokens');

  const canManage = !!daoAddress && (isMockMode || (chainKind === 'evm' ? !!evmAddress : !!publicKey));

  async function handleAction(action: string, asset: TreasuryAssetRow) {
    if (!canManage) return;
    if (action === 'hide' || action === 'unhide') {
      const wallet = chainKind === 'evm' ? evmAddress : publicKey?.toBase58();
      if (!wallet) return;
      const signChallenge = chainKind === 'evm'
        ? (m: string) => signMessageAsync({ message: m })
        : signMessage
          ? solanaAccessSigner(signMessage)
          : null;
      if (!signChallenge) {
        toast({
          variant: 'destructive',
          title: 'Wallet cannot sign',
          description: 'Connect a wallet that can sign messages.',
        });
        return;
      }
      const write = action === 'hide' ? hideAsset : unhideAsset;
      const { error: hErr } = await write(asset.mint, wallet, signChallenge);
      if (hErr) {
        toast({
          variant: 'destructive',
          title: action === 'hide' ? 'Could not hide asset' : 'Could not unhide asset',
          description: hErr,
        });
      } else {
        toast({
          title: action === 'hide' ? 'Asset hidden' : 'Asset restored',
          description: action === 'hide'
            ? `${asset.symbol} moved to Hidden Assets.`
            : `${asset.symbol} is visible again.`,
        });
      }
      return;
    }
    if (action === 'deposit') {
      if (chainKind === 'evm' && asset.mint === 'ETH') {
        toast({
          variant: 'destructive',
          title: 'Use WETH',
          description: 'Add ETH by depositing WETH. Extra ETH in your wallet is wrapped automatically.',
        });
        return;
      }
      setDepositAsset(asset);
      return;
    }
    if (action === 'configure') {
      if (chainKind === 'evm') {
        toast({
          variant: 'destructive',
          title: 'Configured in Constitution',
          description: 'EVM strategy adapters are approved and capped from the Constitution page.',
        });
        return;
      }
      setConfigureAsset(asset);
      return;
    }
    if (action === 'registerSolana') {
      if (chainKind !== 'solana' || !publicKey) return;
      setRegisterSolanaAsset(asset);
      return;
    }
    if (action === 'feeAsset') {
      if (chainKind === 'evm') return;
      const r = await buildSetFeeAsset(new PublicKey(daoAddress!), publicKey!, new PublicKey(asset.mint));
      const out = await tx.send(r, { successLabel: 'Fee asset set' });
      if (out.status === 'success') refetch();
    }
  }

  async function handleNftAction(action: string, nft: TreasuryNft) {
    if (!canManage || chainKind !== 'solana' || !publicKey || !daoAddress) return;
    if (action === 'registerNft') {
      try {
        const r = await buildRegisterNftAsset(new PublicKey(daoAddress), publicKey, new PublicKey(nft.mint));
        const out = await tx.send(r, { successLabel: 'NFT registered for governance' });
        if (out.status === 'success') refetchNfts();
      } catch (err) {
        toast({
          variant: 'destructive',
          title: 'Registration failed',
          description: err instanceof Error ? err.message : 'Could not register NFT.',
        });
      }
      return;
    }
    if (action === 'sendNft') {
      navigate('/overview', { state: { openCreateTx: true, nftTransfer: { mint: nft.mint, name: nft.name } } });
    }
  }

  const showAssetTabs = !loading && !error && (assets.length > 0 || tab === 'nfts');

  const tabItems = [
    { id: 'tokens' as const, label: `Tokens (${visibleAssets.length})` },
    { id: 'hidden' as const, label: `Hidden${hiddenAssets.length ? ` (${hiddenAssets.length})` : ''}` },
    { id: 'nfts' as const, label: `NFTs${nfts.length ? ` (${nfts.length})` : ''}` },
  ];

  return (
    <div className="animate-fade-in pb-8" data-onboarding-id="assets-root">
      {(showDeposit || depositAsset) && canManage && daoAddress && (
        <DepositFlowModal
          daoAddress={daoAddress}
          registeredAssets={assets}
          preselectedAsset={depositAsset ?? undefined}
          initialTab="wallet"
          onClose={() => {
            setShowDeposit(false);
            setDepositAsset(null);
          }}
          onDeposited={refetch}
        />
      )}
      {configureAsset && canManage && (publicKey || isMockMode) && (
        <ConfigureTargetsModal
          daoAddress={daoAddress!}
          founder={publicKey}
          asset={configureAsset}
          onClose={() => setConfigureAsset(null)}
          onDone={refetch}
        />
      )}
      {registerEvmAsset && canManage && chainKind === 'evm' && (
        <RegisterEvmAssetModal
          daoAddress={daoAddress!}
          onClose={() => setRegisterEvmAsset(false)}
          onDone={refetch}
        />
      )}
      {registerSolanaAsset && canManage && chainKind === 'solana' && publicKey && (
        <RegisterSolanaHeldAssetModal
          daoAddress={daoAddress!}
          founder={publicKey}
          asset={registerSolanaAsset}
          onClose={() => setRegisterSolanaAsset(null)}
          onDone={refetch}
        />
      )}

      {/* Header — matches #view-money in demo.html */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 flex-wrap">
        <div>
          <div className="nave-label" style={{ marginBottom: '10px' }}>Money</div>
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
            Where it is,{' '}
            <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>
              what it&apos;s doing.
            </em>
          </h1>
          <p
            style={{
              fontSize: '14.5px',
              color: 'hsl(var(--muted-foreground))',
              margin: 0,
              maxWidth: '520px',
              lineHeight: 1.55,
            }}
          >
            {onchainNavUsd != null
              ? `${USD(onchainNavUsd)} total. Nothing sits anywhere your rules haven't approved.`
              : 'Deposit and withdraw from your treasury. Agents use these balances automatically.'}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          <button
            type="button"
            onClick={() => {
              refetch();
              refetchNfts();
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] border font-semibold transition-colors"
            style={{
              fontSize: '13px',
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          >
            Refresh
          </button>
          {canManage && daoAddress && (
            <button
              type="button"
              onClick={() => {
                setDepositAsset(null);
                setShowDeposit(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold transition-colors"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--foreground))',
                color: '#ffffff',
                border: '1px solid hsl(var(--foreground))',
              }}
            >
              Deposit
            </button>
          )}
        </div>
      </div>

      {/* NAV 3-stat hairline strip */}
      <Section>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <MetricCard
            label="Total value"
            value={onchainNavUsd != null ? USD(onchainNavUsd) : '—'}
            sub="Withdrawable or placed by rules"
          />
          <MetricCard
            label="In use by agents"
            value={deployedUsd != null ? USD(deployedUsd) : '—'}
            sub="Across approved yield places"
          />
          <MetricCard
            label="Tokens"
            value={visibleAssets.length.toString()}
            sub={hiddenAssets.length > 0 ? `${hiddenAssets.length} hidden` : 'Tracked in treasury'}
          />
        </div>
      </Section>

      {/* Holdings section with UnderlineTabs: Tokens / Hidden / NFTs */}
      <Section>
        {showAssetTabs && (
          <UnderlineTabs
            tabs={tabItems}
            activeTab={tab}
            onChange={setTab}
          />
        )}

        {loading && (
          <div className="space-y-3 pt-2">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={3} />
          </div>
        )}

        {!loading && error && (
          <Notice tone="red">
            <strong style={{ fontWeight: 600 }}>Could not load assets</strong>{' '}
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>— {error}</span>
          </Notice>
        )}

        {!loading && !error && assets.length === 0 && tab !== 'nfts' && (
          <NaveEmptyState
            icon="coins"
            title="No deposited assets yet"
            description="Deposit from your wallet to get started. Supported tokens are added automatically."
          />
        )}

        {!loading && !error && assets.length > 0 && tab === 'tokens' && (
          <div>
            {visibleAssets.map((a) => (
              <AssetCard key={a.mint} asset={a} canManage={canManage} onAction={handleAction} />
            ))}
            {visibleAssets.length === 0 && (
              <NaveEmptyState
                icon="eye-slash"
                title="All assets are hidden"
                description="Every detected asset is in the Hidden tab. Unhide one to show it here."
              />
            )}
          </div>
        )}

        {!loading && !error && assets.length > 0 && tab === 'hidden' && (
          <div>
            {hiddenAssets.map((a) => (
              <AssetCard key={a.mint} asset={a} canManage={canManage} onAction={handleAction} hidden />
            ))}
            {hiddenAssets.length === 0 && (
              <NaveEmptyState
                icon="eye"
                title="No hidden assets"
                description="Hide airdrop spam or dust from the Tokens tab to declutter the default view."
              />
            )}
          </div>
        )}

        {tab === 'nfts' && (
          <>
            {nftsLoading && (
              <div className="space-y-2 pt-2">
                <CardSkeleton lines={2} />
                <CardSkeleton lines={2} />
              </div>
            )}
            {!nftsLoading && nftsError && (
              <Notice tone="red">
                <strong style={{ fontWeight: 600 }}>Could not load NFTs</strong>{' '}
                <span style={{ color: 'hsl(var(--muted-foreground))' }}>— {nftsError}</span>
              </Notice>
            )}
            {!nftsLoading && !nftsError && nftsUnsupported && chainKind === 'evm' && (
              <NaveEmptyState
                icon="image"
                title="EVM NFT custody only"
                description="The treasury can receive and governance-transfer ERC-721/1155, but there is no on-chain NFT registry (EIP-170). Gallery listing is intentionally unsupported until an off-chain indexer is productized."
              />
            )}
            {!nftsLoading && !nftsError && nftsUnsupported && chainKind === 'solana' && (
              <NaveEmptyState
                icon="image"
                title="NFT indexing unavailable"
                description="Your RPC does not support DAS (getAssetsByOwner). Use a Helius or Triton endpoint to enumerate treasury NFTs."
              />
            )}
            {!nftsLoading && !nftsError && !nftsUnsupported && nfts.length === 0 && (
              <NaveEmptyState
                icon="image"
                title="No NFTs in treasury"
                description={
                  chainKind === 'evm'
                    ? 'Transfer an ERC-721 to the treasury contract to hold it under governance.'
                    : 'Transfer a Metaplex NFT to the vault authority address. It can be sent from here as soon as it arrives.'
                }
              />
            )}
            {!nftsLoading && !nftsError && nfts.length > 0 && (
              <div>
                {nfts.map((n) => (
                  <NftCard key={n.id} nft={n} canManage={canManage} onAction={handleNftAction} />
                ))}
              </div>
            )}
          </>
        )}

        {onchainNavUsd == null && !loading && assets.length > 0 && tab !== 'nfts' && (
          <div style={{ marginTop: '16px' }}>
            <Notice tone="brass">
              Dollar values appear after the treasury is priced. Balances are already live.
            </Notice>
          </div>
        )}

        {canManage && chainKind === 'evm' && (
          <div style={{ marginTop: '20px' }}>
            <button
              type="button"
              onClick={() => setRegisterEvmAsset(true)}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{ fontSize: '12.5px', color: 'hsl(var(--faint))' }}
            >
              + Advanced — add a token manually
            </button>
          </div>
        )}
      </Section>
    </div>
  );
}
