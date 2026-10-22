import { useEffect, useMemo, useState } from 'react';
import { PublicKey, LAMPORTS_PER_SOL, type TransactionInstruction } from '@solana/web3.js';
import { QRCodeSVG } from 'qrcode.react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { readContract } from '@wagmi/core';
import { useAccount, useBalance } from 'wagmi';
import { formatUnits, parseUnits, type Address } from 'viem';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import Fi from './Fi';
import NaveModal from './NaveModal';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { toast } from '../hooks/use-toast';
import { Erc20Abi } from '../lib/evm/contracts';
import { wagmiConfig } from '../lib/evm/wagmi';
import { buildApproveErc20Evm, buildDepositEvm, buildRegisterAssetEvm, buildWrapEthEvm } from '../lib/evm/writers';
import { buildDepositSol, buildDepositToAsset, buildRegisterAsset } from '../lib/transactionBuilders';
import { getSolanaRegisterAssetPlan } from '../lib/solanaTreasuryRegistrationDefaults';
import { getTreasuryDepositAddresses } from '../lib/pdaDerivation';
import type { TreasuryAssetRow } from '../hooks/useTreasuryAssets';
import type { EvmChainId } from '../lib/chain/types';
import { evmAllowedAssets, type EvmAllowedAsset } from '../lib/allowedAssets';
import { chainDisplayLabel } from '../lib/programConfig';

