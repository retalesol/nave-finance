import { useState, useEffect } from 'react';
import ChainSelector from '../ChainSelector';
import { EVM_DEPLOYMENT_MODE } from '../../lib/programConfig';
import { USER_CHAINS } from '../../lib/chain/types';
import {
  checkDaoSlugAvailability,
  formatDaoSlugLabel,
  normalizeDaoSlug,
  validateDaoSlug,
} from '../../lib/daoSlug';
import {
  type DAOConfig,
  type GovernanceType,
  type TokenMode,
  Field,
  TextInput,
  fitsOnchainName,
  MAX_ONCHAIN_NAME_BYTES,
} from './CreateDaoHelpers';

const PURPOSE_OPTIONS = [
  {
    id: 'Community',
    label: 'Community',
    desc: 'A group pooling funds for shared goals.',
  },
  {
    id: 'Creators & fans',
    label: 'Creators & fans',
    desc: 'Revenue and support, shared with a community.',
  },
  {
    id: 'Protocol or project',
    label: 'Protocol or project',
    desc: 'Reserves and operating funds.',
  },
  {
    id: 'Investment club',
    label: 'Investment club',
    desc: 'Investing together, under agreed rules.',
  },
] as const;

export default function Step1({
  config,
  setConfig,
  connectedWallet,
  onSlugReadyChange,
}: {
  config: DAOConfig;
  setConfig: (c: Partial<DAOConfig>) => void;
  connectedWallet: string | null;
  onSlugReadyChange: (ready: boolean, message: string | null) => void;
  quickMode?: boolean;
}) {
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
    if (id === 'wallets') {
      setConfig({
        governanceType: id,
        tokenMode: null,
        authorizedWallets: connectedWallet ? [connectedWallet] : config.authorizedWallets,
      });
    } else {
      setConfig({
        governanceType: id,
        tokenMode: config.tokenMode ?? 'existing',
      });
    }
  }

  const currentPurpose = config.treasuryPurpose || 'Creators & fans';

  return (
    <div>
      {/* Name + auto-derived public home */}
      <Field label="Name">
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
          maxLength={MAX_ONCHAIN_NAME_BYTES}
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
        {config.name.trim().length > 0 && !fitsOnchainName(config.name) && (
          <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', margin: '6px 0 0' }}>
            Name must be {MAX_ONCHAIN_NAME_BYTES} bytes or fewer.
          </p>
        )}

        {/* Compact inline URL preview + editable slug (keeps placeholder="nave" accessible) */}
        <div className="flex items-center gap-2 flex-wrap mt-2" style={{ fontSize: '12.5px' }}>
          <span style={{ color: 'hsl(var(--faint))' }}>Its home will be</span>
          <div
            className="inline-flex items-center rounded-[8px] border px-2 py-0.5"
            style={{ borderColor: 'hsl(var(--border))', backgroundColor: '#ffffff' }}
          >
            <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
              nave.finance/
            </span>
            <input
              type="text"
              value={config.slug}
              onChange={e => {
                setSlugManual(true);
                setConfig({ slug: normalizeDaoSlug(e.target.value) });
              }}
              placeholder="nave"
              aria-label="Treasury URL slug"
              className="outline-none nave-mono bg-transparent"
              style={{
                width: `${Math.max(6, (config.slug || 'nave').length + 2)}ch`,
                fontSize: '12px',
                color: 'hsl(var(--foreground))',
              }}
            />
          </div>
          {config.slug && validateDaoSlug(config.slug).valid && (
            <span style={{ color: slugChecking ? 'hsl(var(--faint))' : 'hsl(var(--success))', fontWeight: 500 }}>
              {slugChecking ? 'Checking…' : '✓ Available'}
            </span>
          )}
        </div>
      </Field>

      {/* What is it for? */}
      <Field label="What is it for?">
        <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
          {PURPOSE_OPTIONS.map(opt => {
            const sel = currentPurpose === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setConfig({ treasuryPurpose: opt.id, description: opt.desc })}
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
                    {opt.label}
                  </strong>
                  <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', margin: '2px 0 0', lineHeight: 1.5 }}>
                    {opt.desc}
                  </p>
                </span>
              </button>
            );
          })}
        </div>
      </Field>

      {/* Who decides? */}
      <Field label="Who decides?">
        <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
          {([
            {
              id: 'wallets' as GovernanceType,
              label: 'People vote',
              desc: 'Named members, one vote each. Simplest to start.',
              rec: 'Recommended',
            },
            {
              id: 'token' as GovernanceType,
              label: 'Token holders vote',
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

        {/* Token options */}
        {config.governanceType === 'token' && (
          <div className="space-y-4 pt-4">
            <div className="flex gap-2">
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
                    {mode === 'existing' ? 'Use existing token' : 'Create a token'}
                  </button>
                );
              })}
            </div>

            {config.tokenMode === 'existing' && (
              <div>
                <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                  Token contract address
                </label>
                <TextInput
                  value={config.existingTokenCA}
                  onChange={v => setConfig({ existingTokenCA: v })}
                  placeholder={config.chain === 'solana' ? 'Paste SPL token mint address…' : '0x… or mint address'}
                  mono
                />
              </div>
            )}

            {config.tokenMode === 'new' && (
              <div className="space-y-3">
                <div>
                  <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                    Token name / symbol
                  </label>
                  <TextInput
                    value={config.newTokenName}
                    onChange={v => setConfig({ newTokenName: v })}
                    placeholder="e.g. HBR"
                    mono
                    maxLength={MAX_ONCHAIN_NAME_BYTES}
                  />
                </div>
                <div>
                  <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                    Total supply
                  </label>
                  <TextInput
                    value={config.newTokenSupply}
                    onChange={v => setConfig({ newTokenSupply: v })}
                    placeholder="1000000"
                    mono
                    type="number"
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </Field>

      {/* Network */}
      <Field
        label="Network"
        hint={
          EVM_DEPLOYMENT_MODE === 'testnet'
            ? 'Testnet treasuries can launch on Solana, Ethereum, Base, Robinhood, or Arc. You invite members after launch.'
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
    </div>
  );
}
