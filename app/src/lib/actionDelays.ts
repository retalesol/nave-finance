/**
 * Caller-chosen voting and review delays.
 *
 * Production chains keep the long windows the UI and signer already send.
 * Testnet and devnet collapse those same choices to 60 seconds, matching
 * `NaveConstants.DEV_DELAY_SECS` and the Solana devnet build. This does not
 * change `NaveConstants` production values, and it does not rewrite a delay
 * already stored on an existing DAO.
 */

/** One minute. Testnet/devnet voting period and review-window floor. */
export const TESTNET_ACTION_DELAY_SECONDS = 60;

/**
 * Manual proposal form on mainnet refuses anything under one day.
 * Review mode on mainnet may still send the selected sub-day option (1 hour).
 */
export const MAINNET_MIN_MANUAL_VOTING_SECONDS = 86_400;

/** Treasury transfers, agent strategy proposals, and the signer default. */
export const MAINNET_DEFAULT_VOTING_PERIOD_SECONDS = 7 * 86_400;

/** Solana moonlight request and distribution proposals. */
export const MAINNET_MOONLIGHT_VOTING_PERIOD_SECONDS = 3 * 86_400;

/** EVM `setReviewWindow` production floor (1 hour). Testnet chains accept 60s. */
export const MAINNET_EVM_MIN_REVIEW_WINDOW_SECONDS = 3_600;

/** Solana review-window floor. Already one minute on every cluster. */
export const SOLANA_MIN_REVIEW_WINDOW_SECONDS = 60;

const EVM_TESTNET_CHAIN_IDS = new Set<number>([11155111, 84532, 46630, 5042002]);

export type SolanaCluster = 'mainnet' | 'devnet' | 'localnet';
export type EvmDeploymentMode = 'mainnet' | 'testnet' | 'mixed';

export type ActionDelayContext =
  | { kind: 'solana'; network: SolanaCluster }
  | { kind: 'evm'; chainId: number }
  | { kind: 'deployment'; mode: EvmDeploymentMode };

export function actionDelayContextFrom(input: {
  chainKind: 'solana' | 'evm';
  evmChainId?: number | null;
  solanaNetwork: SolanaCluster;
  evmDeploymentMode: EvmDeploymentMode;
}): ActionDelayContext {
  if (input.chainKind === 'evm') {
    if (typeof input.evmChainId === 'number') return { kind: 'evm', chainId: input.evmChainId };
    return { kind: 'deployment', mode: input.evmDeploymentMode };
  }
  return { kind: 'solana', network: input.solanaNetwork };
}

/**
 * True when this call must keep the production-length delay.
 * Unknown EVM chain ids stay long. Mixed mode without a chain id stays long,
 * because that profile includes Base and Robinhood mainnet.
 */
export function usesProductionActionDelay(ctx: ActionDelayContext): boolean {
  if (ctx.kind === 'solana') return ctx.network === 'mainnet';
  if (ctx.kind === 'evm') return !EVM_TESTNET_CHAIN_IDS.has(ctx.chainId);
  return ctx.mode !== 'testnet';
}

/** Replace a production-length voting window with 60s on testnet/devnet. */
export function votingPeriodForNetwork(mainnetSeconds: number, ctx: ActionDelayContext): number {
  return usesProductionActionDelay(ctx) ? mainnetSeconds : TESTNET_ACTION_DELAY_SECONDS;
}

const MAINNET_PROPOSAL_PERIOD_OPTIONS: { label: string; secs: number }[] = [
  { label: '1 hour', secs: 3600 },
  { label: '6 hours', secs: 21600 },
  { label: '1 day', secs: 86400 },
  { label: '3 days', secs: 259200 },
  { label: '7 days', secs: 604800 },
];

export function proposalPeriodOptions(ctx: ActionDelayContext): { label: string; secs: number }[] {
  if (usesProductionActionDelay(ctx)) return MAINNET_PROPOSAL_PERIOD_OPTIONS;
  return [{ label: '1 minute', secs: TESTNET_ACTION_DELAY_SECONDS }, ...MAINNET_PROPOSAL_PERIOD_OPTIONS];
}

/** Review-mode default. Strategy and transfer stay at 3 days on mainnet; other types at 1 day. */
export function defaultReviewPeriodSeconds(proposalType: string, ctx: ActionDelayContext): number {
  if (!usesProductionActionDelay(ctx)) return TESTNET_ACTION_DELAY_SECONDS;
  return proposalType === 'strategy' || proposalType === 'transfer' ? 259200 : 86_400;
}

/**
 * Seconds written into `createProposal`.
 * Mainnet manual mode floors at one day. Testnet manual mode (the day-count
 * templates) is 60 seconds. An explicit review-mode pick is kept, but testnet
 * never sends less than 60 seconds.
 */
export function resolveSubmittedVotingPeriod(input: {
  ctx: ActionDelayContext;
  isReview: boolean;
  reviewPeriodSecs: number;
  votingDays: number;
}): number {
  if (!usesProductionActionDelay(input.ctx)) {
    if (input.isReview) {
      const secs = Math.round(input.reviewPeriodSecs);
      return secs >= TESTNET_ACTION_DELAY_SECONDS ? secs : TESTNET_ACTION_DELAY_SECONDS;
    }
    return TESTNET_ACTION_DELAY_SECONDS;
  }
  if (input.isReview) return input.reviewPeriodSecs;
  const days = Number.isFinite(input.votingDays) && input.votingDays > 0 ? input.votingDays : 7;
  return Math.max(MAINNET_MIN_MANUAL_VOTING_SECONDS, Math.round(days) * 86_400);
}

export function reviewWindowMinSeconds(chainKind: 'evm' | 'solana', ctx: ActionDelayContext): number {
  if (!usesProductionActionDelay(ctx)) return TESTNET_ACTION_DELAY_SECONDS;
  return chainKind === 'evm' ? MAINNET_EVM_MIN_REVIEW_WINDOW_SECONDS : SOLANA_MIN_REVIEW_WINDOW_SECONDS;
}

const MAINNET_REVIEW_WINDOW_PRESETS: { label: string; secs: number }[] = [
  { label: '1 hour', secs: 3600 },
  { label: '6 hours', secs: 6 * 3600 },
  { label: '24 hours', secs: 86400 },
  { label: '3 days', secs: 3 * 86400 },
  { label: '7 days', secs: 7 * 86400 },
];

export function reviewWindowPresets(ctx: ActionDelayContext): { label: string; secs: number }[] {
  if (usesProductionActionDelay(ctx)) return MAINNET_REVIEW_WINDOW_PRESETS;
  return [{ label: '1 minute', secs: TESTNET_ACTION_DELAY_SECONDS }, ...MAINNET_REVIEW_WINDOW_PRESETS];
}

/** Fallback only when the DAO's stored window has not loaded. Does not write it. */
export function defaultReviewWindowFallback(ctx: ActionDelayContext): number {
  return usesProductionActionDelay(ctx) ? 86_400 : TESTNET_ACTION_DELAY_SECONDS;
}
