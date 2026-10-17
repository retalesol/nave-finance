import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { motion, AnimatePresence } from 'framer-motion';
import Fi from '../components/Fi';
import { toast } from '../hooks/use-toast';
import Toggle from '../components/Toggle';
import CollapsibleSection from '../components/CollapsibleSection';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import { scaleIn, fadeOverlay } from '../components/PageTransition';
import { useDaoContext } from '../hooks/useDaoContext';
import { useGuardianConfig, type GuardianInfo } from '../hooks/useGuardianConfig';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useDaoMembership } from '../hooks/useDaoMembership';
import { useTokenRegistry } from '../hooks/useTokenRegistry';
import { useAgentHealth, timeAgo } from '../hooks/useAgentHealth';
import { useAgentStatus } from '../hooks/useAgentStatus';
import { computeAgentStatus, summarizeAgentStatuses } from '../lib/agentStatus';
import { agentRoleLabel } from '../lib/agentRoleLabel';
import { useAgentSessions, type AgentSession } from '../hooks/useAgentSessions';
import { useActivityLog } from '../hooks/useActivityLog';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import {
  isEvmAddress,
  chainKindFromAddress,
  evmExplorerUrl,
  daoNetworkLabel,
  recommendedSisterChainId,
  sisterDestChainIds,
  isEvmChainId,
  type EvmChainId,
  isTreasuryOpsFamily,
} from '../lib/chain/types';
import { supabase, type DaoRegistryRow } from '../lib/supabaseClient';
import { useWatchedDaos } from '../hooks/useWatchedDaos';
import {
  buildSetDaoPrivacyEvm,
  buildUpdateGuardianConfigEvm,
  buildSetReviewWindowEvm,
  buildEmergencyFreezeEvm,
  buildEmergencyUnfreezeEvm,
  buildQueueGuardianRecoveryEvm,
  buildExecuteGuardianRecoveryEvm,
  buildCancelGuardianRecoveryEvm,
  buildSetLinkedTreasuryEvm,
  defaultGuardianActionDeadline,
  buildRecordMoonlightRequestEvm,
  buildSetMoonlightRecipientEvm,
  buildExecuteMoonlightDistributionEvm,
  buildFinalizeMoonlightEvm,
  buildRestoreDaoEvm,
  buildCreateProposalEvm,
  buildApproveErc20Evm,
  buildWithdrawFromStrategyEvm,
  resolveEvmMinOut,
} from '../lib/evm/writers';
import {
  fetchMoonlightStakeEvm,
  fetchNaveStakeConfigEvm,
  fetchDaoContracts,
  fetchGuardianRecoveryPendingEvm,
  fetchLinkedTreasuryEvm,
  fetchPendingReviewWindowEvm,
  type PendingReviewWindowEvm,
} from '../lib/evm/readers';
import {
  buildEmergencyFreeze,
  buildEmergencyUnfreeze,
  buildUpdateGuardianConfig,
  buildSetReviewWindow,
  buildCreateProposal,
  buildRecordMoonlightRequest,
  buildSetMoonlightDistribution,
  buildExecuteMoonlightDistribution,
  buildFinalizeMoonlight,
  buildRestoreDao,
} from '../lib/transactionBuilders';
import { getAccount } from '@solana/spl-token';
import { getDaoLifecyclePDA, getDaoStakeLockPDA, getProposalPDA } from '../lib/pdaDerivation';
import { fetchTreasuryVault, resolveOpenGuardianActionNonce } from '../lib/onChainFetcher';
import { getNavePrograms } from '../lib/naveProgram';
import { naveBaseUnitsToUi } from '../lib/naveStakeOracle';
import { useConstitution } from '../hooks/useConstitution';
import {
  SWITCH_VOTING_QUORUM_PCT,
  MAX_REVIEW_WINDOW_SECONDS,
  SOLANA_NAVE_MINT,
  SOLANA_NETWORK,
  EVM_DEPLOYMENT_MODE,
} from '../lib/programConfig';
import {
  MAINNET_DEFAULT_VOTING_PERIOD_SECONDS,
  MAINNET_MOONLIGHT_VOTING_PERIOD_SECONDS,
  actionDelayContextFrom,
  defaultReviewWindowFallback,
  reviewWindowMinSeconds,
  reviewWindowPresets,
  votingPeriodForNetwork,
} from '../lib/actionDelays';
import { isMockDaoAddress } from '../lib/mockData';
import { dispatchViaProxy, collectEvmGuardianFreezeSigs, withdrawStrategyViaProxyEvm, updateDaoPrivacy, type AgentRole } from '../lib/edgeFunctionClient';
import { encodeEvmSwitchVotingPayload } from '../lib/constitutionPayload';
import { useAccount, useSignMessage } from 'wagmi';
import { encodeAbiParameters, type Address, parseUnits } from 'viem';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useExecutionPipeline } from '../hooks/useExecutionPipeline';
import { ExecutionStatus } from '../lib/onChainTypes';

/* ── Types ──────────────────────────────────────────────── */
interface Signer {
  id: string;
  address: string;
  label: string;
  added: string;
}

interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  time: string;
  status: 'success' | 'failed' | 'pending';
  hash?: string;
}

/* ── Mock data ──────────────────────────────────────────── */
const INITIAL_SIGNERS: Signer[] = [
  { id: 's1', address: '7xKp…3mBf', label: 'Lead Contributor', added: '45 days ago' },
  { id: 's2', address: '9aRz…8vWq', label: 'Core Team', added: '45 days ago' },
  { id: 's3', address: '4sLm…1nPr', label: 'Community Council', added: '30 days ago' },
];

/* ── Helpers ─────────────────────────────────────────────── */
function statusColor(s: string) {
  if (s === 'success' || s === 'pass') return 'hsl(var(--success))';
  if (s === 'failed' || s === 'fail') return 'hsl(var(--destructive))';
  return 'hsl(var(--warning))';
}

function statusBg(s: string) {
  if (s === 'success' || s === 'pass') return { bg: 'hsl(var(--success-muted))', border: 'hsl(var(--border-strong))', color: 'hsl(var(--foreground))' };
  if (s === 'failed' || s === 'fail') return { bg: 'hsl(var(--destructive-muted))', border: 'hsl(0 72% 80%)', color: 'hsl(var(--destructive))' };
  return { bg: 'hsl(var(--warning-muted))', border: 'hsl(38 92% 75%)', color: 'hsl(38 60% 35%)' };
}

/* Section and Toggle are now shared components imported above */

/* ── Multisig section ────────────────────────────────────── */
function MultisigThresholdAdvanced({
  signersCount,
  threshold,
  setThreshold,
  evmEditsLocked,
}: {
  signersCount: number;
  threshold: number;
  setThreshold: (n: number) => void;
  evmEditsLocked: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 mb-2"
        style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
        Advanced — require {threshold} of {signersCount} approvals
      </button>
      {open && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {Array.from({ length: Math.max(1, signersCount) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                onClick={() => { if (!evmEditsLocked) setThreshold(n); }}
                disabled={evmEditsLocked}
                className="px-3 py-1.5 rounded-lg border transition-all"
                style={{
                  fontSize: '13px',
                  backgroundColor: threshold === n ? 'hsl(var(--primary))' : 'hsl(var(--surface-1))',
                  borderColor: threshold === n ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                  color: threshold === n ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                  opacity: evmEditsLocked ? 0.7 : 1,
                  cursor: evmEditsLocked ? 'not-allowed' : 'pointer',
                }}
              >
                {n} of {signersCount}
              </button>
            ))}
          </div>
          <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '8px', lineHeight: 1.5 }}>
            How many trusted wallets must approve an emergency freeze.
          </p>
        </>
      )}
    </div>
  );
}

function MultisigSection({
  initialSigners,
  initialThreshold,
  daoAddress,
  guardiansBootstrapped = false,
}: {
  initialSigners: Signer[];
  initialThreshold: number;
  daoAddress: string | null;
  /** EVM: after bootstrap, founder may not call updateGuardianConfig — use Permission proposals. */
  guardiansBootstrapped?: boolean;
}) {
  const { publicKey } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const [signers, setSigners] = useState<Signer[]>(initialSigners);
  const [threshold, setThreshold] = useState(initialThreshold);
  const [newAddress, setNewAddress] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [guardianSaved, setGuardianSaved] = useState(false);
  const [guardianError, setGuardianError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const evmEditsLocked = chainKind === 'evm' && guardiansBootstrapped;

  /** Push the current signer list + threshold on-chain via buildUpdateGuardianConfig (EVM bootstrap only). */
  async function saveGuardianConfig() {
    setGuardianError(null);

    // Demo DAOs have no chain to write to — show the saved affordance only there.
    if (isMockDaoAddress(daoAddress)) {
      setGuardianSaved(true);
      savedTimer.current = setTimeout(() => setGuardianSaved(false), 2500);
      return;
    }
    if (!daoAddress) {
      setGuardianError('Select a treasury before updating guardians.');
      return;
    }
    // ── EVM: NaveTreasury.updateGuardianConfig (founder one-shot bootstrap only) ──
    if (chainKind === 'evm') {
      if (guardiansBootstrapped) {
        setGuardianError(
          'Guardians are already bootstrapped. Further changes require a passed Permission proposal (Governance → Create Proposal → Permission Update).',
        );
        return;
      }
      if (!evmChainId) {
        setGuardianError('Select an Ethereum, Base, or Robinhood network.');
        return;
      }
      const evmWallets = signers.map((s) => s.address.trim());
      const evmInvalid = signers.filter((s) => !isEvmAddress(s.address));
      if (evmInvalid.length > 0) {
        setGuardianError(
          `Invalid guardian address: ${evmInvalid.map((s) => s.label || s.address).join(', ')}`,
        );
        return;
      }
      if (evmWallets.length === 0) {
        setGuardianError('Add at least one guardian wallet before saving.');
        return;
      }
      if (threshold < 1 || threshold > evmWallets.length) {
        setGuardianError(`Threshold must be between 1 and ${evmWallets.length}.`);
        return;
      }
      const evmResult = await tx.sendEvm(
        buildUpdateGuardianConfigEvm(evmChainId, daoAddress, evmWallets, threshold),
        { successLabel: 'Guardian config saved', quietMock: true },
      );
      if (evmResult.status === 'success' || evmResult.status === 'mock') {
        setGuardianSaved(true);
        savedTimer.current = setTimeout(() => setGuardianSaved(false), 3000);
      } else if (evmResult.status === 'error') {
        setGuardianError(evmResult.error);
      }
      return;
    }
    if (!publicKey) {
      setGuardianError('Connect your wallet to update guardians.');
      return;
    }

    const daoPubkey = new PublicKey(daoAddress);

    // Validate EVERY signer address up front. Never silently drop an unparseable
    // address or fall back to a connected-wallet-only (1-of-1) config — that would
    // quietly weaken the multisig.
    const invalid = signers.filter((s) => {
      try {
        new PublicKey(s.address);
        return false;
      } catch {
        return true;
      }
    });
    if (invalid.length > 0) {
      setGuardianError(
        `Invalid guardian address: ${invalid.map((s) => s.label || s.address).join(', ')}`,
      );
      return;
    }

    const wallets = signers.map((s) => new PublicKey(s.address));
    if (wallets.length === 0) {
      setGuardianError('Add at least one guardian wallet before saving.');
      return;
    }
    if (threshold < 1 || threshold > wallets.length) {
      setGuardianError(`Threshold must be between 1 and ${wallets.length}.`);
      return;
    }

    const result = await tx.send(
      await buildUpdateGuardianConfig(daoPubkey, publicKey, wallets, threshold),
      {
        successLabel: 'Guardian config saved',
        quietMock: true,
      },
    );

    if (result.status === 'mock') {
      setGuardianSaved(true);
      savedTimer.current = setTimeout(() => setGuardianSaved(false), 2500);
      return;
    }

    if (result.status === 'success') {
      setGuardianSaved(true);
      savedTimer.current = setTimeout(() => setGuardianSaved(false), 3000);
    } else if (result.status === 'error') {
      setGuardianError(result.error);
    }
  }

  function addSigner() {
    if (!newAddress.trim()) return;
    const id = `s${Date.now()}`;
    setSigners(s => [
      ...s,
      {
        id,
        address: newAddress.trim(),
        label: newLabel.trim() || 'Trusted wallet',
        added: 'just now',
      },
    ]);
    setNewAddress('');
    setNewLabel('');
    setAdding(false);
  }

  function removeSigner(id: string) {
    setSigners(s => s.filter(signer => signer.id !== id));
  }

  function handleCopy(addr: string) {
    navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <CollapsibleSection
      title="Trusted Wallets"
      subtitle={signers.length === 0 ? 'Add people who can help freeze the treasury' : `${threshold} of ${signers.length} needed for emergency actions`}
    >
      {evmEditsLocked && (
        <div
          className="flex items-start gap-2.5 p-3 rounded-xl border mb-4"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Fi icon="circle-info" style={{ fontSize: '13px', color: 'hsl(var(--primary))', flexShrink: 0, marginTop: '2px' }} />
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
            Guardians are bootstrapped on-chain. Direct founder edits are disabled — create a{' '}
            <strong style={{ color: 'hsl(var(--foreground))' }}>Permission Update</strong> proposal
            in Governance to change wallets or threshold. If the DAO is frozen, use Guardian Recovery below.
          </p>
        </div>
      )}

      {/* Threshold — Advanced */}
      <MultisigThresholdAdvanced
        signersCount={signers.length}
        threshold={threshold}
        setThreshold={setThreshold}
        evmEditsLocked={evmEditsLocked}
      />

      {/* Signers list */}
      <div className="space-y-2 mb-4">
        {signers.map(signer => (
          <div
            key={signer.id}
            className="flex items-center gap-3 px-3 py-3 rounded-xl border"
            style={{
              backgroundColor: 'hsl(var(--surface-1))',
              borderColor: 'hsl(var(--border))',
            }}
          >
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{
                backgroundColor: 'hsl(var(--primary))',
                fontSize: '10px',
                color: 'white',
                fontFamily: 'var(--font-mono)',
                fontWeight: '600',
              }}
            >
              {signer.label.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: '500',
                  color: 'hsl(var(--foreground))',
                }}
              >
                {signer.label}
              </div>
              <div
                className="nave-mono"
                title={signer.address}
                style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}
              >
                {signer.address.length > 16
                  ? `${signer.address.slice(0, 6)}…${signer.address.slice(-6)}`
                  : signer.address}
              </div>
            </div>
            <div
              style={{
                fontSize: '11px',
                color: 'hsl(var(--muted-foreground))',
                fontFamily: 'var(--font-mono)',
                flexShrink: 0,
              }}
            >
              Added {signer.added}
            </div>
            <button
              onClick={() => handleCopy(signer.address)}
              className="p-1.5 rounded-lg transition-colors flex-shrink-0"
              style={{ color: 'hsl(var(--muted-foreground))' }}
              onMouseEnter={e =>
                (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')
              }
              onMouseLeave={e =>
                (e.currentTarget.style.backgroundColor = '')
              }
            >
              {copied === signer.address ? (
                <Fi icon="check" style={{ fontSize: '13px', color: 'hsl(var(--accent))' }} />
              ) : (
                <Fi icon="copy" style={{ fontSize: '13px' }} />
              )}
            </button>
            <button
              onClick={() => { if (!evmEditsLocked) removeSigner(signer.id); }}
              disabled={evmEditsLocked}
              className="p-1.5 rounded-lg transition-colors flex-shrink-0"
              style={{
                color: 'hsl(var(--muted-foreground))',
                opacity: evmEditsLocked ? 0.4 : 1,
                cursor: evmEditsLocked ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={e => {
                if (!evmEditsLocked) e.currentTarget.style.backgroundColor = 'hsl(var(--destructive-muted))';
              }}
              onMouseLeave={e =>
                (e.currentTarget.style.backgroundColor = '')
              }
            >
              <Fi icon="trash" style={{ fontSize: '13px' }} />
            </button>
          </div>
        ))}
      </div>

      {/* Add signer */}
      {evmEditsLocked ? null : adding ? (
        <div
          className="p-4 rounded-xl border space-y-3"
          style={{
            backgroundColor: 'hsl(var(--surface-1))',
            borderColor: 'hsl(var(--border))',
          }}
        >
          <div className="nave-label">Trusted wallet</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="text"
              value={newAddress}
              onChange={e => setNewAddress(e.target.value)}
              placeholder="Wallet address…"
              className="px-3 py-2 rounded-lg border outline-none"
              style={{
                fontSize: '13px',
                fontFamily: 'var(--font-mono)',
                backgroundColor: 'hsl(var(--surface-0))',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
              onFocus={e =>
                (e.currentTarget.style.borderColor = 'hsl(var(--ring))')
              }
              onBlur={e =>
                (e.currentTarget.style.borderColor = 'hsl(var(--border))')
              }
            />
            <input
              type="text"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="Label (optional)"
              className="px-3 py-2 rounded-lg border outline-none"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--surface-0))',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
                fontFamily: 'var(--font-body)',
              }}
              onFocus={e =>
                (e.currentTarget.style.borderColor = 'hsl(var(--ring))')
              }
              onBlur={e =>
                (e.currentTarget.style.borderColor = 'hsl(var(--border))')
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={addSigner}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--primary))',
                color: 'hsl(var(--primary-foreground))',
              }}
            >
              <Fi icon="check" style={{ fontSize: '13px' }} />
              Add wallet
            </button>
            <button
              onClick={() => setAdding(false)}
              className="px-3 py-2 rounded-lg border"
              style={{
                fontSize: '13px',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--muted-foreground))',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border w-full transition-colors"
          style={{
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            borderColor: 'hsl(var(--border))',
            borderStyle: 'dashed',
          }}
          onMouseEnter={e =>
            (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')
          }
          onMouseLeave={e =>
            (e.currentTarget.style.backgroundColor = '')
          }
        >
          <Fi icon="plus" style={{ fontSize: '13px' }} />
          Add trusted wallet
        </button>
      )}

      {/* Save guardian config button — EVM bootstrap only after first save */}
      <div className="mt-4 space-y-2">
        {guardianError && (
          <div
            className="flex items-center gap-2 p-3 rounded-xl border animate-fade-in"
            style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }} />
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))', flex: 1 }}>{guardianError}</span>
            <button onClick={() => setGuardianError(null)} style={{ fontSize: '11px', color: 'hsl(var(--destructive))', textDecoration: 'underline' }}>dismiss</button>
          </div>
        )}
        {!evmEditsLocked && (
          <button
            onClick={saveGuardianConfig}
            disabled={tx.status === 'signing' || tx.status === 'confirming'}
            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg font-medium transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: guardianSaved ? 'hsl(var(--accent))' : 'hsl(var(--primary))',
              color: 'hsl(var(--primary-foreground))',
              opacity: (tx.status === 'signing' || tx.status === 'confirming') ? 0.6 : 1,
            }}
          >
            {(tx.status === 'signing' || tx.status === 'confirming') ? (
              <Fi icon="arrows-rotate" style={{ fontSize: '13px' }} className="animate-spin" />
            ) : guardianSaved ? (
              <Fi icon="check" style={{ fontSize: '13px' }} />
            ) : (
              <Fi icon="floppy-disk" style={{ fontSize: '13px' }} />
            )}
            {tx.status === 'signing'
              ? 'Signing…'
              : tx.status === 'confirming'
                ? 'Confirming…'
                : guardianSaved
                  ? 'Config Saved'
                  : chainKind === 'evm'
                    ? 'Bootstrap Guardian Config'
                    : 'Save Guardian Config'}
          </button>
        )}
      </div>
    </CollapsibleSection>
  );
}

