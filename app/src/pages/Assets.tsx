import { NaveSelect } from '../components/NaveMenu';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useSignMessage } from 'wagmi';
import { parseUnits } from 'viem';
import Fi from '../components/Fi';
import { CardSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import MetricCard from '../components/MetricCard';
import { Notice, Section } from '../components/calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useTokenRegistry } from '../hooks/useTokenRegistry';
import { useConstitution } from '../hooks/useConstitution';
import { useTreasuryData, type StrategyInfo } from '../hooks/useTreasuryData';
import { useTreasuryAssets, type TreasuryAssetRow } from '../hooks/useTreasuryAssets';
import { useTreasuryNfts, type TreasuryNft } from '../hooks/useTreasuryNfts';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { DepositFlowModal } from '../components/DepositFlow';
import { CreateTransactionModal } from '../components/TreasuryActions';
import NaveModal from '../components/NaveModal';
import { toast } from '../hooks/use-toast';
import { describeTransactionError } from '../lib/errorMessages';
import { fetchDaoContracts } from '../lib/evm/readers';
import { buildWithdrawFromStrategyEvm, resolveEvmMinOut } from '../lib/evm/writers';
import { buildRegisterAsset } from '../lib/transactionBuilders';
import { solanaAccessSigner, withdrawStrategyViaProxyEvm } from '../lib/edgeFunctionClient';
import { getSolanaRegisterAssetPlan } from '../lib/solanaTreasuryRegistrationDefaults';
import { blendedApy } from '../lib/positionYield';
import type { EvmChainId } from '../lib/chain/types';

const USD = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const USD_EXACT = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MOCK_FALLBACK_STRATEGIES: StrategyInfo[] = [
  {
    name: 'Kamino',
    protocol: 'kamino',
    allocation: 55,
    currentValueUsd: 31_900,
    earnedUsd: 1_840,
    apy: 5.4,
  },
  {
    name: 'Jito',
    protocol: 'jito',
    allocation: 45,
    currentValueUsd: 26_100,
    earnedUsd: 2_120,
    apy: 6.2,
  },
];

interface VenueMeta {
  place: string;
  what: string;
  exit: string;
  risk: string;
}

function describeVenue(strategy: StrategyInfo): VenueMeta {
  const key = (strategy.protocol || strategy.name).toLowerCase();
  if (key.includes('aave')) {
    return {
      place: 'Aave',
      what: 'Lends USDC to borrowers',
      exit: 'Instantly',
      risk: 'Approved lending venue. Capped by your single-place rule.',
    };
  }
  if (key.includes('compound')) {
    return {
      place: 'Compound',
      what: 'Lends USDC, second venue',
      exit: 'Instantly',
      risk: 'Second lending venue so no single protocol holds everything.',
    };
  }
  if (key.includes('kamino')) {
    return {
      place: 'Kamino',
      what: 'Lends USDC in audited vaults',
      exit: 'Instantly',
      risk: 'Approved Solana lending market. Guardrail checks caps on every move.',
    };
  }
  if (key.includes('marginfi')) {
    return {
      place: 'MarginFi',
      what: 'Lends stablecoins & SOL',
      exit: 'Instantly',
      risk: 'Approved lending venue under your constitutional limits.',
    };
  }
  if (key.includes('jupiter')) {
    return {
      place: 'Jupiter Lend',
      what: 'Lends stablecoins for yield',
      exit: 'Instantly',
      risk: 'Approved yield venue capped by your constitution.',
    };
  }
  if (key.includes('jito')) {
    return {
      place: 'Jito staking',
      what: 'Stakes SOL, back in ~1 day',
      exit: '~1 day',
      risk: 'SOL price moves affect the dollar value; stake is held with major validators.',
    };
  }
  if (key.includes('lido') || key.includes('eth') || key.includes('stak')) {
    return {
      place: 'ETH staking',
      what: 'Stakes ETH, back in ~1 day',
      exit: '~1 day',
      risk: 'ETH price moves affect the dollar value; the stake itself is with a major operator.',
    };
  }
  const cleanName =
    strategy.name && !strategy.name.startsWith('0x')
      ? strategy.name.charAt(0).toUpperCase() + strategy.name.slice(1)
      : strategy.protocol.startsWith('0x')
        ? `Adapter ${strategy.protocol.slice(0, 6)}…${strategy.protocol.slice(-4)}`
        : strategy.protocol;
  return {
    place: cleanName,
    what: 'Earns yield inside your rules',
    exit: 'Instantly',
    risk: 'Protected by your reserve floor and single-place cap.',
  };
}

function describeHoldingJob(asset: TreasuryAssetRow): string {
  const sym = asset.symbol.toUpperCase();
  if (asset.isStablecoin || sym === 'USDC' || sym === 'USDT' || sym === 'DAI' || sym === 'USDS') {
    return 'Reserve + lending. The stable core: part sits safe in reserve, part lends in approved places.';
  }
  if (sym === 'SOL' || sym === 'WSOL') {
    return 'Staked or held to power Solana operations. Back in about a day when unstaked.';
  }
  if (sym === 'ETH' || sym === 'WETH' || sym === 'STETH' || sym === 'WSTETH') {
    return 'Staked or held to secure Ethereum. Back in about a day when unstaked.';
  }
  if (sym === 'NAVE') {
    return 'Held. The protocol token — no role in this treasury’s day-to-day unless a decision says so.';
  }
  return 'Held in the treasury. Can be sent or allocated when a community decision approves it.';
}

function KvRow({
  label,
  value,
  valueColor,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  valueColor?: string;
  mono?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4"
      style={{
        padding: '11px 0',
        borderBottom: '1px solid hsl(var(--surface-2))',
        fontSize: '13.5px',
      }}
    >
      <span style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
      <b
        className={mono ? 'nave-mono' : undefined}
        style={{
          fontWeight: 600,
          color: valueColor ?? 'hsl(var(--foreground))',
          textAlign: 'right',
        }}
      >
        {value}
      </b>
    </div>
  );
}

/* ── Earning place detail modal ─────────────────────────────── */
function EarningPlaceModal({
  strategy,
  totalValueUsd,
  daoAddress,
  isMockMode,
  onClose,
  onUpdated,
}: {
  strategy: StrategyInfo;
  totalValueUsd: number;
  daoAddress: string;
  isMockMode: boolean;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const meta = describeVenue(strategy);
  const { chainKind, evmChainId, chainFamily } = useChain();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const tx = useSendTransaction();

  const [showMoveForm, setShowMoveForm] = useState(false);
  const [direction, setDirection] = useState<'withdraw' | 'deposit'>('withdraw');
  const [amount, setAmount] = useState(
    String(Math.min(1000, Math.max(1, Math.round(strategy.currentValueUsd)))),
  );
  const [busy, setBusy] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const sharePct =
    totalValueUsd > 0 ? Math.round((strategy.currentValueUsd / totalValueUsd) * 100) : Math.round(strategy.allocation);

  async function handleConfirmMove(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      setErr('Enter an amount greater than zero.');
      return;
    }

    setBusy(true);
    try {
      if (isMockMode || direction === 'deposit' || chainKind !== 'evm') {
        setErr(
          direction === 'deposit' || chainKind !== 'evm'
            ? 'Placing or withdrawing here has to be a real transaction. Propose it under Decisions.'
            : 'Demo mode does not send a transaction.',
        );
        return;
      }

      if (!evmChainId || !evmAddress) {
        setErr('Connect your wallet to withdraw to Available.');
        return;
      }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio?.execution) {
        setErr('Execution contract is not available on this network.');
        return;
      }
      const amountBase = parseUnits(String(num), 6);
      const minOut = resolveEvmMinOut(evmChainId as EvmChainId, amountBase);
      const built = buildWithdrawFromStrategyEvm(evmChainId, trio.execution, 0, amountBase, minOut);
      const direct = await tx.sendEvm(built, {
        successLabel: `Withdrawn from ${meta.place}`,
        quietToast: true,
      });
      if (direct.status === 'success' || direct.status === 'mock') {
        setDoneMsg(`Withdrew $${num.toLocaleString()} from ${meta.place} to Available.`);
        onUpdated();
        return;
      }

      const { data, error } = await withdrawStrategyViaProxyEvm(
        daoAddress,
        evmAddress,
        (m) => signMessageAsync({ message: m }),
        {
          chainId: evmChainId,
          chain: chainFamily === 'solana' ? 'base' : chainFamily,
          executionAddress: trio.execution,
          index: 0,
          amount: amountBase.toString(),
          minOut: minOut.toString(),
        },
      );
      if (error || !data?.success) {
        setErr(error || direct.error || 'Could not withdraw from this place right now.');
        return;
      }
      setDoneMsg(`Withdrew $${num.toLocaleString()} from ${meta.place} to Available.`);
      onUpdated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not complete move.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <NaveModal open title={meta.place} subtitle={meta.what} onClose={onClose} maxWidth={480}>
      <div style={{ padding: '18px 22px 22px' }}>
        {doneMsg ? (
          <div className="text-center py-4 space-y-3">
            <div
              className="mx-auto grid place-items-center rounded-full"
              style={{
                width: '38px',
                height: '38px',
                backgroundColor: '#EAF5EE',
                color: 'hsl(var(--success))',
                fontWeight: 700,
              }}
            >
              ✓
            </div>
            <h4
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '21px',
                fontWeight: 400,
                margin: 0,
                color: 'hsl(var(--foreground))',
              }}
            >
              Move complete
            </h4>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
              {doneMsg}
            </p>
            <div className="pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-[9px] font-semibold"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <KvRow label="Placed" value={`${USD(strategy.currentValueUsd)} · ${sharePct}%`} mono />
            <KvRow
              label="Rate"
              value={strategy.apy != null ? `${strategy.apy.toFixed(1)}%/yr` : '—'}
              valueColor="hsl(var(--success))"
              mono
            />
            <KvRow label="Earned so far" value={USD(strategy.earnedUsd)} mono />
            <KvRow label="Get it back" value={meta.exit} />

            <p
              style={{
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
                lineHeight: 1.65,
                margin: '14px 0 0',
              }}
            >
              {meta.risk}
            </p>

            {showMoveForm && (
              <form
                onSubmit={(e) => void handleConfirmMove(e)}
                className="mt-4 pt-4 space-y-3"
                style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: 'hsl(var(--foreground))',
                        marginBottom: '6px',
                        display: 'block',
                      }}
                    >
                      Direction
                    </label>
                    <NaveSelect
                      value={direction}
                      onChange={(e) => setDirection(e.target.value as 'withdraw' | 'deposit')}
                      style={{
                        width: '100%',
                        fontSize: '13.5px',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        border: '1px solid hsl(var(--border))',
                        backgroundColor: '#ffffff',
                        color: 'hsl(var(--foreground))',
                      }}
                    >
                      <option value="withdraw">Withdraw to Available</option>
                      <option value="deposit">Move in (from Available)</option>
                    </NaveSelect>
                  </div>
                  <div>
                    <label
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: 'hsl(var(--foreground))',
                        marginBottom: '6px',
                        display: 'block',
                      }}
                    >
                      Amount (USD)
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                      style={{
                        width: '100%',
                        fontSize: '13.5px',
                        fontFamily: 'var(--font-mono)',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        border: '1px solid hsl(var(--border))',
                        backgroundColor: '#ffffff',
                        color: 'hsl(var(--foreground))',
                      }}
                    />
                  </div>
                </div>
                {err && (
                  <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', margin: 0 }}>{err}</p>
                )}
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-2 rounded-[9px] font-semibold transition-all"
                    style={{
                      fontSize: '13px',
                      backgroundColor: 'hsl(var(--foreground))',
                      color: '#ffffff',
                      opacity: busy ? 0.5 : 1,
                    }}
                  >
                    {busy ? 'Moving…' : 'Confirm move'}
                  </button>
                </div>
              </form>
            )}

            <div
              className="flex items-center justify-end gap-2"
              style={{
                marginTop: '18px',
                paddingTop: '14px',
                borderTop: '1px solid hsl(var(--surface-2))',
              }}
            >
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-[9px] font-semibold"
                style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
              >
                Close
              </button>
              {!showMoveForm && (
                <button
                  type="button"
                  onClick={() => setShowMoveForm(true)}
                  className="px-4 py-2 rounded-[9px] font-semibold"
                  style={{
                    fontSize: '13px',
                    backgroundColor: 'hsl(var(--foreground))',
                    color: '#ffffff',
                  }}
                >
                  Move money
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </NaveModal>
  );
}

