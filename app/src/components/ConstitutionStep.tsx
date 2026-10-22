// Shared constitution configuration UI — used by the 4-step CreateDAO wizard
// and by PolicyEngine (post-create amend flow). Chain-aware: Solana strategy
// support/badges come from `getSolanaStrategyStatuses()`; EVM uses
// `getEvmAdapterStatuses()` — both from `strategyReadiness.ts`, the single
// source of truth for "is this strategy actually live" across the app AND
// the mainnet-cutover preflight gate.

import { useMemo } from 'react';
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
  constitutionCapsBps,
  effectiveApy,
  findVenue,
  strategyChainForEvmId,
  type RiskTier,
  type StrategyChain,
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
   * Preset cards to offer. Defaults to the 3 demo postures (Careful, Balanced, Bold).
   */
  offeredPresets?: readonly RiskPreset[];
  /** When true, includes the minimum balance to rebalance (USD) input inside Customise the numbers. */
  showAgentThreshold?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const RISK_PRESETS: { id: RiskPreset; label: string; desc: string }[] = [
  { id: 'conservative', label: 'Careful',         desc: 'Half stays safe. Modest, steady earnings.' },
  { id: 'balanced',     label: 'Balanced',        desc: 'A strong cushion, most of the rest earning.' },
  { id: 'yield6',       label: 'Yield 6% target', desc: 'Adds Tier 3 credit and fixed-term venues (at most 15%). Not guaranteed.' },
  { id: 'aggressive',   label: 'Bold',            desc: 'Thin cushion, maximum working capital.' },
  { id: 'custom',       label: 'Custom',          desc: 'Define your own parameters.' },
];

export const POSTURE_OPTIONS: { id: RiskPreset; label: string; desc: string; recommended?: boolean }[] = [
  { id: 'conservative', label: 'Careful',  desc: 'Half stays safe. Modest, steady earnings.' },
  { id: 'balanced',     label: 'Balanced', desc: 'A strong cushion, most of the rest earning.', recommended: true },
  { id: 'aggressive',   label: 'Bold',     desc: 'Thin cushion, maximum working capital.' },
];

const BRIDGE_ADAPTER_KEYS = new Set([
  'arbitrum-bridge',
  'arbitrum_bridge',
  'cctp',
  'op-standard-bridge',
  'optimism_bridge',
]);

export function isBridgeAdapterKey(key: string): boolean {
  return BRIDGE_ADAPTER_KEYS.has(key);
}

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
    if (isBridgeAdapterKey(p.key)) return false;
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

// ── Main component ─────────────────────────────────────────────────────────────

