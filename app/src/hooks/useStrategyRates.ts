import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { fromStrategyRateRow } from '../../supabase/functions/_shared/apySource.ts';
import type { StrategyChain, StrategyRate } from '../../supabase/functions/_shared/strategyCatalog.ts';

interface UseStrategyRatesResult {
  /** Latest live rate per venue id for the chain; empty until loaded or when none are stored. */
  rates: Map<string, StrategyRate>;
  loading: boolean;
  /** Oldest fetched_at among the rows, for the "as of" label. */
  asOf: string | null;
}

export function useStrategyRates(chain: StrategyChain | null): UseStrategyRatesResult {
  const [rates, setRates] = useState<Map<string, StrategyRate>>(new Map());
  const [loading, setLoading] = useState(chain != null);
  const [asOf, setAsOf] = useState<string | null>(null);

  useEffect(() => {
    if (!chain) {
      setRates(new Map());
      setAsOf(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data, error } = await supabase.from('strategy_rates').select('*').eq('chain', chain);
        if (cancelled) return;
        if (error || !data) {
          setRates(new Map());
          setAsOf(null);
          return;
        }
        const rows = data.map((row) => fromStrategyRateRow(row as Record<string, unknown>));
        setRates(new Map(rows.map((r) => [r.venueId, r])));
        const times = rows.map((r) => r.fetchedAt).filter(Boolean).sort();
        setAsOf(times[0] ?? null);
      } catch {
        if (!cancelled) {
          setRates(new Map());
          setAsOf(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chain]);

  return { rates, loading, asOf };
}
