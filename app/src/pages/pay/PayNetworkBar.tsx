import { chainFamilyLabel, type ChainFamily } from '../../lib/chain/types';
import { useChain } from '../../hooks/useChain';
import type { PayWalletAddressRow } from '../../lib/pay/api';

function label(chain: string): string {
  if (chain === 'solana' || chain === 'ethereum' || chain === 'base' || chain === 'robinhood' || chain === 'arc') {
    return chainFamilyLabel(chain as ChainFamily);
  }
  return chain;
}

/** The network pill is the chain in use. Other deployed chains stay available. */
export default function PayNetworkBar({ addresses }: { addresses: PayWalletAddressRow[] }) {
  const { chainFamily } = useChain();
  const deployed = [...new Set(addresses.map((row) => row.chain))];
  const here = deployed.includes(chainFamily);
  const others = deployed.filter((chain) => chain !== chainFamily);

  return (
    <p style={{ fontSize: '13px', lineHeight: 1.5, color: '#6B7280', margin: '0 0 18px', maxWidth: '560px' }}>
      <strong style={{ color: '#111827', fontWeight: 600 }}>{label(chainFamily)}</strong>
      {here
        ? ' is the network in use. Invoices, bills, and payroll stay on this treasury’s books.'
        : ' is selected, and this treasury is not deployed there yet.'}
      {others.length > 0 ? ` Also deployed: ${others.map(label).join(', ')}.` : ''}
    </p>
  );
}
