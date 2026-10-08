// ─── useBridgeStats — aggregate bridge + staking stats and wallet history ─────
// Reads the public bridge_transfers table (RLS read-only) for protocol-wide
// bridge stats and the connected wallet's transfer history, plus the central
// Solana staking pool totals. Powers the unified Bridge & Stake page.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { createPublicClient, http, type PublicClient } from 'viem';
import { supabase } from '../lib/supabaseClient';
import {
  ACTIVE_EVM_CHAIN_IDS,
  EVM_DEPLOYMENT_MODE,
  EVM_RPC_URLS,
  EVM_STAKING_ADDRESSES,
  EVM_WRAPPED_NAVE_ADDRESSES,
  NAVE_STAKING_PROGRAM_ID,
} from '../lib/programConfig';
import { wrappedNaveAbi } from '../lib/bridge/wrappedNaveAbi';
import { fetchNaveUsdPrice } from '../lib/pricing/navePrice';
import { fetchStakeClaimReserve } from '../lib/staking/stakeClaimClient';
import { toAddress } from '../lib/evm/addresses';
import { WAGMI_CHAIN_BY_ID } from '../lib/evm/wagmi';
import { evmTarget, isEvmChainId, type EvmChainId } from '../lib/chain/types';
import type { ActivityEntry } from '../lib/staking/activityFeed';
import { naveStakingAbi } from '../lib/staking/naveStakingAbi';
import {
  computeStakingApy,
  readStakePoolStats,
  RATE_SCALE,
  SECONDS_PER_YEAR,
  type StakePoolStats,
} from '../lib/staking/solanaStakingProgram';

/** Every active EVM chain that has a staking (mirror) contract configured. */
function evmStakingChains(): EvmChainId[] {
  return ACTIVE_EVM_CHAIN_IDS.filter((id) => Boolean(EVM_STAKING_ADDRESSES[id]));
}

/** A read-only viem client for a specific EVM chain (dedicated RPC when set). */
function evmClientForChain(chainId: EvmChainId): PublicClient {
  const chain = WAGMI_CHAIN_BY_ID[chainId];
  const rpc = EVM_RPC_URLS[chainId];
  return createPublicClient({ chain, transport: rpc ? http(rpc) : http() });
}

export interface BridgeStats {
  /** Total transfers ever recorded (any status). */
  transferCount: number;
  /** Completed transfers. */
  completedCount: number;
  /**
   * Cumulative bridge VOLUME: sum of net amounts across every completed
   * transfer over all history (base units). This is turnover, not what is
   * currently on other chains — see `wrappedOutstandingRaw` for that.
   */
  totalBridgedRaw: bigint;
  /** Sum of fees across completed transfers (base units). */
  totalFeesRaw: bigint;
}

export interface BridgeHistoryRow {
  id: string;
  direction: string;
  sourceChain: string;
  destChain: string;
  sourceTx: string;
  destTx: string | null;
  amountRaw: bigint;
  netRaw: bigint | null;
  feeRaw: bigint | null;
  status: string;
  createdAt: string;
}

interface RawTransferRow {
  id: string;
  direction: string;
  source_chain: string;
  dest_chain: string;
  source_tx: string;
  dest_tx: string | null;
  amount_raw: string | number;
  net_raw: string | number | null;
  fee_raw: string | number | null;
  status: string;
  created_at: string;
}

function toBig(v: string | number | null | undefined): bigint | null {
  if (v == null) return null;
  try {
    return BigInt(String(v).split('.')[0]);
  } catch {
    return null;
  }
}

interface RawStakeEventRow {
  id: string;
  kind: string;
  source_chain_id: string | number | null;
  source_tx: string;
  wrap_tx: string | null;
  dest_tx: string | null;
  staker: string;
  amount_raw: string | number;
  status: string;
  error: string | null;
  created_at: string;
}

