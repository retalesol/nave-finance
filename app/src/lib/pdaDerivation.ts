import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import {
  NAVE_CORE_PROGRAM_ID,
  NAVE_GOVERNANCE_PROGRAM_ID,
  NAVE_EXECUTION_PROGRAM_ID,
} from './programConfig';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

// ─── PDA derivation helpers ──────────────────────────────────────────────────
// Every function uses PublicKey.findProgramAddressSync with the seed layout
// matching the Anchor program's #[account] constraints.
// All return [pda, bump] tuples for flexibility.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function toLeU32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n, 0);
  return buf;
}

function toLeU64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  // JS safe integer range is fine for indices/nonces
  buf.writeBigUInt64LE(BigInt(n), 0);
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core PDAs
// ═══════════════════════════════════════════════════════════════════════════════

/** Global config PDA — single instance per deployment
 *  Seeds: ["global_config"] */
export function getNaveGlobalConfigPDA(
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    programId,
  );
}

/** Protocol fee vault PDA — single instance per deployment; collects token-mint
 *  fees and funds revoke rewards.
 *  Seeds: ["protocol_fee_vault"] */
export function getProtocolFeeVaultPDA(
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('protocol_fee_vault')],
    programId,
  );
}

/** DAO registry PDA — derived from founder + sequential dao_id
 *  Seeds: ["dao", founder, dao_id_le8] */
export function getDaoRegistryPDA(
  founder: PublicKey,
  daoId: number,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dao'), founder.toBuffer(), toLeU64(daoId)],
    programId,
  );
}

/** Treasury vault PDA — holds SPL tokens via ATA
 *  Seeds: ["treasury_vault", dao] */
export function getTreasuryVaultPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury_vault'), daoPubkey.toBuffer()],
    programId,
  );
}

/** Vault authority PDA — signs token transfers and CPI calls
 *  Seeds: ["vault_authority", dao] */
export function getVaultAuthorityPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault_authority'), daoPubkey.toBuffer()],
    programId,
  );
}

/** On-chain address to deposit SOL / SPL tokens into a DAO treasury. */
export function getTreasuryReceiveAddress(daoAddress: string | PublicKey): string {
  const daoPubkey = typeof daoAddress === 'string' ? new PublicKey(daoAddress) : daoAddress;
  const [vault] = getVaultAuthorityPDA(daoPubkey);
  return vault.toBase58();
}

/**
 * Mint-aware treasury deposit addresses.
 *  - `sol`: the vault authority PDA — the correct destination for native SOL.
 *  - `spl`: the vault's associated token account for `vaultMint` — the correct
 *    destination for that SPL token. Sending SPL tokens to the PDA directly is
 *    wrong; they must land in the ATA.
 */
/** Returns true when `s` is a valid base58 Solana public key string (32 bytes). */
function isValidBase58Pubkey(s: string): boolean {
  if (!s || s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export function getTreasuryDepositAddresses(
  daoAddress: string | PublicKey,
  vaultMint?: string | PublicKey | null,
): { sol: string; spl: string | null } {
  const daoPubkey = typeof daoAddress === 'string' ? new PublicKey(daoAddress) : daoAddress;
  const [vaultAuthority] = getVaultAuthorityPDA(daoPubkey);
  let spl: string | null = null;
  if (vaultMint) {
    // Guard: only derive the SPL ATA when vaultMint is a valid base58 pubkey.
    // An invalid/empty string (e.g. a token name like 'SOL') would throw here.
    const mintStr = typeof vaultMint === 'string' ? vaultMint : vaultMint.toBase58();
    if (typeof vaultMint !== 'string' || isValidBase58Pubkey(mintStr)) {
      const mint = typeof vaultMint === 'string' ? new PublicKey(mintStr) : vaultMint;
      spl = getTreasuryVaultATA(mint, vaultAuthority).toBase58();
    }
  }
  return { sol: vaultAuthority.toBase58(), spl };
}

/** Agent set PDA — stores 4 agent slots
 *  Seeds: ["agent_set", dao] */
export function getAgentSetPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('agent_set'), daoPubkey.toBuffer()],
    programId,
  );
}

/** Guardian config PDA — stores up to 10 guardian wallets + threshold
 *  Seeds: ["guardian_config", dao] */
export function getGuardianConfigPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('guardian_config'), daoPubkey.toBuffer()],
    programId,
  );
}

/** Constitution PDA — stores treasury strategy rules
 *  Seeds: ["constitution", dao] */
export function getConstitutionPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('constitution'), daoPubkey.toBuffer()],
    programId,
  );
}

/** Token registry PDA — stores up to 3 token slots
 *  Seeds: ["token_registry", dao] */
