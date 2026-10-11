import { CHAIN_COLORS, type ChainFamily } from '../lib/chain/types';

interface ChainIconProps {
  family: ChainFamily;
  /** Pixel size of the icon box (width and height). */
  size?: number;
  className?: string;
}

/**
 * Inline brand marks for the user-facing networks. No external assets —
 * small SVGs suitable for pills, dropdowns, and badges. Fills come from the
 * central CHAIN_COLORS map (Solana purple, Ethereum grey, Base blue,
 * Robinhood green).
 */
export default function ChainIcon({ family, size = 16, className }: ChainIconProps) {
  const common = {
    width: size,
    height: size,
    className,
    'aria-hidden': true as const,
  };

  if (family === 'solana') {
    return (
      <svg viewBox="0 0 24 24" fill="none" {...common}>
        <defs>
          <linearGradient id="nave-solana-grad" x1="4" y1="20" x2="20" y2="4" gradientUnits="userSpaceOnUse">
            <stop stopColor={CHAIN_COLORS.solana} />
            <stop offset="1" stopColor="#14F195" />
          </linearGradient>
        </defs>
        <path
          d="M6.5 16.2 17.8 14.6 16.2 5.3 4.9 6.9 6.5 16.2Z"
          fill="url(#nave-solana-grad)"
        />
        <path
          d="M7.8 18.5 19.1 16.9 17.5 7.6 6.2 9.2 7.8 18.5Z"
          fill="url(#nave-solana-grad)"
          opacity="0.85"
        />
      </svg>
    );
  }

  if (family === 'ethereum') {
    return (
      <svg viewBox="0 0 24 24" fill="none" {...common}>
        <path
          d="M12 2.5 5.5 12.2 12 15.8 18.5 12.2 12 2.5Z"
          fill={CHAIN_COLORS.ethereum}
        />
        <path
          d="M12 16.8 5.5 13.4 12 21.5 18.5 13.4 12 16.8Z"
          fill={CHAIN_COLORS.ethereum}
          opacity="0.65"
        />
      </svg>
    );
  }

  if (family === 'arc') {
    return (
      <svg viewBox="0 0 24 24" fill="none" {...common}>
        <circle cx="12" cy="12" r="8.5" stroke={CHAIN_COLORS.arc} strokeWidth="2.2" />
        <path d="M7.2 14.6c1.7-3.8 7.9-3.8 9.6 0" stroke={CHAIN_COLORS.arc} strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }

  if (family === 'robinhood') {
    // Robinhood — stylized feather mark in brand green.
    return (
      <svg viewBox="0 0 24 24" fill="none" {...common}>
        <path
          d="M17.8 3.2c-3.1.2-6 1.6-8.1 3.9-2.3 2.5-3.6 5.9-3.9 9.8l-.6 4 2.1-1.6c.9-.7 1.9-1.6 2.8-2.6 2.5.3 4.7-.5 6.3-2.3 1.9-2.1 2.7-5.3 2.4-9.3l-.1-1.9-.9 0Z"
          fill={CHAIN_COLORS.robinhood}
        />
        <path
          d="M8.6 15.4c1.6-3.9 4-7 7.1-9.2-2.9 3-5 6.2-6.2 9.5l-.9-.3Z"
          fill="#FFFFFF"
          opacity="0.55"
        />
      </svg>
    );
  }

  // Base — filled circle mark (official brand shape).
  return (
    <svg viewBox="0 0 24 24" fill="none" {...common}>
      <circle cx="12" cy="12" r="9.5" fill={CHAIN_COLORS.base} />
    </svg>
  );
}
