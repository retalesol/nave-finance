import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import Fi from '../components/Fi';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import { Notice } from '../components/calm';
import ConstitutionStep, {
  type PolicyState,
  DEFAULT_POLICY,
  PROTOCOLS_EVM,
  PROTOCOLS_SOLANA,
  RISK_PRESETS,
  formatConstitutionBps,
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
  const [amending, setAmending] = useState(false);

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
          />

          {/* Agent deployment threshold field */}
          <div
            style={{
              padding: '24px 0',
              borderTop: '1px solid hsl(var(--surface-2))',
            }}
          >
            <label
              style={{
                display: 'block',
                fontSize: '13px',
                fontWeight: 600,
                marginBottom: '8px',
                color: 'hsl(var(--foreground))',
              }}
            >
              Agent Deployment Threshold (USD)
            </label>
            <input
              type="number"
              min={1}
              step={1}
              value={policy.agentThresholdUsd ?? 100}
              onChange={(e) => {
                const val = Math.max(1, Number(e.target.value) || 1);
                setPolicy({ agentThresholdUsd: val });
              }}
              className="w-full max-w-xs px-3.5 py-2.5 rounded-[10px] border outline-none nave-mono"
              style={{
                fontSize: '14px',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            />
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--faint))', marginTop: '7px' }}>
              Minimum treasury NAV required before autonomous agents deploy capital.
            </p>
          </div>

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
  const venues = (constitution?.approvedProtocols ?? []).filter((protocol) => protocol.approved);
  const reserveBps = constitution?.minLiquidityBps ?? constitution?.minReservesBps ?? 0;
  const thresholdUsd =
    constitution?.agentThresholdUsdMicro != null && constitution.agentThresholdUsdMicro > 0
      ? Math.round(constitution.agentThresholdUsdMicro / 1_000_000)
      : 100;
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
          status: 'Followed ✓',
        },
        {
          no: '02',
          title: `Put at most ${formatConstitutionBps(constitution.maxTotalDeployedBps)} to work earning`,
          sub: 'The rest always stays within reach.',
          status: 'Followed ✓',
        },
        {
          no: '03',
          title: `Never more than ${formatConstitutionBps(constitution.maxSingleAllocationBps)} in any single place`,
          sub: 'So no single venue can hurt you too much.',
          status: 'Followed ✓',
        },
        {
          no: '04',
          title:
            venues.length > 0
              ? `Approved places only: ${venues.map((v) => venueName(v.protocolId, chainKind)).join(', ')}`
              : 'No external earning places approved yet',
          sub: 'Adding a new one always takes a vote.',
          status: venues.length > 0 ? 'Followed ✓' : 'Idle only',
        },
        {
          no: '05',
          title: `Rebalance ${rebalanceLabel.toLowerCase()}, only above $${thresholdUsd.toLocaleString()}`,
          sub: 'Avoids fiddling with small balances.',
          status: 'Followed ✓',
        },
        {
          no: '06',
          title: 'Any founder or guardian can freeze everything, instantly',
          sub: 'Restarting requires a vote. No exceptions.',
          status: 'Ready ✓',
        },
      ]
    : null;

  return (
    <div className="max-w-[620px]" style={{ marginTop: '34px' }}>
      {rules ? (
        <div
          style={{
            borderTop: '1px solid hsl(var(--surface-2))',
          }}
        >
          {rules.map((r) => (
            <div
              key={r.no}
              className="flex items-start gap-3.5"
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
            </div>
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

      {/* Approved venues chips */}
      <div style={{ marginTop: '22px' }}>
        <div className="nave-label" style={{ marginBottom: '8px' }}>Approved venues</div>
        {venues.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {venues.map((venue) => (
              <span
                key={venue.protocolId}
                className="inline-flex items-center gap-1.5 rounded-full border bg-white"
                style={{
                  fontSize: '12.5px',
                  padding: '5px 12px',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              >
                <span>{venueName(venue.protocolId, chainKind)}</span>
                {venue.maxAllocationBps > 0 && (
                  <span className="nave-mono" style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
                    {formatConstitutionBps(venue.maxAllocationBps)}
                  </span>
                )}
              </span>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
            No venues are approved.
          </p>
        )}
      </div>

      <div style={{ marginTop: '24px' }}>
        <button
          type="button"
          onClick={onAmend}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] border font-semibold transition-colors"
          style={{
            fontSize: '13px',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
            backgroundColor: '#ffffff',
          }}
        >
          <Fi icon="sliders" style={{ fontSize: '11px' }} />
          Amend constitution
        </button>
      </div>

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
