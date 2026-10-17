/**
 * Voting window the signer attaches to a new proposal.
 * Mainnet cluster and EVM chain ids 1 / 8453 / 4663 stay at 7 days.
 * Devnet, localnet, and EVM testnet chain ids use 60 seconds, except planner
 * proposals, which get one day so a guardian can see them before they close.
 * Wallet governance can still finalize early once the outcome is certain.
 * An explicit positive `voting_period_seconds` is left alone.
 */

export const TESTNET_VOTING_PERIOD_SECONDS = 60;
export const PLANNER_TESTNET_VOTING_PERIOD_SECONDS = 86_400;
export const MAINNET_VOTING_PERIOD_SECONDS = 604_800;

const EVM_TESTNET_CHAIN_IDS = new Set<number>([11155111, 84532, 46630, 5042002]);

export function solanaVotingPeriodSeconds(requested: unknown, mainnetCluster: boolean, planner = false): number {
  const n = Number(requested);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  if (mainnetCluster) return MAINNET_VOTING_PERIOD_SECONDS;
  return planner ? PLANNER_TESTNET_VOTING_PERIOD_SECONDS : TESTNET_VOTING_PERIOD_SECONDS;
}

export function evmStrategyVotingPeriodSeconds(chainId: number, planner = false): bigint {
  if (!EVM_TESTNET_CHAIN_IDS.has(chainId)) return BigInt(MAINNET_VOTING_PERIOD_SECONDS);
  return BigInt(planner ? PLANNER_TESTNET_VOTING_PERIOD_SECONDS : TESTNET_VOTING_PERIOD_SECONDS);
}
