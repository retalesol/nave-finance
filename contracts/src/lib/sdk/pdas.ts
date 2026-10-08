import { PublicKey } from "@solana/web3.js";
import { getProgramIds } from "../configAddress";

const enc = new TextEncoder();

export function getGlobalConfigPDA(programId = getProgramIds().naveCore) {
  return PublicKey.findProgramAddressSync([enc.encode("global_config")], new PublicKey(programId));
}

export function getDaoRegistryPDA(
  founder: PublicKey,
  daoId: bigint | number,
  programId = getProgramIds().naveCore,
) {
  const id = typeof daoId === "bigint" ? daoId : BigInt(daoId);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync(
    [enc.encode("dao"), founder.toBuffer(), buf],
    new PublicKey(programId),
  );
}

export function getVaultAuthorityPDA(dao: PublicKey, programId = getProgramIds().naveCore) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("vault_authority"), dao.toBuffer()],
    new PublicKey(programId),
  );
}

export function getTreasuryVaultPDA(dao: PublicKey, programId = getProgramIds().naveCore) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("treasury_vault"), dao.toBuffer()],
    new PublicKey(programId),
  );
}

export function getAgentSetPDA(dao: PublicKey, programId = getProgramIds().naveCore) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("agent_set"), dao.toBuffer()],
    new PublicKey(programId),
  );
}

export function getGuardianConfigPDA(dao: PublicKey, programId = getProgramIds().naveCore) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("guardian_config"), dao.toBuffer()],
    new PublicKey(programId),
  );
}

export function getConstitutionPDA(dao: PublicKey, programId = getProgramIds().naveCore) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("constitution"), dao.toBuffer()],
    new PublicKey(programId),
  );
}

export function getTokenRegistryPDA(dao: PublicKey, programId = getProgramIds().naveCore) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("token_registry"), dao.toBuffer()],
    new PublicKey(programId),
  );
}

export function getFeeConfigPDA(dao: PublicKey, programId = getProgramIds().naveCore) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("fee_config"), dao.toBuffer()],
    new PublicKey(programId),
  );
}

export function getStrategyPositionPDA(
  dao: PublicKey,
  protocolId: string,
  programId = getProgramIds().naveCore,
) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("strategy_position"), dao.toBuffer(), enc.encode(protocolId)],
    new PublicKey(programId),
  );
}

export function getHolderAnnotationPDA(
  dao: PublicKey,
  holder: PublicKey,
  programId = getProgramIds().naveCore,
) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("holder_annotation"), dao.toBuffer(), holder.toBuffer()],
    new PublicKey(programId),
  );
}

export function getProposalPDA(
  dao: PublicKey,
  proposalIndex: bigint | number,
  programId = getProgramIds().naveGovernance,
) {
  const id = typeof proposalIndex === "bigint" ? proposalIndex : BigInt(proposalIndex);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync(
    [enc.encode("proposal"), dao.toBuffer(), buf],
    new PublicKey(programId),
  );
}

export function getVoteRecordPDA(
  proposal: PublicKey,
  voter: PublicKey,
  programId = getProgramIds().naveGovernance,
) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("vote_record"), proposal.toBuffer(), voter.toBuffer()],
    new PublicKey(programId),
  );
}

export function getVoteEscrowPDA(
  proposal: PublicKey,
  voter: PublicKey,
  programId = getProgramIds().naveGovernance,
) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("vote_escrow"), proposal.toBuffer(), voter.toBuffer()],
    new PublicKey(programId),
  );
}

export function getExecutionRequestPDA(
  proposal: PublicKey,
  programId = getProgramIds().naveExecution,
) {
  return PublicKey.findProgramAddressSync(
    [enc.encode("execution_request"), proposal.toBuffer()],
    new PublicKey(programId),
  );
}
