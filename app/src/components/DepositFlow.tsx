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

/** Inline QR + copy panel — QR-first receive flow. */
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
      className={`flex flex-col ${compact ? 'items-center text-center' : 'sm:flex-row sm:items-start'} gap-4 p-5 rounded-xl border`}
      style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
    >
      <div className="p-3 rounded-2xl flex-shrink-0" style={{ backgroundColor: 'white', border: '1px solid hsl(var(--border))' }}>
        <QRCodeSVG value={receiveAddress} size={compact ? 140 : 160} level="M" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Fund {daoName ?? 'your treasury'}
          </div>
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px', lineHeight: 1.55 }}>
            {!isSolana
              ? 'Send tokens to this address. They show up in Assets after the transfer lands.'
              : splAddress
                ? 'Send the treasury token to this address.'
                : 'Send SOL to this treasury address.'}
          </p>
          {isSolana && splAddress && (
            <p style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginTop: '6px' }}>
              Native SOL: <span className="nave-mono">{shortenAddress(solAddress)}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={copyAddress}
          className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg border transition-colors"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--background))' }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--background))')}
        >
          <span className="nave-mono truncate" style={{ fontSize: '11.5px', color: 'hsl(var(--foreground))' }}>
            {receiveAddress}
          </span>
          <Fi
            icon={copied ? 'circle-check' : 'copy'}
            style={{ fontSize: '12px', color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))', flexShrink: 0 }}
          />
        </button>
        <p style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
          {copied ? 'Address copied' : 'Scan the QR or tap to copy'}
        </p>
      </div>
    </div>
  );
}

