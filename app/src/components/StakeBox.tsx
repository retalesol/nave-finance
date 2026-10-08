// ─── StakeBox — compact staking card for the unified Bridge & Stake page ─────
// Stake NAVE on Solana (central reward pool funded by the bridge's staking fee
// leg) or wNAVE on Ethereum/Base/Robinhood (mirror pools). Rendered beside the
// bridge form.

import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import Fi from './Fi';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import ChainIcon from './ChainIcon';
import ConnectNetworkButton from './ConnectNetworkButton';
import OdometerNumber from './OdometerNumber';
import { useStaking } from '../hooks/useStaking';
import { chainFamilyLabel } from '../lib/chain/types';
import { NAVE_DECIMALS } from '../lib/programConfig';
import type { StakePoolStats } from '../lib/staking/solanaStakingProgram';

function formatNave(raw: bigint): string {
  const s = formatUnits(raw, NAVE_DECIMALS);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Percent display for the live APY — em-dash when the drip is inactive. */
function formatApy(apy: number | null): string {
  if (apy === null || !Number.isFinite(apy)) return '—';
  if (apy > 0 && apy < 0.01) return '<0.01%';
  return `${apy.toFixed(2)}%`;
}

export default function StakeBox({ pool, apy }: { pool: StakePoolStats | null; apy: number | null }) {
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();

  const {
    chain,
    chainFamily,
    enabled,
    staked,
    pending,
    pendingRatePerSec,
    lastSyncedAt,
    accruingFromSolana,
    amount,
    setAmount,
    amountRaw,
    isBusy,
    stake,
    unstake,
    claim,
  } = useStaking();

  const isSolana = chain === 'solana';
  const connected = isSolana ? !!publicKey : !!evmAddress;
  const tokenLabel = isSolana ? 'NAVE' : 'wNAVE';
  // Show the live counter whenever we have a synced pending value OR a positive
  // accrual rate (EVM share-of-Solana projection starts at 0 and ticks up).
  const showPendingCounter = pending != null || pendingRatePerSec > 0;
  const claimDisabled =
    isBusy ||
    (!accruingFromSolana && pending != null && pending <= 0n && pendingRatePerSec <= 0);

  return (
    <div
      className="rounded-xl border p-5 space-y-5 h-fit"
      style={{ backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))' }}
    >
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-display font-semibold" style={{ fontSize: 17, color: 'hsl(var(--foreground))' }}>
              Stake
            </span>
            <Badge variant="outline" className="flex items-center gap-1" style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
              <ChainIcon family={chainFamily} size={12} />
              {chainFamilyLabel(chainFamily)}
            </Badge>
          </div>
          <Fi icon="layer-group" style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))' }} />
        </div>
        <p style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', marginTop: 4, lineHeight: 1.55 }}>
          Stake {tokenLabel} to earn a pro-rata share of every bridge fee. Rewards accrue
          continuously and are claimable any time.
        </p>
      </div>

      {!enabled ? (
        <div
          className="rounded-lg p-3.5"
          style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
        >
          <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>
            Staking is not configured for this {isSolana ? 'Solana' : 'EVM'} deployment yet.
          </p>
        </div>
      ) : (
        <>
          {/* Live APY.
              This is a SINGLE protocol-wide number (passed in from
              useBridgeStats): the central Solana reward pool's annual emission
              divided by the TOTAL NAVE staked across Solana + Ethereum + Base.
              EVM staking is just a weighted claim on the one Solana reward
              pool, so the APY is identical on every chain — do NOT reintroduce
              a per-chain drip-rate calculation here. */}
          <div
            className="rounded-lg p-3.5 flex items-center justify-between"
            style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
          >
            <div className="flex items-center gap-1.5">
              <Fi icon="chart-line-up" style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }} />
              <span style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>Est. APY</span>
            </div>
            <span
              className="text-display"
              style={{ fontSize: 18, lineHeight: 1.1, fontWeight: 600, color: 'hsl(var(--foreground))' }}
            >
              {formatApy(apy)}
            </span>
          </div>

          {/* Your position */}
          <div
            className="rounded-lg p-3.5 space-y-2"
            style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
          >
            <div className="flex items-center justify-between">
              <span style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>Your stake</span>
              <span style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>
                {staked != null ? `${formatNave(staked)} ${tokenLabel}` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>Claimable rewards</span>
              {showPendingCounter ? (
                <OdometerNumber
                  value={pending ?? 0n}
                  ratePerSec={pendingRatePerSec}
                  lastSyncedAt={lastSyncedAt}
                  suffix={` ${tokenLabel}`}
                />
              ) : (
                <span style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                  —
                </span>
              )}
            </div>
            {accruingFromSolana && (
              <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', lineHeight: 1.45, marginTop: 2 }}>
                Accruing your share of the Solana reward pool. Claiming wraps your rewards and
                delivers them as {tokenLabel} on {chainFamilyLabel(chainFamily)}.
              </p>
            )}
            {isSolana && pool && (
              <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                <span style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>Pool total staked</span>
                <span style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>
                  {formatNave(pool.totalStaked)} NAVE
                </span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={`Amount of ${tokenLabel}`}
              inputMode="decimal"
              aria-label={`Amount of ${tokenLabel} to stake or unstake`}
              autoComplete="off"
              style={{ fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            />
            {!connected ? (
              <ConnectNetworkButton
                fullWidth
                menuAlign="left"
                label="Connect wallet to stake"
                icon={<Fi icon="wallet" style={{ fontSize: 12 }} />}
                className="w-full flex items-center justify-center gap-2"
                style={{
                  backgroundColor: 'hsl(var(--surface-1))',
                  color: 'hsl(var(--foreground))',
                  border: '1px solid hsl(var(--border-strong))',
                  borderRadius: 'var(--radius)',
                  padding: '8px 16px',
                  fontSize: 13,
                  fontWeight: 500,
                }}
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    onClick={() => void stake()}
                    disabled={isBusy || amountRaw <= 0n}
                    style={{ backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                  >
                    {isBusy ? 'Working…' : 'Stake'}
                  </Button>
                  <Button
                    onClick={() => void unstake()}
                    disabled={isBusy || amountRaw <= 0n}
                    style={{ backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border-strong))' }}
                  >
                    {isBusy ? 'Working…' : 'Unstake'}
                  </Button>
                </div>
                <Button
                  className="w-full"
                  onClick={() => void claim()}
                  disabled={claimDisabled}
                  style={{ backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border-strong))' }}
                >
                  {isBusy ? 'Working…' : 'Claim rewards'}
                </Button>
              </>
            )}
          </div>

          <p style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            {isSolana
              ? 'Fees accrue to a central pool on Solana, and rewards are paid out in NAVE.'
              : `Fees accrue to a central pool on Solana. When you claim on ${chainFamilyLabel(chainFamily)}, the protocol wraps the NAVE reward and pays you ${tokenLabel} on this chain.`}
          </p>
        </>
      )}
    </div>
  );
}
