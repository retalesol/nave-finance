import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { supabase } from '../lib/supabaseClient';
import { founderMetadata, type DaoAccessMessageSigner } from '../lib/edgeFunctionClient';
import { getBalance, readContract } from '@wagmi/core';
import { formatUnits, getAddress, type Address } from 'viem';
import { fetchRegisteredAssets, fetchTreasuryVault, getConnection, type RegisteredAssetView } from '../lib/onChainFetcher';
import { fetchNavEvm, fetchDeployedCapitalEvm, fetchRegisteredAssetsEvm } from '../lib/evm/readers';
import { Erc20Abi } from '../lib/evm/contracts';
import { wagmiConfig } from '../lib/evm/wagmi';
import { evmAllowedAssets, type EvmAllowedAsset } from '../lib/allowedAssets';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress, type EvmChainId } from '../lib/chain/types';
import { recallDaoChainId } from '../lib/chain/daoChainMemory';
import { useChain } from './useChain';
import { isMockDaoAddress } from '../lib/mockData';
import { getVaultAuthorityPDA } from '../lib/pdaDerivation';
import { discoverErc20ContractAddressesFromTreasuryActivity } from '../lib/evmTreasuryTokenDiscovery';

/** Known mint → display symbol/name (devnet + mainnet). Falls back to a
 *  truncated mint for unknown assets. */
const KNOWN_MINTS: Record<string, { symbol: string; name: string }> = {
  SOL: { symbol: 'SOL', name: 'Solana' },
  So11111111111111111111111111111111111111112: { symbol: 'wSOL', name: 'Wrapped SOL' },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin' },
  Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr: { symbol: 'USDC', name: 'USD Coin (devnet)' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether USD' },
};

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const ASSET_KIND_LABEL: Record<number, string> = { 0: 'Stablecoin', 1: 'SOL-like', 2: 'Other' };

export interface TreasuryAssetRow extends RegisteredAssetView {
  symbol: string;
  name: string;
  assetKindLabel: string;
  priceUsd: number | null;
  priceSource: string;
  /** Live idle balance in UI units (vault balance / 10^decimals). */
  uiBalance: number;
  /** USD micro-units → USD. From the last on-chain revalue_treasury. */
  valueUsd: number;
  /** Share of total on-chain NAV (0..100). */
  allocationPct: number;
  /**
   * True when the asset is registered for treasury accounting on-chain
   * (Solana `AssetConfig`, EVM `registerAsset`). Held-but-unregistered tokens
   * still appear for visibility but cannot execute governance transfers until registered.
   */
  onChainRegistered: boolean;
}

interface UseTreasuryAssetsResult {
  /** All detected assets (visible + hidden), unchanged for existing callers. */
  assets: TreasuryAssetRow[];
  /** Assets not in the DAO's hidden set (spam/dust filter). */
  visibleAssets: TreasuryAssetRow[];
  /** Assets the DAO has hidden from the default view. */
  hiddenAssets: TreasuryAssetRow[];
  /** Authoritative on-chain USD NAV (micro-USD → USD), or null if unavailable. */
  onchainNavUsd: number | null;
  /** Deployed capital in USD (micro-USD → USD). */
  deployedUsd: number | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Hide an asset for the whole DAO. The founder signs the challenge. */
  hideAsset: (identifier: string, wallet: string, signChallenge: DaoAccessMessageSigner) => Promise<{ error: string | null }>;
  /** Unhide a previously-hidden asset. The founder signs the challenge. */
  unhideAsset: (identifier: string, wallet: string, signChallenge: DaoAccessMessageSigner) => Promise<{ error: string | null }>;
}

/** Map the active chain to the dao_hidden_assets.chain discriminator. */
function hiddenChainFor(daoAddress: string, evmChainId: EvmChainId | null): string {
  if (chainKindFromAddress(daoAddress) !== 'evm') return 'solana';
  const cid = (evmChainId ?? recallDaoChainId(daoAddress)) as number | null;
  if (cid === 8453 || cid === 84532) return 'base';
  if (cid === 4663 || cid === 46630) return 'robinhood';
  if (cid === 5042 || cid === 5042002) return 'arc';
  return 'ethereum';
}

function symbolFor(mint: string): { symbol: string; name: string } {
  return KNOWN_MINTS[mint] || { symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`, name: 'Unknown asset' };
}

type DexToken = {
  tokenAddress?: string;
  priceUsd?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  liquidity?: { usd?: number };
};

async function fetchDexScreenerPrices(mints: string[]): Promise<Map<string, { priceUsd: number; symbol?: string; name?: string }>> {
  const unique = Array.from(new Set(mints.filter((m) => m && m !== 'SOL')));
  const prices = new Map<string, { priceUsd: number; symbol?: string; name?: string }>();
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`);
      if (!res.ok) continue;
      const rows = (await res.json()) as DexToken[];
      for (const row of rows) {
        const address = row.tokenAddress ?? row.baseToken?.address;
        const price = Number(row.priceUsd);
        if (address && Number.isFinite(price) && price > 0) {
          const prev = prices.get(address);
          if (!prev || (row.liquidity?.usd ?? 0) > 0) {
            prices.set(address, {
              priceUsd: price,
              symbol: row.baseToken?.symbol,
              name: row.baseToken?.name,
            });
          }
        }
      }
    } catch {
      // External market data is best-effort; balances should still render.
    }
  }
  return prices;
}

