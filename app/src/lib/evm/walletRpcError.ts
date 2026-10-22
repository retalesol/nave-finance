import type { EvmChainId } from '../chain/types';
import { ARC_TESTNET_RPC_URL } from './arcRpc';
import { WAGMI_CHAIN_BY_ID } from './wagmi';

/** Public endpoints safe to store in a wallet. Not the app's keyed RPC overrides. */
const PUBLIC_WALLET_RPC: Partial<Record<EvmChainId, string>> = {
  1: 'https://ethereum.publicnode.com',
  8453: 'https://mainnet.base.org',
  4663: 'https://rpc.mainnet.chain.robinhood.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  84532: 'https://sepolia.base.org',
  46630: 'https://rpc.testnet.chain.robinhood.com',
  5042002: ARC_TESTNET_RPC_URL,
};

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth += 1) {
    const obj = cur as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown; error?: unknown };
    for (const value of [obj.shortMessage, obj.details, obj.message]) {
      if (typeof value === 'string' && value) parts.push(value);
    }
    const next = obj.cause ?? obj.error;
    if (!next || next === cur) break;
    cur = next;
  }
  if (!parts.length && typeof err === 'string') parts.push(err);
  return parts.join(' ');
}

/**
 * Public RPC a wallet should use. App RPC overrides stay on the wagmi transport;
 * they are not safe to paste into a wallet (keyed providers reject the browser
 * with "Requested resource not available").
 */
export function walletRpcHint(chainId: EvmChainId): string | undefined {
  return PUBLIC_WALLET_RPC[chainId] ?? WAGMI_CHAIN_BY_ID[chainId]?.rpcUrls.default.http[0];
}

/**
 * Turn viem's "Requested resource not available" (EIP-1474 -32002, and MetaMask's
 * same code for a request that is already open) into a wallet instruction.
 * Returns null when the error is something else.
 */
export function explainEvmSendError(err: unknown, chainId: EvmChainId): string | null {
  const text = errorText(err);
  if (/0x82b42900/.test(text)) {
    const name = WAGMI_CHAIN_BY_ID[chainId]?.name ?? `chain ${chainId}`;
    return `The treasury factory rejected this transaction (unauthorized). Your wallet must be on ${name} before you sign — on another network that same address is a different contract.`;
  }
  if (/already pending/i.test(text)) {
    return 'A request is already open in your wallet. Approve or reject it, then try again.';
  }
  if (!/requested resource not available|resource unavailable/i.test(text)) return null;
  const name = WAGMI_CHAIN_BY_ID[chainId]?.name ?? `chain ${chainId}`;
  const rpc = walletRpcHint(chainId);
  if (!rpc) {
    return `Your wallet could not reach ${name}. Update that network's RPC URL in the wallet and try again.`;
  }
  return `Your wallet could not reach ${name}. Open that network in the wallet and set the RPC URL to ${rpc}, then try again.`;
}
