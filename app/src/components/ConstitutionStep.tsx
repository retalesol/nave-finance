// Shared constitution configuration UI — used by the 4-step CreateDAO wizard
// and by PolicyEngine (post-create amend flow). Chain-aware: Solana strategy
// support/badges come from `getSolanaStrategyStatuses()`; EVM uses
// `getEvmAdapterStatuses()` — both from `strategyReadiness.ts`, the single
// source of truth for "is this strategy actually live" across the app AND
// the mainnet-cutover preflight gate.

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import Fi from './Fi';
import CollapsibleSection from './CollapsibleSection';
import PolicySlider from './PolicySlider';
import { staggerContainer, staggerChild } from './PageTransition';
import {
  getSolanaStrategyStatuses,
  getEvmAdapterStatuses,
  type EvmAdapterProtocolId,
} from '../lib/strategyReadiness';
import type { ChainFamily, EvmChainId } from '../lib/chain/types';
import { SYSTEM_CONFIDENCE_THRESHOLD, activeEvmChainId } from '../lib/programConfig';
import { useStrategyRates } from '../hooks/useStrategyRates';
import {
  TIER_PRESETS,
  blendedEstimate,
  constitutionCapsBps,
  effectiveApy,
  findVenue,
  isTemporaryRate,
  presetRisks,
  strategyChainForEvmId,
  venuesForChain,
  type RiskTier,
  type StrategyChain,
  type StrategyRate,
  type StrategyVenue,
  type TierPresetId,
} from '../../supabase/functions/_shared/strategyCatalog.ts';

const SOLANA_STRATEGY_STATUS_BY_ID = new Map(
  getSolanaStrategyStatuses().map((status) => [status.id, status]),
);
const MARGINFI_STRATEGY_ENABLED = SOLANA_STRATEGY_STATUS_BY_ID.get('marginfi')?.supported ?? false;

// ── Types ─────────────────────────────────────────────────────────────────────

export type RiskPreset = 'conservative' | 'balanced' | 'yield6' | 'aggressive' | 'custom';

export interface PolicyState {
  riskPreset: RiskPreset;
  /** 0–100 percent (UI); multiply × 100 for on-chain BPS */
  minStablecoin: number;
  /** 0–100 percent (UI); multiply × 100 for on-chain BPS */
  maxDeployment: number;
  /** 0–100 percent (UI); maps to maxAllocationBps in constitution */
  maxLending: number;
  /** 0–100 percent (UI); multiply × 100 for on-chain BPS */
  liquidityReserve: number;
  /** Human-readable label: 'Hourly' | 'Daily' | 'Weekly' | 'Bi-weekly' | 'Monthly' | 'Manual' */
  rebalanceFreq: string;
  /** Per-protocol enabled flags (key = protocolId) */
  approvedProtocols: Record<string, boolean>;
  /** System-wide AI confidence (0–100). Not user-editable — persisted on save. */
  confidenceThreshold: number;
}

