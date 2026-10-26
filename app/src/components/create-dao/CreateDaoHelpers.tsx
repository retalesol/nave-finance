import Fi from '../Fi';
import { type ChainFamily } from '../../lib/chain/types';

export type GovernanceType = 'token' | 'wallets' | null;
export type TokenMode = 'existing' | 'new' | null;
export type SetupMode = 'quick' | 'advanced';

export interface DAOConfig {
  /** Target chain for this treasury (Solana, Ethereum, or Base). */
  chain: ChainFamily;
  name: string;
  slug: string;
  description: string;
  treasuryPurpose?: string;
  logoBlob: Blob | null;
  logoPreview: string | null;
  governanceType: GovernanceType;
  authorizedWallets: string[];
  website: string;
  twitter: string;
  discord: string;
  tokenMode: TokenMode;
  existingTokenCA: string;
  newTokenName: string;
  newTokenSupply: string;
}

/** On-chain DAO and token names are measured in UTF-8 bytes, capped at 32. */
export const MAX_ONCHAIN_NAME_BYTES = 32;
/** `NaveTreasury.registerDaoToken` rejects a symbol longer than this. */
export const MAX_TOKEN_SYMBOL_LEN = 8;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function fitsOnchainName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && utf8ByteLength(trimmed) <= MAX_ONCHAIN_NAME_BYTES;
}

/** Symbol written at EVM token registration. Longer names are cut to 8 characters. */
export function evmTokenSymbol(name: string): string {
  const symbol = name.trim().toUpperCase().slice(0, MAX_TOKEN_SYMBOL_LEN);
  return symbol.length > 0 ? symbol : 'DAO';
}

export const DEFAULT_CONFIG: DAOConfig = {
  chain: 'solana',
  name: '',
  slug: '',
  description: 'Revenue and support, shared with a community.',
  treasuryPurpose: 'Creators & fans',
  logoBlob: null,
  logoPreview: null,
  governanceType: 'wallets',
  authorizedWallets: [],
  website: '',
  twitter: '',
  discord: '',
  tokenMode: 'existing',
  existingTokenCA: '',
  newTokenName: '',
  newTokenSupply: '1000000',
};

export const ADVANCED_STEPS = [
  { label: 'About',      icon: 'building'   },
  { label: 'Behaviour',  icon: 'shield'     },
  { label: 'Launch',     icon: 'rocket'     },
];

export const QUICK_STEPS = ADVANCED_STEPS;

/** Human-readable labels for the finer-grained post-creation sub-steps tracked
 *  for "Resume setup" checkpoints (distinct from the visible DeployStep rows). */
export const EVM_SUB_STEP_LABELS: Record<string, string> = {
  create: 'Creating treasury',
  'bind-keys': 'Binding agent keys',
  'token-registration': 'Registering governance token',
  'register-metadata': 'Saving DAO metadata',
  activate: 'Activating constitution & policy',
};

export const SOLANA_SUB_STEP_LABELS: Record<string, string> = {
  foundation: 'Creating DAO foundation',
  governance: 'Setting up DAO governance & extensions',
  activate: 'Activating constitution & policy',
  'register-metadata': 'Saving DAO metadata',
};

export const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

export function treasuryNativeLabel(chain: ChainFamily): string {
  if (chain === 'solana') return 'SOL';
  if (chain === 'arc') return 'USDC';
  return 'ETH';
}

export function displayStepIndex(step: number, setupMode: SetupMode): number {
  if (setupMode === 'quick') {
    if (step === 0) return 0;
    if (step === 2) return 1;
    if (step >= 3) return 2;
  }
  return step;
}

/**
 * Guardian set size the deploy flow will submit for the current config:
 * authorized wallets (founder auto-included) — or just the founder for token
 * governance — plus, on EVM, the Nave-custodied guardian generated alongside
 * the agent keys. Mirrors the `guardianWallets` assembly in the deploy handlers.
 */
export function previewGuardianCount(config: DAOConfig): number {
  const base =
    config.governanceType === 'wallets' && config.authorizedWallets.length > 0
      ? config.authorizedWallets.length
      : 1;
  return config.chain === 'solana' ? base : base + 1;
}

export function SetupModeChooser({ onSelect }: { onSelect: (mode: SetupMode) => void }) {
  return (
    <div className="space-y-6">
      <div>
        <div className="nave-label" style={{ marginBottom: '10px' }}>New treasury</div>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 400,
            fontSize: '34px',
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            margin: '0 0 8px',
          }}
        >
          Create a treasury
        </h2>
        <p style={{ fontSize: '14.5px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
          Choose how much configuration you want upfront. You can customize everything later.
        </p>
      </div>
      <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
        {([
          {
            mode: 'quick' as SetupMode,
            label: 'Quick setup',
            desc: 'Name, network, and sensible defaults. Logo, social links, and constitution sliders can wait until after creation.',
            badge: 'Recommended',
          },
          {
            mode: 'advanced' as SetupMode,
            label: 'Advanced setup',
            desc: 'Full wizard with governance options, constitution presets, and optional branding before deploy.',
          },
        ]).map((opt) => (
          <button
            key={opt.mode}
            type="button"
            onClick={() => onSelect(opt.mode)}
            className="w-full flex items-start gap-3 py-3.5 text-left"
            style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
          >
            <div className="flex-1 min-w-0">
              <div style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>
                {opt.label}
              </div>
              <p style={{ fontSize: '12.5px', lineHeight: 1.5, color: 'hsl(var(--muted-foreground))', margin: '2px 0 0' }}>
                {opt.desc}
              </p>
            </div>
            {'badge' in opt && opt.badge && (
              <span
                className="ml-auto flex-shrink-0"
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'hsl(var(--brass))',
                }}
              >
                {opt.badge}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export function StepIndicator({ steps, current }: { steps: typeof ADVANCED_STEPS; current: number }) {
  return (
    <div
      className="flex items-center gap-2 flex-wrap"
      style={{ fontSize: '12.5px', color: 'hsl(var(--faint))' }}
    >
      {steps.map((step, idx) => {
        const active = idx === current;
        const done = idx < current;
        return (
          <div key={step.label} className="flex items-center gap-2">
            <span
              style={{
                fontWeight: active ? 600 : 400,
                color: active
                  ? 'hsl(var(--foreground))'
                  : done
                    ? 'hsl(var(--muted-foreground))'
                    : 'hsl(var(--faint))',
              }}
            >
              {idx + 1} · {step.label}
            </span>
            {idx < steps.length - 1 && (
              <span
                style={{
                  width: '26px',
                  height: '1px',
                  backgroundColor: 'hsl(var(--border))',
                  display: 'inline-block',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: '26px' }}>
      <label
        className="block"
        style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'hsl(var(--foreground))' }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <div style={{ fontSize: '12.5px', color: 'hsl(var(--faint))', marginTop: '7px', lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono = false,
  type = 'text',
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
  maxLength?: number;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      className="w-full rounded-[10px] border outline-none transition-colors"
      style={{
        padding: '11px 13px',
        fontSize: '14.5px',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-body)',
        backgroundColor: '#ffffff',
        borderColor: 'hsl(var(--border))',
        color: 'hsl(var(--foreground))',
      }}
      onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
      onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
    />
  );
}
export { Fi };
