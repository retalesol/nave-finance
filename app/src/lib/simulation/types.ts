/** Shared types for the public /simulation page (mirrors simulation-data edge response). */

export type SimulationRegime = 'bull' | 'bear' | 'sideways' | 'mixed' | 'crisis';

export interface SimulationAllocation {
  venueId: string;
  weight: number;
  navUsd: number;
}

export interface SimulationSeriesPoint {
  t: string;
  month: number;
  nav: number;
  solNav: number;
  evmNav: number;
  regime: Exclude<SimulationRegime, 'mixed'>;
  allocations: SimulationAllocation[];
}

export interface SimulationPortfolio {
  id: string;
  runIndex: number;
  windowStart: string;
  windowEnd: string;
  regimeLabel: SimulationRegime;
  startNavUsd: number;
  endNavUsd: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  cagrPct: number;
  chainSplit: { solana: number; evm: number };
  protocolPnl: Record<string, number>;
  series: SimulationSeriesPoint[];
}

export interface SimulationCohort {
  count: number;
  medianReturnPct: number;
  medianEndNav: number;
}

export interface SimulationSummary {
  medianEndNav: number;
  p10EndNav: number;
  p90EndNav: number;
  bestEndNav: number;
  worstEndNav: number;
  survivalRate: number;
  avgMaxDrawdownPct: number;
  medianCagrPct: number;
  bullCohort: SimulationCohort;
  bearCohort: SimulationCohort;
  sidewaysCohort: SimulationCohort;
  mixedCohort: SimulationCohort;
}

export interface SimulationBatch {
  id: string;
  createdAt: string;
  seed: string;
  status: string;
  params: Record<string, unknown>;
  summary: SimulationSummary;
}

export interface SimulationDataResponse {
  batch: SimulationBatch;
  portfolios: SimulationPortfolio[];
}
