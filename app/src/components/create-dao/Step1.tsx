import { useState, useEffect } from 'react';
import { PublicKey } from '@solana/web3.js';
import { isAddress } from 'viem';
import Fi from '../Fi';
import LogoUpload from '../LogoUpload';
import ChainSelector from '../ChainSelector';
import { Notice } from '../calm';
import { EVM_DEPLOYMENT_MODE, defaultGuardianThreshold } from '../../lib/programConfig';
import { USER_CHAINS } from '../../lib/chain/types';
import {
  checkDaoSlugAvailability,
  formatDaoSlugLabel,
  getDaoPublicUrl,
  normalizeDaoSlug,
  validateDaoSlug,
} from '../../lib/daoSlug';
import {
  type DAOConfig,
  type GovernanceType,
  type TokenMode,
  Field,
  TextInput,
  previewGuardianCount,
} from './CreateDaoHelpers';

export default function Step1({
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
    <div>
      {quickMode && (
        <Notice tone="brass" className="mb-6">
          <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
            Uses authorized-wallet governance with your connected wallet as guardian and the Conservative constitution (60% safe reserve, up to 40% deployed).
          </span>
        </Notice>
      )}

      {/* Treasury name (+ optional logo in advanced mode) */}
      <div style={{ marginBottom: '26px' }}>
        <div className="flex items-start gap-4">
          {!quickMode && (
            <div className="flex-shrink-0">
              <label className="block" style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'hsl(var(--foreground))' }}>
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
            <label className="block" style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'hsl(var(--foreground))' }}>
              Name
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
              placeholder="e.g. Solana Builders Collective"
              className="w-full rounded-[10px] border outline-none transition-colors"
              style={{
                padding: '11px 13px',
                fontSize: '14.5px',
                fontFamily: 'var(--font-body)',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
              onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
            />
          </div>
        </div>
      </div>

      {/* Treasury Slug — nave.dao */}
      <Field
        label="Treasury Slug"
        hint="Your public name on Nave. Used to join (e.g. nave) and for short links like nave.finance/dao/nave."
      >
        <div
          className="flex items-center rounded-[10px] border overflow-hidden"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: '#ffffff' }}
        >
          <input
            type="text"
            value={config.slug}
            onChange={e => {
              setSlugManual(true);
              setConfig({ slug: normalizeDaoSlug(e.target.value) });
            }}
            placeholder="nave"
            className="flex-1 min-w-0 outline-none"
            style={{
              padding: '11px 13px',
              fontSize: '14px',
              fontFamily: 'var(--font-mono)',
              backgroundColor: 'transparent',
              color: 'hsl(var(--foreground))',
            }}
          />
          <span
            className="px-3.5 py-2.5 border-l nave-mono flex-shrink-0"
            style={{
              fontSize: '13px',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--muted-foreground))',
              backgroundColor: 'hsl(var(--background))',
            }}
          >
            .dao
          </span>
        </div>
        {config.slug && validateDaoSlug(config.slug).valid && (
          <div style={{ fontSize: '12.5px', color: slugChecking ? 'hsl(var(--faint))' : 'hsl(var(--success))', marginTop: '6px' }}>
            {slugChecking ? 'Checking availability…' : `✓ Its home will be ${getDaoPublicUrl(config.slug)}`}
          </div>
        )}
      </Field>

      <Field
        label="Network"
        hint={
          EVM_DEPLOYMENT_MODE === 'testnet'
            ? 'Testnet treasuries can launch on Solana, Ethereum, Base, Robinhood, or Arc.'
            : 'Base — low fees, earning via Aave & Compound built in. You invite members after launch.'
        }
      >
        <ChainSelector
          value={config.chain}
          onChange={(chain) => setConfig({ chain })}
          chains={USER_CHAINS}
          label=""
        />
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
          className="w-full rounded-[10px] border outline-none transition-colors resize-none"
          style={{
            padding: '11px 13px',
            fontSize: '14px',
            fontFamily: 'var(--font-body)',
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
          onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
          onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
        />
        <div style={{ fontSize: '11px', color: 'hsl(var(--faint))', textAlign: 'right', marginTop: '4px' }}>
          {config.description.length}/280
        </div>
      </Field>

      {/* Governance type */}
      <Field label="Who decides?">
        <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
          {([
            {
              id: 'wallets' as GovernanceType,
              label: 'Authorized Wallets',
              desc: 'Named members, one vote each. Simplest to start.',
              rec: 'Recommended',
            },
            {
              id: 'token' as GovernanceType,
              label: 'Token-Based',
              desc: 'Power follows a token. For large, open communities.',
            },
          ]).map(g => {
            const sel = config.governanceType === g.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => selectGovernance(g.id)}
                className="w-full flex items-start gap-3 py-3.5 text-left"
                style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
              >
                <span
                  style={{
                    width: '17px',
                    height: '17px',
                    borderRadius: '50%',
                    border: sel ? '1.5px solid hsl(var(--foreground))' : '1.5px solid #CFC8B8',
                    marginTop: '2px',
                    flexShrink: 0,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {sel && (
                    <span
                      style={{
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: 'hsl(var(--foreground))',
                      }}
                    />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <strong style={{ fontSize: '14px', fontWeight: 500, display: 'block', color: 'hsl(var(--foreground))' }}>
                    {g.label}
                  </strong>
                  <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', margin: '2px 0 0', lineHeight: 1.5 }}>
                    {g.desc}
                  </p>
                </span>
                {'rec' in g && g.rec && (
                  <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'hsl(var(--brass))', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {g.rec}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Field>

      {/* — Wallet branch — */}
      {config.governanceType === 'wallets' && (
        <div
          className="space-y-5 pt-4"
          style={{ borderTop: '1px solid hsl(var(--surface-2))', marginBottom: '26px' }}
        >
          <Field label="Authorized Wallets" hint="Wallets that can vote on proposals. Your connected wallet is added automatically; you can add or remove others. Manage these anytime in Settings.">
            <p className="mb-3" style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
              Emergency actions need{' '}
              <strong>{defaultGuardianThreshold(previewGuardianCount(config), config.chain === 'solana' ? 0 : 1)} of {previewGuardianCount(config)}</strong> guardian approvals
              {config.chain !== 'solana' && ' (one is Nave-custodied; with two or more guardians of your own, they can reach this without it)'}.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={walletInput}
                onChange={e => setWalletInput(e.target.value)}
                placeholder="Paste wallet address…"
                className="flex-1 px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
                style={{
                  fontSize: '13px',
                  fontFamily: 'var(--font-mono)',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
                onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                onKeyDown={e => e.key === 'Enter' && addWallet()}
              />
              <button
                type="button"
                onClick={addWallet}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold transition-all flex-shrink-0"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                }}
              >
                <Fi icon="plus" style={{ fontSize: '11px' }} />
                Add
              </button>
            </div>
            {config.authorizedWallets.length > 0 && (
              <div className="mt-3" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
                {config.authorizedWallets.map(w => (
                  <div
                    key={w}
                    className="flex items-center justify-between py-2.5"
                    style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
                  >
                    <span className="nave-mono truncate" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>
                      {w}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeWallet(w)}
                      className="hover:underline underline-offset-4 flex-shrink-0 ml-2"
                      style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Field>

          {/* Optional links */}
          <div className="space-y-3 pt-2" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <p style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--foreground))', paddingTop: '8px', margin: 0 }}>
              Social links <span style={{ fontWeight: 400, color: 'hsl(var(--faint))' }}>(optional)</span>
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
                    className="w-full pl-8 pr-3 py-2 rounded-[10px] border outline-none transition-colors"
                    style={{
                      fontSize: '13px',
                      backgroundColor: '#ffffff',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
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
          className="space-y-5 pt-4"
          style={{ borderTop: '1px solid hsl(var(--surface-2))', marginBottom: '26px' }}
        >
          <Field
            label="Governance Token"
            hint={
              config.chain === 'solana'
                ? 'Use an existing SPL token or mint a new one for this treasury.'
                : 'Use an existing ERC-20 token contract or deploy a new DAO token for this treasury.'
            }
          >
            <div className="flex gap-2 mt-1">
              {(['existing', 'new'] as TokenMode[]).map(mode => {
                const sel = config.tokenMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setConfig({ tokenMode: mode })}
                    className="px-3.5 py-2 rounded-full border text-center transition-all"
                    style={{
                      fontSize: '13px',
                      fontWeight: sel ? 600 : 400,
                      backgroundColor: sel ? 'hsl(var(--foreground))' : '#ffffff',
                      borderColor: sel ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                      color: sel ? '#ffffff' : 'hsl(var(--foreground))',
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
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
                Tokens will be minted directly into the treasury's on-chain wallet. All distributions require an authorized signer — no tokens will reach your personal wallet at creation.
              </p>
            </div>
          )}

          {/* Optional social links for token governance too */}
          <div className="space-y-3 pt-2" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <p style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--foreground))', paddingTop: '8px', margin: 0 }}>
              Social links <span style={{ fontWeight: 400, color: 'hsl(var(--faint))' }}>(optional)</span>
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
                    className="w-full pl-8 pr-3 py-2 rounded-[10px] border outline-none transition-colors"
                    style={{
                      fontSize: '13px',
                      backgroundColor: '#ffffff',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
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