/** Map a bridge_stake_events row into the shared activity-feed shape. */
function stakeEventToActivity(row: RawStakeEventRow): ActivityEntry | null {
  const chainId = row.source_chain_id != null ? Number(row.source_chain_id) : null;
  const family = chainId !== null && isEvmChainId(chainId) ? evmTarget(chainId).family : null;
  if (!family) return null;
  if (row.kind === 'stake' || row.kind === 'unstake') {
    return {
      id: row.id,
      kind: row.kind,
      chainFamily: family,
      chainId: chainId!,
      wallet: row.staker,
      amountRaw: String(row.amount_raw),
      tx: row.source_tx,
      status: 'completed',
      createdAt: row.created_at,
    };
  }
  if (row.kind === 'reward_claim') {
    // New rows carry a synthetic source_tx and the real Solana wrap in
    // wrap_tx; rows written before staged statuses used source_tx for the
    // wrap sig directly.
    const legacyWrap = row.source_tx.startsWith('stake-claim:') ? null : row.source_tx;
    return {
      id: row.id,
      kind: 'claim',
      chainFamily: family,
      chainId: chainId!,
      wallet: row.staker,
      amountRaw: String(row.amount_raw),
      tx: row.dest_tx ?? undefined,
      wrapTx: row.wrap_tx ?? legacyWrap ?? undefined,
      claimId: row.id,
      status: row.status,
      error: row.error ?? undefined,
      createdAt: row.created_at,
    };
  }
  return null;
}

