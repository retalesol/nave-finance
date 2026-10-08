import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getProgramIds } from "../configAddress";
import {
  getAgentSetPDA,
  getConstitutionPDA,
  getDaoRegistryPDA,
  getFeeConfigPDA,
  getGlobalConfigPDA,
  getGuardianConfigPDA,
  getProposalPDA,
  getTokenRegistryPDA,
  getTreasuryVaultPDA,
} from "./pdas";

type AnyProgram = Program<any>;

export async function fetchGlobalConfig(program: AnyProgram) {
  const [pda] = getGlobalConfigPDA();
  return program.account.naveGlobalConfig.fetch(pda);
}

export async function fetchDaoRegistry(
  program: AnyProgram,
  founder: PublicKey,
  daoId: number,
) {
  const [pda] = getDaoRegistryPDA(founder, daoId);
  return program.account.daoRegistry.fetch(pda);
}

export async function fetchTreasuryConstitution(program: AnyProgram, dao: PublicKey) {
  const [pda] = getConstitutionPDA(dao);
  return program.account.treasuryConstitution.fetch(pda);
}

export async function fetchAgentSet(program: AnyProgram, dao: PublicKey) {
  const [pda] = getAgentSetPDA(dao);
  return program.account.agentSet.fetch(pda);
}

export async function fetchGuardianConfig(program: AnyProgram, dao: PublicKey) {
  const [pda] = getGuardianConfigPDA(dao);
  return program.account.guardianConfig.fetch(pda);
}

export async function fetchTreasuryVault(program: AnyProgram, dao: PublicKey) {
  const [pda] = getTreasuryVaultPDA(dao);
  return program.account.treasuryVault.fetch(pda);
}

export async function fetchFeeConfig(program: AnyProgram, dao: PublicKey) {
  const [pda] = getFeeConfigPDA(dao);
  return program.account.feeConfig.fetch(pda);
}

export async function fetchTokenRegistry(program: AnyProgram, dao: PublicKey) {
  const [pda] = getTokenRegistryPDA(dao);
  return program.account.tokenRegistry.fetch(pda);
}

export async function fetchProposal(
  governance: AnyProgram,
  dao: PublicKey,
  proposalIndex: number,
) {
  const [pda] = getProposalPDA(dao, proposalIndex);
  return governance.account.proposal.fetch(pda);
}

export function getCoreProgramId() {
  return new PublicKey(getProgramIds().naveCore);
}

export function getGovernanceProgramId() {
  return new PublicKey(getProgramIds().naveGovernance);
}
