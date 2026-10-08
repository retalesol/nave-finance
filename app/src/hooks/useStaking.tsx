// ─── useStaking — cross-chain NAVE / wNAVE staking controller ────────────────
// Stake NAVE on Solana (the central reward pool that receives the bridge's 1%
// staking fee) or wNAVE on Base/ETH (the mirror pool the relayer funds with
// wrapped rewards). Exposes the connected chain's position + stake/unstake/claim
// actions using the app's unified transaction dispatcher.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useAccount, usePublicClient } from 'wagmi';
import { createPublicClient, http, parseUnits } from 'viem';
import { toast } from './use-toast';
import { useSendTransaction } from './useSendTransaction';
import { useChain } from './useChain';
import { supabase } from '../lib/supabaseClient';
import { removeActivity, upsertActivity, type ActivityEntry } from '../lib/staking/activityFeed';
import {
  ACTIVE_EVM_CHAIN_IDS,
  EVM_RPC_URLS,
  EVM_STAKING_ADDRESSES,
  EVM_WRAPPED_NAVE_ADDRESSES,
  NAVE_DECIMALS,
  NAVE_STAKING_PROGRAM_ID,
  SOLANA_NAVE_MINT,
} from '../lib/programConfig';
import { toAddress } from '../lib/evm/addresses';
import { WAGMI_CHAIN_BY_ID, wagmiConfig } from '../lib/evm/wagmi';
import { signMessage } from '@wagmi/core';
import { fetchStakeClaimPending, submitStakeClaim } from '../lib/staking/stakeClaimClient';
import { isEvmChainId, evmTarget, type ChainFamily, type EvmChainId } from '../lib/chain/types';
import {
  buildStakeInstruction,
  buildUnstakeInstruction,
  buildClaimInstruction,
  computeStakingApy,
  readStakingPosition,
  readStakePoolStats,
  RATE_SCALE,
  SECONDS_PER_YEAR,
} from '../lib/staking/solanaStakingProgram';
import { naveStakingAbi } from '../lib/staking/naveStakingAbi';
import { wrappedNaveAbi } from '../lib/bridge/wrappedNaveAbi';
import { clearAccrual, foldAccrual } from '../lib/staking/accrualMemory';

export type StakingChain = 'solana' | 'evm';

export interface UseStakingResult {
  chain: StakingChain;
  /** Active chain family for display (Solana / Ethereum / Base / Robinhood). */
  chainFamily: ChainFamily;
  /** Whether staking is configured for the active chain. */
  enabled: boolean;
  /** Staked principal (base units). */
  staked: bigint | null;
  /** Claimable reward (base units) — on-chain pending, or 0 while accruing from the Solana share. */
  pending: bigint | null;
  /** Base units accrued per second for the connected user (odometer extrapolation). */
  pendingRatePerSec: number;
  /** Timestamp (ms) when `pending` was last synced from chain. */
  lastSyncedAt: number;
  /**
   * True when the live counter is projecting the user's share of the Solana
   * reward vault because this EVM chain's local drip window is empty. Claim
   * still pays from this chain once the staking mirror delivers wNAVE.
   */
  accruingFromSolana: boolean;
  /** Annualized staking APY (percent) for the active chain, or null when the drip is inactive. */
  apy: number | null;
  /** Amount input (human string). */
  amount: string;
  setAmount: (v: string) => void;
  amountRaw: bigint;
  isBusy: boolean;
  stake: () => Promise<void>;
  unstake: () => Promise<void>;
  claim: () => Promise<void>;
  refresh: () => Promise<void>;
}

function parseAmountRaw(amount: string): bigint {
  const t = amount.trim();
  if (!t) return 0n;
  try {
    return parseUnits(t, NAVE_DECIMALS);
  } catch {
    return 0n;
  }
}

/** First active EVM chain that has a staking contract configured. */
function firstEvmStakingChain(): EvmChainId | null {
  for (const id of ACTIVE_EVM_CHAIN_IDS) {
    if (EVM_STAKING_ADDRESSES[id]) return id;
  }
  return null;
}

const STAKING_REFRESH_MS = 18_000;
/** How often the in-flight claim polls its DB row for phase updates. */
const CLAIM_POLL_MS = 2_500;

function newLocalId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function userShareRate(totalStaked: bigint, userStaked: bigint, poolRatePerSec: number): number {
  if (totalStaked <= 0n || userStaked <= 0n || poolRatePerSec <= 0) return 0;
  const share = Number(userStaked) / Number(totalStaked);
  if (!Number.isFinite(share)) return 0;
  return poolRatePerSec * share;
}