/* ── EVM: frozen-guardian recovery (queue / execute / cancel) ─────────────── */
function GuardianRecoverySection({
  daoAddress,
  frozen,
}: {
  daoAddress: string | null;
  frozen: boolean;
}) {
  const { evmChainId } = useChain();
  const tx = useSendTransaction();
  const [walletsText, setWalletsText] = useState('');
  const [threshold, setThreshold] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    executableAt: bigint;
    pendingThreshold: number;
    pendingWalletCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!daoAddress || !evmChainId) {
      setPending(null);
      return;
    }
    const row = await fetchGuardianRecoveryPendingEvm(evmChainId, daoAddress);
    setPending(row && row.executableAt > 0n ? row : null);
  }, [daoAddress, evmChainId]);

  useEffect(() => {
    void refresh();
  }, [refresh, frozen]);

  if (!frozen || !daoAddress || !evmChainId) return null;

  function parseWallets(): string[] | null {
    const lines = walletsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setError('Enter at least one replacement guardian address.');
      return null;
    }
    const bad = lines.filter((a) => !isEvmAddress(a));
    if (bad.length) {
      setError(`Invalid address: ${bad[0]}`);
      return null;
    }
    if (threshold < 1 || threshold > lines.length) {
      setError(`Threshold must be between 1 and ${lines.length}.`);
      return null;
    }
    return lines;
  }

  async function run(action: 'queue' | 'execute' | 'cancel') {
    if (!daoAddress || !evmChainId) return;
    setError(null);
    setLoading(true);
    try {
      let built;
      if (action === 'queue') {
        const wallets = parseWallets();
        if (!wallets) return;
        built = buildQueueGuardianRecoveryEvm(evmChainId, daoAddress, wallets, threshold);
      } else if (action === 'execute') {
        built = buildExecuteGuardianRecoveryEvm(evmChainId, daoAddress);
      } else {
        built = buildCancelGuardianRecoveryEvm(evmChainId, daoAddress);
      }
      const outcome = await tx.sendEvm(built, {
        successLabel:
          action === 'queue'
            ? 'Guardian recovery queued'
            : action === 'execute'
              ? 'Guardian recovery executed'
              : 'Guardian recovery cancelled',
        quietMock: true,
      });
      if (outcome.status === 'error') setError(outcome.error);
      else await refresh();
    } finally {
      setLoading(false);
    }
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const canExecute = pending != null && pending.executableAt > 0n && pending.executableAt <= nowSec;

  return (
    <CollapsibleSection
      title="Guardian Recovery"
      subtitle="Frozen escape hatch — queue a replacement set with timelock"
    >
      <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, marginBottom: '12px' }}>
        While frozen, the founder can queue a new guardian set. After the timelock, execute to replace
        guardians (DAO stays frozen until the new set unfreezes). Honest guardians can veto via M-of-N.
      </p>
      {pending && (
        <div
          className="p-3 rounded-xl border mb-3"
          style={{ backgroundColor: 'hsl(var(--warning-muted))', borderColor: 'hsl(38 92% 75%)' }}
        >
          <div style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>
            Pending recovery: {pending.pendingWalletCount} wallet(s), threshold {pending.pendingThreshold}.{' '}
            Executable at unix {pending.executableAt.toString()}
            {canExecute ? ' — ready now.' : ' — waiting on timelock.'}
          </div>
        </div>
      )}
      <textarea
        value={walletsText}
        onChange={(e) => setWalletsText(e.target.value)}
        placeholder="Replacement guardian addresses (one per line)…"
        rows={3}
        className="w-full px-3 py-2 rounded-lg border outline-none mb-2"
        style={{
          fontSize: '12.5px',
          fontFamily: 'var(--font-mono)',
          backgroundColor: 'hsl(var(--surface-0))',
          borderColor: 'hsl(var(--border))',
          color: 'hsl(var(--foreground))',
        }}
      />
      <div className="flex items-center gap-2 mb-3">
        <label className="nave-label" style={{ marginBottom: 0 }}>Threshold</label>
        <input
          type="number"
          min={1}
          value={threshold}
          onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
          className="w-16 px-2 py-1.5 rounded-lg border outline-none"
          style={{
            fontSize: '13px',
            fontFamily: 'var(--font-mono)',
            backgroundColor: 'hsl(var(--surface-0))',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
        />
      </div>
      {error && (
        <div className="mb-2" style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))' }}>{error}</div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => void run('queue')}
          className="px-3 py-2 rounded-lg font-medium"
          style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', opacity: loading ? 0.6 : 1 }}
        >
          Queue recovery
        </button>
        <button
          type="button"
          disabled={loading || !canExecute}
          onClick={() => void run('execute')}
          className="px-3 py-2 rounded-lg font-medium border"
          style={{ fontSize: '12.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', opacity: loading || !canExecute ? 0.5 : 1 }}
        >
          Execute recovery
        </button>
        <button
          type="button"
          disabled={loading || !pending}
          onClick={() => void run('cancel')}
          className="px-3 py-2 rounded-lg font-medium border"
          style={{ fontSize: '12.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', opacity: loading || !pending ? 0.5 : 1 }}
        >
          Cancel
        </button>
      </div>
    </CollapsibleSection>
  );
}

/* ── EVM: linked sister treasury for agent bridges ───────────────────────── */
interface SisterCandidate {
  key: string;
  name: string;
  address: string;
  chainId: EvmChainId;
  source: 'created' | 'watched';
}

