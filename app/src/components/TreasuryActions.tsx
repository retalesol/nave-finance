import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { hexToBytes } from 'viem';
import Fi from './Fi';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { toast } from '../hooks/use-toast';
import { fetchDaoContracts } from '../lib/evm/readers';
import {
  buildCreateProposalEvm,
  encodeEvmNftTransferProposalPayload,
  encodeEvmTransferProposalPayload,
} from '../lib/evm/writers';
import { storeEvmProposalPayloadRemote } from '../lib/evmProposalPayloadStore';
import { persistEvmProposalPayload } from './governance/proposalStorage';
import { getAccount } from '@solana/spl-token';
import {
  buildCreateProposal,
  encodeSolanaNftTransferProposalPayload,
  encodeSolanaTransferProposalPayload,
} from '../lib/transactionBuilders';
import { fetchTreasuryVault } from '../lib/onChainFetcher';
import { getNavePrograms } from '../lib/naveProgram';
import { ProposalType, type GovernanceType } from '../lib/onChainTypes';
import type { TreasuryAssetRow } from '../hooks/useTreasuryAssets';
import { isSendableTreasuryAsset } from '../lib/treasuryAssetEligibility';
import type { TreasuryNft } from '../hooks/useTreasuryNfts';
import { EVM_DEPLOYMENT_MODE, SOLANA_NETWORK } from '../lib/programConfig';
import {
  MAINNET_DEFAULT_VOTING_PERIOD_SECONDS,
  actionDelayContextFrom,
  votingPeriodForNetwork,
} from '../lib/actionDelays';

export {
  DepositFlowModal,
  DepositFundsModal,
  ReceiveFundsModal,
  DepositToVaultModal,
  TreasuryDepositBanner,
  DepositAddressPanel,
} from './DepositFlow';

