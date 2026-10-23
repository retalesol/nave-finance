import { getAccount, switchChain } from '@wagmi/core';
import { numberToHex } from 'viem';
import type { EvmChainId } from '../chain/types';
import { classifyChainSwitchError } from './chainSwitchError';
import { walletRpcHint } from './walletRpcError';
import { wagmiConfig, WAGMI_CHAIN_BY_ID } from './wagmi';

type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, cb: (chainId: string) => void) => void;
  removeListener?: (event: string, cb: (chainId: string) => void) => void;
};

function ethereumProvider(): EthProvider | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { ethereum?: EthProvider }).ethereum ?? null;
}

export function chainNameForId(chainId: number): string {
  return WAGMI_CHAIN_BY_ID[chainId as EvmChainId]?.name ?? `chain ${chainId}`;
}

/** eth_chainId should be instant. A dead wallet RPC (Arc's retired host) never answers. */
const WALLET_CHAIN_ID_TIMEOUT_MS = 8_000;
/** A real switch prompt can sit while the founder approves it. */
const WALLET_SWITCH_TIMEOUT_MS = 45_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('wallet-rpc-timeout')), ms);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isWalletRpcTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === 'wallet-rpc-timeout';
}

async function providerChainId(provider: EthProvider | null): Promise<number | null> {
  if (!provider) return null;
  try {
    const hex = await withTimeout(
      provider.request({ method: 'eth_chainId' }),
      WALLET_CHAIN_ID_TIMEOUT_MS,
    );
    if (typeof hex === 'string' && /^0x[0-9a-fA-F]+$/.test(hex)) {
      return Number.parseInt(hex, 16);
    }
  } catch {
    // Provider locked, busy, or its saved RPC never answered.
  }
  return null;
}

/**
 * Chain id reported by the active wagmi connector. `getAccount().chainId` is the
 * connection record and can say Sepolia while MetaMask is still on Arc.
 */
async function readConnectorChainId(): Promise<number | null> {
  // The provider's eth_chainId is the network the next transaction will hit.
  // connector.getChainId() can stay on the chain wagmi last recorded after a
  // switch that the wallet never finished, and a factory address from another
  // chain then reverts Unauthorized (0x82b42900).
  const connector = getAccount(wagmiConfig).connector;
  if (connector && typeof connector.getProvider === 'function') {
    try {
      const provider = await connector.getProvider() as EthProvider | undefined;
      const id = await providerChainId(provider ?? null);
      if (id != null) return id;
    } catch {
      // Fall through.
    }
  }
  const injected = await providerChainId(ethereumProvider());
  if (injected != null) return injected;
  if (connector) {
    try {
      return await connector.getChainId();
    } catch {
      // No live chain id.
    }
  }
  return null;
}

/** Make wagmi's connection record match the chain the connector is actually on. */
function syncWagmiChain(chainId: number) {
  wagmiConfig.setState((state) => {
    const current = state.current;
    if (!current) return { ...state, chainId };
    const connection = state.connections.get(current);
    if (!connection || connection.chainId === chainId) return { ...state, chainId };
    const connections = new Map(state.connections);
    connections.set(current, { ...connection, chainId });
    return { ...state, chainId, connections };
  });
}

let inflight: { chainId: number; promise: Promise<void> } | null = null;

/**
 * Switch the connected EVM wallet onto `chainId` before any signature or
 * transaction. Concurrent callers share one wallet request so MetaMask does
 * not reject a second `wallet_switchEthereumChain` with -32002.
 */
/**
 * Ask the wallet to add `chainId` with the app's RPC. Wallets that already
 * have the chain usually ignore the new URL; the caller still retries the
 * transaction and, if it fails, tells the user which URL to set by hand.
 */
export async function offerWalletChain(chainId: EvmChainId): Promise<void> {
  const connector = getAccount(wagmiConfig).connector;
  let provider = ethereumProvider();
  if (connector && typeof connector.getProvider === 'function') {
    try {
      provider = (await connector.getProvider() as EthProvider | undefined) ?? provider;
    } catch {
      // Use window.ethereum.
    }
  }
  const chain = WAGMI_CHAIN_BY_ID[chainId];
  const name = chainNameForId(chainId);
  if (!provider || !chain) {
    throw new Error(`Add ${name} in your wallet, then try again.`);
  }
  // Public chain RPC only. App RPC overrides are often keyed provider URLs;
  // wallets that call them get EIP-1474 -32002 "Requested resource not available".
  const rpc = walletRpcHint(chainId) ?? chain.rpcUrls.default.http[0];
  try {
    await withTimeout(provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: numberToHex(chainId),
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: rpc ? [rpc] : [...chain.rpcUrls.default.http],
        blockExplorerUrls: chain.blockExplorers?.default?.url
          ? [chain.blockExplorers.default.url]
          : undefined,
      }],
    }), WALLET_SWITCH_TIMEOUT_MS);
  } catch (err) {
    const kind = classifyChainSwitchError(err);
    if (kind === 'rejected') throw new Error(`Adding ${name} was declined in your wallet.`);
    // Already added, or the wallet only switches. The send path retries once.
  }
}

