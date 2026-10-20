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

/** The chain the injected wallet reports, falling back to wagmi's account. */
export async function readWalletChainId(): Promise<number | null> {
  const provider = ethereumProvider();
  if (provider) {
    try {
      const hex = await provider.request({ method: 'eth_chainId' });
      if (typeof hex === 'string' && /^0x[0-9a-fA-F]+$/.test(hex)) {
        return Number.parseInt(hex, 16);
      }
    } catch {
      // Fall through to wagmi when the provider is locked or rejects.
    }
  }
  return getAccount(wagmiConfig).chainId ?? null;
}

let inflight: { chainId: number; promise: Promise<void> } | null = null;

/**
 * Switch the connected EVM wallet onto `chainId` before any signature or
 * transaction. Concurrent callers share one wallet request so MetaMask does
 * not reject a second `wallet_switchEthereumChain` with -32002.
 */
export async function ensureWalletOnChain(chainId: EvmChainId): Promise<void> {
  if ((await readWalletChainId()) === chainId) return;

  if (inflight?.chainId === chainId) return inflight.promise;

  if (inflight) {
    try {
      await inflight.promise;
    } catch {
      // The previous prompt finished (approved or declined). Switch next.
    }
    if ((await readWalletChainId()) === chainId) return;
  }

  const promise = performSwitch(chainId).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { chainId, promise };
  return promise;
}

async function performSwitch(chainId: EvmChainId): Promise<void> {
  const name = chainNameForId(chainId);
  const started = await readWalletChainId();
  try {
    await switchChain(wagmiConfig, { chainId });
  } catch (err) {
    const kind = classifyChainSwitchError(err);
    if (kind === 'rejected') {
      throw new Error(`Switch to ${name} was declined in your wallet.`);
    }
    if (kind === 'missing') {
      await addChain(chainId);
    } else     if (kind === 'pending') {
      const landed = await waitForChainChange(started, 45_000);
      if (landed !== chainId) {
        if (landed == null) {
          throw new Error(`Approve the ${name} network switch already open in your wallet, then try again.`);
        }
        try {
          await switchChain(wagmiConfig, { chainId });
        } catch (retryErr) {
          const retryKind = classifyChainSwitchError(retryErr);
          if (retryKind === 'rejected') throw new Error(`Switch to ${name} was declined in your wallet.`);
          if (retryKind === 'missing') await addChain(chainId);
          else if (retryKind === 'pending') {
            throw new Error(`Approve the ${name} network switch already open in your wallet, then try again.`);
          } else {
            throw new Error(`Could not switch your wallet to ${name}.`);
          }
        }
      }
    } else {
      throw new Error(`Could not switch your wallet to ${name}. ${err instanceof Error ? err.message : ''}`.trim());
    }
  }

  const deadline = Date.now() + 4_000;
  let live = await readWalletChainId();
  while (live !== chainId && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    live = await readWalletChainId();
  }
  if (live !== chainId) {
    const where = live != null ? chainNameForId(live) : 'another network';
    throw new Error(`Your wallet is still on ${where}. Switch to ${name} before continuing.`);
  }
}

async function addChain(chainId: EvmChainId): Promise<void> {
  const provider = ethereumProvider();
  const chain = WAGMI_CHAIN_BY_ID[chainId];
  const name = chainNameForId(chainId);
  if (!provider || !chain) {
    throw new Error(`Add ${name} in your wallet, then try again.`);
  }
  const rpc = EVM_RPC_URLS[chainId] ?? chain.rpcUrls.default.http[0];
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
  } catch (err) {
    const kind = classifyChainSwitchError(err);
    if (kind === 'rejected') throw new Error(`Adding ${name} was declined in your wallet.`);
    if (kind === 'pending') {
      const landed = await waitForChainChange(await readWalletChainId(), 45_000);
      if (landed === chainId) return;
      throw new Error(`Approve the ${name} network request already open in your wallet, then try again.`);
    }
    throw new Error(`Could not add ${name} to your wallet.`);
  }
}

function waitForChainChange(started: number | null, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const provider = ethereumProvider();
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
      provider?.removeListener?.('chainChanged', onChanged);
      resolve(value);
    };
    const onChanged = () => {
      void readWalletChainId().then((id) => {
        if (id != null && id !== started) finish(id);
      });
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    const interval = window.setInterval(onChanged, 400);
    provider?.on?.('chainChanged', onChanged);
  });
}
