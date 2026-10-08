// ─── Strategy readiness — typed browser-side wrapper ─────────────────────────
// Wraps the runtime-agnostic data in `strategyReadinessData.mjs` (the actual
// single source of truth, also consumed directly by `scripts/mainnet-cutover.mjs`
// under Node) with types and Vite env-var resolution. This is the ONE place
// the UI (ConstitutionStep, Assets, PolicyEngine, CreateDAO, ProposalCard —
// via the `programConfig.ts` re-exports kept for backward compatibility)
// should read strategy support/config/badge state from.
import type { EvmChainId } from './chain/types';
import {
  SOLANA_STRATEGIES,
  EVM_STRATEGIES,
  EVM_TESTNET_ADAPTER_FALLBACKS,
  EVM_MAINNET_CHAIN_IDS,
} from './strategyReadinessData.mjs';
import { readViteEnv } from './viteEnv';

// Keys come from the untyped `.mjs` data, so resolve them through the STATIC
// `viteEnv` table rather than `import.meta.env[key]` (which would make Vite
// inline every `VITE_*` var present at build time).
function optionalEnvString(key: string): string | undefined {
  const val = readViteEnv(key);
  if (typeof val !== 'string' || val.trim() === '') return undefined;
  return val.trim();
}

export type StrategyBadge = 'beta';

export interface SolanaStrategyStatus {
  id: string;
  label: string;
  /** Whether the strategy is selectable in the UI right now (flag-gated protocols check their flag). */
  supported: boolean;
  /** Same as `supported` for Solana today — kept for interface parity with EVM's status shape. */
  configured: boolean;
  reason: string;
  badge: StrategyBadge | null;
  badgeReason: string | null;
  mainnetEnvVars: readonly string[];
}

export interface EvmStrategyStatus {
  protocolId: string;
  label: string;
  address: string | null;
  supported: boolean;
  configured: boolean;
  reason: string;
  badge: StrategyBadge | null;
  badgeReason: string | null;
  mainnetEnvVars: readonly string[];
}

/** All Solana strategy ids known to the registry (superset of what may be selectable). */
export const SOLANA_STRATEGY_IDS: readonly string[] = SOLANA_STRATEGIES.map((s) => s.id);

function solanaFlagSatisfied(entry: (typeof SOLANA_STRATEGIES)[number]): boolean {
  if (!entry.requiresFlagEnvVar) return true;
  return optionalEnvString(entry.requiresFlagEnvVar)?.toLowerCase() === 'true';
}

/** Full status for every known Solana strategy, flag-gated ones reflected accurately. */
export function getSolanaStrategyStatuses(): SolanaStrategyStatus[] {
  return SOLANA_STRATEGIES.map((entry) => {
    const supported = solanaFlagSatisfied(entry);
    return {
      id: entry.id,
      label: entry.label,
      supported,
      configured: supported,
      reason: supported
        ? 'Live on this deployment.'
        : `Hidden until ${entry.requiresFlagEnvVar} is set to "true".`,
      badge: (entry.badge as StrategyBadge | null) ?? null,
      badgeReason: entry.badgeReason ?? null,
      mainnetEnvVars: entry.mainnetEnvVars,
    };
  });
}

/** Selectable Solana strategy ids only (excludes flag-gated-off protocols). Backward-compat shape. */
export function getSelectableSolanaStrategyIds(): string[] {
  return getSolanaStrategyStatuses()
    .filter((s) => s.supported)
    .map((s) => s.id);
}

/** True when the MarginFi strategy's gating flag is enabled for this deployment. */
export function isMarginfiStrategyEnabled(): boolean {
  return getSolanaStrategyStatuses().find((s) => s.id === 'marginfi')?.supported ?? false;
}

export type EvmAdapterProtocolId =
  | 'aave'
  | 'compound'
  | 'balancer'
  | 'arbitrum-bridge'
  | 'cctp'
  | 'op-standard-bridge';

function getRawEvmAdapterAddress(chainId: EvmChainId, protocolId: EvmAdapterProtocolId): string | null {
  const entry = EVM_STRATEGIES.find((s) => s.id === protocolId);
  const envVar = entry?.chains[chainId]?.envVar;
  const configured = envVar ? optionalEnvString(envVar) : undefined;
  const fallback = (
    EVM_TESTNET_ADAPTER_FALLBACKS as Record<number, Partial<Record<string, string>>>
  )[chainId]?.[protocolId];
  const address = configured ?? fallback;
  if (!address || /^0x0{40}$/i.test(address)) return null;
  return address;
}

