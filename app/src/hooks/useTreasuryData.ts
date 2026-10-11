import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { supabase, type TreasurySnapshotRow } from '../lib/supabaseClient';
import { isMockDaoAddress, MOCK_TREASURY_HISTORY, MOCK_STRATEGIES, MOCK_ASSETS, MOCK_ALLOCATION } from '../lib/mockData';
import { fetchConstitution, fetchStrategyPositionsForMints, fetchRegisteredAssets } from '../lib/onChainFetcher';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress, type EvmChainId } from '../lib/chain/types';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';
import { fetchStrategyPositionsEvm } from '../lib/evm/readers';
import { ACTIVE_EVM_CHAIN_IDS, isEvmChainConfigured } from '../lib/programConfig';
import { adapterKey, blendedApy, marksFromSnapshots, measuredApy, positionKey } from '../lib/positionYield';

function resolveEvmChainIdForDao(_daoAddress: string): EvmChainId | null {
  // Prefer a configured active chain; multi-chain DAOs store chain on the registry
  // but live position reads work against the first configured EVM chain that matches
  // the treasury (treasury address is chain-scoped via wagmi).
  for (const id of ACTIVE_EVM_CHAIN_IDS) {
    if (isEvmChainConfigured(id)) return id;
  }
  return null;
}

export interface TreasurySnapshot {
  totalValueUsd: number;
  solBalance: number;
  usdcBalance: number;
  strategyPositions: unknown[];
  tokenBalances: unknown[];
  snapshotAt: string;
}

export interface StrategyInfo {
  name: string;
  protocol: string;
  allocation: number;
  currentValueUsd: number;
  /** Marked value minus principal, in USD. */
  earnedUsd: number;
  /** Realized APY (percent) from snapshot marks; null until a day of marks exists. */
  apy: number | null;
}

export interface AssetInfo {
  name: string;
  symbol: string;
  balance: number;
  valueUsd: number;
  allocation: number;
}

