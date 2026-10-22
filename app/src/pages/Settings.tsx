import { useMemo, useState, useEffect } from 'react';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import Toggle from '../components/Toggle';
import { Notice, Section } from '../components/calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { useGuardianConfig, type GuardianInfo } from '../hooks/useGuardianConfig';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useTokenRegistry } from '../hooks/useTokenRegistry';
import { toast } from '../hooks/use-toast';
import { chainKindFromAddress } from '../lib/chain/types';
import { isMockDaoAddress } from '../lib/mockData';
import { normalizeDaoSlug } from '../lib/daoSlug';
import MultisigSection, { type Signer, INITIAL_SIGNERS } from '../components/settings/MultisigSection';
import GuardianRecoverySection from '../components/settings/GuardianRecoverySection';
import LinkedTreasurySection, { ConstitutionRulesLink } from '../components/settings/LinkedTreasurySection';
import EmergencyControls, { ConfirmFreezeModal, resolveGuardianNonce } from '../components/settings/EmergencyControls';
import AgentAdminSection from '../components/settings/AgentAdminSection';
import PrivacyAccessSection from '../components/settings/PrivacyAccessSection';
import AuditLog from '../components/settings/AuditLog';
import VotingSystemSection from '../components/settings/VotingSystemSection';
import ReviewWindowSection from '../components/settings/ReviewWindowSection';
import MoonlightSection, { EvmMoonlightSection, EvmStrategyWithdrawSection } from '../components/settings/MoonlightSection';

export {
  MultisigSection,
  GuardianRecoverySection,
  LinkedTreasurySection,
  ConstitutionRulesLink,
  EmergencyControls,
  ConfirmFreezeModal,
  resolveGuardianNonce,
  AgentAdminSection,
  PrivacyAccessSection,
  AuditLog,
  VotingSystemSection,
  ReviewWindowSection,
  MoonlightSection,
  EvmMoonlightSection,
  EvmStrategyWithdrawSection,
};

