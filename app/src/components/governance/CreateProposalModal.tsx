import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { motion } from 'framer-motion';
import { getAccount } from '@solana/spl-token';
import { bytesToHex, parseUnits, type Address } from 'viem';
import Fi from '@/components/Fi';
import { scaleIn, fadeOverlay } from '@/components/PageTransition';
import { useSendTransaction } from '@/hooks/useSendTransaction';
import { useChain } from '@/hooks/useChain';
import { useTreasuryAssets } from '@/hooks/useTreasuryAssets';
import { isSelectableTreasuryMint } from '@/lib/treasuryAssetEligibility';
import { fetchDaoContracts } from '@/lib/evm/readers';
import { storeEvmProposalPayloadRemote } from '@/lib/evmProposalPayloadStore';
import { buildCreateProposalEvm } from '@/lib/evm/writers';
import { buildCreateProposal, encodeSolanaTransferProposalPayload } from '@/lib/transactionBuilders';
import { getNavePrograms } from '@/lib/naveProgram';
import { getTokenRegistryPDA } from '@/lib/pdaDerivation';
import { fetchTreasuryVault } from '@/lib/onChainFetcher';
import { decodeConstitutionPayload, encodeEvmTransferRequestPayload } from '@/lib/constitutionPayload';
import { isMockDaoAddress } from '@/lib/mockData';
import { isEvmAddress } from '@/lib/chain/types';
import {
  AGENT_ENABLE_PROPOSAL_TITLE,
  EVM_DEPLOYMENT_MODE,
  SOLANA_NETWORK,
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
  type ProposalType,
} from './types';
import {
  persistEvmProposalPayload,
} from './proposalStorage';

type DecisionTemplateKind = 'payment' | 'rule' | 'general';