interface UseTreasuryDataResult {
  history: TreasurySnapshot[];
  currentValue: number;
  strategies: StrategyInfo[];
  assets: AssetInfo[];
  allocation: Array<{ name: string; value: number; color: string }>;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface TreasuryDataQueryData {
  history: TreasurySnapshot[];
  strategies: StrategyInfo[];
  assets: AssetInfo[];
}

async function fetchTreasuryData(daoAddress: string): Promise<TreasuryDataQueryData> {
  // Fetch snapshot history (last 90 days)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);
  const { data: snapshots, error: snapError } = await supabase
    .from('treasury_snapshots')
    .select('*')
    .eq('dao_onchain_address', daoKey)
    .gte('snapshot_at', ninetyDaysAgo.toISOString())
    .order('snapshot_at', { ascending: true });

  if (snapError) {
    throw new Error(snapError.message);
  }

  const rows = (snapshots as TreasurySnapshotRow[]) || [];
  const history: TreasurySnapshot[] = rows.map((r) => ({
    totalValueUsd: Number(r.total_value_usd),
    solBalance: Number(r.sol_balance),
    usdcBalance: Number(r.usdc_balance),
    strategyPositions: r.strategy_positions || [],
    tokenBalances: r.token_balances || [],
    snapshotAt: r.snapshot_at,
  }));

  // Build asset list from the most recent snapshot
  const assets: AssetInfo[] = [];
  if (history.length > 0) {
    const latest = history[history.length - 1];

    if (latest.solBalance > 0) {
      assets.push({
        name: 'Solana',
        symbol: 'SOL',
        balance: latest.solBalance,
        valueUsd: latest.totalValueUsd - latest.usdcBalance,
        allocation: latest.totalValueUsd > 0
          ? ((latest.totalValueUsd - latest.usdcBalance) / latest.totalValueUsd) * 100
          : 0,
      });
    }

    if (latest.usdcBalance > 0) {
      assets.push({
        name: 'USD Coin',
        symbol: 'USDC',
        balance: latest.usdcBalance,
        valueUsd: latest.usdcBalance,
        allocation: latest.totalValueUsd > 0
          ? (latest.usdcBalance / latest.totalValueUsd) * 100
          : 0,
      });
    }
  }

  // Live strategy positions: Solana via program PDAs; EVM via NaveTreasury.position.
  let strategies: StrategyInfo[] = [];
  const marks = marksFromSnapshots(history);
  const evmMarks = marksFromSnapshots(history, adapterKey);
  const kind = chainKindFromAddress(daoAddress);
  if (isProgramConfigured() && kind === 'solana') {
    try {
      const daoPubkey = new PublicKey(daoAddress);
      const [constitution, registeredAssets] = await Promise.all([
        fetchConstitution(daoPubkey),
        fetchRegisteredAssets(daoPubkey),
      ]);
      const protocols = constitution?.approvedProtocols ?? [];
      const mints = registeredAssets.map((a) => new PublicKey(a.mint));

      const pairs = protocols.flatMap((p) =>
        mints.map((mint) => ({ protocol: p, mint })),
      );
      const positions = await fetchStrategyPositionsForMints(
        daoPubkey,
        pairs.map(({ protocol, mint }) => ({ protocolId: protocol.protocolId, mint })),
      );

      // USD per base unit: exact for stablecoins, else the last revalue's price
      // (revalue covers vault plus marked positions for the mint).
      const markedByMint = new Map<string, number>();
      positions.forEach((pos, i) => {
        const mint = pairs[i].mint.toBase58();
        if (pos) markedByMint.set(mint, (markedByMint.get(mint) ?? 0) + pos.currentValueUsd);
      });
      const usdPerUnit = new Map<string, number>();
      for (const a of registeredAssets) {
        if (a.isStablecoin) {
          usdPerUnit.set(a.mint, 1 / 10 ** a.decimals);
        } else {
          const units = a.vaultBalanceBaseUnits + (markedByMint.get(a.mint) ?? 0);
          usdPerUnit.set(a.mint, units > 0 ? a.lastValuedUsd / 1e6 / units : 0);
        }
      }

      const byProtocol = new Map<string, { valueUsd: number; earnedUsd: number; apyRows: Array<{ value: number; apy: number | null }> }>();
      positions.forEach((pos, i) => {
        if (!pos || pos.currentValueUsd <= 0) return;
        const protocolId = pairs[i].protocol.protocolId;
        const mint = pairs[i].mint.toBase58();
        const rate = usdPerUnit.get(mint) ?? 0;
        const valueUsd = pos.currentValueUsd * rate;
        const apy = measuredApy(marks.get(positionKey(protocolId, mint)) ?? [], {
          atSecs: Math.floor(Date.now() / 1000),
          deposited: pos.depositedAmount,
          current: pos.currentValueUsd,
        });
        const agg = byProtocol.get(protocolId) ?? { valueUsd: 0, earnedUsd: 0, apyRows: [] };
        agg.valueUsd += valueUsd;
        agg.earnedUsd += (pos.currentValueUsd - pos.depositedAmount) * rate;
        agg.apyRows.push({ value: valueUsd, apy });
        byProtocol.set(protocolId, agg);
      });
      const deployedTotal = Array.from(byProtocol.values()).reduce((sum, a) => sum + a.valueUsd, 0);

      strategies = Array.from(byProtocol.entries()).map(([protocolId, agg]) => ({
        name: protocolId,
        protocol: protocolId,
        allocation: deployedTotal > 0 ? (agg.valueUsd / deployedTotal) * 100 : 0,
        currentValueUsd: agg.valueUsd,
        earnedUsd: agg.earnedUsd,
        apy: blendedApy(agg.apyRows),
      }));
    } catch (stratErr) {
      console.warn('Failed to load live strategy positions:', stratErr);
      strategies = [];
    }
  } else if (kind === 'evm') {
    try {
      const chainId = resolveEvmChainIdForDao(daoAddress);
      if (chainId != null) {
        const positions = await fetchStrategyPositionsEvm(chainId, daoAddress);
        // currentValue is micro-USD on-chain.
        const deployedTotal = positions.reduce((sum, p) => sum + Number(p.currentValue) / 1e6, 0);
        strategies = positions.map((p) => {
          const valueUsd = Number(p.currentValue) / 1e6;
          return {
            name: p.adapter.slice(0, 10),
            protocol: p.adapter,
            allocation: deployedTotal > 0 ? (valueUsd / deployedTotal) * 100 : 0,
            currentValueUsd: valueUsd,
            earnedUsd: (Number(p.currentValue) - Number(p.depositedAmount)) / 1e6,
            apy: measuredApy(evmMarks.get(p.adapter.toLowerCase()) ?? [], {
              atSecs: Math.floor(Date.now() / 1000),
              deposited: Number(p.depositedAmount),
              current: Number(p.currentValue),
            }),
          };
        });
      }
    } catch (stratErr) {
      console.warn('Failed to load EVM strategy positions:', stratErr);
      strategies = [];
    }
  }

  return { history, strategies, assets };
}

/**
 * Treasury history/strategies/assets overview, backed by React Query so the
 * assets/dashboard pages share one cached fetch per DAO instead of each
 * mount re-issuing the Supabase + on-chain strategy-position reads.
 */
export function useTreasuryData(daoAddress: string | null): UseTreasuryDataResult {
  const isMock = isMockDaoAddress(daoAddress);

  const query = useQuery({
    queryKey: ['treasuryData', daoAddress],
    queryFn: () => fetchTreasuryData(daoAddress as string),
    enabled: !!daoAddress && !isMock,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  const history = query.data?.history ?? [];
  const strategies = query.data?.strategies ?? [];
  const assets = query.data?.assets ?? [];

  const currentValue =
    history.length > 0 ? history[history.length - 1].totalValueUsd : 0;

  const allocation = assets.map((a, i) => ({
    name: a.symbol,
    value: a.allocation,
    color: ['#6366f1', '#22c55e', '#f59e0b', '#ef4444'][i % 4],
  }));

  // Mock mode — return demo data
  if (isMock) {
    const mockCurrent = MOCK_TREASURY_HISTORY.length > 0
      ? MOCK_TREASURY_HISTORY[MOCK_TREASURY_HISTORY.length - 1].totalValueUsd
      : 0;
    return {
      history: MOCK_TREASURY_HISTORY,
      currentValue: mockCurrent,
      strategies: MOCK_STRATEGIES,
      assets: MOCK_ASSETS,
      allocation: MOCK_ALLOCATION,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  if (!daoAddress) {
    return { history: [], currentValue: 0, strategies: [], assets: [], allocation: [], loading: false, error: null, refetch };
  }

  return {
    history,
    currentValue,
    strategies,
    assets,
    allocation,
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : 'Failed to fetch treasury data') : null,
    refetch,
  };
}