/** Zero EVM address — used as the votingMint for wallet-governed EVM DAOs. */
const EVM_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function shortenAddress(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/** Compact copy row for sidebar / inline use. */
export function CopyableAddressRow({
  label,
  address,
  compact = true,
  className = '',
}: {
  label: string;
  address: string;
  compact?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${label}: ${address}`}
      className={`w-full flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors ${className}`}
      style={{ backgroundColor: 'transparent' }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
    >
      <span
        className="flex-shrink-0"
        style={{ fontSize: '10px', color: 'hsl(var(--muted-foreground))', minWidth: '72px' }}
      >
        {label}
      </span>
      <span
        className="nave-mono flex-1 min-w-0 truncate"
        style={{ fontSize: '10.5px', color: 'hsl(var(--foreground))' }}
      >
        {compact ? shortenAddress(address) : address}
      </span>
      <Fi
        icon={copied ? 'check' : 'copy'}
        style={{
          fontSize: '10px',
          flexShrink: 0,
          color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))',
        }}
      />
    </button>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 70,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
  backgroundColor: 'rgba(17, 24, 39, 0.48)',
  backdropFilter: 'blur(3px)',
};

const panel: React.CSSProperties = {
  width: '100%',
  maxWidth: '480px',
  borderRadius: '18px',
  border: '1px solid hsl(var(--border))',
  backgroundColor: '#ffffff',
  boxShadow: '0 24px 70px -12px rgba(17, 24, 39, 0.35)',
  overflow: 'hidden',
};

function ModalHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="flex items-start justify-between gap-3.5"
      style={{ padding: '20px 22px 0', backgroundColor: '#ffffff' }}
    >
      <div>
        <span
          className="text-display block"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 400,
            fontSize: '23px',
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            color: 'hsl(var(--foreground))',
          }}
        >
          {title}
        </span>
        {subtitle && (
          <p
            style={{
              fontSize: '13px',
              color: 'hsl(var(--muted-foreground))',
              lineHeight: 1.5,
              margin: '4px 0 0',
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="flex items-center justify-center flex-shrink-0 transition-colors"
        style={{
          width: '32px',
          height: '32px',
          borderRadius: '50%',
          backgroundColor: 'hsl(var(--background))',
          border: '1px solid hsl(var(--surface-2))',
          color: 'hsl(var(--muted-foreground))',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'hsl(var(--foreground))';
          e.currentTarget.style.borderColor = 'hsl(var(--border))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
          e.currentTarget.style.borderColor = 'hsl(var(--surface-2))';
        }}
      >
        <Fi icon="xmark" style={{ fontSize: '14px' }} />
      </button>
    </div>
  );
}

export interface PayProposalDraft {
  proposalIndex: number;
  recipient: string;
  amount: string;
  reason: string;
}

function withBillMemo(text: string, billId?: string): string {
  if (!billId) return text;
  const tag = `bill:${billId}`;
  if (text.includes(tag)) return text;
  return `${text} ${tag}`.trim();
}

/* ── Propose a payment — build a Transfer proposal from the treasury ── */
export function CreateTransactionModal({
  daoAddress,
  proposalCount,
  governanceType,
  votingMint,
  assets,
  nfts = [],
  initialNftMint,
  initialRecipient,
  initialAmount,
  initialReason,
  billId,
  preferredSymbol,
  onClose,
  onCreated,
}: {
  daoAddress: string;
  proposalCount: number;
  governanceType: GovernanceType;
  votingMint: string | null;
  assets: TreasuryAssetRow[];
  nfts?: TreasuryNft[];
  initialNftMint?: string | null;
  initialRecipient?: string;
  initialAmount?: string;
  initialReason?: string;
  /** Kept on the proposal description so the bill id stays in the memo. */
  billId?: string;
  preferredSymbol?: string;
  onClose: () => void;
  onCreated?: (draft?: PayProposalDraft) => void;
}) {
  const { publicKey } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();

  const registeredNfts = useMemo(() => nfts.filter((n) => !n.compressed), [nfts]);
  const hasNfts = registeredNfts.length > 0;

  const [mode, setMode] = useState<'token' | 'nft'>(
    initialNftMint && hasNfts ? 'nft' : 'token',
  );
  const [recipient, setRecipient] = useState(initialRecipient ?? '');
  const [amount, setAmount] = useState(initialAmount ?? '');
  const [reason, setReason] = useState(initialReason ?? '');
  const [assetMint, setAssetMint] = useState('');
  const [nftMint, setNftMint] = useState(initialNftMint ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transferableAssets = useMemo(
    () => assets.filter((a) => isSendableTreasuryAsset(a)),
    [assets],
  );

  const selectedAsset =
    transferableAssets.find((a) => a.mint === assetMint) ?? transferableAssets[0] ?? null;

  const selectedNft =
    registeredNfts.find((n) => n.mint === nftMint) ?? registeredNfts[0] ?? null;

  const recipientValid = useMemo(() => {
    const r = recipient.trim();
    if (!r) return false;
    if (chainKind === 'evm') return /^0x[0-9a-fA-F]{40}$/.test(r);
    try {
      new PublicKey(r);
      return true;
    } catch {
      return false;
    }
  }, [recipient, chainKind]);

  const amountValid = Number(amount) > 0;
  const amountWithinBalance = selectedAsset ? Number(amount) <= selectedAsset.uiBalance : false;
  const walletReady = chainKind === 'evm' || !!publicKey;
  const canSubmitToken =
    mode === 'token' &&
    recipientValid &&
    amountValid &&
    amountWithinBalance &&
    !submitting &&
    walletReady &&
    !!selectedAsset;
  const canSubmitNft =
    mode === 'nft' && recipientValid && !submitting && walletReady && !!selectedNft;
  const canSubmit = mode === 'token' ? canSubmitToken : canSubmitNft;

  useEffect(() => {
    if (!transferableAssets.length) return;
    if (transferableAssets.some((asset) => asset.mint === assetMint)) return;
    const preferred = preferredSymbol
      ? transferableAssets.find((asset) => asset.symbol.toLowerCase() === preferredSymbol.toLowerCase())
      : undefined;
    setAssetMint((preferred ?? transferableAssets[0]).mint);
  }, [transferableAssets, assetMint, preferredSymbol]);

  useEffect(() => {
    if (registeredNfts.length && !registeredNfts.some((n) => n.mint === nftMint)) {
      setNftMint(registeredNfts[0].mint);
    }
  }, [registeredNfts, nftMint]);

  function parseUiAmount(value: string, decimals: number): bigint | null {
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const [whole, fraction = ''] = trimmed.split('.');
    if (fraction.length > decimals) return null;
    const raw = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+/, '') || '0';
    return BigInt(raw);
  }

  async function handleSubmit() {
    setError(null);
    const votingPeriodSeconds = votingPeriodForNetwork(
      MAINNET_DEFAULT_VOTING_PERIOD_SECONDS,
      actionDelayContextFrom({
        chainKind,
        evmChainId,
        solanaNetwork: SOLANA_NETWORK,
        evmDeploymentMode: EVM_DEPLOYMENT_MODE,
      }),
    );

    const trimmedReason = reason.trim();

    if (mode === 'nft') {
      if (!selectedNft) {
        setError('This treasury has no NFTs to send.');
        return;
      }
      if (!recipientValid) {
        setError('Enter a valid recipient wallet address.');
        return;
      }

      if (chainKind === 'evm') {
        if (!evmChainId) {
          toast({
            variant: 'destructive',
            title: 'Wrong network',
            description: 'Select an Ethereum or Base network.',
          });
          return;
        }
        const trio = await fetchDaoContracts(evmChainId, daoAddress);
        if (!trio) {
          toast({
            variant: 'destructive',
            title: 'Not available',
            description: 'EVM contracts are not configured for this network yet.',
          });
          return;
        }
        setSubmitting(true);
        try {
          const collectionAddr = (selectedNft.collection || selectedNft.mint) as `0x${string}`;
          const payloadHex = encodeEvmNftTransferProposalPayload(
            collectionAddr,
            recipient.trim() as `0x${string}`,
            0n,
          );
          const evmPayloadBytes = Array.from(hexToBytes(payloadHex));
          const outcome = await tx.sendEvm(
            buildCreateProposalEvm(evmChainId, trio.governor, {
              title: trimmedReason
                ? `${trimmedReason.slice(0, 48)} — ${selectedNft.name}`
                : `Send NFT: ${selectedNft.name}`,
              description:
                trimmedReason ||
                `Transfer NFT ${selectedNft.name} to ${recipient.trim()}`,
              payload: payloadHex,
              proposalType: ProposalType.Transfer,
              votingPeriodSeconds,
              votingMint: (governanceType === 'token' && votingMint
                ? votingMint
                : EVM_ZERO_ADDRESS) as `0x${string}`,
            }),
            { successLabel: 'Payment proposal created' },
          );
          if (outcome.status === 'success' || outcome.status === 'mock') {
            if (evmPayloadBytes.length > 0) {
              persistEvmProposalPayload(daoAddress, proposalCount, 'transfer', evmPayloadBytes);
              if (outcome.status === 'success' && evmChainId) {
                void storeEvmProposalPayloadRemote(
                  evmChainId,
                  daoAddress,
                  proposalCount,
                  'transfer',
                  evmPayloadBytes,
                );
              }
            }
            onCreated?.();
            onClose();
          } else {
            setError(outcome.error || 'Failed to create NFT transfer proposal.');
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create NFT transfer proposal.');
        } finally {
          setSubmitting(false);
        }
        return;
      }

      if (!publicKey) {
        setError('Connect your wallet first.');
        return;
      }

      const dao = new PublicKey(daoAddress);
      let daoTokenMint: PublicKey;
      try {
        if (governanceType === 'token') {
          if (!votingMint) {
            setError('This DAO has no voting token yet.');
            return;
          }
          daoTokenMint = new PublicKey(votingMint);
        } else {
          const vault = await fetchTreasuryVault(dao);
          if (!vault?.vaultTokenAccount) {
            setError('Treasury vault is not initialized for this DAO yet.');
            return;
          }
          const { core } = getNavePrograms();
          const acct = await getAccount(
            core.provider.connection,
            new PublicKey(vault.vaultTokenAccount),
          );
          daoTokenMint = acct.mint;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to resolve the DAO mint.');
        return;
      }

      setSubmitting(true);
      try {
        const dest = new PublicKey(recipient.trim());
        const mintPk = new PublicKey(selectedNft.mint);
        const payload = encodeSolanaNftTransferProposalPayload(dest, mintPk);

        const result = await buildCreateProposal(
          dao,
          proposalCount,
          publicKey,
          {
            title: trimmedReason
              ? `${trimmedReason.slice(0, 48)} — ${selectedNft.name}`
              : `Send NFT: ${selectedNft.name}`,
            description:
              trimmedReason ||
              `Transfer NFT ${selectedNft.name} (${selectedNft.mint}) to ${recipient.trim()}`,
            payload,
            proposalType: ProposalType.Transfer,
            votingPeriodSeconds,
          },
          daoTokenMint,
        );

        const outcome = await tx.send([result], { successLabel: 'Payment proposal created' });
        if (outcome.status === 'success' || outcome.status === 'mock') {
          onCreated?.();
          onClose();
        } else {
          setError(outcome.error || 'Failed to create NFT transfer proposal.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create NFT transfer proposal.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const proposalTitle = selectedAsset
      ? trimmedReason
        ? `${trimmedReason.slice(0, 48)} — ${amount} ${selectedAsset.symbol}`
        : `Send ${amount} ${selectedAsset.symbol}`
      : 'Payment proposal';
    const proposalDescription = withBillMemo(
      selectedAsset
        ? trimmedReason ||
          `Transfer ${amount} ${selectedAsset.symbol} from the treasury to ${recipient.trim()}`
        : trimmedReason,
      billId,
    );
    const drafted: PayProposalDraft = {
      proposalIndex: proposalCount,
      recipient: recipient.trim(),
      amount: amount.trim(),
      reason: trimmedReason,
    };

    // ── EVM: create a Transfer governance proposal on the governor ──────────
    if (chainKind === 'evm') {
      if (!evmChainId) {
        toast({
          variant: 'destructive',
          title: 'Wrong network',
          description: 'Select an Ethereum or Base network.',
        });
        return;
      }
      if (!selectedAsset) {
        setError('No deposited assets are available to send.');
        return;
      }
      if (!recipientValid) {
        setError('Enter a valid recipient address.');
        return;
      }
      const baseUnits = parseUiAmount(amount, selectedAsset.decimals);
      if (baseUnits === null || baseUnits <= 0n) {
        setError(`Enter an amount with up to ${selectedAsset.decimals} decimals.`);
        return;
      }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio) {
        toast({
          variant: 'destructive',
          title: 'Not available',
          description: 'EVM contracts are not configured for this network yet.',
        });
        return;
      }
      setSubmitting(true);
      try {
        const payloadHex = encodeEvmTransferProposalPayload(
          selectedAsset.mint as `0x${string}`,
          recipient.trim() as `0x${string}`,
          baseUnits,
        );
        const evmPayloadBytes = Array.from(hexToBytes(payloadHex));
        const outcome = await tx.sendEvm(
          buildCreateProposalEvm(evmChainId, trio.governor, {
            title: proposalTitle,
            description: proposalDescription,
            payload: payloadHex,
            proposalType: ProposalType.Transfer,
            votingPeriodSeconds,
            votingMint: (governanceType === 'token' && votingMint
              ? votingMint
              : EVM_ZERO_ADDRESS) as `0x${string}`,
          }),
          { successLabel: 'Payment proposal created' },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') {
          if (evmPayloadBytes.length > 0) {
            persistEvmProposalPayload(daoAddress, proposalCount, 'transfer', evmPayloadBytes);
            if (outcome.status === 'success' && evmChainId) {
              void storeEvmProposalPayloadRemote(
                evmChainId,
                daoAddress,
                proposalCount,
                'transfer',
                evmPayloadBytes,
              );
            }
          }
          onCreated?.(drafted);
          onClose();
        } else {
          setError(outcome.error || 'Failed to create payment proposal.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create payment proposal.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!publicKey) {
      setError('Connect your wallet first.');
      return;
    }

    const dao = new PublicKey(daoAddress);
    let daoTokenMint: PublicKey;
    try {
      if (governanceType === 'token') {
        if (!votingMint) {
          setError('This DAO has no voting token yet.');
          return;
        }
        daoTokenMint = new PublicKey(votingMint);
      } else {
        const vault = await fetchTreasuryVault(dao);
        if (!vault?.vaultTokenAccount) {
          setError('Treasury vault is not initialized for this DAO yet.');
          return;
        }
        const { core } = getNavePrograms();
        const acct = await getAccount(
          core.provider.connection,
          new PublicKey(vault.vaultTokenAccount),
        );
        daoTokenMint = acct.mint;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve the DAO mint.');
      return;
    }

    setSubmitting(true);
    try {
      const dest = new PublicKey(recipient.trim());
      if (!selectedAsset) {
        setError('No deposited assets are available to send.');
        return;
      }
      if (!amountWithinBalance) {
        setError(`Amount exceeds the ${selectedAsset.symbol} balance.`);
        return;
      }

      const baseUnits = parseUiAmount(amount, selectedAsset.decimals);
      if (baseUnits === null || baseUnits <= 0n) {
        setError(`Enter an amount with up to ${selectedAsset.decimals} decimals.`);
        return;
      }
      const mintPk = selectedAsset.mint === 'SOL' ? null : new PublicKey(selectedAsset.mint);
      const payload = encodeSolanaTransferProposalPayload(dest, mintPk, baseUnits);

      const result = await buildCreateProposal(
        dao,
        proposalCount,
        publicKey,
        {
          title: proposalTitle,
          description: proposalDescription,
          payload,
          proposalType: ProposalType.Transfer,
          votingPeriodSeconds,
        },
        daoTokenMint,
      );

      const outcome = await tx.send([result], { successLabel: 'Payment proposal created' });
        if (outcome.status === 'success' || outcome.status === 'mock') {
          onCreated?.(drafted);
          onClose();
        } else {
          setError(outcome.error || 'Failed to create payment proposal.');
        }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create payment proposal.');
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: '14px',
    padding: '10px 13px',
    borderRadius: '10px',
    border: '1px solid hsl(var(--border))',
    backgroundColor: '#ffffff',
    color: 'hsl(var(--foreground))',
    outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '12.5px',
    fontWeight: 600,
    color: 'hsl(var(--foreground))',
    marginBottom: '6px',
    display: 'block',
  };

  const estimatedUsd =
    selectedAsset?.priceUsd != null && amountValid
      ? Number(amount) * selectedAsset.priceUsd
      : null;

  return createPortal(
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panel} role="dialog" aria-modal="true" aria-label="Propose a payment">
        <ModalHeader
          title="Propose a payment"
          subtitle={billId
            ? 'This proposes a treasury payment for a Nave Pay bill. It does not send the funds.'
            : 'Your agents check it against the rules before anyone votes.'}
          onClose={onClose}
        />
        <div className="space-y-4" style={{ padding: '18px 22px 22px' }}>
          {hasNfts && (
            <div
              className="flex gap-1 p-1 rounded-[10px]"
              style={{
                backgroundColor: 'hsl(var(--background))',
                border: '1px solid hsl(var(--surface-2))',
              }}
            >
              {(['token', 'nft'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className="flex-1 px-3 py-1.5 rounded-[8px] transition-all"
                  style={{
                    fontSize: 12.5,
                    fontWeight: mode === m ? 600 : 500,
                    backgroundColor: mode === m ? '#ffffff' : 'transparent',
                    color: mode === m ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                    boxShadow: mode === m ? '0 1px 3px rgba(17, 24, 39, 0.08)' : 'none',
                  }}
                >
                  {m === 'token' ? 'Token' : 'NFT'}
                </button>
              ))}
            </div>
          )}

          <div>
            <label style={labelStyle}>Who gets paid?</label>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Wallet address…"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: '13px' }}
            />
          </div>

          {mode === 'token' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label style={labelStyle}>Asset</label>
                <select
                  value={selectedAsset?.mint ?? ''}
                  onChange={(e) => setAssetMint(e.target.value)}
                  style={inputStyle}
                  disabled={transferableAssets.length === 0}
                >
                  {transferableAssets.length === 0 ? (
                    <option value="">No deposited assets</option>
                  ) : (
                    transferableAssets.map((a) => (
                      <option key={a.mint} value={a.mint}>
                        {a.symbol} ({a.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })})
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between" style={{ marginBottom: '6px' }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Amount</label>
                  {selectedAsset && (
                    <button
                      type="button"
                      onClick={() => setAmount(String(selectedAsset.uiBalance))}
                      className="hover:underline underline-offset-2 bg-transparent border-0 cursor-pointer"
                      style={{
                        fontSize: '11.5px',
                        fontWeight: 600,
                        color: 'hsl(var(--brass))',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      Max
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>
          ) : (
            <div>
              <label style={labelStyle}>NFT</label>
              <select
                value={selectedNft?.mint ?? ''}
                onChange={(e) => setNftMint(e.target.value)}
                style={inputStyle}
              >
                {registeredNfts.map((n) => (
                  <option key={n.mint} value={n.mint}>
                    {n.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label style={labelStyle}>What is it for?</label>
            <textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Q3 grants — six community projects"
              style={{ ...inputStyle, resize: 'vertical', minHeight: '68px' }}
            />
          </div>

          <div
            style={{
              backgroundColor: 'hsl(var(--background))',
              border: '1px solid hsl(var(--surface-2))',
              borderRadius: '12px',
              padding: '11px 13px',
              fontSize: '12.5px',
              color: 'hsl(var(--muted-foreground))',
              lineHeight: 1.55,
            }}
          >
            {mode === 'token' && amountValid ? (
              <>
                <b style={{ color: 'hsl(var(--foreground))' }}>Needs a community vote</b>
                {estimatedUsd != null
                  ? ` (~$${estimatedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}). `
                  : '. '}
                Your agents verify the reserve rule before any funds move.
              </>
            ) : (
              'Enter a recipient, amount, and reason to publish this payment for a vote.'
            )}
          </div>

          {error && (
            <div
              className="px-3 py-2.5 rounded-lg"
              style={{
                backgroundColor: 'hsl(var(--destructive-muted))',
                fontSize: '12px',
                color: 'hsl(var(--destructive))',
                lineHeight: 1.4,
              }}
            >
              {error}
            </div>
          )}

          <div
            className="pt-3 border-t flex justify-end gap-2"
            style={{ borderColor: 'hsl(var(--surface-2))' }}
          >
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
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: '#111827',
                color: '#ffffff',
                opacity: canSubmit ? 1 : 0.4,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              {submitting ? 'Publishing…' : 'Publish for a vote →'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
