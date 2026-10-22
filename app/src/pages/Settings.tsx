import { useMemo } from 'react';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import { Notice } from '../components/calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { useGuardianConfig, type GuardianInfo } from '../hooks/useGuardianConfig';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useTokenRegistry } from '../hooks/useTokenRegistry';
import { chainKindFromAddress } from '../lib/chain/types';
import { isMockDaoAddress } from '../lib/mockData';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
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
      className="flex-1 overflow-y-auto"
      data-onboarding-id="settings-root"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      <div className="max-w-[860px] mx-auto px-4 sm:px-8 pt-10 pb-20">
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

        <Tabs defaultValue="team" className="mt-7">
          <TabsList>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="dao">DAO</TabsTrigger>
          </TabsList>

          <TabsContent value="team" className="mt-6">
            <div className="max-w-[620px]">
              <MultisigSection
                initialSigners={liveSigners}
                initialThreshold={liveThreshold}
                daoAddress={daoAddress}
                guardiansBootstrapped={guardianConfig.bootstrapped}
                first
              />
              {chainKindFromAddress(daoAddress) === 'evm' && (
                <>
                  <GuardianRecoverySection daoAddress={daoAddress} frozen={dao?.frozen ?? false} />
                  <LinkedTreasurySection daoAddress={daoAddress} />
                </>
              )}
              <VotingSystemSection
                daoAddress={daoAddress}
                governanceType={governanceType}
                guardians={guardianConfig.guardians}
                threshold={liveThreshold}
                votingMint={votingMint}
              />
              <AgentAdminSection daoAddress={daoAddress} frozen={dao?.frozen ?? false} />
            </div>
          </TabsContent>

          <TabsContent value="security" className="mt-6">
            <div className="max-w-[620px]">
              <ConstitutionRulesLink first />
              <EmergencyControls daoAddress={daoAddress} initialFrozen={dao?.frozen ?? false} />
              <ReviewWindowSection daoAddress={daoAddress} />
              <PrivacyAccessSection
                daoAddress={daoAddress}
                governanceType={governanceType}
                privacyEnabled={dao?.privacyEnabled ?? false}
                onRefetch={refetchDao}
              />
              {daoAddress && chainKindFromAddress(daoAddress) === 'evm' && (
                <EvmStrategyWithdrawSection
                  daoAddress={daoAddress}
                  proposalCount={(dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0)}
                />
              )}
            </div>
          </TabsContent>

          <TabsContent value="activity" className="mt-6">
            <div className="max-w-[620px]">
              <AuditLog daoAddress={daoAddress} first />
            </div>
          </TabsContent>

          <TabsContent value="dao" className="mt-6">
            <div className="max-w-[620px]">
              <MoonlightSection daoAddress={daoAddress} first />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