/* ── Holding detail modal ───────────────────────────────────── */
function HoldingDetailModal({
  asset,
  isHidden,
  canManage,
  daoAddress,
  onClose,
  onAddFunds,
  onProposePayment,
  onToggleHide,
  onEnabled,
}: {
  asset: TreasuryAssetRow;
  isHidden: boolean;
  canManage: boolean;
  daoAddress: string;
  onClose: () => void;
  onAddFunds: (asset: TreasuryAssetRow) => void;
  onProposePayment: () => void;
  onToggleHide: (asset: TreasuryAssetRow, currentlyHidden: boolean) => void;
  onEnabled: () => void;
}) {
  const { chainKind } = useChain();
  const { publicKey } = useWallet();
  const tx = useSendTransaction();
  const [copied, setCopied] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [enableErr, setEnableErr] = useState<string | null>(null);

  const solanaPlan =
    chainKind === 'solana' && !asset.onChainRegistered && asset.mint !== 'SOL'
      ? getSolanaRegisterAssetPlan(asset.mint, asset.symbol, asset.name)
      : null;
  const canOneClickEnable = canManage && !!publicKey && solanaPlan?.mode === 'ready';

  function copyAddress() {
    navigator.clipboard.writeText(asset.mint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function handleOneClickEnable() {
    if (!publicKey || !solanaPlan || solanaPlan.mode !== 'ready') return;
    setEnableErr(null);
    setEnabling(true);
    try {
      const dao = new PublicKey(daoAddress);
      const mint = new PublicKey(asset.mint);
      const r = await buildRegisterAsset(
        dao,
        publicKey,
        mint,
        solanaPlan.pythFeedHex,
        solanaPlan.isStablecoin,
        solanaPlan.assetKind,
      );
      const out = await tx.send(r, { successLabel: `${asset.symbol} enabled` });
      if (out.status === 'success' || out.status === 'mock') {
        onEnabled();
        onClose();
      } else {
        setEnableErr(
          describeTransactionError(out.error, {
            programHint: 'core',
            fallback: 'Could not enable token',
          }),
        );
      }
    } catch (e) {
      setEnableErr(e instanceof Error ? e.message : 'Could not enable token');
    } finally {
      setEnabling(false);
    }
  }

  const shareStr = `${asset.allocationPct.toFixed(asset.allocationPct % 1 === 0 ? 0 : 1)}%`;

  return (
    <NaveModal
      open
      title={`${asset.symbol} · ${asset.name}`}
      subtitle="Holding detail"
      onClose={onClose}
      maxWidth={480}
    >
      <div style={{ padding: '18px 22px 22px' }}>
        <KvRow
          label="Balance"
          value={`${asset.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${asset.symbol}`}
          mono
        />
        <KvRow label="Value · share" value={`${USD_EXACT(asset.valueUsd)} · ${shareStr}`} mono />

        <p
          style={{
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.65,
            margin: '14px 0 0',
          }}
        >
          {describeHoldingJob(asset)}
        </p>

        {/* Quiet utility links: Copy address + Hide/Unhide + 1-click Enable if ready */}
        <div className="flex items-center gap-3 flex-wrap mt-3">
          {asset.mint !== 'SOL' && asset.mint !== 'ETH' && (
            <button
              type="button"
              onClick={copyAddress}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{
                fontSize: '12.5px',
                color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))',
              }}
            >
              {copied ? 'Copied ✓' : 'Copy address'}
            </button>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => {
                onToggleHide(asset, isHidden);
                onClose();
              }}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
            >
              {isHidden ? 'Unhide token' : 'Hide token'}
            </button>
          )}
          {canOneClickEnable && (
            <button
              type="button"
              onClick={() => void handleOneClickEnable()}
              disabled={enabling}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--brass))' }}
            >
              {enabling ? 'Enabling…' : 'Enable token'}
            </button>
          )}
        </div>

        {enableErr && (
          <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', marginTop: '8px' }}>
            {enableErr}
          </p>
        )}

        <div
          className="flex items-center justify-end gap-2 flex-wrap"
          style={{
            marginTop: '18px',
            paddingTop: '14px',
            borderTop: '1px solid hsl(var(--surface-2))',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 rounded-[9px] font-semibold"
            style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
          >
            Close
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onAddFunds(asset);
              }}
              className="px-3.5 py-2 rounded-[9px] border font-semibold"
              style={{
                fontSize: '13px',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            >
              Add funds
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onClose();
              onProposePayment();
            }}
            className="px-4 py-2 rounded-[9px] font-semibold"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
            }}
          >
            Propose a payment
          </button>
        </div>
      </div>
    </NaveModal>
  );
}

