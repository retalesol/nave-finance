import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import Fi from '../components/Fi';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import NaveModal from '../components/NaveModal';
import { Notice } from '../components/calm';
import ConstitutionStep, {
  type PolicyState,
  DEFAULT_POLICY,
  PROTOCOLS_EVM,
  PROTOCOLS_SOLANA,
  RISK_PRESETS,
  formatConstitutionBps,
  isBridgeAdapterKey,
  secsToRebalanceFreq,
  tierBoundedCaps,
} from '../components/ConstitutionStep';
import { useDaoContext } from '../hooks/useDaoContext';
import { useConstitution } from '../hooks/useConstitution';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useGuardianConfig } from '../hooks/useGuardianConfig';
import { useTreasuryBalance } from '../hooks/useTreasuryBalance';
import { useChain } from '../hooks/useChain';
import {
  getAdapterProgramId,
  getConfiguredEvmAdapters,
  MARGINFI_STRATEGY_ENABLED,
  SELECTABLE_SOLANA_PROTOCOLS,
  type EvmAdapterProtocolId,
  SYSTEM_CONFIDENCE_THRESHOLD,
} from '../lib/programConfig';
import { isMockDaoAddress } from '../lib/mockData';
import {
  encodeConstitutionPayload,
  type ConstitutionPayloadProtocol,
} from '../lib/constitutionPayload';

