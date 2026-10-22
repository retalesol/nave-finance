import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { useAccount, useSignMessage } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { getTransactionReceipt, readContract } from '@wagmi/core';
import { decodeEventLog, isAddress, parseEther, parseUnits, formatUnits, type Address } from 'viem';
import { wagmiConfig } from '../lib/evm/wagmi';
import Fi from '../components/Fi';
import LogoUpload from '../components/LogoUpload';
import ChainSelector from '../components/ChainSelector';
import TreasuryDeployModal, { type DeployStep, type DeployStepStatus } from '../components/TreasuryDeployModal';
import ConstitutionStep, {
  type PolicyState,
  policyForChain,
  PROTOCOLS_SOLANA,
  PROTOCOLS_EVM,
  RISK_PRESETS,
  rebalanceFreqToSecs,
} from '../components/ConstitutionStep';
import { useDaoContext } from '../hooks/useDaoContext';
import { useChain } from '../hooks/useChain';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { buildCreateDaoEvm, buildRegisterDaoTokenEvm, buildRegisterExternalDaoTokenEvm, type EvmCreateDaoParams } from '../lib/evm/writers';
import { NaveDAOFactoryAbi, NaveTreasuryAbi, Erc20Abi } from '../lib/evm/contracts';
import { fetchFormationFeeEvm, fetchFactoryAddressEvm } from '../lib/evm/readers';
import { ensureWalletOnChain } from '../lib/evm/ensureWalletChain';
import { toAddress } from '../lib/evm/addresses';
import { EVM_PROTOCOL_REVENUE_WALLET, SOLANA_NETWORK, activeEvmChainId, chainDisplayLabel, SYSTEM_CONFIDENCE_THRESHOLD, EVM_DEPLOYMENT_MODE } from '../lib/programConfig';
import { type ChainFamily, type DaoEvmChainFamily, type EvmChainId, evmActivationChainFamily, USER_CHAINS } from '../lib/chain/types';
import {
  buildInitializeDao,
  buildInitializeDaoExtensions,
  buildInitializeDaoGovernance,
  buildRegisterDaoToken,
  type InitializeDaoParams,
  type TransactionBuildResult,
} from '../lib/transactionBuilders';
import { getDaoRegistryPDA, getNaveGlobalConfigPDA, getVaultAuthorityPDA, getAgentSetPDA } from '../lib/pdaDerivation';
import { getNavePrograms } from '../lib/naveProgram';
import { generateAgentKeys, registerDao, generateEvmAgentKeys, bindEvmAgentKeys, setAgentsEnabledViaProxy, solanaAccessSigner } from '../lib/edgeFunctionClient';
import {
  runSolanaAutoActivation,
  type ActivationStepId,
} from '../lib/createDaoActivation';
import { runEvmActivation } from '../lib/createDaoActivationEvm';
import { uploadDaoLogo } from '../lib/uploadLogo';
import {
  MANAGEMENT_FEE_BPS_NORMAL,
  MANAGEMENT_FEE_BPS_FROZEN,
  PERFORMANCE_FEE_BPS,
  FROZEN_PERFORMANCE_FEE_BPS,
  TOKEN_MINT_FEE_SOL,
  TOKEN_MINT_FEE_ETH,
  AGENT_WALLET_SEED_SOL,
  AGENT_WALLET_TOTAL_SEED_SOL,
  DAO_FORMATION_FEE_SOL,
  TREASURY_SEED_SOL,
  NAVE_PROTOCOL_FEE_WALLET,
  defaultGuardianThreshold,
} from '../lib/programConfig';
import {
  checkDaoSlugAvailability,
  formatDaoSlugLabel,
  getDaoPublicUrl,
  normalizeDaoSlug,
  validateDaoSlug,
} from '../lib/daoSlug';
import {
  savePendingDaoCreation,
  clearPendingDaoCreation,
  findPendingDaoCreationForWallet,
  type PendingDaoCreation,
} from '../lib/daoCreationRecovery';

/* ── Types ──────────────────────────────────────────────── */
type GovernanceType = 'token' | 'wallets' | null;
type TokenMode = 'existing' | 'new' | null;

interface DAOConfig {
  /** Target chain for this treasury (Solana, Ethereum, or Base). */
  chain: ChainFamily;
  name: string;
  slug: string;
  description: string;
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

const DEFAULT_CONFIG: DAOConfig = {
  chain: 'solana',
  name: '',
  slug: '',
  description: '',
  logoBlob: null,
  logoPreview: null,
  governanceType: null,
  authorizedWallets: [],
  website: '',
  twitter: '',
  discord: '',
  tokenMode: null,
  existingTokenCA: '',
  newTokenName: '',
  newTokenSupply: '1000000',
};

const ADVANCED_STEPS = [
  { label: 'Identity',       icon: 'building'  },
  { label: 'Constitution',   icon: 'shield'     },
  { label: 'Seed & Review',  icon: 'list-check' },
  { label: 'Deploying',      icon: 'rocket'     },
];

const QUICK_STEPS = [
  { label: 'Setup',          icon: 'building'  },
  { label: 'Review',         icon: 'list-check' },
  { label: 'Deploying',      icon: 'rocket'     },
];

/** Human-readable labels for the finer-grained post-creation sub-steps tracked
 *  for "Resume setup" checkpoints (distinct from the visible DeployStep rows). */
const EVM_SUB_STEP_LABELS: Record<string, string> = {
  create: 'Creating treasury',
  'bind-keys': 'Binding agent keys',
  'token-registration': 'Registering governance token',
  'register-metadata': 'Saving DAO metadata',
  activate: 'Activating constitution & policy',
};

const SOLANA_SUB_STEP_LABELS: Record<string, string> = {
  foundation: 'Creating DAO foundation',
  governance: 'Setting up DAO governance & extensions',
  activate: 'Activating constitution & policy',
  'register-metadata': 'Saving DAO metadata',
};

const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

type SetupMode = 'quick' | 'advanced';

function treasuryNativeLabel(chain: ChainFamily): string {
  if (chain === 'solana') return 'SOL';
  if (chain === 'arc') return 'USDC';
  return 'ETH';
}

function displayStepIndex(step: number, setupMode: SetupMode): number {
  if (setupMode === 'quick') {
    if (step === 0) return 0;
    if (step === 2) return 1;
    if (step >= 3) return 2;
  }
  return step;
}
/* ── Setup mode chooser ──────────────────────────────────── */
function SetupModeChooser({ onSelect }: { onSelect: (mode: SetupMode) => void }) {
  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-display mb-1.5" style={{ fontSize: '24px', letterSpacing: '-0.01em' }}>
          Create a treasury
        </h2>
        <p style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))' }}>
          Choose how much configuration you want upfront. You can customize everything later.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {([
          {
            mode: 'quick' as SetupMode,
            icon: 'bolt',
            label: 'Quick setup',
            desc: 'Name, network, and sensible defaults. Logo, social links, and constitution sliders can wait until after creation.',
            badge: 'Recommended',
          },
          {
            mode: 'advanced' as SetupMode,
            icon: 'sliders',
            label: 'Advanced setup',
            desc: 'Full wizard with governance options, constitution presets, and optional branding before deploy.',
          },
        ]).map((opt) => (
          <button
            key={opt.mode}
            onClick={() => onSelect(opt.mode)}
            className="p-5 rounded-xl border text-left transition-all"
            style={{
              backgroundColor: 'hsl(var(--surface-0))',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'hsl(var(--primary))';
              e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'hsl(var(--border))';
              e.currentTarget.style.backgroundColor = 'hsl(var(--surface-0))';
            }}
          >
            <div className="flex items-start justify-between gap-2 mb-3">
              <Fi icon={opt.icon} style={{ fontSize: '18px', color: 'hsl(var(--primary))' }} />
              {'badge' in opt && opt.badge && (
                <span
                  className="px-2 py-0.5 rounded-full"
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    backgroundColor: 'hsl(var(--primary))',
                    color: 'hsl(var(--primary-foreground))',
                  }}
                >
                  {opt.badge}
                </span>
              )}
            </div>
            <div className="font-semibold text-display" style={{ fontSize: '15px', marginBottom: '6px' }}>
              {opt.label}
            </div>
            <p style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'hsl(var(--muted-foreground))' }}>
              {opt.desc}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────── */