export function useStaking(): UseStakingResult {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { address: evmAddress, chainId: connectedChainId } = useAccount();
  const { target, evmChainId: selectedEvmChainId } = useChain();
  const tx = useSendTransaction();

  // Follow the Bridge page network selector — not whichever wallet happens to be
  // connected. Users often keep Phantom (Solana) and MetaMask (EVM) connected at
  // the same time; the active family must drive which pool we read/write.
  const chain: StakingChain = target.kind === 'evm' ? 'evm' : 'solana';

  const evmChainId = useMemo((): EvmChainId | null => {
    // Prefer the network the user selected in the wallet/Bridge switcher so the
    // StakeBox tracks the same chain as the Bridge form — not whichever EVM
    // wallet chain happens to be connected (users often leave MetaMask on
    // Sepolia while viewing Base/Robinhood).
    if (selectedEvmChainId && EVM_STAKING_ADDRESSES[selectedEvmChainId]) {
      return selectedEvmChainId;
    }
    if (connectedChainId && isEvmChainId(connectedChainId) && EVM_STAKING_ADDRESSES[connectedChainId]) {
      return connectedChainId;
    }
    return firstEvmStakingChain();
  }, [connectedChainId, selectedEvmChainId]);

  const chainFamily: ChainFamily =
    chain === 'solana'
      ? 'solana'
      : evmChainId
        ? evmTarget(evmChainId).family
        : target.family;

  const publicClient = usePublicClient({ chainId: evmChainId ?? undefined });

  const [amount, setAmount] = useState('');
  const [staked, setStaked] = useState<bigint | null>(null);
  const [pending, setPending] = useState<bigint | null>(null);
  const [pendingRatePerSec, setPendingRatePerSec] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState(() => Date.now());
  const [accruingFromSolana, setAccruingFromSolana] = useState(false);
  const [apy, setApy] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const amountRaw = useMemo(() => parseAmountRaw(amount), [amount]);

  const enabled =
    chain === 'solana'
      ? !!NAVE_STAKING_PROGRAM_ID
      : evmChainId !== null && !!EVM_STAKING_ADDRESSES[evmChainId];

  const stakingAddress = useMemo(
    () => (evmChainId !== null ? toAddress(EVM_STAKING_ADDRESSES[evmChainId]) : null),
    [evmChainId],
  );
  const wrappedAddress = useMemo(
    () => (evmChainId !== null ? toAddress(EVM_WRAPPED_NAVE_ADDRESSES[evmChainId]) : null),
    [evmChainId],
  );

  // Monotonic sequence guard: only the LATEST refresh may apply state. Without
  // it, an 18s interval poll that started BEFORE a claim settled could resolve
  // AFTER the post-claim refresh and clobber the fresh (post-settle) pending
  // with the stale pre-claim value — making rewards look claimable again.
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const fresh = () => seq === refreshSeqRef.current;
    const syncedAt = Date.now();
    try {
      if (chain === 'solana') {
        if (!NAVE_STAKING_PROGRAM_ID) {
          setStaked(null);
          setPending(null);
          setPendingRatePerSec(0);
          setLastSyncedAt(syncedAt);
          setAccruingFromSolana(false);
          setApy(null);
          return;
        }
        // Pool-level APY works without a wallet; the position needs one.
        const [poolStats, pos] = await Promise.all([
          readStakePoolStats(connection, NAVE_STAKING_PROGRAM_ID).catch(() => null),
          publicKey
            ? readStakingPosition(connection, NAVE_STAKING_PROGRAM_ID, publicKey)
            : Promise.resolve(null),
        ]);
        if (!fresh()) return;
        setStaked(pos?.staked ?? null);
        setPending(pos?.pending ?? null);
        setPendingRatePerSec(
          poolStats && pos && poolStats.totalStaked > 0n && pos.staked > 0n
            ? userShareRate(poolStats.totalStaked, pos.staked, poolStats.rewardRatePerSecFloat)
            : 0,
        );
        setLastSyncedAt(syncedAt);
        setAccruingFromSolana(false);
        setApy(
          poolStats
            ? computeStakingApy({
                annualEmissionRaw: (poolStats.rewardRatePerSec * SECONDS_PER_YEAR) / RATE_SCALE,
                totalStakedRaw: poolStats.totalStaked,
                periodFinish: poolStats.periodFinish,
              })
            : null,
        );
      } else {
        if (!publicClient || !stakingAddress) {
          setStaked(null);
          setPending(null);
          setPendingRatePerSec(0);
          setLastSyncedAt(syncedAt);
          setAccruingFromSolana(false);
          setApy(null);
          return;
        }
        const readPool = (functionName: 'totalStaked' | 'rewardRate' | 'periodFinish') =>
          publicClient
            .readContract({ address: stakingAddress, abi: naveStakingAbi, functionName })
            .then((v) => v as bigint)
            // Pre-drip deployment (getter absent) — treat as inactive.
            .catch(() => null);

        // Global-parity accrual: EVM stakers earn a pro-rata share of the ONE
        // Solana reward pool. The relayer keeps the authoritative accrual in a
        // server-side ledger and mints wNAVE straight to the staker at claim
        // time (claim-on-demand) — prefer that ledger for the counter; fall
        // back to a locally-persisted projection when the relayer is
        // unreachable.
        const serverPendingPromise =
          evmAddress && evmChainId
            ? fetchStakeClaimPending(evmChainId, evmAddress)
            : Promise.resolve(null);
        const solanaPoolPromise = NAVE_STAKING_PROGRAM_ID
          ? readStakePoolStats(connection, NAVE_STAKING_PROGRAM_ID).catch(() => null)
          : Promise.resolve(null);
        const otherEvmStakedPromise = Promise.all(
          ACTIVE_EVM_CHAIN_IDS.filter((id) => id !== evmChainId && EVM_STAKING_ADDRESSES[id]).map(async (id) => {
            const addr = toAddress(EVM_STAKING_ADDRESSES[id]);
            if (!addr) return 0n;
            try {
              const rpc = EVM_RPC_URLS[id];
              const client = createPublicClient({
                chain: WAGMI_CHAIN_BY_ID[id],
                transport: rpc ? http(rpc) : http(),
              });
              return (await client.readContract({
                address: addr,
                abi: naveStakingAbi,
                functionName: 'totalStaked',
              })) as bigint;
            } catch {
              return 0n;
            }
          }),
        ).then((amounts) => amounts.reduce((sum, v) => sum + v, 0n));

        const [info, pend, totalStakedRaw, rewardRate, periodFinish, solanaPool, otherEvmStaked, serverPending] =
          await Promise.all([
            evmAddress
              ? publicClient.readContract({ address: stakingAddress, abi: naveStakingAbi, functionName: 'users', args: [evmAddress] })
              : Promise.resolve(null),
            evmAddress
              ? publicClient.readContract({ address: stakingAddress, abi: naveStakingAbi, functionName: 'pendingReward', args: [evmAddress] })
              : Promise.resolve(null),
            readPool('totalStaked'),
            readPool('rewardRate'),
            readPool('periodFinish'),
            solanaPoolPromise,
            otherEvmStakedPromise,
            serverPendingPromise,
          ]);
        if (!fresh()) return;
        const userStaked = info !== null ? (info as [bigint, bigint, bigint])[0] : null;
        const onChainPending = pend !== null ? (pend as bigint) : null;
        setStaked(userStaked);

        const localRate =
          totalStakedRaw !== null && rewardRate !== null && userStaked !== null && totalStakedRaw > 0n && userStaked > 0n
            ? userShareRate(totalStakedRaw, userStaked, Number(rewardRate))
            : 0;

        // Prefer the live local drip when the mirror has funded this chain;
        // otherwise fall back to the user's share of the Solana vault emission
        // over global TVL (Solana + every EVM mirror).
        let shareRate = localRate;
        let fromSolana = false;
        const solanaDripActive =
          solanaPool != null &&
          solanaPool.rewardRatePerSecFloat > 0 &&
          solanaPool.periodFinish > BigInt(Math.floor(Date.now() / 1000));
        if (shareRate <= 0 && solanaDripActive && userStaked !== null && userStaked > 0n) {
          const globalStaked =
            solanaPool.totalStaked + (totalStakedRaw ?? 0n) + otherEvmStaked;
          shareRate = userShareRate(globalStaked, userStaked, solanaPool.rewardRatePerSecFloat);
          fromSolana = shareRate > 0;
        }

        if (serverPending) {
          // Authoritative path: server ledger claimable (+ any legacy local
          // drip inventory from earlier notifyReward deliveries). The server
          // record persists across refreshes and devices, so the localStorage
          // projection is no longer needed for this wallet.
          if (evmAddress && evmChainId) clearAccrual(evmChainId, evmAddress);
          const localInventory = onChainPending && onChainPending > 0n ? onChainPending : 0n;
          setPending(serverPending.claimableRaw + localInventory);
          setPendingRatePerSec(serverPending.ratePerSecFloat + localRate);
          setAccruingFromSolana(serverPending.claimableRaw > 0n || serverPending.ratePerSecFloat > 0);
        } else if (fromSolana && evmAddress && evmChainId && userStaked !== null && userStaked > 0n) {
          // Relayer unreachable — locally-persisted projection so refreshes
          // continue the counter instead of restarting from zero.
          const folded = foldAccrual(evmChainId, evmAddress, userStaked, shareRate, syncedAt);
          const base = onChainPending && onChainPending > 0n ? onChainPending : 0n;
          setPending(base + folded);
          setAccruingFromSolana(fromSolana);
        } else {
          // Not projecting: either the local drip is live (on-chain pending is
          // authoritative — the mirror delivery realizes the projected share)
          // or the user is unstaked. Either way drop the stored projection so
          // a stale rate can never resume or double-count later.
          if (evmAddress && evmChainId) {
            clearAccrual(evmChainId, evmAddress);
          }
          setPending(onChainPending);
          setAccruingFromSolana(fromSolana);
        }
        if (!serverPending) setPendingRatePerSec(shareRate);
        setLastSyncedAt(syncedAt);

        // Protocol-wide APY (same number on every chain): Solana vault emission
        // over global TVL. Falls back to the local drip when Solana is unread.
        const globalStakedForApy =
          (solanaPool?.totalStaked ?? 0n) + (totalStakedRaw ?? 0n) + otherEvmStaked;
        setApy(
          solanaPool
            ? computeStakingApy({
                annualEmissionRaw: (solanaPool.rewardRatePerSec * SECONDS_PER_YEAR) / RATE_SCALE,
                totalStakedRaw: globalStakedForApy > 0n ? globalStakedForApy : solanaPool.totalStaked,
                periodFinish: solanaPool.periodFinish,
              })
            : totalStakedRaw !== null && rewardRate !== null && periodFinish !== null
              ? computeStakingApy({
                  annualEmissionRaw: rewardRate * SECONDS_PER_YEAR,
                  totalStakedRaw,
                  periodFinish,
                })
              : null,
        );
      }
    } catch {
      if (!fresh()) return;
      setStaked(null);
      setPending(null);
      setPendingRatePerSec(0);
      setLastSyncedAt(syncedAt);
      setAccruingFromSolana(false);
      setApy(null);
    }
  }, [chain, publicKey, connection, publicClient, evmAddress, stakingAddress, evmChainId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => void refresh(), STAKING_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  /** Record a completed stake/unstake in the local activity feed ("Your
   *  Transactions") — Solana actions are never mirrored to the DB and EVM
   *  stake events lag the ~10-minute mirror, so this makes them show up
   *  immediately. Reconciled against DB rows by tx hash. */
  const recordAction = useCallback(
    (kind: 'stake' | 'unstake', txHash: string | null | undefined, raw: bigint) => {
      const wallet = chain === 'solana' ? publicKey?.toBase58() : evmAddress;
      if (!wallet) return;
      upsertActivity({
        id: newLocalId(),
        kind,
        chainFamily,
        chainId: chain === 'evm' ? (evmChainId ?? undefined) : undefined,
        wallet,
        amountRaw: raw.toString(),
        tx: txHash ?? undefined,
        status: 'completed',
        createdAt: new Date().toISOString(),
      });
    },
    [chain, chainFamily, publicKey, evmAddress, evmChainId],
  );

  const stake = useCallback(async () => {
    if (!enabled || amountRaw <= 0n) return;
    setIsBusy(true);
    try {
      if (chain === 'solana') {
        if (!publicKey || !NAVE_STAKING_PROGRAM_ID) return;
        const instruction = buildStakeInstruction(
          { programId: NAVE_STAKING_PROGRAM_ID, owner: publicKey, naveMint: SOLANA_NAVE_MINT },
          amountRaw,
        );
        const res = await tx.send({ instruction, programId: NAVE_STAKING_PROGRAM_ID }, { successLabel: 'Staked NAVE' });
        if (res.status === 'success') recordAction('stake', res.txHash, amountRaw);
      } else {
        if (!evmChainId || !stakingAddress || !wrappedAddress) return;
        // Approve, then stake (two txs — staking has no one-signature constraint).
        const approve = await tx.sendEvm(
          { request: { kind: 'evm', chainId: evmChainId, address: wrappedAddress, abi: wrappedNaveAbi, functionName: 'approve', args: [stakingAddress, amountRaw] } },
          { successLabel: 'Approved wNAVE' },
        );
        if (approve.status !== 'success') return;
        const res = await tx.sendEvm(
          { request: { kind: 'evm', chainId: evmChainId, address: stakingAddress, abi: naveStakingAbi, functionName: 'stake', args: [amountRaw] } },
          { successLabel: 'Staked wNAVE' },
        );
        if (res.status === 'success') recordAction('stake', res.txHash, amountRaw);
      }
      setAmount('');
      await refresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Stake failed', description: err instanceof Error ? err.message : 'Could not stake.' });
    } finally {
      setIsBusy(false);
    }
  }, [enabled, amountRaw, chain, publicKey, evmChainId, stakingAddress, wrappedAddress, tx, refresh, recordAction]);

  const unstake = useCallback(async () => {
    if (!enabled || amountRaw <= 0n) return;
    setIsBusy(true);
    try {
      if (chain === 'solana') {
        if (!publicKey || !NAVE_STAKING_PROGRAM_ID) return;
        const instruction = buildUnstakeInstruction(
          { programId: NAVE_STAKING_PROGRAM_ID, owner: publicKey, naveMint: SOLANA_NAVE_MINT },
          amountRaw,
        );
        const res = await tx.send({ instruction, programId: NAVE_STAKING_PROGRAM_ID }, { successLabel: 'Unstaked NAVE' });
        if (res.status === 'success') recordAction('unstake', res.txHash, amountRaw);
      } else {
        if (!evmChainId || !stakingAddress) return;
        const res = await tx.sendEvm(
          { request: { kind: 'evm', chainId: evmChainId, address: stakingAddress, abi: naveStakingAbi, functionName: 'unstake', args: [amountRaw] } },
          { successLabel: 'Unstaked wNAVE' },
        );
        if (res.status === 'success') recordAction('unstake', res.txHash, amountRaw);
      }
      setAmount('');
      await refresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Unstake failed', description: err instanceof Error ? err.message : 'Could not unstake.' });
    } finally {
      setIsBusy(false);
    }
  }, [enabled, amountRaw, chain, publicKey, evmChainId, stakingAddress, tx, refresh, recordAction]);

  const claim = useCallback(async () => {
    if (!enabled) return;
    setIsBusy(true);
    try {
      if (chain === 'solana') {
        if (!publicKey || !NAVE_STAKING_PROGRAM_ID) return;
        const claimedRaw = pending ?? 0n;
        const instruction = buildClaimInstruction({ programId: NAVE_STAKING_PROGRAM_ID, owner: publicKey, naveMint: SOLANA_NAVE_MINT });
        const res = await tx.send({ instruction, programId: NAVE_STAKING_PROGRAM_ID }, { successLabel: 'Claimed rewards' });
        if (res.status === 'success') {
          // Solana claims settle in one tx — record as immediately completed.
          upsertActivity({
            id: newLocalId(),
            kind: 'claim',
            chainFamily: 'solana',
            wallet: publicKey.toBase58(),
            amountRaw: claimedRaw > 0n ? claimedRaw.toString() : undefined,
            tx: res.txHash ?? undefined,
            status: 'completed',
            createdAt: new Date().toISOString(),
          });
        }
      } else {
        if (!evmChainId || !stakingAddress || !evmAddress) return;

        // Claim-on-demand: the relayer verifies a signature from THIS wallet,
        // folds the server-side accrual ledger, wraps the owed NAVE from the
        // Solana reward reserve, and mints wNAVE straight to the staker.
        //
        // Live progress: a local feed entry is written before the signature
        // prompt and, while the relayer works, its DB row (submitted →
        // wrapping → delivering → completed) is polled so "Your Transactions"
        // shows each phase in real time.
        const localId = newLocalId();
        const startedAtIso = new Date().toISOString();
        const baseEntry: ActivityEntry = {
          id: localId,
          kind: 'claim',
          chainFamily,
          chainId: evmChainId,
          wallet: evmAddress,
          amountRaw: pending && pending > 0n ? pending.toString() : undefined,
          status: 'signing',
          createdAt: startedAtIso,
        };
        upsertActivity(baseEntry);

        let latest: ActivityEntry = baseEntry;
        const poll = setInterval(() => {
          void (async () => {
            const { data } = await supabase
              .from('bridge_stake_events')
              .select('id, status, amount_raw, wrap_tx, dest_tx, error')
              .eq('kind', 'reward_claim')
              .eq('staker', evmAddress.toLowerCase())
              .eq('source_chain_id', evmChainId)
              .gte('created_at', startedAtIso)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (!data) return;
            latest = {
              ...latest,
              claimId: data.id as string,
              status: data.status as string,
              amountRaw: data.amount_raw != null ? String(data.amount_raw) : latest.amountRaw,
              wrapTx: (data.wrap_tx as string | null) ?? latest.wrapTx,
              tx: (data.dest_tx as string | null) ?? latest.tx,
              error: (data.error as string | null) ?? undefined,
            };
            upsertActivity(latest);
          })();
        }, CLAIM_POLL_MS);

        let outcome;
        try {
          outcome = await submitStakeClaim(evmChainId, evmAddress, async (message) => {
            const sig = await signMessage(wagmiConfig, { message });
            upsertActivity((latest = { ...latest, status: 'submitted' }));
            return sig;
          });
        } finally {
          clearInterval(poll);
        }

        if (outcome.status === 'completed') {
          clearAccrual(evmChainId, evmAddress);
          upsertActivity({
            ...latest,
            claimId: outcome.claimId ?? latest.claimId,
            status: 'completed',
            amountRaw: outcome.claimedRaw != null ? outcome.claimedRaw.toString() : latest.amountRaw,
            tx: outcome.mintTx ?? latest.tx,
            wrapTx: outcome.wrapTx ?? latest.wrapTx,
          });
          toast({
            title: 'Claimed wNAVE rewards',
            description: outcome.mintTx
              ? `${outcome.mintTx.slice(0, 10)}…${outcome.mintTx.slice(-8)}`
              : 'Rewards wrapped and delivered to your wallet.',
          });
        } else if (outcome.status === 'reserve_empty') {
          removeActivity(localId);
          toast({
            title: 'Rewards still settling',
            description:
              'Your accrued rewards are recorded, but the protocol reward reserve hasn\u2019t received enough bridge fees to pay out yet. Your balance keeps accruing — try again later.',
          });
        } else if (outcome.status === 'nothing_to_claim') {
          // No ledger balance — pay any legacy local drip inventory instead.
          let onChainClaimable: bigint | null = null;
          if (publicClient) {
            try {
              onChainClaimable = (await publicClient.readContract({
                address: stakingAddress,
                abi: naveStakingAbi,
                functionName: 'pendingReward',
                args: [evmAddress],
              })) as bigint;
            } catch {
              onChainClaimable = null;
            }
          }
          if (onChainClaimable !== null && onChainClaimable > 0n) {
            const res = await tx.sendEvm(
              { request: { kind: 'evm', chainId: evmChainId, address: stakingAddress, abi: naveStakingAbi, functionName: 'claim', args: [] } },
              { successLabel: 'Claimed wNAVE rewards' },
            );
            if (res.status === 'success') {
              upsertActivity({
                ...latest,
                status: 'completed',
                amountRaw: onChainClaimable.toString(),
                tx: res.txHash ?? latest.tx,
              });
            } else {
              removeActivity(localId);
            }
          } else {
            removeActivity(localId);
            toast({
              title: 'Nothing to claim yet',
              description: 'Rewards accrue continuously from the Solana reward pool while you stay staked.',
            });
          }
        } else {
          const rejected = /rejected|denied/i.test(outcome.error ?? '');
          if (rejected || !latest.claimId) {
            // Never reached the relayer (or the user dismissed the prompt) —
            // drop the placeholder instead of showing a scary failed row.
            removeActivity(localId);
          } else {
            upsertActivity({ ...latest, status: 'failed', error: outcome.error });
          }
          toast({
            variant: rejected ? undefined : 'destructive',
            title: rejected ? 'Claim cancelled' : 'Claim failed',
            description: rejected ? 'Signature request was dismissed.' : outcome.error ?? 'Could not claim rewards.',
          });
        }
      }
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not claim.';
      toast({ variant: 'destructive', title: 'Claim failed', description: msg });
    } finally {
      setIsBusy(false);
    }
  }, [enabled, chain, chainFamily, publicKey, evmChainId, evmAddress, stakingAddress, publicClient, pending, tx, refresh]);

  return {
    chain,
    chainFamily,
    enabled,
    staked,
    pending,
    pendingRatePerSec,
    lastSyncedAt,
    accruingFromSolana,
    apy,
    amount,
    setAmount,
    amountRaw,
    isBusy,
    stake,
    unstake,
    claim,
    refresh,
  };
}