const NATIVE_SOL_OPTION = 'SOL_NATIVE';
const NATIVE_EVM_OPTION = '0x0000000000000000000000000000000000000000';

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
  const navigate = useNavigate();
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

  // Manual-mode state (used when !isReview — matching demo's Start a decision modal).
  const [decisionKind, setDecisionKind] = useState<DecisionTemplateKind>('payment');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('3000');
  const [votingDaysStr, setVotingDaysStr] = useState<'3' | '5' | '7'>('5');

  const [payloadBytes] = useState<number[]>(initial?.payload ?? []);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { assets: treasuryAssets } = useTreasuryAssets(daoAddress);
  const registeredTreasuryAssets = useMemo(
    () => treasuryAssets.filter((a) => isSelectableTreasuryMint(a)),
    [treasuryAssets],
  );
  const [selectedAssetMint, setSelectedAssetMint] = useState<string>('');

  useEffect(() => {
    if (!selectedAssetMint) {
      if (registeredTreasuryAssets[0]?.mint) {
        setSelectedAssetMint(registeredTreasuryAssets[0].mint);
      } else {
        setSelectedAssetMint(chainKind === 'evm' ? NATIVE_EVM_OPTION : NATIVE_SOL_OPTION);
      }
    }
  }, [registeredTreasuryAssets, selectedAssetMint, chainKind]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function handleSubmit() {
    setError(null);

    if (!isReview && decisionKind === 'rule') {
      onClose();
      navigate('/rules', { state: { startAmend: true } });
      return;
    }

    const finalTitle = isReview ? resolvedTitle : title.trim();
    const finalDescription = isReview ? resolvedDescription : description.trim();
    const hasRecipient = !isReview && decisionKind === 'payment' && recipient.trim().length > 0;
    const type: ProposalType = isReview
      ? resolvedType
      : decisionKind === 'payment' && hasRecipient
        ? 'transfer'
        : 'general';

    const votingDays = isReview
      ? reviewPeriodSecs / 86400
      : (parseInt(votingDaysStr, 10) || 5);

    if (!finalTitle || !finalDescription) {
      setError('A title and reason are required.');
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
        'moonlight-request': OnChainProposalType.MoonlightRequest,
        'moonlight-distribution': OnChainProposalType.MoonlightDistribution,
      };
      const evmProposalType = evmTypeNum[type] ?? OnChainProposalType.General;

      let evmPayloadBytes = payloadBytes;
      let payloadHex: `0x${string}` = (payloadBytes.length
        ? '0x' + payloadBytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('')
        : '0x') as `0x${string}`;

      if (!isReview && type === 'transfer') {
        const recTrimmed = recipient.trim();
        if (!isEvmAddress(recTrimmed)) {
          setError('Enter a valid recipient address (0x…).');
          return;
        }
        const assetAddr = (selectedAssetMint && isEvmAddress(selectedAssetMint)
          ? selectedAssetMint
          : NATIVE_EVM_OPTION) as Address;
        const matchedAsset = registeredTreasuryAssets.find(
          (a) => a.mint.toLowerCase() === assetAddr.toLowerCase(),
        );
        const decimals = matchedAsset?.decimals ?? (assetAddr === NATIVE_EVM_OPTION ? 18 : 6);
        let amountBaseUnits: bigint;
        try {
          amountBaseUnits = parseUnits(amount.trim() || '0', decimals);
        } catch {
          setError('Enter a valid payment amount.');
          return;
        }
        if (amountBaseUnits <= 0n) {
          setError('Enter a positive payment amount.');
          return;
        }
        try {
          evmPayloadBytes = encodeEvmTransferRequestPayload({
            asset: assetAddr,
            recipient: recTrimmed as Address,
            amount: amountBaseUnits,
          });
          payloadHex = bytesToHex(new Uint8Array(evmPayloadBytes));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to encode payment payload.');
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
          title: finalTitle,
          description: finalDescription,
          payload: payloadHex,
          proposalType: evmProposalType,
          votingPeriodSeconds,
          votingMint: (isTokenGov && votingMint ? votingMint : '0x0000000000000000000000000000000000000000') as `0x${string}`,
        }),
        { successLabel: 'Decision published', quietMock: true },
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
        setError(outcome.error || 'Failed to publish the decision.');
      }
      return;
    }

    if (!publicKey) { setError('Connect your wallet to publish a decision.'); return; }

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
      'agent-enable': OnChainProposalType.General,
      'moonlight-request': OnChainProposalType.MoonlightRequest,
      'moonlight-distribution': OnChainProposalType.MoonlightDistribution,
    };
    const proposalType = proposalTypeNum[type] ?? OnChainProposalType.General;
    let solanaPayloadBytes = payloadBytes;

    if (!isReview && type === 'transfer') {
      let recipientPk: PublicKey;
      try {
        recipientPk = new PublicKey(recipient.trim());
      } catch {
        setError('Enter a valid Solana recipient address.');
        return;
      }
      const isNativeSol = !selectedAssetMint || selectedAssetMint === NATIVE_SOL_OPTION;
      let mintOrZero: PublicKey | null = null;
      let decimals = 9;
      if (!isNativeSol) {
        try {
          mintOrZero = new PublicKey(selectedAssetMint);
        } catch {
          setError('Select a valid asset.');
          return;
        }
        const matchedAsset = registeredTreasuryAssets.find((a) => a.mint === selectedAssetMint);
        decimals = matchedAsset?.decimals ?? 6;
      }
      let amountBaseUnits: bigint;
      try {
        amountBaseUnits = parseUnits(amount.trim() || '0', decimals);
      } catch {
        setError('Enter a valid payment amount.');
        return;
      }
      if (amountBaseUnits <= 0n) {
        setError('Enter a positive payment amount.');
        return;
      }
      solanaPayloadBytes = encodeSolanaTransferProposalPayload(recipientPk, mintOrZero, amountBaseUnits);
    }

    const result = await buildCreateProposal(
      daoPubkey,
      proposalCount,
      publicKey,
      {
        title: finalTitle,
        description: finalDescription,
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
    const outcome = await tx.send(result, { successLabel: 'Decision published', quietMock: true });
    if (outcome.status === 'mock' || outcome.status === 'success') {
      setSubmitted(true);
      setTimeout(onClose, 1600);
    } else if (outcome.status === 'error') {
      setError(outcome.error || 'Failed to publish the decision.');
    }
  }

  const typeMeta = TYPE_META[isReview ? resolvedType : 'general'];

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
              {isReview ? 'Review & Submit Proposal' : 'Start a decision'}
            </div>
            <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: '4px', lineHeight: 1.5 }}>
              {isReview
                ? 'Review the auto-generated proposal details, then confirm to put it to a vote'
                : 'Plain templates. Members see what it costs and what happens if it passes.'}
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
              Decision published
            </div>
            <div style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', marginTop: '6px' }}>
              Members can now vote. You’ll find it at the top of Decisions.
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
              <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
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
          /* ── Manual mode — Demo's 3 human templates ────────────────── */
          <div className="space-y-4" style={{ padding: '18px 22px 22px' }}>
            {/* Type selector */}
            <div>
              <label
                htmlFor="decision-type-select"
                style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}
              >
                Type
              </label>
              <select
                id="decision-type-select"
                value={decisionKind}
                onChange={(e) => {
                  setDecisionKind(e.target.value as DecisionTemplateKind);
                  setError(null);
                }}
                className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
                style={{
                  fontSize: '14px',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                }}
              >
                <option value="payment">Payment — send money</option>
                <option value="rule">Rule change</option>
                <option value="general">General — anything else</option>
              </select>
            </div>

            {decisionKind === 'rule' ? (
              <div className="space-y-4 pt-1">
                <div
                  className="rounded-[12px] p-4"
                  style={{
                    backgroundColor: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--surface-2))',
                    fontSize: '13.5px',
                    color: 'hsl(var(--muted-foreground))',
                    lineHeight: 1.65,
                  }}
                >
                  Rule changes preview as a plain-English sentence in the Rules editor before publishing. The Guardrail enforces the new rule only after the vote passes and a founder activates it.
                </div>

                <div className="flex items-center justify-end gap-2 pt-3 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-[9px] transition-colors"
                    style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--muted-foreground))' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      navigate('/rules', { state: { startAmend: true } });
                    }}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                    style={{ fontSize: '13px', backgroundColor: '#111827', color: '#ffffff' }}
                  >
                    Open Rules editor →
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Title */}
                <div>
                  <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}>
                    Title
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Fund the winter meetup series"
                    className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
                    style={{ fontSize: '14px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                  />
                </div>

                {decisionKind === 'payment' && (
                  <>
                    <div>
                      <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}>
                        Who gets paid?
                      </label>
                      <input
                        type="text"
                        value={recipient}
                        onChange={(e) => setRecipient(e.target.value)}
                        placeholder={chainKind === 'evm' ? '0x… wallet address' : 'Recipient wallet address'}
                        className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
                        style={{ fontSize: '14px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                        onFocus={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
                        onBlur={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}>
                          Amount (USDC / native)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          placeholder="3000"
                          className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
                          style={{ fontSize: '14px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                          onFocus={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
                          onBlur={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                        />
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}>
                          Asset
                        </label>
                        <select
                          value={selectedAssetMint}
                          onChange={(e) => setSelectedAssetMint(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
                          style={{ fontSize: '14px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                        >
                          {registeredTreasuryAssets.map((a) => (
                            <option key={a.mint} value={a.mint}>
                              {a.symbol} ({a.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })})
                            </option>
                          ))}
                          {chainKind === 'evm' ? (
                            <option value={NATIVE_EVM_OPTION}>ETH (Native)</option>
                          ) : (
                            <option value={NATIVE_SOL_OPTION}>SOL (Native)</option>
                          )}
                        </select>
                      </div>
                    </div>
                  </>
                )}

                {/* Why? (shown to every voter) */}
                <div>
                  <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}>
                    Why? (shown to every voter)
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What it funds, what happens if it passes, what happens if it doesn't."
                    rows={3}
                    className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors resize-vertical"
                    style={{ fontSize: '14px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', lineHeight: 1.55 }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--foreground))')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                  />
                </div>

                {/* Voting closes in */}
                <div>
                  <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '7px', color: 'hsl(var(--foreground))' }}>
                    Voting closes in
                  </label>
                  <select
                    value={votingDaysStr}
                    onChange={(e) => setVotingDaysStr(e.target.value as '3' | '5' | '7')}
                    className="w-full px-3 py-2.5 rounded-[10px] border outline-none transition-colors"
                    style={{ fontSize: '14px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  >
                    <option value="3">3 days</option>
                    <option value="5">5 days</option>
                    <option value="7">7 days</option>
                  </select>
                  {shortActionDelay && (
                    <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px', lineHeight: 1.4 }}>
                      Fast-forwarded to 1 minute on this test network.
                    </p>
                  )}
                </div>

                {/* Notebox */}
                <div
                  className="rounded-[12px]"
                  style={{
                    padding: '13px 14px',
                    backgroundColor: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--surface-2))',
                    fontSize: '13px',
                    color: 'hsl(var(--muted-foreground))',
                    lineHeight: 1.6,
                  }}
                >
                  A simple majority of votes cast decides. If it passes, your agents carry it out and report back here.
                </div>

                {error && (
                  <div className="px-3 py-2.5 rounded-lg border" style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(4 60% 80%)', color: 'hsl(var(--destructive))' }}>
                    {error}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-4 border-t" style={{ borderColor: 'hsl(var(--surface-2))' }}>
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-[9px] transition-colors"
                    style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--muted-foreground))' }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = 'hsl(var(--foreground))')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = 'hsl(var(--muted-foreground))')}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSubmit()}
                    disabled={!title.trim() || !description.trim()}
                    className="flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                    style={{ fontSize: '13px', backgroundColor: '#111827', color: '#ffffff', opacity: !title.trim() || !description.trim() ? 0.4 : 1 }}
                  >
                    Publish decision
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
