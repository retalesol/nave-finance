import { getAccount, switchChain } from '@wagmi/core';
import { numberToHex } from 'viem';
import type { EvmChainId } from '../chain/types';
import { EVM_RPC_URLS } from '../programConfig';
import { classifyChainSwitchError } from './chainSwitchError';
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

async function providerChainId(provider: EthProvider | null): Promise<number | null> {
  if (!provider) return null;
  try {
    const hex = await provider.request({ method: 'eth_chainId' });
    if (typeof hex === 'string' && /^0x[0-9a-fA-F]+$/.test(hex)) {
      return Number.parseInt(hex, 16);
    }
  } catch {
    // Provider locked or busy.
  }
  return null;
}

/**
 * Chain id reported by the active wagmi connector. `getAccount().chainId` is the
 * connection record and can say Sepolia while MetaMask is still on Arc.
 */
async function readConnectorChainId(): Promise<number | null> {
  const connector = getAccount(wagmiConfig).connector;
  if (connector) {
    try {
      return await connector.getChainId();
    } catch {
      // Fall through to the injected provider.
    }
    if (typeof connector.getProvider === 'function') {
      try {
        const provider = await connector.getProvider() as EthProvider | undefined;
        const id = await providerChainId(provider ?? null);
        if (id != null) return id;
      } catch {
        // Fall through.
      }
    }
  }
  return providerChainId(ethereumProvider());
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
export async function ensureWalletOnChain(chainId: EvmChainId): Promise<void> {
  if ((await readConnectorChainId()) === chainId) {
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
    await switchChain(wagmiConfig, { chainId });
  } catch (err) {
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
  while (live !== chainId && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    live = await readConnectorChainId();
  }
  if (live !== chainId) {
    const where = live != null ? chainNameForId(live) : 'another network';
    throw new Error(`Your wallet is still on ${where}. Switch to ${name} before continuing.`);
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
  const rpc = EVM_RPC_URLS[chainId] ?? chain.rpcUrls.default.http[0];
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: numberToHex(chainId) }],
    });
  } catch (err) {
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
      await provider.request({
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
      });
    } catch (addErr) {
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
