import { Link } from 'react-router-dom';
import Fi from './Fi';
import ChainIcon from './ChainIcon';
import { CHAIN_COLORS } from '../lib/chain/types';

/**
 * Shown across treasury surfaces when Robinhood Chain is selected. Treasuries
 * are supported; local DeFi yield is limited, so capital typically bridges to
 * Ethereum (CCTP USDC / Arbitrum Portal ETH rails via agents).
 */
export default function RobinhoodTreasuryNotice() {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border p-3.5 mb-6"
      style={{
        backgroundColor: `${CHAIN_COLORS.robinhood}14`,
        borderColor: `${CHAIN_COLORS.robinhood}55`,
      }}
      role="status"
    >
      <ChainIcon family="robinhood" size={16} className="mt-0.5 flex-shrink-0" />
      <div style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'hsl(var(--foreground))' }}>
        <span style={{ fontWeight: 600 }}>Robinhood treasuries bridge out for yield.</span>{' '}
        Local DeFi opportunities are limited — agents move USDC/ETH to a sister
        Ethereum treasury (CCTP / Arbitrum bridge) for Aave and Compound. Bridge
        &amp; Stake for <code>$NAVE</code> remains at{' '}
        <Link
          to="/bridge"
          className="inline-flex items-center gap-1 no-underline"
          style={{ color: CHAIN_COLORS.robinhood, fontWeight: 600 }}
        >
          Bridge &amp; Stake
          <Fi icon="arrow-right" style={{ fontSize: '10px' }} />
        </Link>
        .
      </div>
    </div>
  );
}
