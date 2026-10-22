import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { motion } from 'framer-motion';
import { getAccount } from '@solana/spl-token';
import { hexToBytes, parseUnits, type Address } from 'viem';
import Fi from '@/components/Fi';
import { scaleIn, fadeOverlay } from '@/components/PageTransition';
import { useSendTransaction } from '@/hooks/useSendTransaction';
import { useChain } from '@/hooks/useChain';
import { useTreasuryAssets } from '@/hooks/useTreasuryAssets';
import { isSelectableTreasuryMint } from '@/lib/treasuryAssetEligibility';
import { fetchDaoContracts } from '@/lib/evm/readers';
import { storeEvmProposalPayloadRemote } from '@/lib/evmProposalPayloadStore';
import { buildCreateProposalEvm, encodeEvmPermissionPayload, encodeEvmStrategyProposalPayload } from '@/lib/evm/writers';
import { buildCreateProposal } from '@/lib/transactionBuilders';
import { getNavePrograms } from '@/lib/naveProgram';
import { getTokenRegistryPDA } from '@/lib/pdaDerivation';
import { fetchTreasuryVault } from '@/lib/onChainFetcher';
import { decodeConstitutionPayload } from '@/lib/constitutionPayload';
import { isMockDaoAddress } from '@/lib/mockData';
import { isEvmAddress } from '@/lib/chain/types';
import {
  AGENT_ENABLE_PROPOSAL_TITLE,
  EVM_DEPLOYMENT_MODE,
  MARGINFI_STRATEGY_ENABLED,
  SOLANA_NETWORK,
  getAdapterProgramId,
  getConfiguredEvmAdapters,
} from '@/lib/programConfig';
import {
  actionDelayContextFrom,
  defaultReviewPeriodSeconds,
  proposalPeriodOptions,
  resolveSubmittedVotingPeriod,
  usesProductionActionDelay,
} from '@/lib/actionDelays';
import { ProposalType as OnChainProposalType } from '@/lib/onChainTypes';
import {
  TYPE_META,
  PROPOSAL_TEMPLATES,
  getProposalDescription,
  type ProposalType,
  type NewProposal,
} from './types';
import {
  persistEvmProposalPayload,
  persistSolanaStrategyPayload,
  decodeSolanaStrategyPayload,
} from './proposalStorage';