/* ── NFT row (only rendered when nfts.length > 0) ──────────── */
function NftRow({
  nft,
  canManage,
  onSendNft,
}: {
  nft: TreasuryNft;
  canManage: boolean;
  onSendNft: (nft: TreasuryNft) => void;
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
          className="w-10 h-10 rounded-[10px] overflow-hidden flex items-center justify-center flex-shrink-0 border"
          style={{
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--muted-foreground))',
          }}
        >
          {nft.image ? (
            <img src={nft.image} alt={nft.name} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <Fi icon="image" style={{ fontSize: 15 }} />
          )}
        </div>
        <div className="min-w-0">
          <div
            className="truncate"
            style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}
          >
            {nft.name}
          </div>
          <div className="nave-mono truncate" style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
            {nft.mint.slice(0, 6)}…{nft.mint.slice(-4)}
          </div>
        </div>
      </div>

      {canManage && !nft.compressed && (
        <button
          type="button"
          onClick={() => onSendNft(nft)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] border font-semibold transition-colors"
          style={{
            fontSize: '12.5px',
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
        >
          Propose transfer →
        </button>
      )}
    </div>
  );
}

/* ── Assets (Money) page ────────────────────────────────────── */
export default function Assets() {
  const navigate = useNavigate();
  const { daoAddress, isMockMode } = useDaoContext();
  const daoRegistry = useDaoRegistry(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const { constitution } = useConstitution(daoAddress);
  const treasury = useTreasuryData(daoAddress);
  const { publicKey, signMessage } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { chainKind } = useChain();

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

  const { nfts, refetch: refetchNfts } = useTreasuryNfts(daoAddress);

  const [depositAsset, setDepositAsset] = useState<TreasuryAssetRow | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [initialNftMint, setInitialNftMint] = useState<string | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyInfo | null>(null);
  const [selectedHolding, setSelectedHolding] = useState<{
    asset: TreasuryAssetRow;
    hidden: boolean;
  } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [refreshStamp, setRefreshStamp] = useState('Updated just now');

  const canManage =
    !!daoAddress && (isMockMode || (chainKind === 'evm' ? !!evmAddress : !!publicKey));
  const votingMint = tokenRegistry.tokens[0]?.mint ?? null;

  const strategies: StrategyInfo[] = useMemo(() => {
    if (treasury.strategies.length > 0) return treasury.strategies;
    if (isMockMode) return MOCK_FALLBACK_STRATEGIES;
    return [];
  }, [treasury.strategies, isMockMode]);

  const holdingsSumUsd = useMemo(
    () => visibleAssets.reduce((sum, a) => sum + a.valueUsd, 0),
    [visibleAssets],
  );

  const totalValueUsd =
    onchainNavUsd != null && onchainNavUsd > 0
      ? onchainNavUsd
      : holdingsSumUsd > 0
        ? holdingsSumUsd
        : treasury.currentValue;

  const earningUsd = useMemo(() => {
    const stratSum = strategies.reduce((sum, s) => sum + s.currentValueUsd, 0);
    if (stratSum > 0) return stratSum;
    return deployedUsd ?? 0;
  }, [strategies, deployedUsd]);

  const blendedRate = useMemo(
    () => blendedApy(strategies.map((s) => ({ value: s.currentValueUsd, apy: s.apy }))),
    [strategies],
  );

  const reserveFloorPct = useMemo(() => {
    const bps = constitution?.minStablecoinReserveBps ?? constitution?.minReservesBps ?? 3000;
    return Math.round(bps / 100);
  }, [constitution]);

  const safeAvailableUsd = Math.max(0, totalValueUsd - earningUsd);
  const reserveTargetUsd = totalValueUsd * (reserveFloorPct / 100);
  const freeToSpendUsd = Math.max(0, safeAvailableUsd - reserveTargetUsd);

  async function handleToggleHide(asset: TreasuryAssetRow, currentlyHidden: boolean) {
    if (!canManage) return;
    const wallet = chainKind === 'evm' ? evmAddress : publicKey?.toBase58();
    if (!wallet) return;
    const signChallenge =
      chainKind === 'evm'
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
    const write = currentlyHidden ? unhideAsset : hideAsset;
    const { error: hErr } = await write(asset.mint, wallet, signChallenge);
    if (hErr) {
      toast({
        variant: 'destructive',
        title: currentlyHidden ? 'Could not unhide token' : 'Could not hide token',
        description: hErr,
      });
    } else {
      toast({
        title: currentlyHidden ? 'Token restored' : 'Token hidden',
        description: currentlyHidden
          ? `${asset.symbol} is visible in Holdings again.`
          : `${asset.symbol} moved to hidden tokens.`,
      });
    }
  }

  function handleRefreshHoldings() {
    refetch();
    treasury.refetch();
    refetchNfts();
    const now = new Date();
    setRefreshStamp(
      `Updated ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    );
  }

  function openWithdrawFlow(nftMint?: string) {
    if (daoAddress) {
      setInitialNftMint(nftMint ?? null);
      setShowWithdrawModal(true);
    } else {
      navigate('/overview', {
        state: { openCreateTx: true, ...(nftMint ? { nftTransfer: { mint: nftMint } } : {}) },
      });
    }
  }

  const earningCaption =
    strategies.length > 0
      ? `${strategies.length} approved ${strategies.length === 1 ? 'place' : 'places'}${blendedRate != null ? `, ${blendedRate.toFixed(1)}% blended.` : '.'}`
      : undefined;

  return (
    <div className="animate-fade-in" data-onboarding-id="assets-root">
      {(showDeposit || depositAsset) && daoAddress && (
        <DepositFlowModal
          daoAddress={daoAddress}
          daoName={daoRegistry.dao?.name}
          registeredAssets={assets}
          preselectedAsset={depositAsset ?? undefined}
          initialTab="wallet"
          onClose={() => {
            setShowDeposit(false);
            setDepositAsset(null);
          }}
          onDeposited={() => {
            refetch();
            treasury.refetch();
          }}
        />
      )}

      {showWithdrawModal && daoAddress && (
        <CreateTransactionModal
          daoAddress={daoAddress}
          proposalCount={
            typeof daoRegistry.dao?.nextProposalIndex === 'number'
              ? daoRegistry.dao.nextProposalIndex
              : (daoRegistry.dao?.proposalCount ?? 0) + (daoRegistry.dao?.archivedProposalCount ?? 0)
          }
          governanceType={daoRegistry.dao?.governanceType ?? 'wallet'}
          votingMint={votingMint}
          assets={assets}
          nfts={nfts}
          initialNftMint={initialNftMint}
          onClose={() => {
            setShowWithdrawModal(false);
            setInitialNftMint(null);
          }}
          onCreated={() => {
            refetch();
            treasury.refetch();
          }}
        />
      )}

      {selectedStrategy && daoAddress && (
        <EarningPlaceModal
          strategy={selectedStrategy}
          totalValueUsd={totalValueUsd}
          daoAddress={daoAddress}
          isMockMode={isMockMode}
          onClose={() => setSelectedStrategy(null)}
          onUpdated={() => {
            refetch();
            treasury.refetch();
          }}
        />
      )}

      {selectedHolding && daoAddress && (
        <HoldingDetailModal
          asset={selectedHolding.asset}
          isHidden={selectedHolding.hidden}
          canManage={canManage}
          daoAddress={daoAddress}
          onClose={() => setSelectedHolding(null)}
          onAddFunds={(asset) => {
            if (chainKind === 'evm' && asset.mint === 'ETH') {
              setDepositAsset(null);
              setShowDeposit(true);
              return;
            }
            setDepositAsset(asset);
          }}
          onProposePayment={() => openWithdrawFlow()}
          onToggleHide={(asset, hidden) => void handleToggleHide(asset, hidden)}
          onEnabled={refetch}
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
        </div>

        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button
            type="button"
            onClick={() => openWithdrawFlow()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] border font-semibold transition-colors"
            style={{
              fontSize: '13px',
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          >
            Withdraw
          </button>
          <button
            type="button"
            onClick={() => {
              if (!daoAddress) {
                navigate('/treasuries');
                return;
              }
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
            Add funds
          </button>
        </div>
      </div>

      {/* 3 Calm Stats Strip */}
      <Section>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5" data-onboarding-id="assets-stats">
          <MetricCard
            label="Safe & available"
            value={USD(safeAvailableUsd)}
          />
          <MetricCard
            label="Earning"
            value={USD(earningUsd)}
            sub={earningCaption}
          />
          <MetricCard
            label="Free to spend"
            value={USD(freeToSpendUsd)}
          />
        </div>
      </Section>

      {/* Earning places section */}
        <Section title="Earning places">
        <div className="overflow-x-auto">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {(['Place', 'What it does', 'Amount', 'Rate', 'Earned'] as const).map((h, i) => (
                  <th
                    key={h}
                    style={{
                      fontSize: '11px',
                      fontWeight: 500,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'hsl(var(--faint))',
                      textAlign: i >= 2 ? 'right' : 'left',
                      fontFamily: i >= 2 ? 'var(--font-mono)' : 'var(--font-body)',
                      padding: i === 4 ? '8px 0' : '8px 10px 8px 0',
                      borderBottom: '1px solid hsl(var(--border))',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {strategies.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    style={{
                      padding: '16px 0',
                      fontSize: '13.5px',
                      color: 'hsl(var(--muted-foreground))',
                    }}
                  >
                    No Automations
                  </td>
                </tr>
              ) : (
                strategies.map((s, idx) => {
                  const meta = describeVenue(s);
                  const isLast = idx === strategies.length - 1;
                  const cellBorder = isLast ? 'none' : '1px solid hsl(var(--surface-2))';
                  return (
                    <tr
                      key={`${s.protocol}-${idx}`}
                      onClick={() => setSelectedStrategy(s)}
                      className="cursor-pointer group"
                    >
                      <td
                        className="group-hover:text-brass transition-colors"
                        style={{
                          fontSize: '13.5px',
                          fontWeight: 600,
                          padding: '12px 10px 12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--foreground))',
                        }}
                      >
                        {meta.place}
                      </td>
                      <td
                        style={{
                          fontSize: '13.5px',
                          padding: '12px 10px 12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--muted-foreground))',
                        }}
                      >
                        {meta.what}
                      </td>
                      <td
                        className="nave-mono"
                        style={{
                          fontSize: '12.5px',
                          textAlign: 'right',
                          padding: '12px 10px 12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--foreground))',
                        }}
                      >
                        {USD(s.currentValueUsd)}
                      </td>
                      <td
                        className="nave-mono"
                        style={{
                          fontSize: '12.5px',
                          textAlign: 'right',
                          padding: '12px 10px 12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--foreground))',
                        }}
                      >
                        {s.apy != null ? `${s.apy.toFixed(1)}%/yr` : '—'}
                      </td>
                      <td
                        className="nave-mono"
                        style={{
                          fontSize: '12.5px',
                          textAlign: 'right',
                          padding: '12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--foreground))',
                        }}
                      >
                        {USD(s.earnedUsd)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Holdings section */}
      <Section
        title="Holdings"
        action={
          <div className="flex items-center gap-3">
            <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
              {refreshStamp}
            </span>
            <button
              type="button"
              onClick={handleRefreshHoldings}
              disabled={loading}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
              }}
            >
              {loading ? 'Updating…' : 'Refresh'}
            </button>
          </div>
        }
      >
        {loading && visibleAssets.length === 0 && (
          <div className="space-y-3 pt-2">
            <CardSkeleton lines={3} />
          </div>
        )}

        {!loading && error && (
          <Notice tone="red">
            <strong style={{ fontWeight: 600 }}>Could not load holdings</strong>{' '}
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>— {error}</span>
          </Notice>
        )}

        {!loading && !error && visibleAssets.length === 0 && (
          <NaveEmptyState
            icon="coins"
            title="No holdings yet"
            description="Add funds from your wallet or send tokens to your treasury address to get started."
          />
        )}

        {visibleAssets.length > 0 && (
          <div className="overflow-x-auto">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {(['Asset', 'Balance', 'Value', 'Share'] as const).map((h, i) => (
                    <th
                      key={h}
                      style={{
                        fontSize: '11px',
                        fontWeight: 500,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: 'hsl(var(--faint))',
                        textAlign: i === 0 ? 'left' : 'right',
                        fontFamily: i === 0 ? 'var(--font-body)' : 'var(--font-mono)',
                        padding: i === 3 ? '8px 0' : '8px 10px 8px 0',
                        borderBottom: '1px solid hsl(var(--border))',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleAssets.map((a, idx) => {
                  const isLast = idx === visibleAssets.length - 1;
                  const cellBorder = isLast ? 'none' : '1px solid hsl(var(--surface-2))';
                  return (
                    <tr
                      key={a.mint}
                      onClick={() => setSelectedHolding({ asset: a, hidden: false })}
                      className="cursor-pointer group"
                    >
                      <td
                        className="group-hover:text-brass transition-colors"
                        style={{
                          fontSize: '13.5px',
                          padding: '12px 10px 12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--foreground))',
                        }}
                      >
                        <b style={{ fontWeight: 600 }}>{a.symbol}</b>{' '}
                        <span style={{ color: 'hsl(var(--muted-foreground))' }}>· {a.name}</span>
                      </td>
                      <td
                        className="nave-mono"
                        style={{
                          fontSize: '12.5px',
                          textAlign: 'right',
                          padding: '12px 10px 12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--foreground))',
                        }}
                      >
                        {a.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </td>
                      <td
                        className="nave-mono"
                        style={{
                          fontSize: '12.5px',
                          textAlign: 'right',
                          padding: '12px 10px 12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--foreground))',
                        }}
                      >
                        {USD(a.valueUsd)}
                      </td>
                      <td
                        className="nave-mono"
                        style={{
                          fontSize: '12.5px',
                          textAlign: 'right',
                          padding: '12px 0',
                          borderBottom: cellBorder,
                          color: 'hsl(var(--muted-foreground))',
                        }}
                      >
                        {a.allocationPct.toFixed(a.allocationPct % 1 === 0 ? 0 : 1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Quiet Hidden tokens toggle — only rendered when hiddenAssets.length > 0 */}
        {hiddenAssets.length > 0 && (
          <div style={{ marginTop: '14px' }}>
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
            >
              {showHidden
                ? `Hide hidden tokens (${hiddenAssets.length})`
                : `Hidden tokens (${hiddenAssets.length})`}
            </button>

            {showHidden && (
              <div className="mt-3 pt-2" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
                {hiddenAssets.map((a) => (
                  <div
                    key={a.mint}
                    onClick={() => setSelectedHolding({ asset: a, hidden: true })}
                    className="flex items-center justify-between py-2.5 cursor-pointer group"
                    style={{
                      borderBottom: '1px solid hsl(var(--surface-2))',
                      fontSize: '13px',
                    }}
                  >
                    <span className="group-hover:text-brass transition-colors">
                      <b style={{ fontWeight: 600 }}>{a.symbol}</b>{' '}
                      <span style={{ color: 'hsl(var(--muted-foreground))' }}>· {a.name}</span>
                    </span>
                    <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                      {a.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* NFTs section — only rendered when nfts.length > 0 */}
      {nfts.length > 0 && (
        <Section title="NFTs" hint={`${nfts.length} held`}>
          <div>
            {nfts.map((n) => (
              <NftRow
                key={n.id}
                nft={n}
                canManage={canManage}
                onSendNft={(nft) => openWithdrawFlow(nft.mint)}
              />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
