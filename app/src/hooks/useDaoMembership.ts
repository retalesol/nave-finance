import { useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { useDaoContext } from './useDaoContext';
import { useDaoRegistry } from './useDaoRegistry';
import { useGuardianConfig } from './useGuardianConfig';
import { isMockDaoAddress } from '../lib/mockData';
import { chainKindFromAddress } from '../lib/chain/types';

export interface DaoMembership {
  /** True when a wallet is connected. */
  isConnected: boolean;
  /** Address of the connected wallet (base58 on Solana, 0x… on EVM), or null. */
  walletStr: string | null;
  /** True when the connected wallet is the DAO founder/creator. */
  isFounder: boolean;
  /** True when the connected wallet is one of the DAO guardians. */
  isGuardian: boolean;
  /** True when the DAO uses token-weighted governance (any connected wallet may vote). */
  isTokenGov: boolean;
  /**
   * True when the connected wallet may take member-only actions in this DAO.
   * Mock DAOs are always treated as members so the demo remains interactive.
   */
  isMember: boolean;
}

/** Address equality that is case-insensitive for EVM (0x…) addresses. */
function addrEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (chainKindFromAddress(a) === 'evm' || chainKindFromAddress(b) === 'evm') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Shared DAO membership resolver used to gate member-only UI actions.
 *
 * Membership is the union of:
 *   - mock mode (demo treasuries are always interactive)
 *   - founder (creatorWallet / on-chain founder)
 *   - guardian (in the DAO guardian set)
 *   - token-gov (token DAOs treat any connected wallet as a voting member; the
 *     on-chain vote instruction enforces the actual token balance)
 *
 * The connected wallet is resolved per chain: Solana DAOs use the Solana
 * wallet-adapter wallet; Ethereum/Base DAOs use the connected EVM (wagmi) wallet.
 * Without this, an EVM DAO would always resolve to a non-member (C6).
 */
export function useDaoMembership(): DaoMembership {
  const { daoAddress } = useDaoContext();
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const { dao } = useDaoRegistry(daoAddress);
  const guardian = useGuardianConfig(daoAddress);

  const isMock = isMockDaoAddress(daoAddress);
  const isEvm = chainKindFromAddress(daoAddress) === 'evm';
  const walletStr = isEvm ? (evmAddress ?? null) : (publicKey?.toBase58() ?? null);

  const guardians = guardian.guardians;

  return useMemo(() => {
    const isFounder =
      !!walletStr &&
      (addrEq(dao?.creatorWallet, walletStr) || addrEq(dao?.onChainData?.founder, walletStr));
    const isGuardian =
      !!walletStr && guardians.some((g) => addrEq(g.wallet, walletStr));
    const isTokenGov = dao?.governanceType === 'token';
    const isMember = isMock || isFounder || isGuardian || isTokenGov;

    return {
      isConnected: !!walletStr,
      walletStr,
      isFounder,
      isGuardian,
      isTokenGov,
      isMember,
    };
  }, [
    walletStr,
    isMock,
    daoAddress,
    dao?.creatorWallet,
    dao?.onChainData?.founder,
    dao?.governanceType,
    guardians,
  ]);
}