export interface ConstitutionStepProps {
  policy: PolicyState;
  setPolicy: (update: Partial<PolicyState>) => void;
  chain: 'solana' | 'evm';
  evmChainId?: EvmChainId;
  /** When true, renders a compact read-only summary card instead of the editor. */
  readOnly?: boolean;
  /**
   * Preset cards to offer. Create offers Conservative, Balanced and Yield 6%;
   * Aggressive and Custom stay on the amend flow.
   */
  offeredPresets?: readonly RiskPreset[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const RISK_PRESETS: { id: RiskPreset; label: string; desc: string }[] = [
  { id: 'conservative', label: 'Conservative', desc: 'Tier 1 lending and savings only.' },
  { id: 'balanced',     label: 'Balanced',     desc: 'Tier 1, plus up to 30% in Tier 2 vaults.' },
  { id: 'yield6',       label: 'Yield 6% target', desc: 'Adds Tier 3 credit and fixed-term venues (at most 15%). Not guaranteed.' },
  { id: 'aggressive',   label: 'Aggressive',   desc: 'Maximise yield. Higher risk tolerance.' },
  { id: 'custom',       label: 'Custom',        desc: 'Define your own parameters.' },
];

export const PRESET_DEFAULTS: Record<RiskPreset, Partial<PolicyState>> = {
  conservative: { minStablecoin: 60, maxDeployment: 40, maxLending: 20, liquidityReserve: 25 },
  balanced:     { minStablecoin: 35, maxDeployment: 65, maxLending: 40, liquidityReserve: 15 },
  yield6:       { minStablecoin: 30, maxDeployment: 70, maxLending: 40, liquidityReserve: 12 },
  aggressive:   { minStablecoin: 15, maxDeployment: 85, maxLending: 70, liquidityReserve: 8  },
  custom:       {},
};

/** Tiers each preset approves. Custom leaves approvals alone. */
const PRESET_TIERS: Partial<Record<RiskPreset, RiskTier[]>> = {
  conservative: TIER_PRESETS.conservative.tiers,
  balanced: TIER_PRESETS.balanced.tiers,
  yield6: TIER_PRESETS.yield6.tiers,
  aggressive: [1, 2, 3],
};

export const PROTOCOLS_SOLANA = [
  { key: 'kamino',   label: 'Kamino',   desc: 'Main-market USDC lending', badge: null as 'beta' | null, badgeReason: null as string | null },
  ...(MARGINFI_STRATEGY_ENABLED
    ? [{ key: 'marginfi', label: 'MarginFi', desc: 'Lending / borrowing protocol', badge: null as 'beta' | null, badgeReason: null as string | null }]
    : []),
  { key: 'jito',    label: 'Jito',    desc: 'Liquid staking (jitoSOL)', badge: null as 'beta' | null, badgeReason: null as string | null },
  {
    key: 'jupiter',
    label: 'Jupiter',
    desc: 'Lend Earn — yield on stablecoins and SOL',
    badge: SOLANA_STRATEGY_STATUS_BY_ID.get('jupiter')?.badge ?? null,
    badgeReason: SOLANA_STRATEGY_STATUS_BY_ID.get('jupiter')?.badgeReason ?? null,
  },
];

export const PROTOCOLS_EVM = [
  { key: 'aave',     label: 'Aave V3',    desc: 'Lending and borrowing markets', badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'compound', label: 'Compound V3', desc: 'Blue-chip lending protocol', badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'balancer', label: 'Balancer',    desc: 'Weighted liquidity pools', badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'arbitrum-bridge', label: 'Arbitrum Bridge', desc: 'Bridge WETH to Ethereum sister treasury', badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'cctp', label: 'CCTP USDC', desc: 'Circle CCTP USDC to sister treasury', badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'op-standard-bridge', label: 'OP Bridge', desc: 'Base ↔ Ethereum ETH/WETH StandardBridge', badge: null as 'beta' | null, badgeReason: null as string | null },
];

/** Strategy-menu chain for the wizard's chain selection. */
export function strategyChainFor(chain: 'solana' | 'evm', evmChainId?: EvmChainId | null): StrategyChain | null {
  return chain === 'solana' ? 'solana' : strategyChainForEvmId(evmChainId ?? null);
}

/**
 * Approvals after picking a preset: catalog dollar venues are on exactly when
 * their tier is in the preset. Non-dollar venues (Jito) and bridge adapters
 * keep their current toggle, and only `selectable` keys can turn on.
 */
export function approvalsForPreset(
  preset: RiskPreset,
  strategyChain: StrategyChain | null,
  current: Record<string, boolean>,
  selectable: readonly string[],
): Record<string, boolean> {
  const tiers = PRESET_TIERS[preset];
  if (!tiers || !strategyChain) return current;
  const next = { ...current };
  for (const key of selectable) {
    const venue = findVenue(strategyChain, key);
    if (!venue || !venue.stable || venue.availability === 'later') continue;
    next[key] = tiers.includes(venue.tier);
  }
  return next;
}

/**
 * Per-venue cap (bps) for the constitution: the per-venue limit, with Tier 2
 * and Tier 3 ceilings split across that tier's approved venues so the on-chain
 * tier totals always fit. Venues outside the catalog count as Tier 1.
 */
export function tierBoundedCaps(
  chain: 'solana' | 'evm',
  evmChainId: EvmChainId | null | undefined,
  policy: Pick<PolicyState, 'approvedProtocols' | 'maxLending'>,
): (protocolId: string) => number {
  const strategyChain = strategyChainFor(chain, evmChainId);
  const tierOf = (id: string): RiskTier => (strategyChain && findVenue(strategyChain, id)?.tier) || 1;
  const approved = Object.entries(policy.approvedProtocols).filter(([, on]) => on).map(([id]) => id);
  const caps = constitutionCapsBps(approved.map((id) => ({ id, tier: tierOf(id) })), policy.maxLending);
  const flat = Math.round(policy.maxLending * 100);
  return (id) => caps.get(id) ?? flat;
}

function formatApy(apy: number): string {
  return `${apy.toFixed(apy >= 10 ? 1 : 2)}%`;
}

function availabilityLabel(venue: StrategyVenue): string {
  if (venue.availability === 'testnet') return 'On testnet';
  if (venue.availability === 'fork-only') return 'Mainnet only · tested on a fork';
  return 'Later';
}

export const REBALANCE_OPTIONS = ['Hourly', 'Daily', 'Weekly', 'Bi-weekly', 'Monthly', 'Manual'];

export const DEFAULT_SOLANA_PROTOCOLS: Record<string, boolean> = {
  kamino:   true,
  marginfi: MARGINFI_STRATEGY_ENABLED,
  jito:     true,
  jupiter:  false,
};

export const DEFAULT_POLICY: PolicyState = {
  riskPreset:           'balanced',
  minStablecoin:        35,
  maxDeployment:        65,
  maxLending:           40,
  liquidityReserve:     15,
  rebalanceFreq:        'Weekly',
  approvedProtocols:    DEFAULT_SOLANA_PROTOCOLS,
  confidenceThreshold:  SYSTEM_CONFIDENCE_THRESHOLD,
};

/**
 * Chain-aware constitution for a risk preset. Quick setup passes `conservative`
 * (60% stablecoin reserve, 40% deployment cap, 20% per venue, 25% liquidity).
 * Solana keeps Kamino/Jito. EVM only enables adapters that have a real address
 * on the selected chain.
 */
export function policyForChain(chain: ChainFamily, preset: RiskPreset = 'conservative'): PolicyState {
  const base: PolicyState = {
    ...DEFAULT_POLICY,
    ...PRESET_DEFAULTS[preset],
    riskPreset: preset,
  };
  if (chain === 'solana') {
    const selectable = PROTOCOLS_SOLANA.filter((p) => p.badge !== 'beta').map((p) => p.key);
    return { ...base, approvedProtocols: approvalsForPreset(preset, 'solana', base.approvedProtocols, selectable) };
  }
  const evmChainId = activeEvmChainId(chain);
  const approvedProtocols: Record<string, boolean> = {};
  for (const status of getEvmAdapterStatuses(evmChainId)) {
    approvedProtocols[status.protocolId] = status.configured;
  }
  const configured = Object.entries(approvedProtocols).filter(([, on]) => on).map(([id]) => id);
  return {
    ...base,
    approvedProtocols: approvalsForPreset(preset, strategyChainForEvmId(evmChainId), approvedProtocols, configured),
  };
}

/** Whole-percent label for an on-chain basis-point figure. */
export function formatConstitutionBps(bps: number): string {
  const pct = bps / 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a rebalance-freq label to seconds for on-chain set_policy_parameters. */
export function rebalanceFreqToSecs(freq: string): number {
  switch (freq) {
    case 'Hourly':    return 3_600;
    case 'Daily':     return 86_400;
    case 'Weekly':    return 604_800;
    case 'Bi-weekly': return 1_209_600;
    case 'Monthly':   return 2_592_000;
    case 'Manual':
    default:          return 30 * 86_400;
  }
}

/** Convert a rebalance-secs value back to a human-readable label. */
export function secsToRebalanceFreq(secs: number): string {
  if (secs <= 3_600)     return 'Hourly';
  if (secs <= 86_400)    return 'Daily';
  if (secs <= 604_800)   return 'Weekly';
  if (secs <= 1_209_600) return 'Bi-weekly';
  return 'Monthly';
}

// ── SimResult ─────────────────────────────────────────────────────────────────

export function SimResult({ policy }: { policy: PolicyState }) {
  const activeProtocols = Object.entries(policy.approvedProtocols)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const issues: string[] = [];
  if (policy.minStablecoin + policy.maxDeployment > 100)
    issues.push('Min stablecoin reserve + max deployment exceeds 100%');
  if (activeProtocols.length === 0)
    issues.push('No approved protocols selected');
  if (policy.maxLending > policy.maxDeployment)
    issues.push('Max lending exposure exceeds max deployment');

  return (
    <div
      className="p-4 rounded-xl border"
      style={{
        backgroundColor: issues.length ? 'hsl(var(--warning-muted))' : 'hsl(var(--accent-muted))',
        borderColor: issues.length ? 'hsl(38 92% 75%)' : 'hsl(var(--border-strong))',
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        {issues.length ? (
          <Fi icon="triangle-exclamation" style={{ fontSize: '13px', color: 'hsl(var(--warning))' }} />
        ) : (
          <Fi icon="circle-check" style={{ fontSize: '13px', color: 'hsl(var(--accent))' }} />
        )}
        <span style={{ fontSize: '13px', fontWeight: '500', color: issues.length ? 'hsl(38 60% 30%)' : 'hsl(var(--accent-muted-foreground))' }}>
          {issues.length
            ? `${issues.length} policy conflict${issues.length > 1 ? 's' : ''} detected`
            : 'Policy simulation passed'}
        </span>
      </div>
      {issues.length > 0 ? (
        <ul className="space-y-1">
          {issues.map((iss) => (
            <li key={iss} style={{ fontSize: '12.5px', color: 'hsl(38 50% 35%)', paddingLeft: '16px', listStyle: 'disc' }}>
              {iss}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ fontSize: '12.5px', color: 'hsl(var(--accent-muted-foreground))' }}>
          Agent can operate with {activeProtocols.length} approved protocol{activeProtocols.length !== 1 ? 's' : ''}.
          Rebalancing: {policy.rebalanceFreq}.
        </p>
      )}
    </div>
  );
}

// ── Read-only summary card ─────────────────────────────────────────────────────

function ConstitutionSummary({ policy, chain, evmChainId }: {
  policy: PolicyState;
  chain: 'solana' | 'evm';
  evmChainId?: EvmChainId;
}) {
  const evmAdapterStatuses = useMemo(
    () => (chain === 'evm' && evmChainId ? getEvmAdapterStatuses(evmChainId) : []),
    [chain, evmChainId],
  );
  const evmStatusByProtocol = useMemo(
    () => new Map(evmAdapterStatuses.map((s) => [s.protocolId, s])),
    [evmAdapterStatuses],
  );
  const protocolOptions = (chain === 'evm' ? PROTOCOLS_EVM : PROTOCOLS_SOLANA).filter((p) => {
    if (chain !== 'evm') return true;
    const status = evmStatusByProtocol.get(p.key as EvmAdapterProtocolId);
    return !!(status?.configured && status.address && !/^0x0{40}$/i.test(status.address));
  });

  const approvedProtocolLabels = protocolOptions
    .filter((p) => {
      if (!policy.approvedProtocols[p.key]) return false;
      if (chain === 'evm') return evmStatusByProtocol.get(p.key as EvmAdapterProtocolId)?.configured ?? false;
      return true;
    })
    .map((p) => p.label);

  const presetLabel = RISK_PRESETS.find((r) => r.id === policy.riskPreset)?.label ?? policy.riskPreset;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="px-2.5 py-1 rounded-lg text-xs font-medium"
          style={{ backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
        >
          {presetLabel}
        </span>
        {approvedProtocolLabels.map((label) => (
          <span
            key={label}
            className="px-2.5 py-1 rounded-lg text-xs"
            style={{ backgroundColor: 'hsl(var(--accent-muted))', color: 'hsl(var(--accent-muted-foreground))', border: '1px solid hsl(var(--border-strong))' }}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: 'Min Reserve', value: `${policy.minStablecoin}%` },
          { label: 'Max Deploy', value: `${policy.maxDeployment}%` },
          { label: 'Rebalancing', value: policy.rebalanceFreq },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between px-3 py-2 rounded-lg"
            style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}>
            <span style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>{label}</span>
            <span className="nave-mono" style={{ fontSize: '11.5px', color: 'hsl(var(--foreground))', fontWeight: 500 }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Strategy menu ──────────────────────────────────────────────────────────────

const TIER_STYLE: Record<RiskTier, { bg: string; fg: string }> = {
  1: { bg: 'hsl(var(--accent-muted))', fg: 'hsl(var(--accent-muted-foreground))' },
  2: { bg: 'hsl(var(--warning-muted))', fg: 'hsl(38 60% 30%)' },
  3: { bg: 'hsl(0 85% 95%)', fg: 'hsl(0 60% 38%)' },
};

function TierBadge({ tier }: { tier: RiskTier }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded"
      style={{ fontSize: '10px', fontWeight: 600, backgroundColor: TIER_STYLE[tier].bg, color: TIER_STYLE[tier].fg }}
    >
      Tier {tier}
    </span>
  );
}

function StrategyMenu({ strategyChain, preset, rates, asOf }: {
  strategyChain: StrategyChain;
  preset: RiskPreset;
  rates: Map<string, StrategyRate>;
  asOf: string | null;
}) {
  const venues = venuesForChain(strategyChain);
  const tierPreset: TierPresetId | null =
    preset === 'conservative' || preset === 'balanced' || preset === 'yield6' ? preset : null;
  const estimate = tierPreset ? blendedEstimate(strategyChain, tierPreset, rates) : null;
  const risks = tierPreset ? presetRisks(strategyChain, tierPreset) : [];
  const target = tierPreset ? TIER_PRESETS[tierPreset].targetApy : null;
  const asOfLabel = asOf
    ? `Live rates as of ${new Date(asOf).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Reference rates from Oct 10, 2026 (live feed not loaded)';

  return (
    <CollapsibleSection title="Strategy Menu" subtitle={asOfLabel}>
      <div className="space-y-4" data-testid="strategy-menu">
        {estimate && (
          <div
            className="p-3.5 rounded-xl border"
            style={{ borderColor: 'hsl(var(--border-strong))', backgroundColor: 'hsl(var(--surface-1))' }}
          >
            {estimate.weights.size > 0 ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                    Estimated blend at today's mainnet rates
                  </span>
                  <span className="nave-mono" style={{ fontSize: '15px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                    {formatApy(estimate.apy)}
                  </span>
                </div>
                {target != null && estimate.meetsTarget === false && (
                  <p style={{ fontSize: '12px', color: 'hsl(38 60% 30%)', marginTop: 6, lineHeight: 1.5 }}>
                    Today's rates put this mix at {formatApy(estimate.apy)}, short of the {target}% target. Nave will not
                    go past the tier caps (Tier 2 at most 30%, Tier 3 at most 15%) to close the gap; the blend rises only
                    if venue rates rise.
                  </p>
                )}
                {target != null && estimate.meetsTarget === true && (
                  <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: 6, lineHeight: 1.5 }}>
                    At today's rates this mix reaches the {target}% target. Rates change daily, so this is an estimate, not a promise.
                  </p>
                )}
                <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: 6, lineHeight: 1.5 }}>
                  Base yield only; reward tokens are left out because a treasury contract cannot claim them. Venues marked
                  "Mainnet only" cannot be approved on this testnet.
                </p>
              </>
            ) : (
              <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                No dollar venues on this chain match this preset yet.
              </p>
            )}
            {risks.length > 0 && (
              <ul className="mt-2 space-y-1">
                {risks.map((r) => (
                  <li key={r} style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', paddingLeft: 14, listStyle: 'disc' }}>
                    {r}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="space-y-2">
          {venues.map((venue) => {
            const rate = rates.get(venue.id);
            const apy = venue.rate ? effectiveApy(rate, venue.fallbackApy) : null;
            return (
              <div
                key={venue.id}
                data-testid={`strategy-venue-${venue.id}`}
                className="p-3 rounded-xl border"
                style={{
                  borderColor: 'hsl(var(--border))',
                  backgroundColor: 'hsl(var(--surface-0))',
                  opacity: venue.availability === 'later' ? 0.62 : 1,
                }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>{venue.label}</span>
                  <TierBadge tier={venue.tier} />
                  {!venue.stable && (
                    <span className="px-1.5 py-0.5 rounded" style={{ fontSize: '10px', fontWeight: 600, backgroundColor: 'hsl(var(--warning-muted))', color: 'hsl(38 60% 30%)' }}>
                      {venue.asset}, not stable
                    </span>
                  )}
                  <span className="nave-mono ml-auto" style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }}>
                    {apy != null ? `${formatApy(apy)}${rate ? '' : ' est.'}` : '—'}
                  </span>
                </div>
                <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: 3, lineHeight: 1.5 }}>
                  {availabilityLabel(venue)} · Exit: {venue.exitNote}
                  {rate && isTemporaryRate(rate) ? ' · Rate spike; using the 30-day average' : ''}
                </div>
                {venue.availability === 'later' && venue.laterReason && (
                  <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: 2 }}>{venue.laterReason}</div>
                )}
                {venue.tier > 1 && (
                  <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: 2 }}>
                    {venue.risks.join(' ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </CollapsibleSection>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ConstitutionStep({
  policy,
  setPolicy,
  chain,
  evmChainId,
  readOnly = false,
  offeredPresets,
}: ConstitutionStepProps) {
  const evmAdapterStatuses = useMemo(
    () => (chain === 'evm' && evmChainId ? getEvmAdapterStatuses(evmChainId) : []),
    [chain, evmChainId],
  );
  const evmStatusByProtocol = useMemo(
    () => new Map(evmAdapterStatuses.map((s) => [s.protocolId, s])),
    [evmAdapterStatuses],
  );

  const protocolOptions = (chain === 'evm' ? PROTOCOLS_EVM : PROTOCOLS_SOLANA).filter((p) => {
    if (chain !== 'evm') return true;
    const status = evmStatusByProtocol.get(p.key as EvmAdapterProtocolId);
    return !!(status?.configured && status.address && !/^0x0{40}$/i.test(status.address));
  });

  const strategyChain = strategyChainFor(chain, evmChainId);
  const { rates, asOf } = useStrategyRates(readOnly ? null : strategyChain);

  if (readOnly) {
    return <ConstitutionSummary policy={policy} chain={chain} evmChainId={evmChainId} />;
  }

  function applyPreset(preset: RiskPreset) {
    const selectable = protocolOptions
      .filter((p) => p.badge !== 'beta')
      .filter((p) => chain !== 'evm' || evmStatusByProtocol.get(p.key as EvmAdapterProtocolId)?.configured)
      .map((p) => p.key);
    setPolicy({
      riskPreset: preset,
      ...PRESET_DEFAULTS[preset],
      approvedProtocols: approvalsForPreset(preset, strategyChain, policy.approvedProtocols, selectable),
    });
  }

  function toggleProtocol(key: string) {
    if (chain === 'evm' && !evmStatusByProtocol.get(key as EvmAdapterProtocolId)?.configured) {
      return;
    }
    setPolicy({ approvedProtocols: { ...policy.approvedProtocols, [key]: !policy.approvedProtocols[key] } });
  }

  return (
    <div className="space-y-4">
      {/* Risk preset */}
      <CollapsibleSection title="Risk Profile">
        <motion.div
          className="grid grid-cols-2 sm:grid-cols-4 gap-2"
          variants={staggerContainer}
          initial="initial"
          animate="animate"
        >
          {RISK_PRESETS.filter((preset) => !offeredPresets || offeredPresets.includes(preset.id)).map((preset) => (
            <motion.button
              key={preset.id}
              onClick={() => applyPreset(preset.id)}
              className="p-3.5 rounded-xl border text-left transition-all"
              style={{
                backgroundColor: policy.riskPreset === preset.id ? 'hsl(var(--primary))' : 'hsl(var(--surface-0))',
                borderColor: policy.riskPreset === preset.id ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                color: policy.riskPreset === preset.id ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
              }}
              variants={staggerChild}
              whileHover={{ y: -2, transition: { duration: 0.15 } }}
              whileTap={{ scale: 0.97 }}
            >
              <div className="font-semibold text-display" style={{ fontSize: '12.5px', marginBottom: '3px' }}>
                {preset.label}
              </div>
              <div style={{
                fontSize: '11px',
                opacity: policy.riskPreset === preset.id ? 0.75 : 1,
                color: policy.riskPreset === preset.id ? 'inherit' : 'hsl(var(--muted-foreground))',
                lineHeight: 1.4,
              }}>
                {preset.desc}
              </div>
            </motion.button>
          ))}
        </motion.div>
      </CollapsibleSection>

      {/* Capital constraints */}
      <CollapsibleSection title="Capital Constraints">
        <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, marginBottom: 14 }}>
          These limits are enforced on-chain. Agents cannot deploy or lend beyond what you set here.
        </p>
        <div className="space-y-6">
          <PolicySlider
            label="Minimum Stablecoin Reserve"
            hint="Minimum % of treasury that must stay in stablecoins"
            value={policy.minStablecoin}
            onChange={(v) => setPolicy({ minStablecoin: v, riskPreset: 'custom' })}
            accent
          />
          <PolicySlider
            label="Maximum Treasury Deployment"
            hint="Max % of treasury that can be deployed to DeFi protocols"
            value={policy.maxDeployment}
            onChange={(v) => setPolicy({ maxDeployment: v, riskPreset: 'custom' })}
          />
          <PolicySlider
            label="Maximum Lending Exposure"
            hint="Max % of deployed capital in lending protocols"
            value={policy.maxLending}
            onChange={(v) => setPolicy({ maxLending: v, riskPreset: 'custom' })}
          />
          <PolicySlider
            label="Liquidity Reserve"
            hint="Minimum instantly-liquid capital"
            value={policy.liquidityReserve}
            onChange={(v) => setPolicy({ liquidityReserve: v, riskPreset: 'custom' })}
          />
        </div>
      </CollapsibleSection>

      {/* Approved protocols */}
      <CollapsibleSection title="Approved Protocols">
        <div className="space-y-3">
          {protocolOptions.length === 0 && chain === 'evm' && (
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
              No strategy adapters are configured on this chain.
            </p>
          )}
          {protocolOptions.map((p) => {
            const evmStatus = chain === 'evm'
              ? evmStatusByProtocol.get(p.key as EvmAdapterProtocolId)
              : undefined;
            const disabled = chain === 'evm' && !evmStatus?.configured;
            const enabled = !disabled && !!policy.approvedProtocols[p.key];
            const venue = strategyChain ? findVenue(strategyChain, p.key) : undefined;
            const rate = venue ? rates.get(venue.id) : undefined;
            const apyLabel = venue && venue.rate
              ? `${formatApy(effectiveApy(rate, venue.fallbackApy))}${rate ? '' : ' est.'}`
              : '—';
            return (
              <div
                key={p.key}
                className="flex items-center justify-between p-3.5 rounded-xl border transition-all"
                style={{
                  borderColor: enabled ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                  backgroundColor: enabled ? 'hsl(var(--accent-muted))' : 'hsl(var(--surface-0))',
                  opacity: disabled ? 0.62 : 1,
                }}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-display" style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>
                      {p.label}
                    </span>
                    <span
                      className="nave-mono px-1.5 py-0.5 rounded"
                      style={{ fontSize: '10px', backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}
                      title={rate ? `Live mainnet rate (${rate.source.split(':')[0]})` : 'Reference rate from Oct 10, 2026; live rate not loaded'}
                    >
                      {apyLabel}
                    </span>
                    {venue && <TierBadge tier={venue.tier} />}
                    {venue && !venue.stable && (
                      <span
                        className="px-1.5 py-0.5 rounded"
                        style={{ fontSize: '10px', fontWeight: 600, backgroundColor: 'hsl(var(--warning-muted))', color: 'hsl(38 60% 30%)' }}
                      >
                        {venue.asset}, not stable
                      </span>
                    )}
                    {p.badge === 'beta' && (
                      <span
                        className="px-1.5 py-0.5 rounded uppercase"
                        style={{ fontSize: '9.5px', fontWeight: 600, letterSpacing: '0.03em', backgroundColor: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' }}
                        title={p.badgeReason ?? 'Beta: newer, less battle-tested integration.'}
                      >
                        Beta
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '1px' }}>
                    {disabled && evmStatus ? evmStatus.reason : (p.badge === 'beta' && p.badgeReason ? p.badgeReason : p.desc)}
                  </div>
                  {venue && (
                    <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
                      Exit: {venue.exitNote}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => toggleProtocol(p.key)}
                  disabled={disabled}
                  className="flex-shrink-0 relative rounded-full ml-3"
                  style={{
                    width: '40px',
                    height: '22px',
                    backgroundColor: enabled ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                    transition: 'background-color 0.2s',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                  title={disabled && evmStatus ? evmStatus.reason : `Toggle ${p.label}`}
                >
                  <span
                    className="absolute top-1 rounded-full"
                    style={{
                      width: '14px',
                      height: '14px',
                      backgroundColor: 'white',
                      left: enabled ? '22px' : '4px',
                      transition: 'left 0.2s',
                    }}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </CollapsibleSection>

      {strategyChain && (
        <StrategyMenu
          strategyChain={strategyChain}
          preset={policy.riskPreset}
          rates={rates}
          asOf={asOf}
        />
      )}

      {/* Automation */}
      <CollapsibleSection title="Automation & Operations">
        <div className="space-y-5">
          <div className="space-y-2">
            <label className="nave-label">Rebalancing Frequency</label>
            <div className="flex flex-wrap gap-2">
              {REBALANCE_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setPolicy({ rebalanceFreq: opt })}
                  className="px-3.5 py-1.5 rounded-lg border text-sm transition-all"
                  style={{
                    fontSize: '12px',
                    fontFamily: 'var(--font-mono)',
                    backgroundColor: policy.rebalanceFreq === opt ? 'hsl(var(--primary))' : 'hsl(var(--surface-0))',
                    borderColor: policy.rebalanceFreq === opt ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                    color: policy.rebalanceFreq === opt ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

        </div>
      </CollapsibleSection>

      {/* Live sim result */}
      <SimResult policy={policy} />
    </div>
  );
}