export function getTokenRegistryPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('token_registry'), daoPubkey.toBuffer()],
    programId,
  );
}

/** Fee config PDA — stores fee parameters
 *  Seeds: ["fee_config", dao] */
export function getFeeConfigPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), daoPubkey.toBuffer()],
    programId,
  );
}

/** DAO stake lock PDA — per-DAO recoverable NAVE creation-stake record.
 *  Companion PDA to DaoRegistry (registry byte layout untouched).
 *  Seeds: ["dao_stake_lock", dao] */
export function getDaoStakeLockPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dao_stake_lock'), daoPubkey.toBuffer()],
    programId,
  );
}

/** Stake escrow token-account PDA — holds the locked NAVE creation stake;
 *  authority = the DaoStakeLock PDA.
 *  Seeds: ["stake_escrow", dao] */
export function getStakeEscrowPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stake_escrow'), daoPubkey.toBuffer()],
    programId,
  );
}

/** DAO lifecycle PDA — per-DAO moonlighting lifecycle companion PDA, created on
 *  first moonlight action (registry byte layout untouched).
 *  Seeds: ["dao_lifecycle", dao] */
export function getDaoLifecyclePDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dao_lifecycle'), daoPubkey.toBuffer()],
    programId,
  );
}

/** Strategy position PDA — one per protocol per DAO
 *  Seeds: ["strategy_position", dao, protocol_id_bytes] */
export function getStrategyPositionPDA(
  daoPubkey: PublicKey,
  protocolId: string,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('strategy_position'),
      daoPubkey.toBuffer(),
      Buffer.from(protocolId),
    ],
    programId,
  );
}

/** Strategy escrow token-account PDA — one per protocol per DAO
 *  Seeds: ["strategy_escrow", dao, protocol_id_bytes], owner = vault_authority.
 *  Only valid once the on-chain escrow re-architecture ships (see
 *  AUDIT_CHANGES.md); gated behind VITE_ESCROW_PDA_ENABLED at the call sites. */
export function getStrategyEscrowPDA(
  daoPubkey: PublicKey,
  protocolId: string,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('strategy_escrow'),
      daoPubkey.toBuffer(),
      Buffer.from(protocolId),
    ],
    programId,
  );
}

// ── Multi-asset treasury PDAs ────────────────────────────────────────────────

/** Asset config PDA — per-(dao, mint) valuation + routing metadata.
 *  Seeds: ["asset_config", dao, mint] */
export function getAssetConfigPDA(
  daoPubkey: PublicKey,
  mint: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('asset_config'), daoPubkey.toBuffer(), mint.toBuffer()],
    programId,
  );
}

/** Treasury asset PDA — per-(dao, mint) accounting record.
 *  Seeds: ["treasury_asset", dao, mint] */
export function getTreasuryAssetPDA(
  daoPubkey: PublicKey,
  mint: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury_asset'), daoPubkey.toBuffer(), mint.toBuffer()],
    programId,
  );
}

/** Asset vault PDA — per-(dao, mint) holding token account, owned by vault_authority.
 *  Seeds: ["asset_vault", dao, mint] */
export function getAssetVaultPDA(
  daoPubkey: PublicKey,
  mint: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('asset_vault'), daoPubkey.toBuffer(), mint.toBuffer()],
    programId,
  );
}

/** NFT vault record PDA — per-(dao, nft_mint) custody metadata.
 *  Seeds: ["nft_vault_record", dao, mint] */
export function getNftVaultRecordPDA(
  daoPubkey: PublicKey,
  mint: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('nft_vault_record'), daoPubkey.toBuffer(), mint.toBuffer()],
    programId,
  );
}

/** NFT vault PDA — per-(dao, nft_mint) holding token account.
 *  Seeds: ["nft_vault", dao, mint] */
export function getNftVaultPDA(
  daoPubkey: PublicKey,
  mint: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('nft_vault'), daoPubkey.toBuffer(), mint.toBuffer()],
    programId,
  );
}

/** Position token PDA — per-(dao, protocol, mint) receipt-token account (cTokens / poolSOL).
 *  Seeds: ["position_token", dao, protocol_id_bytes, mint] */
export function getPositionTokenPDA(
  daoPubkey: PublicKey,
  protocolId: string,
  mint: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position_token'), daoPubkey.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
    programId,
  );
}

/** Per-dao native-SOL funding PDA (SPL stake-pool DepositSol signer).
 *  Seeds: ["sol_funding", dao] */
export function getSolFundingPDA(
  daoPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('sol_funding'), daoPubkey.toBuffer()],
    programId,
  );
}