function LinkedTreasurySection({ daoAddress }: { daoAddress: string | null }) {
  const { evmChainId } = useChain();
  const { address: evmAddress } = useAccount();
  const watched = useWatchedDaos(evmAddress ?? null);
  const tx = useSendTransaction();
  const recommended = evmChainId ? recommendedSisterChainId(evmChainId) : 1;
  const [destChainId, setDestChainId] = useState<EvmChainId>(recommended);
  const [destTreasury, setDestTreasury] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [candidates, setCandidates] = useState<SisterCandidate[]>([]);
  const [loadingSisters, setLoadingSisters] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (evmChainId) setDestChainId(recommendedSisterChainId(evmChainId));
  }, [evmChainId]);

  useEffect(() => {
    let cancelled = false;
    async function loadSisters() {
      if (!daoAddress || !evmChainId || !evmAddress) {
        setCandidates([]);
        return;
      }
      setLoadingSisters(true);
      const created: SisterCandidate[] = [];
      const { data } = await supabase
        .from('dao_registry')
        .select('name, slug, dao_onchain_address, chain_id, creator_wallet')
        .ilike('creator_wallet', evmAddress);
      for (const row of (data as DaoRegistryRow[] | null) ?? []) {
        const chainId = row.chain_id;
        if (typeof chainId !== 'number' || !isEvmChainId(chainId)) continue;
        if (chainId === evmChainId) continue;
        if (row.dao_onchain_address.toLowerCase() === daoAddress.toLowerCase()) continue;
        created.push({
          key: `created:${chainId}:${row.dao_onchain_address.toLowerCase()}`,
          name: row.name || row.slug || 'Unnamed treasury',
          address: row.dao_onchain_address,
          chainId,
          source: 'created',
        });
      }
      const extra: SisterCandidate[] = [];
      for (const dao of watched.daos) {
        const chainId = dao.chainId;
        if (typeof chainId !== 'number' || !isEvmChainId(chainId)) continue;
        if (chainId === evmChainId) continue;
        if (dao.daoOnchainAddress.toLowerCase() === daoAddress.toLowerCase()) continue;
        const key = `watched:${chainId}:${dao.daoOnchainAddress.toLowerCase()}`;
        if (created.some((c) => c.address.toLowerCase() === dao.daoOnchainAddress.toLowerCase() && c.chainId === chainId)) {
          continue;
        }
        extra.push({
          key,
          name: dao.name || dao.label || 'Watched treasury',
          address: dao.daoOnchainAddress,
          chainId,
          source: 'watched',
        });
      }
      if (!cancelled) {
        setCandidates([...created, ...extra]);
        setLoadingSisters(false);
      }
    }
    void loadSisters();
    return () => { cancelled = true; };
  }, [daoAddress, evmChainId, evmAddress, watched.daos]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!daoAddress || !evmChainId) {
        setCurrent(null);
        return;
      }
      const addr = await fetchLinkedTreasuryEvm(evmChainId, daoAddress, destChainId);
      if (!cancelled) setCurrent(addr);
    }
    void load();
    return () => { cancelled = true; };
  }, [daoAddress, evmChainId, destChainId]);

  if (!daoAddress || !evmChainId || chainKindFromAddress(daoAddress) !== 'evm') return null;

  function pickSister(candidate: SisterCandidate) {
    setSelectedKey(candidate.key);
    setDestChainId(candidate.chainId);
    setDestTreasury(candidate.address);
    setSaved(false);
    setError(null);
  }

  async function save() {
    setError(null);
    setSaved(false);
    if (!isEvmChainId(destChainId)) {
      setError('Choose a destination network.');
      return;
    }
    if (!isEvmAddress(destTreasury)) {
      setError('Choose a sister treasury, or enter an address under Advanced.');
      return;
    }
    const outcome = await tx.sendEvm(
      buildSetLinkedTreasuryEvm(evmChainId!, daoAddress!, destChainId, destTreasury.trim()),
      { successLabel: 'Sister treasury linked', quietMock: true },
    );
    if (outcome.status === 'error') setError(outcome.error);
    else {
      setSaved(true);
      setCurrent(destTreasury.trim());
    }
  }

  const destOptions = sisterDestChainIds(evmChainId);
  const recommendedLabel = daoNetworkLabel(recommended);

  return (
    <CollapsibleSection
      title="Sister Treasury"
      subtitle="Link another of your treasuries so agents can move funds for yield"
    >
      <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, marginBottom: '12px' }}>
        Agents bridge to a treasury you already created on another network — usually {recommendedLabel}.
        Pick one below. You can change this later.
      </p>

      {loadingSisters ? (
        <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginBottom: '10px' }}>
          Looking for your other treasuries…
        </p>
      ) : candidates.length > 0 ? (
        <div className="space-y-1.5 mb-3">
          {candidates.map((c) => {
            const sel = selectedKey === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => pickSister(c)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-left transition-all"
                style={{
                  backgroundColor: sel ? 'hsl(var(--surface-1))' : 'hsl(var(--surface-0))',
                  borderColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                }}
              >
                <div className="min-w-0">
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>{c.name}</div>
                  <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
                    {daoNetworkLabel(c.chainId)}
                    {c.source === 'watched' ? ' · watched' : ''}
                  </div>
                </div>
                {sel && <Fi icon="circle-check" style={{ fontSize: '13px', color: 'hsl(var(--primary))', flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      ) : (
        <div
          className="px-3 py-3 rounded-lg border mb-3"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}
        >
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            No other treasuries found for this wallet. Create one on {recommendedLabel}, then come back — or use Advanced to paste an address.
          </p>
        </div>
      )}

      {current && (
        <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginBottom: '10px', lineHeight: 1.5 }}>
          Currently linked on {daoNetworkLabel(destChainId)}:{' '}
          <span className="nave-mono">{current.slice(0, 6)}…{current.slice(-4)}</span>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1.5 mb-2"
        style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={showAdvanced ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
        Advanced — paste a treasury address
      </button>
      {showAdvanced && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          <div>
            <div className="nave-label mb-1.5">Network</div>
            <select
              value={destChainId}
              onChange={(e) => {
                const id = Number(e.target.value);
                if (isEvmChainId(id)) {
                  setDestChainId(id);
                  setSelectedKey('');
                }
              }}
              className="w-full px-3 py-2 rounded-lg border outline-none"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--surface-0))',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            >
              {destOptions.map((id) => (
                <option key={id} value={id}>{daoNetworkLabel(id)}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="nave-label mb-1.5">Treasury address</div>
            <input
              value={destTreasury}
              onChange={(e) => {
                setDestTreasury(e.target.value);
                setSelectedKey('');
              }}
              placeholder="0x…"
              className="w-full px-3 py-2 rounded-lg border outline-none"
              style={{
                fontSize: '13px',
                fontFamily: 'var(--font-mono)',
                backgroundColor: 'hsl(var(--surface-0))',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mb-2" style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))' }}>{error}</div>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={tx.status === 'signing' || tx.status === 'confirming' || !destTreasury.trim()}
        className="px-4 py-2 rounded-lg font-medium"
        style={{
          fontSize: '13px',
          backgroundColor: saved ? 'hsl(var(--accent))' : 'hsl(var(--primary))',
          color: 'hsl(var(--primary-foreground))',
          opacity: tx.status === 'signing' || tx.status === 'confirming' || !destTreasury.trim() ? 0.6 : 1,
        }}
      >
        {saved ? 'Linked' : 'Link sister treasury'}
      </button>
    </CollapsibleSection>
  );
}

/* ── Protocol whitelist (read-only, live from on-chain constitution) ───────── */
function ConstitutionRulesLink() {
  return (
    <div
      className="nave-card p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
      style={{ borderColor: 'hsl(var(--border))' }}
    >
      <div>
        <div className="text-display font-semibold" style={{ fontSize: '14px' }}>
          Treasury rules & protocols
        </div>
        <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px', lineHeight: 1.5 }}>
          Approved protocols, risk limits, and constitution parameters live on the Constitution page — not here.
        </p>
      </div>
      <Link
        to="/policy"
        className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border font-medium no-underline transition-colors flex-shrink-0"
        style={{ fontSize: '12.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
      >
        <Fi icon="castle" style={{ fontSize: '11px' }} />
        Open Constitution
        <Fi icon="arrow-right" style={{ fontSize: '10px' }} />
      </Link>
    </div>
  );
}

/* ── Emergency controls ──────────────────────────────────── */
/**
 * Coordinated, deterministic guardian-action nonce.
 *
 * Guardian M-of-N signatures only accumulate on the SAME GuardianAction PDA,
 * which is derived from (dao, action_type, nonce). A per-guardian Date.now() (or a
 * per-session counter) gives every guardian a DIFFERENT nonce → a different PDA →
 * the threshold can never be reached. We bucket time into a shared coordination
 * window so every guardian acting within the same window derives the same nonce and
 * converges on one GuardianAction.
 *
 * LIMITATION (flagged): this is a best-effort client-only scheme. If a window
 * boundary falls mid-coordination, guardians can split across two PDAs. Fully
 * correct convergence needs a backend/contract-provided shared action id (e.g. a
 * pending-action registry the client can read), which is out of scope here.
 */
const GUARDIAN_ACTION_WINDOW_MS = 60 * 60 * 1000; // 1-hour coordination window
function coordinatedActionNonce(): number {
  return Math.floor(Date.now() / GUARDIAN_ACTION_WINDOW_MS);
}

/**
 * Resolve the nonce a guardian should sign for a Solana emergency action.
 *
 * First we read the chain for an already-open GuardianAction of this
 * (dao, actionType) and reuse its nonce so all guardians converge on the SAME
 * PDA and the M-of-N threshold can actually accumulate. Only if none exists do
 * we mint a fresh deterministic (time-bucketed) nonce for the first signer.
 * actionType: 0 = freeze, 1 = unfreeze.
 *
 * Retries the on-chain check a couple of times before concluding no open
 * action exists — a guardian who just submitted moments ago may not be
 * queryable yet (RPC/indexing lag), which would otherwise cause a second
 * guardian to wrongly mint a fresh nonce instead of reusing the first one.
 * This narrows, but does not eliminate, the documented window-boundary race;
 * when it does fall through to a fresh nonce, the caller is told so they can
 * coordinate manually rather than silently risking a split action.
 */
async function resolveGuardianNonce(
  daoPubkey: PublicKey,
  actionType: number,
): Promise<{ nonce: number; isNewAction: boolean }> {
  let existing: number | null = null;
  for (let attempt = 0; attempt < 3 && existing == null; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    existing = await resolveOpenGuardianActionNonce(daoPubkey, actionType);
  }
  if (existing != null) return { nonce: existing, isNewAction: false };
  return { nonce: coordinatedActionNonce(), isNewAction: true };
}

function EmergencyControls({ daoAddress, initialFrozen = false }: { daoAddress: string | null; initialFrozen?: boolean }) {
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { chainKind, evmChainId, chainFamily } = useChain();
  const tx = useSendTransaction();
  const [frozen, setFrozen] = useState(initialFrozen);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [evmBusy, setEvmBusy] = useState(false);
  const confirmedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Reflect the authoritative on-chain frozen state when it loads/changes.
  useEffect(() => {
    setFrozen(initialFrozen);
  }, [initialFrozen]);

  async function submitEvmFreeze(wantFreeze: boolean) {
    if (!daoAddress || !evmChainId || !evmAddress) {
      setFreezeError('Connect your EVM founder wallet on Ethereum or Base.');
      return;
    }
    if (!isTreasuryOpsFamily(chainFamily)) {
      setFreezeError('Select an Ethereum, Base, or Robinhood network.');
      return;
    }
    setEvmBusy(true);
    setFreezeError(null);
    try {
      const deadline = defaultGuardianActionDeadline();
      const nonce = BigInt(Math.floor(Date.now() / 1000));
      const { data, error } = await collectEvmGuardianFreezeSigs(
        daoAddress,
        evmAddress,
        (m) => signMessageAsync({ message: m }),
        wantFreeze,
        evmChainId,
        chainFamily,
        { nonce, deadline },
      );
      if (error || !data?.signatures?.length) {
        setFreezeError(error || 'No guardian signatures collected.');
        return;
      }
      const built = wantFreeze
        ? buildEmergencyFreezeEvm(evmChainId, daoAddress, BigInt(data.nonce), BigInt(data.deadline), data.signatures)
        : buildEmergencyUnfreezeEvm(evmChainId, daoAddress, BigInt(data.nonce), BigInt(data.deadline), data.signatures);
      if (!built.request) {
        setFreezeError(built.error || 'Failed to build freeze transaction.');
        return;
      }
      const result = await tx.sendEvm(built, {
        successLabel: wantFreeze ? 'Emergency freeze activated' : 'Treasury unfrozen',
        quietMock: true,
      });
      if (result.status === 'success' || result.status === 'mock') {
        setFrozen(wantFreeze);
        setConfirmed(wantFreeze);
        if (wantFreeze) confirmedTimer.current = setTimeout(() => setConfirmed(false), 3000);
      } else if (result.status === 'error') {
        setFreezeError(result.error);
      }
    } catch (err) {
      setFreezeError(err instanceof Error ? err.message : 'EVM freeze failed.');
    } finally {
      setEvmBusy(false);
    }
  }

  async function requestFreeze() {
    setFreezeError(null);
    if (chainKind === 'evm') {
      if (frozen) {
        await submitEvmFreeze(false);
        return;
      }
      setConfirming(true);
      return;
    }
    if (frozen) {
      // Unfreeze
      if (!publicKey || !daoAddress) {
        setFrozen(false);
        setConfirmed(false);
        return;
      }
      const daoPubkey = new PublicKey(daoAddress);
      const { nonce, isNewAction } = await resolveGuardianNonce(daoPubkey, 1);
      if (isNewAction) {
        toast({
          title: 'Starting a new emergency action',
          description:
            'No in-progress unfreeze action was found on-chain. If another guardian is acting at the same time, coordinate directly so your signatures land on the same action.',
        });
      }
      const result = await tx.send(await buildEmergencyUnfreeze(daoPubkey, publicKey, nonce), {
        successLabel: 'Treasury unfrozen',
        quietMock: true,
      });
      if (result.status === 'mock') {
        setFrozen(false);
        setConfirmed(false);
      } else if (result.status === 'success') {
        setFrozen(false);
        setConfirmed(false);
      } else if (result.status === 'error') {
        setFreezeError(result.error);
      }
      return;
    }
    setConfirming(true);
  }

  async function confirmFreeze() {
    setConfirming(false);
    setFreezeError(null);

    if (chainKind === 'evm') {
      await submitEvmFreeze(true);
      return;
    }

    if (!publicKey || !daoAddress) {
      // Mock fallback
      setFrozen(true);
      setConfirmed(true);
      confirmedTimer.current = setTimeout(() => setConfirmed(false), 3000);
      return;
    }

    const daoPubkey = new PublicKey(daoAddress);
    const { nonce, isNewAction } = await resolveGuardianNonce(daoPubkey, 0);
    if (isNewAction) {
      toast({
        title: 'Starting a new emergency action',
        description:
          'No in-progress freeze action was found on-chain. If another guardian is acting at the same time, coordinate directly so your signatures land on the same action.',
      });
    }
    const result = await tx.send(await buildEmergencyFreeze(daoPubkey, publicKey, nonce), {
      successLabel: 'Emergency freeze activated',
      quietMock: true,
    });

    if (result.status === 'mock') {
      setFrozen(true);
      setConfirmed(true);
      confirmedTimer.current = setTimeout(() => setConfirmed(false), 3000);
    } else if (result.status === 'success') {
      setFrozen(true);
      setConfirmed(true);
      confirmedTimer.current = setTimeout(() => setConfirmed(false), 3000);
    } else if (result.status === 'error') {
      setFreezeError(result.error);
    }
  }

  // EVM freeze collects custodied guardian EIP-712 sigs via evm-guardian-freeze.

  return (
    <CollapsibleSection title="Emergency Controls" subtitle="Override agent operations in critical situations">
      <div className="space-y-4">
        {/* Freeze — Solana incremental guardian signing, or EVM aggregated EIP-712 */}
        {(
        <div
          className="p-4 rounded-xl border"
          style={{
            backgroundColor: frozen ? 'hsl(var(--destructive-muted))' : 'hsl(var(--surface-1))',
            borderColor: frozen ? 'hsl(0 72% 80%)' : 'hsl(var(--border))',
          }}
        >
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
            <div className="flex items-center gap-3">
              <div>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: '600',
                    color: frozen ? 'hsl(var(--destructive))' : 'hsl(var(--foreground))',
                  }}
                >
                  {frozen ? 'Treasury Frozen' : 'Emergency Treasury Freeze'}
                </div>
                <div
                  style={{
                    fontSize: '12.5px',
                    color: frozen ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))',
                    marginTop: '2px',
                    opacity: 0.8,
                  }}
                >
                  {frozen
                    ? 'All agent operations are halted. Multisig required to resume.'
                    : chainKind === 'evm'
                      ? 'Collects custodied guardian EIP-712 signatures, then freezes in one transaction.'
                      : 'Immediately halt all agent operations. Requires multisig to resume.'}
                </div>
              </div>
            </div>
            <button
              onClick={requestFreeze}
              disabled={evmBusy}
              className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium flex-shrink-0 transition-all w-full sm:w-auto"
              style={{
                fontSize: '13px',
                backgroundColor: frozen ? 'hsl(var(--primary))' : 'hsl(var(--destructive-muted))',
                color: frozen ? 'hsl(var(--primary-foreground))' : 'hsl(var(--destructive))',
                border: frozen ? 'none' : '1px solid hsl(0 72% 80%)',
                opacity: evmBusy ? 0.6 : 1,
              }}
            >
              {evmBusy ? <Fi icon="spinner" style={{ fontSize: '13px' }} /> : frozen ? <Fi icon="lock-open" style={{ fontSize: '13px' }} /> : <Fi icon="lock" style={{ fontSize: '13px' }} />}
              {evmBusy ? 'Signing…' : frozen ? 'Unfreeze Treasury' : 'Freeze Treasury'}
            </button>
          </div>
        </div>
        )}

        {/* Confirm modal */}
        <AnimatePresence>
          {confirming && (
            <ConfirmFreezeModal onConfirm={confirmFreeze} onCancel={() => setConfirming(false)} />
          )}
        </AnimatePresence>

        {confirmed && (
          <div
            className="flex items-center gap-2 p-3 rounded-xl border animate-fade-in"
            style={{
              backgroundColor: 'hsl(var(--destructive-muted))',
              borderColor: 'hsl(0 72% 80%)',
            }}
          >
            <Fi icon="lock" style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }} />
            <span style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }}>
              Treasury freeze confirmed. Agent has been halted.
            </span>
          </div>
        )}

        {freezeError && (
          <div
            className="flex items-center gap-2 p-3 rounded-xl border animate-fade-in"
            style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }} />
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))', flex: 1 }}>{freezeError}</span>
            <button onClick={() => setFreezeError(null)} style={{ fontSize: '11px', color: 'hsl(var(--destructive))', textDecoration: 'underline' }}>dismiss</button>
          </div>
        )}

        {(tx.status === 'signing' || tx.status === 'confirming') && (
          <div
            className="flex items-center gap-2 p-3 rounded-xl border animate-fade-in"
            style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
          >
            <Fi icon="arrows-rotate" style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }} className="animate-spin" />
            <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
              {tx.status === 'signing' ? 'Waiting for wallet signature…' : 'Confirming transaction…'}
            </span>
          </div>
        )}

        {/* Transaction threshold */}
        <div
          className="p-4 rounded-xl border"
          style={{
            backgroundColor: 'hsl(var(--surface-1))',
            borderColor: 'hsl(var(--border))',
          }}
        >
          <div className="flex items-center justify-between">
            <div>
              <div style={{ fontSize: '13.5px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>
                Single-operation approval threshold
              </div>
              <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
                Operations above this value require multisig approval
              </div>
            </div>
            <div
              className="nave-mono font-semibold px-3 py-1.5 rounded-lg border"
              style={{
                fontSize: '14px',
                backgroundColor: 'hsl(var(--surface-0))',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            >
              $10,000
            </div>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
}

/* ── Confirm Freeze Modal (with Escape key) ──────────── */
function ConfirmFreezeModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return createPortal(
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      {...fadeOverlay}
    >
      <motion.div
        className="w-full max-w-sm rounded-2xl border shadow-xl p-6"
        style={{
          backgroundColor: 'hsl(var(--surface-0))',
          borderColor: 'hsl(0 72% 80%)',
          boxShadow: 'var(--shadow-xl)',
        }}
        {...scaleIn}
      >
        <div className="flex items-center gap-2 mb-3">
          <Fi icon="triangle-exclamation" style={{ fontSize: '16px', color: 'hsl(var(--destructive))' }} />
          <span className="text-display font-semibold" style={{ fontSize: '15px', color: 'hsl(var(--destructive))' }}>
            Confirm Emergency Freeze
          </span>
        </div>
        <p style={{ fontSize: '13.5px', lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', marginBottom: '16px' }}>
          This will immediately pause all agent operations. The treasury will remain
          intact but no new transactions will be executed until the multisig
          threshold approves resumption.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onConfirm}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium"
            style={{ fontSize: '13.5px', backgroundColor: 'hsl(var(--destructive))', color: 'white' }}
          >
            <Fi icon="lock" style={{ fontSize: '13px' }} />
            Confirm Freeze
          </button>
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-lg border"
            style={{ fontSize: '13.5px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/* ── Agent Admin Section ──────────────────────────────────── */

const AGENT_ROLES: { role: AgentRole; label: string; icon: string; desc: string }[] = [
  { role: 'executive', label: 'Executive', icon: 'crown', desc: 'Strategic coordinator — first approval' },
  { role: 'financial', label: 'Financial', icon: 'money-bill-wave', desc: 'Operations layer — second approval' },
  { role: 'oversight', label: 'Operational', icon: 'eye', desc: 'Safeguard layer — final approval' },
  { role: 'operational', label: 'Oversight', icon: 'gear', desc: 'Monitoring — does not sign' },
];

function sessionStatusMeta(status: string): { color: string; bg: string; label: string } {
  switch (status) {
    case 'active':
      return { color: 'hsl(var(--success))', bg: 'hsl(var(--success-muted))', label: 'Active' };
    case 'completed':
      return { color: 'hsl(var(--foreground))', bg: 'hsl(var(--surface-2))', label: 'Completed' };
    case 'failed':
      return { color: 'hsl(var(--destructive))', bg: 'hsl(var(--destructive-muted))', label: 'Failed' };
    case 'expired':
      return { color: 'hsl(var(--warning))', bg: 'hsl(var(--warning-muted))', label: 'Expired' };
    default:
      return { color: 'hsl(var(--muted-foreground))', bg: 'hsl(var(--surface-1))', label: status };
  }
}

function AgentAdminSection({ daoAddress, frozen }: { daoAddress: string | null; frozen: boolean }) {
  const { publicKey, signMessage } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { chainKind, evmChainId, chainFamily } = useChain();
  const health = useAgentHealth(daoAddress);
  const agentStatus = useAgentStatus(daoAddress);
  const sessions = useAgentSessions(daoAddress);
  const hasOnChain = agentStatus.onChainData !== null;

  // Single accurate status per role: on-chain enablement refined by activity.
  const roleStatuses = useMemo(
    () =>
      AGENT_ROLES.map(agent => {
        const onChainAgent = agentStatus.agents.find(a => a.role === agent.role) ?? null;
        const healthEntry = health.agents.find(a => a.role === agent.role) ?? null;
        const status = computeAgentStatus({
          agentsEnabled: agentStatus.agentsEnabled,
          frozen,
          hasOnChain,
          onChain: onChainAgent
            ? { active: onChainAgent.active, nullified: onChainAgent.nullified, status: onChainAgent.status }
            : null,
          health: healthEntry,
        });
        return { agent, healthEntry, status };
      }),
    [agentStatus.agents, agentStatus.agentsEnabled, health.agents, frozen, hasOnChain],
  );

  const systemSummary = useMemo(
    () => summarizeAgentStatuses(roleStatuses.map(r => r.status)),
    [roleStatuses],
  );
  const systemOperational = systemSummary.level === 'active';
  const [activeTab, setActiveTab] = useState<'status' | 'sessions' | 'dispatch'>('status');
  const [dispatchRole, setDispatchRole] = useState<AgentRole>('executive');
  const [dispatchExecReq, setDispatchExecReq] = useState('');
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<{ success: boolean; message: string } | null>(null);
  const [sessionFilter, setSessionFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');

  const filteredSessions = useMemo(() => {
    if (sessionFilter === 'all') return sessions.sessions;
    return sessions.sessions.filter(s => s.sessionStatus === sessionFilter);
  }, [sessions.sessions, sessionFilter]);

  async function handleDispatch() {
    if (!dispatchExecReq.trim()) return;
    if (!daoAddress) {
      setDispatchResult({ success: false, message: 'No DAO selected.' });
      return;
    }
    if (chainKind === 'evm') {
      if (!evmAddress || !evmChainId || (!isTreasuryOpsFamily(chainFamily))) {
        setDispatchResult({ success: false, message: 'Connect an Ethereum, Base, or Robinhood founder wallet.' });
        return;
      }
      const raw = dispatchExecReq.trim();
      const hashIdx = raw.includes('#') ? raw.split('#')[1] : raw;
      const index = Number(hashIdx);
      if (!Number.isFinite(index) || index < 0) {
        setDispatchResult({ success: false, message: 'Enter an EVM execution request index (e.g. 0 or 0xExec…#0).' });
        return;
      }
      setDispatchLoading(true);
      setDispatchResult(null);
      try {
        const { dispatchViaProxyEvm } = await import('../lib/edgeFunctionClient');
        const { data, error } = await dispatchViaProxyEvm(
          daoAddress,
          evmAddress,
          (m) => signMessageAsync({ message: m }),
          raw.includes('#') ? raw : String(index),
          evmChainId,
          chainFamily,
          index,
        );
        if (error || !data?.success) {
          setDispatchResult({ success: false, message: error || 'EVM dispatch failed.' });
        } else {
          setDispatchResult({
            success: true,
            message: `EVM orchestrator processed request #${index} (${data.execution_requests_processed ?? 0} step(s)).`,
          });
        }
      } catch (err) {
        setDispatchResult({ success: false, message: err instanceof Error ? err.message : 'Dispatch failed.' });
      } finally {
        setDispatchLoading(false);
      }
      return;
    }
    if (!publicKey || !signMessage) {
      setDispatchResult({ success: false, message: 'Connect a wallet that supports message signing.' });
      return;
    }
    setDispatchLoading(true);
    setDispatchResult(null);
    try {
      const { data, error } = await dispatchViaProxy(
        daoAddress,
        publicKey.toBase58(),
        signMessage,
        dispatchExecReq.trim(),
      );
      if (error || !data?.success) {
        setDispatchResult({ success: false, message: error || 'Dispatch failed.' });
      } else {
        const processed = data.execution_requests_processed ?? 0;
        setDispatchResult({
          success: true,
          message: `Orchestrator ran for ${dispatchExecReq.slice(0, 8)}…${dispatchExecReq.slice(-4)} — ${processed} request(s) processed${data.errors?.length ? `, ${data.errors.length} error(s)` : ''}.`,
        });
      }
    } catch (err) {
      setDispatchResult({ success: false, message: err instanceof Error ? err.message : 'Dispatch failed.' });
    } finally {
      setDispatchLoading(false);
    }
  }

  const tabs: { key: typeof activeTab; label: string; icon: string }[] = [
    { key: 'status', label: 'Status', icon: 'signal' },
    { key: 'sessions', label: 'Activity', icon: 'clock-rotate-left' },
    { key: 'dispatch', label: 'Advanced', icon: 'sliders' },
  ];

  return (
    <CollapsibleSection
      title="Agent Administration"
      subtitle={`${systemOperational ? 'System healthy' : systemSummary.label} · ${sessions.activeSessions.length} active session${sessions.activeSessions.length !== 1 ? 's' : ''}`}
    >
      <div className="space-y-4">
        {/* Tab bar */}
        <div
          className="flex gap-0.5 p-0.5 rounded-lg"
          style={{ backgroundColor: 'hsl(var(--surface-1))' }}
        >
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="flex items-center justify-center gap-1.5 flex-1 py-2 rounded-md transition-all"
              style={{
                fontSize: '12.5px',
                fontWeight: activeTab === tab.key ? '500' : '400',
                backgroundColor: activeTab === tab.key ? 'hsl(var(--surface-0))' : 'transparent',
                color: activeTab === tab.key ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                boxShadow: activeTab === tab.key ? 'var(--shadow-xs)' : 'none',
              }}
            >
              <Fi icon={tab.icon} style={{ fontSize: '11px' }} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Tab: Agent Status ─────────────────────────── */}
        {activeTab === 'status' && (
          <div className="space-y-3">
            {roleStatuses.map(({ agent, healthEntry: agentHealth, status }) => {
              const color = status.color;

              return (
                <div
                  key={agent.role}
                  className="flex items-center gap-4 p-4 rounded-xl border transition-colors"
                  style={{
                    backgroundColor: 'hsl(var(--surface-1))',
                    borderColor: 'hsl(var(--border))',
                  }}
                >
                  {/* Icon + status dot */}
                  <div className="relative flex-shrink-0">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: 'hsl(var(--surface-2))' }}
                    >
                      <Fi icon={agent.icon} style={{ fontSize: '16px', color: 'hsl(var(--foreground))' }} />
                    </div>
                    <div
                      className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2"
                      style={{
                        backgroundColor: color,
                        borderColor: 'hsl(var(--surface-1))',
                      }}
                    />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span style={{ fontSize: '13.5px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>
                        {agent.label} Agent
                      </span>
                      <span
                        className="px-1.5 py-0.5 rounded-full"
                        style={{
                          fontSize: '10px',
                          fontFamily: 'var(--font-mono)',
                          color,
                          backgroundColor: status.bg,
                          letterSpacing: '0.04em',
                        }}
                      >
                        {status.label}
                      </span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
                      {agent.desc}
                    </p>
                  </div>

                  {/* Metrics */}
                  <div className="hidden sm:flex items-center gap-5 flex-shrink-0">
                    <div className="text-right">
                      <div className="nave-label" style={{ fontSize: '9px' }}>24h Ops</div>
                      <div className="nave-mono" style={{ fontSize: '13px', color: 'hsl(var(--foreground))', marginTop: '1px' }}>
                        {agentHealth?.actions_24h ?? 0}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="nave-label" style={{ fontSize: '9px' }}>Errors</div>
                      <div
                        className="nave-mono"
                        style={{
                          fontSize: '13px',
                          color: (agentHealth?.errors_24h ?? 0) > 0 ? 'hsl(var(--destructive))' : 'hsl(var(--foreground))',
                          marginTop: '1px',
                        }}
                      >
                        {agentHealth?.errors_24h ?? 0}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="nave-label" style={{ fontSize: '9px' }}>Last Action</div>
                      <div
                        className="nave-mono"
                        style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '1px' }}
                      >
                        {agentHealth ? timeAgo(agentHealth.last_action_at) : 'Never'}
                      </div>
                    </div>
                    {agentHealth?.last_confidence !== null && agentHealth?.last_confidence !== undefined && (
                      <div className="text-right">
                        <div className="nave-label" style={{ fontSize: '9px' }}>Confidence</div>
                        <div
                          className="nave-mono"
                          style={{
                            fontSize: '13px',
                            color: (agentHealth.last_confidence ?? 0) >= 80
                              ? 'hsl(var(--success))'
                              : (agentHealth.last_confidence ?? 0) >= 60
                                ? 'hsl(var(--warning))'
                                : 'hsl(var(--destructive))',
                            marginTop: '1px',
                          }}
                        >
                          {agentHealth.last_confidence}%
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* System health summary */}
            <div
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border"
              style={{
                backgroundColor: systemOperational ? 'hsl(var(--success-muted))' : 'hsl(var(--warning-muted))',
                borderColor: systemOperational ? 'hsl(152 50% 82%)' : 'hsl(38 92% 75%)',
              }}
            >
              <Fi
                icon={systemOperational ? 'shield-check' : 'triangle-exclamation'}
                style={{ fontSize: '12px', color: systemOperational ? 'hsl(var(--success))' : 'hsl(var(--warning))' }}
              />
              <span style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>
                {systemOperational
                  ? 'All agents operating within normal parameters'
                  : systemSummary.label}
              </span>
              <span
                className="ml-auto nave-mono"
                style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}
              >
                {health.checkedAt ? `Checked ${timeAgo(health.checkedAt)}` : ''}
              </span>
            </div>
          </div>
        )}

        {/* ── Tab: Session History ──────────────────────── */}
        {activeTab === 'sessions' && (
          <div className="space-y-3">
            {/* Filter bar */}
            <div className="flex items-center gap-2">
              {(['all', 'active', 'completed', 'failed'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setSessionFilter(f)}
                  className="px-2.5 py-1 rounded-md transition-all"
                  style={{
                    fontSize: '11.5px',
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.02em',
                    backgroundColor: sessionFilter === f ? 'hsl(var(--primary))' : 'hsl(var(--surface-1))',
                    color: sessionFilter === f ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                    border: sessionFilter === f ? 'none' : '1px solid hsl(var(--border))',
                  }}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                  {f === 'active' && sessions.activeSessions.length > 0 && (
                    <span
                      className="ml-1 px-1 rounded-full"
                      style={{ backgroundColor: 'hsl(var(--success))', color: 'white', fontSize: '9px', padding: '0 4px' }}
                    >
                      {sessions.activeSessions.length}
                    </span>
                  )}
                </button>
              ))}
              <button
                onClick={sessions.refetch}
                className="ml-auto p-1.5 rounded-md transition-colors"
                style={{ color: 'hsl(var(--muted-foreground))' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Fi icon="arrows-rotate" style={{ fontSize: '11px' }} />
              </button>
            </div>

            {/* Session list */}
            {sessions.loading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-14 rounded-xl animate-pulse" style={{ backgroundColor: 'hsl(var(--surface-1))' }} />
                ))}
              </div>
            ) : filteredSessions.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center py-8"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              >
                <Fi icon="clock-rotate-left" style={{ fontSize: '24px', opacity: 0.4, marginBottom: '8px' }} />
                <span style={{ fontSize: '13px' }}>
                  {sessionFilter === 'all' ? 'No agent sessions recorded' : `No ${sessionFilter} sessions`}
                </span>
              </div>
            ) : (
              <div className="space-y-1.5">
                {filteredSessions.map((session: AgentSession) => {
                  const meta = sessionStatusMeta(session.sessionStatus);
                  const roleInfo = AGENT_ROLES.find(a => a.role === session.agentRole);
                  const duration = session.completedAt
                    ? Math.round((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 1000)
                    : null;

                  return (
                    <div
                      key={session.id}
                      className="flex items-center gap-3 px-4 py-3 rounded-xl border"
                      style={{
                        backgroundColor: 'hsl(var(--surface-1))',
                        borderColor: session.sessionStatus === 'failed' ? 'hsl(0 72% 90%)' : 'hsl(var(--border))',
                      }}
                    >
                      {/* Role icon */}
                      <div
                        className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
                      >
                        <Fi icon={roleInfo?.icon || 'robot'} style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }} />
                      </div>

                      {/* Session info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span style={{ fontSize: '12.5px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>
                            {roleInfo?.label || agentRoleLabel(session.agentRole)}
                          </span>
                          <span
                            className="px-1.5 py-0.5 rounded-full"
                            style={{
                              fontSize: '9.5px',
                              fontFamily: 'var(--font-mono)',
                              color: meta.color,
                              backgroundColor: meta.bg,
                            }}
                          >
                            {meta.label}
                          </span>
                          {duration !== null && (
                            <span
                              className="nave-mono"
                              style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))' }}
                            >
                              {duration}s
                            </span>
                          )}
                        </div>
                        <div
                          className="mt-0.5 flex items-center gap-2"
                          style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}
                        >
                          <span>
                            {session.executionRequestAddress.slice(0, 6)}…{session.executionRequestAddress.slice(-4)}
                          </span>
                          <span>·</span>
                          <span>
                            {new Date(session.startedAt).toLocaleString(undefined, {
                              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                            })}
                          </span>
                        </div>
                        {session.errorMessage && (
                          <p
                            className="mt-1"
                            style={{ fontSize: '11px', color: 'hsl(var(--destructive))', lineHeight: 1.4 }}
                          >
                            {session.errorMessage}
                          </p>
                        )}
                      </div>

                      {/* Active indicator */}
                      {session.sessionStatus === 'active' && (
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: 'hsl(var(--success))' }} />
                          <span className="nave-mono" style={{ fontSize: '10px', color: 'hsl(var(--success))' }}>Processing</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Session stats footer */}
            {sessions.sessions.length > 0 && (
              <div
                className="flex items-center justify-between px-3 pt-2 border-t"
                style={{ borderColor: 'hsl(var(--border))' }}
              >
                <span className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
                  {sessions.sessions.length} total session{sessions.sessions.length !== 1 ? 's' : ''}
                </span>
                <div className="flex items-center gap-3 nave-mono" style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))' }}>
                  <span style={{ color: 'hsl(var(--success))' }}>
                    {sessions.sessions.filter(s => s.sessionStatus === 'completed').length} completed
                  </span>
                  <span style={{ color: 'hsl(var(--destructive))' }}>
                    {sessions.sessions.filter(s => s.sessionStatus === 'failed').length} failed
                  </span>
                  <span style={{ color: 'hsl(var(--warning))' }}>
                    {sessions.sessions.filter(s => s.sessionStatus === 'expired').length} expired
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Manual Dispatch ──────────────────────── */}
        {activeTab === 'dispatch' && (
          <div className="space-y-4">
            <div
              className="flex items-start gap-2 p-3 rounded-xl border"
              style={{
                backgroundColor: 'hsl(var(--warning-muted))',
                borderColor: 'hsl(38 92% 75%)',
              }}
            >
              <Fi icon="triangle-exclamation" style={{ fontSize: '12px', color: 'hsl(var(--warning))', marginTop: '2px', flexShrink: 0 }} />
              <p style={{ fontSize: '12.5px', color: 'hsl(38 60% 25%)', lineHeight: 1.5 }}>
                Agents run on their own. Use this only if a run got stuck and support asked you to retry it.
              </p>
            </div>

            {/* Agent role selector */}
            <div>
              <label className="nave-label" style={{ fontSize: '10px', marginBottom: '8px', display: 'block' }}>
                Agent Role
              </label>
              <div className="flex gap-2">
                {AGENT_ROLES.map(agent => (
                  <button
                    key={agent.role}
                    onClick={() => setDispatchRole(agent.role)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-all"
                    style={{
                      fontSize: '12.5px',
                      backgroundColor: dispatchRole === agent.role ? 'hsl(var(--primary))' : 'hsl(var(--surface-1))',
                      borderColor: dispatchRole === agent.role ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                      color: dispatchRole === agent.role ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                    }}
                  >
                    <Fi icon={agent.icon} style={{ fontSize: '11px' }} />
                    {agent.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Execution request address */}
            <div>
              <label className="nave-label" style={{ fontSize: '10px', marginBottom: '6px', display: 'block' }}>
                Execution Request Address
              </label>
              <input
                type="text"
                value={dispatchExecReq}
                onChange={e => setDispatchExecReq(e.target.value)}
                placeholder={chainKind === 'evm' ? 'Request number (e.g. 0)' : 'Request id from support'}
                className="w-full px-3 py-2.5 rounded-lg border transition-colors"
                style={{
                  fontSize: '13px',
                  fontFamily: 'var(--font-mono)',
                  backgroundColor: 'hsl(var(--surface-1))',
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--foreground))',
                  outline: 'none',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--primary))')}
                onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
              />
            </div>

            {/* Dispatch button */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleDispatch}
                disabled={dispatchLoading || !dispatchExecReq.trim()}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-all"
                style={{
                  fontSize: '13.5px',
                  backgroundColor: dispatchLoading || !dispatchExecReq.trim()
                    ? 'hsl(var(--surface-2))'
                    : 'hsl(var(--primary))',
                  color: dispatchLoading || !dispatchExecReq.trim()
                    ? 'hsl(var(--muted-foreground))'
                    : 'hsl(var(--primary-foreground))',
                  opacity: dispatchLoading ? 0.7 : 1,
                  cursor: dispatchLoading || !dispatchExecReq.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {dispatchLoading ? (
                  <Fi icon="arrows-rotate" style={{ fontSize: '13px' }} className="animate-spin" />
                ) : (
                  <Fi icon="paper-plane" style={{ fontSize: '13px' }} />
                )}
                {dispatchLoading ? 'Dispatching…' : 'Dispatch Agent'}
              </button>
              <span
                className="nave-mono"
                style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
              >
                {dispatchRole} → {dispatchExecReq ? `${dispatchExecReq.slice(0, 8)}…` : 'no target'}
              </span>
            </div>

            {/* Result feedback */}
            {dispatchResult && (
              <div
                className="flex items-center gap-2 p-3 rounded-xl border animate-fade-in"
                style={{
                  backgroundColor: dispatchResult.success ? 'hsl(var(--success-muted))' : 'hsl(var(--destructive-muted))',
                  borderColor: dispatchResult.success ? 'hsl(152 50% 82%)' : 'hsl(0 72% 80%)',
                }}
              >
                <Fi
                  icon={dispatchResult.success ? 'circle-check' : 'circle-xmark'}
                  style={{
                    fontSize: '13px',
                    color: dispatchResult.success ? 'hsl(var(--success))' : 'hsl(var(--destructive))',
                  }}
                />
                <span style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>
                  {dispatchResult.message}
                </span>
                <button
                  onClick={() => setDispatchResult(null)}
                  className="ml-auto"
                  style={{ fontSize: '10px', color: 'hsl(var(--muted-foreground))', textDecoration: 'underline' }}
                >
                  dismiss
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

function PrivacyAccessSection({
  daoAddress,
  governanceType,
  privacyEnabled,
  onRefetch,
}: {
  daoAddress: string | null;
  governanceType: 'wallet' | 'token';
  privacyEnabled: boolean;
  onRefetch: () => void;
}) {
  const { publicKey, signMessage } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const { address: evmAddress } = useAccount();
  const tx = useSendTransaction();
  const [target, setTarget] = useState(privacyEnabled);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTarget(privacyEnabled);
  }, [privacyEnabled]);

  async function savePrivacy() {
    if (!daoAddress) return;
    if (chainKind === 'evm') {
      if (!evmChainId) {
        setError('Select an Ethereum or Base network.');
        return;
      }
      if (!evmAddress) {
        setError('Connect your Ethereum/Base wallet to update DAO privacy.');
        return;
      }
      setSaving(true);
      setError(null);
      setDone(false);
      const result = await tx.sendEvm(
        buildSetDaoPrivacyEvm(evmChainId, daoAddress, target ? 2 : 0),
        { successLabel: 'Privacy mode updated', quietMock: true },
      );
      setSaving(false);
      if (result.status === 'success' || result.status === 'mock') {
        setDone(true);
        onRefetch();
        window.setTimeout(() => setDone(false), 2200);
      } else if (result.status === 'error') {
        setError(result.error);
      }
      return;
    }
    if (!publicKey || !signMessage) {
      setError('Connect a wallet with message-signing support to update DAO privacy.');
      return;
    }
    setSaving(true);
    setError(null);
    setDone(false);
    const { data, error: saveError } = await updateDaoPrivacy(
      daoAddress,
      publicKey.toBase58(),
      signMessage,
      target,
    );
    setSaving(false);
    if (saveError || !data?.success) {
      setError(saveError || 'Failed to update privacy mode.');
      return;
    }
    setDone(true);
    onRefetch();
    window.setTimeout(() => setDone(false), 2200);
  }

  return (
    <CollapsibleSection
      title="DAO Privacy Access"
      subtitle={target ? 'Private membership checks enabled' : 'Public join enabled'}
    >
      <div className="space-y-4">
        <div
          className="flex items-start gap-2 p-3 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Fi icon="circle-info" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', flexShrink: 0 }} />
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            When privacy is on, people cannot add this treasury from the lobby unless they are already allowed in
            {governanceType === 'wallet' ? ' as a trusted wallet' : ' by holding the voting token'}.
          </p>
        </div>

        <div
          className="flex items-center justify-between px-4 py-3 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <div>
            <div style={{ fontSize: '13.5px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>
              Privacy mode
            </div>
            <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: 2 }}>
              {target ? 'Enabled: gated membership access' : 'Disabled: public discoverability'}
            </div>
          </div>
          <Toggle value={target} onChange={setTarget} />
        </div>

        {error && (
          <div
            className="flex items-center gap-2 p-3 rounded-xl border"
            style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }} />
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))' }}>{error}</span>
          </div>
        )}

        <button
          onClick={savePrivacy}
          disabled={saving || target === privacyEnabled}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
          style={{
            fontSize: '13px',
            backgroundColor: done ? 'hsl(var(--accent))' : 'hsl(var(--primary))',
            color: 'hsl(var(--primary-foreground))',
            opacity: saving || target === privacyEnabled ? 0.6 : 1,
            cursor: saving || target === privacyEnabled ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? (
            <Fi icon="arrows-rotate" style={{ fontSize: '13px' }} className="animate-spin" />
          ) : done ? (
            <Fi icon="check" style={{ fontSize: '13px' }} />
          ) : (
            <Fi icon="lock" style={{ fontSize: '13px' }} />
          )}
          {saving ? 'Saving privacy mode…' : done ? 'Privacy mode updated' : target === privacyEnabled ? 'No changes' : 'Save privacy mode'}
        </button>
      </div>
    </CollapsibleSection>
  );
}

/* ── Audit log (live) ───────────────────────────────────────── */
const AUDIT_PAGE_SIZE = 10;

function getAuditExplorerUrl(
  hash: string,
  isEvmDao: boolean,
  evmChainId?: number,
): { url: string; label: string } {
  if (!isEvmDao) {
    return { url: `https://solscan.io/tx/${hash}`, label: 'Solscan' };
  }
  // Chain-id driven (Etherscan / Basescan / Robinhood Blockscout); Ethereum fallback.
  return evmExplorerUrl(evmChainId, 'tx', hash) ?? { url: `https://etherscan.io/tx/${hash}`, label: 'Etherscan' };
}

/**
 * activity_logs.tx_signature is a per-event dedup key: `${sig}:${eventIndex}`
 * (Solana) or `${txHash}:${logIndex}` (EVM). Strip the suffix to get the
 * explorer-linkable hash. Synthetic entries (e.g. `recon:…` reconciliation
 * alerts) have no on-chain tx and return undefined.
 */
function explorerHashFromDedupKey(dedupKey: string | undefined): string | undefined {
  if (!dedupKey) return undefined;
  const hash = dedupKey.split(':')[0];
  // Solana sigs are base58 (64 bytes → ~87 chars); EVM hashes are 0x + 64 hex.
  if (/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,88})$/.test(hash)) return hash;
  return undefined;
}

function deriveAuditStatus(eventType: string): AuditEntry['status'] {
  const t = eventType.toLowerCase();
  if (t.includes('fail') || t.includes('error') || t.includes('revert') || t.includes('cancelled')) {
    return 'failed';
  }
  if (t.includes('pending') || t.includes('queued') || t.includes('created')) {
    return 'pending';
  }
  return 'success';
}

function AuditLog({ daoAddress }: { daoAddress: string | null }) {
  const { activities, loading } = useActivityLog(daoAddress);
  const { evmChainId } = useChain();
  const { dao } = useDaoRegistry(daoAddress);
  const explorerChainId = dao?.chainId ?? evmChainId ?? undefined;
  const [page, setPage] = useState(0);

  const entries: AuditEntry[] = activities.map((a) => ({
    id: a.id,
    action: a.description,
    actor: a.agentRole || a.actor || a.eventType,
    time: a.blockTime ? new Date(a.blockTime).toLocaleString() : new Date(a.createdAt).toLocaleString(),
    status: deriveAuditStatus(a.eventType),
    hash: explorerHashFromDedupKey(a.txSignature),
  }));

  const totalPages = Math.ceil(entries.length / AUDIT_PAGE_SIZE);
  const pageEntries = entries.slice(page * AUDIT_PAGE_SIZE, (page + 1) * AUDIT_PAGE_SIZE);

  return (
    <CollapsibleSection
      title="Audit Log"
      subtitle="Indexed activity feed of recorded treasury operations"
      collapsible={false}
      defaultOpen
    >
      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <Fi icon="clock-rotate-left" style={{ fontSize: '22px', opacity: 0.4, marginBottom: '8px' }} />
          <span style={{ fontSize: '13px' }}>{loading ? 'Loading activity…' : 'No on-chain activity recorded yet'}</span>
        </div>
      ) : (
        <>
          <div className="space-y-0">
            {pageEntries.map((entry, idx) => {
              const dotColor = statusColor(entry.status);
              const explorerUrl = entry.hash
                ? getAuditExplorerUrl(entry.hash, isEvmAddress(daoAddress), explorerChainId)
                : null;
              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 py-3"
                  style={{
                    borderBottom:
                      idx < pageEntries.length - 1
                        ? '1px solid hsl(var(--border))'
                        : 'none',
                  }}
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0"
                    style={{ backgroundColor: dotColor }}
                  />
                  <div className="flex-1 min-w-0">
                    <p style={{ fontSize: '13px', color: 'hsl(var(--foreground))', lineHeight: 1.5 }}>
                      {entry.action}
                    </p>
                    <div
                      className="flex items-center gap-3 mt-1 flex-wrap"
                      style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}
                    >
                      <span>{entry.actor}</span>
                      <span>·</span>
                      <span>{entry.time}</span>
                      {entry.hash && explorerUrl && (
                        <>
                          <span>·</span>
                          <a
                            href={explorerUrl.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: 'hsl(var(--foreground))',
                              textDecoration: 'underline',
                              textUnderlineOffset: '2px',
                              opacity: 0.7,
                              fontFamily: 'var(--font-mono)',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                            onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
                          >
                            {explorerUrl.label}: {entry.hash}
                            <Fi icon="arrow-up-right" style={{ fontSize: '9px', marginLeft: '3px', display: 'inline' }} />
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className="flex-shrink-0 px-2 py-0.5 rounded-md border"
                    style={{
                      fontSize: '10.5px',
                      fontFamily: 'var(--font-mono)',
                      ...(() => {
                        const m = statusBg(entry.status);
                        return { backgroundColor: m.bg, borderColor: m.border, color: m.color };
                      })(),
                    }}
                  >
                    {entry.status}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div
              className="flex items-center justify-between pt-4 mt-2 border-t"
              style={{ borderColor: 'hsl(var(--border))' }}
            >
              <span style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
                {page * AUDIT_PAGE_SIZE + 1}–{Math.min((page + 1) * AUDIT_PAGE_SIZE, entries.length)} of {entries.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="flex items-center justify-center w-7 h-7 rounded-lg border transition-colors"
                  style={{
                    borderColor: 'hsl(var(--border))',
                    color: page === 0 ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
                    opacity: page === 0 ? 0.4 : 1,
                  }}
                  onMouseEnter={e => { if (page > 0) e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))'; }}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                >
                  <Fi icon="chevron-left" style={{ fontSize: '11px' }} />
                </button>
                {Array.from({ length: totalPages }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setPage(i)}
                    className="flex items-center justify-center w-7 h-7 rounded-lg border transition-colors"
                    style={{
                      fontSize: '11.5px',
                      fontFamily: 'var(--font-mono)',
                      borderColor: i === page ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                      backgroundColor: i === page ? 'hsl(var(--foreground))' : 'transparent',
                      color: i === page ? 'hsl(var(--background))' : 'hsl(var(--foreground))',
                    }}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page === totalPages - 1}
                  className="flex items-center justify-center w-7 h-7 rounded-lg border transition-colors"
                  style={{
                    borderColor: 'hsl(var(--border))',
                    color: page === totalPages - 1 ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
                    opacity: page === totalPages - 1 ? 0.4 : 1,
                  }}
                  onMouseEnter={e => { if (page < totalPages - 1) e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))'; }}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                >
                  <Fi icon="chevron-right" style={{ fontSize: '11px' }} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}

/* ── Voting System section ───────────────────────────────── */
function VotingSystemSection({
  daoAddress,
  governanceType,
  votingMint,
}: {
  daoAddress: string | null;
  governanceType: 'wallet' | 'token';
  guardians: GuardianInfo[];
  threshold: number;
  votingMint: string | null;
}) {
  const navigate = useNavigate();
  const { publicKey } = useWallet();
  const { chainKind } = useChain();
  const { address: evmAddress } = useAccount();
  const [target, setTarget] = useState<'wallet' | 'token'>(governanceType === 'token' ? 'wallet' : 'token');
  const [error, setError] = useState<string | null>(null);

  function handleProposeSwitch() {
    setError(null);
    if (!daoAddress || (chainKind === 'evm' ? !evmAddress : !publicKey)) {
      setError('Connect your wallet to propose a voting system change.');
      return;
    }
    const toTokenGov = target === 'token';
    if (toTokenGov && !votingMint) {
      setError('Register a governance token first — token governance requires exactly one voting token.');
      return;
    }

    let payload: number[];
    if (chainKind === 'evm') {
      try {
        payload = encodeEvmSwitchVotingPayload({
          governanceType: toTokenGov ? 1 : 0,
          votingToken: (toTokenGov && votingMint ? votingMint : '0x0000000000000000000000000000000000000000') as `0x${string}`,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to encode EVM voting payload.');
        return;
      }
    } else {
      // Payload: [governance_type (1 byte)] + [voting_token_or_zero (32 bytes)] = 33 bytes
      const solanaPayload = new Uint8Array(33);
      solanaPayload[0] = toTokenGov ? 1 : 0;
      if (toTokenGov && votingMint) {
        try { solanaPayload.set(new PublicKey(votingMint).toBytes(), 1); } catch { /* ignore */ }
      }
      payload = Array.from(solanaPayload);
    }

    const targetLabel = toTokenGov ? 'Token-Weighted' : 'Authorized-Wallet';
    navigate('/governance', {
      state: {
        proposeSwitchVoting: {
          title: `Voting System Change — Switch to ${targetLabel} Governance`,
          description:
            `Proposal to switch the DAO's governance model from ` +
            `${toTokenGov ? 'authorized-wallet' : 'token-weighted'} voting to ` +
            `${toTokenGov ? 'token-weighted' : 'authorized-wallet'} voting.\n\n` +
            (toTokenGov
              ? `Under token governance, voting weight is proportional to token holdings. ` +
                `Quorum is measured against the total token supply.\n\n` +
                `Voting token: ${votingMint?.slice(0, 8)}…\n\n`
              : `Under wallet governance, each authorized guardian wallet has equal voting weight.\n\n`) +
            `This is a high-impact, irreversible change. It requires a ${SWITCH_VOTING_QUORUM_PCT}% quorum to pass. ` +
            `Once approved, the founder applies the change on-chain from the Settings → Voting System page.`,
          payload,
        },
      },
    });
  }

  const busy = false;

  return (
    <CollapsibleSection
      title="Voting System"
      subtitle={governanceType === 'token' ? 'Token-weighted governance' : 'Authorized-wallet governance'}
    >
      <div className="space-y-4">
        <div
          className="flex items-start gap-2 p-3 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Fi icon="circle-info" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', flexShrink: 0 }} />
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            This DAO currently uses <strong>{governanceType === 'token' ? 'token-weighted voting' : 'authorized-wallet voting'}</strong>.
            Switching the voting system is a high-impact change and requires a {SWITCH_VOTING_QUORUM_PCT}% quorum to approve.
            Token governance allows exactly one voting token.
          </p>
        </div>

        <div>
          <div className="nave-label mb-2">Switch to</div>
          <div className="flex gap-2">
            {(['wallet', 'token'] as const).map(t => {
              const sel = target === t;
              return (
                <button
                  key={t}
                  onClick={() => setTarget(t)}
                  className="flex-1 py-2.5 rounded-lg border text-center transition-all"
                  style={{
                    fontSize: '13px',
                    fontWeight: sel ? 600 : 400,
                    backgroundColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--surface-0))',
                    borderColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                    color: sel ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                  }}
                >
                  {t === 'wallet' ? 'Authorized Wallets' : 'Token-weighted'}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div
            className="flex items-center gap-2 p-3 rounded-xl border"
            style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }} />
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))', flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ fontSize: '11px', color: 'hsl(var(--destructive))', textDecoration: 'underline' }}>dismiss</button>
          </div>
        )}

        <button
          onClick={handleProposeSwitch}
          disabled={busy || target === governanceType}
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg font-medium transition-all"
          style={{
            fontSize: '13px',
            backgroundColor: 'hsl(var(--primary))',
            color: 'hsl(var(--primary-foreground))',
            opacity: busy || target === governanceType ? 0.6 : 1,
            cursor: busy || target === governanceType ? 'not-allowed' : 'pointer',
          }}
        >
          <Fi icon="lightbulb" style={{ fontSize: '13px' }} />
          {target === governanceType ? 'Already active' : `Propose switch to ${target === 'token' ? 'token-weighted' : 'authorized-wallet'} voting`}
        </button>
        <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', textAlign: 'center', marginTop: '4px', lineHeight: 1.4 }}>
          This creates a governance proposal requiring {SWITCH_VOTING_QUORUM_PCT}% quorum. Once passed, apply it here.
        </p>
      </div>
    </CollapsibleSection>
  );
}

/* ── Review window section ───────────────────────────────── */
// Bounds mirror the on-chain review-window clamp. Mainnet EVM stays at a 1-hour
// floor; testnet and devnet accept 60 seconds. Reductions on EVM are still
// delayed via pendingReviewWindow. Saving here never rewrites a window the
// founder did not choose.
const REVIEW_WINDOW_MAX_SECS = MAX_REVIEW_WINDOW_SECONDS;

function ReviewWindowCustomHours({
  target,
  setTarget,
  minSecs,
  maxSecs,
}: {
  target: number;
  setTarget: (secs: number) => void;
  minSecs: number;
  maxSecs: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 mb-2"
        style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
        Advanced — custom hours
      </button>
      {open && (
        <input
          type="number"
          min={minSecs / 3600}
          max={maxSecs / 3600}
          step="0.25"
          value={Number((target / 3600).toFixed(2))}
          onChange={(e) => {
            const hours = parseFloat(e.target.value);
            if (!Number.isNaN(hours)) setTarget(Math.round(hours * 3600));
          }}
          className="w-full px-3 py-2.5 rounded-lg border"
          style={{
            fontSize: '13px',
            backgroundColor: 'hsl(var(--surface-0))',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
        />
      )}
    </div>
  );
}

function formatDuration(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400} day${secs / 86400 === 1 ? '' : 's'}`;
  if (secs % 3600 === 0) return `${secs / 3600} hour${secs / 3600 === 1 ? '' : 's'}`;
  if (secs % 60 === 0) return `${secs / 60} min`;
  return `${secs}s`;
}

function ReviewWindowSection({ daoAddress }: { daoAddress: string | null }) {
  const { publicKey } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const { constitution, refetch } = useConstitution(daoAddress);
  const delayCtx = actionDelayContextFrom({
    chainKind,
    evmChainId,
    solanaNetwork: SOLANA_NETWORK,
    evmDeploymentMode: EVM_DEPLOYMENT_MODE,
  });
  const reviewPresets = reviewWindowPresets(delayCtx);
  const current = constitution?.reviewWindowSecs ?? defaultReviewWindowFallback(delayCtx);
  const [target, setTarget] = useState<number>(current);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pendingEvm, setPendingEvm] = useState<PendingReviewWindowEvm | null>(null);
  const REVIEW_WINDOW_MIN_SECS = reviewWindowMinSeconds(chainKind, delayCtx);

  useEffect(() => {
    setTarget(current);
  }, [current]);

  // EVM: reductions are queued until the current window elapses — surface the
  // pending value so the founder isn't confused by an unchanged getter.
  useEffect(() => {
    let cancelled = false;
    if (chainKind !== 'evm' || !evmChainId || !daoAddress || isMockDaoAddress(daoAddress)) {
      setPendingEvm(null);
      return;
    }
    fetchPendingReviewWindowEvm(evmChainId, daoAddress)
      .then((p) => { if (!cancelled) setPendingEvm(p); })
      .catch(() => { if (!cancelled) setPendingEvm(null); });
    return () => { cancelled = true; };
  }, [chainKind, evmChainId, daoAddress, current, done]);

  async function handleSave() {
    setError(null);
    setDone(false);
    if (target < REVIEW_WINDOW_MIN_SECS || target > REVIEW_WINDOW_MAX_SECS) {
      setError(`Review window must be between ${formatDuration(REVIEW_WINDOW_MIN_SECS)} and ${formatDuration(REVIEW_WINDOW_MAX_SECS)}.`);
      return;
    }
    // ── EVM: NaveTreasury.setReviewWindow(int64 secs) (founder-gated) ──
    if (chainKind === 'evm') {
      if (!daoAddress) { setError('Select a treasury before updating the review window.'); return; }
      if (!evmChainId) { setError('Select an Ethereum or Base network.'); return; }
      const evmResult = await tx.sendEvm(
        buildSetReviewWindowEvm(evmChainId, daoAddress, target),
        { successLabel: 'Review window updated', quietMock: true },
      );
      if (evmResult.status === 'success' || evmResult.status === 'mock') {
        setDone(true);
        refetch();
      } else if (evmResult.status === 'error') {
        setError(evmResult.error);
      }
      return;
    }
    if (!publicKey || !daoAddress) {
      setError('Connect your wallet to update the review window.');
      return;
    }

    try {
      const result = await tx.send(
        await buildSetReviewWindow(new PublicKey(daoAddress), publicKey, target),
        { successLabel: 'Review window updated', quietMock: true },
      );
      if (result.status === 'success' || result.status === 'mock') {
        setDone(true);
        refetch();
      } else if (result.status === 'error') {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update review window.');
    }
  }

  const busy = tx.status === 'signing' || tx.status === 'confirming';

  return (
    <CollapsibleSection
      title="Oversight Review Window"
      subtitle={`Currently ${formatDuration(current)} before approved strategies can execute`}
    >
      <div className="space-y-4">
        <div
          className="flex items-start gap-2 p-3 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Fi icon="circle-info" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', flexShrink: 0 }} />
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            After agents approve a strategy, this pause lets your trusted wallets stop it before it runs.
            {chainKind === 'evm' && ' Shortening the pause takes effect only after the current window ends.'}
          </p>
        </div>

        {pendingEvm && (
          <div
            className="flex items-start gap-2 p-3 rounded-xl border"
            style={{ backgroundColor: 'hsl(var(--warning) / 0.08)', borderColor: 'hsl(var(--warning) / 0.4)' }}
          >
            <Fi icon="hourglass-half" style={{ fontSize: '12px', color: 'hsl(var(--warning))', marginTop: '2px', flexShrink: 0 }} />
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))', lineHeight: 1.5 }}>
              Pending change: the review window will become <strong>{formatDuration(pendingEvm.secs)}</strong>
              {pendingEvm.effectiveAt > 0 && ` on ${new Date(pendingEvm.effectiveAt * 1000).toLocaleString()}`}.
              Until then, {formatDuration(current)} still applies.
            </p>
          </div>
        )}

        <div>
          <div className="nave-label mb-2">Set window to</div>
          <div className="flex flex-wrap gap-2">
            {reviewPresets.map(p => {
              const sel = target === p.secs;
              return (
                <button
                  key={p.secs}
                  onClick={() => setTarget(p.secs)}
                  className="px-3 py-2 rounded-lg border text-center transition-all"
                  style={{
                    fontSize: '13px',
                    fontWeight: sel ? 600 : 400,
                    backgroundColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--surface-0))',
                    borderColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                    color: sel ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <ReviewWindowCustomHours
          target={target}
          setTarget={setTarget}
          minSecs={REVIEW_WINDOW_MIN_SECS}
          maxSecs={REVIEW_WINDOW_MAX_SECS}
        />

        {error && (
          <div
            className="flex items-center gap-2 p-3 rounded-xl border"
            style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }} />
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))', flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ fontSize: '11px', color: 'hsl(var(--destructive))', textDecoration: 'underline' }}>dismiss</button>
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={busy || target === current}
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg font-medium transition-all"
          style={{
            fontSize: '13px',
            backgroundColor: done ? 'hsl(var(--accent))' : 'hsl(var(--primary))',
            color: 'hsl(var(--primary-foreground))',
            opacity: busy || target === current ? 0.6 : 1,
            cursor: busy || target === current ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? (
            <Fi icon="arrows-rotate" style={{ fontSize: '13px' }} className="animate-spin" />
          ) : done ? (
            <Fi icon="check" style={{ fontSize: '13px' }} />
          ) : (
            <Fi icon="hourglass-half" style={{ fontSize: '13px' }} />
          )}
          {busy ? 'Submitting…' : done ? 'Review Window Updated' : target === current ? 'No change' : `Set to ${formatDuration(target)}`}
        </button>
      </div>
    </CollapsibleSection>
  );
}

/* ── Moonlight Section ───────────────────────────────────── */
const MOONLIGHT_REQUEST_TYPE = 9;
const MOONLIGHT_DISTRIBUTION_TYPE = 10;
const ZERO_PUBKEY = '11111111111111111111111111111111';

function nonZeroMoonlightKey(k: string | null | undefined): string | null {
  return k && k !== ZERO_PUBKEY ? k : null;
}

interface MoonlightLifecycle {
  exists: boolean;
  status: number;
  initiatedBy: string | null;
  recipient: string | null;
  requestProposal: string | null;
  distributionProposal: string | null;
}

interface MoonlightStake {
  exists: boolean;
  lockedAmount: bigint;
  status: number;
  naveMint: string | null;
}

const MOONLIGHT_STATUS_LABELS = ['Active', 'Moonlight requested', 'Distribution pending', 'Distributing', 'Moonlighted'] as const;

function MoonlightStageBadge({ status }: { status: number }) {
  const tones = ['primary', 'accent', 'accent', 'accent', 'destructive'] as const;
  const tone = tones[status] ?? 'muted-foreground';
  return (
    <span
      className="px-2.5 py-1 rounded-full font-medium"
      style={{ fontSize: '11px', backgroundColor: `hsl(var(--${tone}))`, color: 'white' }}
    >
      {MOONLIGHT_STATUS_LABELS[status] ?? 'Unknown'}
    </span>
  );
}

/**
 * Founder/operator unwind of an executed EVM strategy request.
 * Prefers in-wallet Executive `sendEvm`; otherwise founder challenge →
 * `evm-strategy-withdraw` → signer `/relay-evm` (custodied Executive).
 */
function EvmStrategyWithdrawSection({
  daoAddress,
  proposalCount,
}: {
  daoAddress: string;
  proposalCount: number;
}) {
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { evmChainId, chainFamily } = useChain();
  const tx = useSendTransaction();
  const pipeline = useExecutionPipeline(daoAddress, proposalCount);
  const [index, setIndex] = useState('');
  const [amount, setAmount] = useState('');
  const [decimals, setDecimals] = useState('6');
  const [minOutQuote, setMinOutQuote] = useState('');
  const [busy, setBusy] = useState(false);

  const executed = useMemo(
    () => pipeline.completedExecutions.filter((e) => e.status === ExecutionStatus.Executed && e.amount > 0),
    [pipeline.completedExecutions],
  );

  async function handleWithdraw() {
    if (!evmAddress || !evmChainId || (!isTreasuryOpsFamily(chainFamily))) {
      toast({ variant: 'destructive', title: 'Connect founder wallet', description: 'Ethereum, Base, or Robinhood wallet required.' });
      return;
    }
    const idx = Number(index);
    if (!Number.isFinite(idx) || idx < 0) {
      toast({ variant: 'destructive', title: 'Invalid request index' });
      return;
    }
    let amountBase: bigint;
    try {
      amountBase = parseUnits(amount.trim() || '0', Number(decimals) || 6);
    } catch {
      toast({ variant: 'destructive', title: 'Invalid amount' });
      return;
    }
    if (amountBase <= 0n) {
      toast({ variant: 'destructive', title: 'Amount must be positive' });
      return;
    }

    let minOut: bigint;
    try {
      const quoted = minOutQuote.trim() ? BigInt(minOutQuote.trim()) : undefined;
      minOut = resolveEvmMinOut(evmChainId as EvmChainId, quoted);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'minOut required',
        description: err instanceof Error ? err.message : 'Provide a positive off-chain quote on mainnet.',
      });
      return;
    }

    setBusy(true);
    try {
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio?.execution) {
        toast({ variant: 'destructive', title: 'Execution contract unresolved' });
        return;
      }

      // Try direct Executive wallet first (quiet — most founders are not the EOA).
      const built = buildWithdrawFromStrategyEvm(evmChainId, trio.execution, idx, amountBase, minOut);
      const direct = await tx.sendEvm(built, { successLabel: `Strategy withdraw #${idx}`, quietToast: true });
      if (direct.status === 'success') {
        toast({ title: 'Strategy withdraw submitted' });
        pipeline.refetch();
        return;
      }

      const { data, error } = await withdrawStrategyViaProxyEvm(
        daoAddress,
        evmAddress,
        (m) => signMessageAsync({ message: m }),
        {
          chainId: evmChainId,
          chain: chainFamily,
          executionAddress: trio.execution,
          index: idx,
          amount: amountBase.toString(),
          minOut: minOut.toString(),
        },
      );
      if (error || !data?.success) {
        toast({
          variant: 'destructive',
          title: 'Withdraw failed',
          description: error || direct.error || 'Executive relay rejected the withdraw.',
        });
        return;
      }
      toast({ title: 'Strategy withdraw submitted', description: data.tx_hash ? `Tx ${data.tx_hash.slice(0, 10)}…` : undefined });
      pipeline.refetch();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Withdraw failed',
        description: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setBusy(false);
    }
  }

  if (chainKindFromAddress(daoAddress) !== 'evm') return null;

  return (
    <CollapsibleSection title="Strategy withdraw" defaultOpen={false}>
      <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))', marginBottom: 12, lineHeight: 1.55 }}>
        Unwind an executed strategy request. On mainnet, set a positive minOut (underlying base units) from an off-chain quote.
        Uses the Executive agent (connected wallet or custodied relay).
      </p>
      {executed.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {executed.slice(0, 8).map((e) => (
            <button
              key={e.proposal}
              type="button"
              onClick={() => setIndex(e.proposal)}
              className="w-full text-left px-2.5 py-1.5 rounded-md border text-xs"
              style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            >
              #{e.proposal} · {e.protocolName} · amount {e.amount}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <label className="text-xs space-y-1">
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>Request index</span>
          <input value={index} onChange={(e) => setIndex(e.target.value)} className="w-full px-2 py-1.5 rounded-md border text-sm" style={{ borderColor: 'hsl(var(--border))' }} placeholder="0" />
        </label>
        <label className="text-xs space-y-1">
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>Token decimals</span>
          <input value={decimals} onChange={(e) => setDecimals(e.target.value)} className="w-full px-2 py-1.5 rounded-md border text-sm" style={{ borderColor: 'hsl(var(--border))' }} />
        </label>
        <label className="text-xs space-y-1 col-span-2">
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>Amount (human)</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full px-2 py-1.5 rounded-md border text-sm" style={{ borderColor: 'hsl(var(--border))' }} placeholder="100.0" />
        </label>
        <label className="text-xs space-y-1 col-span-2">
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>minOut quote (base units, required on mainnet)</span>
          <input value={minOutQuote} onChange={(e) => setMinOutQuote(e.target.value)} className="w-full px-2 py-1.5 rounded-md border text-sm" style={{ borderColor: 'hsl(var(--border))' }} placeholder="0 on testnet" />
        </label>
      </div>
      <button
        type="button"
        disabled={busy || tx.status === 'signing'}
        onClick={() => void handleWithdraw()}
        className="px-3 py-2 rounded-lg border text-xs font-medium"
        style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', opacity: busy ? 0.6 : 1 }}
      >
        {busy ? 'Submitting…' : 'Withdraw from strategy'}
      </button>
    </CollapsibleSection>
  );
}

/** EVM moonlighting wizard over NaveDaoStake (mirrors Solana lifecycle stages). */
function EvmMoonlightSection({ daoAddress }: { daoAddress: string }) {
  const navigate = useNavigate();
  const { isFounder } = useDaoMembership();
  const { address: evmAddress } = useAccount();
  const { evmChainId, chainFamily } = useChain();
  const { dao } = useDaoRegistry(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const tx = useSendTransaction();
  const votingTokenCandidate =
    dao?.governanceType === 'token'
      ? (tokenRegistry.tokens[0]?.mint ?? null)
      : null;
  const resolvedVotingMint: Address = (
    votingTokenCandidate && /^0x[0-9a-fA-F]{40}$/.test(votingTokenCandidate)
      ? votingTokenCandidate
      : `0x${'0'.repeat(40)}`
  ) as Address;
  const [status, setStatus] = useState(0);
  const [stakeAmount, setStakeAmount] = useState(0n);
  const [recipient, setRecipient] = useState('');
  const [requestIdx, setRequestIdx] = useState('');
  const [distIdx, setDistIdx] = useState('');
  const [module, setModule] = useState<string | null>(null);
  const [governor, setGovernor] = useState<string | null>(null);
  const [stakeToken, setStakeToken] = useState<string | null>(null);
  const [requiredStake, setRequiredStake] = useState(0n);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!evmChainId) return;
    try {
      const [cfg, stake, trio] = await Promise.all([
        fetchNaveStakeConfigEvm(evmChainId),
        fetchMoonlightStakeEvm(evmChainId, daoAddress),
        fetchDaoContracts(evmChainId, daoAddress),
      ]);
      setModule(cfg?.module ?? null);
      setStakeToken(cfg?.token ?? null);
      setRequiredStake(cfg?.amount ?? 0n);
      setGovernor(trio?.governor ?? null);
      if (stake) {
        setStatus(stake.moonlightStatus);
        setStakeAmount(stake.amount);
        if (stake.recipient && stake.recipient !== `0x${'0'.repeat(40)}`) {
          setRecipient(stake.recipient);
        }
      } else {
        setStatus(0);
        setStakeAmount(0n);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load moonlight state');
    }
  }, [daoAddress, evmChainId]);

  useEffect(() => { void load(); }, [load]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  if (!evmChainId || (!isTreasuryOpsFamily(chainFamily))) {
    return (
      <div className="nave-card p-5">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>Connect Ethereum, Base, or Robinhood to manage moonlighting.</p>
      </div>
    );
  }

  if (!module) {
    return (
      <div className="nave-card p-5">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
          The moonlight module is not configured on this chain yet.
          An existing locked stake cannot be returned until it is set. New treasuries do not lock NAVE.
        </p>
      </div>
    );
  }

  if (!isFounder) {
    return (
      <div className="nave-card p-5">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
          Only the founder wallet on this chain can moonlight this treasury.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="nave-card p-5" style={{ backgroundColor: 'hsl(var(--surface-0))' }}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <Fi icon="moon" style={{ fontSize: '16px', color: 'hsl(var(--primary))' }} />
            <span className="text-display font-semibold" style={{ fontSize: '15px' }}>Moonlight DAO</span>
          </div>
          <MoonlightStageBadge status={status} />
        </div>
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
          EVM wind-down via NaveDaoStake: create a MoonlightRequest proposal, record it, set a recipient,
          pass a MoonlightDistribution proposal, execute stake release, then finalize. Deposit and new
          strategy requests are blocked on-chain while moonlighting.
        </p>
        {stakeAmount > 0n && (
          <div className="flex items-center justify-between mt-3 pt-3 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
            <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>Locked wNAVE stake</span>
            <span className="nave-mono" style={{ fontSize: '13px', fontWeight: 600 }}>{stakeAmount.toString()} base units</span>
          </div>
        )}
      </div>
      {error && <div className="px-4 py-3 rounded-xl" style={{ backgroundColor: 'hsl(var(--destructive-muted))', fontSize: '12.5px', color: 'hsl(var(--destructive))' }}>{error}</div>}
      {notice && <div className="px-4 py-3 rounded-xl" style={{ backgroundColor: 'hsl(var(--surface-1))', fontSize: '12.5px' }}>{notice}</div>}

      {status === 0 && (
        <button
          type="button"
          disabled={!!busy}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{ backgroundColor: 'hsl(var(--primary))', color: 'white' }}
          onClick={() => void run('begin', async () => {
            if (!governor) throw new Error('Governor not resolved');
            const built = buildCreateProposalEvm(evmChainId, governor, {
              title: 'Moonlight request',
              description: `Wind down ${dao?.name ?? 'this DAO'}`,
              payload: '0x' as `0x${string}`,
              proposalType: 9,
              votingPeriodSeconds: votingPeriodForNetwork(MAINNET_DEFAULT_VOTING_PERIOD_SECONDS, { kind: 'evm', chainId: evmChainId }),
              votingMint: resolvedVotingMint,
            });
            const outcome = await tx.sendEvm(built, { successLabel: 'Moonlight request created' });
            if (outcome.status === 'error') throw new Error(outcome.error ?? 'Proposal failed');
            setNotice('Vote on the MoonlightRequest in Governance, then record it below.');
            navigate('/governance');
          })}
        >
          {busy === 'begin' ? 'Submitting…' : 'Begin Moonlighting'}
        </button>
      )}

      {status === 0 && (
        <div className="nave-card p-4 space-y-2">
          <label style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>Passed MoonlightRequest proposal index</label>
          <input className="w-full px-3 py-2 rounded-lg border text-sm" value={requestIdx} onChange={(e) => setRequestIdx(e.target.value)} placeholder="e.g. 0" />
          <button
            type="button"
            disabled={!!busy}
            className="px-3 py-2 rounded-lg text-sm"
            style={{ backgroundColor: 'hsl(var(--surface-1))' }}
            onClick={() => void run('record', async () => {
              if (!governor || !module) throw new Error('Module/governor missing');
              const idx = Number(requestIdx);
              if (!Number.isFinite(idx)) throw new Error('Enter proposal index');
              const built = buildRecordMoonlightRequestEvm(evmChainId, module, daoAddress, governor, idx);
              const outcome = await tx.sendEvm(built, { successLabel: 'Moonlight request recorded' });
              if (outcome.status === 'error') throw new Error(outcome.error ?? 'Record failed');
              setNotice('Moonlight recorded — deposits and new strategies are blocked on-chain.');
            })}
          >
            Record moonlight request
          </button>
        </div>
      )}

      {(status === 1 || status === 2) && (
        <div className="nave-card p-4 space-y-2">
          <label style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>Distribution recipient (0x…)</label>
          <input className="w-full px-3 py-2 rounded-lg border text-sm nave-mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
          {status === 1 && (
            <button
              type="button"
              disabled={!!busy}
              className="px-3 py-2 rounded-lg text-sm"
              onClick={() => void run('recipient', async () => {
                if (!module) throw new Error('Module missing');
                const built = buildSetMoonlightRecipientEvm(evmChainId, module, daoAddress, recipient);
                const outcome = await tx.sendEvm(built, { successLabel: 'Recipient set' });
                if (outcome.status === 'error') throw new Error(outcome.error ?? 'Set recipient failed');
                if (!governor) throw new Error('Governor missing');
                const payload = encodeAbiParameters([{ type: 'address' }], [recipient as Address]);
                const prop = buildCreateProposalEvm(evmChainId, governor, {
                  title: 'Moonlight distribution',
                  description: `Distribute stake to ${recipient}`,
                  payload,
                  proposalType: 10,
                  votingPeriodSeconds: votingPeriodForNetwork(MAINNET_DEFAULT_VOTING_PERIOD_SECONDS, { kind: 'evm', chainId: evmChainId }),
                  votingMint: resolvedVotingMint,
                });
                await tx.sendEvm(prop, { successLabel: 'Distribution proposal created' });
                setNotice('Vote on the MoonlightDistribution proposal, then execute below.');
                navigate('/governance');
              })}
            >
              Set recipient + create distribution proposal
            </button>
          )}
          {status === 2 && (
            <>
              <input className="w-full px-3 py-2 rounded-lg border text-sm" value={distIdx} onChange={(e) => setDistIdx(e.target.value)} placeholder="Passed distribution proposal index" />
              <button
                type="button"
                disabled={!!busy}
                className="px-3 py-2 rounded-lg text-sm"
                onClick={() => void run('execute', async () => {
                  if (!module || !governor) throw new Error('Module/governor missing');
                  const idx = Number(distIdx);
                  if (!Number.isFinite(idx)) throw new Error('Enter proposal index');
                  const built = buildExecuteMoonlightDistributionEvm(evmChainId, module, daoAddress, governor, idx);
                  const outcome = await tx.sendEvm(built, { successLabel: 'Stake released' });
                  if (outcome.status === 'error') throw new Error(outcome.error ?? 'Execute failed');
                  setNotice('Stake released. Transfer remaining ERC-20/NFT assets via Governance, then finalize.');
                })}
              >
                Execute distribution
              </button>
            </>
          )}
        </div>
      )}

      {status === 3 && (
        <button
          type="button"
          disabled={!!busy}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          onClick={() => void run('finalize', async () => {
            if (!module) throw new Error('Module missing');
            const built = buildFinalizeMoonlightEvm(evmChainId, module, daoAddress);
            const outcome = await tx.sendEvm(built, { successLabel: 'DAO moonlighted' });
            if (outcome.status === 'error') throw new Error(outcome.error ?? 'Finalize failed');
            setNotice('DAO moonlighted. The founder can reopen it without a new stake.');
          })}
        >
          Finalize moonlight
        </button>
      )}

      {status === 4 && stakeToken && (
        <button
          type="button"
          disabled={!!busy || !evmAddress}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          onClick={() => void run('restore', async () => {
            if (!module || !stakeToken) throw new Error('Module/token missing');
            const amount = requiredStake > 0n ? requiredStake : stakeAmount;
            if (amount === 0n) throw new Error('No stake amount configured');
            const approve = buildApproveErc20Evm(evmChainId, stakeToken, module, amount);
            const restore = buildRestoreDaoEvm(evmChainId, module, daoAddress, amount, 0n);
            const outcome = await tx.sendEvm([approve, restore], { successLabel: 'DAO restored' });
            if (outcome.status === 'error') throw new Error(outcome.error ?? 'Restore failed');
            setNotice('DAO restored to Active. Re-enable agents explicitly if needed.');
          })}
        >
          Restake & restore DAO
        </button>
      )}
    </div>
  );
}

function MoonlightSection({ daoAddress }: { daoAddress: string }) {
  const navigate = useNavigate();
  const { publicKey } = useWallet();
  const { dao } = useDaoRegistry(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const tx = useSendTransaction();

  const walletStr = publicKey?.toBase58() ?? null;
  const isSolanaDao = chainKindFromAddress(daoAddress) === 'solana';
  const founder = (dao as { onChainData?: { founder?: string }; creatorWallet?: string } | null)?.onChainData?.founder ?? dao?.creatorWallet ?? null;
  const isFounder = !!walletStr && !!founder && founder === walletStr;
  const isTokenGov = dao?.governanceType === 'token';

  const [lifecycle, setLifecycle] = useState<MoonlightLifecycle | null>(null);
  const [stake, setStake] = useState<MoonlightStake | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Dialog states
  const [showConfirmBegin, setShowConfirmBegin] = useState(false);
  const [showRecordDialog, setShowRecordDialog] = useState(false);
  const [showDistDialog, setShowDistDialog] = useState(false);
  const [requestProposalIdx, setRequestProposalIdx] = useState('');
  const [recipient, setRecipient] = useState('');
  const [distProposalIdx, setDistProposalIdx] = useState('');

  const status = lifecycle?.status ?? 0;
  const isDriver = !!walletStr && !!lifecycle?.initiatedBy && lifecycle.initiatedBy === walletStr;
  const nextProposalIndex =
    typeof dao?.nextProposalIndex === 'number'
      ? dao.nextProposalIndex
      : (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);

  const loadState = useCallback(async () => {
    if (!daoAddress || !isSolanaDao) return;
    setLoading(true);
    try {
      const { core } = getNavePrograms();
      const daoPubkey = new PublicKey(daoAddress);
      const [lcPda] = getDaoLifecyclePDA(daoPubkey);
      const [lockPda] = getDaoStakeLockPDA(daoPubkey);
      const [lc, lock] = await Promise.all([
        core.account.daoLifecycle.fetchNullable(lcPda),
        core.account.daoStakeLock.fetchNullable(lockPda),
      ]);
      setLifecycle(
        lc
          ? {
              exists: true,
              status: Number(lc.status),
              initiatedBy: nonZeroMoonlightKey((lc.initiatedBy as PublicKey).toBase58()),
              recipient: nonZeroMoonlightKey((lc.recipient as PublicKey).toBase58()),
              requestProposal: nonZeroMoonlightKey((lc.requestProposal as PublicKey).toBase58()),
              distributionProposal: nonZeroMoonlightKey((lc.distributionProposal as PublicKey).toBase58()),
            }
          : { exists: false, status: 0, initiatedBy: null, recipient: null, requestProposal: null, distributionProposal: null },
      );
      setStake(
        lock
          ? {
              exists: true,
              lockedAmount: BigInt((lock.lockedAmount as { toString: () => string }).toString()),
              status: Number(lock.status),
              naveMint: (lock.naveMint as PublicKey).toBase58(),
            }
          : { exists: false, lockedAmount: 0n, status: 0, naveMint: null },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load moonlight state');
    } finally {
      setLoading(false);
    }
  }, [daoAddress, isSolanaDao]);

  useEffect(() => { void loadState(); }, [loadState]);

  async function resolveDaoTokenMint(daoPubkey: PublicKey): Promise<PublicKey> {
    if (isTokenGov && tokenRegistry.tokens[0]?.mint) return new PublicKey(tokenRegistry.tokens[0].mint);
    const vault = await fetchTreasuryVault(daoPubkey);
    if (!vault?.vaultTokenAccount) throw new Error('Treasury vault is not initialized for this DAO yet.');
    const { core } = getNavePrograms();
    const acct = await getAccount(core.provider.connection, new PublicKey(vault.vaultTokenAccount));
    return acct.mint;
  }

  function resetMessages() { setError(null); setNotice(null); }

  async function run(label: string, fn: () => Promise<void>) {
    resetMessages();
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
      void loadState();
    }
  }

  function handleCreateRequestProposal() {
    void run('create-request', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      const daoPubkey = new PublicKey(daoAddress);
      const daoTokenMint = await resolveDaoTokenMint(daoPubkey);
      const result = await buildCreateProposal(
        daoPubkey, nextProposalIndex, publicKey,
        { title: 'Moonlight request', description: `Approve winding down ${dao?.name ?? 'this DAO'} (moonlight). Passing halts agents and unlocks the distribution wizard for the proposal creator.`, payload: [], proposalType: MOONLIGHT_REQUEST_TYPE, votingPeriodSeconds: votingPeriodForNetwork(MAINNET_MOONLIGHT_VOTING_PERIOD_SECONDS, { kind: 'solana', network: SOLANA_NETWORK }) },
        daoTokenMint,
      );
      const outcome = await tx.send(result, { successLabel: 'Moonlight request proposal created', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Proposal creation failed');
      setNotice(`Moonlight request proposal #${nextProposalIndex + 1} created. Vote on it in Governance — once it passes, record it below.`);
      setShowConfirmBegin(false);
      navigate('/governance');
    });
  }

  function handleRecordRequest() {
    void run('record', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      const idx = Number.parseInt(requestProposalIdx.replace(/^#?p?/i, ''), 10);
      if (!Number.isFinite(idx) || idx < 1) throw new Error('Enter the passed request proposal number (e.g. 3).');
      const daoPubkey = new PublicKey(daoAddress);
      const [requestProposal] = getProposalPDA(daoPubkey, idx - 1);
      const result = await buildRecordMoonlightRequest(daoPubkey, publicKey, requestProposal);
      const outcome = await tx.send(result, { successLabel: 'Moonlight request recorded', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Recording failed');
      setNotice('Moonlight request recorded. Agents are halted. Continue the wind-down below.');
      setShowRecordDialog(false);
      setRequestProposalIdx('');
    });
  }

  function handleSetDistributionAndProposal() {
    void run('set-dist', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      let recipientKey: PublicKey;
      try { recipientKey = new PublicKey(recipient.trim()); }
      catch { throw new Error('Enter a valid recipient wallet address.'); }
      const daoPubkey = new PublicKey(daoAddress);
      const setResult = await buildSetMoonlightDistribution(daoPubkey, publicKey, recipientKey);
      const setOutcome = await tx.send(setResult, { successLabel: 'Recipient set', quietMock: true });
      if (setOutcome.status === 'error') throw new Error(setOutcome.error ?? 'Set recipient failed');
      const daoTokenMint = await resolveDaoTokenMint(daoPubkey);
      const payload = Array.from(recipientKey.toBytes());
      const propResult = await buildCreateProposal(
        daoPubkey, nextProposalIndex, publicKey,
        { title: 'Moonlight distribution', description: `Approve distributing all assets and the staked NAVE of ${dao?.name ?? 'this DAO'} to ${recipient.trim()}.`, payload, proposalType: MOONLIGHT_DISTRIBUTION_TYPE, votingPeriodSeconds: votingPeriodForNetwork(MAINNET_MOONLIGHT_VOTING_PERIOD_SECONDS, { kind: 'solana', network: SOLANA_NETWORK }) },
        daoTokenMint,
      );
      const propOutcome = await tx.send(propResult, { successLabel: 'Distribution proposal created', quietMock: true });
      if (propOutcome.status === 'error') throw new Error(propOutcome.error ?? 'Distribution proposal failed');
      setNotice(`Distribution proposal #${nextProposalIndex + 1} created. Vote on it in Governance — once it passes, execute the distribution below.`);
      setShowDistDialog(false);
      setRecipient('');
      navigate('/governance');
    });
  }

  function handleExecuteDistribution() {
    void run('execute', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      const recipientStr = lifecycle?.recipient;
      if (!recipientStr) throw new Error('No approved recipient on record.');
      const idx = Number.parseInt(distProposalIdx.replace(/^#?p?/i, ''), 10);
      if (!Number.isFinite(idx) || idx < 1) throw new Error('Enter the passed distribution proposal number.');
      const daoPubkey = new PublicKey(daoAddress);
      const [distributionProposal] = getProposalPDA(daoPubkey, idx - 1);
      const naveMint = stake?.naveMint ? new PublicKey(stake.naveMint) : SOLANA_NAVE_MINT;
      const result = await buildExecuteMoonlightDistribution(daoPubkey, publicKey, naveMint, new PublicKey(recipientStr), distributionProposal);
      const outcome = await tx.send(result, { successLabel: 'Distribution executed', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Execution failed');
      setNotice('Distribution executed. Any locked NAVE stake has been released. Distribute remaining SOL/SPL assets via Governance, then finalize.');
    });
  }

  function handleFinalize() {
    void run('finalize', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      const daoPubkey = new PublicKey(daoAddress);
      const result = await buildFinalizeMoonlight(daoPubkey, publicKey);
      const outcome = await tx.send(result, { successLabel: 'DAO moonlighted', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Finalize failed');
      setNotice('DAO moonlighted — it is now hidden from participants. Only the founder can reopen it, and reopening does not require a new stake.');
    });
  }

  function handleRestore() {
    void run('restore', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      if (!isFounder) throw new Error('Only the founder can reopen this DAO.');
      const daoPubkey = new PublicKey(daoAddress);
      const result = await buildRestoreDao(daoPubkey, publicKey);
      const outcome = await tx.send(result, { successLabel: 'DAO restored', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Restore failed');
      setNotice('DAO restored to Active. Reopening did not move NAVE. Re-enable agents explicitly if needed.');
    });
  }

  if (!isSolanaDao) {
    return <EvmMoonlightSection daoAddress={daoAddress} />;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="nave-card p-5" style={{ backgroundColor: 'hsl(var(--surface-0))' }}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <Fi icon="moon" style={{ fontSize: '16px', color: 'hsl(var(--primary))' }} />
            <span className="text-display font-semibold" style={{ fontSize: '15px' }}>Moonlight DAO</span>
          </div>
          {lifecycle && <MoonlightStageBadge status={status} />}
        </div>
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
          Wind a DAO down through governance: an approved request halts agents, then assets are distributed to an approved recipient. An existing locked NAVE stake, if this treasury has one, is returned with that distribution. New treasuries have nothing to return. The DAO stays hidden until the founder reopens it, which does not require a new stake.
        </p>
        {stake?.exists && stake.status !== 1 && (
          <div className="flex items-center justify-between mt-3 pt-3 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
            <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>Existing locked NAVE</span>
            <span className="nave-mono" style={{ fontSize: '13px', fontWeight: 600 }}>
              {naveBaseUnitsToUi(stake.lockedAmount.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 })} NAVE
            </span>
          </div>
        )}
      </div>

      {/* Error / notice banners */}
      {error && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl border" style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}>
          <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))', flexShrink: 0, marginTop: '2px' }} />
          <span style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))' }}>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl border" style={{ backgroundColor: 'hsl(var(--accent-muted))', borderColor: 'hsl(var(--border-strong))' }}>
          <Fi icon="circle-check" style={{ fontSize: '13px', color: 'hsl(var(--accent))', flexShrink: 0, marginTop: '2px' }} />
          <span style={{ fontSize: '12.5px', color: 'hsl(var(--accent-muted-foreground))' }}>{notice}</span>
        </div>
      )}

      {loading && !lifecycle && (
        <div className="nave-card p-4" style={{ backgroundColor: 'hsl(var(--surface-0))' }}>
          <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>Loading moonlight state…</span>
        </div>
      )}

      {/* Stage 0 — Active */}
      {status === 0 && (
        <div className="nave-card p-5 space-y-3" style={{ backgroundColor: 'hsl(var(--surface-0))' }}>
          <button
            onClick={() => setShowConfirmBegin(true)}
            disabled={!walletStr || !!busy}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold w-full transition-all"
            style={{
              fontSize: '13.5px',
              backgroundColor: !walletStr || !!busy ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
              color: !walletStr || !!busy ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
              cursor: !walletStr || !!busy ? 'not-allowed' : 'pointer',
            }}
          >
            <Fi icon={busy === 'create-request' ? 'spinner' : 'moon'} style={{ fontSize: '12px' }} className={busy === 'create-request' ? 'animate-spin' : ''} />
            {busy === 'create-request' ? 'Submitting…' : 'Begin Moonlighting'}
          </button>

          {isFounder && (
            <div className="pt-3 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
              <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginBottom: '8px' }}>
                Already voted? If the request proposal passed, record it to start the wind-down.
              </p>
              <button
                onClick={() => setShowRecordDialog(true)}
                className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium w-full"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border-strong))', cursor: 'pointer' }}
              >
                <Fi icon="lock" style={{ fontSize: '11px' }} />
                Record Approved Request
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stage 1 — Moonlight Requested: set distribution */}
      {status === 1 && (
        <div className="nave-card p-5 space-y-3" style={{ backgroundColor: 'hsl(var(--surface-0))' }}>
          <div className="flex items-start gap-2.5 p-3 rounded-lg" style={{ backgroundColor: 'hsl(var(--warning-muted))' }}>
            <Fi icon="triangle-exclamation" style={{ fontSize: '13px', color: 'hsl(38 60% 35%)', flexShrink: 0, marginTop: '2px' }} />
            <p style={{ fontSize: '12.5px', color: 'hsl(38 60% 35%)', lineHeight: 1.55 }}>
              Before moonlighting, withdraw all assets from treasury via Governance transfer proposals, then set the distribution recipient below.
            </p>
          </div>
          {isDriver ? (
            <button
              onClick={() => setShowDistDialog(true)}
              disabled={!!busy}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold w-full transition-all"
              style={{
                fontSize: '13.5px',
                backgroundColor: !!busy ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
                color: !!busy ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
                cursor: !!busy ? 'not-allowed' : 'pointer',
              }}
            >
              <Fi icon="arrow-right" style={{ fontSize: '12px' }} />
              Set Distribution Wallet &amp; Create Proposal
            </button>
          ) : (
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
              Waiting on the proposal creator{lifecycle?.initiatedBy ? ` (${lifecycle.initiatedBy.slice(0, 4)}…${lifecycle.initiatedBy.slice(-4)})` : ''} to set the recipient.
            </p>
          )}
        </div>
      )}

      {/* Stage 2 — Distribution pending: execute */}
      {status === 2 && (
        <div className="nave-card p-5 space-y-3" style={{ backgroundColor: 'hsl(var(--surface-0))' }}>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
            <span style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>Approved recipient</span>
            <span className="nave-mono" style={{ fontSize: '12px' }}>
              {lifecycle?.recipient ? `${lifecycle.recipient.slice(0, 6)}…${lifecycle.recipient.slice(-6)}` : '—'}
            </span>
          </div>
          {isDriver && (
            <div className="space-y-2">
              <input
                value={distProposalIdx}
                onChange={(e) => setDistProposalIdx(e.target.value)}
                placeholder="Passed distribution proposal # (e.g. 4)"
                className="w-full px-3 py-2.5 rounded-lg border outline-none"
                style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
              />
              <button
                onClick={handleExecuteDistribution}
                disabled={!!busy || !distProposalIdx.trim()}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold w-full"
                style={{
                  fontSize: '13.5px',
                  backgroundColor: !!busy || !distProposalIdx.trim() ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
                  color: !!busy || !distProposalIdx.trim() ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
                  cursor: !!busy || !distProposalIdx.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                <Fi icon={busy === 'execute' ? 'spinner' : 'bolt'} style={{ fontSize: '12px' }} className={busy === 'execute' ? 'animate-spin' : ''} />
                {busy === 'execute' ? 'Executing…' : 'Execute distribution'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stage 3 — Distributing: finalize */}
      {status === 3 && (
        <div className="nave-card p-5 space-y-3" style={{ backgroundColor: 'hsl(var(--surface-0))' }}>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
            Distribution is complete. Any locked NAVE stake has been released. Distribute remaining SOL, SPL tokens, and NFTs via recipient-bound Transfer proposals in Governance, then finalize.
          </p>
          {(isFounder || isDriver) && (
            <button
              onClick={handleFinalize}
              disabled={!!busy}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold w-full"
              style={{
                fontSize: '13.5px',
                backgroundColor: !!busy ? 'hsl(var(--muted))' : 'hsl(var(--destructive))',
                color: 'hsl(var(--primary-foreground))',
                cursor: !!busy ? 'not-allowed' : 'pointer',
              }}
            >
              <Fi icon={busy === 'finalize' ? 'spinner' : 'flag-checkered'} style={{ fontSize: '12px' }} className={busy === 'finalize' ? 'animate-spin' : ''} />
              {busy === 'finalize' ? 'Finalizing…' : 'Finalize &amp; Hide DAO'}
            </button>
          )}
        </div>
      )}

      {/* Stage 4 — Moonlighted */}
      {status === 4 && (
        <div className="nave-card p-5 space-y-3" style={{ backgroundColor: 'hsl(var(--surface-0))' }}>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
            This DAO is moonlighted and hidden from participants. Only the founder can reopen it, and reopening does not require a new stake.
          </p>
          {isFounder && (
            <button
              onClick={handleRestore}
              disabled={!!busy}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold w-full"
              style={{
                fontSize: '13.5px',
                backgroundColor: !!busy ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
                color: !!busy ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
                cursor: !!busy ? 'not-allowed' : 'pointer',
              }}
            >
              <Fi icon={busy === 'restore' ? 'spinner' : 'sun'} style={{ fontSize: '12px' }} className={busy === 'restore' ? 'animate-spin' : ''} />
              {busy === 'restore' ? 'Reopening…' : 'Reopen DAO'}
            </button>
          )}
        </div>
      )}

      {/* Confirm begin dialog */}
      {showConfirmBegin && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center px-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => setShowConfirmBegin(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 space-y-4"
            style={{ backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5">
              <Fi icon="moon" style={{ fontSize: '18px', color: 'hsl(var(--primary))' }} />
              <h3 className="text-display font-semibold" style={{ fontSize: '16px' }}>Begin Moonlighting?</h3>
            </div>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.65 }}>
              This will create a governance proposal to wind down <strong>{dao?.name ?? 'this DAO'}</strong>. Once the proposal passes and is recorded by the founder, agents are halted and the distribution process begins.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowConfirmBegin(false)}
                className="flex-1 px-4 py-2.5 rounded-lg font-medium"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border-strong))' }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateRequestProposal}
                disabled={busy === 'create-request'}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--primary))',
                  color: 'hsl(var(--primary-foreground))',
                  cursor: busy === 'create-request' ? 'not-allowed' : 'pointer',
                  opacity: busy === 'create-request' ? 0.7 : 1,
                }}
              >
                <Fi icon={busy === 'create-request' ? 'spinner' : 'scroll'} style={{ fontSize: '11px' }} className={busy === 'create-request' ? 'animate-spin' : ''} />
                {busy === 'create-request' ? 'Submitting…' : 'Create Proposal'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Record request dialog */}
      {showRecordDialog && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center px-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => setShowRecordDialog(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 space-y-4"
            style={{ backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5">
              <Fi icon="lock" style={{ fontSize: '16px', color: 'hsl(var(--primary))' }} />
              <h3 className="text-display font-semibold" style={{ fontSize: '16px' }}>Record Approved Request</h3>
            </div>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
              Enter the proposal number of the passed moonlight request. Founder only.
            </p>
            <input
              value={requestProposalIdx}
              onChange={(e) => setRequestProposalIdx(e.target.value)}
              placeholder="Proposal number (e.g. 3)"
              className="w-full px-3 py-2.5 rounded-lg border outline-none"
              style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowRecordDialog(false)}
                className="flex-1 px-4 py-2.5 rounded-lg font-medium"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border-strong))' }}
              >
                Cancel
              </button>
              <button
                onClick={handleRecordRequest}
                disabled={!!busy || !requestProposalIdx.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold"
                style={{
                  fontSize: '13px',
                  backgroundColor: !!busy || !requestProposalIdx.trim() ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
                  color: !!busy || !requestProposalIdx.trim() ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
                  cursor: !!busy || !requestProposalIdx.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                <Fi icon={busy === 'record' ? 'spinner' : 'lock'} style={{ fontSize: '11px' }} className={busy === 'record' ? 'animate-spin' : ''} />
                {busy === 'record' ? 'Recording…' : 'Record'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Distribution wallet dialog */}
      {showDistDialog && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center px-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => setShowDistDialog(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 space-y-4"
            style={{ backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5">
              <Fi icon="arrow-right" style={{ fontSize: '16px', color: 'hsl(var(--primary))' }} />
              <h3 className="text-display font-semibold" style={{ fontSize: '16px' }}>Set Distribution Wallet</h3>
            </div>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.65 }}>
              Enter the wallet that will receive the treasury assets. If this treasury still has a locked NAVE stake, that stake is released to the same recipient. This creates a binding distribution proposal that DAO members must vote on.
            </p>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Recipient wallet address"
              className="w-full px-3 py-2.5 rounded-lg border outline-none"
              style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowDistDialog(false)}
                className="flex-1 px-4 py-2.5 rounded-lg font-medium"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border-strong))' }}
              >
                Cancel
              </button>
              <button
                onClick={handleSetDistributionAndProposal}
                disabled={!!busy || !recipient.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold"
                style={{
                  fontSize: '13px',
                  backgroundColor: !!busy || !recipient.trim() ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
                  color: !!busy || !recipient.trim() ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
                  cursor: !!busy || !recipient.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                <Fi icon={busy === 'set-dist' ? 'spinner' : 'scroll'} style={{ fontSize: '11px' }} className={busy === 'set-dist' ? 'animate-spin' : ''} />
                {busy === 'set-dist' ? 'Submitting…' : 'Set &amp; Create Proposal'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
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

  return (
    <div
      className="flex-1 overflow-y-auto"
      data-onboarding-id="settings-root"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {/* Header */}
        <div className="mb-2">
          <h1
            className="text-display font-semibold"
            style={{
              fontSize: '22px',
              letterSpacing: '-0.02em',
              color: 'hsl(var(--foreground))',
            }}
          >
            Security & Settings
          </h1>
          <p
            style={{
              fontSize: '13.5px',
              color: 'hsl(var(--muted-foreground))',
              marginTop: '4px',
            }}
          >
            Trusted wallets, privacy, and emergency controls.
          </p>
        </div>

        {/* Security status banner — reflects real DAO state */}
        {(() => {
          const frozen = dao?.frozen ?? false;
          const govLabel = governanceType === 'token'
            ? `Token-weighted${votingMint ? ' (1 voting token)' : ''}`
            : signerCount > 0
              ? `${liveThreshold}-of-${signerCount} multisig`
              : 'Authorized wallets';
          const statusText = frozen ? 'Treasury frozen' : 'All clear';
          const statusColorVar = frozen ? 'hsl(var(--destructive))' : 'hsl(var(--accent))';
          return (
            <div
              className="flex items-center gap-3 px-4 py-3 rounded-xl border"
              style={{
                backgroundColor: frozen ? 'hsl(var(--destructive-muted))' : 'hsl(var(--accent-muted))',
                borderColor: frozen ? 'hsl(0 72% 80%)' : 'hsl(152 50% 82%)',
              }}
            >
              <Fi icon={frozen ? 'shield-halved' : 'shield-check'} style={{ fontSize: '14px', color: statusColorVar }} />
              <div>
                <span style={{ fontSize: '13px', fontWeight: '500', color: frozen ? 'hsl(var(--destructive))' : 'hsl(var(--accent-muted-foreground))' }}>
                  Security status: {statusText}
                </span>
                <span style={{ fontSize: '12.5px', color: frozen ? 'hsl(var(--destructive))' : 'hsl(var(--accent-muted-foreground))', opacity: 0.8, marginLeft: '8px' }}>
                  {govLabel} · {dao ? `${(dao.proposalCount ?? 0) + (dao.archivedProposalCount ?? 0)} proposals` : 'Loading…'}
                </span>
              </div>
            </div>
          );
        })()}

        <Tabs defaultValue="team" className="space-y-4">
          <TabsList
            className="w-full grid grid-cols-4 h-10"
            style={{ backgroundColor: 'hsl(var(--surface-1))' }}
          >
            <TabsTrigger value="team" style={{ fontSize: '13px' }}>Team</TabsTrigger>
            <TabsTrigger value="security" style={{ fontSize: '13px' }}>Security</TabsTrigger>
            <TabsTrigger value="activity" style={{ fontSize: '13px' }}>Activity</TabsTrigger>
            <TabsTrigger value="dao" style={{ fontSize: '13px' }}>DAO</TabsTrigger>
          </TabsList>

          <TabsContent value="team" className="space-y-4 mt-4">
            <MultisigSection
              initialSigners={liveSigners}
              initialThreshold={liveThreshold}
              daoAddress={daoAddress}
              guardiansBootstrapped={guardianConfig.bootstrapped}
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
          </TabsContent>

          <TabsContent value="security" className="space-y-4 mt-4">
            <ConstitutionRulesLink />
            <EmergencyControls daoAddress={daoAddress} initialFrozen={dao?.frozen ?? false} />
            {daoAddress && chainKindFromAddress(daoAddress) === 'evm' && (
              <EvmStrategyWithdrawSection
                daoAddress={daoAddress}
                proposalCount={(dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0)}
              />
            )}
            <ReviewWindowSection daoAddress={daoAddress} />
            <PrivacyAccessSection
              daoAddress={daoAddress}
              governanceType={governanceType}
              privacyEnabled={dao?.privacyEnabled ?? false}
              onRefetch={refetchDao}
            />
          </TabsContent>

          <TabsContent value="activity" className="space-y-4 mt-4">
            <AuditLog daoAddress={daoAddress} />
          </TabsContent>

          <TabsContent value="dao" className="space-y-4 mt-4">
            <MoonlightSection daoAddress={daoAddress} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}