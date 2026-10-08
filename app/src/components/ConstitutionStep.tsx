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

const SOLANA_STRATEGY_STATUS_BY_ID = new Map(
  getSolanaStrategyStatuses().map((status) => [status.id, status]),
);
const MARGINFI_STRATEGY_ENABLED = SOLANA_STRATEGY_STATUS_BY_ID.get('marginfi')?.supported ?? false;

// ── Types ─────────────────────────────────────────────────────────────────────

export type RiskPreset = 'conservative' | 'balanced' | 'aggressive' | 'custom';

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
   * Preset cards to offer. Create's first constitution card offers Conservative
   * and Balanced; Aggressive and Custom stay on the amend flow.
   */
  offeredPresets?: readonly RiskPreset[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const RISK_PRESETS: { id: RiskPreset; label: string; desc: string }[] = [
  { id: 'conservative', label: 'Conservative', desc: 'Capital preservation. Low risk, steady yield.' },
  { id: 'balanced',     label: 'Balanced',     desc: 'Moderate risk-return profile.' },
  { id: 'aggressive',   label: 'Aggressive',   desc: 'Maximise yield. Higher risk tolerance.' },
  { id: 'custom',       label: 'Custom',        desc: 'Define your own parameters.' },
];

export const PRESET_DEFAULTS: Record<RiskPreset, Partial<PolicyState>> = {
  conservative: { minStablecoin: 60, maxDeployment: 40, maxLending: 20, liquidityReserve: 25 },
  balanced:     { minStablecoin: 35, maxDeployment: 65, maxLending: 40, liquidityReserve: 15 },
  aggressive:   { minStablecoin: 15, maxDeployment: 85, maxLending: 70, liquidityReserve: 8  },
  custom:       {},
};

export const PROTOCOLS_SOLANA = [
  { key: 'kamino',   label: 'Kamino',   desc: 'Automated liquidity & lending strategies', apy: '7–11%', badge: null as 'beta' | null, badgeReason: null as string | null },
  ...(MARGINFI_STRATEGY_ENABLED
    ? [{ key: 'marginfi', label: 'MarginFi', desc: 'Lending / borrowing protocol', apy: '5–9%', badge: null as 'beta' | null, badgeReason: null as string | null }]
    : []),
  { key: 'jito',    label: 'Jito',    desc: 'Liquid staking (jitoSOL)',                  apy: '6–8%', badge: null as 'beta' | null, badgeReason: null as string | null },
  {
    key: 'jupiter',
    label: 'Jupiter',
    desc: 'Lend Earn — yield on stablecoins and SOL',
    apy: '4–8%',
    badge: SOLANA_STRATEGY_STATUS_BY_ID.get('jupiter')?.badge ?? null,
    badgeReason: SOLANA_STRATEGY_STATUS_BY_ID.get('jupiter')?.badgeReason ?? null,
  },
];

export const PROTOCOLS_EVM = [
  { key: 'aave',     label: 'Aave V3',    desc: 'Lending and borrowing markets',  apy: '3–8%',  badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'compound', label: 'Compound V3', desc: 'Blue-chip lending protocol',     apy: '3–7%',  badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'balancer', label: 'Balancer',    desc: 'Weighted liquidity pools',       apy: '4–10%', badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'arbitrum-bridge', label: 'Arbitrum Bridge', desc: 'Bridge WETH to Ethereum sister treasury', apy: '—', badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'cctp', label: 'CCTP USDC', desc: 'Circle CCTP USDC to sister treasury', apy: '—', badge: null as 'beta' | null, badgeReason: null as string | null },
  { key: 'op-standard-bridge', label: 'OP Bridge', desc: 'Base ↔ Ethereum ETH/WETH StandardBridge', apy: '—', badge: null as 'beta' | null, badgeReason: null as string | null },
];

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
  if (chain === 'solana') return base;
  const approvedProtocols: Record<string, boolean> = {};
  for (const status of getEvmAdapterStatuses(activeEvmChainId(chain))) {
    approvedProtocols[status.protocolId] = status.configured;
  }
  return { ...base, approvedProtocols };
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
  const protocolOptions = (chain === 'evm' ? PROTOCOLS_EVM : PROTOCOLS_SOLANA).filter((p) => {
    if (chain !== 'evm') return true;
    const status = evmStatusByProtocol.get(p.key as EvmAdapterProtocolId);
    return !!(status?.configured && status.address && !/^0x0{40}$/i.test(status.address));
  });
  const evmAdapterStatuses = useMemo(
    () => (chain === 'evm' && evmChainId ? getEvmAdapterStatuses(evmChainId) : []),
    [chain, evmChainId],
  );
  const evmStatusByProtocol = useMemo(
    () => new Map(evmAdapterStatuses.map((s) => [s.protocolId, s])),
    [evmAdapterStatuses],
  );

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

  if (readOnly) {
    return <ConstitutionSummary policy={policy} chain={chain} evmChainId={evmChainId} />;
  }

  function applyPreset(preset: RiskPreset) {
    setPolicy({ riskPreset: preset, ...PRESET_DEFAULTS[preset] });
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
                    >
                      {p.apy}
                    </span>
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