/** Full status for one EVM adapter on one chain. Same shape as the pre-registry `EvmAdapterStatus`. */
export function getEvmAdapterStatus(chainId: EvmChainId, protocolId: EvmAdapterProtocolId): EvmStrategyStatus {
  const entry = EVM_STRATEGIES.find((s) => s.id === protocolId);
  const rule = entry?.chains[chainId] ?? { supported: true, reason: 'Supported when a Nave adapter address is configured.' };
  const address = getRawEvmAdapterAddress(chainId, protocolId);
  const supported = rule.supported || (!!address && !!rule.configurableWithAdapter);
  return {
    protocolId,
    label: entry?.label ?? protocolId,
    address,
    supported,
    configured: supported && !!address,
    reason: address && supported ? `${rule.reason} Adapter address is configured.` : rule.reason,
    badge: (entry?.badge as StrategyBadge | null) ?? null,
    badgeReason: entry?.badgeReason ?? null,
    mainnetEnvVars: rule.envVar ? [rule.envVar] : [],
  };
}

export function getEvmAdapterStatuses(chainId: EvmChainId): EvmStrategyStatus[] {
  return EVM_STRATEGIES.map((entry) => getEvmAdapterStatus(chainId, entry.id as EvmAdapterProtocolId));
}

export function getEvmAdapterAddress(chainId: EvmChainId, protocolId: EvmAdapterProtocolId): string | null {
  const status = getEvmAdapterStatus(chainId, protocolId);
  return status.configured ? status.address : null;
}

export interface EvmAdapterAddressEntry {
  protocolId: EvmAdapterProtocolId;
  address: string;
}

export function getConfiguredEvmAdapters(chainId: EvmChainId): EvmAdapterAddressEntry[] {
  return getEvmAdapterStatuses(chainId)
    .map((status): EvmAdapterAddressEntry | null =>
      status.configured && status.address ? { protocolId: status.protocolId as EvmAdapterProtocolId, address: status.address } : null,
    )
    .filter((entry): entry is EvmAdapterAddressEntry => entry !== null);
}

export function isConfiguredEvmAdapterAddress(chainId: EvmChainId, adapter: string): boolean {
  const normalized = adapter.trim().toLowerCase();
  return getConfiguredEvmAdapters(chainId).some((entry) => entry.address.toLowerCase() === normalized);
}

/**
 * A single "what's left to flip on for mainnet" row, across both Solana and
 * EVM. Solana strategies are chain-agnostic (one row); EVM strategies get one
 * row per mainnet chain id (1 = Ethereum, 8453 = Base) since each needs its
 * own deployed adapter address. `envVarsSet`/`ready` are computed from
 * whatever env vars are ACTUALLY present in this running deployment right
 * now — this is a live readiness snapshot, not a static list.
 */
export interface MainnetReadinessRow {
  chainFamily: 'solana' | 'evm';
  evmChainId?: EvmChainId;
  id: string;
  label: string;
  mainnetEnvVars: readonly string[];
  envVarsSet: boolean;
  /** False for strategies explicitly deferred (e.g. Balancer without a validated pool) — not part of the mainnet-readiness gap. */
  expectedAtMainnet: boolean;
}

export function getMainnetReadinessChecklist(): MainnetReadinessRow[] {
  const rows: MainnetReadinessRow[] = [];
  for (const entry of SOLANA_STRATEGIES) {
    rows.push({
      chainFamily: 'solana',
      id: entry.id,
      label: entry.label,
      mainnetEnvVars: entry.mainnetEnvVars,
      envVarsSet: entry.mainnetEnvVars.every((v: string) => !!optionalEnvString(v)),
      expectedAtMainnet: true,
    });
  }
  for (const entry of EVM_STRATEGIES) {
    for (const chainId of EVM_MAINNET_CHAIN_IDS as EvmChainId[]) {
      const rule = entry.chains[chainId];
      if (!rule) continue;
      rows.push({
        chainFamily: 'evm',
        evmChainId: chainId,
        id: entry.id,
        label: entry.label,
        mainnetEnvVars: rule.envVar ? [rule.envVar] : [],
        envVarsSet: rule.envVar ? !!optionalEnvString(rule.envVar) : false,
        expectedAtMainnet: rule.supported,
      });
    }
  }
  return rows;
}