export async function ensureWalletOnChain(chainId: EvmChainId): Promise<void> {
  const live = await readConnectorChainId();
  if (live === chainId) {
    syncWagmiChain(chainId);
    return;
  }
  // eth_chainId timed out, but the connector already recorded this chain
  // (the usual case right after a mined transaction when the wallet's saved
  // RPC host does not resolve). Don't open another switch that will also hang.
  if (live == null && getAccount(wagmiConfig).chainId === chainId) {
    syncWagmiChain(chainId);
    return;
  }

  if (inflight?.chainId === chainId) return inflight.promise;

  if (inflight) {
    try {
      await inflight.promise;
    } catch {
      // The previous prompt finished (approved or declined). Switch next.
    }
    if ((await readConnectorChainId()) === chainId) {
      syncWagmiChain(chainId);
      return;
    }
  }

  const promise = performSwitch(chainId).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { chainId, promise };
  return promise;
}

async function performSwitch(chainId: EvmChainId): Promise<void> {
  const name = chainNameForId(chainId);
  const started = await readConnectorChainId();
  try {
    await withTimeout(switchChain(wagmiConfig, { chainId }), WALLET_SWITCH_TIMEOUT_MS);
  } catch (err) {
    if (isWalletRpcTimeout(err)) {
      throw new Error(
        `Switch to ${name} did not respond. In your wallet, set the ${name} RPC to ${walletRpcHint(chainId) ?? 'the public RPC'}, then try again.`,
      );
    }
    const kind = classifyChainSwitchError(err);
    if (kind === 'rejected') {
      throw new Error(`Switch to ${name} was declined in your wallet.`);
    }
    if (kind === 'missing' || kind === 'mismatch') {
      await switchViaProvider(chainId);
    } else if (kind === 'pending') {
      const landed = await waitForChainChange(started, 45_000);
      if (landed !== chainId) {
        if (landed == null) {
          throw new Error(`Approve the ${name} network switch already open in your wallet, then try again.`);
        }
        await switchViaProvider(chainId);
      }
    } else {
      throw new Error(`Could not switch your wallet to ${name}. Approve the network change in your wallet and try again.`);
    }
  }

  const deadline = Date.now() + 8_000;
  let live = await readConnectorChainId();
  while (live !== chainId && live != null && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    live = await readConnectorChainId();
  }
  if (live == null && getAccount(wagmiConfig).chainId === chainId) {
    syncWagmiChain(chainId);
    return;
  }
  if (live !== chainId) {
    if (live == null) {
      throw new Error(
        `Could not read the network from your wallet. Set the ${name} RPC to ${walletRpcHint(chainId) ?? 'the public RPC'}, then try again.`,
      );
    }
    throw new Error(`Your wallet is still on ${chainNameForId(live)}. Switch to ${name} before continuing.`);
  }
  syncWagmiChain(chainId);
}

async function switchViaProvider(chainId: EvmChainId): Promise<void> {
  const connector = getAccount(wagmiConfig).connector;
  let provider = ethereumProvider();
  if (connector && typeof connector.getProvider === 'function') {
    try {
      provider = (await connector.getProvider() as EthProvider | undefined) ?? provider;
    } catch {
      // Use window.ethereum.
    }
  }
  await requestWalletChain(provider, chainId);
}

async function requestWalletChain(provider: EthProvider | null, chainId: EvmChainId): Promise<void> {
  const chain = WAGMI_CHAIN_BY_ID[chainId];
  const name = chainNameForId(chainId);
  if (!provider || !chain) {
    throw new Error(`Add ${name} in your wallet, then try again.`);
  }
  const rpc = walletRpcHint(chainId) ?? chain.rpcUrls.default.http[0];
  try {
    await withTimeout(provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: numberToHex(chainId) }],
    }), WALLET_SWITCH_TIMEOUT_MS);
  } catch (err) {
    if (isWalletRpcTimeout(err)) {
      throw new Error(
        `Switch to ${name} did not respond. In your wallet, set the ${name} RPC to ${rpc ?? 'the public RPC'}, then try again.`,
      );
    }
    const kind = classifyChainSwitchError(err);
    if (kind === 'rejected') throw new Error(`Switch to ${name} was declined in your wallet.`);
    if (kind === 'pending') {
      const landed = await waitForChainChange(await readConnectorChainId(), 45_000);
      if (landed === chainId) return;
      throw new Error(`Approve the ${name} network switch already open in your wallet, then try again.`);
    }
    if (kind !== 'missing') {
      throw new Error(`Could not switch your wallet to ${name}. Approve the network change in your wallet and try again.`);
    }
    try {
      await withTimeout(provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: numberToHex(chainId),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: rpc ? [rpc] : chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers?.default?.url
            ? [chain.blockExplorers.default.url]
            : undefined,
        }],
      }), WALLET_SWITCH_TIMEOUT_MS);
    } catch (addErr) {
      if (isWalletRpcTimeout(addErr)) {
        throw new Error(`Adding ${name} did not respond. Add it in your wallet, then try again.`);
      }
      const addKind = classifyChainSwitchError(addErr);
      if (addKind === 'rejected') throw new Error(`Adding ${name} was declined in your wallet.`);
      if (addKind === 'pending') {
        const landed = await waitForChainChange(await readConnectorChainId(), 45_000);
        if (landed === chainId) return;
      }
      throw new Error(`Could not add ${name} to your wallet.`);
    }
  }
}

function waitForChainChange(started: number | null, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
      resolve(value);
    };
    const tick = () => {
      void readConnectorChainId().then((id) => {
        if (id != null && id !== started) finish(id);
      });
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    const interval = window.setInterval(tick, 400);
  });
}
