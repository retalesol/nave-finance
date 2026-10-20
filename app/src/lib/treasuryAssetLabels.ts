/** Display names for treasury holdings. Native SOL and wrapped SOL are different assets. */

export const NATIVE_SOL_MINT_ID = 'SOL';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const KNOWN_MINTS: Record<string, { symbol: string; name: string }> = {
  [NATIVE_SOL_MINT_ID]: { symbol: 'SOL', name: 'Solana' },
  [WSOL_MINT]: { symbol: 'wSOL', name: 'Wrapped SOL' },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin' },
  Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr: { symbol: 'USDC', name: 'USD Coin (devnet)' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether USD' },
};

export function treasuryAssetLabel(
  mint: string,
  market?: { symbol?: string; name?: string } | null,
): { symbol: string; name: string } {
  const known = KNOWN_MINTS[mint];
  if (known) return known;
  const symbol = market?.symbol?.trim();
  const name = market?.name?.trim();
  if (symbol || name) {
    return {
      symbol: symbol || `${mint.slice(0, 4)}…${mint.slice(-4)}`,
      name: name || 'Unknown asset',
    };
  }
  return {
    symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`,
    name: 'Unknown asset',
  };
}