function shortenAddress(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function filterDepositableAssets(assets: TreasuryAssetRow[]): TreasuryAssetRow[] {
  return assets.filter(a => {
    if (a.mint === 'ETH') return false;
    if (a.onChainRegistered && !a.enabled) return false;
    if (a.mint === 'SOL') return true;
    if (/^0x[0-9a-fA-F]{40}$/.test(a.mint)) return true;
    if (a.mint.length < 32 || a.mint.length > 44) return false;
    try { new PublicKey(a.mint); return true; } catch { return false; }
  });
}

const ZERO_PYTH_FEED = '0'.repeat(64);

function evmAssetKind(asset: EvmAllowedAsset): number {
  if (asset.assetClass === 'stablecoin') return 0;
  if (asset.assetClass === 'sol-like' || asset.symbol.toUpperCase().includes('ETH')) return 1;
  return 2;
}

function evmAllowlistAsDepositRow(asset: EvmAllowedAsset): TreasuryAssetRow {
  return {
    mint: asset.address,
    decimals: asset.decimals,
    pythFeedHex: asset.assetClass === 'stablecoin' ? ZERO_PYTH_FEED : (asset.pythFeedId ?? ZERO_PYTH_FEED),
    isStablecoin: asset.assetClass === 'stablecoin',
    assetKind: evmAssetKind(asset),
    enabled: true,
    deposited: 0,
    deployedCapital: 0,
    lastValuedUsd: 0,
    lastValuedAt: 0,
    vaultBalanceBaseUnits: 0,
    assetVault: '',
    symbol: asset.symbol,
    name: asset.name,
    assetKindLabel: asset.assetClass,
    priceUsd: null,
    priceSource: '—',
    uiBalance: 0,
    valueUsd: 0,
    allocationPct: 0,
    onChainRegistered: false,
  };
}

export async function buildAllowanceSafeEvmDeposit(
  chainId: EvmChainId,
  owner: Address,
  treasury: string,
  asset: string,
  amount: bigint,
  preRequests: ReturnType<typeof buildApproveErc20Evm>[] = [],
) {
  const allowance = await readContract(wagmiConfig, {
    address: asset as Address,
    abi: Erc20Abi,
    functionName: 'allowance',
    args: [owner, treasury as Address],
    chainId,
  }).catch(() => 0n);
  const requests = [...preRequests];
  if ((allowance as bigint) < amount) {
    if ((allowance as bigint) > 0n) {
      requests.push(buildApproveErc20Evm(chainId, asset, treasury, 0n));
    }
    requests.push(buildApproveErc20Evm(chainId, asset, treasury, amount));
  }
  requests.push(buildDepositEvm(chainId, treasury, asset, amount));
  return requests;
}

function useDepositAddresses(daoAddress: string, vaultMint?: string | null) {
  const { chainKind } = useChain();
  return useMemo(
    () => (chainKind === 'evm'
      ? { sol: daoAddress, spl: null as string | null }
      : getTreasuryDepositAddresses(daoAddress, vaultMint)),
    [chainKind, daoAddress, vaultMint],
  );
}

/** Inline QR + copy panel — calm hairline receive flow. */
export function DepositAddressPanel({
  daoAddress,
  daoName,
  vaultMint,
  compact = false,
}: {
  daoAddress: string;
  daoName?: string;
  vaultMint?: string | null;
  compact?: boolean;
}) {
  const { chainKind } = useChain();
  const isSolana = chainKind === 'solana';
  const [copied, setCopied] = useState(false);
  const { sol: solAddress, spl: splAddress } = useDepositAddresses(daoAddress, vaultMint);
  const receiveAddress = splAddress ?? solAddress;

  function copyAddress() {
    navigator.clipboard.writeText(receiveAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div
      className={`flex flex-col ${compact ? 'items-center text-center' : 'sm:flex-row sm:items-start'} gap-5`}
      style={{
        padding: '24px 0',
        borderTop: '1px solid hsl(var(--surface-2))',
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      <div
        className="p-3 rounded-[12px] flex-shrink-0"
        style={{ backgroundColor: '#ffffff', border: '1px solid hsl(var(--border))' }}
      >
        <QRCodeSVG value={receiveAddress} size={compact ? 132 : 148} level="M" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        <div>
          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '15px',
              fontWeight: 600,
              color: 'hsl(var(--foreground))',
            }}
          >
            Fund {daoName ?? 'your treasury'}
          </div>
          <p
            style={{
              fontSize: '13px',
              color: 'hsl(var(--muted-foreground))',
              marginTop: '4px',
              lineHeight: 1.55,
            }}
          >
            {!isSolana
              ? 'Send tokens to this address. They show up in Money after the transfer lands.'
              : splAddress
                ? 'Send the treasury token to this address.'
                : 'Send SOL to this treasury address.'}
          </p>
          {isSolana && splAddress && (
            <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '6px' }}>
              Native SOL: <span className="nave-mono">{shortenAddress(solAddress)}</span>
            </p>
          )}
        </div>
        <div
          className="flex items-center gap-2 rounded-[10px] border"
          style={{
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            padding: '10px 12px',
          }}
        >
          <code
            className="nave-mono truncate flex-1"
            style={{ fontSize: '11.5px', color: 'hsl(var(--foreground))' }}
          >
            {receiveAddress}
          </code>
          <button
            type="button"
            onClick={copyAddress}
            className="px-3 py-1 rounded-[8px] border font-semibold transition-colors flex-shrink-0"
            style={{
              fontSize: '12px',
              backgroundColor: 'hsl(var(--background))',
              borderColor: 'hsl(var(--border))',
              color: copied ? 'hsl(var(--success))' : 'hsl(var(--foreground))',
            }}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <p style={{ fontSize: '11.5px', color: 'hsl(var(--faint))' }}>
          {copied ? 'Address copied to clipboard' : 'Scan the QR or copy the treasury deposit address'}
        </p>
      </div>
    </div>
  );
}