function StepIndicator({ steps, current }: { steps: typeof ADVANCED_STEPS; current: number }) {
  return (
    <div className="flex items-center gap-1">
      {steps.map((step, idx) => {
        const done = idx < current;
        const active = idx === current;
        return (
          <div key={step.label} className="flex items-center">
            <div className="flex items-center gap-1.5">
              <div
                className="flex items-center justify-center rounded-full transition-all"
                style={{
                  width: active ? '26px' : '20px',
                  height: active ? '26px' : '20px',
                  backgroundColor:
                    done ? 'hsl(var(--primary))' :
                    active ? 'hsl(var(--primary))' :
                    'hsl(var(--surface-1))',
                  border: active
                    ? '2px solid hsl(var(--primary))'
                    : done ? 'none'
                    : '1px solid hsl(var(--border))',
                  flexShrink: 0,
                }}
              >
                {done ? (
                  <Fi icon="check" style={{ fontSize: '9px', color: 'white' }} />
                ) : (
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: '600',
                      color: active ? 'white' : 'hsl(var(--muted-foreground))',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {idx + 1}
                  </span>
                )}
              </div>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: active ? '500' : '400',
                  color: active ? 'hsl(var(--foreground))' : done ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
                }}
              >
                {step.label}
              </span>
            </div>
            {idx < steps.length - 1 && (
              <div
                className="mx-2 transition-colors"
                style={{
                  width: '24px',
                  height: '1px',
                  backgroundColor: done ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        className="nave-label"
        style={{ fontSize: '12px', fontWeight: '500' }}
      >
        {label}
      </label>
      {hint && (
        <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}>
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono = false,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2.5 rounded-lg border outline-none transition-colors"
      style={{
        fontSize: '13px',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-body)',
        backgroundColor: 'hsl(var(--surface-0))',
        borderColor: 'hsl(var(--border))',
        color: 'hsl(var(--foreground))',
      }}
      onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
      onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
    />
  );
}

/**
 * Guardian set size the deploy flow will submit for the current config:
 * authorized wallets (founder auto-included) — or just the founder for token
 * governance — plus, on EVM, the Nave-custodied guardian generated alongside
 * the agent keys. Mirrors the `guardianWallets` assembly in the deploy handlers.
 */
function previewGuardianCount(config: DAOConfig): number {
  const base =
    config.governanceType === 'wallets' && config.authorizedWallets.length > 0
      ? config.authorizedWallets.length
      : 1;
  return config.chain === 'solana' ? base : base + 1;
}

/* ── Step 1: Identity ─────────────────────────────────────── */
function Step1({
  config,
  setConfig,
  connectedWallet,
  onSlugReadyChange,
  quickMode = false,
}: {
  config: DAOConfig;
  setConfig: (c: Partial<DAOConfig>) => void;
  connectedWallet: string | null;
  onSlugReadyChange: (ready: boolean, message: string | null) => void;
  quickMode?: boolean;
}) {
  const [walletInput, setWalletInput] = useState('');
  const [slugManual, setSlugManual] = useState(false);
  const [slugChecking, setSlugChecking] = useState(false);

  useEffect(() => {
    const slug = config.slug;
    if (!slug.trim()) {
      onSlugReadyChange(false, null);
      return;
    }
    const validation = validateDaoSlug(slug);
    if (!validation.valid) {
      onSlugReadyChange(false, validation.error ?? 'Invalid DAO name');
      return;
    }

    let cancelled = false;
    setSlugChecking(true);
    onSlugReadyChange(false, null);

    const timer = window.setTimeout(async () => {
      const result = await checkDaoSlugAvailability(slug);
      if (cancelled) return;
      setSlugChecking(false);
      if (result.available) {
        onSlugReadyChange(true, null);
      } else {
        onSlugReadyChange(false, result.error ?? `${formatDaoSlugLabel(slug)} is already taken`);
      }
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [config.slug, onSlugReadyChange]);

  function selectGovernance(id: GovernanceType) {
    // When choosing authorized-wallet governance, auto-include the connected
    // wallet as the first authorized signer (the founder is always a guardian).
    if (id === 'wallets' && connectedWallet && config.authorizedWallets.length === 0) {
      setConfig({ governanceType: id, tokenMode: null, authorizedWallets: [connectedWallet] });
    } else {
      setConfig({ governanceType: id, tokenMode: null });
    }
  }

  function addWallet() {
    const v = walletInput.trim();
    if (!v) return;
    const isEvmChain = config.chain !== 'solana';
    const duplicate = config.authorizedWallets.some((w) =>
      isEvmChain ? w.toLowerCase() === v.toLowerCase() : w === v,
    );
    if (duplicate) return;
    // Chain-aware validation: 0x EVM addresses for Ethereum/Base/Robinhood,
    // base58 ed25519 pubkeys for Solana.
    if (isEvmChain) {
      if (!isAddress(v)) return;
    } else {
      try {
        new PublicKey(v);
      } catch {
        return;
      }
    }
    setConfig({ authorizedWallets: [...config.authorizedWallets, v] });
    setWalletInput('');
  }

  function removeWallet(w: string) {
    setConfig({ authorizedWallets: config.authorizedWallets.filter(x => x !== w) });
  }

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-display mb-1.5" style={{ fontSize: '24px', letterSpacing: '-0.01em' }}>
          {quickMode ? 'Quick setup' : 'Treasury identity'}
        </h2>
        <p style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))' }}>
          {quickMode
            ? 'Name your treasury. Wallet governance and the Conservative constitution apply by default.'
            : 'Name your treasury and choose how governance works.'}
        </p>
      </div>

      {quickMode && (
        <div
          className="flex items-start gap-2.5 p-4 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Fi icon="circle-info" style={{ fontSize: '14px', color: 'hsl(var(--primary))', flexShrink: 0, marginTop: '2px' }} />
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
            Uses authorized-wallet governance with your connected wallet as guardian and the Conservative constitution: 60% stays in stablecoins, at most 40% can be deployed, 20% per venue, and 25% stays liquid.
            Add a logo, social links, and amend the rules after creation.
          </p>
        </div>
      )}

      <Field
        label="Treasury network"
        hint={
          EVM_DEPLOYMENT_MODE === 'testnet'
            ? 'Testnet treasuries can launch on Solana, Ethereum, Base, Robinhood, or Arc.'
            : 'Mainnet treasuries stay on Base.'
        }
      >
        <ChainSelector
          value={config.chain}
          onChange={(chain) => setConfig({ chain })}
          chains={USER_CHAINS}
          label=""
        />
      </Field>

      {/* Treasury name (+ optional logo in advanced mode) */}
      <div className={`flex items-start gap-4${quickMode ? '' : ''}`}>
        {!quickMode && (
          <div className="flex-shrink-0">
            <label className="nave-label" style={{ fontSize: '12px', fontWeight: '500', display: 'block', marginBottom: '6px' }}>
              Logo
            </label>
            <LogoUpload
              previewUrl={config.logoPreview}
              onCropped={(blob, dataUrl) => setConfig({ logoBlob: blob, logoPreview: dataUrl })}
              onClear={() => setConfig({ logoBlob: null, logoPreview: null })}
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <label className="nave-label" style={{ fontSize: '12px', fontWeight: '500', display: 'block', marginBottom: '6px' }}>
            Treasury Name
          </label>
          <input
            type="text"
            value={config.name}
            onChange={e => {
              const v = e.target.value;
              const patch: Partial<DAOConfig> = { name: v };
              if (!slugManual) patch.slug = normalizeDaoSlug(v);
              setConfig(patch);
            }}
            placeholder={
              config.chain === 'base'
                ? 'e.g. Base Builders Collective'
                : config.chain === 'robinhood'
                  ? 'e.g. Robinhood Builders Collective'
                  : config.chain === 'ethereum'
                    ? 'e.g. Ethereum Builders Collective'
                    : config.chain === 'arc'
                      ? 'e.g. Arc Builders Collective'
                      : 'e.g. Solana Builders Collective'
            }
            className="w-full px-4 rounded-lg border outline-none transition-colors"
            style={{
              height: quickMode ? '48px' : '64px',
              fontSize: quickMode ? '16px' : '20px',
              fontFamily: 'var(--font-display)',
              backgroundColor: 'hsl(var(--surface-0))',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
            onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
          />
        </div>
      </div>

      {/* Treasury Slug — nave.dao */}
      <Field
        label="Treasury Slug"
        hint="Your public name on Nave. Used to join (e.g. nave) and for short links like nave.finance/dao/nave."
      >
        <div
          className="flex items-center rounded-lg border overflow-hidden"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-0))' }}
        >
          <input
            type="text"
            value={config.slug}
            onChange={e => {
              setSlugManual(true);
              setConfig({ slug: normalizeDaoSlug(e.target.value) });
            }}
            placeholder="nave"
            className="flex-1 min-w-0 px-3 py-2.5 outline-none"
            style={{
              fontSize: '13px',
              fontFamily: 'var(--font-mono)',
              backgroundColor: 'transparent',
              color: 'hsl(var(--foreground))',
            }}
          />
          <span
            className="px-3 py-2.5 border-l nave-mono flex-shrink-0"
            style={{
              fontSize: '13px',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--muted-foreground))',
              backgroundColor: 'hsl(var(--surface-1))',
            }}
          >
            .dao
          </span>
        </div>
        {config.slug && validateDaoSlug(config.slug).valid && (
          <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '6px' }}>
            {slugChecking ? 'Checking availability…' : getDaoPublicUrl(config.slug)}
          </p>
        )}
      </Field>

      {!quickMode && (
      <>
      {/* Description */}
      <Field label="Description" hint="A short summary of what this treasury is for. Stored with your DAO profile.">
        <textarea
          value={config.description}
          onChange={e => setConfig({ description: e.target.value })}
          placeholder="What is this treasury for?"
          rows={3}
          maxLength={280}
          className="w-full px-3 py-2.5 rounded-lg border outline-none transition-colors resize-none"
          style={{
            fontSize: '13px',
            fontFamily: 'var(--font-body)',
            backgroundColor: 'hsl(var(--surface-0))',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
          onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
          onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
        />
        <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', textAlign: 'right' }}>
          {config.description.length}/280
        </div>
      </Field>

      {/* Governance type */}
      <Field label="Governance Type" hint="How will decisions be made for this treasury?">
        <div className="grid grid-cols-1 xs:grid-cols-2 gap-3 mt-1">
          {([
            {
              id: 'wallets' as GovernanceType,
              icon: 'users',
              label: 'Authorized Wallets',
              desc: 'Specific wallets control voting and proposals.',
            },
            {
              id: 'token' as GovernanceType,
              icon: 'coins',
              label: 'Token-Based',
              desc: 'Token holders participate in governance.',
            },
          ]).map(g => {
            const sel = config.governanceType === g.id;
            return (
              <button
                key={g.id}
                onClick={() => selectGovernance(g.id)}
                className="p-4 rounded-xl border text-left transition-all"
                style={{
                  backgroundColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--surface-0))',
                  borderColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                  color: sel ? 'white' : 'hsl(var(--foreground))',
                }}
              >
                <Fi
                  icon={g.icon}
                  style={{
                    fontSize: '16px',
                    marginBottom: '8px',
                    display: 'block',
                    color: sel ? 'white' : 'hsl(var(--muted-foreground))',
                  }}
                />
                <div className="font-semibold text-display" style={{ fontSize: '13.5px', marginBottom: '3px' }}>
                  {g.label}
                </div>
                <div
                  style={{
                    fontSize: '11.5px',
                    lineHeight: 1.4,
                    opacity: sel ? 0.8 : 1,
                    color: sel ? 'inherit' : 'hsl(var(--muted-foreground))',
                  }}
                >
                  {g.desc}
                </div>
              </button>
            );
          })}
        </div>
      </Field>

      {/* — Wallet branch — */}
      {config.governanceType === 'wallets' && (
        <div
          className="space-y-5 p-5 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Field label="Authorized Wallets" hint="Wallets that can vote on proposals. Your connected wallet is added automatically; you can add or remove others. Manage these anytime in Settings.">
            <p className="mb-3" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
              These wallets vote on proposals and approve emergency actions. A proposal closes immediately once the yes votes cannot lose; otherwise it stays open until the voting window ends. Emergency actions need{' '}
              <strong>{defaultGuardianThreshold(previewGuardianCount(config), config.chain === 'solana' ? 0 : 1)} of {previewGuardianCount(config)}</strong> guardian approvals
              {config.chain !== 'solana' && ' (one is Nave-custodied; with two or more guardians of your own, they can reach this without it)'}.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={walletInput}
                onChange={e => setWalletInput(e.target.value)}
                placeholder="Paste wallet address…"
                className="flex-1 px-3 py-2.5 rounded-lg border outline-none transition-colors"
                style={{
                  fontSize: '12.5px',
                  fontFamily: 'var(--font-mono)',
                  backgroundColor: 'hsl(var(--surface-0))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
                onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                onKeyDown={e => e.key === 'Enter' && addWallet()}
              />
              <button
                onClick={addWallet}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-medium transition-all flex-shrink-0"
                style={{
                  fontSize: '12.5px',
                  backgroundColor: 'hsl(var(--primary))',
                  color: 'hsl(var(--primary-foreground))',
                }}
              >
                <Fi icon="plus" style={{ fontSize: '11px' }} />
                Add
              </button>
            </div>
            {config.authorizedWallets.length > 0 && (
              <div className="space-y-1.5 mt-3">
                {config.authorizedWallets.map(w => (
                  <div
                    key={w}
                    className="flex items-center justify-between px-3 py-2 rounded-lg"
                    style={{ backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}
                  >
                    <span className="nave-mono truncate" style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }}>
                      {w}
                    </span>
                    <button
                      onClick={() => removeWallet(w)}
                      className="p-1 rounded transition-colors flex-shrink-0"
                      style={{ color: 'hsl(var(--muted-foreground))' }}
                    >
                      <Fi icon="xmark" style={{ fontSize: '13px' }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Field>

          {/* Optional links */}
          <div className="space-y-3 pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
            <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', paddingTop: '8px' }}>
              Social links <span style={{ opacity: 0.6 }}>(optional)</span>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { key: 'website', icon: 'globe', placeholder: 'https://yoursite.com' },
                { key: 'twitter', icon: 'xmark', placeholder: '@handle' },
                { key: 'discord', icon: 'comment', placeholder: 'discord.gg/…' },
              ].map(f => (
                <div key={f.key} className="relative">
                  <div
                    className="absolute left-3 top-1/2 -translate-y-1/2"
                    style={{ color: 'hsl(var(--muted-foreground))' }}
                  >
                    <Fi icon={f.icon} style={{ fontSize: '12px' }} />
                  </div>
                  <input
                    type="text"
                    value={(config as unknown as Record<string, string>)[f.key]}
                    onChange={e => setConfig({ [f.key]: e.target.value } as Partial<DAOConfig>)}
                    placeholder={f.placeholder}
                    className="w-full pl-8 pr-3 py-2 rounded-lg border outline-none transition-colors"
                    style={{
                      fontSize: '12.5px',
                      backgroundColor: 'hsl(var(--surface-0))',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
                    onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* — Token branch — */}
      {config.governanceType === 'token' && (
        <div
          className="space-y-5 p-5 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Field
            label="Governance Token"
            hint={
              config.chain === 'solana'
                ? 'Use an existing SPL token or mint a new one for this treasury.'
                : 'Use an existing ERC-20 token contract or deploy a new DAO token for this treasury.'
            }
          >
            <div className="grid grid-cols-2 gap-2 mt-1">
              {(['existing', 'new'] as TokenMode[]).map(mode => {
                const sel = config.tokenMode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => setConfig({ tokenMode: mode })}
                    className="px-4 py-2.5 rounded-lg border text-center transition-all"
                    style={{
                      fontSize: '13px',
                      fontWeight: sel ? '600' : '400',
                      backgroundColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--surface-0))',
                      borderColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                      color: sel ? 'white' : 'hsl(var(--foreground))',
                    }}
                  >
                    {mode === 'existing' ? 'Existing Token' : 'New Token'}
                  </button>
                );
              })}
            </div>
          </Field>

          {config.tokenMode === 'existing' && (
            <Field label="Token Contract Address">
              <TextInput
                value={config.existingTokenCA}
                onChange={v => setConfig({ existingTokenCA: v })}
                placeholder={config.chain === 'solana' ? 'Paste SPL token mint address…' : 'Paste ERC-20 token address…'}
                mono
              />
            </Field>
          )}

          {config.tokenMode === 'new' && (
            <div className="space-y-4">
              <Field label="Token Name">
                <TextInput
                  value={config.newTokenName}
                  onChange={v => setConfig({ newTokenName: v })}
                  placeholder="e.g. SBUILD"
                  mono
                />
              </Field>
              <Field
                label="Token Supply"
                hint="Total tokens to mint. They will be deposited directly into the treasury wallet — not your personal wallet."
              >
                <TextInput
                  value={config.newTokenSupply}
                  onChange={v => setConfig({ newTokenSupply: v })}
                  placeholder="1000000"
                  mono
                  type="number"
                />
              </Field>
              <div
                className="flex items-start gap-2 p-3 rounded-lg"
                style={{ backgroundColor: 'hsl(var(--accent-muted))', border: '1px solid hsl(var(--border-strong))' }}
              >
                <Fi
                  icon="circle-info"
                  style={{ fontSize: '13px', color: 'hsl(var(--accent))', flexShrink: 0, marginTop: '2px' }}
                />
                <p style={{ fontSize: '12px', color: 'hsl(var(--accent-muted-foreground))', lineHeight: 1.6 }}>
                  Tokens will be minted directly into the treasury's on-chain wallet. All distributions require an authorized signer — no tokens will reach your personal wallet at creation.
                </p>
              </div>
            </div>
          )}

          {/* Optional social links for token governance too */}
          <div className="space-y-3 pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
            <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', paddingTop: '8px' }}>
              Social links <span style={{ opacity: 0.6 }}>(optional)</span>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { key: 'website', icon: 'globe', placeholder: 'https://yoursite.com' },
                { key: 'twitter', icon: 'xmark', placeholder: '@handle' },
                { key: 'discord', icon: 'comment', placeholder: 'discord.gg/…' },
              ].map(f => (
                <div key={f.key} className="relative">
                  <div
                    className="absolute left-3 top-1/2 -translate-y-1/2"
                    style={{ color: 'hsl(var(--muted-foreground))' }}
                  >
                    <Fi icon={f.icon} style={{ fontSize: '12px' }} />
                  </div>
                  <input
                    type="text"
                    value={(config as unknown as Record<string, string>)[f.key]}
                    onChange={e => setConfig({ [f.key]: e.target.value } as Partial<DAOConfig>)}
                    placeholder={f.placeholder}
                    className="w-full pl-8 pr-3 py-2 rounded-lg border outline-none transition-colors"
                    style={{
                      fontSize: '12.5px',
                      backgroundColor: 'hsl(var(--surface-0))',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
                    onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      </>
      )}

    </div>
  );
}

/* ── Step 3: Seed & Review ───────────────────────────────── */
function SeedReviewStep({
  config,
  policy,
  seedAmount,
  setSeedAmount,
  onDeploy,
  deploying,
  evmFormationFeeWei,
  evmFormationFeeLoading,
}: {
  config: DAOConfig;
  policy: PolicyState;
  seedAmount: string;
  setSeedAmount: (v: string) => void;
  onDeploy: () => void;
  deploying: boolean;
  evmFormationFeeWei?: bigint | null;
  evmFormationFeeLoading?: boolean;
}) {
  const isSolana = config.chain === 'solana';
  const chainLabel = chainDisplayLabel(config.chain);
  const isTokenGov = config.governanceType === 'token';
  const isNewToken = config.tokenMode === 'new';
  const nativeUnit = treasuryNativeLabel(config.chain);
  const seedDepositCopy = config.chain === 'arc'
    ? 'Arc treasuries hold 6-decimal ERC-20 USDC (deposited from Assets after creation); native gas USDC is not attached to createDao, and the seed amount sets your initial agent threshold.'
    : `Deposited into your ${chainLabel} vault as native ${nativeUnit} — not a protocol fee.`;

  const seedNum = parseFloat(seedAmount);
  const validSeed = !isNaN(seedNum) && seedNum >= 0;
  const deployBlocked = deploying || !validSeed;

  const presetLabel = RISK_PRESETS.find((r) => r.id === policy.riskPreset)?.label ?? policy.riskPreset;
  const approvedProtocols = (isSolana ? PROTOCOLS_SOLANA : PROTOCOLS_EVM)
    .filter((p) => policy.approvedProtocols[p.key])
    .map((p) => p.label);

  // Per-network native cost rows (Solana). Formation has no protocol fee.
  const isMainnet = SOLANA_NETWORK === 'mainnet';
  const agentSeedSol = AGENT_WALLET_TOTAL_SEED_SOL;
  const rentSol = 0.015;
  const gasSol = 0.001;
  const totalFeesSol = agentSeedSol + rentSol + gasSol + (isNewToken ? TOKEN_MINT_FEE_SOL : 0);
  const totalCostSol = totalFeesSol + (validSeed ? seedNum : 0);

  const identityRows: { label: string; value: string }[] = [
    { label: 'Chain', value: chainLabel },
    { label: 'Treasury Name', value: config.name || '—' },
    ...(config.slug ? [{ label: 'Slug', value: formatDaoSlugLabel(config.slug) }] : []),
    {
      label: 'Governance',
      value: isTokenGov ? 'Token-Based' : 'Authorized Wallets',
    },
    ...(config.governanceType === 'wallets'
      ? [{ label: 'Guardians', value: `${config.authorizedWallets.length} wallet${config.authorizedWallets.length !== 1 ? 's' : ''}` }]
      : []),
    {
      label: 'Guardian approvals',
      value: `${defaultGuardianThreshold(previewGuardianCount(config), isSolana ? 0 : 1)} of ${previewGuardianCount(config)}${isSolana ? '' : ' (incl. one Nave-custodied guardian)'}`,
    },
  ];

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-display mb-1.5" style={{ fontSize: '24px', letterSpacing: '-0.01em' }}>
          Seed & Review
        </h2>
        <p style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))' }}>
          Set your initial treasury deposit, review all details, then deploy.
        </p>
      </div>

      {/* Treasury seed input */}
      <div className="space-y-1.5">
        <label className="nave-label" style={{ fontSize: '12px', fontWeight: '500' }}>
          Treasury seed (optional)
        </label>
        <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}>
          {isSolana
            ? 'Deposited into your vault as wSOL — not a protocol fee. Agents use this as initial deployable capital.'
            : seedDepositCopy}
          {' '}Enter 0 to start with an empty treasury.
        </p>
        <div className="flex items-center rounded-lg border overflow-hidden"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-0))' }}>
          <input
            type="number"
            min="0"
            step="0.01"
            value={seedAmount}
            onChange={(e) => setSeedAmount(e.target.value)}
            placeholder="0.0"
            className="flex-1 min-w-0 px-3 py-2.5 outline-none"
            style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', backgroundColor: 'transparent', color: 'hsl(var(--foreground))' }}
          />
          <span className="px-3 py-2.5 border-l nave-mono flex-shrink-0"
            style={{ fontSize: '13px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', backgroundColor: 'hsl(var(--surface-1))' }}>
            {nativeUnit}
          </span>
        </div>
      </div>

      {/* Identity summary */}
      <div className="nave-card overflow-hidden">
        <div className="px-5 py-3 border-b"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}>
          <span className="text-display font-semibold" style={{ fontSize: '13px' }}>Treasury Identity</span>
        </div>
        <div className="divide-y" style={{ borderColor: 'hsl(var(--border))' }}>
          {identityRows.map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between px-5 py-2.5"
              style={{ borderColor: 'hsl(var(--border))' }}>
              <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>{label}</span>
              <span className="nave-mono" style={{ fontSize: '13px', color: 'hsl(var(--foreground))', fontWeight: '500' }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Constitution summary */}
      <div className="nave-card overflow-hidden">
        <div className="px-5 py-3 border-b"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}>
          <span className="text-display font-semibold" style={{ fontSize: '13px' }}>Treasury Constitution</span>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2.5 py-1 rounded-lg text-xs font-medium"
              style={{ backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
              {presetLabel}
            </span>
            {approvedProtocols.map((label) => (
              <span key={label} className="px-2.5 py-1 rounded-lg text-xs"
                style={{ backgroundColor: 'hsl(var(--accent-muted))', color: 'hsl(var(--accent-muted-foreground))', border: '1px solid hsl(var(--border-strong))' }}>
                {label}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Min Reserve', value: `${policy.minStablecoin}%` },
              { label: 'Max Deploy', value: `${policy.maxDeployment}%` },
              { label: 'Rebalancing', value: policy.rebalanceFreq },
            ].map(({ label, value }) => (
              <div key={label} className="px-3 py-2 rounded-lg text-center"
                style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}>
                <div style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))' }}>{label}</div>
                <div className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--foreground))', fontWeight: 500 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Cost breakdown */}
      {isSolana && (
        <div className="nave-card p-5 space-y-3" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
          <span className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
            Deployment Costs
          </span>
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
            Forming a treasury has no protocol fee and does not lock NAVE. You pay network gas and account rent.
            Any SOL you deposit is your treasury seed, not a fee.
          </p>

          <div style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))', textTransform: 'uppercase', letterSpacing: '0.04em', paddingTop: '2px' }}>
            Network
          </div>

          {[
            { label: `Agent wallet seeding (4×)`, value: `${agentSeedSol.toFixed(isMainnet ? 1 : 2)} SOL` },
            { label: 'Rent (accounts)', value: '~0.015 SOL' },
            ...(isNewToken ? [{ label: `Token mint fee`, value: `${TOKEN_MINT_FEE_SOL.toFixed(2)} SOL` }] : []),
            { label: 'Network gas', value: '~0.001 SOL' },
          ].map((f) => (
            <div key={f.label} className="flex items-center justify-between">
              <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>{f.label}</span>
              <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>{f.value}</span>
            </div>
          ))}

          {/* Your treasury deposit — highlighted */}
          <div className="flex items-center justify-between py-2 px-3 rounded-lg"
            style={{ backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}>
            <div>
              <span style={{ fontSize: '12px', fontWeight: '600', color: 'hsl(var(--foreground))' }}>
                Initial treasury deposit
              </span>
              <span style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))', display: 'block', opacity: 0.85 }}>
                deposited into your vault as deployable capital, not a fee
              </span>
            </div>
            <span className="nave-mono" style={{ fontSize: '13px', fontWeight: '600', color: 'hsl(var(--foreground))' }}>
              {validSeed ? `${seedNum.toFixed(4)} SOL` : '—'}
            </span>
          </div>

          <div className="pt-1 space-y-1">
            <div className="flex items-center justify-between">
              <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>Network SOL (gas, rent, agent funding)</span>
              <span className="nave-mono" style={{ fontSize: '12px' }}>~{totalFeesSol.toFixed(3)} SOL</span>
            </div>
            <div className="flex items-center justify-between border-t pt-2" style={{ borderColor: 'hsl(var(--border))' }}>
              <span style={{ fontSize: '13px', fontWeight: '600', color: 'hsl(var(--foreground))' }}>Total SOL from your wallet</span>
              <span className="nave-mono" style={{ fontSize: '13px', fontWeight: '700', color: 'hsl(var(--foreground))' }}>
                ~{validSeed ? totalCostSol.toFixed(3) : totalFeesSol.toFixed(3)} SOL
              </span>
            </div>
          </div>
        </div>
      )}

      {!isSolana && (
        <div className="nave-card p-5 space-y-3" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
          <span className="text-display font-semibold" style={{ fontSize: '13.5px' }}>Deployment Costs</span>
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
            Forming a treasury has no protocol fee and does not lock NAVE. You pay network gas.
            Any {nativeUnit} you send with creation is your treasury seed, not a fee.
          </p>

          <div style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))', textTransform: 'uppercase', letterSpacing: '0.04em', paddingTop: '2px' }}>
            Network gas
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>Network gas</span>
                <span style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))', display: 'block', opacity: 0.85 }}>
                  no protocol formation fee
                </span>
              </div>
              <span className="nave-mono" style={{ fontSize: '12px' }}>
                {evmFormationFeeLoading
                  ? 'Loading…'
                  : evmFormationFeeWei != null && evmFormationFeeWei > 0n
                    ? `~${parseFloat(formatUnits(evmFormationFeeWei, 18)).toFixed(4)} ${nativeUnit} + gas`
                    : `~0.003 ${nativeUnit} (variable)`}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 px-3 rounded-lg"
              style={{ backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}>
              <div>
                <span style={{ fontSize: '12px', fontWeight: '600', color: 'hsl(var(--foreground))' }}>
                  Initial treasury deposit
                </span>
                <span style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))', display: 'block', opacity: 0.85 }}>
                  deposited into your vault, not a fee
                </span>
              </div>
              <span className="nave-mono" style={{ fontSize: '13px', fontWeight: '600', color: 'hsl(var(--foreground))' }}>
                {validSeed ? `${seedNum.toFixed(4)} ${nativeUnit}` : '—'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* New token note */}
      {isNewToken && (
        <div className="flex items-start gap-2.5 p-4 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--accent-muted))', borderColor: 'hsl(var(--border-strong))' }}>
          <Fi icon="circle-info" style={{ fontSize: '14px', color: 'hsl(var(--accent))', flexShrink: 0, marginTop: '2px' }} />
          <div>
            <p className="font-semibold" style={{ fontSize: '13px', color: 'hsl(var(--accent-muted-foreground))', marginBottom: '3px' }}>
              Token created under treasury control
            </p>
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--accent-muted-foreground))', lineHeight: 1.6 }}>
              {config.newTokenName || 'Your token'} mint will be created with the treasury as its mint authority. Manage it from the Tokens page after deployment.
            </p>
          </div>
        </div>
      )}

      {/* Wallet prompt count notice */}
      <div className="flex items-start gap-2.5 p-4 rounded-xl border"
        style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}>
        <Fi icon="signature" style={{ fontSize: '14px', color: 'hsl(var(--primary))', flexShrink: 0, marginTop: '2px' }} />
        <div>
          <p className="font-semibold" style={{ fontSize: '13px', color: 'hsl(var(--foreground))', marginBottom: '3px' }}>
            {isSolana
              ? 'Your wallet will prompt you up to 3 times'
              : 'Your wallet will prompt you several times'}
          </p>
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
            {isSolana
              ? 'A guided popup walks you through each signature — Foundation, Governance, then Activate & Ratify. You can retry if interrupted.'
              : 'You will sign an agent-key message, create the treasury, sign the key-binding and treasury-details messages, then activate the rules. A token treasury adds one more transaction. You can retry if interrupted.'}
          </p>
        </div>
      </div>

      {/* Deploy button */}
      <button
        onClick={onDeploy}
        disabled={deployBlocked}
        className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl font-semibold transition-all"
        style={{
          fontSize: '15px',
          backgroundColor: deployBlocked ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
          color: deployBlocked ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
          cursor: deployBlocked ? 'not-allowed' : 'pointer',
          boxShadow: deployBlocked ? 'none' : 'var(--shadow-md)',
        }}
      >
        <Fi icon="rocket" style={{ fontSize: '14px' }} />
        Deploy Treasury
      </button>
      {!validSeed && (
        <p className="text-center" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
          Enter a seed amount (0 is valid) to continue
        </p>
      )}
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────── */
export default function CreateDAO() {
  const navigate = useNavigate();
  const { connected, publicKey, signMessage } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const { setDaoAddress } = useDaoContext();
  const { setChainFamily, rememberDaoChain } = useChain();
  const { address: evmAddress, isConnected: evmConnected, chainId: connectedEvmChainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { signMessageAsync: signEvmMessage } = useSignMessage();
  const tx = useSendTransaction();
  const [setupMode, setSetupMode] = useState<SetupMode>('quick');
  const [step, setStep] = useState(0);
  // Launch create is Base. Solana and Ethereum stay on their non-create paths.
  const [config, setConfigState] = useState<DAOConfig>(() => ({
    ...DEFAULT_CONFIG,
    chain: 'base',
  }));
  // Constitution policy state — quick setup starts on the Conservative preset.
  const [policy, setPolicyState] = useState<PolicyState>(() => policyForChain('base', 'conservative'));
  // Treasury seed amount (native SOL or ETH as string). 0 is a valid seed and must not block Deploy.
  const [seedAmount, setSeedAmount] = useState<string>('0');
  const [deploying, setDeploying] = useState(false);
  const [deploySteps, setDeploySteps] = useState<DeployStep[]>([]);

  const DEPLOY_STEP_TEMPLATES_SOLANA = [
    { id: 'foundation', label: 'Sign 1 of 3 — Foundation' },
    { id: 'governance', label: 'Sign 2 of 3 — Governance' },
    { id: 'activate',   label: 'Sign 3 of 3 — Activate & Ratify' },
    { id: 'agents',     label: 'Starting agents…' },
  ] as const;

  const DEPLOY_STEP_TEMPLATES_EVM = [
    { id: 'create',   label: 'Sign 1 of 2 — Create Treasury' },
    { id: 'activate', label: 'Sign 2 of 2 — Activate & Ratify' },
    { id: 'agents',   label: 'Starting agents…' },
  ] as const;

  function initDeploySteps(isSolana: boolean) {
    const template = isSolana ? DEPLOY_STEP_TEMPLATES_SOLANA : DEPLOY_STEP_TEMPLATES_EVM;
    setDeploySteps(template.map((s) => ({ ...s, status: 'pending' as DeployStepStatus })));
  }

  function patchDeployStep(id: string, status: DeployStepStatus, detail?: string | null) {
    setDeploySteps((prev) =>
      prev.map((s) => (
        s.id === id
          ? { ...s, status, detail: detail === undefined ? s.detail : detail ?? undefined }
          : s
      )),
    );
  }

  function beginDeployStep(id: string) {
    setDeploySteps((prev) =>
      prev.map((s) => {
        if (s.id === id) return { ...s, status: 'running' as DeployStepStatus, detail: undefined };
        if (s.status === 'running') return { ...s, status: 'done' as DeployStepStatus };
        return s;
      }),
    );
  }

  function completeDeployStep(id: string, detail?: string) {
    patchDeployStep(id, 'done', detail);
  }

  function failDeployStep(id: string, detail?: string) {
    patchDeployStep(id, 'error', detail);
  }

  const deployActiveHint =
    deploySteps.find((s) => s.status === 'running')?.label ??
    'Approve the transaction in your wallet when prompted.';
  const [walletError, setWalletError] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [slugReady, setSlugReady] = useState(false);
  const [slugMessage, setSlugMessage] = useState<string | null>(null);
  const [evmFormationFeeWei, setEvmFormationFeeWei] = useState<bigint | null>(null);
  const [evmFormationFeeLoading, setEvmFormationFeeLoading] = useState(false);

  function setConfig(partial: Partial<DAOConfig>) {
    setConfigState(prev => ({ ...prev, ...partial }));
  }

  function setPolicy(partial: Partial<PolicyState>) {
    setPolicyState(prev => ({ ...prev, ...partial }));
  }

  // Keep the active chain synced to the selection. The wallet switch is the
  // same request deploy awaits, so selecting a network and then deploying
  // does not open a second MetaMask prompt.
  useEffect(() => {
    setChainFamily(config.chain);
    if (config.chain === 'solana' || !evmConnected) return;
    const targetId = activeEvmChainId(config.chain as Exclude<ChainFamily, 'solana'>);
    if (connectedEvmChainId === targetId) return;
    void ensureWalletOnChain(targetId).catch(() => {
      // Deploy repeats this check and surfaces the wallet error there.
    });
  }, [config.chain, setChainFamily, evmConnected, connectedEvmChainId]);

  useEffect(() => {
    setPolicyState((prev) => policyForChain(config.chain, prev.riskPreset));
  }, [config.chain]);

  useEffect(() => {
    if (step !== 2 || config.chain === 'solana') return;
    let cancelled = false;
    setEvmFormationFeeLoading(true);
    const chainId = activeEvmChainId(config.chain as Exclude<ChainFamily, 'solana'>);
    fetchFormationFeeEvm(chainId)
      .then((fee) => {
        if (!cancelled) setEvmFormationFeeWei(fee);
      })
      .catch(() => {
        if (!cancelled) setEvmFormationFeeWei(null);
      })
      .finally(() => {
        if (!cancelled) setEvmFormationFeeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, config.chain]);

  function handleSlugReadyChange(ready: boolean, message: string | null) {
    setSlugReady(ready);
    setSlugMessage(message);
  }
  const onSlugReadyChange = useCallback(handleSlugReadyChange, []);

  const wizardSteps = setupMode === 'quick' ? QUICK_STEPS : ADVANCED_STEPS;
  const connectedWallet =
    config.chain === 'solana'
      ? (publicKey?.toBase58() ?? null)
      : (evmAddress ?? null);

  // ── Resume-setup: an earlier attempt created a treasury on-chain but a
  // post-creation step (agent-key binding, token registration, metadata sync,
  // constitution activation) failed. Surface it as a persistent banner so the
  // founder can finish setup instead of accidentally creating a second DAO.
  const [pendingResume, setPendingResume] = useState<PendingDaoCreation | null>(null);
  const [resuming, setResuming] = useState(false);
  useEffect(() => {
    setPendingResume(findPendingDaoCreationForWallet(connectedWallet));
  }, [connectedWallet]);

  function selectSetupMode(mode: SetupMode) {
    setSetupMode(mode);
    if (mode === 'quick') {
      setStep(0);
      setConfig({
        governanceType: 'wallets',
        authorizedWallets: connectedWallet ? [connectedWallet] : [],
      });
      setPolicyState(policyForChain(config.chain, 'conservative'));
    }
  }

  useEffect(() => {
    if (setupMode !== 'quick') return;
    setPolicyState(policyForChain(config.chain, 'conservative'));
  }, [setupMode, config.chain]);

  function openCreateWallet() {
    if (config.chain === 'solana') setVisible(true);
    else openConnectModal?.();
  }

  // Keep quick-mode guardian in sync when the wallet connects after mode selection.
  useEffect(() => {
    if (setupMode !== 'quick' || !connectedWallet) return;
    if (config.governanceType !== 'wallets') {
      setConfig({ governanceType: 'wallets' });
    }
    if (!config.authorizedWallets.includes(connectedWallet)) {
      setConfig({ authorizedWallets: [connectedWallet] });
    }
  }, [setupMode, connectedWallet, config.governanceType, config.authorizedWallets]);

  function canAdvance() {
    if (step === 0) {
      if (config.chain === 'solana') {
        if (!connected || !publicKey) return false;
      } else if (!evmConnected || !evmAddress) {
        return false;
      }
      if (!config.name.trim()) return false;
      if (!config.slug.trim() || !slugReady) return false;
      if (setupMode === 'quick') {
        return config.governanceType === 'wallets' && config.authorizedWallets.length > 0;
      }
      if (!config.governanceType) return false;
      if (config.governanceType === 'token' && !config.tokenMode) return false;
      if (config.governanceType === 'token' && config.tokenMode === 'existing') {
        const token = config.existingTokenCA.trim();
        if (!token) return false;
        if (config.chain === 'solana') {
          try {
            new PublicKey(token);
          } catch {
            return false;
          }
        } else if (!toAddress(token)) {
          return false;
        }
      }
      if (config.governanceType === 'token' && config.tokenMode === 'new' && !config.newTokenName.trim()) return false;
    }
    if (step === 1) {
      // At least one protocol must be approved
      return Object.values(policy.approvedProtocols).some((v) => v);
    }
    if (step === 2) {
      // Seed must be a valid non-negative number (empty = not ready; "0" is valid)
      const seedNum = parseFloat(seedAmount);
      return !isNaN(seedNum) && seedNum >= 0;
    }
    return true;
  }

  async function handleDeployEvm() {
    // EVM (Ethereum/Base) deployment via the NaveDAOFactory clone. Requires a
    // connected EVM wallet and configured factory/protocol addresses; otherwise
    // sendEvm surfaces a clear "not configured" message (or demo mock).
    if (!evmConnected || !evmAddress) {
      setWalletError(true);
      return;
    }
    setWalletError(false);
    setTxError(null);
    setDeploying(true);
    initDeploySteps(false);
    beginDeployStep('create');

    // Populated once the treasury exists on-chain — from that point on, any
    // failure is a POST-creation failure (the DAO is real; don't lose it).
    // `currentSubStep` tracks finer-grained progress than the visible deploy
    // steps so a resume can report/label exactly where it left off.
    let checkpoint: Omit<PendingDaoCreation, 'failedStep' | 'failedError' | 'failedAt'> | null = null;
    let currentSubStep: 'create' | 'bind-keys' | 'token-registration' | 'register-metadata' | 'activate' = 'create';

    try {
      const family = config.chain as DaoEvmChainFamily;
      const chainId = activeEvmChainId(family);
      patchDeployStep('create', 'running', `Switching your wallet to ${chainDisplayLabel(family)}. Approve that prompt before signing.`);
      await ensureWalletOnChain(chainId);
      patchDeployStep('create', 'running', null);
      const founder = evmAddress as Address;
      const isTokenGov = config.governanceType === 'token';
      let votingTokenMint: Address | null = null;

      if (isTokenGov && config.tokenMode === 'existing') {
        votingTokenMint = toAddress(config.existingTokenCA);
        if (!votingTokenMint) {
          throw new Error('Enter a valid ERC-20 token contract address for EVM token governance.');
        }
      }

      // 1. Generate the 4 real EVM agent EOAs (+ a server-custodied guardian)
      //    keyed by an unguessable ref. EVM clones use CREATE, so the treasury
      //    address isn't known until the tx is mined — we rebind the keys to it
      //    after the DaoCreated event below. The founder proves ownership by
      //    signing the keygen challenge with their EVM wallet (EIP-191).
      const daoRef = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '');
      const keygenMsg = `nave-evm-keygen|${daoRef}|${chainId}|${Date.now()}`;
      const keygenSig = await signEvmMessage({ message: keygenMsg });
      const { data: keyData, error: keyError } = await generateEvmAgentKeys(
        daoRef, founder, chainId, family, keygenMsg, keygenSig,
      );
      if (keyError || !keyData) {
        throw new Error(`EVM agent key generation failed: ${keyError ?? 'unknown error'}`);
      }
      const agentAuthorities: [Address, Address, Address, Address] = [
        keyData.agents.executive.address as Address,
        keyData.agents.financial.address as Address,
        keyData.agents.oversight.address as Address,
        keyData.agents.operational.address as Address,
      ];

      // The connected wallet is always a guardian; the generated guardian signer
      // joins the set so the server-side M-of-N path has a usable signer too.
      const guardianWallets: Address[] =
        config.governanceType === 'wallets' && config.authorizedWallets.length > 0
          ? config.authorizedWallets.map((w) => w.trim() as Address)
          : [founder];
      if (keyData.guardian?.address && !guardianWallets.some((w) => w.toLowerCase() === keyData.guardian!.address.toLowerCase())) {
        guardianWallets.push(keyData.guardian.address as Address);
      }
      if (!guardianWallets.some((w) => w.toLowerCase() === founder.toLowerCase())) {
        guardianWallets.unshift(founder);
      }
      const custodiedGuardians = keyData.guardian?.address ? 1 : 0;

      const params: EvmCreateDaoParams = {
        name: config.name,
        privacyMode: 0,
        guardianWallets,
        guardianThreshold: defaultGuardianThreshold(guardianWallets.length, custodiedGuardians),
        agentAuthorities,
        managementFeeBps: MANAGEMENT_FEE_BPS_NORMAL,
        performanceFeeBps: PERFORMANCE_FEE_BPS,
        frozenManagementFeeBps: MANAGEMENT_FEE_BPS_FROZEN,
        frozenPerformanceFeeBps: FROZEN_PERFORMANCE_FEE_BPS,
        // Protocol-revenue share routes to the Nave-controlled fee wallet when
        // configured (mirrors Solana's protocol treasury); falls back to the
        // founder on deployments without one set (e.g. testnets).
        protocolRevenueWallet: (toAddress(EVM_PROTOCOL_REVENUE_WALLET ?? null) ?? founder) as Address,
        quorumBps: 3500,
        governanceType: isTokenGov ? 1 : 0,
      };

      // 2. Resolve factory address + formation fee from the on-chain protocol.
      //    fetchFactoryAddressEvm tries the env var first, then falls back to
      //    reading NaveProtocol.factory() — so it works even if .env.local hasn't
      //    been reloaded / the factory env var isn't set yet.
      const [resolvedFactory, formationFeeWei] = await Promise.all([
        fetchFactoryAddressEvm(chainId),
        fetchFormationFeeEvm(chainId).then(f => f ?? 0n),
      ]);
      if (!resolvedFactory) {
        throw new Error(
          `NaveDAOFactory is not deployed on this network yet (chain ${chainId}). ` +
          `Testnet factories fall back to the deployed Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet stacks.`,
        );
      }
      // formationFee is 0. Any msg.value above that is the founder's own seed, not a fee.
      // On Arc Testnet (5042002), NaveProtocol.wrappedNative() is address(0) because
      // native gas is 18-decimal USDC while the treasury asset is 6-decimal ERC-20 USDC
      // (0x3600000000000000000000000000000000000000); passing seedWei > 0 reverts
      // seedNativeTreasury() with WrappedNativeNotConfigured().
      const seedNum = parseFloat(seedAmount);
      const seedWei =
        chainId === 5042002
          ? 0n
          : !isNaN(seedNum) && seedNum > 0
            ? parseEther(String(seedNum))
            : 0n;
      const totalValue = formationFeeWei + seedWei;
      const build = buildCreateDaoEvm(chainId, params, totalValue, resolvedFactory);
      const outcome = await tx.sendEvm(build, { successLabel: 'Treasury deployed', quietMock: true, quietToast: true });

      if (outcome.status === 'success') {
        completeDeployStep('create');
        // 3. Recover the treasury address from the DaoCreated event so we can
        //    rebind agent keys, persist chain metadata, and register off-chain
        //    DAO metadata. The indexer also records the trio from the same event.
        let treasury: Address | null = null;
        if (outcome.txHash) {
          const receipt = await getTransactionReceipt(wagmiConfig, { hash: outcome.txHash as `0x${string}`, chainId });
          for (const log of receipt.logs) {
            try {
              const decoded = decodeEventLog({ abi: NaveDAOFactoryAbi, data: log.data, topics: log.topics });
              if (decoded.eventName === 'DaoCreated') {
                treasury = (decoded.args as unknown as { treasury: Address }).treasury;
                break;
              }
            } catch { /* not a DaoCreated log */ }
          }
        }
        if (!treasury) {
          throw new Error('Treasury deployed, but the DaoCreated event could not be decoded. Please refresh and join the DAO by address once the indexer catches up.');
        }

        // The DAO now exists on-chain. From here on, any failure is a
        // POST-creation failure — persist a resumable checkpoint so a retry
        // (via the "Resume setup" banner) can finish the remaining steps
        // instead of restarting the wizard (which would create a SECOND DAO).
        checkpoint = {
          chain: family,
          chainId,
          daoAddress: treasury,
          daoRef,
          founder,
          name: config.name,
          slug: config.slug,
          description: config.description,
          governanceType: config.governanceType,
          tokenMode: config.tokenMode,
          existingTokenCA: config.existingTokenCA,
          newTokenName: config.newTokenName,
          newTokenSupply: config.newTokenSupply,
          votingTokenMint: votingTokenMint ?? null,
          guardianWallets,
          seedAmount,
          policy,
          website: config.website,
          twitter: config.twitter,
          discord: config.discord,
          logoUrl: '',
        };

        currentSubStep = 'bind-keys';
        await ensureWalletOnChain(chainId);
        const bindMsg = `nave-evm-keybind|${daoRef}|${treasury.toLowerCase()}|${chainId}|${Date.now()}`;
        const bindSig = await signEvmMessage({ message: bindMsg });
        const { error: bindError } = await bindEvmAgentKeys(daoRef, treasury, founder, chainId, family, bindMsg, bindSig);
        if (bindError) {
          throw new Error(`Treasury deployed, but agent key binding failed: ${bindError}`);
        }

        // 4. For EVM token governance, register the voting token on the treasury clone.
        currentSubStep = 'token-registration';
        if (isTokenGov && config.tokenMode === 'new') {
          const evmDecimals = 18;
          const initialSupply = parseUnits(config.newTokenSupply || '0', evmDecimals);
          if (initialSupply <= 0n) {
            throw new Error('Enter a positive initial token supply.');
          }
          const tokenOutcome = await tx.sendEvm(
            buildRegisterDaoTokenEvm(
              chainId,
              treasury,
              config.newTokenName.trim(),
              config.newTokenName.trim().toUpperCase().slice(0, 11),
              evmDecimals,
              initialSupply,
              treasury,
              parseEther(String(TOKEN_MINT_FEE_ETH)),
            ),
            { successLabel: 'Governance token deployed' },
          );
          if (tokenOutcome.status !== 'success' || !tokenOutcome.txHash) {
            throw new Error(tokenOutcome.error || 'Treasury deployed, but governance token registration failed.');
          }
          const tokenReceipt = await getTransactionReceipt(wagmiConfig, { hash: tokenOutcome.txHash as `0x${string}`, chainId });
          for (const log of tokenReceipt.logs) {
            try {
              const decoded = decodeEventLog({ abi: NaveTreasuryAbi, data: log.data, topics: log.topics });
              if (decoded.eventName === 'DaoTokenRegistered') {
                votingTokenMint = (decoded.args as unknown as { mint: Address }).mint;
                break;
              }
            } catch { /* not a DaoTokenRegistered log */ }
          }
          if (!votingTokenMint) {
            throw new Error('Treasury deployed, but the governance token address could not be decoded.');
          }
          if (checkpoint) checkpoint.votingTokenMint = votingTokenMint;
        } else if (isTokenGov && config.tokenMode === 'existing' && votingTokenMint) {
          let tokenDecimals = 18;
          try {
            tokenDecimals = Number(await readContract(wagmiConfig, {
              address: votingTokenMint,
              abi: Erc20Abi,
              functionName: 'decimals',
              chainId,
            }));
          } catch {
            /* default 18 */
          }
          const tokenName = config.name.trim() || 'Governance Token';
          const tokenSymbol = tokenName.toUpperCase().slice(0, 11) || 'GOV';
          const regOutcome = await tx.sendEvm(
            buildRegisterExternalDaoTokenEvm(
              chainId,
              treasury,
              votingTokenMint,
              tokenName,
              tokenSymbol,
              tokenDecimals,
            ),
            { successLabel: 'Governance token registered' },
          );
          if (regOutcome.status !== 'success' && regOutcome.status !== 'mock') {
            throw new Error(regOutcome.error || 'Treasury deployed, but governance token registration failed.');
          }
        }

        const evmGuardianThreshold = defaultGuardianThreshold(guardianWallets.length, custodiedGuardians);

        // 5. Persist the resolved chain id for this DAO address so future loads
        //    reconcile to the right chain (Ethereum vs Base) instead of
        //    defaulting to Ethereum, and select the new treasury.
        rememberDaoChain(treasury, chainId);
        setDaoAddress(treasury);

        let logoUrl = '';
        if (config.logoBlob) {
          try {
            logoUrl = await uploadDaoLogo(
              config.logoBlob,
              config.name || treasury,
              founder,
              treasury,
              async (m) => {
                await ensureWalletOnChain(chainId);
                return signEvmMessage({ message: m });
              },
              { chain: family, chainId },
            );
          } catch {
            /* logo upload is non-blocking */
          }
        }
        if (checkpoint) checkpoint.logoUrl = logoUrl;

        // 6. Attach off-chain metadata (name, socials, governance, chain) to
        //    the registry so the EVM DAO shows up in the lobby with full
        //    metadata (the indexer only writes the minimal identity row).
        //    register-dao verifies an EIP-191 personal_sign over a fresh single-use
        //    `nave-register-dao|…` challenge (built inside registerDao).
        currentSubStep = 'register-metadata';
        const { error: registerError } = await registerDao({
          dao_address: treasury,
          creator_wallet: founder,
          name: config.name,
          slug: config.slug,
          description: config.description,
          logo_url: logoUrl,
          governance_type: isTokenGov ? 'token' : 'wallet',
          voting_token_mint: isTokenGov ? votingTokenMint ?? undefined : undefined,
          authorized_wallets: guardianWallets,
          privacy_enabled: false,
          social_website: config.website,
          social_twitter: config.twitter,
          social_discord: config.discord,
          chain: family,
          chain_id: chainId,
        }, async (m) => {
          await ensureWalletOnChain(chainId);
          return signEvmMessage({ message: m });
        });
        if (registerError) {
          throw new Error(`Treasury created on-chain, but metadata sync failed: ${registerError}. Treasury address: ${treasury}`);
        }
        // register-dao auto-watches the creator wallet server-side; watch-dao
        // now requires its own signed challenge, so no extra prompt here.

        // ── Tx 2: Constitution + policy + agent enable ────────────────────────
        currentSubStep = 'activate';
        beginDeployStep('activate');
        const chainLabel = evmActivationChainFamily(chainId);
        const evmActivationResult = await runEvmActivation({
          daoAddress: treasury,
          chainId,
          chain: chainLabel,
          founderAddress: founder,
          policy,
          seedAmount,
          sendEvm: (r, opts) => tx.sendEvm(r, opts),
          signMessage: async (msg) => {
            await ensureWalletOnChain(chainId);
            return signEvmMessage({ message: msg });
          },
          executiveAddress: keyData.agents.executive.address,
          onStep: (label) => {
            if (label.includes('Activate')) beginDeployStep('activate');
            if (label.includes('agents')) beginDeployStep('agents');
          },
        });
        if (!evmActivationResult.ok) {
          failDeployStep('activate', evmActivationResult.error);
          throw new Error(
            `Treasury created, but constitution update failed: ${evmActivationResult.error}. ` +
            `Treasury address: ${treasury}`,
          );
        }
        completeDeployStep('activate');
        if (evmActivationResult.agentError) {
          failDeployStep('agents', evmActivationResult.agentError);
          console.warn('[CreateDAO] EVM agent enable failed (non-fatal):', evmActivationResult.agentError);
        } else {
          completeDeployStep('agents');
        }

        clearPendingDaoCreation(family, founder);
        setPendingResume(null);
        setDeploying(false);
        navigate('/dao-created', { state: {
          daoAddress: treasury,
          name: config.name,
          slug: config.slug,
          description: config.description,
          logoUrl,
          governanceType: config.governanceType,
          guardianCount: guardianWallets.length,
          guardianThreshold: evmGuardianThreshold,
          votingToken: votingTokenMint ?? null,
          chainId,
          agentError: evmActivationResult.agentError,
        } });
      } else if (outcome.status === 'mock') {
        setDeploying(false);
        setDeploySteps([]);
        setTxError('EVM treasury creation is not configured for this deployment yet (no factory address). Connect a configured environment to deploy on Ethereum or Base.');
      } else {
        setDeploying(false);
        failDeployStep('create', outcome.error ?? undefined);
        setTxError(outcome.error || 'EVM deployment failed');
      }
    } catch (err) {
      setDeploying(false);
      const msg = err instanceof Error ? err.message : 'EVM deployment failed';
      setTxError(msg);
      setDeploySteps((prev) =>
        prev.map((s) =>
          s.status === 'running'
            ? { ...s, status: 'error' as DeployStepStatus, detail: msg }
            : s,
        ),
      );
      // The treasury already exists on-chain (checkpoint is only set after
      // creation succeeds) — persist a resumable checkpoint instead of
      // leaving the founder with just a raw address in an error message.
      if (checkpoint) {
        savePendingDaoCreation({
          ...checkpoint,
          failedStep: EVM_SUB_STEP_LABELS[currentSubStep] ?? currentSubStep,
          failedError: msg,
          failedAt: new Date().toISOString(),
        });
        setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));
      }
    }
  }

  async function handleDeploy() {
    if (!(USER_CHAINS as readonly string[]).includes(config.chain)) {
      setTxError('This network is not open for treasury creation.');
      return;
    }
    // FN-H1/H2: an earlier attempt for THIS wallet already created a treasury
    // on-chain and didn't finish setup (checkpoint persisted below, or by an
    // earlier failed run) — never silently start a fresh deploy in that case,
    // since `daoCount` has already incremented and a second `initialize_dao`
    // would create a genuine second, half-abandoned DAO. Surface the existing
    // "Resume setup" banner instead (or let the user explicitly dismiss it).
    if (pendingResume && !resuming) {
      setTxError(
        `You have an unfinished DAO setup ("${pendingResume.name || pendingResume.daoAddress}"). ` +
          'Use "Resume setup" above to finish it (or dismiss it first if you intend to create a new DAO).',
      );
      return;
    }
    if (config.chain === 'solana') {
      await handleDeploySolana();
      return;
    }
    await handleDeployEvm();
  }

  /** Solana create path. Open on testnet, where Solana is in USER_CHAINS. */
  async function handleDeploySolana() {
    if (!connected || !publicKey) {
      setWalletError(true);
      setVisible(true);
      return;
    }
    setWalletError(false);
    setTxError(null);
    setDeploying(true);
    initDeploySteps(true);
    beginDeployStep('foundation');

    const founder = publicKey;

    // Populated once the DAO exists on-chain (foundation + governance txs
    // land) — from that point any failure is a POST-creation failure that
    // should be resumable rather than requiring a full wizard restart.
    let checkpoint: Omit<PendingDaoCreation, 'failedStep' | 'failedError' | 'failedAt'> | null = null;
    let currentSubStep: 'foundation' | 'governance' | 'activate' | 'register-metadata' = 'foundation';

    try {
      const walletBalance = await connection.getBalance(founder);
      const seedNum = parseFloat(seedAmount);
      const seedLamportsPreflight = !isNaN(seedNum) && seedNum > 0
        ? Math.round(seedNum * LAMPORTS_PER_SOL)
        : 0;
      const minLamports = Math.round(
        (DAO_FORMATION_FEE_SOL + AGENT_WALLET_TOTAL_SEED_SOL + 0.02) * LAMPORTS_PER_SOL,
      ) + seedLamportsPreflight;
      if (walletBalance < minLamports) {
        throw new Error(
          `Insufficient SOL: need about ${(minLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL in your wallet ` +
          `(agent funding, rent, gas, and your treasury seed — formation has no protocol fee). ` +
          `You have ${(walletBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL.`,
        );
      }

      const { core } = getNavePrograms(connection);

      // 1. Derive the next DAO id from global config and the resulting DAO PDA.
      const [globalConfigPda] = getNaveGlobalConfigPDA();
      const globalConfig = await core.account.naveGlobalConfig.fetch(globalConfigPda);
      const daoId = (globalConfig.daoCount as { toNumber: () => number }).toNumber();
      // The program enforces this exact address; env config is advisory only.
      const protocolTreasury = globalConfig.treasury as PublicKey;
      const [daoRegistry] = getDaoRegistryPDA(founder, daoId);

      // 2. Generate (or confirm) the 4 AI agent keypairs via the backend.
      //    The founder signs a fresh single-use `nave-agent-keys|…` challenge
      //    (built inside generateAgentKeys) to prove ownership.
      if (!signMessage) {
        throw new Error('Connected wallet does not support message signing.');
      }

      const { data: keyData, error: keyError } = await generateAgentKeys(
        daoRegistry.toBase58(),
        founder.toBase58(),
        signMessage,
        daoId,
      );
      if (keyError || !keyData) {
        throw new Error(`Agent key generation failed: ${keyError ?? 'unknown error'}`);
      }
      const agentAuthorities = [
        new PublicKey(keyData.agents.executive.pubkey),
        new PublicKey(keyData.agents.financial.pubkey),
        new PublicKey(keyData.agents.oversight.pubkey),
        new PublicKey(keyData.agents.operational.pubkey),
      ];

      const isTokenGov = config.governanceType === 'token';
      const [vaultAuthority] = getVaultAuthorityPDA(daoRegistry);

      // 3. Resolve the treasury's vault mint.
      //    - Wallet-governance DAOs do NOT create or register any token. Their
      //      vault uses wrapped SOL (NATIVE_MINT) so the treasury can hold funds
      //      without minting a governance token.
      //    - Token-governance DAOs use an existing mint, or create a new one
      //      owned by the DAO (so it can mint/revoke via governance later).
      const decimals = 6;
      let vaultMint: PublicKey;
      let mintResult: TransactionBuildResult | null = null;
      let registerTokenResult: TransactionBuildResult | null = null;
      let createdTokenMint: string | null = null;

      if (!isTokenGov) {
        vaultMint = NATIVE_MINT;
      } else if (config.tokenMode === 'existing' && config.existingTokenCA.trim()) {
        vaultMint = new PublicKey(config.existingTokenCA.trim());
        createdTokenMint = vaultMint.toBase58();
      } else {
        const mintKeypair = Keypair.generate();
        vaultMint = mintKeypair.publicKey;
        createdTokenMint = vaultMint.toBase58();
        const rent = await getMinimumBalanceForRentExemptMint(connection);
        mintResult = {
          // Mint + freeze authority = DAO registry PDA, so the treasury controls
          // future minting and can revoke authorities via governance.
          instruction: createInitializeMint2Instruction(vaultMint, decimals, daoRegistry, daoRegistry),
          preInstructions: [
            SystemProgram.createAccount({
              fromPubkey: founder,
              newAccountPubkey: vaultMint,
              space: MINT_SIZE,
              lamports: rent,
              programId: TOKEN_PROGRAM_ID,
            }),
          ],
          signers: [mintKeypair],
          programId: TOKEN_PROGRAM_ID,
        };
      }

      // 4. Assemble DAO parameters. The connected wallet is always a guardian.
      const guardianWallets =
        config.governanceType === 'wallets' && config.authorizedWallets.length > 0
          ? config.authorizedWallets.map((w) => new PublicKey(w.trim()))
          : [founder];
      if (!guardianWallets.some((w) => w.equals(founder))) {
        guardianWallets.unshift(founder);
      }
      const guardianThreshold = defaultGuardianThreshold(guardianWallets.length);
      const feeRecipient = getAssociatedTokenAddressSync(vaultMint, founder, true);

      const params: InitializeDaoParams = {
        name: config.name,
        guardianWallets,
        guardianThreshold,
        agentAuthorities,
        managementFeeBps: MANAGEMENT_FEE_BPS_NORMAL,
        performanceFeeBps: PERFORMANCE_FEE_BPS,
        frozenManagementFeeBps: MANAGEMENT_FEE_BPS_FROZEN,
        frozenPerformanceFeeBps: FROZEN_PERFORMANCE_FEE_BPS,
        privacyMode: 0,
        feeRecipient,
        // Protocol revenue wallet (15% yield skim). Sourced from
        // VITE_NAVE_PROTOCOL_FEE_WALLET; required non-zero on-chain.
        protocolRevenueWallet: NAVE_PROTOCOL_FEE_WALLET,
        quorumBps: 3500,
        governanceType: isTokenGov ? 1 : 0,
      };

      // 5. Build instructions. The vault ATA is created as a preInstruction on
      //    the extensions transaction.
      const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);
      const extResult = await buildInitializeDaoExtensions(founder, daoId, vaultMint, params);
      extResult.preInstructions = [
        createAssociatedTokenAccountIdempotentInstruction(founder, vaultTokenAccount, vaultAuthority, vaultMint),
      ];

      if (isTokenGov) {
        const tokenInitialSupply =
          config.tokenMode === 'new'
            ? Math.floor(parseFloat(config.newTokenSupply || '0') * 10 ** decimals)
            : 0;
        registerTokenResult = await buildRegisterDaoToken(
          daoRegistry,
          founder,
          vaultMint,
          vaultTokenAccount,
          config.newTokenName || config.name,
          (config.newTokenName || config.name).slice(0, 8).toUpperCase(),
          decimals,
          false, // creation-time registration is covered by the formation fee
          tokenInitialSupply,
        );
      }

      // 6. Strategy positions/escrows are NO LONGER provisioned at creation.
      //    In the multi-asset model they are keyed by a registered, priceable
      //    treasury asset (USDC, wSOL, …) and provisioned per-asset via the
      //    asset-management flow: register_asset → init position/escrow →
      //    configure_position_targets. The DAO governance token is not a
      //    priceable treasury asset, so escrowing it here is invalid.

      // 7. Bundle into sequential signatures:
      //    Tx 1 — Foundation: [mint?] + initialize_dao + agent_wallet_seeding
      //    Tx 2 — Governance: vault ATA + initialize_dao_extensions
      //                       + initialize_dao_governance + [register_token?]
      //
      //    Merging extensions + governance into one tx reduces the required
      //    wallet signatures from 3 → 2 for the init phase (plus the later
      //    Seed & Ratify tx makes 3 total).
      const AGENT_SEED_LAMPORTS = Math.round(AGENT_WALLET_SEED_SOL * 1_000_000_000);
      const seedAgentPubkeys = [
        ...agentAuthorities,
        ...(keyData.agents.planner?.pubkey ? [new PublicKey(keyData.agents.planner.pubkey)] : []),
      ];
      const initDaoResult = await buildInitializeDao(founder, protocolTreasury, daoId, params);
      initDaoResult.preInstructions = [
        ...(initDaoResult.preInstructions ?? []),
        ...seedAgentPubkeys.map((agentKey) =>
          SystemProgram.transfer({
            fromPubkey: founder,
            toPubkey: agentKey,
            lamports: AGENT_SEED_LAMPORTS,
          }),
        ),
      ];

      const foundationGroup: TransactionBuildResult[] = [
        ...(mintResult ? [mintResult] : []),
        initDaoResult,
      ];
      const governanceGroup: TransactionBuildResult[] = [
        extResult,
        await buildInitializeDaoGovernance(founder, daoId, params),
        ...(registerTokenResult ? [registerTokenResult] : []),
      ];

      // FN-H1/H2: sent as TWO separate sendGrouped calls (rather than one call
      // with two groups) so we have a real await boundary between them — the
      // instant the foundation group confirms, the DaoRegistry/TreasuryVault
      // exist on-chain and we can persist a resumable checkpoint BEFORE
      // attempting the governance group. Previously the checkpoint was only
      // built after BOTH groups finished (success or a caught throw), so a
      // governance-group failure that resolved as a normal `error` outcome
      // (not a thrown exception) — or a crash between the two txs — left no
      // recovery record at all, and a later "Try again" would re-run
      // `initialize_dao` with a fresh `daoId`, creating a second DAO while the
      // first stayed half-initialized forever.
      const foundationOutcome = await tx.sendGrouped([foundationGroup], {
        successLabel: 'DAO foundation created',
        quietMock: true,
        quietToast: true,
      });

      if (foundationOutcome.status === 'mock') {
        setDaoAddress(daoRegistry.toBase58());
        setTimeout(() => {
          setDeploying(false);
          setDeploySteps([]);
          navigate('/dao-created', {
            state: {
              daoAddress: daoRegistry.toBase58(),
              name: config.name,
              slug: config.slug,
              description: config.description,
              logoUrl: '',
              governanceType: config.governanceType,
              guardianCount: guardianWallets.length,
              guardianThreshold,
              votingToken: createdTokenMint,
              daoId,
              riskPreset: RISK_PRESETS.find((r) => r.id === policy.riskPreset)?.label ?? policy.riskPreset,
              approvedProtocols: Object.entries(policy.approvedProtocols)
                .filter(([, v]) => v)
                .map(([id]) => id),
            },
          });
        }, 1500);
        return;
      }

      if (foundationOutcome.status !== 'success') {
        setDeploying(false);
        setDeploySteps((prev) =>
          prev.map((s) =>
            s.status === 'running'
              ? { ...s, status: 'error' as DeployStepStatus, detail: foundationOutcome.error ?? undefined }
              : s,
          ),
        );
        setTxError(foundationOutcome.error || 'Deployment failed');
        return;
      }

      // The DaoRegistry + TreasuryVault + VaultAuthority now exist on-chain.
      // Persist a resumable checkpoint IMMEDIATELY — before attempting the
      // governance group — so a crash, a rejected governance signature, or
      // any other failure from this point on can be resumed instead of
      // silently orphaning this DAO and creating a second one.
      currentSubStep = 'governance';
      completeDeployStep('foundation');
      beginDeployStep('governance');
      checkpoint = {
        chain: 'solana',
        daoAddress: daoRegistry.toBase58(),
        daoId,
        founder: founder.toBase58(),
        name: config.name,
        slug: config.slug,
        description: config.description,
        governanceType: config.governanceType,
        tokenMode: config.tokenMode,
        existingTokenCA: config.existingTokenCA,
        newTokenName: config.newTokenName,
        newTokenSupply: config.newTokenSupply,
        votingTokenMint: vaultMint.toBase58(),
        guardianWallets: guardianWallets.map((w) => w.toBase58()),
        seedAmount,
        policy,
        website: config.website,
        twitter: config.twitter,
        discord: config.discord,
        logoUrl: '',
      };
      savePendingDaoCreation({
        ...checkpoint,
        failedStep: SOLANA_SUB_STEP_LABELS.governance,
        failedError: 'Foundation transaction confirmed; DAO governance setup has not completed yet.',
        failedAt: new Date().toISOString(),
      });
      setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));

      const outcome = await tx.sendGrouped([governanceGroup], {
        successLabel: 'Treasury deployed',
        quietMock: true,
        quietToast: true,
      });

      if (outcome.status === 'error') {
        setDeploying(false);
        setDeploySteps((prev) =>
          prev.map((s) =>
            s.status === 'running'
              ? { ...s, status: 'error' as DeployStepStatus, detail: outcome.error ?? undefined }
              : s,
          ),
        );
        setTxError(outcome.error || 'Deployment failed');
        savePendingDaoCreation({
          ...checkpoint,
          failedStep: SOLANA_SUB_STEP_LABELS.governance,
          failedError: outcome.error || 'DAO governance setup failed',
          failedAt: new Date().toISOString(),
        });
        setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));
        return;
      }

      completeDeployStep('governance');

      // 7. Upload the cropped logo (best-effort) before persisting metadata.
      let logoUrl = '';
      if (config.logoBlob) {
        try {
          if (!signMessage) throw new Error('Connected wallet does not support message signing.');
          logoUrl = await uploadDaoLogo(
            config.logoBlob,
            config.name || daoRegistry.toBase58(),
            founder.toBase58(),
            daoRegistry.toBase58(),
            solanaAccessSigner(signMessage),
            { chain: 'solana' },
          );
        } catch {
          /* logo upload is non-blocking */
        }
      }

      const successState = {
        daoAddress: daoRegistry.toBase58(),
        name: config.name,
        slug: config.slug,
        description: config.description,
        logoUrl,
        governanceType: config.governanceType,
        guardianCount: guardianWallets.length,
        guardianThreshold,
        votingToken: createdTokenMint,
        daoId,
        riskPreset: RISK_PRESETS.find((r) => r.id === policy.riskPreset)?.label ?? policy.riskPreset,
        approvedProtocols: Object.entries(policy.approvedProtocols)
          .filter(([, v]) => v)
          .map(([id]) => id),
      };

      // From here on, any failure is a POST-creation failure — refresh the
      // checkpoint (now with the real uploaded logoUrl) so a retry (via the
      // "Resume setup" banner) can finish the remaining steps instead of
      // restarting the wizard (which would create a SECOND DAO).
      checkpoint = {
        chain: 'solana',
        daoAddress: daoRegistry.toBase58(),
        daoId,
        founder: founder.toBase58(),
        name: config.name,
        slug: config.slug,
        description: config.description,
        governanceType: config.governanceType,
        tokenMode: config.tokenMode,
        existingTokenCA: config.existingTokenCA,
        newTokenName: config.newTokenName,
        newTokenSupply: config.newTokenSupply,
        // The vault mint (wSOL for wallet gov, the created/existing mint for
        // token gov) — resume needs this to re-derive the activation context.
        votingTokenMint: vaultMint.toBase58(),
        guardianWallets: guardianWallets.map((w) => w.toBase58()),
        seedAmount,
        policy,
        website: config.website,
        twitter: config.twitter,
        discord: config.discord,
        logoUrl,
      };

      // ── Auto-activation: seed + ratify (one tx), then start agents off-chain.
      if (outcome.status === 'success') {
        currentSubStep = 'activate';
        beginDeployStep('activate');
        const wizardSeedNum = parseFloat(seedAmount);
        const seedLamports = !isNaN(wizardSeedNum) && wizardSeedNum > 0
          ? Math.round(wizardSeedNum * LAMPORTS_PER_SOL)
          : Math.round(TREASURY_SEED_SOL * LAMPORTS_PER_SOL);
        const activationResult = await runSolanaAutoActivation({
          connection,
          daoRegistry,
          founder,
          governanceType: isTokenGov ? 'token' : 'wallet',
          daoTokenMint: vaultMint,
          guardianWalletCount: guardianWallets.length,
          seedLamports,
          // agentThresholdUsdMicro is derived post-revalue inside createDaoActivation
          constitutionProtocols: Object.entries(policy.approvedProtocols)
            .filter(([, v]) => v)
            .map(([id]) => ({ id })),
          policyParams: {
            maxAllocationBps: Math.round(policy.maxLending * 100),
            minStablecoinReserveBps: Math.round(policy.minStablecoin * 100),
            maxTotalDeployedBps: Math.round(policy.maxDeployment * 100),
            minLiquidityBps: Math.round(policy.liquidityReserve * 100),
            rebalanceFrequencySecs: rebalanceFreqToSecs(policy.rebalanceFreq),
            confidenceThreshold: SYSTEM_CONFIDENCE_THRESHOLD,
          },
          send: tx.send,
          sendGrouped: tx.sendGrouped,
          setAgentsEnabled: async (enabled) => {
            if (!signMessage) return { error: 'Connected wallet does not support message signing.' };
            const { data, error } = await setAgentsEnabledViaProxy(
              daoRegistry.toBase58(),
              founder.toBase58(),
              signMessage,
              enabled,
            );
            return {
              error: error ?? (data && data.success === false ? data.error ?? 'Agent start failed' : null),
            };
          },
          onStep: (id, status, detail) => {
            const stepId: Record<ActivationStepId, string> = {
              seedAndRatify: 'activate',
              agents: 'agents',
            };
            const mapped = stepId[id];
            if (status === 'running') beginDeployStep(mapped);
            else if (status === 'done' || status === 'skipped') completeDeployStep(mapped, detail);
            else if (status === 'error') failDeployStep(mapped, detail);
          },
        });
        // seedAndRatify (required) failing leaves the treasury created but
        // not ratified/activated — surface it as a resumable failure instead
        // of silently continuing to metadata registration and navigation.
        if (!activationResult.ok) {
          throw new Error(
            `Treasury created, but constitution activation failed: ${activationResult.error ?? 'unknown error'}. ` +
            `Treasury address: ${daoRegistry.toBase58()}`,
          );
        }
      }

      setDeploying(false);
      setDeploySteps([]);

      if (outcome.status === 'success') {
        // Attach off-chain metadata (name, description, logo, socials) to the
        // registry before routing. If this fails, the DAO exists on-chain but
        // would be hard to find in the app, so surface the recovery address.
        currentSubStep = 'register-metadata';
        const { error: registerError } = await registerDao({
          dao_address: daoRegistry.toBase58(),
          creator_wallet: founder.toBase58(),
          name: config.name,
          slug: config.slug,
          description: config.description,
          logo_url: logoUrl,
          governance_type: isTokenGov ? 'token' : 'wallet',
          voting_token_mint: isTokenGov ? createdTokenMint ?? undefined : undefined,
          authorized_wallets: !isTokenGov ? guardianWallets.map((w) => w.toBase58()) : undefined,
          privacy_enabled: false,
          social_website: config.website,
          social_twitter: config.twitter,
          social_discord: config.discord,
          dao_id: daoId,
          chain: 'solana',
          network: SOLANA_NETWORK === 'mainnet' ? 'mainnet' : 'devnet',
        }, solanaAccessSigner(signMessage));
        if (registerError) {
          setTxError(
            `Treasury created on-chain, but metadata sync failed: ${registerError}. ` +
              `Treasury address: ${daoRegistry.toBase58()}`,
          );
          setDaoAddress(daoRegistry.toBase58());
          if (checkpoint) {
            savePendingDaoCreation({
              ...checkpoint,
              failedStep: SOLANA_SUB_STEP_LABELS[currentSubStep] ?? currentSubStep,
              failedError: registerError,
              failedAt: new Date().toISOString(),
            });
            setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));
          }
          return;
        }
        // register-dao auto-watches the creator wallet server-side (watch-dao
        // now needs its own signed challenge — no extra wallet prompt here).

        clearPendingDaoCreation('solana', founder.toBase58());
        setPendingResume(null);
        setDaoAddress(daoRegistry.toBase58());
        navigate('/dao-created', { state: successState });
      } else {
        setTxError(outcome.error || 'Deployment failed');
      }
    } catch (err) {
      setDeploying(false);
      const msg = err instanceof Error ? err.message : 'Deployment failed';
      setTxError(msg);
      setDeploySteps((prev) =>
        prev.map((s) =>
          s.status === 'running'
            ? { ...s, status: 'error' as DeployStepStatus, detail: msg }
            : s,
        ),
      );
      // The DAO already exists on-chain (checkpoint is set as soon as the
      // foundation tx lands, before the governance tx is even attempted) —
      // persist a resumable checkpoint.
      if (checkpoint) {
        savePendingDaoCreation({
          ...checkpoint,
          failedStep: SOLANA_SUB_STEP_LABELS[currentSubStep] ?? currentSubStep,
          failedError: msg,
          failedAt: new Date().toISOString(),
        });
        setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));
      }
    }
  }

  // ── Resume setup: re-run ONLY the remaining post-creation steps for an
  // already-on-chain DAO. Every step below is checked against on-chain/
  // off-chain state before acting (idempotent), so calling this after ANY
  // partial failure — including one already retried — can never double-submit
  // a step that landed. Reuses the exact same building blocks as the main
  // deploy flows (bindEvmAgentKeys, registerDao are
  // idempotent upserts server-side; runEvmActivation/runSolanaAutoActivation
  // check on-chain state per step — see createDaoActivationEvm.ts /
  // createDaoActivation.ts).
  async function resumeEvmDaoCreation(record: PendingDaoCreation) {
    if (!evmConnected || !evmAddress) {
      setWalletError(true);
      throw new Error('Connect the EVM wallet used to create this DAO to resume.');
    }
    if (evmAddress.toLowerCase() !== record.founder.toLowerCase()) {
      throw new Error(`Connect the wallet that started this setup (${record.founder}) to resume.`);
    }
    const chainId = record.chainId as EvmChainId;
    const family = record.chain as DaoEvmChainFamily;
    await ensureWalletOnChain(chainId);
    const treasury = record.daoAddress as Address;
    const founder = evmAddress as Address;
    const isTokenGov = record.governanceType === 'token';
    let votingTokenMint: Address | null = toAddress(record.votingTokenMint);

    // 1. Agent key binding — idempotent: `bind` only updates rows still keyed
    //    to the pending ref, so a second call after a successful bind is a safe no-op.
    if (record.daoRef) {
      const bindMsg = `nave-evm-keybind|${record.daoRef}|${treasury.toLowerCase()}|${chainId}|${Date.now()}`;
      const bindSig = await signEvmMessage({ message: bindMsg });
      const { error: bindError } = await bindEvmAgentKeys(record.daoRef, treasury, founder, chainId, family, bindMsg, bindSig);
      if (bindError) throw new Error(`Agent key binding failed: ${bindError}`);
    }

    // 2. Governance token — on-chain idempotency check (votingToken() != 0 ⇒ already registered).
    if (isTokenGov) {
      const existingTokenRaw = await readContract(wagmiConfig, {
        address: treasury, abi: NaveTreasuryAbi, functionName: 'votingToken', chainId,
      }).catch(() => null);
      const existingAddr = existingTokenRaw && String(existingTokenRaw).toLowerCase() !== ZERO_EVM_ADDRESS
        ? toAddress(existingTokenRaw as string)
        : null;
      if (existingAddr) {
        votingTokenMint = existingAddr;
      } else if (record.tokenMode === 'new') {
        const evmDecimals = 18;
        const initialSupply = parseUnits(record.newTokenSupply || '0', evmDecimals);
        if (initialSupply <= 0n) throw new Error('Enter a positive initial token supply.');
        const tokenOutcome = await tx.sendEvm(
          buildRegisterDaoTokenEvm(
            chainId, treasury,
            record.newTokenName.trim(),
            record.newTokenName.trim().toUpperCase().slice(0, 11),
            evmDecimals, initialSupply, treasury,
            parseEther(String(TOKEN_MINT_FEE_ETH)),
          ),
          { successLabel: 'Governance token deployed' },
        );
        if (tokenOutcome.status !== 'success' || !tokenOutcome.txHash) {
          throw new Error(tokenOutcome.error || 'Governance token registration failed.');
        }
        const tokenReceipt = await getTransactionReceipt(wagmiConfig, { hash: tokenOutcome.txHash as `0x${string}`, chainId });
        for (const log of tokenReceipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: NaveTreasuryAbi, data: log.data, topics: log.topics });
            if (decoded.eventName === 'DaoTokenRegistered') {
              votingTokenMint = (decoded.args as unknown as { mint: Address }).mint;
              break;
            }
          } catch { /* not a DaoTokenRegistered log */ }
        }
        if (!votingTokenMint) throw new Error('Governance token registered, but the address could not be decoded.');
      } else if (record.tokenMode === 'existing') {
        votingTokenMint = toAddress(record.existingTokenCA);
        if (!votingTokenMint) throw new Error('Missing a valid existing governance token address to resume with.');
        let tokenDecimals = 18;
        try {
          tokenDecimals = Number(await readContract(wagmiConfig, {
            address: votingTokenMint, abi: Erc20Abi, functionName: 'decimals', chainId,
          }));
        } catch { /* default 18 */ }
        const tokenName = record.name.trim() || 'Governance Token';
        const tokenSymbol = tokenName.toUpperCase().slice(0, 11) || 'GOV';
        const regOutcome = await tx.sendEvm(
          buildRegisterExternalDaoTokenEvm(chainId, treasury, votingTokenMint, tokenName, tokenSymbol, tokenDecimals),
          { successLabel: 'Governance token registered' },
        );
        if (regOutcome.status !== 'success' && regOutcome.status !== 'mock') {
          throw new Error(regOutcome.error || 'Governance token registration failed.');
        }
      }
    }

    rememberDaoChain(treasury, chainId);
    setDaoAddress(treasury);

    // 3. Off-chain metadata — idempotent upsert (register-dao; fresh single-use challenge).
    const { error: registerError } = await registerDao({
      dao_address: treasury,
      creator_wallet: founder,
      name: record.name,
      slug: record.slug,
      description: record.description,
      logo_url: record.logoUrl,
      governance_type: isTokenGov ? 'token' : 'wallet',
      voting_token_mint: isTokenGov ? votingTokenMint ?? undefined : undefined,
      authorized_wallets: record.guardianWallets,
      privacy_enabled: false,
      social_website: record.website,
      social_twitter: record.twitter,
      social_discord: record.discord,
      chain: family,
      chain_id: chainId,
    }, async (m) => {
      await ensureWalletOnChain(chainId);
      return signEvmMessage({ message: m });
    });
    if (registerError) throw new Error(`Metadata sync failed: ${registerError}`);
    // register-dao auto-watches the creator wallet server-side.

    // 4. Constitution activation — idempotent (createDaoActivationEvm.ts checks).
    const chainLabel = evmActivationChainFamily(chainId);
    const evmActivationResult = await runEvmActivation({
      daoAddress: treasury,
      chainId,
      chain: chainLabel,
      founderAddress: founder,
      policy: record.policy,
      seedAmount: record.seedAmount,
      sendEvm: (r, opts) => tx.sendEvm(r, opts),
      signMessage: async (msg) => {
        await ensureWalletOnChain(chainId);
        return signEvmMessage({ message: msg });
      },
      onStep: () => {},
    });
    if (!evmActivationResult.ok) {
      throw new Error(`Constitution activation failed: ${evmActivationResult.error ?? 'unknown error'}`);
    }

    clearPendingDaoCreation(family, founder);
    setPendingResume(null);
    navigate('/dao-created', { state: {
      daoAddress: treasury,
      name: record.name,
      slug: record.slug,
      description: record.description,
      logoUrl: record.logoUrl,
      governanceType: record.governanceType,
      guardianCount: record.guardianWallets.length,
      guardianThreshold: defaultGuardianThreshold(record.guardianWallets.length, 1),
      votingToken: votingTokenMint ?? null,
      chainId,
      agentError: evmActivationResult.agentError,
    } });
  }

  async function resumeSolanaDaoCreation(record: PendingDaoCreation) {
    if (!connected || !publicKey) {
      setWalletError(true);
      setVisible(true);
      throw new Error('Connect the Solana wallet used to create this DAO to resume.');
    }
    if (publicKey.toBase58() !== record.founder) {
      throw new Error(`Connect the wallet that started this setup (${record.founder}) to resume.`);
    }
    if (!signMessage) throw new Error('Connected wallet does not support message signing.');

    const founder = publicKey;
    const daoRegistry = new PublicKey(record.daoAddress);
    const isTokenGov = record.governanceType === 'token';
    const vaultMint = record.votingTokenMint ? new PublicKey(record.votingTokenMint) : NATIVE_MINT;
    const guardianWallets = record.guardianWallets.map((w) => new PublicKey(w));

    const { core } = getNavePrograms(connection);

    // 0. Extensions + governance (AgentSet/FeeConfig from initialize_dao_extensions;
    //    GuardianConfig/Constitution/TokenRegistry from initialize_dao_governance,
    //    plus register_dao_token — all three land in ONE atomic transaction, the
    //    same "governance group" handleDeploy sends right after the foundation
    //    group). FN-H1/H2: the checkpoint is now persisted the moment the
    //    foundation group confirms, which means a resume can land here with
    //    ONLY the DaoRegistry/TreasuryVault/VaultAuthority created and NOTHING
    //    else — a stale resume implementation that jumped straight to constitution
    //    activation below would fail immediately (those
    //    steps depend on accounts this group creates). Detect that case via the
    //    AgentSet PDA (idempotency-checked — its existence implies the whole
    //    governance group already landed, since it's one atomic transaction)
    //    and complete the governance group first if it's missing.
    const [agentSetPda] = getAgentSetPDA(daoRegistry);
    const extensionsAndGovernanceDone = (await core.account.agentSet.fetchNullable(agentSetPda)) !== null;
    if (!extensionsAndGovernanceDone) {
      // Idempotent: generate-agent-keys returns the SAME pubkeys already
      // generated (and already seeded via agent_wallet_seeding in the
      // foundation tx) for this dao_address rather than minting new ones.
      // A fresh single-use challenge is signed inside generateAgentKeys.
      const { data: keyData, error: keyError } = await generateAgentKeys(
        daoRegistry.toBase58(),
        founder.toBase58(),
        signMessage,
        record.daoId,
      );
      if (keyError || !keyData) {
        throw new Error(`Could not recover agent keys to resume governance setup: ${keyError ?? 'unknown error'}`);
      }
      const agentAuthorities = [
        new PublicKey(keyData.agents.executive.pubkey),
        new PublicKey(keyData.agents.financial.pubkey),
        new PublicKey(keyData.agents.oversight.pubkey),
        new PublicKey(keyData.agents.operational.pubkey),
      ];
      const decimals = 6;
      const [vaultAuthority] = getVaultAuthorityPDA(daoRegistry);
      const feeRecipient = getAssociatedTokenAddressSync(vaultMint, founder, true);
      const guardianThreshold = defaultGuardianThreshold(guardianWallets.length);
      const resumeParams: InitializeDaoParams = {
        name: record.name,
        guardianWallets,
        guardianThreshold,
        agentAuthorities,
        managementFeeBps: MANAGEMENT_FEE_BPS_NORMAL,
        performanceFeeBps: PERFORMANCE_FEE_BPS,
        frozenManagementFeeBps: MANAGEMENT_FEE_BPS_FROZEN,
        frozenPerformanceFeeBps: FROZEN_PERFORMANCE_FEE_BPS,
        privacyMode: 0,
        feeRecipient,
        protocolRevenueWallet: NAVE_PROTOCOL_FEE_WALLET,
        quorumBps: 3500,
        governanceType: isTokenGov ? 1 : 0,
      };
      const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);
      const extResult = await buildInitializeDaoExtensions(founder, record.daoId!, vaultMint, resumeParams);
      extResult.preInstructions = [
        createAssociatedTokenAccountIdempotentInstruction(founder, vaultTokenAccount, vaultAuthority, vaultMint),
      ];
      let registerTokenResult: TransactionBuildResult | null = null;
      if (isTokenGov) {
        const tokenInitialSupply = record.tokenMode === 'new'
          ? Math.floor(parseFloat(record.newTokenSupply || '0') * 10 ** decimals)
          : 0;
        registerTokenResult = await buildRegisterDaoToken(
          daoRegistry,
          founder,
          vaultMint,
          vaultTokenAccount,
          record.newTokenName || record.name,
          (record.newTokenName || record.name).slice(0, 8).toUpperCase(),
          decimals,
          false,
          tokenInitialSupply,
        );
      }
      const governanceGroup: TransactionBuildResult[] = [
        extResult,
        await buildInitializeDaoGovernance(founder, record.daoId!, resumeParams),
        ...(registerTokenResult ? [registerTokenResult] : []),
      ];
      const governanceOutcome = await tx.sendGrouped([governanceGroup], {
        successLabel: 'DAO governance completed',
        quietMock: true,
        quietToast: true,
      });
      if (governanceOutcome.status !== 'success' && governanceOutcome.status !== 'mock') {
        throw new Error(governanceOutcome.error || 'Failed to complete DAO governance setup.');
      }
    }

    // Constitution activation — idempotent (createDaoActivation.ts checks).
    // New treasuries do not lock NAVE. An existing lock, if any, is released on moonlight.
    const wizardSeedNum = parseFloat(record.seedAmount);
    const seedLamports = !isNaN(wizardSeedNum) && wizardSeedNum > 0
      ? Math.round(wizardSeedNum * LAMPORTS_PER_SOL)
      : Math.round(TREASURY_SEED_SOL * LAMPORTS_PER_SOL);
    const activationResult = await runSolanaAutoActivation({
      connection,
      daoRegistry,
      founder,
      governanceType: isTokenGov ? 'token' : 'wallet',
      daoTokenMint: vaultMint,
      guardianWalletCount: guardianWallets.length,
      seedLamports,
      constitutionProtocols: Object.entries(record.policy.approvedProtocols)
        .filter(([, v]) => v)
        .map(([id]) => ({ id })),
      policyParams: {
        maxAllocationBps: Math.round(record.policy.maxLending * 100),
        minStablecoinReserveBps: Math.round(record.policy.minStablecoin * 100),
        maxTotalDeployedBps: Math.round(record.policy.maxDeployment * 100),
        minLiquidityBps: Math.round(record.policy.liquidityReserve * 100),
        rebalanceFrequencySecs: rebalanceFreqToSecs(record.policy.rebalanceFreq),
        confidenceThreshold: SYSTEM_CONFIDENCE_THRESHOLD,
      },
      send: tx.send,
      sendGrouped: tx.sendGrouped,
      setAgentsEnabled: async (enabled) => {
        const { data, error } = await setAgentsEnabledViaProxy(daoRegistry.toBase58(), founder.toBase58(), signMessage, enabled);
        return { error: error ?? (data && data.success === false ? data.error ?? 'Agent start failed' : null) };
      },
      onStep: () => {},
    });
    if (!activationResult.ok) {
      throw new Error(`Constitution activation failed: ${activationResult.error ?? 'unknown error'}`);
    }

    // 3. Off-chain metadata — idempotent upsert (register-dao); a fresh
    //    single-use challenge is signed inside registerDao.
    const { error: registerError } = await registerDao({
      dao_address: daoRegistry.toBase58(),
      creator_wallet: founder.toBase58(),
      name: record.name,
      slug: record.slug,
      description: record.description,
      logo_url: record.logoUrl,
      governance_type: isTokenGov ? 'token' : 'wallet',
      voting_token_mint: isTokenGov ? record.votingTokenMint ?? undefined : undefined,
      authorized_wallets: !isTokenGov ? guardianWallets.map((w) => w.toBase58()) : undefined,
      privacy_enabled: false,
      social_website: record.website,
      social_twitter: record.twitter,
      social_discord: record.discord,
      dao_id: record.daoId,
      chain: 'solana',
      network: SOLANA_NETWORK === 'mainnet' ? 'mainnet' : 'devnet',
    }, solanaAccessSigner(signMessage));
    if (registerError) {
      setDaoAddress(daoRegistry.toBase58());
      throw new Error(`Metadata sync failed: ${registerError}`);
    }
    // register-dao auto-watches the creator wallet server-side.

    clearPendingDaoCreation('solana', founder.toBase58());
    setPendingResume(null);
    setDaoAddress(daoRegistry.toBase58());
    navigate('/dao-created', { state: {
      daoAddress: daoRegistry.toBase58(),
      name: record.name,
      slug: record.slug,
      description: record.description,
      logoUrl: record.logoUrl,
      governanceType: record.governanceType,
      guardianCount: guardianWallets.length,
      guardianThreshold: defaultGuardianThreshold(guardianWallets.length),
      votingToken: isTokenGov ? record.votingTokenMint : null,
      daoId: record.daoId,
      riskPreset: RISK_PRESETS.find((r) => r.id === record.policy.riskPreset)?.label ?? record.policy.riskPreset,
      approvedProtocols: Object.entries(record.policy.approvedProtocols).filter(([, v]) => v).map(([id]) => id),
    } });
  }

  async function handleResumeSetup() {
    if (!pendingResume || resuming) return;
    const record = pendingResume;
    setResuming(true);
    setTxError(null);
    try {
      if (record.chain === 'solana') {
        await resumeSolanaDaoCreation(record);
      } else {
        await resumeEvmDaoCreation(record);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resume failed';
      setTxError(msg);
      savePendingDaoCreation({ ...record, failedError: msg, failedAt: new Date().toISOString() });
      setPendingResume(findPendingDaoCreationForWallet(record.founder));
    } finally {
      setResuming(false);
    }
  }

  function dismissPendingResume() {
    if (!pendingResume) return;
    clearPendingDaoCreation(pendingResume.chain, pendingResume.founder);
    setPendingResume(null);
  }

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      {/* Top bar */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 border-b"
        style={{
          backgroundColor: 'hsl(var(--surface-0))',
          borderColor: 'hsl(var(--border))',
          backdropFilter: 'blur(10px)',
        }}
      >
        <button
          onClick={() => navigate('/')}
          className="text-display no-underline"
          style={{ fontSize: '19px', color: 'hsl(var(--foreground))' }}
        >
          Nave
        </button>
        <StepIndicator
          steps={wizardSteps}
          current={setupMode ? displayStepIndex(step, setupMode) : 0}
        />
        <div className="flex items-center gap-3">
          {(config.chain === 'solana' ? !connected : !evmConnected) && (
            <button
              type="button"
              onClick={openCreateWallet}
              className="px-3 py-1.5 rounded-lg font-medium"
              style={{ fontSize: '13px', backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
            >
              Connect
            </button>
          )}
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5"
            style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
          >
            <Fi icon="xmark" style={{ fontSize: '14px' }} />
            Exit
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
        {pendingResume && !deploying && (
          <div
            className="flex flex-col gap-2.5 px-4 py-3.5 rounded-xl border mb-6 animate-fade-in"
            style={{ backgroundColor: 'hsl(var(--warning-muted))', borderColor: 'hsl(38 92% 75%)' }}
          >
            <div className="flex items-start gap-2.5">
              <Fi icon="arrows-rotate" style={{ fontSize: '13px', color: 'hsl(var(--warning))', flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '13px', color: 'hsl(38 55% 30%)' }}>
                <strong>Resume setup</strong> — "{pendingResume.name || pendingResume.daoAddress}" was created
                on-chain ({chainDisplayLabel(pendingResume.chain)}), but setup didn't finish:{' '}
                {pendingResume.failedStep} failed ({pendingResume.failedError}). Your treasury is safe — finish
                setup instead of creating a new one.
              </div>
            </div>
            <div className="flex items-center gap-2" style={{ marginLeft: '22px' }}>
              <button
                onClick={handleResumeSetup}
                disabled={resuming}
                className="px-3 py-1.5 rounded-lg text-display"
                style={{
                  fontSize: '12.5px',
                  backgroundColor: 'hsl(var(--warning))',
                  color: 'hsl(var(--warning-foreground, 0 0% 100%))',
                  opacity: resuming ? 0.6 : 1,
                }}
              >
                {resuming ? 'Resuming…' : 'Resume setup'}
              </button>
              <button
                onClick={dismissPendingResume}
                disabled={resuming}
                style={{ fontSize: '12.5px', color: 'hsl(38 55% 40%)' }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {walletError && (
          <div
            className="flex items-center gap-2.5 px-4 py-3 rounded-xl border mb-6 animate-fade-in"
            style={{ backgroundColor: 'hsl(var(--warning-muted))', borderColor: 'hsl(38 92% 75%)' }}
          >
            <Fi icon="triangle-exclamation" style={{ fontSize: '13px', color: 'hsl(var(--warning))', flexShrink: 0 }} />
            <span style={{ fontSize: '13px', color: 'hsl(38 55% 30%)' }}>
              Please connect your wallet to deploy a treasury.
            </span>
            <button
              onClick={() => setWalletError(false)}
              style={{ marginLeft: 'auto', color: 'hsl(38 55% 40%)' }}
            >
              <Fi icon="xmark" style={{ fontSize: '13px' }} />
            </button>
          </div>
        )}
        {txError && !deploySteps.length && (
          <div
            className="flex items-center gap-2.5 px-4 py-3 rounded-xl border mb-6 animate-fade-in"
            style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))', flexShrink: 0 }} />
            <span style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }}>
              {txError}
            </span>
            <button
              onClick={() => setTxError(null)}
              style={{ marginLeft: 'auto', color: 'hsl(var(--destructive))' }}
            >
              <Fi icon="xmark" style={{ fontSize: '13px' }} />
            </button>
          </div>
        )}
        {step === 0 && (
          <Step1
            config={config}
            setConfig={setConfig}
            connectedWallet={connectedWallet}
            onSlugReadyChange={onSlugReadyChange}
            quickMode={setupMode === 'quick'}
          />
        )}
        {setupMode === 'advanced' && step === 1 && (
          <ConstitutionStep
            policy={policy}
            setPolicy={setPolicy}
            chain={config.chain === 'solana' ? 'solana' : 'evm'}
            evmChainId={
              config.chain !== 'solana'
                ? activeEvmChainId(config.chain as Exclude<ChainFamily, 'solana'>)
                : undefined
            }
            offeredPresets={['conservative', 'balanced', 'yield6']}
          />
        )}
        {step === 2 && (
          <SeedReviewStep
            config={config}
            policy={policy}
            seedAmount={seedAmount}
            setSeedAmount={setSeedAmount}
            onDeploy={handleDeploy}
            deploying={deploying}
            evmFormationFeeWei={evmFormationFeeWei}
            evmFormationFeeLoading={evmFormationFeeLoading}
          />
        )}

        {/* Nav buttons */}
        {step === 0 && (
          <>
            <div className="flex items-center justify-between mt-10 pt-6 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
              <button
                onClick={() => selectSetupMode(setupMode === 'quick' ? 'advanced' : 'quick')}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg border transition-colors"
                style={{ fontSize: '13.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                {setupMode === 'quick' ? 'Advanced setup' : 'Quick setup'}
              </button>
              <button
                onClick={() => setStep(setupMode === 'quick' ? 2 : 1)}
                disabled={!canAdvance()}
                className="flex items-center gap-2 px-6 py-2 rounded-lg font-medium transition-all"
                style={{
                  fontSize: '13.5px',
                  backgroundColor: canAdvance() ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                  color: canAdvance() ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                  cursor: canAdvance() ? 'pointer' : 'not-allowed',
                }}
              >
                {setupMode === 'quick' ? 'Review' : 'Constitution'}
                <Fi icon="arrow-right" style={{ fontSize: '12px' }} />
              </button>
            </div>
            {slugMessage && config.slug.trim() && (
              <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', marginTop: '8px', textAlign: 'right' }}>
                {slugMessage}
              </p>
            )}
          </>
        )}

        {setupMode === 'advanced' && step === 1 && (
          <div className="flex items-center justify-between mt-10 pt-6 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
            <button
              onClick={() => setStep(0)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border transition-colors"
              style={{ fontSize: '13.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <Fi icon="arrow-left" style={{ fontSize: '12px' }} />
              Back to Identity
            </button>
            <button
              onClick={() => setStep(2)}
              disabled={!canAdvance()}
              className="flex items-center gap-2 px-6 py-2 rounded-lg font-medium transition-all"
              style={{
                fontSize: '13.5px',
                backgroundColor: canAdvance() ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                color: canAdvance() ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                cursor: canAdvance() ? 'pointer' : 'not-allowed',
              }}
            >
              Seed & Review
              <Fi icon="arrow-right" style={{ fontSize: '12px' }} />
            </button>
          </div>
        )}

        {step === 2 && !deploying && (
          <div className="flex items-center mt-10 pt-6 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
            <button
              onClick={() => setStep(setupMode === 'quick' ? 0 : 1)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border transition-colors"
              style={{ fontSize: '13.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <Fi icon="arrow-left" style={{ fontSize: '12px' }} />
              {setupMode === 'quick' ? 'Back to Setup' : 'Back to Constitution'}
            </button>
          </div>
        )}
      </div>

      <TreasuryDeployModal
        open={deploySteps.length > 0}
        chainLabel={chainDisplayLabel(config.chain)}
        steps={deploySteps}
        activeHint={deployActiveHint}
        error={txError}
        deploying={deploying}
        onClose={() => {
          if (deploying && !txError) return;
          setDeploySteps([]);
          setTxError(null);
        }}
        onRetry={() => {
          setTxError(null);
          void handleDeploy();
        }}
      />
    </div>
  );
}