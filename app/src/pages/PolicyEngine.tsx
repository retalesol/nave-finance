import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import Fi from '../components/Fi';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import ConstitutionStep, {
  type PolicyState,
  DEFAULT_POLICY,
  PROTOCOLS_EVM,
  PROTOCOLS_SOLANA,
  formatConstitutionBps,
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
  getEvmAdapterStatuses,
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

// PolicyState type is imported from ConstitutionStep (shared with wizard)

/* ── Constants ──────────────────────────────────────────── */
// DEFAULT_POLICY and PolicyState imported from ConstitutionStep



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
  const evmAdapterStatuses = useMemo(
    () => (evmChainId ? getEvmAdapterStatuses(evmChainId) : []),
    [evmChainId],
  );
  const evmStatusByProtocol = useMemo(
    () => new Map(evmAdapterStatuses.map((status) => [status.protocolId, status])),
    [evmAdapterStatuses],
  );
  const protocolOptions = chainKind === 'evm' ? PROTOCOLS_EVM : PROTOCOLS_SOLANA;

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
  }, [constitution, constitutionOnChain, chainKind, evmAdapterStatuses]);

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

    // Title is auto-generated and not editable by the user.
    // First-ever constitution: "Policy Change - Constitution Ratification" (unique).
    // Subsequent updates are numbered from 1.
    const isFirstConstitution = !constitution;
    const policyChangeCount =
      (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);
    const title = isFirstConstitution
      ? 'Policy Change - Constitution Ratification'
      : `Policy Change - Updating Constitution #${policyChangeCount}`;

    // All supported protocols for the active chain go into the governance
    // proposal payload. EVM adapter addresses are not configured in this app
    // yet, so EVM ratification will require those addresses before submitting.
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

    // Keep description SHORT — the on-chain payload already holds the full policy.
    // Long descriptions bloat the create_proposal instruction past the 1232-byte
    // transaction limit when combined with the JSON payload bytes.
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

    // Hand off to Governance, which opens the create-proposal flow prefilled with
    // this policy. The wallet signs the create_proposal transaction there.
    navigate('/governance', {
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
    <div className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 sm:space-y-6 animate-fade-in" data-onboarding-id="policy-root">
      {/* Header */}
      <div>
        <h1 className="text-display" style={{ fontSize: '24px', letterSpacing: '-0.01em' }}>
          Treasury Constitution
        </h1>
        <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px' }}>
          Define the constitutional parameters all four autonomous agents must operate within
        </p>
      </div>

      {!amending ? (
        <ConstitutionReadout
          constitution={constitution}
          chainKind={chainKind === 'evm' ? 'evm' : 'solana'}
          onAmend={() => setAmending(true)}
        />
      ) : (
      <>
      <div className="flex items-center justify-between gap-3">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
          Amendments are a governance proposal. The treasury keeps the on-chain rules until that proposal passes.
        </p>
        <button
          type="button"
          onClick={() => setAmending(false)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border flex-shrink-0"
          style={{ fontSize: '12.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
        >
          <Fi icon="arrow-left" style={{ fontSize: '11px' }} />
          Back
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6">
        {/* Left col — uses shared ConstitutionStep component */}
        <div className="lg:col-span-2 space-y-4">
          <ConstitutionStep
            policy={policy}
            setPolicy={setPolicy}
            chain={chainKind === 'evm' ? 'evm' : 'solana'}
            evmChainId={evmChainId ?? undefined}
          />
        </div>

        {/* Right col */}
        <div className="space-y-4">
          {/* Policy summary card */}
          <div className="nave-card p-5 space-y-4">
            <span className="text-display font-semibold" style={{ fontSize: '14px' }}>Constitution Summary</span>
            <div className="space-y-2">
              {[
                { label: 'Risk Profile', value: policy.riskPreset.charAt(0).toUpperCase() + policy.riskPreset.slice(1) },
                { label: 'Min Reserve', value: `${policy.minStablecoin}%` },
                { label: 'Max Deploy', value: `${policy.maxDeployment}%` },
                { label: 'Max Lending', value: `${policy.maxLending}%` },
                { label: 'Rebalancing', value: policy.rebalanceFreq },
                { label: 'Agent Threshold', value: `$${(policy.agentThresholdUsd ?? 100).toLocaleString()}` },
                { label: 'Protocols', value: protocolOptions.filter(p => policy.approvedProtocols[p.key] && (chainKind !== 'evm' || evmStatusByProtocol.get(p.key as EvmAdapterProtocolId)?.configured)).length + ' approved' },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between">
                  <span style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>{label}</span>
                  <span className="nave-mono" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>{value}</span>
                </div>
              ))}
            </div>
            <div className="pt-3 border-t space-y-1.5" style={{ borderColor: 'hsl(var(--border))' }}>
              <label className="nave-label" style={{ fontSize: '11px', display: 'block' }}>
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
                className="w-full px-3 py-2 rounded-lg border outline-none nave-mono"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--surface-0))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              />
              <p style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.45 }}>
                Minimum treasury NAV required before autonomous agents deploy capital.
              </p>
            </div>
          </div>

          {/* Governance note */}
          <div
            className="p-4 rounded-xl border"
            style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
          >
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
              Constitution changes are submitted as governance proposals signed by your wallet, require a
              passing vote, and are then ratified by the founder before the agents follow them.
            </p>
          </div>

          {/* Empty-treasury guard */}
          {!isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance && (
            <div
              className="flex items-start gap-2.5 p-3.5 rounded-xl border"
              style={{ backgroundColor: 'hsl(var(--warning-muted))', borderColor: 'hsl(38 92% 75%)' }}
            >
              <Fi icon="triangle-exclamation" style={{ fontSize: '13px', color: 'hsl(var(--warning))', flexShrink: 0, marginTop: '2px' }} />
              <p style={{ fontSize: '12.5px', color: 'hsl(38 50% 28%)', lineHeight: 1.55 }}>
                The treasury holds no funds yet. Deposit assets before proposing a constitution — the
                agents cannot be activated on an empty DAO.
              </p>
            </div>
          )}

          {/* Tx error */}
          {txError && (
            <div
              className="flex items-center gap-2 p-3 rounded-xl border animate-fade-in"
              style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
            >
              <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }} />
              <span style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))', flex: 1 }}>{txError}</span>
              <button onClick={() => setTxError(null)} style={{ fontSize: '11px', color: 'hsl(var(--destructive))', textDecoration: 'underline' }}>dismiss</button>
            </div>
          )}

          {/* Action buttons */}
          <div className="space-y-2 pt-1">
            {/* Primary: Propose Change */}
            <button
              onClick={handleProposeChange}
              disabled={!isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance}
              className="flex items-center justify-center gap-1.5 w-full px-3.5 py-2.5 rounded-lg border font-medium transition-colors"
              style={{
                fontSize: '13px',
                borderColor: 'hsl(var(--border-strong))',
                color: 'hsl(var(--foreground))',
                backgroundColor: 'hsl(var(--surface-0))',
                opacity: !isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance ? 0.5 : 1,
                cursor: !isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-0))')}
            >
              <Fi icon="lightbulb" style={{ fontSize: '12px' }} />
              Propose Change
            </button>

            {/* Tertiary: Reset (text link style) */}
            <button
              onClick={handleReset}
              className="flex items-center justify-center gap-1.5 w-full py-1.5 transition-colors"
              style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'hsl(var(--foreground))')}
              onMouseLeave={e => (e.currentTarget.style.color = 'hsl(var(--muted-foreground))')}
            >
              <Fi icon="rotate-left" style={{ fontSize: '11px' }} />
              Reset to defaults
            </button>
          </div>
        </div>
      </div>
      </>
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
  const sentences = constitution
    ? [
        constitution.minLiquidityBps != null
          ? `At least ${formatConstitutionBps(constitution.minLiquidityBps)} of the treasury stays liquid.`
          : `At least ${formatConstitutionBps(constitution.minReservesBps)} of the treasury stays liquid.`,
        `At most ${formatConstitutionBps(constitution.maxTotalDeployedBps)} of the treasury can be deployed.`,
        `No single venue can hold more than ${formatConstitutionBps(constitution.maxSingleAllocationBps)}.`,
        ...(constitution.agentThresholdUsdMicro != null && constitution.agentThresholdUsdMicro > 0
          ? [`Autonomous agents require at least $${(constitution.agentThresholdUsdMicro / 1_000_000).toLocaleString()} in treasury NAV.`]
          : []),
      ]
    : null;

  return (
    <div className="nave-card p-5 space-y-4">
      {sentences ? (
        <div className="space-y-2">
          {sentences.map((sentence) => (
            <p key={sentence} style={{ fontSize: '14px', color: 'hsl(var(--foreground))', lineHeight: 1.55 }}>
              {sentence}
            </p>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
          This treasury has no constitution on chain yet.
        </p>
      )}
      <div>
        <div className="nave-label" style={{ fontSize: '10px', marginBottom: '6px' }}>Approved venues</div>
        {venues.length > 0 ? (
          <ul className="space-y-1">
            {venues.map((venue) => (
              <li key={venue.protocolId} style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>
                {venueName(venue.protocolId, chainKind)}
                {venue.maxAllocationBps > 0 ? ` (${formatConstitutionBps(venue.maxAllocationBps)})` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>No venues are approved.</p>
        )}
      </div>
      <button
        type="button"
        onClick={onAmend}
        className="flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-lg border font-medium"
        style={{
          fontSize: '13px',
          borderColor: 'hsl(var(--border-strong))',
          color: 'hsl(var(--foreground))',
          backgroundColor: 'hsl(var(--surface-0))',
        }}
      >
        <Fi icon="sliders" style={{ fontSize: '12px' }} />
        Amend constitution
      </button>
    </div>
  );
}