/** Deposit address hairline strip with optional QR modal trigger. */
export function TreasuryDepositBanner({
  daoAddress,
  vaultMint,
  onShowQr,
}: {
  daoAddress: string;
  vaultMint?: string | null;
  onShowQr?: () => void;
}) {
  const { chainKind } = useChain();
  const isSolana = chainKind === 'solana';
  const [copied, setCopied] = useState(false);
  const { sol: solAddress, spl: splAddress } = useDepositAddresses(daoAddress, vaultMint);
  const depositAddress = splAddress ?? solAddress;

  function copy() {
    navigator.clipboard.writeText(depositAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-3"
      style={{
        padding: '16px 0',
        borderTop: '1px solid hsl(var(--surface-2))',
        borderBottom: '1px solid hsl(var(--surface-2))',
      }}
    >
      <div className="flex-1 min-w-0">
        <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
          {splAddress ? 'Token deposit address' : 'Treasury deposit address'}
        </div>
        <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', lineHeight: 1.5 }}>
          {!isSolana
            ? 'Send any token to this address. It shows up in Money as soon as the transfer lands.'
            : splAddress
              ? 'Send the treasury token here to fund this treasury. Only use Solana devnet.'
              : 'Send SOL here to fund this treasury. Only use Solana devnet.'}
        </p>
        {isSolana && splAddress && (
          <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px', lineHeight: 1.5 }}>
            For native SOL, use <span className="nave-mono">{shortenAddress(solAddress)}</span>.
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 w-full sm:w-auto sm:max-w-md">
        <button
          type="button"
          onClick={copy}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-[10px] border transition-colors"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: '#ffffff' }}
        >
          <span className="nave-mono truncate" style={{ fontSize: '11.5px', color: 'hsl(var(--foreground))' }}>
            {depositAddress}
          </span>
          <Fi
            icon={copied ? 'circle-check' : 'copy'}
            style={{ fontSize: '12px', flexShrink: 0, color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
          />
        </button>
        {onShowQr && (
          <button
            type="button"
            onClick={onShowQr}
            className="flex items-center justify-center px-3 py-2 rounded-[10px] border transition-colors"
            style={{ borderColor: 'hsl(var(--border))', backgroundColor: '#ffffff', color: 'hsl(var(--foreground))' }}
            title="Show QR code"
          >
            <Fi icon="qrcode" style={{ fontSize: '14px' }} />
          </button>
        )}
      </div>
    </div>
  );
}

type DepositTab = 'wallet' | 'address';

/**
 * Shared deposit flow — QR-first modal used by Dashboard and Assets.
 */
export function DepositFlowModal({
  daoAddress,
  daoName,
  vaultMint,
  registeredAssets = [],
  preselectedAsset,
  initialTab,
  onClose,
  onDeposited,
}: {
  daoAddress: string;
  daoName?: string;
  vaultMint?: string | null;
  registeredAssets?: TreasuryAssetRow[];
  /** When set (Assets row action), pre-select token; tab defaults to QR unless initialTab is set. */
  preselectedAsset?: TreasuryAssetRow | null;
  initialTab?: DepositTab;
  onClose: () => void;
  onDeposited?: () => void;
}) {
  const effectiveVaultMint = preselectedAsset && preselectedAsset.mint !== 'SOL'
    ? preselectedAsset.mint
    : vaultMint;

  const [tab, setTab] = useState<DepositTab>(initialTab ?? 'wallet');
  const { chainKind, evmChainId, chainFamily } = useChain();
  const isSolana = chainKind === 'solana';
  const walletNetworkName = isSolana ? 'Solana' : chainDisplayLabel(chainFamily);
  const [copied, setCopied] = useState(false);
  const { sol: solAddress, spl: splAddress } = useDepositAddresses(daoAddress, effectiveVaultMint);
  const receiveAddress = splAddress ?? solAddress;

  function copyAddress() {
    navigator.clipboard.writeText(receiveAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { address: evmAddress } = useAccount();
  const { data: nativeEvmBalance } = useBalance({
    address: evmAddress,
    chainId: evmChainId ?? undefined,
    query: { enabled: chainKind === 'evm' && !!evmAddress && !!evmChainId },
  });
  const tx = useSendTransaction();

  const selectableAssets = useMemo(() => {
    const registered = filterDepositableAssets(registeredAssets);
    if (chainKind !== 'evm' || !evmChainId) return registered;
    const have = new Set(registeredAssets.map((a) => a.mint.toLowerCase()));
    const extras = evmAllowedAssets(evmChainId)
      .filter((a) => !have.has(a.address.toLowerCase()))
      .map(evmAllowlistAsDepositRow);
    return [...registered, ...extras];
  }, [registeredAssets, chainKind, evmChainId]);
  const [selectedMint, setSelectedMint] = useState<string>(
    () => preselectedAsset?.mint ?? selectableAssets[0]?.mint ?? '',
  );
  const [amount, setAmount] = useState('');
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletBalanceBaseUnits, setWalletBalanceBaseUnits] = useState<bigint | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);

  useEffect(() => {
    if (preselectedAsset?.mint) setSelectedMint(preselectedAsset.mint);
  }, [preselectedAsset?.mint]);

  useEffect(() => {
    if (selectableAssets[0] && !selectableAssets.some((asset) => asset.mint === selectedMint)) {
      setSelectedMint(selectableAssets[0].mint);
    }
  }, [selectedMint, selectableAssets]);

  const selectedAsset = selectableAssets.find(a => a.mint === selectedMint) ?? preselectedAsset ?? null;

  const rpcEndpoint = connection.rpcEndpoint;
  const isNativeSol = selectedMint === 'SOL';
  useEffect(() => {
    setWalletBalance(null);
    setWalletBalanceBaseUnits(null);
    if (!selectedMint) return;
    if (chainKind === 'evm') {
      if (!evmAddress || !evmChainId || !selectedAsset) return;
      let cancelled = false;
      const timer = setTimeout(() => {
        if (!cancelled) { cancelled = true; setWalletBalance(0); }
      }, 6000);
      (async () => {
        try {
          const balance = await readContract(wagmiConfig, {
            address: selectedMint as Address,
            abi: Erc20Abi,
            functionName: 'balanceOf',
            args: [evmAddress],
            chainId: evmChainId,
          });
          if (!cancelled) {
            const raw = balance as bigint;
            setWalletBalanceBaseUnits(raw);
            setWalletBalance(Number(formatUnits(raw, selectedAsset.decimals)));
          }
        } catch {
          if (!cancelled) {
            setWalletBalanceBaseUnits(0n);
            setWalletBalance(0);
          }
        } finally {
          clearTimeout(timer);
        }
      })();
      return () => { cancelled = true; clearTimeout(timer); };
    }
    if (!publicKey) return;
    if (!isNativeSol && selectedMint.length < 32) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) { cancelled = true; setWalletBalance(0); }
    }, 6000);
    (async () => {
      try {
        if (isNativeSol) {
          const lamports = await connection.getBalance(publicKey);
          if (!cancelled) setWalletBalance(lamports / LAMPORTS_PER_SOL);
          return;
        }
        const mintPk = new PublicKey(selectedMint);
        const { value: accounts } = await connection.getParsedTokenAccountsByOwner(
          publicKey,
          { mint: mintPk },
        );
        if (!cancelled) {
          const uiAmount = accounts.length > 0
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? Number((accounts[0].account.data as any).parsed?.info?.tokenAmount?.uiAmount ?? 0)
            : 0;
          setWalletBalance(uiAmount);
        }
      } catch {
        if (!cancelled) setWalletBalance(0);
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { cancelled = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, selectedMint, rpcEndpoint, isNativeSol, chainKind, evmAddress, evmChainId, selectedAsset]);

  const amountNum = Number(amount);
  const amountValid = amountNum > 0;
  const amountBaseUnits = selectedAsset && amountValid
    ? (() => {
        try { return parseUnits(amount, selectedAsset.decimals); } catch { return null; }
      })()
    : null;
  const isSelectedWeth = chainKind === 'evm' && selectedAsset?.symbol.toUpperCase() === 'WETH';
  const wethDeficit = isSelectedWeth && amountBaseUnits != null && walletBalanceBaseUnits != null && amountBaseUnits > walletBalanceBaseUnits
    ? amountBaseUnits - walletBalanceBaseUnits
    : 0n;
  const nativeCanCoverWethDeficit = !!nativeEvmBalance && wethDeficit > 0n && nativeEvmBalance.value >= wethDeficit;
  const withinBalance = walletBalance === null || amountNum <= walletBalance || nativeCanCoverWethDeficit;
  const hasAssets = selectableAssets.length > 0 || !!preselectedAsset;
  const walletReady = chainKind === 'evm' || !!publicKey;
  const canDeposit = amountValid && withinBalance && !submitting && walletReady && hasAssets && !!selectedMint;

  async function handleDeposit() {
    setDepositError(null);

    if (chainKind === 'evm') {
      if (!evmChainId) { toast({ variant: 'destructive', title: 'Wrong network', description: `Select ${walletNetworkName}.` }); return; }
      if (!evmAddress) { setDepositError(`Connect your ${walletNetworkName} wallet first.`); return; }
      if (!selectedAsset) { setDepositError('Select a token to deposit.'); return; }
      if (!amountValid) { setDepositError('Enter an amount greater than zero.'); return; }
      setSubmitting(true);
      try {
        const baseUnits = parseUnits(amount, selectedAsset.decimals);
        const preRequests = [
          ...(!selectedAsset.onChainRegistered
            ? [buildRegisterAssetEvm(
                evmChainId,
                daoAddress,
                selectedAsset.mint,
                `0x${(selectedAsset.isStablecoin ? ZERO_PYTH_FEED : (selectedAsset.pythFeedHex || ZERO_PYTH_FEED)).replace(/^0x/i, '')}` as `0x${string}`,
                selectedAsset.isStablecoin,
                selectedAsset.assetKind,
              )]
            : []),
          ...(selectedAsset.symbol.toUpperCase() === 'WETH' && walletBalanceBaseUnits != null && baseUnits > walletBalanceBaseUnits
            ? [buildWrapEthEvm(evmChainId, selectedAsset.mint, baseUnits - walletBalanceBaseUnits)]
            : []),
        ];
        const outcome = await tx.sendEvm(
          await buildAllowanceSafeEvmDeposit(evmChainId, evmAddress, daoAddress, selectedAsset.mint, baseUnits, preRequests),
          { successLabel: `Deposited ${amount} ${selectedAsset.symbol}` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') { onDeposited?.(); onClose(); }
        else setDepositError(outcome.error || 'Deposit failed.');
      } catch (err) {
        setDepositError(err instanceof Error ? err.message : 'Failed to deposit.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!publicKey) { setDepositError('Connect your wallet first.'); return; }
    if (!selectedAsset) { setDepositError('Select a token to deposit.'); return; }
    if (!amountValid) { setDepositError('Enter an amount greater than zero.'); return; }
    if (walletBalance !== null && amountNum > walletBalance) {
      setDepositError(`You only have ${walletBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${selectedAsset.symbol} in your wallet.`);
      return;
    }
    if (walletBalance === 0) {
      setDepositError(`Your wallet has no ${selectedAsset.symbol}. Acquire some before depositing.`);
      return;
    }
    setSubmitting(true);
    try {
      const dao = new PublicKey(daoAddress);

      if (isNativeSol) {
        // Route through the deposit_sol instruction (not a raw SystemProgram
        // transfer) so the deposit resets on-chain NAV staleness and is
        // properly accounted for by revalue_treasury, rather than landing in
        // the vault_authority PDA as an untracked balance bump.
        const lamports = Math.round(amountNum * LAMPORTS_PER_SOL);
        const outcome = await tx.send(await buildDepositSol(dao, publicKey, lamports), {
          successLabel: `Deposited ${amount} SOL to treasury`,
        });
        if (outcome.status === 'success' || outcome.status === 'mock') {
          onDeposited?.();
          onClose();
        } else {
          setDepositError(outcome.error || 'Deposit failed.');
        }
        return;
      }

      const mintPk = new PublicKey(selectedMint);
      const depositorTokenAccount = getAssociatedTokenAddressSync(mintPk, publicKey, false);
      const baseUnits = BigInt(Math.round(amountNum * 10 ** selectedAsset.decimals));
      const result = await buildDepositToAsset(dao, publicKey, mintPk, depositorTokenAccount, baseUnits);
      const setup: TransactionInstruction[] = [
        createAssociatedTokenAccountIdempotentInstruction(publicKey, depositorTokenAccount, publicKey, mintPk),
      ];
      if (!selectedAsset.onChainRegistered) {
        const plan = getSolanaRegisterAssetPlan(selectedAsset.mint, selectedAsset.symbol, selectedAsset.name);
        if (plan.mode !== 'ready') {
          setDepositError('Send this token to the treasury address on the Receive tab. It shows up as soon as the transfer lands.');
          setSubmitting(false);
          return;
        }
        const registration = await buildRegisterAsset(
          dao,
          publicKey,
          mintPk,
          plan.pythFeedHex,
          plan.isStablecoin,
          plan.assetKind,
        );
        if (registration.instruction) setup.push(registration.instruction);
      }
      result.preInstructions = [...setup, ...(result.preInstructions ?? [])];
      const outcome = await tx.send(result, { successLabel: `Deposited ${amount} ${selectedAsset.symbol} to treasury` });
      if (outcome.status === 'success' || outcome.status === 'mock') {
        onDeposited?.();
        onClose();
      } else {
        setDepositError(outcome.error || 'Deposit failed.');
      }
    } catch (err) {
      setDepositError(err instanceof Error ? err.message : 'Failed to deposit.');
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: '14px',
    fontFamily: 'var(--font-mono)',
    padding: '11px 13px',
    borderRadius: '10px',
    border: '1px solid hsl(var(--border))',
    backgroundColor: '#ffffff',
    color: 'hsl(var(--foreground))',
    outline: 'none',
  };

  const modalTitle = preselectedAsset
    ? `Add funds — ${preselectedAsset.symbol}`
    : 'Add funds';

  const registerPrerequisiteMessage =
    chainKind === 'evm'
      ? 'Pick a supported token below, or use Receive to send funds to this treasury.'
      : 'Pick a token from your wallet, or use Receive to send funds to this treasury.';

  return (
    <NaveModal
      open
      title={modalTitle}
      subtitle="Deposit from your connected wallet, or send tokens to the treasury address."
      icon="arrow-down-to-bracket"
      onClose={onClose}
      maxWidth={480}
    >
      <div style={{ padding: '18px 22px 22px' }}>
        {/* Modal pill tabs (.mtabs) */}
        <div
          className="flex gap-1"
          style={{
            backgroundColor: 'hsl(var(--background))',
            border: '1px solid hsl(var(--surface-2))',
            borderRadius: '10px',
            padding: '3px',
            marginBottom: '18px',
          }}
        >
          {([
            { id: 'address' as const, label: 'Receive' },
            { id: 'wallet' as const, label: 'From Wallet' },
          ]).map((t) => {
            const active = tab === t.id;
            return (
              <button
                type="button"
                key={t.id}
                onClick={() => setTab(t.id)}
                className="flex-1 transition-all"
                style={{
                  padding: '7px 8px',
                  borderRadius: '8px',
                  fontSize: '12.5px',
                  fontWeight: active ? 600 : 500,
                  backgroundColor: active ? '#ffffff' : 'transparent',
                  color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  boxShadow: active ? '0 1px 3px rgba(17, 24, 39, 0.08)' : 'none',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === 'address' && (
          <div className="space-y-4">
            <p
              style={{
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
                lineHeight: 1.55,
                textAlign: 'center',
                margin: 0,
              }}
            >
              {!isSolana ? (
                <>Send tokens to {daoName ? <strong style={{ color: 'hsl(var(--foreground))' }}>{daoName}</strong> : 'this treasury'}.</>
              ) : splAddress ? (
                <>Send the treasury token to {daoName ? <strong style={{ color: 'hsl(var(--foreground))' }}>{daoName}</strong> : 'this treasury'}.</>
              ) : (
                <>Send SOL to {daoName ? <strong style={{ color: 'hsl(var(--foreground))' }}>{daoName}</strong> : 'this treasury'}.</>
              )}
            </p>
            <div
              className="mx-auto grid place-items-center p-3.5"
              style={{
                width: 'fit-content',
                backgroundColor: '#ffffff',
                border: '1px solid hsl(var(--border))',
                borderRadius: '12px',
              }}
            >
              <QRCodeSVG value={receiveAddress} size={156} level="M" />
            </div>
            <div
              className="flex items-center gap-2"
              style={{
                backgroundColor: 'hsl(var(--background))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '10px',
                padding: '11px 12px',
              }}
            >
              <code
                className="nave-mono truncate flex-1"
                style={{ fontSize: '11.5px', color: 'hsl(var(--foreground))' }}
              >
                {receiveAddress}
              </code>
              <button
                type="button"
                onClick={copyAddress}
                className="px-3 py-1.5 rounded-[8px] border font-semibold transition-colors flex-shrink-0"
                style={{
                  fontSize: '12px',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                  color: copied ? 'hsl(var(--success))' : 'hsl(var(--foreground))',
                }}
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <p
              style={{
                fontSize: '11.5px',
                color: 'hsl(var(--faint))',
                textAlign: 'center',
                margin: 0,
              }}
            >
              {copied ? 'Address copied to clipboard' : 'Deposits appear automatically once confirmed on-chain'}
            </p>
            {isSolana && splAddress && (
              <p
                style={{
                  fontSize: '11.5px',
                  color: 'hsl(var(--muted-foreground))',
                  lineHeight: 1.5,
                  textAlign: 'center',
                  margin: 0,
                }}
              >
                For native SOL, send to <span className="nave-mono">{shortenAddress(solAddress)}</span>.
              </p>
            )}
          </div>
        )}

        {tab === 'wallet' && (
          <div className="space-y-4">
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
              {chainKind === 'evm'
                ? 'Move tokens from your wallet into this treasury. First-time tokens are set up automatically.'
                : 'Move tokens from your wallet into this treasury.'}
            </p>
            {chainKind === 'evm' && (
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
                Native {nativeEvmBalance?.symbol ?? 'ETH'} balance:{' '}
                <strong className="nave-mono" style={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}>
                  {nativeEvmBalance ? Number(nativeEvmBalance.formatted).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}{' '}
                  {nativeEvmBalance?.symbol ?? 'ETH'}
                </strong>
                {isSelectedWeth ? '. Extra ETH is wrapped to WETH if needed.' : '.'}
              </div>
            )}

            {!hasAssets ? (
              <div
                style={{
                  backgroundColor: 'hsl(var(--background))',
                  border: '1px solid hsl(var(--surface-2))',
                  borderRadius: '12px',
                  padding: '12px 14px',
                  fontSize: '13px',
                  color: 'hsl(var(--muted-foreground))',
                  lineHeight: 1.55,
                }}
              >
                {registerPrerequisiteMessage}
              </div>
            ) : (
              <>
                {!preselectedAsset && (
                  <div>
                    <label
                      style={{
                        fontSize: '12.5px',
                        fontWeight: 600,
                        color: 'hsl(var(--foreground))',
                        marginBottom: '7px',
                        display: 'block',
                      }}
                    >
                      Token
                    </label>
                    <select
                      value={selectedMint}
                      onChange={(e) => {
                        setSelectedMint(e.target.value);
                        setAmount('');
                        setDepositError(null);
                      }}
                      style={{ ...inputStyle, fontFamily: 'var(--font-body)' }}
                    >
                      {selectableAssets.map((a) => (
                        <option key={a.mint} value={a.mint}>
                          {a.symbol} — {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <div className="flex items-center justify-between" style={{ marginBottom: '7px' }}>
                    <label
                      style={{
                        fontSize: '12.5px',
                        fontWeight: 600,
                        color: 'hsl(var(--foreground))',
                      }}
                    >
                      Amount
                    </label>
                    {selectedAsset && (
                      <div className="flex items-center gap-2">
                        <span
                          className="nave-mono"
                          style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}
                        >
                          {walletBalance === null
                            ? 'Checking balance…'
                            : `Balance: ${walletBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${selectedAsset.symbol}`}
                        </span>
                        {walletBalance !== null && walletBalance > 0 && (
                          <button
                            type="button"
                            onClick={() => setAmount(String(walletBalance))}
                            className="hover:underline underline-offset-2"
                            style={{
                              fontSize: '11px',
                              fontWeight: 600,
                              color: 'hsl(var(--brass))',
                              fontFamily: 'var(--font-mono)',
                            }}
                          >
                            MAX
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <input
                    type="number"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    style={inputStyle}
                  />
                  {amountValid && !withinBalance && (
                    <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', marginTop: '6px' }}>
                      Amount exceeds your wallet balance.
                    </p>
                  )}
                  {isSelectedWeth && wethDeficit > 0n && nativeCanCoverWethDeficit && (
                    <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '6px' }}>
                      This will wrap {formatUnits(wethDeficit, selectedAsset?.decimals ?? 18)} ETH to WETH before depositing.
                    </p>
                  )}
                </div>
              </>
            )}

            {depositError && (
              <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', lineHeight: 1.5, margin: 0 }}>
                {depositError}
              </p>
            )}

            <div
              className="flex items-center justify-end gap-2"
              style={{
                marginTop: '20px',
                paddingTop: '16px',
                borderTop: '1px solid hsl(var(--surface-2))',
              }}
            >
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-[9px] font-semibold"
                style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeposit}
                disabled={!canDeposit}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                  opacity: canDeposit ? 1 : 0.4,
                  cursor: canDeposit ? 'pointer' : 'not-allowed',
                }}
              >
                {submitting ? 'Adding funds…' : `Add funds${selectedAsset ? ` — ${selectedAsset.symbol}` : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </NaveModal>
  );
}

/** @deprecated Alias — use DepositFlowModal. */
export const DepositFundsModal = DepositFlowModal;

/** @deprecated Alias — use DepositFlowModal. */
export function ReceiveFundsModal(props: {
  daoAddress: string;
  daoName?: string;
  vaultMint?: string | null;
  onClose: () => void;
}) {
  return <DepositFlowModal {...props} registeredAssets={[]} />;
}

/** @deprecated Alias — use DepositFlowModal. */
export function DepositToVaultModal(props: {
  daoAddress: string;
  registeredAssets?: TreasuryAssetRow[];
  vaultMint?: string | null;
  decimals?: number;
  onClose: () => void;
  onDeposited?: () => void;
}) {
  return <DepositFlowModal {...props} initialTab="wallet" />;
}
