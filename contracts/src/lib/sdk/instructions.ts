import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
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
  getVaultAuthorityPDA,
} from "./pdas";

type AnyProgram = Program<any>;

export async function buildInitializeDao(
  program: AnyProgram,
  founder: PublicKey,
  globalConfig: PublicKey,
  protocolTreasury: PublicKey,
  daoId: number,
  params: {
    name: string;
    guardianWallets: PublicKey[];
    guardianThreshold: number;
    agentAuthorities: PublicKey[];
    managementFeeBps: number;
    performanceFeeBps: number;
    frozenManagementFeeBps: number;
    frozenPerformanceFeeBps: number;
    privacyMode: number;
  },
  vaultTokenAccount: PublicKey,
) {
  const [daoRegistry] = getDaoRegistryPDA(founder, daoId);
  const [vaultAuthority] = getVaultAuthorityPDA(daoRegistry);
  const [treasuryVault] = getTreasuryVaultPDA(daoRegistry);
  const [agentSet] = getAgentSetPDA(daoRegistry);
  const [guardianConfig] = getGuardianConfigPDA(daoRegistry);
  const [constitution] = getConstitutionPDA(daoRegistry);
  const [tokenRegistry] = getTokenRegistryPDA(daoRegistry);
  const [feeConfig] = getFeeConfigPDA(daoRegistry);

  return program.methods
    .initializeDao(params)
    .accounts({
      founder,
      globalConfig,
      protocolTreasury,
      daoRegistry,
      vaultAuthority,
      treasuryVault,
      vaultTokenAccount,
      agentSet,
      guardianConfig,
      constitution,
      tokenRegistry,
      feeConfig,
      systemProgram: SystemProgram.programId,
    });
}

export async function buildCreateProposal(
  governance: AnyProgram,
  proposer: PublicKey,
  globalConfig: PublicKey,
  daoRegistry: PublicKey,
  daoTokenMint: PublicKey,
  proposalIndex: number,
  params: {
    title: string;
    description: string;
    payload: number[];
    proposalType: number;
    votingPeriodSeconds: BN;
  },
) {
  const [proposal] = getProposalPDA(daoRegistry, proposalIndex);
  return governance.methods.createProposal(params).accounts({
    proposer,
    globalConfig,
    daoRegistry,
    proposal,
    daoTokenMint,
    systemProgram: SystemProgram.programId,
  });
}

export async function buildCastVoteWallet(
  governance: AnyProgram,
  voter: PublicKey,
  globalConfig: PublicKey,
  daoRegistry: PublicKey,
  guardianConfig: PublicKey,
  proposal: PublicKey,
  choice: number,
) {
  const [voteRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from("vote_record"), proposal.toBuffer(), voter.toBuffer()],
    new PublicKey(getProgramIds().naveGovernance),
  );

  return governance.methods.castVoteWallet(choice).accounts({
    voter,
    globalConfig,
    daoRegistry,
    guardianConfig,
    proposal,
    voteRecord,
    systemProgram: SystemProgram.programId,
  });
}

export async function buildLockTokensAndVote(
  governance: AnyProgram,
  accounts: Record<string, PublicKey>,
  amount: BN,
  choice: number,
) {
  return governance.methods.lockTokensAndVote(amount, choice).accounts(accounts);
}

export { getGlobalConfigPDA, getDaoRegistryPDA, getConstitutionPDA, getAgentSetPDA, getProposalPDA };
