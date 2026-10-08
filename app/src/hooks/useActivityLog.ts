import { useState, useEffect, useCallback } from 'react';
import { supabase, type ActivityLogRow } from '../lib/supabaseClient';
import { isMockDaoAddress, MOCK_ACTIVITIES } from '../lib/mockData';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';

export interface ActivityEntry {
  id: string;
  eventType: string;
  description: string;
  actor: string;
  agentRole: string | null;
  txSignature: string;
  slot: number | null;
  blockTime: string | null;
  createdAt: string;
  rawData: Record<string, unknown>;
}

interface UseActivityLogResult {
  activities: ActivityEntry[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  filterByType: (type: string | null) => void;
  refetch: () => void;
}

const PAGE_SIZE = 25;

export function useActivityLog(daoAddress: string | null): UseActivityLogResult {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const isMock = isMockDaoAddress(daoAddress);

  const fetchData = useCallback(
    async (pageNum: number, append = false) => {
      if (!daoAddress || isMockDaoAddress(daoAddress)) {
        setActivities([]);
        setHasMore(false);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      if (!append) {
        setActivities([]);
        setHasMore(false);
      }

      try {
        const daoKey = normalizeDaoOnchainAddressForQuery(daoAddress);
        let query = supabase
          .from('activity_logs')
          .select('*')
          .eq('dao_onchain_address', daoKey)
          .order('created_at', { ascending: false })
          .range(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE - 1);

        if (typeFilter) {
          query = query.eq('event_type', typeFilter);
        }

        const { data, error: dbError } = await query;

        if (dbError) {
          setError(dbError.message);
          setLoading(false);
          return;
        }

        const rows = (data as ActivityLogRow[]) || [];
        const entries: ActivityEntry[] = rows.map((r) => ({
          id: r.id,
          eventType: r.event_type,
          description: r.description,
          actor: r.actor,
          agentRole: r.agent_role,
          txSignature: r.tx_signature,
          slot: r.slot,
          blockTime: r.block_time,
          createdAt: r.created_at,
          rawData: r.raw_data,
        }));

        if (append) {
          setActivities((prev) => [...prev, ...entries]);
        } else {
          setActivities(entries);
        }

        setHasMore(entries.length === PAGE_SIZE);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch activity logs');
      } finally {
        setLoading(false);
      }
    },
    [daoAddress, typeFilter],
  );

  useEffect(() => {
    setPage(0);
    fetchData(0);
  }, [fetchData]);

  const loadMore = useCallback(() => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchData(nextPage, true);
  }, [page, fetchData]);

  const filterByType = useCallback((type: string | null) => {
    setTypeFilter(type);
    setPage(0);
  }, []);

  const refetch = useCallback(() => {
    setPage(0);
    fetchData(0);
  }, [fetchData]);

  if (isMock) {
    return {
      activities: MOCK_ACTIVITIES,
      loading: false,
      error: null,
      hasMore: false,
      loadMore: () => {},
      filterByType: () => {},
      refetch: () => {},
    };
  }

  return { activities, loading, error, hasMore, loadMore, filterByType, refetch };
}