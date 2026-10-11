import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { parseUnits } from 'viem';
import Fi from './Fi';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { toast } from '../hooks/use-toast';
import { fetchDaoContracts } from '../lib/evm/readers';
import { buildCreateProposalEvm } from '../lib/evm/writers';
import { getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { buildCreateProposal, encodeSolanaNftTransferProposalPayload, encodeSolanaTransferProposalPayload } from '../lib/transactionBuilders';
import { fetchTreasuryVault } from '../lib/onChainFetcher';
import { getNavePrograms } from '../lib/naveProgram';
import { ProposalType, type GovernanceType } from '../lib/onChainTypes';
import { encodeEvmNftTransferProposalPayload, encodeEvmTransferProposalPayload } from '../lib/evm/writers';
import type { TreasuryAssetRow } from '../hooks/useTreasuryAssets';
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
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
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
  backgroundColor: 'rgba(0,0,0,0.45)',
};

const panel: React.CSSProperties = {
  width: '100%',
  maxWidth: '420px',
  borderRadius: '16px',
  border: '1px solid hsl(var(--border))',
  backgroundColor: 'hsl(var(--background))',
  boxShadow: 'var(--shadow-lg)',
  overflow: 'hidden',
};

function ModalHeader({ title, icon, onClose }: { title: string; icon: string; onClose: () => void }) {
  return (
    <div
      className="flex items-center justify-between px-5 py-4 border-b"
      style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}
    >
      <div className="flex items-center gap-2">
        <Fi icon={icon} style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }} />
        <span className="text-display font-semibold" style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }}>
          {title}
        </span>
      </div>
      <button
        onClick={onClose}
        className="p-1.5 rounded-lg transition-colors"
        style={{ color: 'hsl(var(--muted-foreground))' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      >
        <Fi icon="xmark" style={{ fontSize: '15px' }} />
      </button>
    </div>
  );
}

