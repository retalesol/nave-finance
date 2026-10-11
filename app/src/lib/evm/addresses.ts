// ─── EVM address resolution (Ethereum + Base + Robinhood) ─────────────────────
// Singleton (NaveProtocol, NaveDAOFactory) addresses come from env config, keyed
// strictly by the six supported chain ids. Per-DAO contract addresses
// (NaveTreasury / NaveGovernor / NaveExecution) are resolved at runtime from the
// treasury clone's `governor()` / `execution()` getters — see
// fetchDaoContracts in readers.ts.

import { getAddress, isAddress, type Address } from 'viem';
import {
  EVM_PROTOCOL_ADDRESSES,
  EVM_FACTORY_ADDRESSES,
} from '../programConfig';
import {
  isEvmChainId,
  type EvmChainId,
} from '../chain/types';

/** Checksum + validate an address string, or return null if invalid/empty. */
export function toAddress(value: string | null | undefined): Address | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!isAddress(trimmed)) return null;
  return getAddress(trimmed);
}

/** Resolve the NaveProtocol singleton for a chain, or null if not configured. */
export function getProtocolAddress(chainId: EvmChainId): Address | null {
  return toAddress(EVM_PROTOCOL_ADDRESSES[chainId]);
}

/** Resolve the NaveDAOFactory singleton for a chain, or null if not configured. */
export function getFactoryAddress(chainId: EvmChainId): Address | null {
  return toAddress(EVM_FACTORY_ADDRESSES[chainId]);
}

/**
 * Guard used by readers/writers: ensure a chain id is in-scope. Throwing here is
 * the last line of defence against an out-of-scope EVM chain leaking through.
 */
export function assertSupportedChain(chainId: number): asserts chainId is EvmChainId {
  if (!isEvmChainId(chainId)) {
    throw new Error(
      `Unsupported EVM chain id ${chainId}; Nave supports Ethereum, Base, Robinhood, and Arc Testnet (1, 8453, 4663, 11155111, 84532, 46630, 5042002).`,
    );
  }
}

/** The three per-DAO contract roles that the factory deploys as clones. */
export interface DaoContractAddresses {
  treasury: Address;
  governor: Address;
  execution: Address;
}
