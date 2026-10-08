// ─── EVM contract ABIs + descriptors ─────────────────────────────────────────
// ABIs live in src/abi/*.json and are the REAL Foundry artifacts emitted by the
// contracts build and copied here via `npm run sync-abi` (see src/abi/abi.meta.json
// for the sync provenance/timestamp). The function/read surface below is the
// typed contract the frontend programs against and is kept in lockstep with the
// synced ABIs.

import type { Abi } from 'viem';

import naveProtocolAbi from '../../abi/NaveProtocol.json';
import naveDaoFactoryAbi from '../../abi/NaveDAOFactory.json';
import naveTreasuryAbi from '../../abi/NaveTreasury.json';
import naveGovernorAbi from '../../abi/NaveGovernor.json';
import naveExecutionAbi from '../../abi/NaveExecution.json';
import naveDaoStakeAbi from '../../abi/NaveDaoStake.json';
import erc20Abi from '../../abi/ERC20.json';

export const NaveProtocolAbi = naveProtocolAbi as Abi;
export const NaveDAOFactoryAbi = naveDaoFactoryAbi as Abi;
export const NaveTreasuryAbi = naveTreasuryAbi as Abi;
export const NaveGovernorAbi = naveGovernorAbi as Abi;
export const NaveExecutionAbi = naveExecutionAbi as Abi;
export const NaveDaoStakeAbi = naveDaoStakeAbi as Abi;
export const Erc20Abi = erc20Abi as Abi;

/** Logical Nave EVM contract names (mirrors the Solana program set). */
export type NaveEvmContract =
  | 'NaveProtocol'
  | 'NaveDAOFactory'
  | 'NaveTreasury'
  | 'NaveGovernor'
  | 'NaveExecution'
  | 'NaveDaoStake';

/** ABI lookup by logical contract name. */
export const NAVE_ABIS: Record<NaveEvmContract, Abi> = {
  NaveProtocol: NaveProtocolAbi,
  NaveDAOFactory: NaveDAOFactoryAbi,
  NaveTreasury: NaveTreasuryAbi,
  NaveGovernor: NaveGovernorAbi,
  NaveExecution: NaveExecutionAbi,
  NaveDaoStake: NaveDaoStakeAbi,
};

/**
 * The ABIs in src/abi/*.json are the real, synced Foundry artifacts (the
 * `npm run sync-abi` script stamps the sibling `abi.meta.json` with the source
 * + timestamp). This flag is retained for call-site compatibility but is now
 * permanently false — the frontend binds real contract ABIs, never placeholders.
 */
export const ABIS_ARE_PLACEHOLDER = false;
