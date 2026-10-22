// ─── StakeBox — calm hairline staking view for the in-treasury Stake page ────
// Stake NAVE on Solana (central reward pool funded by the bridge's staking fee
// leg) or wNAVE on Ethereum/Base/Robinhood (mirror pools).

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import Fi from './Fi';
import ConnectNetworkButton from './ConnectNetworkButton';
import OdometerNumber from './OdometerNumber';
import { Stat, UnderlineTabs } from './calm';
import { useStaking } from '../hooks/useStaking';
import { useDaoContext } from '../hooks/useDaoContext';
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

type StakeActionTab = 'stake' | 'unstake';

const STAKE_TABS: readonly { id: StakeActionTab; label: string }[] = [
  { id: 'stake', label: 'Stake' },
  { id: 'unstake', label: 'Unstake' },
];

export default function StakeBox({ pool, apy }: { pool: StakePoolStats | null; apy: number | null }) {
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const { isMockMode } = useDaoContext();

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

  const [actionTab, setActionTab] = useState<StakeActionTab>('stake');
  const [mockDone, setMockDone] = useState<string | null>(null);

  const isSolana = chain === 'solana';
  const connected = isMockMode || (isSolana ? !!publicKey : !!evmAddress);
  const tokenLabel = isSolana ? 'NAVE' : 'wNAVE';
  const effectiveApy = apy ?? (isMockMode ? 6.2 : null);

  const showPendingCounter = pending != null || pendingRatePerSec > 0;
  const claimDisabled =
    isBusy ||
    (!isMockMode && !accruingFromSolana && pending != null && pending <= 0n && pendingRatePerSec <= 0);

  const amountNum = Number(amount) || 0;
  const estimatedAnnual =
    effectiveApy != null && amountNum > 0
      ? ((amountNum * effectiveApy) / 100).toLocaleString(undefined, { maximumFractionDigits: 3 })
      : '0';

  function handleMax() {
    if (actionTab === 'unstake' && staked && staked > 0n) {
      setAmount(formatNave(staked));
      return;
    }
    if (staked && staked > 0n) {
      setAmount(formatNave(staked));
    } else if (isMockMode) {
      setAmount('2500');
    }
  }

  function handlePrimarySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (amountRaw <= 0n || isBusy) return;
    if (isMockMode && (!enabled || !(isSolana ? !!publicKey : !!evmAddress))) {
      setMockDone(actionTab === 'stake' ? 'Staked' : 'Unstaked');
      return;
    }
    if (actionTab === 'stake') {
      void stake();
    } else {
      void unstake();
    }
  }

  function handleClaim() {
    if (isMockMode && (!enabled || !(isSolana ? !!publicKey : !!evmAddress))) {
      setMockDone('Rewards claimed');
      return;
    }
    void claim();
  }

  return (
    <div className="space-y-6">
      {/* 3 Calm Stats Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <Stat
          label={`Your staked ${tokenLabel}`}
          value={
            staked != null
              ? `${formatNave(staked)} ${tokenLabel}`
              : isMockMode
                ? `12,500 ${tokenLabel}`
                : `0 ${tokenLabel}`
          }
          caption={`On ${chainFamilyLabel(chainFamily)}${isSolana && pool ? ` · Pool ${formatNave(pool.totalStaked)} NAVE` : '.'}`}
        />

        <Stat
          label="Claimable rewards"
          value={
            showPendingCounter ? (
              <OdometerNumber
                value={pending ?? 0n}
                ratePerSec={pendingRatePerSec}
                lastSyncedAt={lastSyncedAt}
                suffix={` ${tokenLabel}`}
              />
            ) : isMockMode ? (
              `142.8 ${tokenLabel}`
            ) : (
              `0 ${tokenLabel}`
            )
          }
          caption={
            accruingFromSolana
              ? `Accruing from Solana pool, paid in ${tokenLabel}.`
              : 'Earned from protocol bridge fees.'
          }
        />

        <Stat
          label="Current APY"
          value={effectiveApy != null ? `${formatApy(effectiveApy)}/yr` : '—'}
          caption="Protocol-wide across all networks."
        />
      </div>

      {/* Staking Form Section */}
      <div
        style={{
          paddingTop: '26px',
          borderTop: '1px solid hsl(var(--surface-2))',
        }}
      >
        {!enabled && !isMockMode ? (
          <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
            Staking is not configured for this {isSolana ? 'Solana' : 'EVM'} deployment yet.
          </p>
        ) : (
          <form onSubmit={handlePrimarySubmit} className="space-y-4">
            <UnderlineTabs
              tabs={STAKE_TABS}
              activeTab={actionTab}
              onChange={(tab) => {
                setActionTab(tab);
                setMockDone(null);
              }}
            />

            <div className="pt-2">
              <div className="flex items-center justify-between" style={{ marginBottom: '7px' }}>
                <label
                  htmlFor="stake-amount"
                  style={{
                    fontSize: '12.5px',
                    fontWeight: 600,
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  Amount ({tokenLabel})
                </label>
                <button
                  type="button"
                  onClick={handleMax}
                  className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  Max
                </button>
              </div>

              <input
                id="stake-amount"
                value={amount}
                onChange={(e) => {
                  setMockDone(null);
                  setAmount(e.target.value);
                }}
                placeholder="0.0"
                inputMode="decimal"
                aria-label={`Amount of ${tokenLabel} to ${actionTab}`}
                autoComplete="off"
                style={{
                  width: '100%',
                  border: '1px solid hsl(var(--border))',
                  backgroundColor: '#ffffff',
                  borderRadius: '10px',
                  padding: '11px 13px',
                  fontSize: '14.5px',
                  fontFamily: 'var(--font-mono)',
                  color: 'hsl(var(--foreground))',
                  outline: 'none',
                }}
              />
            </div>

            {/* Live Estimate Notebox */}
            <div
              style={{
                backgroundColor: 'hsl(var(--background))',
                border: '1px solid hsl(var(--surface-2))',
                borderRadius: '12px',
                padding: '13px 14px',
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
                lineHeight: 1.6,
              }}
            >
              {actionTab === 'stake' ? (
                <>
                  Estimated earnings:{' '}
                  <b className="nave-mono" style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>
                    ≈ {estimatedAnnual} {tokenLabel} / year
                  </b>
                  . Unstake or claim any time. Your agents keep watching it like any other placement.
                </>
              ) : (
                <>
                  Unstaking returns{' '}
                  <b className="nave-mono" style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>
                    {amountNum > 0 ? amountNum.toLocaleString() : '0'} {tokenLabel}
                  </b>{' '}
                  directly to your wallet on {chainFamilyLabel(chainFamily)} with no lockup.
                </>
              )}
            </div>

            {mockDone && (
              <div
                className="text-center pt-4"
                style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
              >
                <div
                  className="mx-auto grid place-items-center rounded-full"
                  style={{
                    width: '40px',
                    height: '40px',
                    border: '1px solid #BFE0CC',
                    backgroundColor: '#F2F9F4',
                    color: 'hsl(var(--success))',
                    fontSize: '18px',
                    marginBottom: '10px',
                  }}
                >
                  ✓
                </div>
                <h4
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 400,
                    fontSize: '22px',
                    margin: '0 0 6px',
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  {mockDone}
                </h4>
                <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
                  Recorded in your staking activity below.
                </p>
              </div>
            )}

            {!connected ? (
              <ConnectNetworkButton
                fullWidth
                menuAlign="left"
                label="Connect wallet to stake"
                icon={<Fi icon="wallet" style={{ fontSize: 12 }} />}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-[9px] font-semibold"
                style={{
                  backgroundColor: '#ffffff',
                  color: 'hsl(var(--foreground))',
                  border: '1px solid hsl(var(--border))',
                  fontSize: '13px',
                }}
              />
            ) : (
              <div
                className="flex items-center justify-between gap-2 pt-4 flex-wrap"
                style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
              >
                <button
                  type="button"
                  onClick={handleClaim}
                  disabled={claimDisabled}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-[9px] border font-semibold transition-all"
                  style={{
                    fontSize: '13px',
                    backgroundColor: '#ffffff',
                    borderColor: 'hsl(var(--border))',
                    color: 'hsl(var(--foreground))',
                    opacity: claimDisabled ? 0.45 : 1,
                    cursor: claimDisabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isBusy ? 'Working…' : 'Claim rewards'}
                </button>

                <button
                  type="submit"
                  disabled={isBusy || amountRaw <= 0n}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                  style={{
                    fontSize: '13px',
                    backgroundColor: 'hsl(var(--foreground))',
                    color: '#ffffff',
                    border: '1px solid hsl(var(--foreground))',
                    opacity: isBusy || amountRaw <= 0n ? 0.4 : 1,
                    cursor: isBusy || amountRaw <= 0n ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isBusy
                    ? 'Working…'
                    : actionTab === 'stake'
                      ? `Stake ${tokenLabel} →`
                      : `Unstake ${tokenLabel} →`}
                </button>
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
