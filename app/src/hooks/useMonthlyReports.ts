import { useState, useEffect, useCallback } from 'react';
import { supabase, type MonthlyReportRow } from '../lib/supabaseClient';
import { isMockDaoAddress, MOCK_MONTHLY_REPORTS, MOCK_YEARLY_REPORTS } from '../lib/mockData';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';

export interface MonthlyReport {
  year: number;
  month: number;
  capitalStart: number;
  capitalEnd: number;
  yieldEarned: number;
  feesCollected: number;
  agentActionsCount: number;
  walletActionsCount: number;
  proposalsCount: number;
  summary: Record<string, unknown>;
  returnPct: number;
}

export interface YearlyReportGroup {
  year: number;
  months: MonthlyReport[];
  totalYield: number;
  totalFees: number;
}

interface UseMonthlyReportsResult {
  reports: YearlyReportGroup[];
  allMonths: MonthlyReport[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useMonthlyReports(daoAddress: string | null): UseMonthlyReportsResult {
  const [reports, setReports] = useState<YearlyReportGroup[]>([]);
  const [allMonths, setAllMonths] = useState<MonthlyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMock = isMockDaoAddress(daoAddress);

  const fetchData = useCallback(async () => {
    if (!daoAddress || isMock) {
      setReports([]);
      setAllMonths([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);
      const { data, error: dbError } = await supabase
        .from('monthly_reports')
        .select('*')
        .eq('dao_onchain_address', daoKey)
        .order('year', { ascending: false })
        .order('month', { ascending: false });

      if (dbError) {
        setError(dbError.message);
        setLoading(false);
        return;
      }

      const rows = (data as MonthlyReportRow[]) || [];
      const monthlyData: MonthlyReport[] = rows.map((r) => {
        const returnPct =
          r.capital_start > 0
            ? ((Number(r.capital_end) - Number(r.capital_start)) / Number(r.capital_start)) * 100
            : 0;

        return {
          year: r.year,
          month: r.month,
          capitalStart: Number(r.capital_start),
          capitalEnd: Number(r.capital_end),
          yieldEarned: Number(r.yield_earned),
          feesCollected: Number(r.fees_collected),
          agentActionsCount: r.agent_actions_count,
          walletActionsCount: r.wallet_actions_count,
          proposalsCount: r.proposals_count,
          summary: r.summary,
          returnPct,
        };
      });

      setAllMonths(monthlyData);

      // Group by year
      const yearMap = new Map<number, MonthlyReport[]>();
      for (const m of monthlyData) {
        if (!yearMap.has(m.year)) {
          yearMap.set(m.year, []);
        }
        yearMap.get(m.year)!.push(m);
      }

      const grouped: YearlyReportGroup[] = Array.from(yearMap.entries())
        .map(([year, months]) => ({
          year,
          months: months.sort((a, b) => a.month - b.month),
          totalYield: months.reduce((sum, m) => sum + m.yieldEarned, 0),
          totalFees: months.reduce((sum, m) => sum + m.feesCollected, 0),
        }))
        .sort((a, b) => b.year - a.year);

      setReports(grouped);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch reports');
    } finally {
      setLoading(false);
    }
  }, [daoAddress, isMock]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (isMock) {
    return {
      reports: MOCK_YEARLY_REPORTS,
      allMonths: MOCK_MONTHLY_REPORTS,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  return { reports, allMonths, loading, error, refetch: fetchData };
}