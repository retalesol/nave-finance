// Shared constitution configuration UI — used by the 4-step CreateDAO wizard
// and by PolicyEngine (post-create amend flow). Chain-aware: Solana strategy
// support/badges come from `getSolanaStrategyStatuses()`; EVM uses
// `getEvmAdapterStatuses()` — both from `strategyReadiness.ts`, the single
// source of truth for "is this strategy actually live" across the app AND
// the mainnet-cutover preflight gate.

import { useMemo } from 'react';
import Fi from './Fi';
import CollapsibleSection from './CollapsibleSection';
import PolicySlider from './PolicySlider';
import { SummaryLine } from './calm';
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
  /** Minimum treasury NAV (in USD) required before autonomous agents deploy capital. */
  agentThresholdUsd?: number;
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
  { id: 'custom',       label: 'Custom',       desc: 'Define your own parameters.' },
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
    if (!venue) {
      if (strategyChain === 'robinhood' || strategyChain === 'arc') {
        next[key] = true;
      }
      continue;
    }
    if (venue.availability === 'later') continue;
    if (!venue.stable && strategyChain !== 'robinhood' && strategyChain !== 'arc') continue;
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
    case 'Manual':    return 0;
    default:          return 30 * 86_400;
  }
}

/** Convert a rebalance-secs value back to a human-readable label. */
export function secsToRebalanceFreq(secs: number): string {
  if (secs <= 0)         return 'Manual';
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
      style={{
        padding: '12px 0',
        borderTop: '1px solid hsl(var(--surface-2))',
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            backgroundColor: issues.length ? '#9A7414' : '#2F7D4F',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: '13px', fontWeight: 600, color: issues.length ? '#9A7414' : 'hsl(var(--foreground))' }}>
          {issues.length
            ? `${issues.length} policy conflict${issues.length > 1 ? 's' : ''} detected`
            : 'Policy simulation passed'}
        </span>
      </div>
      {issues.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {issues.map((iss) => (
            <li key={iss} style={{ fontSize: '12.5px', color: '#9A7414', paddingLeft: '16px', listStyle: 'disc' }}>
              {iss}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', margin: '4px 0 0 15px' }}>
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
    <div className="space-y-2">
      {[
        { label: 'Posture', value: presetLabel },
        { label: 'Min Reserve', value: `${policy.minStablecoin}%` },
        { label: 'Max Deploy', value: `${policy.maxDeployment}%` },
        { label: 'Rebalancing', value: policy.rebalanceFreq },
        { label: 'Approved venues', value: approvedProtocolLabels.length > 0 ? approvedProtocolLabels.join(', ') : 'None' },
      ].map(({ label, value }) => (
        <div
          key={label}
          className="flex items-center justify-between gap-4"
          style={{
            padding: '10px 0',
            borderBottom: '1px solid hsl(var(--surface-2))',
            fontSize: '13.5px',
          }}
        >
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
          <b style={{ fontWeight: 500, color: 'hsl(var(--foreground))' }}>{value}</b>
        </div>
      ))}
    </div>
  );
}

// ── Strategy menu ──────────────────────────────────────────────────────────────

const TIER_STYLE: Record<RiskTier, { bg: string; fg: string }> = {
  1: { bg: 'hsl(var(--surface-1))', fg: 'hsl(var(--foreground))' },
  2: { bg: 'hsl(var(--warning-muted))', fg: '#9A7414' },
  3: { bg: 'hsl(var(--destructive-muted))', fg: 'hsl(var(--destructive))' },
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
      <div className="space-y-3" data-testid="strategy-menu">
        {estimate && (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '12px',
              backgroundColor: 'hsl(var(--background))',
              border: '1px solid hsl(var(--surface-2))',
            }}
          >
            {estimate.weights.size > 0 ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
                    Estimated blend at today&apos;s mainnet rates
                  </span>
                  <span className="nave-mono" style={{ fontSize: '15px', fontWeight: 600, color: '#2F7D4F' }}>
                    {formatApy(estimate.apy)}
                  </span>
                </div>
                {target != null && estimate.meetsTarget === false && (
                  <p style={{ fontSize: '12px', color: '#9A7414', marginTop: 6, lineHeight: 1.5 }}>
                    Today&apos;s rates put this mix at {formatApy(estimate.apy)}, short of the {target}% target. Nave will not
                    go past the tier caps (Tier 2 at most 30%, Tier 3 at most 15%) to close the gap; the blend rises only
                    if venue rates rise.
                  </p>
                )}
                {target != null && estimate.meetsTarget === true && (
                  <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: 6, lineHeight: 1.5 }}>
                    At today&apos;s rates this mix reaches the {target}% target. Rates change daily, so this is an estimate, not a promise.
                  </p>
                )}
                <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: 6, lineHeight: 1.5 }}>
                  Base yield only; reward tokens are left out because a treasury contract cannot claim them. Venues marked
                  &quot;Mainnet only&quot; cannot be approved on this testnet.
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

        <div>
          {venues.map((venue) => {
            const rate = rates.get(venue.id);
            const apy = venue.rate ? effectiveApy(rate, venue.fallbackApy) : null;
            return (
              <div
                key={venue.id}
                data-testid={`strategy-venue-${venue.id}`}
                style={{
                  padding: '12px 0',
                  borderBottom: '1px solid hsl(var(--surface-2))',
                  opacity: venue.availability === 'later' ? 0.62 : 1,
                }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium" style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>
                    {venue.label}
                  </span>
                  <TierBadge tier={venue.tier} />
                  {!venue.stable && (
                    <span
                      className="px-1.5 py-0.5 rounded"
                      style={{ fontSize: '10px', fontWeight: 600, backgroundColor: 'hsl(var(--warning-muted))', color: '#9A7414' }}
                    >
                      {venue.asset}, not stable
                    </span>
                  )}
                  <span className="nave-mono ml-auto" style={{ fontSize: '12.5px', color: '#2F7D4F', fontWeight: 500 }}>
                    {apy != null ? `${formatApy(apy)}${rate ? '' : ' est.'}` : '—'}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: 3, lineHeight: 1.5 }}>
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
    <div>
      {/* Risk preset — demo .opts radio rows */}
      <CollapsibleSection title="How careful should your agents be?">
        <div className="flex flex-col">
          {RISK_PRESETS.filter((preset) => !offeredPresets || offeredPresets.includes(preset.id)).map((preset) => {
            const selected = policy.riskPreset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className="flex items-start gap-3 w-full text-left transition-colors"
                style={{
                  padding: '13px 2px',
                  borderBottom: '1px solid hsl(var(--surface-2))',
                }}
              >
                <span
                  style={{
                    width: '17px',
                    height: '17px',
                    borderRadius: '50%',
                    border: `1.5px solid ${selected ? '#111827' : '#CFC8B8'}`,
                    marginTop: '2px',
                    flexShrink: 0,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {selected && (
                    <span
                      style={{
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: '#111827',
                      }}
                    />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <b
                    style={{
                      fontSize: '14px',
                      fontWeight: 500,
                      display: 'block',
                      color: 'hsl(var(--foreground))',
                    }}
                  >
                    {preset.label}
                  </b>
                  <p
                    style={{
                      fontSize: '12.5px',
                      color: 'hsl(var(--muted-foreground))',
                      margin: '2px 0 0',
                      lineHeight: 1.5,
                    }}
                  >
                    {preset.desc}
                  </p>
                </span>
                {preset.id === 'balanced' && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: '11px',
                      color: 'hsl(var(--brass))',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Recommended
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </CollapsibleSection>

      {/* Plain-English SummaryLine */}
      <SummaryLine className="my-2">
        “Keep at least <em>{policy.minStablecoin}%</em> safe, put at most <em>{policy.maxDeployment}%</em> to work, never more than <em>{policy.maxLending}%</em> in one place — only in places we&apos;ve approved.”
      </SummaryLine>

      {/* Capital constraints — hairline sliders */}
      <CollapsibleSection title="Capital Constraints" subtitle="Enforced on-chain by the Guardrail agent">
        <div>
          <PolicySlider
            label="Minimum Stablecoin Reserve"
            hint="Never invested, so bills and surprises are always covered."
            value={policy.minStablecoin}
            onChange={(v) => setPolicy({ minStablecoin: v, riskPreset: 'custom' })}
            accent
          />
          <PolicySlider
            label="Maximum Treasury Deployment"
            hint="The ceiling for earning placements across approved DeFi protocols."
            value={policy.maxDeployment}
            onChange={(v) => setPolicy({ maxDeployment: v, riskPreset: 'custom' })}
          />
          <PolicySlider
            label="Maximum Lending Exposure"
            hint="Most in any single place — spreads venue risk."
            value={policy.maxLending}
            onChange={(v) => setPolicy({ maxLending: v, riskPreset: 'custom' })}
          />
          <PolicySlider
            label="Liquidity Reserve"
            hint="Minimum instantly-liquid capital."
            value={policy.liquidityReserve}
            onChange={(v) => setPolicy({ liquidityReserve: v, riskPreset: 'custom' })}
          />
        </div>
      </CollapsibleSection>

      {/* Approved protocols — hairline toggles */}
      <CollapsibleSection title="Approved Protocols">
        <div>
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
                className="flex items-center justify-between gap-3"
                style={{
                  padding: '13px 0',
                  borderBottom: '1px solid hsl(var(--surface-2))',
                  opacity: disabled ? 0.62 : 1,
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>
                      {p.label}
                    </span>
                    <span
                      className="nave-mono px-1.5 py-0.5 rounded"
                      style={{
                        fontSize: '10.5px',
                        backgroundColor: 'hsl(var(--surface-1))',
                        color: 'hsl(var(--muted-foreground))',
                      }}
                      title={rate ? `Live mainnet rate (${rate.source.split(':')[0]})` : 'Reference rate from Oct 10, 2026; live rate not loaded'}
                    >
                      {apyLabel}
                    </span>
                    {venue && <TierBadge tier={venue.tier} />}
                    {venue && !venue.stable && (
                      <span
                        className="px-1.5 py-0.5 rounded"
                        style={{ fontSize: '10px', fontWeight: 600, backgroundColor: 'hsl(var(--warning-muted))', color: '#9A7414' }}
                      >
                        {venue.asset}, not stable
                      </span>
                    )}
                    {p.badge === 'beta' && (
                      <span
                        className="px-1.5 py-0.5 rounded uppercase"
                        style={{ fontSize: '9.5px', fontWeight: 600, letterSpacing: '0.03em', backgroundColor: 'hsl(var(--surface-2))', color: 'hsl(var(--foreground))' }}
                        title={p.badgeReason ?? 'Beta: newer, less battle-tested integration.'}
                      >
                        Beta
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
                    {disabled && evmStatus ? evmStatus.reason : (p.badge === 'beta' && p.badgeReason ? p.badgeReason : p.desc)}
                  </div>
                  {venue && (
                    <div style={{ fontSize: '11.5px', color: 'hsl(var(--faint))', marginTop: '2px' }}>
                      Exit: {venue.exitNote}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => toggleProtocol(p.key)}
                  disabled={disabled}
                  className="flex-shrink-0 relative rounded-full ml-3"
                  style={{
                    width: '38px',
                    height: '22px',
                    backgroundColor: enabled ? '#111827' : '#E5E0D2',
                    transition: 'background-color 0.18s',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                  title={disabled && evmStatus ? evmStatus.reason : `Toggle ${p.label}`}
                >
                  <span
                    className="absolute top-[2px] rounded-full bg-white"
                    style={{
                      width: '18px',
                      height: '18px',
                      left: enabled ? '18px' : '2px',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
                      transition: 'left 0.18s',
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

      {/* Automation — rebalance pills */}
      <CollapsibleSection title="Automation & Operations">
        <div className="space-y-4">
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '13px',
                fontWeight: 600,
                marginBottom: '8px',
                color: 'hsl(var(--foreground))',
              }}
            >
              Rebalancing Frequency
            </label>
            <div className="flex flex-wrap gap-2">
              {REBALANCE_OPTIONS.map((opt) => {
                const selected = policy.rebalanceFreq === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setPolicy({ rebalanceFreq: opt })}
                    className="rounded-full border transition-all"
                    style={{
                      padding: '8px 14px',
                      fontSize: '13px',
                      fontWeight: selected ? 600 : 400,
                      backgroundColor: selected ? '#111827' : '#ffffff',
                      borderColor: selected ? '#111827' : 'hsl(var(--border))',
                      color: selected ? '#ffffff' : 'hsl(var(--foreground))',
                    }}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* Live sim result */}
      <SimResult policy={policy} />
    </div>
  );
}
