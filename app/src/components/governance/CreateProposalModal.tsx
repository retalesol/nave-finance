import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { motion } from 'framer-motion';
import { getAccount } from '@solana/spl-token';
import { hexToBytes } from 'viem';
import Fi from '@/components/Fi';
import { scaleIn, fadeOverlay } from '@/components/PageTransition';
import { useSendTransaction } from '@/hooks/useSendTransaction';
import { useChain } from '@/hooks/useChain';
import { fetchDaoContracts } from '@/lib/evm/readers';
import { storeEvmProposalPayloadRemote } from '@/lib/evmProposalPayloadStore';
import { buildCreateProposalEvm, encodeEvmPermissionPayload } from '@/lib/evm/writers';
import { buildCreateProposal } from '@/lib/transactionBuilders';
import { getNavePrograms } from '@/lib/naveProgram';
import { getTokenRegistryPDA } from '@/lib/pdaDerivation';
import { fetchTreasuryVault } from '@/lib/onChainFetcher';
import { decodeConstitutionPayload } from '@/lib/constitutionPayload';
import { isMockDaoAddress } from '@/lib/mockData';
import { isEvmAddress } from '@/lib/chain/types';
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
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
        {rows.map((r, i) => (
          <div key={r.label} className="flex items-center justify-between px-3 py-2" style={{ borderBottom: i < rows.length - 1 ? '1px solid hsl(var(--border))' : 'none', backgroundColor: i % 2 === 0 ? 'hsl(var(--surface-1))' : 'hsl(var(--surface-0))' }}>
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>{r.label}</span>
            <span className="nave-mono" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>{r.value}</span>
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
  // In review mode (initial provided), everything is pre-derived — no edits.
  const isReview = !!initial;
  const resolvedType: ProposalType = initial?.type ?? 'policy';
  const resolvedTitle = initial?.title ?? '';
  const resolvedDescription = initial?.description ?? '';

  // Voting period options for the review picker (in seconds).
  const PERIOD_OPTIONS = [
    { label: '1 hour',   secs: 3600     },
    { label: '6 hours',  secs: 21600    },
    { label: '1 day',    secs: 86400    },
    { label: '3 days',   secs: 259200   },
    { label: '7 days',   secs: 604800   },
  ];
  // Default: 1 day for policy/constitutional proposals; 3 days for strategy/transfer.
  const defaultPeriodSecs =
    resolvedType === 'strategy' || resolvedType === 'transfer' ? 259200 : 86400;
  const [reviewPeriodSecs, setReviewPeriodSecs] = useState(defaultPeriodSecs);

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
      }

      const votingPeriodSeconds = isReview
        ? reviewPeriodSecs
        : Math.max(86400, Math.round(votingDays) * 86400);
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
    const result = await buildCreateProposal(
      daoPubkey,
      proposalCount,
      publicKey,
      {
        title,
        description,
        payload: payloadBytes,
        proposalType,
        // Review mode: use seconds directly for sub-day precision.
        // Manual mode: votingDays was parsed from the day picker (days × 86400).
        votingPeriodSeconds: isReview
          ? reviewPeriodSecs
          : Math.max(86400, Math.round(votingDays) * 86400),
      },
      daoTokenMint,
    );
    const outcome = await tx.send(result, { successLabel: 'Proposal submitted', quietMock: true });
    if (outcome.status === 'mock' || outcome.status === 'success') {
      // Store the strategy raw payload so handleFinalize can auto-bundle
      // create_execution_request in the same tx when this proposal passes.
      if (type === 'strategy' && daoAddress && payloadBytes.length >= 72) {
        const decoded = decodeSolanaStrategyPayload(payloadBytes);
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
      style={{ backgroundColor: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      {...fadeOverlay}
    >
      <motion.div
        className="w-full max-w-lg rounded-2xl border shadow-xl"
        style={{
          backgroundColor: 'hsl(var(--surface-0))',
          borderColor: 'hsl(var(--border))',
          boxShadow: 'var(--shadow-xl)',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
        {...scaleIn}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
          <div>
            <div className="text-display font-semibold" style={{ fontSize: '16px' }}>
              {isReview ? 'Review & Submit Proposal' : 'Create Proposal'}
            </div>
            <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
              {isReview
                ? 'Review the auto-generated proposal details, then confirm to put it to a vote'
                : 'Submit a governance proposal for community vote'}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          >
            <Fi icon="xmark" style={{ fontSize: '16px' }} />
          </button>
        </div>

        {submitted ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4" style={{ backgroundColor: 'hsl(var(--accent-muted))' }}>
              <Fi icon="circle-check" style={{ fontSize: '22px', color: 'hsl(var(--accent))' }} />
            </div>
            <div className="text-display font-semibold" style={{ fontSize: '16px' }}>Proposal submitted</div>
            <div style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: '6px' }}>
              Your proposal has been created and is now open for community vote.
            </div>
          </div>
        ) : isReview ? (
          /* ── Review mode — everything is read-only ─────────────────── */
          <div className="p-6 space-y-5">
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
                        onClick={() => setReviewPeriodSecs(opt.secs)}
                        className="px-3 py-1.5 rounded-lg border transition-all"
                        style={{
                          fontSize: '12px',
                          fontFamily: 'var(--font-mono)',
                          backgroundColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--surface-1))',
                          borderColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                          color: sel ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
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
                className="px-3 py-2.5 rounded-lg border"
                style={{ fontSize: '14px', fontWeight: 500, backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', lineHeight: 1.4 }}
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
                  className="px-3 py-3 rounded-lg border overflow-y-auto"
                  style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', lineHeight: 1.65, whiteSpace: 'pre-wrap', maxHeight: '200px' }}
                >
                  {resolvedDescription}
                </div>
              </div>
            )}

            {/* Governance note */}
            <div
              className="flex items-start gap-2 px-3 py-2.5 rounded-lg"
              style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
            >
              <Fi icon="circle-info" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', flexShrink: 0, marginTop: '2px' }} />
              <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                Submitting this transaction creates a governance vote. Once the voting period ends and quorum is reached, the founder can ratify the result on-chain to activate the changes.
              </p>
            </div>

            {error && (
              <div className="px-3 py-2.5 rounded-lg border" style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)', color: 'hsl(var(--destructive))' }}>
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg border transition-colors"
                style={{ fontSize: '13.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-all"
                style={{ fontSize: '13.5px', backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
              >
                <Fi icon="paper-plane" style={{ fontSize: '13px' }} />
                Confirm & Submit
              </button>
            </div>
          </div>
        ) : (
          /* ── Manual mode — minimal form for ad-hoc proposals ──────── */
          <div className="p-6 space-y-5">
            {/* Template picker */}
            <div>
              <label className="nave-label mb-2 block">Start from a template</label>
              <div className="flex flex-wrap gap-2">
                {PROPOSAL_TEMPLATES.map((t) => {
                  const active = selectedTemplate === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => applyTemplate(t.id)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-all"
                      style={{
                        fontSize: '12px',
                        backgroundColor: active ? 'hsl(var(--primary))' : 'hsl(var(--surface-1))',
                        borderColor: active ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                        color: active ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
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
              <div className="grid grid-cols-3 gap-2">
                {((['policy', 'strategy', 'permission', 'transfer', 'token-mint', 'general'] as ProposalType[])).map(t => {
                  const m = TYPE_META[t];
                  const active = form.type === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setForm(f => ({ ...f, type: t }))}
                      className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-left transition-all"
                      style={{
                        fontSize: '12px',
                        backgroundColor: active ? 'hsl(var(--primary))' : 'hsl(var(--surface-1))',
                        borderColor: active ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                        color: active ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
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
              <label className="nave-label mb-2 block">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Concise proposal title…"
                className="w-full px-3 py-2.5 rounded-lg border outline-none transition-colors"
                style={{ fontSize: '13.5px', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
                onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
              />
            </div>

            {/* Description */}
            <div>
              <label className="nave-label mb-2 block">Description</label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Describe the rationale, impact, and implementation details…"
                rows={5}
                className="w-full px-3 py-2.5 rounded-lg border outline-none transition-colors resize-none"
                style={{ fontSize: '13.5px', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', lineHeight: 1.6 }}
                onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
                onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
              />
            </div>

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

            {error && (
              <div className="px-3 py-2.5 rounded-lg border" style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)', color: 'hsl(var(--destructive))' }}>
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg border transition-colors"
                style={{ fontSize: '13.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!form.title.trim() || !form.description.trim()}
                className="flex items-center gap-2 px-5 py-2 rounded-lg font-medium transition-all"
                style={{ fontSize: '13.5px', backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', opacity: !form.title.trim() || !form.description.trim() ? 0.5 : 1 }}
              >
                <Fi icon="paper-plane" style={{ fontSize: '13px' }} />
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