async function fetchDexScreenerPricesForChain(
  chain: 'solana' | 'ethereum' | 'base',
  addresses: string[],
): Promise<Map<string, { priceUsd: number; symbol?: string; name?: string }>> {
  const unique = Array.from(new Set(addresses.filter(Boolean).map((a) => a.toLowerCase())));
  const prices = new Map<string, { priceUsd: number; symbol?: string; name?: string }>();
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chain}/${batch.join(',')}`);
      if (!res.ok) continue;
      const rows = (await res.json()) as DexToken[];
      for (const row of rows) {
        const address = (row.tokenAddress ?? row.baseToken?.address)?.toLowerCase();
        const price = Number(row.priceUsd);
        if (address && Number.isFinite(price) && price > 0) {
          prices.set(address, {
            priceUsd: price,
            symbol: row.baseToken?.symbol,
            name: row.baseToken?.name,
          });
        }
      }
    } catch {
      // External market data is best-effort; balances should still render.
    }
  }
  return prices;
}

function evmAssetKind(asset: EvmAllowedAsset): number {
  if (asset.assetClass === 'stablecoin') return 0;
  if (asset.assetClass === 'sol-like' || asset.symbol.toUpperCase().includes('ETH')) return 1;
  return 2;
}

function toUiAmount(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

interface TreasuryAssetsData {
  assets: TreasuryAssetRow[];
  onchainNavUsd: number | null;
  deployedUsd: number | null;
}

/**
 * Core treasury-assets fetch, extracted so it can be driven by React Query.
 * Throws on failure so callers get `isError`/`error` from the query instead
 * of a silently empty asset list.
 */
async function fetchTreasuryAssetsData(
  daoAddress: string,
  evmChainId: EvmChainId | null,
): Promise<TreasuryAssetsData> {
    // EVM DAOs (0x…): read portfolio-level NAV/deployed capital from the
    // treasury, then use the curated EVM allowlist as an index to discover
    // non-zero ERC-20 balances held by the treasury contract.
    if (chainKindFromAddress(daoAddress) === 'evm') {
        if (!evmChainId) {
          return { assets: [], onchainNavUsd: null, deployedUsd: null };
        }
        const chainId = evmChainId;
        const allowed = evmAllowedAssets(chainId);
        const dexChain =
          chainId === 8453 || chainId === 84532
            ? 'base'
            : 'ethereum'; // Robinhood WETH priced via Ethereum DexScreener (same asset)
        const [navMicro, deployedMicro, nativeBalance, registeredAssets] = await Promise.all([
          fetchNavEvm(chainId, daoAddress),
          fetchDeployedCapitalEvm(chainId, daoAddress),
          getBalance(wagmiConfig, { address: daoAddress as Address, chainId }).catch(() => null),
          fetchRegisteredAssetsEvm(chainId, daoAddress),
        ]);
        const allowedByAddress = new Map(allowed.map((asset) => [asset.address.toLowerCase(), asset]));
        const registeredByAddress = new Map(registeredAssets.map((r) => [r.address.toLowerCase(), r]));
        let rows: TreasuryAssetRow[] = registeredAssets.map((registered) => {
          const asset = allowedByAddress.get(registered.address.toLowerCase());
          const balance = registered.idleBalance;
          const uiBalance = toUiAmount(balance, registered.decimals);
          const onchainPriceUsd =
            registered.unitPriceUsdMicro != null && registered.unitPriceUsdMicro > 0
              ? registered.unitPriceUsdMicro / 1_000_000
              : null;
          const priceUsd = registered.isStablecoin ? 1 : onchainPriceUsd;
          const valueUsd =
            registered.valuedUsdMicro != null && registered.valuedUsdMicro > 0
              ? registered.valuedUsdMicro / 1_000_000
              : priceUsd != null
                ? uiBalance * priceUsd
                : 0;
          const row: TreasuryAssetRow = {
            mint: registered.address,
            decimals: registered.decimals,
            pythFeedHex: registered.pythFeedHex,
            isStablecoin: registered.isStablecoin,
            assetKind: registered.assetKind,
            enabled: registered.enabled,
            deposited: 0,
            deployedCapital: 0,
            lastValuedUsd: registered.valuedUsdMicro ?? Math.round(valueUsd * 1_000_000),
            lastValuedAt: 0,
            vaultBalanceBaseUnits: 0,
            assetVault: daoAddress,
            symbol: asset?.symbol ?? `${registered.address.slice(0, 6)}…${registered.address.slice(-4)}`,
            name: asset?.name ?? 'Registered ERC-20 asset',
            assetKindLabel: ASSET_KIND_LABEL[registered.assetKind] ?? 'Other',
            priceUsd,
            priceSource: registered.isStablecoin
              ? 'Stablecoin parity'
              : priceUsd != null
                ? 'On-chain valuation'
                : 'Unpriced',
            uiBalance,
            valueUsd,
            allocationPct: 0,
            onChainRegistered: registered.registered,
          };
          return row;
        });

        // Backwards-compatible fallback for older test deployments that do not
        // expose getRegisteredAssets yet: detect non-zero allowlisted balances.
        if (rows.length === 0) {
          const balances = await Promise.all(
            allowed.map(async (asset) => {
              try {
                const balance = await readContract(wagmiConfig, {
                  address: asset.address as Address,
                  abi: Erc20Abi,
                  functionName: 'balanceOf',
                  args: [daoAddress as Address],
                  chainId,
                });
                return balance as bigint;
              } catch {
                return 0n;
              }
            }),
          );
          rows = allowed
            .map((asset, idx) => {
              const balance = balances[idx] ?? 0n;
              if (balance <= 0n) return null;
              const uiBalance = toUiAmount(balance, asset.decimals);
              const priceUsd = asset.assetClass === 'stablecoin' ? 1 : null;
              const valueUsd = priceUsd != null ? uiBalance * priceUsd : 0;
              const assetKind = evmAssetKind(asset);
              const row: TreasuryAssetRow = {
                mint: asset.address,
                decimals: asset.decimals,
                pythFeedHex: '0'.repeat(64),
                isStablecoin: asset.assetClass === 'stablecoin',
                assetKind,
                enabled: true,
                deposited: 0,
                deployedCapital: 0,
                lastValuedUsd: Math.round(valueUsd * 1_000_000),
                lastValuedAt: 0,
                vaultBalanceBaseUnits: 0,
                assetVault: daoAddress,
                symbol: asset.symbol,
                name: asset.name,
                assetKindLabel: ASSET_KIND_LABEL[assetKind] ?? 'Other',
                priceUsd,
                priceSource: priceUsd != null ? 'Stablecoin parity' : 'Unpriced',
                uiBalance,
                valueUsd,
                allocationPct: 0,
                onChainRegistered: false,
              };
              return row;
            })
            .filter((row): row is TreasuryAssetRow => row !== null);
        }

        const wrappedNative = allowed.find((asset) => asset.symbol.toUpperCase() === 'WETH');

        // Arc native balance is 18-decimal gas USDC, not a treasury asset.
        // Treasury USDC is the 6-decimal ERC-20 at 0x3600…0000.
        if (chainId !== 5042002 && nativeBalance && nativeBalance.value > 0n) {
          const uiBalance = toUiAmount(nativeBalance.value, nativeBalance.decimals);
          rows.unshift({
            mint: 'ETH',
            decimals: nativeBalance.decimals,
            pythFeedHex: '0'.repeat(64),
            isStablecoin: false,
            assetKind: 1,
            enabled: false,
            deposited: 0,
            deployedCapital: 0,
            lastValuedUsd: 0,
            lastValuedAt: 0,
            vaultBalanceBaseUnits: 0,
            assetVault: daoAddress,
            symbol: nativeBalance.symbol || 'ETH',
            name: 'Native Ether (direct transfer)',
            assetKindLabel: 'ETH-like',
            priceUsd: null,
            priceSource: 'Unpriced',
            uiBalance,
            valueUsd: 0,
            allocationPct: 0,
            onChainRegistered: false,
          });
        }

        // Inbound ERC-20 discovery via Etherscan (optional `VITE_ETHERSCAN_API_KEY`).
        const etherscanKey =
          typeof import.meta.env.VITE_ETHERSCAN_API_KEY === 'string'
            ? import.meta.env.VITE_ETHERSCAN_API_KEY
            : undefined;
        const discoveredAddrs = await discoverErc20ContractAddressesFromTreasuryActivity(
          chainId as EvmChainId,
          daoAddress,
          etherscanKey,
        );
        const haveAddr = new Set(rows.map((r) => r.mint.toLowerCase()));
        for (const raw of discoveredAddrs) {
          let checksum: Address;
          try {
            checksum = getAddress(raw);
          } catch {
            continue;
          }
          if (haveAddr.has(checksum.toLowerCase())) continue;
          try {
            const balance = (await readContract(wagmiConfig, {
              address: checksum,
              abi: Erc20Abi,
              functionName: 'balanceOf',
              args: [daoAddress as Address],
              chainId,
            })) as bigint;
            if (balance <= 0n) continue;
            const [decRaw, symRaw, nameRaw] = await Promise.all([
              readContract(wagmiConfig, {
                address: checksum,
                abi: Erc20Abi,
                functionName: 'decimals',
                chainId,
              }),
              readContract(wagmiConfig, {
                address: checksum,
                abi: Erc20Abi,
                functionName: 'symbol',
                chainId,
              }).catch(() => null),
              readContract(wagmiConfig, {
                address: checksum,
                abi: Erc20Abi,
                functionName: 'name',
                chainId,
              }).catch(() => null),
            ]);
            const decimals = Number(decRaw ?? 18);
            const uiBalance = toUiAmount(balance, decimals);
            const symbol =
              typeof symRaw === 'string' ? symRaw : `${checksum.slice(0, 6)}…${checksum.slice(-4)}`;
            const name = typeof nameRaw === 'string' ? nameRaw : 'Discovered ERC-20';
            rows.push({
              mint: checksum,
              decimals,
              pythFeedHex: '0'.repeat(64),
              isStablecoin: false,
              assetKind: 2,
              enabled: false,
              deposited: 0,
              deployedCapital: 0,
              lastValuedUsd: 0,
              lastValuedAt: 0,
              vaultBalanceBaseUnits: 0,
              assetVault: daoAddress,
              symbol,
              name,
              assetKindLabel: ASSET_KIND_LABEL[2] ?? 'Other',
              priceUsd: null,
              priceSource: 'Unpriced',
              uiBalance,
              valueUsd: 0,
              allocationPct: 0,
              onChainRegistered: false,
            });
            haveAddr.add(checksum.toLowerCase());
          } catch {
            // Non-standard ERC-20 or RPC flake — skip.
          }
        }

        const dexMintSet = new Set<string>();
        for (const r of rows) {
          if (/^0x[0-9a-fA-F]{40}$/i.test(r.mint)) {
            try {
              dexMintSet.add(getAddress(r.mint).toLowerCase());
            } catch {
              dexMintSet.add(r.mint.toLowerCase());
            }
          }
        }
        if (wrappedNative) dexMintSet.add(wrappedNative.address.toLowerCase());

        const prices = await fetchDexScreenerPricesForChain(dexChain, [...dexMintSet]);

        for (const row of rows) {
          if (row.mint === 'ETH' && wrappedNative) {
            const p = prices.get(wrappedNative.address.toLowerCase());
            const wethReg = registeredByAddress.get(wrappedNative.address.toLowerCase());
            const wethOnchainPrice =
              wethReg?.unitPriceUsdMicro != null && wethReg.unitPriceUsdMicro > 0
                ? wethReg.unitPriceUsdMicro / 1_000_000
                : null;
            if (p && Number.isFinite(p.priceUsd) && p.priceUsd > 0) {
              row.priceUsd = p.priceUsd;
              row.priceSource = 'DexScreener (WETH proxy)';
              row.valueUsd = row.uiBalance * p.priceUsd;
              row.lastValuedUsd = Math.round(row.valueUsd * 1_000_000);
            } else if (wethOnchainPrice != null && wethOnchainPrice > 0) {
              row.priceUsd = wethOnchainPrice;
              row.priceSource = 'On-chain valuation';
              row.valueUsd = row.uiBalance * wethOnchainPrice;
              row.lastValuedUsd = Math.round(row.valueUsd * 1_000_000);
            }
            continue;
          }
          if (!/^0x[0-9a-fA-F]{40}$/i.test(row.mint)) continue;
          const lo = row.mint.toLowerCase();
          const p = prices.get(lo);
          if (row.isStablecoin) {
            row.priceUsd = 1;
            row.priceSource = 'Stablecoin parity';
            row.valueUsd = row.uiBalance;
            row.lastValuedUsd = Math.round(row.valueUsd * 1_000_000);
            continue;
          }
          if (p && Number.isFinite(p.priceUsd) && p.priceUsd > 0) {
            row.priceUsd = p.priceUsd;
            row.priceSource = 'DexScreener';
            if (typeof p.symbol === 'string' && p.symbol) row.symbol = p.symbol;
            if (typeof p.name === 'string' && p.name) row.name = p.name;
            row.valueUsd = row.uiBalance * p.priceUsd;
            row.lastValuedUsd = Math.round(row.valueUsd * 1_000_000);
            continue;
          }
          // Fallback to on-chain treasury valuation (valueAssetUsd / lastValuedUsd)
          // when DexScreener does not index the token (e.g. Robinhood Testnet WETH).
          if (row.priceUsd == null && row.uiBalance > 0) {
            try {
              const rawUnits = BigInt(Math.round(row.uiBalance * Math.pow(10, row.decimals)));
              const valuedMicro = (await readContract(wagmiConfig, {
                address: daoAddress as Address,
                abi: [
                  {
                    type: 'function',
                    name: 'valueAssetUsd',
                    stateMutability: 'view',
                    inputs: [{ type: 'address' }, { type: 'uint256' }],
                    outputs: [{ type: 'uint256' }],
                  },
                ] as const,
                functionName: 'valueAssetUsd',
                args: [row.mint as Address, rawUnits],
                chainId,
              })) as bigint;
              if (valuedMicro > 0n) {
                const valUsd = Number(valuedMicro) / 1_000_000;
                row.valueUsd = valUsd;
                row.priceUsd = valUsd / row.uiBalance;
                row.priceSource = 'On-chain valuation';
                row.lastValuedUsd = Number(valuedMicro);
              }
            } catch {
              // Asset not registered or oracle unavailable — leave unpriced.
            }
          }
        }

        const totalValue = rows.reduce((sum, row) => sum + row.valueUsd, 0);
        const resolvedNavUsd =
          navMicro != null && navMicro > 0
            ? navMicro / 1_000_000
            : totalValue > 0
              ? totalValue
              : null;
        return {
          assets: rows.map((row) => ({
            ...row,
            allocationPct: totalValue > 0 ? (row.valueUsd / totalValue) * 100 : 0,
          })),
          onchainNavUsd: resolvedNavUsd,
          deployedUsd: deployedMicro != null ? deployedMicro / 1_000_000 : null,
        };
    }

    if (!isProgramConfigured()) {
      return { assets: [], onchainNavUsd: null, deployedUsd: null };
    }

    {
      const daoPubkey = new PublicKey(daoAddress);
      const conn = getConnection();
      const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
      const [registered, vault] = await Promise.all([
        fetchRegisteredAssets(daoPubkey),
        fetchTreasuryVault(daoPubkey),
      ]);
      const registeredByMint = new Map(registered.map((asset) => [asset.mint, asset]));

      const tokenAccounts = await conn.getParsedTokenAccountsByOwner(vaultAuthority, {
        programId: TOKEN_PROGRAM_ID,
      });
      const depositedRows: RegisteredAssetView[] = tokenAccounts.value
        .map(({ pubkey, account }) => {
          const parsed = account.data.parsed;
          const info = parsed?.info;
          const mint = String(info?.mint ?? '');
          const tokenAmount = info?.tokenAmount;
          const amount = Number(tokenAmount?.amount ?? 0);
          if (!mint || !Number.isFinite(amount) || amount <= 0) return null;
          const registeredAsset = registeredByMint.get(mint);
          return {
            mint,
            decimals: Number(tokenAmount?.decimals ?? registeredAsset?.decimals ?? 0),
            pythFeedHex: registeredAsset?.pythFeedHex ?? '0'.repeat(64),
            isStablecoin: registeredAsset?.isStablecoin ?? false,
            assetKind: registeredAsset?.assetKind ?? 2,
            enabled: registeredAsset ? registeredAsset.enabled : false,
            deposited: registeredAsset?.deposited ?? amount,
            deployedCapital: registeredAsset?.deployedCapital ?? 0,
            lastValuedUsd: registeredAsset?.lastValuedUsd ?? 0,
            lastValuedAt: registeredAsset?.lastValuedAt ?? 0,
            vaultBalanceBaseUnits: amount,
            assetVault: registeredAsset?.assetVault ?? pubkey.toBase58(),
          } satisfies RegisteredAssetView;
        })
        .filter((row): row is RegisteredAssetView => row !== null);

      const solLamports = await conn.getBalance(vaultAuthority);
      if (solLamports > 0) {
        depositedRows.unshift({
          mint: 'SOL',
          decimals: 9,
          pythFeedHex: '0'.repeat(64),
          isStablecoin: false,
          assetKind: 1,
          enabled: false,
          deposited: solLamports,
          deployedCapital: 0,
          lastValuedUsd: 0,
          lastValuedAt: 0,
          vaultBalanceBaseUnits: solLamports,
          assetVault: vaultAuthority.toBase58(),
        });
      }

      const allByMint = new Map<string, RegisteredAssetView>();
      for (const asset of registered) allByMint.set(asset.mint, asset);
      for (const asset of depositedRows) allByMint.set(asset.mint, asset);
      const discovered = Array.from(allByMint.values());
      const prices = await fetchDexScreenerPrices(discovered.map((a) => (a.mint === 'SOL' ? WSOL_MINT : a.mint)));

      const navUsd = vault && vault.currentNav > 0 ? vault.currentNav / 1_000_000 : null;
      let onchainNavUsd = navUsd;
      const deployedUsd = vault ? vault.deployedCapital / 1_000_000 : null;

      const navMicro = vault ? vault.currentNav : 0;
      const rows: TreasuryAssetRow[] = discovered.map((a) => {
        const known = symbolFor(a.mint);
        const priceKey = a.mint === 'SOL' ? WSOL_MINT : a.mint;
        const market = prices.get(priceKey);
        const isStable = a.isStablecoin || known.symbol === 'USDC' || known.symbol === 'USDT';
        const priceUsd = isStable ? 1 : market?.priceUsd ?? null;
        const balance = a.vaultBalanceBaseUnits / Math.pow(10, a.decimals);
        const valueUsd = a.lastValuedUsd > 0
          ? a.lastValuedUsd / 1_000_000
          : priceUsd != null ? balance * priceUsd : 0;
        const onChainRegistered = a.mint === 'SOL' ? false : registeredByMint.has(a.mint);
        return {
          ...a,
          symbol: market?.symbol ?? known.symbol,
          name: market?.name ?? known.name,
          assetKindLabel: ASSET_KIND_LABEL[a.assetKind] ?? 'Other',
          priceUsd,
          priceSource: a.lastValuedUsd > 0 ? 'On-chain valuation' : priceUsd != null ? (isStable ? 'Stablecoin parity' : 'DexScreener') : 'Unpriced',
          uiBalance: balance,
          valueUsd,
          allocationPct: navMicro > 0 ? (a.lastValuedUsd / navMicro) * 100 : 0,
          onChainRegistered,
        };
      });
      const estimatedNav = rows.reduce((sum, row) => sum + row.valueUsd, 0);
      if (navMicro <= 0 && estimatedNav > 0) {
        rows.forEach((row) => {
          row.allocationPct = (row.valueUsd / estimatedNav) * 100;
        });
      }
      if (navUsd == null && estimatedNav > 0) {
        onchainNavUsd = estimatedNav;
      }
      return { assets: rows.sort((a, b) => b.valueUsd - a.valueUsd), onchainNavUsd, deployedUsd };
    }
}

/**
 * Multi-asset treasury view sourced from on-chain state: enumerates the DAO's
 * registered AssetConfig accounts, joins each with its TreasuryAsset accounting
 * (USD micro-units from the last revalue_treasury) + live vault balance, and
 * reads the portfolio-level TreasuryVault NAV.
 *
 * Backed by React Query so the several screens reading the same DAO's assets
 * (dashboard, assets page, policy engine) share one cached fetch per
 * `daoAddress` instead of each mount re-issuing the full RPC/DexScreener chain.
 */
export function useTreasuryAssets(daoAddress: string | null): UseTreasuryAssetsResult {
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId, chainFamily } = useChain();
  const queryClient = useQueryClient();

  const assetsQuery = useQuery({
    queryKey: ['treasuryAssets', daoAddress, evmChainId],
    queryFn: () => fetchTreasuryAssetsData(daoAddress as string, evmChainId),
    enabled: !!daoAddress && !isMock,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const hiddenChain = daoAddress ? hiddenChainFor(daoAddress, evmChainId) : null;
  const hiddenQueryKey = ['hiddenTreasuryAssets', daoAddress, hiddenChain] as const;
  const hiddenQuery = useQuery({
    queryKey: hiddenQueryKey,
    queryFn: async (): Promise<Set<string>> => {
      const daoKey = chainKindFromAddress(daoAddress as string) === 'evm'
        ? (daoAddress as string).toLowerCase()
        : daoAddress as string;
      const { data, error: hErr } = await supabase
        .from('dao_hidden_assets')
        .select('asset_identifier')
        .eq('dao_onchain_address', daoKey)
        .eq('chain', hiddenChain as string);
      if (hErr) return new Set<string>();
      return new Set((data ?? []).map((r: { asset_identifier: string }) => r.asset_identifier));
    },
    enabled: !!daoAddress && !isMock,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  const refetch = useCallback(() => {
    void assetsQuery.refetch();
  }, [assetsQuery]);

  const hideAsset = useCallback(async (
    identifier: string,
    wallet: string,
    signChallenge: DaoAccessMessageSigner,
  ): Promise<{ error: string | null }> => {
    if (!daoAddress) return { error: 'No DAO selected' };
    const chain = hiddenChainFor(daoAddress, evmChainId);
    const { error: insErr } = await founderMetadata({
      action: 'hide_asset',
      daoAddress,
      wallet,
      signChallenge,
      chain: chainFamily,
      chainId: evmChainId,
      assetChain: chain,
      assetIdentifier: identifier,
    });
    if (insErr) return { error: insErr };
    await queryClient.invalidateQueries({ queryKey: ['hiddenTreasuryAssets', daoAddress] });
    return { error: null };
  }, [daoAddress, evmChainId, chainFamily, queryClient]);

  const unhideAsset = useCallback(async (
    identifier: string,
    wallet: string,
    signChallenge: DaoAccessMessageSigner,
  ): Promise<{ error: string | null }> => {
    if (!daoAddress) return { error: 'No DAO selected' };
    const chain = hiddenChainFor(daoAddress, evmChainId);
    const { error: delErr } = await founderMetadata({
      action: 'unhide_asset',
      daoAddress,
      wallet,
      signChallenge,
      chain: chainFamily,
      chainId: evmChainId,
      assetChain: chain,
      assetIdentifier: identifier,
    });
    if (delErr) return { error: delErr };
    await queryClient.invalidateQueries({ queryKey: ['hiddenTreasuryAssets', daoAddress] });
    return { error: null };
  }, [daoAddress, evmChainId, chainFamily, queryClient]);

  const rawAssets = assetsQuery.data?.assets;
  const assets = useMemo(
    () => (daoAddress && !isMock ? rawAssets ?? [] : []),
    [daoAddress, isMock, rawAssets],
  );
  const hiddenSet = useMemo(() => hiddenQuery.data ?? new Set<string>(), [hiddenQuery.data]);

  const { visibleAssets, hiddenAssets } = useMemo(() => {
    const visible: TreasuryAssetRow[] = [];
    const hidden: TreasuryAssetRow[] = [];
    for (const a of assets) {
      if (hiddenSet.has(a.mint)) hidden.push(a);
      else visible.push(a);
    }
    return { visibleAssets: visible, hiddenAssets: hidden };
  }, [assets, hiddenSet]);

  if (!daoAddress || isMock) {
    return {
      assets: [],
      visibleAssets: [],
      hiddenAssets: [],
      onchainNavUsd: null,
      deployedUsd: null,
      loading: false,
      error: null,
      refetch,
      hideAsset,
      unhideAsset,
    };
  }

  return {
    assets,
    visibleAssets,
    hiddenAssets,
    onchainNavUsd: assetsQuery.data?.onchainNavUsd ?? null,
    deployedUsd: assetsQuery.data?.deployedUsd ?? null,
    loading: assetsQuery.isFetching,
    error: assetsQuery.isError
      ? (assetsQuery.error instanceof Error ? assetsQuery.error.message : 'Failed to fetch treasury assets')
      : null,
    refetch,
    hideAsset,
    unhideAsset,
  };
}