function ProfileSection({
  daoAddress,
  initialName,
  initialSlug,
  initialDescription,
}: {
  daoAddress: string;
  initialName: string;
  initialSlug: string;
  initialDescription: string;
}) {
  const storageKey = `nave_profile_override::${daoAddress.toLowerCase()}`;
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [description, setDescription] = useState(initialDescription);
  const [saved, setSaved] = useState(false);
  const [copiedHome, setCopiedHome] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { name?: string; slug?: string; description?: string };
        setName(parsed.name ?? initialName);
        setSlug(parsed.slug ?? initialSlug);
        setDescription(parsed.description ?? initialDescription);
        return;
      }
    } catch {
      /* ignore storage errors */
    }
    setName(initialName);
    setSlug(initialSlug);
    setDescription(initialDescription);
  }, [storageKey, initialName, initialSlug, initialDescription]);

  const publicHome = `nave.finance/${slug || normalizeDaoSlug(name) || 'treasury'}`;

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ name: name.trim(), slug: normalizeDaoSlug(slug || name), description: description.trim() }),
      );
    } catch {
      /* ignore storage errors */
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
    toast({ title: 'Profile saved' });
  }

  function handleCopyHome() {
    navigator.clipboard.writeText(`https://${publicHome}`);
    setCopiedHome(true);
    window.setTimeout(() => setCopiedHome(false), 1600);
  }

  return (
    <Section first title="Profile">
      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Treasury name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Atlas Community Treasury"
            className="w-full px-3 py-2.5 rounded-[10px] border outline-none"
            style={{
              fontSize: '14px',
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          />
        </div>

        <div>
          <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Public home
          </label>
          <div
            className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-[10px] border"
            style={{ backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))' }}
          >
            <input
              type="text"
              value={publicHome}
              onChange={(e) => {
                const raw = e.target.value.replace(/^https?:\/\//i, '').replace(/^nave\.finance\//i, '');
                setSlug(normalizeDaoSlug(raw));
              }}
              className="flex-1 min-w-0 outline-none nave-mono bg-transparent"
              style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}
            />
            <button
              type="button"
              onClick={handleCopyHome}
              className="hover:underline underline-offset-4 flex-shrink-0"
              style={{ fontSize: '12.5px', color: copiedHome ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
            >
              {copiedHome ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
        </div>

        <div>
          <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What is this treasury for?"
            className="w-full px-3 py-2.5 rounded-[10px] border outline-none resize-none"
            style={{
              fontSize: '14px',
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
            }}
          >
            Save profile
          </button>
          {saved && (
            <span style={{ fontSize: '13px', color: 'hsl(var(--success))', fontWeight: 500 }}>
              Saved ✓
            </span>
          )}
        </div>
      </form>
    </Section>
  );
}

function NotificationPreferencesRows({ daoAddress }: { daoAddress: string }) {
  const storageKey = `nave_notif_prefs::${daoAddress.toLowerCase()}`;
  const [prefs, setPrefs] = useState<{ vote: boolean; blocked: boolean; report: boolean }>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw);
    } catch {
      /* ignore */
    }
    return { vote: true, blocked: true, report: false };
  });

  function togglePref(key: 'vote' | 'blocked' | 'report') {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const rows: { key: 'vote' | 'blocked' | 'report'; title: string; sub: string }[] = [
    {
      key: 'vote',
      title: 'Decision needs my vote',
      sub: 'Email and in-app, when voting opens or is about to close.',
    },
    {
      key: 'blocked',
      title: 'Agent blocked a move',
      sub: 'Tell me whenever the Guardrail refuses to sign.',
    },
    {
      key: 'report',
      title: 'Monthly report ready',
      sub: 'One email when the statement is generated.',
    },
  ];

  return (
    <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
      {rows.map((r) => (
        <div
          key={r.key}
          className="flex items-start justify-between gap-4 py-3.5"
          style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
        >
          <div className="min-w-0 flex-1">
            <div style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>{r.title}</div>
            <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>{r.sub}</div>
          </div>
          <div className="pt-0.5 flex-shrink-0">
            <Toggle value={prefs[r.key]} onChange={() => togglePref(r.key)} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────── */
export default function Settings() {
  const { daoAddress } = useDaoContext();
  const guardianConfig = useGuardianConfig(daoAddress);
  const { dao, refetch: refetchDao } = useDaoRegistry(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const isMock = isMockDaoAddress(daoAddress);
  const governanceType = dao?.governanceType === 'token' ? 'token' : 'wallet';
  const votingMint = tokenRegistry.tokens[0]?.mint ?? null;

  // Live guardian data; only fall back to mock signers in demo mode.
  const liveSigners: Signer[] = useMemo(() => {
    if (guardianConfig.guardians.length > 0) {
      return guardianConfig.guardians.map((g: GuardianInfo, i: number) => ({
        id: `live-${i}`,
        // Store the FULL on-chain pubkey. Truncating here previously made
        // saveGuardianConfig fail to parse the address, silently dropping every
        // guardian and overwriting the multisig with a 1-of-1 of the caller.
        address: g.wallet,
        label: g.label || (g.isOnChain ? 'On-chain Signer' : 'Pending Signer'),
        added: g.isOnChain ? 'on-chain' : 'setup',
      }));
    }
    return isMock ? INITIAL_SIGNERS : [];
  }, [guardianConfig.guardians, isMock]);

  const liveThreshold = guardianConfig.threshold > 0 ? guardianConfig.threshold : isMock ? 2 : 1;
  const signerCount = liveSigners.length;

  // ─── Loading skeleton ─────────────────────────────────────────────
  if (guardianConfig.loading && guardianConfig.guardians.length === 0) {
    return <PageSkeleton variant="settings" />;
  }

  // ─── No DAO selected ───────────────────────────────────────────
  if (!daoAddress) {
    return (
      <div className="p-6 animate-fade-in">
        <NaveEmptyState
          icon="gear"
          title="No Treasury Selected"
          description="Select a treasury to manage security settings, guardian configuration, and emergency controls."
        />
      </div>
    );
  }

  const frozen = dao?.frozen ?? false;
  const govLabel = governanceType === 'token'
    ? `Token-weighted${votingMint ? ' (1 voting token)' : ''}`
    : signerCount > 0
      ? `${liveThreshold}-of-${signerCount} multisig`
      : 'Authorized wallets';
  const statusText = frozen ? 'Treasury frozen' : 'All clear';

  return (
    <div
      className="animate-fade-in"
      data-onboarding-id="settings-root"
    >
      <div>
        {/* Header */}
        <div>
          <div className="nave-label" style={{ marginBottom: '10px' }}>Settings</div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 400,
              fontSize: '34px',
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              margin: '0 0 8px',
              color: 'hsl(var(--foreground))',
            }}
          >
            Treasury <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>settings.</em>
          </h1>
          <p
            style={{
              fontSize: '14.5px',
              color: 'hsl(var(--muted-foreground))',
              margin: 0,
              maxWidth: '520px',
            }}
          >
            Profile, people, and preferences. Structural changes — members, guardians, rules — always go through a decision.
          </p>
        </div>

        {/* One-line security status notice */}
        <Notice tone={frozen ? 'red' : 'green'} className="mt-6">
          <span style={{ fontWeight: 500 }}>
            Security status: {statusText}
          </span>
          <span style={{ color: 'hsl(var(--muted-foreground))', marginLeft: '8px', fontSize: '13px' }}>
            {govLabel} · {dao ? `${(dao.proposalCount ?? 0) + (dao.archivedProposalCount ?? 0)} proposals` : 'Loading…'}
          </span>
        </Notice>

        <div className="max-w-[620px] mt-8">
          {/* 1. Profile */}
          <ProfileSection
            daoAddress={daoAddress}
            initialName={dao?.name || 'Atlas Community Treasury'}
            initialSlug={dao?.slug || normalizeDaoSlug(dao?.name || 'atlas')}
            initialDescription={dao?.description || 'A community treasury funding open-source grants and local projects.'}
          />

          {/* 2. Members & guardians */}
          <MultisigSection
            initialSigners={liveSigners}
            initialThreshold={liveThreshold}
            daoAddress={daoAddress}
            guardiansBootstrapped={guardianConfig.bootstrapped}
          />

          {/* 3. Preferences & privacy */}
          <Section title="Notifications">
            <NotificationPreferencesRows daoAddress={daoAddress} />
          </Section>

          <PrivacyAccessSection
            daoAddress={daoAddress}
            governanceType={governanceType}
            privacyEnabled={dao?.privacyEnabled ?? false}
            onRefetch={refetchDao}
          />

          <ReviewWindowSection daoAddress={daoAddress} />

          {/* 4. Safety */}
          <EmergencyControls daoAddress={daoAddress} initialFrozen={dao?.frozen ?? false} />

          {/* Quiet Advanced disclosure at the very bottom */}
          <details
            style={{
              marginTop: '30px',
              borderTop: '1px solid hsl(var(--border))',
              paddingTop: '18px',
            }}
          >
            <summary
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: 'hsl(var(--muted-foreground))',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              Advanced (voting system, recovery &amp; wind-down)
            </summary>
            <div className="pt-4">
              <VotingSystemSection
                daoAddress={daoAddress}
                governanceType={governanceType}
                guardians={guardianConfig.guardians}
                threshold={liveThreshold}
                votingMint={votingMint}
              />
              {chainKindFromAddress(daoAddress) === 'evm' && (
                <>
                  <GuardianRecoverySection daoAddress={daoAddress} frozen={dao?.frozen ?? false} />
                  <LinkedTreasurySection daoAddress={daoAddress} />
                </>
              )}
              <MoonlightSection daoAddress={daoAddress} />
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
