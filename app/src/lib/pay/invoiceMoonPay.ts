/**
 * MoonPay destination for a public invoice.
 * Mirrors selectInvoiceMoonPayWallet in the MoonPay edge helper.
 */

export interface InvoicePayChoice {
  chain: string;
  chain_id: number | null;
  asset: string;
  address: string;
  unique?: boolean;
}

const EVM_NATIVE = '0x0000000000000000000000000000000000000000';

export interface InvoiceCardTarget {
  currencyCode: 'usdc_sol' | 'usdc' | 'usdc_base';
  walletAddress: string;
  chainId: number | null;
}

export function invoiceCardTarget(rows: InvoicePayChoice[], chain: string): InvoiceCardTarget | null {
  if (chain === 'solana') {
    const vault = rows.find((row) => row.chain === 'solana' && row.asset === 'native' && row.address);
    const canonical = rows.find((row) => row.chain === 'solana' && row.asset === 'treasury' && row.address);
    const picked = vault ?? canonical;
    if (!picked) return null;
    return { currencyCode: 'usdc_sol', walletAddress: picked.address, chainId: null };
  }
  const chainId = chain === 'ethereum' ? 1 : chain === 'base' ? 8453 : null;
  if (chainId == null) return null;
  const forwarder = rows.find((row) => (
    row.chain === chain
    && row.address
    && row.asset
    && row.asset !== 'native'
    && row.asset !== 'treasury'
    && row.asset.toLowerCase() !== EVM_NATIVE
  ));
  const canonical = rows.find((row) => row.chain === chain && row.asset === 'treasury' && row.address);
  const picked = forwarder ?? canonical;
  if (!picked) return null;
  return {
    currencyCode: chainId === 1 ? 'usdc' : 'usdc_base',
    walletAddress: picked.address,
    chainId,
  };
}

/** Card checkout stays open for a day. MoonPay reviews can outlast a page timer. */
export const INVOICE_CARD_WATCH_MS = 24 * 60 * 60 * 1000;