export default function ConstitutionStep({
  policy,
  setPolicy,
  chain,
  evmChainId,
  readOnly = false,
  showAgentThreshold = false,
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
    if (isBridgeAdapterKey(p.key)) return false;
    if (chain !== 'evm') return true;
    const status = evmStatusByProtocol.get(p.key as EvmAdapterProtocolId);
    return !!(status?.configured && status.address && !/^0x0{40}$/i.test(status.address));
  });

  const strategyChain = strategyChainFor(chain, evmChainId);
  const { rates } = useStrategyRates(readOnly ? null : strategyChain);

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
      {/* Risk preset — demo #wiz2 radio options */}
      <div style={{ marginBottom: '18px' }}>
        <label
          style={{
            display: 'block',
            fontSize: '13px',
            fontWeight: 600,
            marginBottom: '8px',
            color: 'hsl(var(--foreground))',
          }}
        >
          How careful should your agents be?
        </label>
        <div
          className="flex flex-col"
          style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
        >
          {POSTURE_OPTIONS.map((preset) => {
            const selected =
              policy.riskPreset === preset.id ||
              (preset.id === 'aggressive' && policy.riskPreset === 'yield6');
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
                {preset.recommended && (
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
      </div>

      {/* Plain-English SummaryLine */}
      <SummaryLine className="my-2">
        “Keep at least <em>{policy.minStablecoin}%</em> safe, put at most <em>{policy.maxDeployment}%</em> to work, never more than <em>{policy.maxLending}%</em> in one place — only in places we&apos;ve approved.”
      </SummaryLine>

      {/* Expandable Customise the numbers disclosure matching demo #wiz2 */}
      <details
        className="custom"
        style={{
          marginTop: '14px',
          borderBottom: '1px solid hsl(var(--surface-2))',
          paddingBottom: '12px',
        }}
      >
        <summary
          style={{
            fontSize: '13px',
            fontWeight: 500,
            color: 'hsl(var(--muted-foreground))',
            cursor: 'pointer',
            padding: '8px 0',
            userSelect: 'none',
          }}
        >
          Customise the numbers
        </summary>

        <div className="pt-2 space-y-6">
          {/* 3 Demo Sliders */}
          <div>
            <PolicySlider
              label="Keep safe in reserve"
              hint="Never invested, so surprises are always covered."
              min={10}
              max={80}
              value={policy.minStablecoin}
              onChange={(v) => setPolicy({ minStablecoin: v, liquidityReserve: Math.min(policy.liquidityReserve, v), riskPreset: 'custom' })}
              accent
            />
            <PolicySlider
              label="Most that can be put to work"
              hint="The ceiling for earning placements."
              min={20}
              max={90}
              value={policy.maxDeployment}
              onChange={(v) => setPolicy({ maxDeployment: v, riskPreset: 'custom' })}
            />
            <PolicySlider
              label="Most in any single place"
              hint="Spreads the risk."
              min={10}
              max={80}
              value={policy.maxLending}
              onChange={(v) => setPolicy({ maxLending: v, riskPreset: 'custom' })}
            />
          </div>

          {/* Approved places (merged with Strategy Menu — single list with inline APY) */}
          <div data-testid="strategy-menu">
            <label
              style={{
                display: 'block',
                fontSize: '13px',
                fontWeight: 600,
                marginBottom: '6px',
                color: 'hsl(var(--foreground))',
              }}
            >
              Approved places
            </label>
            {protocolOptions.length === 0 && chain === 'evm' && (
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
                No earning places are configured on this network yet.
              </p>
            )}
            <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
              {protocolOptions.map((p) => {
                const evmStatus = chain === 'evm'
                  ? evmStatusByProtocol.get(p.key as EvmAdapterProtocolId)
                  : undefined;
                const disabled = chain === 'evm' && !evmStatus?.configured;
                const enabled = !disabled && !!policy.approvedProtocols[p.key];
                const venue = strategyChain ? findVenue(strategyChain, p.key) : undefined;
                const rate = venue ? rates.get(venue.id) : undefined;
                const apyLabel = venue && venue.rate
                  ? `${formatApy(effectiveApy(rate, venue.fallbackApy))}/yr`
                  : null;
                return (
                  <div
                    key={p.key}
                    data-testid={`strategy-venue-${p.key}`}
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
                        {apyLabel && (
                          <span
                            className="nave-mono"
                            style={{
                              fontSize: '12px',
                              color: '#2F7D4F',
                              fontWeight: 500,
                            }}
                          >
                            {apyLabel}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
                        {disabled && evmStatus ? evmStatus.reason : p.desc}
                        {venue ? ` · Exit: ${venue.exitNote}` : ''}
                      </div>
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
          </div>

          {/* Rebalancing cadence */}
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
              Rebalancing cadence
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
                      padding: '7px 14px',
                      fontSize: '12.5px',
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

          {showAgentThreshold && (
            <div
              style={{
                paddingTop: '14px',
                borderTop: '1px solid hsl(var(--surface-2))',
              }}
            >
              <label
                style={{
                  display: 'block',
                  fontSize: '13px',
                  fontWeight: 600,
                  marginBottom: '6px',
                  color: 'hsl(var(--foreground))',
                }}
              >
                Minimum balance to rebalance (USD)
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={policy.agentThresholdUsd ?? 1000}
                onChange={(e) => {
                  const val = Math.max(1, Number(e.target.value) || 1);
                  setPolicy({ agentThresholdUsd: val });
                }}
                className="w-full max-w-[200px] px-3 py-2 rounded-[10px] border outline-none nave-mono"
                style={{
                  fontSize: '13.5px',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              />
              <p style={{ fontSize: '12px', color: 'hsl(var(--faint))', marginTop: '5px' }}>
                Avoids fiddling with small balances.
              </p>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