/** Mint-keyed strategy position PDA (new multi-asset seeds).
 *  Seeds: ["strategy_position", dao, protocol_id_bytes, mint] */
export function getStrategyPositionForMintPDA(
  daoPubkey: PublicKey,
  protocolId: string,
  mint: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('strategy_position'), daoPubkey.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
    programId,
  );
}

/** Mint-keyed strategy escrow PDA (new multi-asset seeds).
 *  Seeds: ["strategy_escrow", dao, protocol_id_bytes, mint] */
export function getStrategyEscrowForMintPDA(
  daoPubkey: PublicKey,
  protocolId: string,
  mint: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('strategy_escrow'), daoPubkey.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
    programId,
  );
}

/** Guardian action PDA — multisig action tracker.
 *  Seeds: ["guardian_action", dao, [action_type], ...extraSeeds, nonce_le8]
 *  action_type: 0 = freeze, 1 = unfreeze, 2 = update status, 3 = rotate key.
 *  For type 2 extraSeeds = [[agent_slot], [new_status]]; for type 3 = [[agent_slot], new_pubkey]. */
export function getGuardianActionPDA(
  daoPubkey: PublicKey,
  actionType: number,
  nonce: number,
  extraSeeds: Buffer[] = [],
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('guardian_action'),
      daoPubkey.toBuffer(),
      Buffer.from([actionType]),
      ...extraSeeds,
      toLeU64(nonce),
    ],
    programId,
  );
}

/** Holder annotation PDA — data annotations for token holders
 *  Seeds: ["holder_annotation", dao, holder] */
export function getHolderAnnotationPDA(
  daoPubkey: PublicKey,
  holderPubkey: PublicKey,
  programId = NAVE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('holder_annotation'),
      daoPubkey.toBuffer(),
      holderPubkey.toBuffer(),
    ],
    programId,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_governance PDAs
// ═══════════════════════════════════════════════════════════════════════════════

/** Token genesis latch PDA — SEC-M3 per-(dao, mint) one-time genesis mint record.
 *  Seeds: ["token_genesis", dao, mint] */
export function getTokenGenesisRecordPDA(
  daoPubkey: PublicKey,
  mint: PublicKey,
  programId = NAVE_GOVERNANCE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('token_genesis'), daoPubkey.toBuffer(), mint.toBuffer()],
    programId,
  );
}

/** Proposal PDA — sequential index per DAO (u64)
 *  Seeds: ["proposal", dao, proposal_index_le8] */
export function getProposalPDA(
  daoPubkey: PublicKey,
  proposalIndex: number,
  programId = NAVE_GOVERNANCE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('proposal'),
      daoPubkey.toBuffer(),
      toLeU64(proposalIndex),
    ],
    programId,
  );
}

/** Vote record PDA — one per voter per proposal (wallet-based voting)
 *  Seeds: ["vote_record", proposal, voter] */
export function getVoteRecordPDA(
  proposalPubkey: PublicKey,
  voterPubkey: PublicKey,
  programId = NAVE_GOVERNANCE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('vote_record'),
      proposalPubkey.toBuffer(),
      voterPubkey.toBuffer(),
    ],
    programId,
  );
}

/** Vote escrow PDA — token lock for token-based voting
 *  Seeds: ["vote_escrow", proposal, voter] */
export function getVoteEscrowPDA(
  proposalPubkey: PublicKey,
  voterPubkey: PublicKey,
  programId = NAVE_GOVERNANCE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('vote_escrow'),
      proposalPubkey.toBuffer(),
      voterPubkey.toBuffer(),
    ],
    programId,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_execution PDAs
// ═══════════════════════════════════════════════════════════════════════════════

/** Execution request PDA — keyed by the source proposal
 *  Seeds: ["execution_request", proposal] */
export function getExecutionRequestPDA(
  proposalPubkey: PublicKey,
  programId = NAVE_EXECUTION_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('execution_request'),
      proposalPubkey.toBuffer(),
    ],
    programId,
  );
}

/** Execution authority PDA — CPI signer for strategy adapters
 *  Seeds: ["execution_authority", dao] */
export function getExecutionAuthorityPDA(
  daoPubkey: PublicKey,
  programId = NAVE_EXECUTION_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('execution_authority'), daoPubkey.toBuffer()],
    programId,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Token account helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Strategy escrow ATA — standard associated token account for vault_authority + mint */
export function getStrategyEscrowATA(
  mint: PublicKey,
  vaultAuthority: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, vaultAuthority, true);
}

/** Treasury vault ATA — vault_authority's associated token account for a given mint */
export function getTreasuryVaultATA(
  mint: PublicKey,
  vaultAuthority: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, vaultAuthority, true);
}