/* ── Propose transfer — build a Transfer proposal from the treasury ── */
export function CreateTransactionModal({
  daoAddress,
  proposalCount,
  governanceType,
  votingMint,
  assets,
  nfts = [],
  initialNftMint,
  onClose,
  onCreated,
}: {
  daoAddress: string;
  proposalCount: number;
  /** Token DAOs use the registered voting mint; wallet DAOs resolve mint from the vault (see Governance proposal flow). */
  governanceType: GovernanceType;
  votingMint: string | null;
  assets: TreasuryAssetRow[];
  nfts?: TreasuryNft[];
  /** Pre-select NFT mode with this mint (from Assets → Send via governance). */
  initialNftMint?: string | null;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const { publicKey } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const [mode, setMode] = useState<'token' | 'nft'>(initialNftMint ? 'nft' : 'token');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [assetMint, setAssetMint] = useState('');
  const [assetQuery, setAssetQuery] = useState('');
  const [nftMint, setNftMint] = useState(initialNftMint ?? '');
  const [evmCollection, setEvmCollection] = useState('');
  const [evmTokenId, setEvmTokenId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registeredNfts = useMemo(() => nfts.filter((n) => n.registered && !n.compressed), [nfts]);

  const assetsWithBalance = useMemo(() => assets.filter((a) => a.uiBalance > 0), [assets]);
  const transferableAssets = useMemo(
    () => assetsWithBalance.filter((a) => a.onChainRegistered && a.enabled),
    [assetsWithBalance],
  );
  const filteredTransferable = useMemo(() => {
    const q = assetQuery.trim().toLowerCase();
    if (!q) return transferableAssets;
    return transferableAssets.filter(
      (a) =>
        a.symbol.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.mint.toLowerCase().includes(q),
    );
  }, [transferableAssets, assetQuery]);

  const selectedAsset =
    filteredTransferable.find((a) => a.mint === assetMint) ?? filteredTransferable[0] ?? null;

  const selectedNft = registeredNfts.find((n) => n.mint === nftMint) ?? registeredNfts[0] ?? null;

  const heldButNotSendable =
    assetsWithBalance.length > 0 && transferableAssets.length === 0;

  const recipientValid = useMemo(() => {
    const r = recipient.trim();
    if (chainKind === 'evm') return /^0x[0-9a-fA-F]{40}$/.test(r);
    try { new PublicKey(r); return true; } catch { return false; }
  }, [recipient, chainKind]);
  const amountValid = Number(amount) > 0;
  const amountWithinBalance = selectedAsset ? Number(amount) <= selectedAsset.uiBalance : false;
  const evmTokenIdValid = /^\d+$/.test(evmTokenId.trim()) && BigInt(evmTokenId.trim()) >= 0n;
  const evmCollectionValid = chainKind !== 'evm' || /^0x[0-9a-fA-F]{40}$/.test(evmCollection.trim());
  const walletReady = chainKind === 'evm' || !!publicKey;
  const canSubmitToken = mode === 'token' && recipientValid && amountValid && amountWithinBalance && !submitting && walletReady && !!selectedAsset;
  const canSubmitNft = mode === 'nft' && recipientValid && !submitting && walletReady && (
    chainKind === 'evm'
      ? evmCollectionValid && evmTokenIdValid
      : !!selectedNft
  );
  const canSubmit = mode === 'token' ? canSubmitToken : canSubmitNft;

  useEffect(() => {
    if (filteredTransferable.length && !filteredTransferable.some((a) => a.mint === assetMint)) {
      setAssetMint(filteredTransferable[0].mint);
    }
  }, [filteredTransferable, assetMint]);

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

    if (mode === 'nft') {
      if (chainKind === 'evm') {
        if (!evmChainId) { toast({ variant: 'destructive', title: 'Wrong network', description: 'Select an Ethereum or Base network.' }); return; }
        if (!recipientValid) { setError('Enter a valid recipient address.'); return; }
        if (!evmCollectionValid) { setError('Enter a valid ERC-721 collection contract address.'); return; }
        if (!evmTokenIdValid) { setError('Enter a valid token ID (non-negative integer).'); return; }
        const trio = await fetchDaoContracts(evmChainId, daoAddress);
        if (!trio) { toast({ variant: 'destructive', title: 'Not available', description: 'EVM contracts are not configured for this network yet.' }); return; }
        setSubmitting(true);
        try {
          const tokenId = BigInt(evmTokenId.trim());
          const payloadHex = encodeEvmNftTransferProposalPayload(
            evmCollection.trim() as `0x${string}`,
            recipient.trim() as `0x${string}`,
            tokenId,
          );
          const outcome = await tx.sendEvm(
            buildCreateProposalEvm(evmChainId, trio.governor, {
              title: `Send NFT #${tokenId.toString()}`,
              description: `Transfer ERC-721 token ${tokenId.toString()} from ${evmCollection.trim()} to ${recipient.trim()}`,
              payload: payloadHex,
              proposalType: ProposalType.Transfer,
              votingPeriodSeconds,
              votingMint: (governanceType === 'token' && votingMint ? votingMint : EVM_ZERO_ADDRESS) as `0x${string}`,
            }),
            { successLabel: 'NFT transfer proposal created' },
          );
          if (outcome.status === 'success' || outcome.status === 'mock') { onCreated?.(); onClose(); }
          else setError(outcome.error || 'Failed to create NFT transfer proposal.');
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create NFT transfer proposal.');
        } finally {
          setSubmitting(false);
        }
        return;
      }

      if (!publicKey) { setError('Connect your wallet first.'); return; }
      if (!selectedNft) { setError('Register an NFT on the Assets page before sending.'); return; }
      if (!recipientValid) { setError('Enter a valid recipient address.'); return; }

      const dao = new PublicKey(daoAddress);
      let daoTokenMint: PublicKey;
      try {
        if (governanceType === 'token') {
          if (!votingMint) {
            setError('This DAO has no voting token yet. Configure a voting token in Settings before creating transaction proposals.');
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
          const acct = await getAccount(core.provider.connection, new PublicKey(vault.vaultTokenAccount));
          daoTokenMint = acct.mint;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to resolve the DAO mint for this proposal.');
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
            title: `Send NFT: ${selectedNft.name}`,
            description: `Transfer NFT ${selectedNft.name} (${selectedNft.mint}) to ${recipient.trim()}`,
            payload,
            proposalType: ProposalType.Transfer,
            votingPeriodSeconds,
          },
          daoTokenMint,
        );

        const outcome = await tx.send([result], { successLabel: 'NFT transfer proposal created' });
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

    // ── EVM: create a Transfer governance proposal on the governor ──────────
    if (chainKind === 'evm') {
      if (!evmChainId) { toast({ variant: 'destructive', title: 'Wrong network', description: 'Select an Ethereum or Base network.' }); return; }
      if (!selectedAsset) { setError('No deposited assets are available to send.'); return; }
      if (!recipientValid) { setError('Enter a valid recipient address.'); return; }
      const baseUnits = parseUiAmount(amount, selectedAsset.decimals);
      if (baseUnits === null || baseUnits <= 0n) { setError(`Enter an amount with up to ${selectedAsset.decimals} decimals.`); return; }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio) { toast({ variant: 'destructive', title: 'Not available', description: 'EVM contracts are not configured for this network yet.' }); return; }
      setSubmitting(true);
      try {
        const payloadHex = encodeEvmTransferProposalPayload(
          selectedAsset.mint as `0x${string}`,
          recipient.trim() as `0x${string}`,
          baseUnits,
        );
        const outcome = await tx.sendEvm(
          buildCreateProposalEvm(evmChainId, trio.governor, {
            title: `Send ${amount} ${selectedAsset.symbol}`,
            description: `Transfer ${amount} ${selectedAsset.symbol} from the treasury to ${recipient.trim()}`,
            payload: payloadHex,
            proposalType: ProposalType.Transfer,
            votingPeriodSeconds,
            votingMint: (governanceType === 'token' && votingMint ? votingMint : EVM_ZERO_ADDRESS) as `0x${string}`,
          }),
          { successLabel: 'Transaction proposal created' },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') { onCreated?.(); onClose(); }
        else setError(outcome.error || 'Failed to create transaction proposal.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create transaction proposal.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!publicKey) { setError('Connect your wallet first.'); return; }

    const dao = new PublicKey(daoAddress);
    let daoTokenMint: PublicKey;
    try {
      if (governanceType === 'token') {
        if (!votingMint) {
          setError('This DAO has no voting token yet. Configure a voting token in Settings before creating transaction proposals.');
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
        const acct = await getAccount(core.provider.connection, new PublicKey(vault.vaultTokenAccount));
        daoTokenMint = acct.mint;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve the DAO mint for this proposal.');
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

      // Payload: 32-byte recipient + 32-byte mint/SOL sentinel + 8-byte amount.
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
          title: `Send ${amount} ${selectedAsset.symbol}`,
          description: `Transfer ${amount} ${selectedAsset.symbol} from the treasury to ${recipient.trim()}`,
          payload,
          proposalType: ProposalType.Transfer,
          votingPeriodSeconds,
        },
        daoTokenMint,
      );

      const outcome = await tx.send([result], { successLabel: 'Transaction proposal created' });
      if (outcome.status === 'success' || outcome.status === 'mock') {
        onCreated?.();
        onClose();
      } else {
        setError(outcome.error || 'Failed to create transaction proposal.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create transaction proposal.');
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    padding: '10px 12px',
    borderRadius: '10px',
    border: '1px solid hsl(var(--border))',
    backgroundColor: 'hsl(var(--surface-0))',
    color: 'hsl(var(--foreground))',
    outline: 'none',
  };
  const estimatedFee = chainKind === 'evm' ? 'Network gas fee' : '~0.00001 SOL network fee';
  const estimatedValue = selectedAsset?.priceUsd != null && amountValid
    ? Number(amount) * selectedAsset.priceUsd
    : null;

  return createPortal(
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panel}>
        <ModalHeader title="Propose Transfer" icon="paper-plane" onClose={onClose} />
        <div className="p-5 space-y-4">
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            Creates a governance proposal — guardians must vote before any funds move.
          </p>
          <div className="flex gap-0.5 p-0.5 rounded-lg w-fit" style={{ backgroundColor: 'hsl(var(--surface-1))' }}>
            {(['token', 'nft'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className="px-3.5 py-1.5 rounded-md transition-all"
                style={{
                  fontSize: 12.5,
                  fontWeight: mode === m ? 500 : 400,
                  backgroundColor: mode === m ? 'hsl(var(--surface-0))' : 'transparent',
                  color: mode === m ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  boxShadow: mode === m ? 'var(--shadow-xs)' : 'none',
                }}
              >
                {m === 'token' ? 'Token transfer' : 'NFT transfer'}
              </button>
            ))}
          </div>

          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            {mode === 'token'
              ? 'Select a treasury asset, recipient wallet, and amount.'
              : 'Propose sending a treasury-held NFT to a recipient. Solana NFTs must be registered on the Assets page first; EVM uses the ERC-721 collection address and token ID.'}
          </p>

          {mode === 'token' && heldButNotSendable && (
            <div
              className="px-3 py-2.5 rounded-lg"
              style={{ backgroundColor: 'hsl(var(--surface-1))', fontSize: '12px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}
            >
              This treasury holds tokens that are not registered for governance transfers yet. Open{' '}
              <strong>Assets</strong> and use <strong>Enable for transfers</strong> (Solana) or <strong>Register Asset</strong> (EVM) for the mint you want to move.
            </div>
          )}

          {mode === 'nft' && chainKind === 'solana' && registeredNfts.length === 0 && (
            <div
              className="px-3 py-2.5 rounded-lg"
              style={{ backgroundColor: 'hsl(var(--surface-1))', fontSize: '12px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}
            >
              No governance-registered NFTs found. Open <strong>Assets → NFTs</strong> and use <strong>Register for governance</strong> on the NFT you want to send.
            </div>
          )}

          {mode === 'token' && (
          <>
          <div>
            <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
              Search assets
            </label>
            <input
              value={assetQuery}
              onChange={(e) => setAssetQuery(e.target.value)}
              placeholder="Filter by symbol, name, or address…"
              style={inputStyle}
              disabled={transferableAssets.length === 0}
            />
          </div>

          <div>
            <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
              Asset
            </label>
            <select
              value={selectedAsset?.mint ?? ''}
              onChange={e => setAssetMint(e.target.value)}
              style={inputStyle}
              disabled={filteredTransferable.length === 0}
            >
              {filteredTransferable.length === 0 ? (
                <option value="">
                  {heldButNotSendable
                    ? 'Register a held asset first'
                    : assetQuery.trim()
                      ? 'No assets match this search'
                      : 'No deposited assets found'}
                </option>
              ) : filteredTransferable.map((a) => (
                <option key={a.mint} value={a.mint}>
                  {a.symbol} · {a.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })} available
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
              Recipient address
            </label>
            <input
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="Destination wallet address…"
              style={inputStyle}
            />
          </div>

          <div>
            <div className="flex items-center justify-between" style={{ marginBottom: '6px' }}>
              <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, display: 'block' }}>
                Amount
              </label>
              {selectedAsset && (
                <button
                  type="button"
                  onClick={() => setAmount(String(selectedAsset.uiBalance))}
                  className="text-xs font-medium underline-offset-2 hover:underline"
                  style={{ color: 'hsl(var(--primary))', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  Max
                </button>
              )}
            </div>
            <input
              type="number"
              min="0"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              style={inputStyle}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="p-3 rounded-lg border" style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}>
              <div className="nave-label" style={{ fontSize: '10.5px', marginBottom: 4 }}>Estimated value</div>
              <div className="nave-mono" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>
                {estimatedValue == null ? '—' : `$${estimatedValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
              </div>
            </div>
            <div className="p-3 rounded-lg border" style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}>
              <div className="nave-label" style={{ fontSize: '10.5px', marginBottom: 4 }}>Estimated fee</div>
              <div className="nave-mono" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>{estimatedFee}</div>
            </div>
          </div>

          <p style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            Estimated USD uses DexScreener (or stable parity) for orientation only. On-chain agents and risk checks use oracle-backed prices at execution time, not this estimate.
          </p>
          </>
          )}

          {mode === 'nft' && (
            <>
              {chainKind === 'evm' ? (
                <>
                  <div>
                    <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                      ERC-721 collection address
                    </label>
                    <input value={evmCollection} onChange={(e) => setEvmCollection(e.target.value)} placeholder="0x…" style={inputStyle} />
                  </div>
                  <div>
                    <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                      Token ID
                    </label>
                    <input value={evmTokenId} onChange={(e) => setEvmTokenId(e.target.value)} placeholder="0" style={inputStyle} />
                  </div>
                </>
              ) : (
                <div>
                  <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                    NFT
                  </label>
                  <select value={selectedNft?.mint ?? ''} onChange={(e) => setNftMint(e.target.value)} style={inputStyle} disabled={registeredNfts.length === 0}>
                    {registeredNfts.length === 0 ? (
                      <option value="">No registered NFTs</option>
                    ) : registeredNfts.map((n) => (
                      <option key={n.mint} value={n.mint}>{n.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                  Recipient address
                </label>
                <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Destination wallet address…" style={inputStyle} />
              </div>
            </>
          )}

          {error && (
            <div
              className="px-3 py-2.5 rounded-lg"
              style={{ backgroundColor: 'hsl(var(--destructive-muted))', fontSize: '12px', color: 'hsl(0 60% 40%)', lineHeight: 1.4 }}
            >
              {error}
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium transition-all"
            style={{
              fontSize: '14px',
              backgroundColor: canSubmit ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
              color: canSubmit ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            <Fi icon="paper-plane" style={{ fontSize: '13px' }} />
            {submitting ? 'Creating proposal…' : 'Confirm Proposal'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