export interface UseBridgeStatsResult {
  stats: BridgeStats | null;
  pool: StakePoolStats | null;
  /** Total wNAVE staked across ALL EVM mirror pools (base units), or null. */
  evmStakedRaw: bigint | null;
  /** Per-EVM-chain staked wNAVE (base units) for the 4-chain breakdown. */
  evmStakedByChain: Partial<Record<EvmChainId, bigint>>;
  /**
   * wNAVE currently OUTSTANDING across all EVM chains (base units): the sum
   * of each chain's WrappedNave totalSupply, i.e. all mints minus all burns.
   * This is what "Total bridged" means — NAVE actively living on other chains.
   */
  wrappedOutstandingRaw: bigint | null;
  /** Per-chain outstanding wNAVE supply for the breakdown rows. */
  wrappedByChain: Partial<Record<EvmChainId, bigint>>;
  /**
   * Relayer-owned Solana reward reserve that EVM claims pay out of (base
   * units), or null when unavailable. Reward pool tile = vault + this.
   */
  rewardReserveRaw: bigint | null;
  /** NAVE/USD spot price (CoinGecko id nave-shares), or null when unavailable. */
  naveUsdPrice: number | null;
  /**
   * Single protocol-wide staking APY in percent, or null when the reward drip
   * is inactive. Rewards live in ONE central pool (the Solana reward vault);
   * EVM staking just represents weighted contribution to that pool. So the APY
   * is GLOBAL — the Solana reward pool's annual emission divided by the total
   * NAVE staked across Solana + Ethereum + Base (the true TVL) — and is shown
   * identically on every chain (no per-chain variance).
   */
  apy: number | null;
  history: BridgeHistoryRow[];
  /** Stake / unstake / claim rows for the connected EVM wallet (DB-derived). */
  activity: ActivityEntry[];
  /** True while the first load is in flight. */
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useBridgeStats(): UseBridgeStatsResult {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const stakingChains = useMemo(() => evmStakingChains(), []);

  const [stats, setStats] = useState<BridgeStats | null>(null);
  const [pool, setPool] = useState<StakePoolStats | null>(null);
  const [evmStakedRaw, setEvmStakedRaw] = useState<bigint | null>(null);
  const [evmStakedByChain, setEvmStakedByChain] = useState<Partial<Record<EvmChainId, bigint>>>({});
  const [wrappedOutstandingRaw, setWrappedOutstandingRaw] = useState<bigint | null>(null);
  const [wrappedByChain, setWrappedByChain] = useState<Partial<Record<EvmChainId, bigint>>>({});
  const [rewardReserveRaw, setRewardReserveRaw] = useState<bigint | null>(null);
  const [naveUsdPrice, setNaveUsdPrice] = useState<number | null>(null);
  const [apy, setApy] = useState<number | null>(null);
  const [history, setHistory] = useState<BridgeHistoryRow[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const solAddr = publicKey?.toBase58() ?? null;
  const evmAddr = evmAddress?.toLowerCase() ?? null;

  const refresh = useCallback(async () => {
    // Family names ('ethereum'/'base') collide across clusters — always scope
    // to the deployment network so mainnet never shows testnet volume/history.
    const network = EVM_DEPLOYMENT_MODE === 'mainnet' ? 'mainnet' : EVM_DEPLOYMENT_MODE === 'mixed' ? 'mixed' : 'testnet';

    // ── Protocol-wide stats (network-scoped; reduce client-side) ─────────────
    const statsPromise = supabase
      .from('bridge_transfers')
      .select('status, net_raw, fee_raw, amount_raw', { count: 'exact' })
      .eq('network', network)
      .limit(1000)
      .then(({ data, count }) => {
        if (!data) return null;
        let totalBridged = 0n;
        let totalFees = 0n;
        let completed = 0;
        for (const row of data as Pick<RawTransferRow, 'status' | 'net_raw' | 'fee_raw' | 'amount_raw'>[]) {
          if (row.status !== 'completed') continue;
          completed += 1;
          totalBridged += toBig(row.net_raw) ?? toBig(row.amount_raw) ?? 0n;
          totalFees += toBig(row.fee_raw) ?? 0n;
        }
        return {
          transferCount: count ?? data.length,
          completedCount: completed,
          totalBridgedRaw: totalBridged,
          totalFeesRaw: totalFees,
        } satisfies BridgeStats;
      });

    // ── Connected wallet history (sender OR recipient on either chain) ───────
    const orClauses: string[] = [];
    if (solAddr) orClauses.push(`sender.eq.${solAddr}`, `recipient.eq.${solAddr}`);
    if (evmAddr) orClauses.push(`sender.ilike.${evmAddr}`, `recipient.ilike.${evmAddr}`);
    const historyPromise = orClauses.length
      ? supabase
          .from('bridge_transfers')
          .select('id, direction, source_chain, dest_chain, source_tx, dest_tx, amount_raw, net_raw, fee_raw, status, created_at')
          .eq('network', network)
          .or(orClauses.join(','))
          .order('created_at', { ascending: false })
          .limit(15)
          .then(({ data }) =>
            ((data ?? []) as RawTransferRow[]).map((row) => ({
              id: row.id,
              direction: row.direction,
              sourceChain: row.source_chain,
              destChain: row.dest_chain,
              sourceTx: row.source_tx,
              destTx: row.dest_tx,
              amountRaw: toBig(row.amount_raw) ?? 0n,
              netRaw: toBig(row.net_raw),
              feeRaw: toBig(row.fee_raw),
              status: row.status,
              createdAt: row.created_at,
            })),
          )
      : Promise.resolve([] as BridgeHistoryRow[]);

    // ── Stake / unstake / claim rows for the connected EVM wallet ────────────
    // (bridge_stake_events is public-read; Solana stake actions are recorded
    // locally by useStaking and merged in the feed component.)
    const activityPromise: PromiseLike<ActivityEntry[]> = evmAddr
      ? supabase
          .from('bridge_stake_events')
          .select('id, kind, source_chain_id, source_tx, wrap_tx, dest_tx, staker, amount_raw, status, error, created_at')
          .eq('network', network)
          .eq('staker', evmAddr)
          .in('kind', ['stake', 'unstake', 'reward_claim'])
          .order('created_at', { ascending: false })
          .limit(15)
          .then(({ data }) =>
            ((data ?? []) as RawStakeEventRow[])
              .map(stakeEventToActivity)
              .filter((e): e is ActivityEntry => e !== null),
          )
      : Promise.resolve([]);

    // ── Central Solana staking pool ──────────────────────────────────────────
    const poolPromise = NAVE_STAKING_PROGRAM_ID
      ? readStakePoolStats(connection, NAVE_STAKING_PROGRAM_ID).catch(() => null)
      : Promise.resolve(null);

    // ── Total wNAVE staked across EVERY EVM mirror pool (for the global TVL) ──
    // Read each active EVM staking contract's `totalStaked` on its own dedicated
    // RPC. A single missing/failed chain contributes 0 (not null) so the global
    // TVL is a lower bound rather than collapsing to unknown. Kept per-chain for
    // the "Total staked" tile's 4-chain breakdown.
    const evmStakedPromise: Promise<Partial<Record<EvmChainId, bigint>> | null> =
      stakingChains.length === 0
        ? Promise.resolve(null)
        : Promise.all(
            stakingChains.map(async (chainId) => {
              const addr = toAddress(EVM_STAKING_ADDRESSES[chainId]);
              if (!addr) return [chainId, 0n] as const;
              const v = await evmClientForChain(chainId)
                .readContract({ address: addr, abi: naveStakingAbi, functionName: 'totalStaked' })
                .then((x) => x as bigint)
                .catch(() => 0n);
              return [chainId, v] as const;
            }),
          ).then((entries) => Object.fromEntries(entries) as Partial<Record<EvmChainId, bigint>>);

    // ── wNAVE OUTSTANDING per chain (mints − burns = ERC-20 totalSupply) ──────
    // This is what "Total bridged" means: NAVE actively living on other chains.
    // Burns bridge value back to Solana and reduce the supply automatically.
    const wrappedChains = ACTIVE_EVM_CHAIN_IDS.filter((id) => Boolean(EVM_WRAPPED_NAVE_ADDRESSES[id]));
    const wrappedPromise: Promise<Partial<Record<EvmChainId, bigint>> | null> =
      wrappedChains.length === 0
        ? Promise.resolve(null)
        : Promise.all(
            wrappedChains.map(async (chainId) => {
              const addr = toAddress(EVM_WRAPPED_NAVE_ADDRESSES[chainId]);
              if (!addr) return [chainId, 0n] as const;
              const v = await evmClientForChain(chainId)
                .readContract({ address: addr, abi: wrappedNaveAbi, functionName: 'totalSupply' })
                .then((x) => x as bigint)
                .catch(() => 0n);
              return [chainId, v] as const;
            }),
          ).then((entries) => Object.fromEntries(entries) as Partial<Record<EvmChainId, bigint>>);

    const [nextStats, nextHistory, nextActivity, nextPool, nextEvmStakedMap, nextWrappedMap, nextReserve, nextPrice] =
      await Promise.all([
        statsPromise,
        historyPromise,
        activityPromise,
        poolPromise,
        evmStakedPromise,
        wrappedPromise,
        fetchStakeClaimReserve(),
        fetchNaveUsdPrice(),
      ]);
    setStats(nextStats);
    setHistory(nextHistory);
    setActivity(nextActivity);
    setPool(nextPool);
    const nextEvmStaked =
      nextEvmStakedMap === null
        ? null
        : Object.values(nextEvmStakedMap).reduce((sum, v) => sum + (v ?? 0n), 0n);
    setEvmStakedRaw(nextEvmStaked);
    setEvmStakedByChain(nextEvmStakedMap ?? {});
    setWrappedOutstandingRaw(
      nextWrappedMap === null
        ? null
        : Object.values(nextWrappedMap).reduce((sum, v) => sum + (v ?? 0n), 0n),
    );
    setWrappedByChain(nextWrappedMap ?? {});
    setRewardReserveRaw(nextReserve);
    setNaveUsdPrice(nextPrice);

    // ── Single, protocol-wide APY (shown identically on all chains) ──────────
    // Rewards live in ONE central pool (the Solana reward vault). EVM staking is
    // just a weighted claim on that pool, so the APY is GLOBAL: the Solana
    // reward pool's annualized drip emission divided by the TOTAL NAVE staked
    // across Solana + Ethereum + Base (the true TVL). This is the same number
    // regardless of which chain the user is viewing — there is deliberately no
    // per-chain APY variance.
    const globalStakedRaw = (nextPool?.totalStaked ?? 0n) + (nextEvmStaked ?? 0n);
    setApy(
      nextPool
        ? computeStakingApy({
            annualEmissionRaw: (nextPool.rewardRatePerSec * SECONDS_PER_YEAR) / RATE_SCALE,
            totalStakedRaw: globalStakedRaw,
            periodFinish: nextPool.periodFinish,
          })
        : null,
    );
    setLoading(false);
  }, [connection, solAddr, evmAddr, stakingChains]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return {
    stats,
    pool,
    evmStakedRaw,
    evmStakedByChain,
    wrappedOutstandingRaw,
    wrappedByChain,
    rewardReserveRaw,
    naveUsdPrice,
    apy,
    history,
    activity,
    loading,
    refresh,
  };
}
