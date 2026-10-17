import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useSignMessage } from 'wagmi';
import Fi from '../components/Fi';
import { CardSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import MetricCard from '../components/MetricCard';
import { useDaoContext } from '../hooks/useDaoContext';
import { useTreasuryAssets, type TreasuryAssetRow } from '../hooks/useTreasuryAssets';
import { useTreasuryNfts, type TreasuryNft } from '../hooks/useTreasuryNfts';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { DepositFlowModal } from '../components/DepositFlow';
import NaveModal from '../components/NaveModal';
import { toast } from '../hooks/use-toast';
import { describeTransactionError } from '../lib/errorMessages';
import { buildRegisterAssetEvm, buildRevalueTreasuryEvm, type EvmBuildResult } from '../lib/evm/writers';
import {
  buildInitStrategyPosition,
  buildInitStrategyEscrow,
  buildConfigurePositionTargets,
  buildConfigureMarginfiPosition,
  buildRegisterAsset,
  buildRegisterNftAsset,
  buildRevalueTreasury,
  buildSetFeeAsset,
} from '../lib/transactionBuilders';
import { evmAllowedAssets, resolveAsset, riskLabel, type AllowedAsset, type EvmAllowedAsset } from '../lib/allowedAssets';
import { fetchYieldData, solanaAccessSigner } from '../lib/edgeFunctionClient';
import { getSolanaRegisterAssetPlan } from '../lib/solanaTreasuryRegistrationDefaults';
import { getSolanaStrategyStatuses } from '../lib/strategyReadiness';
import { SOLANA_NETWORK } from '../lib/programConfig';

const CHAINLINK_SOL_USD_FEED_DEVNET = '99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR';
const CHAINLINK_SOL_USD_FEED_MAINNET = 'CH31Xns5z3M1cTAbKW34jcxPPciazARpijcHj9rxtemt';
const WSOL_MINT_STR = 'So11111111111111111111111111111111111111112';

const MARGINFI_STRATEGY_ENABLED = getSolanaStrategyStatuses().find((s) => s.id === 'marginfi')?.supported ?? false;
const JUPITER_STRATEGY_BADGE = getSolanaStrategyStatuses().find((s) => s.id === 'jupiter')?.badge ?? null;
import type { EvmChainId } from '../lib/chain/types';

const USD = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FIELD_STYLE: React.CSSProperties = {
  fontSize: 13,
  backgroundColor: 'hsl(var(--surface-0))',
  borderColor: 'hsl(var(--border))',
  color: 'hsl(var(--foreground))',
};

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <NaveModal open title={title} onClose={onClose} maxWidth={460}>
      <div className="px-5 py-4 space-y-4">{children}</div>
    </NaveModal>
  );
}

function Field({ label, value, onChange, placeholder, mono }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2.5 rounded-lg border outline-none"
        style={{ ...FIELD_STYLE, fontFamily: mono ? 'var(--font-mono)' : 'var(--font-body)' }}
      />
    </div>
  );
}

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p style={{ fontSize: 12, color: 'hsl(var(--destructive))' }}>{msg}</p>;
}

