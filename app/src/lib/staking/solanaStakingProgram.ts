// ─── nave_staking instruction encode / account decode (frontend) ─────────────
// Hand-encodes the stake / unstake / claim instructions and decodes the
// StakePool + UserStake accounts (no generated IDL dependency). Mirrors the
// on-chain program in contracts/solana/programs/nave_staking.

import { Buffer } from 'buffer';
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';

const STAKE_POOL_SEED = Buffer.from('stake_pool');
const POOL_AUTHORITY_SEED = Buffer.from('stake_pool_authority');
const STAKE_VAULT_SEED = Buffer.from('stake_vault');
const REWARD_VAULT_SEED = Buffer.from('reward_vault');
const USER_STAKE_SEED = Buffer.from('user_stake');

const ACC_SCALE = 1_000_000_000_000n;
/** Fixed-point scale for the on-chain `reward_rate` (tokens/sec * 1e12). */
export const RATE_SCALE = 1_000_000_000_000n;
export const SECONDS_PER_YEAR = 31_536_000n;

function ixDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`)).subarray(0, 8);
}
const STAKE_DISC = ixDiscriminator('stake');
const UNSTAKE_DISC = ixDiscriminator('unstake');
const CLAIM_DISC = ixDiscriminator('claim');

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function deriveStakePool(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([STAKE_POOL_SEED], programId)[0];
}
export function derivePoolAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([POOL_AUTHORITY_SEED], programId)[0];
}
export function deriveStakeVault(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([STAKE_VAULT_SEED], programId)[0];
}
export function deriveRewardVault(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([REWARD_VAULT_SEED], programId)[0];
}
export function deriveUserStake(programId: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([USER_STAKE_SEED, owner.toBuffer()], programId)[0];
}

export interface StakeAccounts {
  programId: PublicKey;
  owner: PublicKey;
  naveMint: PublicKey;
}

export function buildStakeInstruction(a: StakeAccounts, amount: bigint): TransactionInstruction {
  const pool = deriveStakePool(a.programId);
  const userStake = deriveUserStake(a.programId, a.owner);
  const stakeVault = deriveStakeVault(a.programId);
  const rewardVault = deriveRewardVault(a.programId);
  const userNave = getAssociatedTokenAddressSync(a.naveMint, a.owner);
  const keys = [
    { pubkey: a.owner, isSigner: true, isWritable: true },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: userStake, isSigner: false, isWritable: true },
    { pubkey: userNave, isSigner: false, isWritable: true },
    { pubkey: stakeVault, isSigner: false, isWritable: true },
    { pubkey: rewardVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: a.programId, keys, data: Buffer.concat([STAKE_DISC, u64le(amount)]) });
}

export function buildUnstakeInstruction(a: StakeAccounts, amount: bigint): TransactionInstruction {
  const pool = deriveStakePool(a.programId);
  const userStake = deriveUserStake(a.programId, a.owner);
  const stakeVault = deriveStakeVault(a.programId);
  const rewardVault = deriveRewardVault(a.programId);
  const poolAuthority = derivePoolAuthority(a.programId);
  const userNave = getAssociatedTokenAddressSync(a.naveMint, a.owner);
  const keys = [
    { pubkey: a.owner, isSigner: true, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: userStake, isSigner: false, isWritable: true },
    { pubkey: userNave, isSigner: false, isWritable: true },
    { pubkey: stakeVault, isSigner: false, isWritable: true },
    { pubkey: rewardVault, isSigner: false, isWritable: true },
    { pubkey: poolAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: a.programId, keys, data: Buffer.concat([UNSTAKE_DISC, u64le(amount)]) });
}

export function buildClaimInstruction(a: StakeAccounts): TransactionInstruction {
  const pool = deriveStakePool(a.programId);
  const userStake = deriveUserStake(a.programId, a.owner);
  const rewardVault = deriveRewardVault(a.programId);
  const poolAuthority = derivePoolAuthority(a.programId);
  const userNave = getAssociatedTokenAddressSync(a.naveMint, a.owner);
  const keys = [
    { pubkey: a.owner, isSigner: true, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: userStake, isSigner: false, isWritable: true },
    { pubkey: userNave, isSigner: false, isWritable: true },
    { pubkey: rewardVault, isSigner: false, isWritable: true },
    { pubkey: poolAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: a.programId, keys, data: CLAIM_DISC });
}

// ─── Account decoding + pending-reward computation ───────────────────────────

interface StakePoolData {
  totalStaked: bigint;
  accRewardPerShare: bigint;
  lastRewardBalance: bigint;
  paused: boolean;
  /** Drip emission rate in tokens/sec scaled by RATE_SCALE (0 = drip inactive). */
  rewardRate: bigint;
  /** Unix timestamp the current drip window ends (0 = uninitialized). */
  periodFinish: bigint;
  /** Unix timestamp acc_reward_per_share was last advanced by the drip. */
  lastUpdateTime: bigint;
  /** Rolling drip window length in seconds. */
  rewardDuration: bigint;
}

function decodeStakePool(data: Buffer): StakePoolData {
  // Drip fields were carved out of the trailing `reserved` bytes, so accounts
  // written by a pre-drip program (or not yet re-synced) decode them as 0.
  return {
    totalStaked: data.readBigUInt64LE(202),
    accRewardPerShare: data.readBigUInt64LE(210) + (data.readBigUInt64LE(218) << 64n),
    lastRewardBalance: data.readBigUInt64LE(226),
    paused: data.readUInt8(234) === 1,
    rewardRate: data.readBigUInt64LE(235) + (data.readBigUInt64LE(243) << 64n),
    periodFinish: data.readBigInt64LE(251),
    lastUpdateTime: data.readBigInt64LE(259),
    rewardDuration: data.readBigInt64LE(267),
  };
}

interface UserStakeData {
  amount: bigint;
  rewardDebt: bigint;
  pending: bigint;
}

function decodeUserStake(data: Buffer): UserStakeData {
  return {
    amount: data.readBigUInt64LE(41),
    rewardDebt: data.readBigUInt64LE(49) + (data.readBigUInt64LE(57) << 64n),
    pending: data.readBigUInt64LE(65),
  };
}

export interface StakingPosition {
  /** Staked NAVE principal (base units). */
  staked: bigint;
  /** Claimable reward (base units), including the un-applied elapsed drip. */
  pending: bigint;
  /** Whether staking/claim is paused. */
  paused: boolean;
}

export interface StakePoolStats {
  /** Total NAVE staked in the central pool (base units). */
  totalStaked: bigint;
  /** Undistributed reward balance sitting in the reward vault (base units). */
  rewardBalance: bigint;
  /** Whether staking/claim is paused. */
  paused: boolean;
  /** Drip rate in base-units/sec, scaled by RATE_SCALE (0 = drip inactive). */
  rewardRatePerSec: bigint;
  /** Drip rate as a float in base-units/sec (rewardRatePerSec / RATE_SCALE). */
  rewardRatePerSecFloat: number;
  /** Unix timestamp (seconds) the current drip window ends. 0 = uninitialized. */
  periodFinish: bigint;
}

/**
 * Annualized staking APY in percent from an emission rate and total stake.
 * Returns null when the drip is inactive: nothing staked, zero rate, or the
 * emission window has already ended (now >= periodFinish).
 */
export function computeStakingApy({
  annualEmissionRaw,
  totalStakedRaw,
  periodFinish,
  nowSec = Math.floor(Date.now() / 1000),
}: {
  /** Projected emission over a year, in token base units. */
  annualEmissionRaw: bigint;
  /** Total staked principal, in token base units. */
  totalStakedRaw: bigint;
  /** Unix timestamp (seconds) the drip window ends; pass 0n when unknown. */
  periodFinish: bigint;
  nowSec?: number;
}): number | null {
  if (totalStakedRaw <= 0n || annualEmissionRaw <= 0n) return null;
  if (periodFinish <= 0n || BigInt(nowSec) >= periodFinish) return null;
  const apy = (Number(annualEmissionRaw) / Number(totalStakedRaw)) * 100;
  return Number.isFinite(apy) ? apy : null;
}

/**
 * Read pool-level stats (total staked + current reward-vault balance).
 * Returns null when the pool account doesn't exist yet.
 */
export async function readStakePoolStats(
  connection: Connection,
  programId: PublicKey,
): Promise<StakePoolStats | null> {
  const poolPda = deriveStakePool(programId);
  const rewardVault = deriveRewardVault(programId);
  const poolInfo = await connection.getAccountInfo(poolPda);
  if (!poolInfo) return null;
  const pool = decodeStakePool(Buffer.from(poolInfo.data));
  let rewardBalance = 0n;
  try {
    rewardBalance = BigInt((await connection.getTokenAccountBalance(rewardVault)).value.amount);
  } catch {
    // Reward vault not created yet — zero balance.
  }
  return {
    totalStaked: pool.totalStaked,
    rewardBalance,
    paused: pool.paused,
    rewardRatePerSec: pool.rewardRate,
    rewardRatePerSecFloat: Number(pool.rewardRate) / Number(RATE_SCALE),
    periodFinish: pool.periodFinish,
  };
}

/**
 * Read a user's live staking position, mirroring the on-chain sync + accrue so
 * the displayed pending matches what `claim` would pay. Returns zeros when the
 * pool or the user position doesn't exist yet.
 */
export async function readStakingPosition(
  connection: Connection,
  programId: PublicKey,
  owner: PublicKey,
): Promise<StakingPosition> {
  const poolPda = deriveStakePool(programId);
  const userPda = deriveUserStake(programId, owner);

  const [poolInfo, userInfo] = await connection.getMultipleAccountsInfo([poolPda, userPda]);
  if (!poolInfo) return { staked: 0n, pending: 0n, paused: false };
  const pool = decodeStakePool(Buffer.from(poolInfo.data));
  if (!userInfo) return { staked: 0n, pending: 0n, paused: pool.paused };
  const user = decodeUserStake(Buffer.from(userInfo.data));

  // Mirror update_pool: project the elapsed time-drip onto the stored acc
  // (the program drips rewards over a rolling window now, so no vault-delta
  // fold here). All-zero drip fields (pre-upgrade pool) project nothing.
  let acc = pool.accRewardPerShare;
  if (pool.totalStaked > 0n && pool.rewardRate > 0n) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const applicable = now < pool.periodFinish ? now : pool.periodFinish;
    if (applicable > pool.lastUpdateTime) {
      const elapsed = applicable - pool.lastUpdateTime;
      const emitted = (pool.rewardRate * elapsed) / RATE_SCALE;
      acc += (emitted * ACC_SCALE) / pool.totalStaked;
    }
  }
  const accumulated = (user.amount * acc) / ACC_SCALE;
  const earned = accumulated > user.rewardDebt ? accumulated - user.rewardDebt : 0n;
  return { staked: user.amount, pending: user.pending + earned, paused: pool.paused };
}
