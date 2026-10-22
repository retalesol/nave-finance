// Official Arc Testnet HTTP endpoint (chain id 5042002).
// `rpc.testnet.arc.network` does not resolve. Wallets that were given that
// host fail eth_estimateGas with EIP-1474 -32002, which viem shows as
// "Requested resource not available" and a nameless chain id.

export const ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io';

const RETIRED_ARC_RPC_HOSTS = new Set([
  'rpc.testnet.arc.network',
  'www.rpc.testnet.arc.network',
]);

/** Use a configured Arc RPC, unless it is the retired hostname. */
export function resolveArcTestnetRpc(configured?: string | null): string {
  const raw = configured?.trim();
  if (!raw) return ARC_TESTNET_RPC_URL;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (RETIRED_ARC_RPC_HOSTS.has(host)) return ARC_TESTNET_RPC_URL;
  } catch {
    return ARC_TESTNET_RPC_URL;
  }
  return raw.replace(/\/$/, '');
}