function PrimaryBtn({ onClick, busy, disabled, children }: { onClick: () => void; busy: boolean; disabled?: boolean; children: React.ReactNode }) {
  const isDisabled = busy || !!disabled;
  return (
    <button onClick={onClick} disabled={isDisabled} className="px-4 py-2 rounded-lg font-medium"
      style={{ fontSize: 13, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', opacity: isDisabled ? 0.6 : 1, cursor: isDisabled ? 'not-allowed' : 'pointer' }}>
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
function ConfigureTargetsModal({ daoAddress, founder, asset, onClose, onDone }: {
  daoAddress: string; founder: PublicKey; asset: TreasuryAssetRow; onClose: () => void; onDone: () => void;
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
        // Auto-select the best (highest adjustedScore)
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
      // Intentional Solana-only: this binds a Kamino/Jito/marginfi market+reserve
      // PDA (Solana `configure_position_targets` / `init_strategy_*`). On EVM each
      // adapter (Aave/Compound/Balancer) encodes its own underlying target,
      // so there is no per-position binding — approve adapters + set allocation
      // caps via the constitution (Policy) instead. See FEATURE_PARITY_MATRIX ❎.
      toast({ variant: 'destructive', title: 'Solana-only step', description: 'EVM adapters self-target their pool — approve adapters and set caps via the Policy constitution instead.' });
      return;
    }
    let market: PublicKey, reserve: PublicKey;
    try {
      market = new PublicKey(extMarket.trim());
      reserve = new PublicKey(extReserve.trim());
    } catch { setErr('Market and reserve must be valid Solana addresses'); return; }
    setBusy(true);
    try {
      const dao = new PublicKey(daoAddress);
      const mintKey = new PublicKey(asset.mint);
      const initPos = await buildInitStrategyPosition(dao, founder, protocol, mintKey);
      const initEsc = await buildInitStrategyEscrow(dao, founder, protocol, mintKey);
      if (protocol === 'marginfi') {
        // configure_marginfi_position(ext_market=marginfi_group, ext_reserve=bank)
        // — a dedicated instruction (not the generic configure_position_targets):
        // it additionally provisions the DAO's cross-margin MarginfiAccount
        // ledger via a fresh keypair that must co-sign this call.
        const configure = await buildConfigureMarginfiPosition(dao, founder, mintKey, market, reserve);
        const out = await tx.sendGrouped([[initPos, initEsc, configure]], { successLabel: 'MarginFi position configured' });
        if (out.status === 'success' || out.status === 'mock') { onDone(); onClose(); }
        else setErr(out.error || 'Configuration failed');
        return;
      }
      let collateral: PublicKey;
      try {
        collateral = new PublicKey((collateralMint || extMarket).trim());
      } catch { setErr('Collateral mint must be a valid Solana address'); return; }
      const configure = await buildConfigurePositionTargets(dao, founder, protocol, mintKey, collateral, market, reserve);
      const out = await tx.sendGrouped([[initPos, initEsc, configure]], { successLabel: 'Strategy targets configured' });
      if (out.status === 'success' || out.status === 'mock') { onDone(); onClose(); }
      else setErr(out.error || 'Configuration failed');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Configuration failed'); }
    finally { setBusy(false); }
  }

  const canSubmit = !!extMarket && !!extReserve;
  // NOTE: marginfi's `market`/`reserve` map to configure_marginfi_position's
  // (ext_market=marginfi_group, ext_reserve=bank) — distinct from the generic
  // configure_position_targets(protocol_id, ext_market, ext_reserve) shape the
  // other protocols use (where collateral is also required). MarginFi has no
  // collateral-mint concept here, so that field is hidden for it below.
  const fieldLabels: Record<string, { collateral: string; market: string; reserve: string }> = {
    kamino:   { collateral: 'Reserve collateral mint', market: 'Lending market', reserve: 'Reserve' },
    jito:     { collateral: 'Pool mint (poolSOL)',     market: 'Stake pool',     reserve: 'Reserve stake' },
    marginfi: { collateral: 'Collateral mint',         market: 'MarginFi group', reserve: 'Bank address' },
    jupiter:  { collateral: 'jlToken (fToken) mint',   market: 'Lending PDA',    reserve: 'Liquidity vault' },
  };
  const labels = fieldLabels[protocol] ?? fieldLabels.kamino;

  return (
    <ModalShell title={`Configure ${asset.symbol} strategy targets`} onClose={onClose}>
      {/* Context */}
      <p style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
        We pick the best yield pool for {asset.symbol}. Confirm to continue.
      </p>

      {/* Protocol selector */}
      <div className="space-y-1.5">
        <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>Protocol</label>
        <select value={protocol} onChange={(e) => { setProtocol(e.target.value); setDiscoveredPools([]); setSelectedPoolId(null); }}
          className="w-full px-3 py-2.5 rounded-lg border outline-none" style={FIELD_STYLE}>
          <option value="kamino">Kamino (klend)</option>
          <option value="jito">Jito (SPL stake pool)</option>
          {MARGINFI_STRATEGY_ENABLED && <option value="marginfi">MarginFi (lending)</option>}
          <option value="jupiter">Jupiter (Lend Earn){JUPITER_STRATEGY_BADGE === 'beta' ? ' — Beta' : ''}</option>
        </select>
        {discovering && (
          <p style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))' }} className="flex items-center gap-1.5">
            <Fi icon="arrows-rotate" className="animate-spin" style={{ fontSize: 10 }} />
            Scanning live pools…
          </p>
        )}
      </div>

      {/* Discovered pools list */}
      {discoveredPools.length > 0 && (
        <div className="space-y-1.5">
          <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>
            Live pools found — ranked by risk-adjusted yield
          </label>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {discoveredPools.map((pool) => {
              const rl = riskLabel(pool.riskScore);
              const selected = pool.poolId === selectedPoolId;
              return (
                <button
                  key={pool.poolId}
                  onClick={() => selectPool(pool)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-all"
                  style={{
                    fontSize: 12,
                    backgroundColor: selected ? 'hsl(var(--surface-1))' : 'hsl(var(--surface-0))',
                    borderColor: selected ? 'hsl(var(--ring))' : 'hsl(var(--border))',
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {selected && <Fi icon="circle-check" style={{ fontSize: 10, color: 'hsl(var(--primary))', flexShrink: 0 }} />}
                    <span className="nave-mono truncate" style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
                      {pool.source}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                    <span className="nave-mono" style={{ fontSize: 11, color: 'hsl(var(--success))' }}>
                      {(pool.apyBps / 100).toFixed(2)}% APY
                    </span>
                    <span style={{ fontSize: 10.5, color: rl.color, fontFamily: 'var(--font-mono)' }}>
                      {rl.label} risk
                    </span>
                    {pool.tvlUsd > 0 && (
                      <span style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
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
        onClick={() => setShowAdvanced(v => !v)}
        className="flex items-center gap-1.5 w-full text-left"
        style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={showAdvanced ? 'chevron-up' : 'chevron-down'} style={{ fontSize: 10 }} />
        Advanced — manual pool addresses
      </button>
      {showAdvanced && (
        <div className="space-y-3 pt-1">
          <button
            type="button"
            onClick={handleDiscover}
            disabled={discovering || busy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border font-medium"
            style={{ fontSize: 12, borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
          >
            <Fi icon={discovering ? 'arrows-rotate' : 'magnifying-glass'} style={{ fontSize: 11 }} className={discovering ? 'animate-spin' : ''} />
            {discovering ? 'Scanning…' : 'Re-scan pools'}
          </button>
          {protocol !== 'marginfi' && (
            <Field label={labels.collateral} value={collateralMint} onChange={setCollateralMint} placeholder="cToken / pool / jlToken mint…" mono />
          )}
          <Field label={labels.market} value={extMarket} onChange={setExtMarket} placeholder="ext market / lending PDA…" mono />
          <Field label={labels.reserve} value={extReserve} onChange={setExtReserve} placeholder="ext reserve / vault…" mono />
        </div>
      )}

      {allowedAsset && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ backgroundColor: 'hsl(var(--surface-1))', fontSize: 11.5, color: 'hsl(var(--muted-foreground))' }}>
          <Fi icon="circle-info" style={{ fontSize: 11 }} />
          {allowedAsset.symbol} is in the curated allowlist — asset class: {allowedAsset.assetClass}, max risk: {allowedAsset.maxRisk}/100.
        </div>
      )}

      <Err msg={err} />
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border" style={{ fontSize: 13, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>Cancel</button>
        <PrimaryBtn onClick={submit} busy={busy} disabled={!canSubmit}>
          {busy ? 'Configuring…' : 'Configure targets'}
        </PrimaryBtn>
      </div>
    </ModalShell>
  );
}

/* ── Register EVM asset ───────────────────────────────────── */
function RegisterEvmAssetModal({ daoAddress, onClose, onDone }: {
  daoAddress: string; onClose: () => void; onDone: () => void;
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
    if (!evmChainId) { setErr('Select an Ethereum or Base network.'); return; }
    if (!asset) { setErr('Select an asset to register.'); return; }
    const feedHex = pythPresetLocked ? defaultFeed : pythFeed;
    const feed = normalizePythFeed(feedHex);
    if (!feed) { setErr('Pyth feed id must be 32 bytes / 64 hex chars. Stablecoins use all zeros.'); return; }
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
      if (out.status === 'success' || out.status === 'mock') { onDone(); onClose(); }
      else setErr(out.error || 'Registration failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Add a token" onClose={onClose}>
      <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
        Choose a supported token. Setup happens automatically so you can deposit next.
      </p>
      <div className="space-y-1.5">
        <label className="nave-label" style={{ fontSize: 12, fontWeight: 500 }}>Asset</label>
        <select
          value={asset?.address ?? ''}
          onChange={(e) => selectAsset(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border outline-none"
          style={FIELD_STYLE}
        >
          {assets.map((a) => (
            <option key={a.address} value={a.address}>{a.symbol} — {a.name}</option>
          ))}
        </select>
      </div>
      {!pythPresetLocked && (
        <details>
          <summary style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}>Advanced</summary>
          <div className="pt-2">
            <Field label="Price feed id" value={pythFeed} onChange={setPythFeed} placeholder={ZERO_PYTH_FEED} mono />
          </div>
        </details>
      )}
      <Err msg={err} />
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border" style={{ fontSize: 13, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>Cancel</button>
        <PrimaryBtn onClick={submit} busy={busy} disabled={!asset}>{busy ? 'Adding…' : 'Add token'}</PrimaryBtn>
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
        setErr('Pyth price feed id must be 32 bytes (64 hex characters). Use the feed id from Pyth for this token.');
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
      } else setErr(describeTransactionError(out.error, { programHint: 'core', fallback: 'Registration failed' }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title={`Enable ${asset.symbol}`} onClose={onClose}>
      <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
        Enables {asset.symbol} for deposits and transfers from this treasury.
      </p>
      {plan.mode === 'needs_pyth_feed' && (
        <details open>
          <summary style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}>Advanced — price feed</summary>
          <div className="pt-2">
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
        <div className="px-3 py-2 rounded-lg" style={{ backgroundColor: 'hsl(var(--surface-1))', fontSize: 12, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
          {asset.symbol} is ready to enable.
        </div>
      )}
      <Err msg={err} />
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border" style={{ fontSize: 13, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>Cancel</button>
        <PrimaryBtn onClick={submit} busy={busy}>{busy ? 'Confirming…' : 'Enable asset'}</PrimaryBtn>
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

/* ── Asset card ─────────────────────────────────────────────── */
function AssetCard({ asset, canManage, onAction, hidden = false }: {
  asset: TreasuryAssetRow; canManage: boolean; onAction: (a: string, asset: TreasuryAssetRow) => void; hidden?: boolean;
}) {
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const heldUnregistered = !asset.onChainRegistered && asset.uiBalance > 0;
  const solMintOk =
    asset.mint !== 'SOL' && asset.mint.length >= 32 && asset.mint.length <= 44;
  const showEnableSolana = chainKind === 'solana' && heldUnregistered && solMintOk;
  const depositBlocked = chainKind === 'evm' && asset.mint === 'ETH';
  const dexHref = treasuryAssetDexScreenerUrl(asset, chainKind, evmChainId);

  return (
    <div className="rounded-xl border p-5" style={{ backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))' }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
            <Fi icon="coins" style={{ fontSize: '16px', color: 'hsl(var(--foreground))' }} />
          </div>
          <div>
            <div className="text-display font-semibold" style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }}>{asset.symbol}</div>
            <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
              {asset.name}
              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--muted-foreground))' }}>
                {asset.assetKindLabel}
              </span>
              {heldUnregistered && (
                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ backgroundColor: 'hsl(var(--surface-2))', color: 'hsl(var(--foreground))' }}>
                  Held · not on registry
                </span>
              )}
              {asset.onChainRegistered && !asset.enabled && (
                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ backgroundColor: 'hsl(var(--destructive-muted))', color: 'hsl(var(--destructive))' }}>Disabled</span>
              )}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-display font-semibold" style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }}>{USD(asset.valueUsd)}</div>
          <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>{asset.allocationPct.toFixed(1)}% of NAV</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {[
          { label: 'Available', value: asset.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) },
          { label: 'In use', value: (asset.deployedCapital / Math.pow(10, asset.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) },
        ].map((s) => (
          <div key={s.label} className="p-2.5 rounded-lg" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
            <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginBottom: '2px' }}>{s.label}</div>
            <div className="text-display font-semibold" style={{ fontSize: '14px', color: 'hsl(var(--foreground))' }}>{s.value}</div>
          </div>
        ))}
      </div>

      <details className="mb-4">
        <summary style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}>Details</summary>
        <div className="flex items-center gap-2 p-2.5 rounded-lg mt-2" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
          <code style={{ fontSize: '11px', color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>
            {asset.mint}
          </code>
          <button type="button" onClick={() => navigator.clipboard.writeText(asset.mint)} className="ml-auto p-1 rounded flex-shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }} title="Copy">
            <Fi icon="copy" style={{ fontSize: '11px' }} />
          </button>
        </div>
        {dexHref && (
          <a
            href={dexHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-2 px-2.5 py-1 rounded-lg border text-xs font-medium"
            style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
          >
            <Fi icon="arrow-up-right-from-square" style={{ fontSize: 10 }} /> Market
          </a>
        )}
      </details>

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onAction('deposit', asset)}
            disabled={depositBlocked}
            title={depositBlocked ? 'Use WETH to add ETH to the treasury.' : undefined}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium"
            style={{
              borderColor: 'hsl(var(--border))',
              color: depositBlocked ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
              opacity: depositBlocked ? 0.55 : 1,
              cursor: depositBlocked ? 'not-allowed' : 'pointer',
            }}
          >
            <Fi icon="arrow-down" style={{ fontSize: 10 }} /> Add funds
          </button>
          {showEnableSolana && (
            <button
              type="button"
              onClick={() => onAction('registerSolana', asset)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium"
              style={{ borderColor: 'hsl(var(--primary))', color: 'hsl(var(--primary))' }}
            >
              <Fi icon="bolt" style={{ fontSize: 10 }} /> Enable
            </button>
          )}
          {chainKind !== 'evm' && asset.onChainRegistered && asset.isStablecoin && (
            <button onClick={() => onAction('feeAsset', asset)} disabled={tx.status === 'signing'} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium"
              style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}>
              <Fi icon="receipt" style={{ fontSize: 10 }} /> Set as fee asset
            </button>
          )}
          <button
            onClick={() => onAction('configure', asset)}
            disabled={chainKind === 'solana' && !asset.onChainRegistered}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium"
            style={{
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
              opacity: chainKind === 'solana' && !asset.onChainRegistered ? 0.55 : 1,
              cursor: chainKind === 'solana' && !asset.onChainRegistered ? 'not-allowed' : 'pointer',
            }}
          >
            <Fi icon="sliders" style={{ fontSize: 10 }} /> Yield setup
          </button>
          <button
            onClick={() => onAction(hidden ? 'unhide' : 'hide', asset)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium"
            style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
            title={hidden ? 'Show this asset in the default view' : 'Hide this asset (e.g. airdrop spam) from the default view'}
          >
            <Fi icon={hidden ? 'eye' : 'eye-slash'} style={{ fontSize: 10 }} /> {hidden ? 'Unhide' : 'Hide'}
          </button>
        </div>
      )}
    </div>
  );
}

function NftCard({ nft, canManage, onAction }: {
  nft: TreasuryNft;
  canManage: boolean;
  onAction: (action: string, nft: TreasuryNft) => void;
}) {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-0))' }}>
      <div className="aspect-square relative" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
        {nft.image ? (
          <img src={nft.image} alt={nft.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
            <Fi icon="image" style={{ fontSize: 28 }} />
          </div>
        )}
        {nft.compressed && (
          <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-medium"
            style={{ backgroundColor: 'hsl(var(--surface-0))', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}>
            Compressed
          </span>
        )}
      </div>
      <div className="p-3.5 space-y-2">
        <div className="font-medium truncate" style={{ fontSize: 14, color: 'hsl(var(--foreground))' }}>{nft.name}</div>
        <div className="nave-mono truncate" style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>{nft.mint}</div>
        {nft.collection && (
          <div style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
            Collection: {nft.collection.slice(0, 4)}…{nft.collection.slice(-4)}
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {!nft.registered && canManage && !nft.compressed && (
            <button
              onClick={() => onAction('registerNft', nft)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium"
              style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            >
              <Fi icon="shield-check" style={{ fontSize: 10 }} /> Register for governance
            </button>
          )}
          {nft.registered && canManage && (
            <button
              onClick={() => onAction('sendNft', nft)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium"
              style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            >
              <Fi icon="paper-plane" style={{ fontSize: 10 }} /> Send via governance
            </button>
          )}
          {nft.compressed && (
            <span style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', lineHeight: 1.4 }}>
              cNFT transfers require a dedicated Bubblegum path (coming soon).
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Assets page ────────────────────────────────────────────── */
export default function Assets() {
  const navigate = useNavigate();
  const { daoAddress, isMockMode } = useDaoContext();
  const { publicKey, signMessage } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const { assets, visibleAssets, hiddenAssets, onchainNavUsd, deployedUsd, loading, error, refetch, hideAsset, unhideAsset } = useTreasuryAssets(daoAddress);
  const { nfts, loading: nftsLoading, error: nftsError, unsupported: nftsUnsupported, refetch: refetchNfts } = useTreasuryNfts(daoAddress);
  const [depositAsset, setDepositAsset] = useState<TreasuryAssetRow | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [configureAsset, setConfigureAsset] = useState<TreasuryAssetRow | null>(null);
  const [registerEvmAsset, setRegisterEvmAsset] = useState(false);
  const [registerSolanaAsset, setRegisterSolanaAsset] = useState<TreasuryAssetRow | null>(null);
  const [revaluing, setRevaluing] = useState(false);
  const [tab, setTab] = useState<'tokens' | 'hidden' | 'nfts'>('tokens');

  const canManage = !!daoAddress && !isMockMode && (chainKind === 'evm' ? !!evmAddress : !!publicKey);

  async function handleRevalueNav() {
    if (!daoAddress || revaluing) return;
    setRevaluing(true);
    try {
      if (chainKind === 'evm') {
        if (!evmChainId) {
          toast({ variant: 'destructive', title: 'Select network', description: 'Select an EVM network to revalue treasury NAV.' });
          return;
        }
        const out = await tx.sendEvm(buildRevalueTreasuryEvm(evmChainId, daoAddress), {
          successLabel: 'Treasury NAV revalued',
        });
        if (out.status === 'success' || out.status === 'mock') {
          refetch();
        }
        return;
      }
      if (!publicKey) {
        toast({ variant: 'destructive', title: 'Connect wallet', description: 'Connect your founder wallet to revalue treasury NAV.' });
        return;
      }
      const registered = assets.filter((a) => a.onChainRegistered && a.mint !== 'SOL');
      if (registered.length === 0) {
        toast({ variant: 'destructive', title: 'No registered assets', description: 'Enable at least one treasury asset before revaluing NAV.' });
        return;
      }
      const solFeed = new PublicKey(
        SOLANA_NETWORK === 'mainnet' ? CHAINLINK_SOL_USD_FEED_MAINNET : CHAINLINK_SOL_USD_FEED_DEVNET,
      );
      const revalueAssets = registered.map((a) => ({
        mint: new PublicKey(a.mint),
        priceUpdate: a.isStablecoin ? undefined : a.mint === WSOL_MINT_STR ? solFeed : undefined,
      }));
      const built = await buildRevalueTreasury(new PublicKey(daoAddress), publicKey, revalueAssets);
      const out = await tx.send(built, { successLabel: 'Treasury NAV revalued' });
      if (out.status === 'success' || out.status === 'mock') {
        refetch();
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Revalue failed',
        description: err instanceof Error ? err.message : 'Could not revalue treasury NAV.',
      });
    } finally {
      setRevaluing(false);
    }
  }

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
        toast({ variant: 'destructive', title: 'Wallet cannot sign', description: 'Connect a wallet that can sign messages.' });
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
      if (chainKind === 'solana' && !asset.onChainRegistered && asset.mint !== 'SOL') {
        setRegisterSolanaAsset(asset);
        return;
      }
      setDepositAsset(asset);
      return;
    }
    if (action === 'configure') {
      if (chainKind === 'evm') {
        toast({ variant: 'destructive', title: 'Configured in Constitution', description: 'EVM strategy adapters are approved and capped from the Constitution page.' });
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
        toast({ variant: 'destructive', title: 'Registration failed', description: err instanceof Error ? err.message : 'Could not register NFT.' });
      }
      return;
    }
    if (action === 'sendNft') {
      navigate('/dashboard', { state: { openCreateTx: true, nftTransfer: { mint: nft.mint, name: nft.name } } });
    }
  }

  const showAssetTabs = !loading && !error && (assets.length > 0 || tab === 'nfts');

  return (
    <div className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 pb-8" data-onboarding-id="assets-root">
      {(showDeposit || depositAsset) && canManage && daoAddress && (
        <DepositFlowModal
          daoAddress={daoAddress}
          registeredAssets={assets}
          preselectedAsset={depositAsset ?? undefined}
          initialTab="wallet"
          onClose={() => { setShowDeposit(false); setDepositAsset(null); }}
          onDeposited={refetch}
        />
      )}
      {configureAsset && canManage && publicKey && (
        <ConfigureTargetsModal daoAddress={daoAddress!} founder={publicKey!} asset={configureAsset} onClose={() => setConfigureAsset(null)} onDone={refetch} />
      )}
      {registerEvmAsset && canManage && chainKind === 'evm' && (
        <RegisterEvmAssetModal daoAddress={daoAddress!} onClose={() => setRegisterEvmAsset(false)} onDone={refetch} />
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

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-display font-semibold" style={{ fontSize: '20px', color: 'hsl(var(--foreground))' }}>Assets</h1>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', lineHeight: 1.55 }}>
            Deposit and withdraw from your treasury. Agents use these balances automatically.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {canManage && daoAddress && (
            <button onClick={() => { setDepositAsset(null); setShowDeposit(true); }} className="flex items-center gap-1.5 px-3 py-2 rounded-lg font-medium"
              style={{ fontSize: 12.5, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
              <Fi icon="arrow-down" style={{ fontSize: 11 }} /> Deposit
            </button>
          )}
          {canManage && daoAddress && assets.some((a) => a.onChainRegistered) && (
            <button
              onClick={() => void handleRevalueNav()}
              disabled={revaluing}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border font-medium"
              style={{ fontSize: 12.5, borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', opacity: revaluing ? 0.6 : 1 }}
            >
              <Fi icon="arrows-rotate" className={revaluing ? 'animate-spin' : ''} style={{ fontSize: 11 }} />
              {revaluing ? 'Revaluing…' : 'Revalue NAV'}
            </button>
          )}
          <button onClick={() => { refetch(); refetchNfts(); }} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border font-medium"
            style={{ fontSize: 12.5, borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}>
            <Fi icon="arrow-rotate-right" style={{ fontSize: 11 }} /> Refresh
          </button>
        </div>
      </div>

      {/* NAV summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MetricCard label="Total value" value={onchainNavUsd != null ? USD(onchainNavUsd) : '—'} />
        <MetricCard label="In use by agents" value={deployedUsd != null ? USD(deployedUsd) : '—'} />
        <MetricCard label="Tokens" value={visibleAssets.length.toString()} />
      </div>

      {/* Tabs: Tokens / Hidden / NFTs */}
      {showAssetTabs && (
        <div className="flex gap-0.5 p-0.5 rounded-lg w-fit flex-wrap" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
          {([
            ['tokens', `Tokens (${visibleAssets.length})`],
            ['hidden', `Hidden${hiddenAssets.length ? ` (${hiddenAssets.length})` : ''}`],
            ['nfts', `NFTs${nfts.length ? ` (${nfts.length})` : ''}`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="px-3.5 py-1.5 rounded-md transition-all"
              style={{
                fontSize: 12.5,
                fontWeight: tab === key ? 500 : 400,
                backgroundColor: tab === key ? 'hsl(var(--surface-0))' : 'transparent',
                color: tab === key ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                boxShadow: tab === key ? 'var(--shadow-xs)' : 'none',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* List */}
      {loading && (
        <div className="space-y-3"><CardSkeleton lines={4} /><CardSkeleton lines={3} /></div>
      )}
      {!loading && error && (
        <div className="p-4 rounded-xl border" style={{ borderColor: 'hsl(var(--destructive))', backgroundColor: 'hsl(var(--destructive-muted))', color: 'hsl(var(--destructive))', fontSize: 13 }}>
          {error}
        </div>
      )}
      {!loading && !error && assets.length === 0 && (
        <NaveEmptyState
          icon="coins"
          title="No deposited assets yet"
          description="Deposit from your wallet to get started. Supported tokens are added automatically."
        />
      )}
      {!loading && !error && assets.length > 0 && tab === 'tokens' && (
        <div className="space-y-4">
          {visibleAssets.map((a) => (
            <AssetCard key={a.mint} asset={a} canManage={canManage} onAction={handleAction} />
          ))}
          {visibleAssets.length === 0 && (
            <NaveEmptyState icon="eye-slash" title="All assets are hidden" description="Every detected asset is in the Hidden tab. Unhide one to show it here." />
          )}
        </div>
      )}
      {!loading && !error && assets.length > 0 && tab === 'hidden' && (
        <div className="space-y-4">
          {hiddenAssets.map((a) => (
            <AssetCard key={a.mint} asset={a} canManage={canManage} onAction={handleAction} hidden />
          ))}
          {hiddenAssets.length === 0 && (
            <NaveEmptyState icon="eye" title="No hidden assets" description="Hide airdrop spam or dust from the Tokens tab to declutter the default view." />
          )}
        </div>
      )}

      {tab === 'nfts' && (
        <>
          {nftsLoading && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <CardSkeleton lines={2} /><CardSkeleton lines={2} /><CardSkeleton lines={2} />
            </div>
          )}
          {!nftsLoading && nftsError && (
            <div className="p-4 rounded-xl border" style={{ borderColor: 'hsl(var(--destructive))', backgroundColor: 'hsl(var(--destructive-muted))', color: 'hsl(var(--destructive))', fontSize: 13 }}>
              {nftsError}
            </div>
          )}
          {!nftsLoading && !nftsError && nftsUnsupported && chainKind === 'evm' && (
            <NaveEmptyState icon="image" title="EVM NFT custody only" description="The treasury can receive and governance-transfer ERC-721/1155, but there is no on-chain NFT registry (EIP-170). Gallery listing is intentionally unsupported until an off-chain indexer is productized." />
          )}
          {!nftsLoading && !nftsError && nftsUnsupported && chainKind === 'solana' && (
            <NaveEmptyState icon="image" title="NFT indexing unavailable" description="Your RPC does not support DAS (getAssetsByOwner). Use a Helius or Triton endpoint to enumerate treasury NFTs." />
          )}
          {!nftsLoading && !nftsError && !nftsUnsupported && nfts.length === 0 && (
            <NaveEmptyState icon="image" title="No NFTs in treasury" description={chainKind === 'evm' ? 'Transfer an ERC-721 to the treasury contract to hold it under governance.' : 'Transfer a Metaplex NFT to the vault authority address. Register it here before sending via governance.'} />
          )}
          {!nftsLoading && !nftsError && nfts.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {nfts.map((n) => (
                <NftCard key={n.id} nft={n} canManage={canManage} onAction={handleNftAction} />
              ))}
            </div>
          )}
        </>
      )}

      {onchainNavUsd == null && !loading && assets.length > 0 && tab !== 'nfts' && (
        <div className="flex items-start gap-3 p-4 rounded-xl border" style={{ backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))' }}>
          <Fi icon="info-circle" style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }} />
          <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
            Dollar values appear after the treasury is priced. Balances are already live.
          </div>
        </div>
      )}

      {canManage && chainKind === 'evm' && (
        <button
          type="button"
          onClick={() => setRegisterEvmAsset(true)}
          className="flex items-center gap-1.5"
          style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}
        >
          <Fi icon="plus" style={{ fontSize: 10 }} />
          Advanced — add a token manually
        </button>
      )}
    </div>
  );
}