/** Decodes a constitution payload and renders the policy settings. */
function PolicySummaryFromPayload({ payloadBytes }: { payloadBytes: number[] }) {
  const decoded = useMemo(() => {
    try { return decodeConstitutionPayload(payloadBytes); } catch { return null; }
  }, [payloadBytes]);
  if (!decoded) return (
    <div>
      <div className="nave-label mb-2">Description</div>
      <div className="px-3 py-3 rounded-lg border" style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
        Constitution proposal — payload could not be decoded.
      </div>
    </div>
  );
  const approved = decoded.protocols.filter(p => p.approved).map(p => p.id.charAt(0).toUpperCase() + p.id.slice(1)).join(', ') || 'none';
  const rows = [
    { label: 'Risk preset',        value: decoded.riskPreset ? decoded.riskPreset.charAt(0).toUpperCase() + decoded.riskPreset.slice(1) : '—' },
    { label: 'Approved protocols', value: approved },
    { label: 'Min stablecoin',     value: decoded.minStablecoin != null ? `${decoded.minStablecoin}%` : '—' },
    { label: 'Max deployment',     value: decoded.maxDeployment != null ? `${decoded.maxDeployment}%` : '—' },
    { label: 'Max lending',        value: decoded.maxLending != null ? `${decoded.maxLending}%` : '—' },
    { label: 'Liquidity reserve',  value: decoded.liquidityReserve != null ? `${decoded.liquidityReserve}%` : '—' },
    { label: 'Rebalancing',        value: decoded.rebalanceFreq ?? '—' },
  ];
  return (
    <div>
      <div className="nave-label mb-2">Policy details</div>
      <div className="border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between py-2.5 border-b" style={{ borderColor: 'hsl(var(--surface-2))', fontSize: '13.5px' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>{r.label}</span>
            <span className="nave-mono" style={{ fontSize: '13px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
export default function CreateProposalModal({
  onClose,
  daoAddress,
  proposalCount,
  isTokenGov,
  votingMint,
  initial,
}: {
  onClose: () => void;
  daoAddress: string | null;
  proposalCount: number;
  isTokenGov: boolean;
  votingMint: string | null;
  /** Pre-filled from context (e.g. a constitution proposal from the Policy page).
   *  When provided the modal shows a read-only review; the user can only confirm. */
  initial?: { title: string; description: string; payload: number[]; type?: ProposalType } | null;
}) {
  const { publicKey } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const delayCtx = actionDelayContextFrom({
    chainKind,
    evmChainId,
    solanaNetwork: SOLANA_NETWORK,
    evmDeploymentMode: EVM_DEPLOYMENT_MODE,
  });
  const shortActionDelay = !usesProductionActionDelay(delayCtx);
  // In review mode (initial provided), everything is pre-derived — no edits.
  const isReview = !!initial;
  const resolvedType: ProposalType =
    initial?.type ??
    (initial?.title?.startsWith(AGENT_ENABLE_PROPOSAL_TITLE) ? 'agent-enable' : 'policy');
  const resolvedTitle = initial?.title ?? '';
  const resolvedDescription = initial?.description ?? '';

  // Mainnet: 1 hour through 7 days. Testnet/devnet adds 1 minute and defaults to it.
  const PERIOD_OPTIONS = proposalPeriodOptions(delayCtx);
  const defaultPeriodSecs = defaultReviewPeriodSeconds(resolvedType, delayCtx);
  const [reviewPeriodSecs, setReviewPeriodSecs] = useState(defaultPeriodSecs);
  const periodTouched = useRef(false);
  useEffect(() => {
    if (!periodTouched.current) setReviewPeriodSecs(defaultPeriodSecs);
  }, [defaultPeriodSecs]);

  // Manual-mode state (only used when initial is not provided).
  const [form, setForm] = useState<NewProposal>({
    title: '',
    description: '',
    type: 'policy',
    votingPeriod: '7',
  });
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [payloadBytes] = useState<number[]>(initial?.payload ?? []);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Permission proposal: guardian wallets (EVM addresses, one per line) + threshold. */
  const [permissionWalletsText, setPermissionWalletsText] = useState('');
  const [permissionThreshold, setPermissionThreshold] = useState(1);

  const { assets: treasuryAssets } = useTreasuryAssets(daoAddress);
  const registeredTreasuryAssets = useMemo(
    () => treasuryAssets.filter((a) => isSelectableTreasuryMint(a)),
    [treasuryAssets],
  );
  const configuredEvmAdapters = useMemo(
    () => (chainKind === 'evm' && evmChainId ? getConfiguredEvmAdapters(evmChainId) : []),
    [chainKind, evmChainId],
  );
  const [strategyProtocol, setStrategyProtocol] = useState<string>('kamino');
  const [strategyAdapterAddress, setStrategyAdapterAddress] = useState<string>('');
  const [strategyAssetMint, setStrategyAssetMint] = useState<string>('');
  const [strategyAmount, setStrategyAmount] = useState<string>('');

  useEffect(() => {
    if (chainKind === 'evm') {
      if (!strategyAdapterAddress && configuredEvmAdapters[0]?.address) {
        setStrategyAdapterAddress(configuredEvmAdapters[0].address);
      }
    }
  }, [chainKind, configuredEvmAdapters, strategyAdapterAddress]);

  useEffect(() => {
    if (!strategyAssetMint && registeredTreasuryAssets[0]?.mint) {
      setStrategyAssetMint(registeredTreasuryAssets[0].mint);
    }
  }, [registeredTreasuryAssets, strategyAssetMint]);

  function applyTemplate(templateId: string) {
    const template = PROPOSAL_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    setSelectedTemplate(templateId);
    setForm({
      title: template.title,
      description: getProposalDescription(template.type),
      type: template.type,
      votingPeriod: template.votingPeriod,
    });
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function handleSubmit() {
    setError(null);
    const title = isReview ? resolvedTitle : form.title;
    const description = isReview ? resolvedDescription : form.description;
    const type = isReview ? resolvedType : form.type;
    // For review mode, use the selected period in seconds directly.
    // For manual mode, convert days to seconds (backward compat).
    const votingDays = isReview
      ? reviewPeriodSecs / 86400
      : (parseInt(form.votingPeriod, 10) || 7);

    if (!title.trim() || !description.trim()) {
      setError('A title and description are required.');
      return;
    }
    if (isMockDaoAddress(daoAddress)) {
      setSubmitted(true);
      setTimeout(onClose, 1600);
      return;
    }
    if (!daoAddress) { setError('Select a treasury first.'); return; }

    // ── EVM: create the proposal directly on the per-DAO governor ───────────
    if (chainKind === 'evm') {
      if (!evmChainId) { setError('Select an Ethereum, Base, or Robinhood network.'); return; }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio) { setError('EVM contracts are not configured for this network yet.'); return; }
      // Same ordinal mapping the Solana path uses — the governor expects the
      // matching NaveEnums.ProposalType integer.
      const evmTypeNum: Record<ProposalType, number> = {
        'policy': OnChainProposalType.Policy,
        'strategy': OnChainProposalType.Strategy,
        'permission': OnChainProposalType.Permission,
        'emergency': OnChainProposalType.Emergency,
        'general': OnChainProposalType.General,
        'transfer': OnChainProposalType.Transfer,
        'token-mint': OnChainProposalType.TokenMint,
        'token-revoke': OnChainProposalType.TokenRevoke,
        'switch-voting': OnChainProposalType.SwitchVotingSystem,
        'agent-enable': OnChainProposalType.General,
        // Moonlight proposals are created from the Moonlight wizard, not this
        // modal; mapped here only to keep the record exhaustive.
        'moonlight-request': OnChainProposalType.MoonlightRequest,
        'moonlight-distribution': OnChainProposalType.MoonlightDistribution,
      };
      const evmProposalType = evmTypeNum[type] ?? OnChainProposalType.Policy;

      let evmPayloadBytes = payloadBytes;
      let payloadHex: `0x${string}` = (payloadBytes.length
        ? '0x' + payloadBytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('')
        : '0x') as `0x${string}`;

      if (type === 'permission' && !isReview) {
        const wallets = permissionWalletsText
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (wallets.length === 0) {
          setError('Add at least one guardian wallet for a Permission proposal.');
          return;
        }
        const bad = wallets.filter((w) => !isEvmAddress(w));
        if (bad.length) {
          setError(`Invalid guardian address: ${bad[0]}`);
          return;
        }
        if (permissionThreshold < 1 || permissionThreshold > wallets.length) {
          setError(`Threshold must be between 1 and ${wallets.length}.`);
          return;
        }
        try {
          payloadHex = encodeEvmPermissionPayload(wallets, permissionThreshold);
          evmPayloadBytes = Array.from(hexToBytes(payloadHex));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to encode permission payload.');
          return;
        }
      } else if (type === 'strategy' && !isReview) {
        const adapterRaw = strategyAdapterAddress.trim();
        const assetRaw = strategyAssetMint.trim();
        if (!isEvmAddress(adapterRaw)) {
          setError('Select or enter a valid EVM strategy adapter address.');
          return;
        }
        if (!isEvmAddress(assetRaw)) {
          setError('Select or enter a valid ERC-20 treasury asset address.');
          return;
        }
        const matchedAsset = registeredTreasuryAssets.find(
          (a) => a.mint.toLowerCase() === assetRaw.toLowerCase(),
        );
        const decimals = matchedAsset?.decimals ?? 6;
        let amountBaseUnits: bigint;
        try {
          amountBaseUnits = parseUnits(strategyAmount.trim() || '0', decimals);
        } catch {
          setError('Enter a valid strategy deployment amount.');
          return;
        }
        if (amountBaseUnits <= 0n) {
          setError('Enter a positive strategy deployment amount.');
          return;
        }
        try {
          payloadHex = encodeEvmStrategyProposalPayload(
            adapterRaw as Address,
            amountBaseUnits,
            assetRaw as Address,
          );
          evmPayloadBytes = Array.from(hexToBytes(payloadHex));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to encode EVM strategy payload.');
          return;
        }
      }

      const votingPeriodSeconds = resolveSubmittedVotingPeriod({
        ctx: delayCtx,
        isReview,
        reviewPeriodSecs,
        votingDays,
      });
      const outcome = await tx.sendEvm(
        buildCreateProposalEvm(evmChainId, trio.governor, {
          title,
          description,
          payload: payloadHex,
          proposalType: evmProposalType,
          votingPeriodSeconds,
          votingMint: (isTokenGov && votingMint ? votingMint : '0x0000000000000000000000000000000000000000') as `0x${string}`,
        }),
        { successLabel: 'Proposal submitted', quietMock: true },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') {
        if (evmPayloadBytes.length > 0) {
          persistEvmProposalPayload(daoAddress, proposalCount, type, evmPayloadBytes);
          if (outcome.status === 'success' && evmChainId) {
            void storeEvmProposalPayloadRemote(evmChainId, daoAddress, proposalCount, type, evmPayloadBytes);
          }
        }
        setSubmitted(true);
        setTimeout(onClose, 1600);
      } else if (outcome.status === 'error') {
        setError(outcome.error || 'Failed to submit the proposal.');
      }
      return;
    }

    if (!publicKey) { setError('Connect your wallet to submit a proposal.'); return; }

    const daoPubkey = new PublicKey(daoAddress);
    let daoTokenMint: PublicKey;
    try {
      if (isTokenGov) {
        if (!votingMint) throw new Error('This DAO has no governance token registered. Register one in Settings before creating proposals.');
        const { core } = getNavePrograms();
        const [tokenRegistryPda] = getTokenRegistryPDA(daoPubkey);
        const registry = await core.account.tokenRegistry.fetch(tokenRegistryPda);
        const slot = registry.tokens?.[0];
        if (!slot) throw new Error('This DAO has no governance token registered.');
        daoTokenMint = new PublicKey(slot.mint);
      } else {
        const vault = await fetchTreasuryVault(daoPubkey);
        if (!vault?.vaultTokenAccount) throw new Error('Treasury vault is not initialized for this DAO yet.');
        const { core } = getNavePrograms();
        const acct = await getAccount(core.provider.connection, new PublicKey(vault.vaultTokenAccount));
        daoTokenMint = acct.mint;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve the DAO token mint.');
      return;
    }

    // Map UI type → on-chain ProposalType discriminant.
    const proposalTypeNum: Record<ProposalType, number> = {
      'policy': OnChainProposalType.Policy,
      'strategy': OnChainProposalType.Strategy,
      'permission': OnChainProposalType.Permission,
      'emergency': OnChainProposalType.Emergency,
      'general': OnChainProposalType.General,
      'transfer': OnChainProposalType.Transfer,
      'token-mint': OnChainProposalType.TokenMint,
      'token-revoke': OnChainProposalType.TokenRevoke,
      'switch-voting': OnChainProposalType.SwitchVotingSystem,
      // Agent-enable proposals are plain General proposals on-chain; the canonical
      // title is what surfaces the founder "Execute: Enable Agents" action.
      'agent-enable': OnChainProposalType.General,
      // Moonlight proposals are created from the Moonlight wizard, not this
      // modal; mapped here only to keep the record exhaustive.
      'moonlight-request': OnChainProposalType.MoonlightRequest,
      'moonlight-distribution': OnChainProposalType.MoonlightDistribution,
    };
    const proposalType = proposalTypeNum[type] ?? OnChainProposalType.Policy;
    let solanaPayloadBytes = payloadBytes;
    if (type === 'strategy' && !isReview) {
      const adapterPk = getAdapterProgramId(strategyProtocol);
      if (!adapterPk) {
        setError(`Adapter program is not configured for ${strategyProtocol}.`);
        return;
      }
      const mintRaw = strategyAssetMint.trim() || votingMint || 'So11111111111111111111111111111111111111112';
      let mintPk: PublicKey;
      try {
        mintPk = new PublicKey(mintRaw);
      } catch {
        setError('Select or enter a valid Solana asset mint address.');
        return;
      }
      const matchedAsset = registeredTreasuryAssets.find((a) => a.mint === mintRaw);
      const decimals = matchedAsset?.decimals ?? (mintRaw === 'So11111111111111111111111111111111111111112' ? 9 : 6);
      let amountBaseUnits: bigint;
      try {
        amountBaseUnits = parseUnits(strategyAmount.trim() || '0', decimals);
      } catch {
        setError('Enter a valid strategy deployment amount.');
        return;
      }
      if (amountBaseUnits <= 0n) {
        setError('Enter a positive strategy deployment amount.');
        return;
      }
      // Canonical 72-byte NE-7 strategy payload: [adapter (32)] || [amount u64 LE (8)] || [mint (32)]
      const buf = new Uint8Array(72);
      buf.set(adapterPk.toBytes(), 0);
      const view = new DataView(buf.buffer);
      view.setBigUint64(32, amountBaseUnits, true);
      buf.set(mintPk.toBytes(), 40);
      solanaPayloadBytes = Array.from(buf);
    }
    const result = await buildCreateProposal(
      daoPubkey,
      proposalCount,
      publicKey,
      {
        title,
        description,
        payload: solanaPayloadBytes,
        proposalType,
        votingPeriodSeconds: resolveSubmittedVotingPeriod({
          ctx: delayCtx,
          isReview,
          reviewPeriodSecs,
          votingDays,
        }),
      },
      daoTokenMint,
    );
    const outcome = await tx.send(result, { successLabel: 'Proposal submitted', quietMock: true });
    if (outcome.status === 'mock' || outcome.status === 'success') {
      // Store the strategy raw payload so handleFinalize can auto-bundle
      // create_execution_request in the same tx when this proposal passes.
      if (type === 'strategy' && daoAddress && solanaPayloadBytes.length >= 72) {
        const decoded = decodeSolanaStrategyPayload(solanaPayloadBytes);
        if (decoded) {
          persistSolanaStrategyPayload(daoAddress, proposalCount, decoded.amount, decoded.adapter, decoded.mint);
        }
      }
      setSubmitted(true);
      setTimeout(onClose, 1600);
    } else if (outcome.status === 'error') {
      setError(outcome.error || 'Failed to submit the proposal.');
    }
  }

  const typeMeta = TYPE_META[isReview ? resolvedType : form.type];

  return createPortal(
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(17, 24, 39, 0.48)', backdropFilter: 'blur(3px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      {...fadeOverlay}
    >
      <motion.div
        className="w-full max-w-[520px] rounded-[18px] border"
        style={{
          backgroundColor: '#ffffff',
          borderColor: 'hsl(var(--border))',
          boxShadow: '0 24px 70px -12px rgba(17, 24, 39, 0.35)',
          maxHeight: '86vh',
          overflowY: 'auto',
        }}
        {...scaleIn}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-3.5"
          style={{ padding: '20px 22px 0' }}
        >
          <div>
            <div
              className="text-display"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '23px',
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
                color: 'hsl(var(--foreground))',
              }}
            >
              {isReview ? 'Review & Submit Proposal' : 'Create Proposal'}
            </div>
            <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: '4px', lineHeight: 1.5 }}>
              {isReview
                ? 'Review the auto-generated proposal details, then confirm to put it to a vote'
                : 'Submit a governance proposal for community vote'}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="flex items-center justify-center flex-shrink-0 transition-colors"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              backgroundColor: 'hsl(var(--background))',
              border: '1px solid hsl(var(--surface-2))',
              color: 'hsl(var(--muted-foreground))',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = 'hsl(var(--foreground))';
              e.currentTarget.style.borderColor = 'hsl(var(--border))';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
              e.currentTarget.style.borderColor = 'hsl(var(--surface-2))';
            }}
          >
            <Fi icon="xmark" style={{ fontSize: '14px' }} />
          </button>
        </div>

        {submitted ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mb-3.5"
              style={{
                backgroundColor: '#F2F9F4',
                border: '1px solid #BFE0CC',
                color: 'hsl(var(--success))',
              }}
            >
              <Fi icon="check" style={{ fontSize: '20px', color: 'hsl(var(--success))' }} />
            </div>
            <div
              className="text-display"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '24px',
                color: 'hsl(var(--foreground))',
              }}
            >
              Proposal submitted
            </div>
            <div style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', marginTop: '6px' }}>
              Your proposal has been created and is now open for community vote.
            </div>
          </div>
        ) : isReview ? (
          /* ── Review mode — everything is read-only ─────────────────── */
          <div className="space-y-5" style={{ padding: '18px 22px 22px' }}>
            {/* Type badge + voting period picker */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                  style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', backgroundColor: typeMeta.bg, color: typeMeta.color, border: `1px solid ${typeMeta.border}` }}
                >
                  <Fi icon={typeMeta.icon} style={{ fontSize: '11px' }} />
                  {typeMeta.label}
                </span>
              </div>
              {/* Voting period — editable even in review mode */}
              <div>
                <div className="nave-label mb-1.5" style={{ fontSize: '11px' }}>
                  Voting period
                  <span style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))', fontWeight: 400, marginLeft: '6px' }}>
                    — choose how long votes are open. Shorter = faster resolution.
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PERIOD_OPTIONS.map(opt => {
                    const sel = reviewPeriodSecs === opt.secs;
                    return (
                      <button
                        key={opt.secs}
                        type="button"
                        onClick={() => {
                          periodTouched.current = true;
                          setReviewPeriodSecs(opt.secs);
                        }}
                        className="px-3 py-1.5 rounded-full border transition-all"
                        style={{
                          fontSize: '12px',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: sel ? 600 : 400,
                          backgroundColor: sel ? '#111827' : '#ffffff',
                          borderColor: sel ? '#111827' : 'hsl(var(--border))',
                          color: sel ? '#ffffff' : 'hsl(var(--muted-foreground))',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Title */}
            <div>
              <div className="nave-label mb-2">Proposal Title</div>
              <div
                className="px-3 py-2.5 rounded-[10px] border"
                style={{ fontSize: '14px', fontWeight: 500, backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--surface-2))', color: 'hsl(var(--foreground))', lineHeight: 1.4 }}
              >
                {resolvedTitle}
              </div>
            </div>

            {/* Description / Policy details */}
            {resolvedType === 'policy' && payloadBytes.length > 0 ? (
              <PolicySummaryFromPayload payloadBytes={payloadBytes} />
            ) : (
              <div>
                <div className="nave-label mb-2">Description</div>
                <div
                  className="px-3 py-3 rounded-[10px] border overflow-y-auto"
                  style={{ fontSize: '13px', backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--surface-2))', color: 'hsl(var(--muted-foreground))', lineHeight: 1.65, whiteSpace: 'pre-wrap', maxHeight: '200px' }}
                >
                  {resolvedDescription}
                </div>
              </div>
            )}

            {/* Governance note */}
            <div
              className="flex items-start gap-2 rounded-[12px]"
              style={{
                padding: '13px 14px',
                backgroundColor: 'hsl(var(--background))',
                border: '1px solid hsl(var(--surface-2))',
              }}
            >
              <Fi icon="circle-info" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', flexShrink: 0, marginTop: '3px' }} />
              <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
                Submitting this transaction opens a guardian vote. It can be finalized immediately once the yes votes cannot be overturned. Otherwise anyone can finalize it after the voting window closes.
              </p>
            </div>

            {error && (
              <div className="px-3 py-2.5 rounded-lg border" style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(4 60% 80%)', color: 'hsl(var(--destructive))' }}>
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-4 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-[9px] transition-colors"
                style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--muted-foreground))' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'hsl(var(--foreground))')}
                onMouseLeave={e => (e.currentTarget.style.color = 'hsl(var(--muted-foreground))')}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                className="flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                style={{ fontSize: '13px', backgroundColor: '#111827', color: '#ffffff' }}
              >
                <Fi icon="paper-plane" style={{ fontSize: '12px' }} />
                Confirm & Submit
              </button>
            </div>
          </div>
        ) : (
          /* ── Manual mode — minimal form for ad-hoc proposals ──────── */
          <div className="space-y-5" style={{ padding: '18px 22px 22px' }}>
            {/* Template picker */}
            <div>
              <label className="nave-label mb-2 block">Start from a template</label>
              <div className="flex flex-wrap gap-1.5">
                {PROPOSAL_TEMPLATES.map((t) => {
                  const active = selectedTemplate === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => applyTemplate(t.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border transition-all"
                      style={{
                        fontSize: '12px',
                        fontWeight: active ? 600 : 400,
                        backgroundColor: active ? '#111827' : '#ffffff',
                        borderColor: active ? '#111827' : 'hsl(var(--border))',
                        color: active ? '#ffffff' : 'hsl(var(--muted-foreground))',
                      }}
                    >
                      <Fi icon={t.icon} style={{ fontSize: '11px' }} />
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Type selector */}
            <div>
              <label className="nave-label mb-2 block">Proposal Type</label>
              <div className="flex flex-wrap gap-1.5">
                {((['policy', 'strategy', 'permission', 'transfer', 'token-mint', 'general'] as ProposalType[])).map(t => {
                  const m = TYPE_META[t];
                  const active = form.type === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setForm(f => ({ ...f, type: t }))}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-left transition-all"
                      style={{
                        fontSize: '12px',
                        fontWeight: active ? 600 : 400,
                        backgroundColor: active ? '#111827' : '#ffffff',
                        borderColor: active ? '#111827' : 'hsl(var(--border))',
                        color: active ? '#ffffff' : 'hsl(var(--muted-foreground))',
                      }}
                    >
                      <Fi icon={m.icon} style={{ fontSize: '11px', flexShrink: 0 }} />
                      <span style={{ lineHeight: 1.2 }}>{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Title */}
            <div>
              <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}>Title</label>
              <input
                type="text"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Concise proposal title…"
                className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
                style={{ fontSize: '14px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
                onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
              />
            </div>

            {/* Description */}
            <div>
              <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}>Description</label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Describe the rationale, impact, and implementation details…"
                rows={4}
                className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors resize-vertical"
                style={{ fontSize: '14px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', lineHeight: 1.55 }}
                onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
                onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
              />
            </div>

            {/* Strategy payload — Solana 72-byte NE-7 or EVM abi.encode(adapter, amount, asset) */}
            {form.type === 'strategy' && (
              <div className="space-y-3">
                <div>
                  <label className="nave-label mb-2 block">
                    {chainKind === 'evm' ? 'Strategy adapter' : 'Protocol'}
                  </label>
                  {chainKind === 'evm' ? (
                    <div className="space-y-2">
                      {configuredEvmAdapters.length > 0 && (
                        <select
                          value={strategyAdapterAddress}
                          onChange={(e) => setStrategyAdapterAddress(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-lg border outline-none"
                          style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                        >
                          {configuredEvmAdapters.map((a) => (
                            <option key={a.address} value={a.address}>
                              {a.protocolId.toUpperCase()} ({a.address.slice(0, 6)}…{a.address.slice(-4)})
                            </option>
                          ))}
                        </select>
                      )}
                      <input
                        type="text"
                        value={strategyAdapterAddress}
                        onChange={(e) => setStrategyAdapterAddress(e.target.value)}
                        placeholder="0x… adapter contract address"
                        className="w-full px-3 py-2 rounded-lg border outline-none nave-mono"
                        style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                      />
                    </div>
                  ) : (
                    <select
                      value={strategyProtocol}
                      onChange={(e) => setStrategyProtocol(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-lg border outline-none"
                      style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                    >
                      <option value="kamino">Kamino</option>
                      <option value="jito">Jito</option>
                      <option value="jupiter">Jupiter</option>
                      {MARGINFI_STRATEGY_ENABLED && <option value="marginfi">MarginFi</option>}
                    </select>
                  )}
                </div>
                <div>
                  <label className="nave-label mb-2 block">Treasury asset</label>
                  {registeredTreasuryAssets.length > 0 ? (
                    <select
                      value={strategyAssetMint}
                      onChange={(e) => setStrategyAssetMint(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-lg border outline-none"
                      style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                    >
                      {registeredTreasuryAssets.map((a) => (
                        <option key={a.mint} value={a.mint}>
                          {a.symbol} — {a.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })} available
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={strategyAssetMint}
                      onChange={(e) => setStrategyAssetMint(e.target.value)}
                      placeholder={chainKind === 'evm' ? '0x… ERC-20 asset address' : 'SPL token mint address'}
                      className="w-full px-3 py-2 rounded-lg border outline-none nave-mono"
                      style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                    />
                  )}
                </div>
                <div>
                  <label className="nave-label mb-2 block">Deployment amount</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={strategyAmount}
                    onChange={(e) => setStrategyAmount(e.target.value)}
                    placeholder="e.g. 10"
                    className="w-full px-3 py-2 rounded-lg border outline-none nave-mono"
                    style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  />
                </div>
              </div>
            )}

            {/* Permission payload — EVM abi.encode(wallets, threshold) */}
            {form.type === 'permission' && chainKind === 'evm' && (
              <div className="space-y-3">
                <div>
                  <label className="nave-label mb-2 block">Guardian wallets</label>
                  <textarea
                    value={permissionWalletsText}
                    onChange={(e) => setPermissionWalletsText(e.target.value)}
                    placeholder="0x… addresses, one per line"
                    rows={3}
                    className="w-full px-3 py-2.5 rounded-lg border outline-none transition-colors resize-none"
                    style={{ fontSize: '12.5px', fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  />
                </div>
                <div>
                  <label className="nave-label mb-2 block">Threshold</label>
                  <input
                    type="number"
                    min={1}
                    value={permissionThreshold}
                    onChange={(e) => setPermissionThreshold(Math.max(1, Number(e.target.value) || 1))}
                    className="w-24 px-3 py-2 rounded-lg border outline-none"
                    style={{ fontSize: '13.5px', fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  />
                  <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '6px', lineHeight: 1.45 }}>
                    Encoded as <code>abi.encode(wallets, threshold)</code> and applied via{' '}
                    <code>executePermissionProposal</code> after the vote passes.
                  </p>
                </div>
              </div>
            )}

            {shortActionDelay && (
              <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                Voting stays open for 1 minute on this network.
              </p>
            )}

            {error && (
              <div className="px-3 py-2.5 rounded-lg border" style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(4 60% 80%)', color: 'hsl(var(--destructive))' }}>
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-4 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-[9px] transition-colors"
                style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--muted-foreground))' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'hsl(var(--foreground))')}
                onMouseLeave={e => (e.currentTarget.style.color = 'hsl(var(--muted-foreground))')}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!form.title.trim() || !form.description.trim()}
                className="flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                style={{ fontSize: '13px', backgroundColor: '#111827', color: '#ffffff', opacity: !form.title.trim() || !form.description.trim() ? 0.4 : 1 }}
              >
                <Fi icon="paper-plane" style={{ fontSize: '12px' }} />
                Submit Proposal
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}