/* ── Page ───────────────────────────────────────────────── */
export default function PolicyEngine() {
  const navigate = useNavigate();
  const location = useLocation();
  const { daoAddress } = useDaoContext();
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const { constitution, onChainData: constitutionOnChain, loading: constitutionLoading } = useConstitution(daoAddress);
  const { dao } = useDaoRegistry(daoAddress);
  const guardian = useGuardianConfig(daoAddress);
  const treasuryBalance = useTreasuryBalance(daoAddress);
  const { chainKind, evmChainId } = useChain();
  const isMock = isMockDaoAddress(daoAddress);

  // Membership: only treasury members may propose a constitution change. The
  // proposal tx is signed by this wallet, which is the on-chain membership proof.
  const walletStr = chainKind === 'evm' ? (evmAddress ?? null) : (publicKey?.toBase58() ?? null);
  const isFounder =
    !!walletStr &&
    (dao?.creatorWallet === walletStr || dao?.onChainData?.founder === walletStr);
  const isGuardian = !!walletStr && (guardian.onChainData?.wallets?.includes(walletStr) ?? false);
  const isTokenGov = dao?.governanceType === 'token';
  const isMember = isMock || isFounder || isGuardian || isTokenGov;
  const [policy, setPolicyState] = useState<PolicyState>(DEFAULT_POLICY);
  const [txError, setTxError] = useState<string | null>(null);
  const [amending, setAmending] = useState(() =>
    Boolean((location.state as { startAmend?: boolean } | null)?.startAmend),
  );

  useEffect(() => {
    if ((location.state as { startAmend?: boolean } | null)?.startAmend) {
      setAmending(true);
    }
  }, [location.state]);

  // Seed local policy state from on-chain constitution when it loads
  useEffect(() => {
    if (!constitution) return;
    const bpsToPercent = (bps: number) => Math.round(bps / 100);
    const defaultSolanaProtocols: Record<string, boolean> = {
      kamino:   true,
      marginfi: MARGINFI_STRATEGY_ENABLED,
      jito:     true,
      jupiter:  false,
    };
    const protocolMap: Record<string, boolean> = chainKind === 'evm'
      ? Object.fromEntries(PROTOCOLS_EVM.map((p) => [p.key, false]))
      : { ...defaultSolanaProtocols };
    for (const p of constitution.approvedProtocols) {
      if (p.protocolId in protocolMap) protocolMap[p.protocolId] = true;
    }
    const rebalanceSec = constitution.rebalanceFrequencySeconds;
    const rebalanceLabel = rebalanceSec <= 0
      ? 'Manual'
      : rebalanceSec <= 3600 ? 'Hourly'
      : rebalanceSec <= 86400 ? 'Daily'
      : rebalanceSec <= 604800 ? 'Weekly'
      : rebalanceSec <= 1209600 ? 'Bi-weekly'
      : 'Monthly';

    setPolicyState(prev => ({
      ...prev,
      riskPreset: (constitution.riskPreset as PolicyState['riskPreset']) || prev.riskPreset,
      minStablecoin: bpsToPercent(constitution.minReservesBps),
      maxDeployment: bpsToPercent(constitution.maxTotalDeployedBps),
      maxLending: bpsToPercent(constitution.maxSingleAllocationBps),
      liquidityReserve: bpsToPercent(constitution.minLiquidityBps ?? constitution.minReservesBps),
      rebalanceFreq: rebalanceLabel,
      approvedProtocols: protocolMap,
      confidenceThreshold:
        constitution.confidenceThreshold != null && constitution.confidenceThreshold > 0
          ? constitution.confidenceThreshold
          : constitutionOnChain?.confidenceThreshold != null && constitutionOnChain.confidenceThreshold > 0
            ? constitutionOnChain.confidenceThreshold
          : prev.confidenceThreshold,
      agentThresholdUsd:
        constitution.agentThresholdUsdMicro != null && constitution.agentThresholdUsdMicro > 0
          ? Math.round(constitution.agentThresholdUsdMicro / 1_000_000)
          : prev.agentThresholdUsd ?? 100,
    }));
  }, [constitution, constitutionOnChain, chainKind]);

  function setPolicy(partial: Partial<PolicyState>) {
    setPolicyState(prev => ({ ...prev, ...partial }));
  }

  function handleReset() {
    setPolicyState(DEFAULT_POLICY);
  }

  function handleProposeChange() {
    setTxError(null);

    if (!isMock) {
      if (!walletStr) {
        setTxError(chainKind === 'evm' ? 'Connect your Ethereum/Base wallet to propose a constitution change.' : 'Connect your wallet to propose a constitution change.');
        return;
      }
      if (!isMember) {
        setTxError(
          'Only treasury members can propose changes. Connect the founder or a guardian wallet.',
        );
        return;
      }
      if (treasuryBalance.resolved && !treasuryBalance.hasBalance) {
        setTxError(
          'Fund the treasury before proposing a constitution — agents cannot operate on an empty DAO.',
        );
        return;
      }
    }

    const isFirstConstitution = !constitution;
    const policyChangeCount =
      (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);
    const title = isFirstConstitution
      ? 'Policy Change - Constitution Ratification'
      : `Policy Change - Updating Constitution #${policyChangeCount}`;

    const capFor = tierBoundedCaps(chainKind === 'evm' ? 'evm' : 'solana', evmChainId, policy);
    let protocols: ConstitutionPayloadProtocol[];
    if (chainKind === 'evm') {
      if (!evmChainId) {
        setTxError('Select an Ethereum or Base network before proposing an EVM constitution.');
        return;
      }
      const configuredAdapters = getConfiguredEvmAdapters(evmChainId);
      const configuredById = new Map(configuredAdapters.map((adapter) => [adapter.protocolId, adapter]));
      const unsupportedApproved = PROTOCOLS_EVM
        .filter((p) => !!policy.approvedProtocols[p.key] && !configuredById.has(p.key as EvmAdapterProtocolId));
      if (unsupportedApproved.length > 0) {
        setTxError(
          `Adapter addresses are not configured for: ${unsupportedApproved.map((p) => p.label).join(', ')}. Disable them or configure supported adapters for this chain.`,
        );
        return;
      }
      protocols = configuredAdapters.map((adapter) => ({
        id: adapter.protocolId,
        approved: !!policy.approvedProtocols[adapter.protocolId],
        maxAllocationBps: capFor(adapter.protocolId),
        adapter: adapter.address,
      }));
    } else {
      protocols = [
        ...SELECTABLE_SOLANA_PROTOCOLS
          .map((id): ConstitutionPayloadProtocol | null => {
            if (!getAdapterProgramId(id)) return null;
            return { id, approved: !!policy.approvedProtocols[id], maxAllocationBps: capFor(id) };
          })
          .filter((p): p is ConstitutionPayloadProtocol => p !== null),
        { id: 'jupiter', approved: !!policy.approvedProtocols['jupiter'], maxAllocationBps: capFor('jupiter') },
      ];
    }
    const confidenceThreshold = SYSTEM_CONFIDENCE_THRESHOLD;

    const description = isFirstConstitution
      ? 'Constitution ratification. Full policy is encoded in the proposal payload.'
      : 'Constitution update. Full policy is encoded in the proposal payload.';

    let payload: number[];
    try {
      if (daoAddress && policy.agentThresholdUsd != null && policy.agentThresholdUsd > 0) {
        try {
          localStorage.setItem(
            `nave_agent_threshold_micro::${daoAddress.toLowerCase()}`,
            String(Math.round(policy.agentThresholdUsd * 1_000_000)),
          );
        } catch { /* ignore storage errors */ }
      }
      payload = encodeConstitutionPayload({
        v: 1,
        protocols,
        confidenceThreshold,
        riskPreset: policy.riskPreset,
        minStablecoin: policy.minStablecoin,
        maxDeployment: policy.maxDeployment,
        maxLending: policy.maxLending,
        liquidityReserve: policy.liquidityReserve,
        rebalanceFreq: policy.rebalanceFreq,
      } as Parameters<typeof encodeConstitutionPayload>[0]);
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Failed to encode the constitution payload.');
      return;
    }

    navigate('/decisions', {
      state: { proposePolicy: { title, description, payload } },
    });
  }

  // ─── Loading skeleton ─────────────────────────────────────────────
  if (constitutionLoading && !constitution) {
    return <PageSkeleton variant="settings" />;
  }

  // ─── No DAO selected ───────────────────────────────────────────
  if (!daoAddress) {
    return (
      <div className="p-6 animate-fade-in">
        <NaveEmptyState
          icon="shield-halved"
          title="No Treasury Selected"
          description="Select a treasury to configure its constitutional policy engine."
          action={{ label: 'Go to Lobby', icon: 'arrow-right', onClick: () => navigate('/treasuries') }}
        />
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-8 py-7 sm:py-10 animate-fade-in" data-onboarding-id="policy-root">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="nave-label" style={{ marginBottom: '10px' }}>Rules</div>
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
            The rules your agents <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>must obey.</em>
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))', fontSize: '14.5px', margin: 0, maxWidth: '520px' }}>
            Set by the community, checked on every move, changeable only by a vote.
          </p>
        </div>

        <div className="flex items-center gap-2 pt-1">
          {!amending ? (
            <button
              type="button"
              onClick={() => setAmending(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] border font-semibold transition-colors"
              style={{
                fontSize: '13px',
                borderColor: 'hsl(var(--border))',
                backgroundColor: '#ffffff',
                color: 'hsl(var(--foreground))',
              }}
            >
              Suggest a change
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setAmending(false)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[9px] transition-colors"
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'hsl(var(--muted-foreground))',
              }}
            >
              <Fi icon="arrow-left" style={{ fontSize: '11px' }} />
              Back to readout
            </button>
          )}
        </div>
      </div>

      {!amending ? (
        <ConstitutionReadout
          constitution={constitution}
          chainKind={chainKind === 'evm' ? 'evm' : 'solana'}
          onAmend={() => setAmending(true)}
        />
      ) : (
        <div className="max-w-[620px]" style={{ marginTop: '24px' }}>
          <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, marginBottom: '8px' }}>
            Amendments are a governance proposal. The treasury keeps the on-chain rules until that proposal passes and is ratified.
          </p>

          <ConstitutionStep
            policy={policy}
            setPolicy={setPolicy}
            chain={chainKind === 'evm' ? 'evm' : 'solana'}
            evmChainId={evmChainId ?? undefined}
            showAgentThreshold
          />

          {/* Empty-treasury guard */}
          {!isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance && (
            <div className="mb-4">
              <Notice tone="brass">
                The treasury holds no funds yet. Deposit assets before proposing a constitution — the agents cannot be activated on an empty DAO.
              </Notice>
            </div>
          )}

          {/* Tx error */}
          {txError && (
            <div className="mb-4">
              <Notice tone="red" actionLabel="Dismiss" onAction={() => setTxError(null)}>
                {txError}
              </Notice>
            </div>
          )}

          {/* Action buttons */}
          <div
            className="flex flex-wrap items-center justify-between gap-3 pt-5 border-t"
            style={{ borderColor: 'hsl(var(--surface-2))' }}
          >
            <button
              type="button"
              onClick={handleReset}
              className="hover:underline underline-offset-4 transition-colors"
              style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
            >
              Reset to defaults
            </button>

            <button
              type="button"
              onClick={handleProposeChange}
              disabled={!isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[9px] font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: '#111827',
                color: '#ffffff',
                opacity: !isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance ? 0.45 : 1,
                cursor: !isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance ? 'not-allowed' : 'pointer',
              }}
            >
              Propose Change
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function venueName(protocolId: string, chainKind: 'solana' | 'evm'): string {
  const list = chainKind === 'evm' ? PROTOCOLS_EVM : PROTOCOLS_SOLANA;
  return list.find((protocol) => protocol.key === protocolId)?.label ?? protocolId;
}