/** Prominent deposit address banner with optional QR modal trigger. */
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
      className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3.5 rounded-xl border"
      style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
    >
      <div className="flex items-start gap-2.5 flex-1 min-w-0">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'hsl(var(--primary))' }}
        >
          <Fi icon="arrow-down-to-bracket" style={{ fontSize: '13px', color: 'white' }} />
        </div>
        <div className="min-w-0">
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            {splAddress ? 'Token deposit address' : 'Treasury deposit address'}
          </div>
          <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', lineHeight: 1.5 }}>
            {!isSolana
              ? 'Send any token to this address. It shows up in Assets as soon as the transfer lands.'
              : splAddress
                ? 'Send the treasury token here to fund this treasury. Only use Solana devnet.'
                : 'Send SOL here to fund this treasury. Only use Solana devnet.'}
          </p>
          {isSolana && splAddress && (
            <p style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginTop: '4px', lineHeight: 1.5 }}>
              For native SOL, use <span className="nave-mono">{shortenAddress(solAddress)}</span>.
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 w-full sm:w-auto sm:max-w-md">
        <button
          type="button"
          onClick={copy}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-colors"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--background))' }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--background))')}
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
            className="flex items-center justify-center px-3 py-2.5 rounded-lg border transition-colors"
            style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
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
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    padding: '10px 12px',
    borderRadius: '10px',
    border: '1px solid hsl(var(--border))',
    backgroundColor: 'hsl(var(--surface-0))',
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
    <NaveModal open title={modalTitle} icon="arrow-down-to-bracket" onClose={onClose} maxWidth={460}>
        <div
          className="flex border-b"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}
        >
          {([
            { id: 'address' as const, label: 'Receive', icon: 'qrcode' },
            { id: 'wallet' as const, label: 'From Wallet', icon: 'wallet' },
          ]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex items-center gap-1.5 px-5 py-3 flex-1 justify-center transition-colors"
              style={{
                fontSize: '13px',
                fontWeight: tab === t.id ? 600 : 400,
                color: tab === t.id ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                borderBottom: tab === t.id ? '2px solid hsl(var(--foreground))' : '2px solid transparent',
                backgroundColor: 'transparent',
              }}
            >
              <Fi icon={t.icon} style={{ fontSize: '12px' }} />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'address' && (
          <div className="p-5 flex flex-col items-center text-center space-y-4">
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
              {!isSolana
                ? <>Send tokens to {daoName ? <strong>{daoName}</strong> : 'this treasury'}.</>
                : splAddress
                  ? <>Send the treasury token to {daoName ? <strong>{daoName}</strong> : 'this treasury'}.</>
                  : <>Send SOL to {daoName ? <strong>{daoName}</strong> : 'this treasury'}.</>}
            </p>
            <div className="p-4 rounded-2xl" style={{ backgroundColor: 'white', border: '1px solid hsl(var(--border))' }}>
              <QRCodeSVG value={receiveAddress} size={176} level="M" />
            </div>
            <button
              onClick={copyAddress}
              className="w-full flex items-center justify-between gap-2 px-3.5 py-3 rounded-xl border transition-colors"
              style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            >
              <span className="nave-mono truncate" style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }}>
                {receiveAddress}
              </span>
              <Fi
                icon={copied ? 'circle-check' : 'copy'}
                style={{ fontSize: '13px', color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))', flexShrink: 0 }}
              />
            </button>
            <p style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
              {copied ? 'Address copied to clipboard' : 'Tap to copy the deposit address'}
            </p>
            {isSolana && splAddress && (
              <p style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                For native SOL, send to <span className="nave-mono">{shortenAddress(solAddress)}</span>.
              </p>
            )}
          </div>
        )}

        {tab === 'wallet' && (
          <div className="p-5 space-y-4">
            <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
              {chainKind === 'evm'
                ? 'Move tokens from your wallet into this treasury. First-time tokens are set up automatically.'
                : 'Move tokens from your wallet into this treasury.'}
            </p>
            {chainKind === 'evm' && (
              <div
                className="px-3 py-2.5 rounded-lg border"
                style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))', fontSize: '12px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}
              >
                Native {nativeEvmBalance?.symbol ?? 'ETH'} balance:{' '}
                <span className="nave-mono" style={{ color: 'hsl(var(--foreground))' }}>
                  {nativeEvmBalance ? Number(nativeEvmBalance.formatted).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'} {nativeEvmBalance?.symbol ?? 'ETH'}
                </span>
                {isSelectedWeth ? '. Extra ETH is wrapped to WETH if needed.' : '.'}
              </div>
            )}

            {!hasAssets ? (
              <div
                className="px-3 py-3 rounded-lg"
                style={{ backgroundColor: 'hsl(var(--warning-muted))', fontSize: '12.5px', color: 'hsl(38 50% 28%)', lineHeight: 1.5 }}
              >
                <Fi icon="triangle-exclamation" style={{ fontSize: '12px', marginRight: '6px' }} />
                {registerPrerequisiteMessage}
              </div>
            ) : (
              <>
                {!preselectedAsset && (
                  <div>
                    <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>Token</label>
                    <select
                      value={selectedMint}
                      onChange={e => { setSelectedMint(e.target.value); setAmount(''); setDepositError(null); }}
                      style={inputStyle}
                    >
                      {selectableAssets.map(a => (
                        <option key={a.mint} value={a.mint}>{a.symbol} — {a.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {selectedAsset && (
                  <div className="flex items-center justify-between">
                    <span style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
                      {walletBalance === null
                        ? 'Checking balance…'
                        : `Your wallet: ${walletBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${selectedAsset.symbol}`}
                    </span>
                    {walletBalance !== null && walletBalance > 0 && (
                      <button type="button" onClick={() => setAmount(String(walletBalance))}
                        style={{ fontSize: '11px', color: 'hsl(var(--primary))', fontFamily: 'var(--font-mono)' }}>
                        MAX
                      </button>
                    )}
                  </div>
                )}
                <div>
                  <label className="nave-label" style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>Amount</label>
                  <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
                  {amountValid && !withinBalance && (
                    <p style={{ fontSize: '11.5px', color: 'hsl(var(--destructive))', marginTop: '4px' }}>Amount exceeds your wallet balance.</p>
                  )}
                  {isSelectedWeth && wethDeficit > 0n && nativeCanCoverWethDeficit && (
                    <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px' }}>
                      This will wrap {formatUnits(wethDeficit, selectedAsset?.decimals ?? 18)} ETH to WETH before depositing.
                    </p>
                  )}
                </div>
              </>
            )}

            {depositError && (
              <div className="px-3 py-2.5 rounded-lg" style={{ backgroundColor: 'hsl(var(--destructive-muted))', fontSize: '12px', color: 'hsl(0 60% 40%)', lineHeight: 1.4 }}>
                {depositError}
              </div>
            )}

            <button
              onClick={handleDeposit}
              disabled={!canDeposit}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium transition-all"
              style={{
                fontSize: '14px',
                backgroundColor: canDeposit ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                color: canDeposit ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                cursor: canDeposit ? 'pointer' : 'not-allowed',
              }}
            >
              <Fi icon="arrow-down-to-bracket" style={{ fontSize: '13px' }} />
              {submitting ? 'Adding funds…' : `Add funds${selectedAsset ? ` — ${selectedAsset.symbol}` : ''}`}
            </button>
          </div>
        )}
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
