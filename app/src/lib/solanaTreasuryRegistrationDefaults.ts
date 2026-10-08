/**
 * Defaults for `register_asset` without user-supplied Pyth ids where possible.
 * On-chain: non-stable assets require a non-zero `pyth_feed_id` (see `register_asset_handler`).
 */
import { ASSET_KIND } from './transactionBuilders';

const ZERO_FEED = '0'.repeat(64);

/** Pyth pull-oracle feed id hex (64 chars, no 0x) keyed by SPL mint base58. */
export const KNOWN_PYTH_FEED_HEX_BY_MINT: Record<string, string> = {
  So11111111111111111111111111111111111111112:
    'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', // SOL/USD
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: ZERO_FEED,
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: ZERO_FEED,
  Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr: ZERO_FEED,
};

const STABLE_HINT = /\b(USDC|USDT|DAI|PYUSD|USDP|FDUSD|USDG|TUSD|BUSD)\b/i;

export function inferStablecoinFromMeta(symbol: string, name: string): boolean {
  const s = `${symbol} ${name}`;
  return STABLE_HINT.test(s);
}

export type SolanaRegisterAssetPlan =
  | {
      mode: 'ready';
      pythFeedHex: string;
      isStablecoin: boolean;
      assetKind: number;
    }
  | {
      mode: 'needs_pyth_feed';
      /** Suggested kind when user pastes a feed id. */
      assetKind: number;
    };

/**
 * Returns a one-click-safe plan, or `needs_pyth_feed` for unknown volatile tokens
 * (on-chain rejects zero feed when `is_stablecoin` is false).
 */
export function getSolanaRegisterAssetPlan(mint: string, symbol: string, name: string): SolanaRegisterAssetPlan {
  const knownFeed = KNOWN_PYTH_FEED_HEX_BY_MINT[mint];
  if (knownFeed !== undefined) {
    const isStable = knownFeed === ZERO_FEED;
    return {
      mode: 'ready',
      pythFeedHex: knownFeed,
      isStablecoin: isStable,
      assetKind: isStable
        ? ASSET_KIND.STABLE
        : mint === 'So11111111111111111111111111111111111111112'
          ? ASSET_KIND.SOL_LIKE
          : ASSET_KIND.OTHER,
    };
  }
  if (inferStablecoinFromMeta(symbol, name)) {
    return { mode: 'ready', pythFeedHex: ZERO_FEED, isStablecoin: true, assetKind: ASSET_KIND.STABLE };
  }
  return { mode: 'needs_pyth_feed', assetKind: ASSET_KIND.OTHER };
}