function ConstitutionReadout({
  constitution,
  chainKind,
  onAmend,
}: {
  constitution: ReturnType<typeof useConstitution>['constitution'];
  chainKind: 'solana' | 'evm';
  onAmend: () => void;
}) {
  const [selectedRuleNo, setSelectedRuleNo] = useState<string | null>(null);
  const venues = (constitution?.approvedProtocols ?? []).filter(
    (protocol) => protocol.approved && !isBridgeAdapterKey(protocol.protocolId),
  );
  const reserveBps = constitution?.minLiquidityBps ?? constitution?.minReservesBps ?? 0;
  const thresholdUsd =
    constitution?.agentThresholdUsdMicro != null && constitution.agentThresholdUsdMicro > 0
      ? Math.round(constitution.agentThresholdUsdMicro / 1_000_000)
      : 1000;
  const rebalanceLabel = constitution
    ? secsToRebalanceFreq(constitution.rebalanceFrequencySeconds)
    : 'Weekly';
  const presetLabel =
    RISK_PRESETS.find((r) => r.id === constitution?.riskPreset)?.label ??
    (constitution?.riskPreset
      ? constitution.riskPreset.charAt(0).toUpperCase() + constitution.riskPreset.slice(1)
      : 'Balanced');

  const rules = constitution
    ? [
        {
          no: '01',
          title: `Keep at least ${formatConstitutionBps(reserveBps)} in safe, stable funds`,
          sub: 'So bills and surprises are always covered.',
          detail: 'So bills and surprises are always covered, even if markets fall. Agents pause new investments automatically if this is threatened.',
          status: 'Followed ✓',
        },
        {
          no: '02',
          title: `Put at most ${formatConstitutionBps(constitution.maxTotalDeployedBps)} to work earning`,
          sub: 'The rest always stays within reach.',
          detail: 'The rest always stays within reach, so the treasury never has to sell at a bad moment to pay for something.',
          status: 'Followed ✓',
        },
        {
          no: '03',
          title: `Never more than ${formatConstitutionBps(constitution.maxSingleAllocationBps)} in any single place`,
          sub: 'So no single venue can hurt you too much.',
          detail: 'Spreads risk so no single venue, hack, or freeze can hurt the treasury too much.',
          status: 'Followed ✓',
        },
        {
          no: '04',
          title:
            venues.length > 0
              ? `Approved places only: ${venues.map((v) => venueName(v.protocolId, chainKind)).join(', ')}`
              : 'No external earning places approved yet',
          sub: 'Adding a new one always takes a vote.',
          detail: 'Agents physically cannot send money anywhere else. Adding a place requires a vote and a founder activation.',
          status: venues.length > 0 ? 'Followed ✓' : 'Idle only',
        },
        {
          no: '05',
          title: `Rebalance ${rebalanceLabel.toLowerCase()}, only above $${thresholdUsd.toLocaleString()}`,
          sub: 'Avoids fiddling with small balances.',
          detail: 'Prevents fiddling with tiny balances and burning fees on noise.',
          status: 'Followed ✓',
        },
        {
          no: '06',
          title: 'Any founder or guardian can freeze everything, instantly',
          sub: 'Restarting requires a vote. No exceptions.',
          detail: 'Any founder or guardian can halt everything in one action. Restarting needs the community — no back doors.',
          status: 'Ready ✓',
        },
      ]
    : null;

  const selectedRule = rules?.find((r) => r.no === selectedRuleNo) ?? null;

  return (
    <div className="max-w-[620px]" style={{ marginTop: '34px' }}>
      {rules ? (
        <div
          style={{
            borderTop: '1px solid hsl(var(--surface-2))',
          }}
        >
          {rules.map((r) => (
            <button
              key={r.no}
              type="button"
              onClick={() => setSelectedRuleNo(r.no)}
              className="flex items-start gap-3.5 w-full text-left cursor-pointer group transition-colors"
              style={{
                padding: '15px 0',
                borderBottom: '1px solid hsl(var(--surface-2))',
              }}
            >
              <span
                className="nave-mono"
                style={{ fontSize: '11px', color: 'hsl(var(--faint))', paddingTop: '3px' }}
              >
                {r.no}
              </span>
              <div className="flex-1 min-w-0">
                <h3
                  className="group-hover:text-brass transition-colors"
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: '14px',
                    fontWeight: 500,
                    margin: 0,
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  {r.title}
                </h3>
                <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', margin: '3px 0 0' }}>
                  {r.sub}
                </p>
              </div>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: '12px',
                  color: '#2F7D4F',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  paddingTop: '2px',
                }}
              >
                {r.status}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div
          style={{
            padding: '20px 0',
            borderTop: '1px solid hsl(var(--surface-2))',
            borderBottom: '1px solid hsl(var(--surface-2))',
          }}
        >
          <p style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
            This treasury has no constitution on chain yet.
          </p>
        </div>
      )}

      {selectedRule && (
        <NaveModal
          open={true}
          onClose={() => setSelectedRuleNo(null)}
          title={`Rule ${selectedRule.no} — ${selectedRule.title}`}
          subtitle={selectedRule.status}
          maxWidth={480}
        >
          <div style={{ padding: '18px 22px 22px' }}>
            <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.7, margin: '0 0 14px' }}>
              {selectedRule.detail}
            </p>
            <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
              <div className="flex justify-between py-2.5" style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: '13px' }}>
                <span style={{ color: 'hsl(var(--muted-foreground))' }}>Posture</span>
                <b style={{ fontWeight: 500, color: 'hsl(var(--foreground))' }}>{presetLabel}</b>
              </div>
              <div className="flex justify-between py-2.5" style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: '13px' }}>
                <span style={{ color: 'hsl(var(--muted-foreground))' }}>Enforced by</span>
                <b style={{ fontWeight: 500, color: 'hsl(var(--foreground))' }}>The Guardrail, on every move</b>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-4 mt-2">
              <button
                type="button"
                onClick={() => setSelectedRuleNo(null)}
                className="px-3.5 py-2 rounded-[9px] border font-semibold"
                style={{ fontSize: '13px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedRuleNo(null);
                  onAmend();
                }}
                className="px-4 py-2 rounded-[9px] font-semibold"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
              >
                Suggest a change
              </button>
            </div>
          </div>
        </NaveModal>
      )}

      <p
        style={{
          marginTop: '36px',
          fontSize: '12.5px',
          color: 'hsl(var(--faint))',
          lineHeight: 1.6,
        }}
      >
        If a move would break a rule, the Guardrail refuses to sign and the move is cancelled before any money moves. &nbsp;·&nbsp; Posture:{' '}
        <b style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>{presetLabel}</b>
      </p>
    </div>
  );
}
