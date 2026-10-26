import { supabase, setSupabaseWalletAddress } from '../supabaseClient';
import { atomicFromDecimal, decimalFromAtomic } from './lots';

export interface PayCryptoAsset {
  id: string;
  chain: string;
  symbol: string;
  name: string;
  contract: string;
  decimals: number;
  is_stable: boolean;
}

export interface PayCryptoEvent {
  id: string;
  wallet_address_id: string;
  chain: string;
  tx_hash: string;
  occurred_at: string;
  event_date: string;
  direction: 'in' | 'out';
  asset_id: string;
  qty_atomic: string;
  counterparty: string;
  usd_cents: number | null;
  kind: 'income' | 'capital' | 'transfer' | 'expense' | 'unclassified';
  account_id: string | null;
  memo: string;
  status: string;
}

export interface PayCryptoLot {
  id: string;
  wallet_address_id: string;
  asset_id: string;
  remaining_atomic: string;
  remaining_cost_cents: number;
}

export interface PayChainBalance {
  wallet_address_id: string;
  asset_id: string;
  qty_atomic: string;
}

export interface PayLotAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

export interface TreasuryActivitySnapshot {
  lotMethod: 'FIFO' | 'HIFO';
  assets: PayCryptoAsset[];
  events: PayCryptoEvent[];
  lots: PayCryptoLot[];
  balances: PayChainBalance[];
  accounts: PayLotAccount[];
  addresses: { id: string; chain: string; chain_id: number | null; address: string; dao_onchain_address: string }[];
}

export interface LiveHolding {
  mint: string;
  symbol: string;
  decimals: number;
  vaultBalanceBaseUnits: number;
  uiBalance: number;
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export function treasuryActivityMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Treasury activity could not be saved.';
  if (message.includes('invoice_settlement')) {
    return 'That transfer is already an invoice settlement. It stays on the invoice.';
  }
  if (message.includes('not_authorized')) return 'This wallet cannot change treasury activity.';
  if (message.includes('bad_kind')) return 'That classification does not fit this direction.';
  if (message.includes('invalid_amount')) return 'Enter a quantity with no more decimals than the asset allows.';
  if (message.includes('asset_not_found')) return 'Choose an asset on this treasury.';
  if (message.includes('address_not_found')) return 'Choose a treasury address.';
  if (message.includes('invalid_tx')) return 'A transaction id is required.';
  return message;
}

export function liveChainAtomic(
  asset: Pick<PayCryptoAsset, 'chain' | 'symbol' | 'contract' | 'decimals'>,
  liveChain: string | null,
  rows: LiveHolding[],
): string | null {
  if (!liveChain || asset.chain !== liveChain) return null;
  const contract = asset.contract.toLowerCase();
  for (const row of rows) {
    const mint = row.mint.toLowerCase();
    const symbol = row.symbol.toUpperCase();
    const matches = (asset.contract !== '' && mint === contract)
      || (asset.contract === '' && asset.symbol.toUpperCase() === 'SOL' && (row.mint === 'SOL' || symbol === 'SOL'))
      || (asset.contract === '' && asset.symbol.toUpperCase() === 'ETH' && (row.mint === 'ETH' || symbol === 'ETH'));
    if (!matches) continue;
    if (row.mint === 'SOL' || row.mint === 'ETH' || row.vaultBalanceBaseUnits > 0) {
      if (!Number.isFinite(row.vaultBalanceBaseUnits)) return null;
      return String(Math.trunc(row.vaultBalanceBaseUnits));
    }
    try {
      return atomicFromDecimal(row.uiBalance.toFixed(Math.min(row.decimals, asset.decimals)), asset.decimals);
    } catch {
      return null;
    }
  }
  return null;
}

export function formatAtomic(atomic: string, decimals: number): string {
  try {
    return decimalFromAtomic(atomic.split('.')[0] || '0', decimals);
  } catch {
    return atomic;
  }
}

export async function fetchTreasuryActivity(
  treasuryGroupId: string,
  wallet: string | null,
): Promise<TreasuryActivitySnapshot> {
  setSupabaseWalletAddress(wallet);
  const [walletRow, assets, events, lots, balances, accounts, addresses] = await Promise.all([
    supabase
      .from('pay_wallets')
      .select('lot_method')
      .eq('treasury_group_id', treasuryGroupId)
      .eq('kind', 'nave_treasury')
      .maybeSingle(),
    supabase
      .from('pay_crypto_assets')
      .select('id, chain, symbol, name, contract, decimals, is_stable')
      .eq('treasury_group_id', treasuryGroupId)
      .order('chain')
      .order('symbol'),
    supabase
      .from('pay_crypto_events')
      .select('id, wallet_address_id, chain, tx_hash, occurred_at, event_date, direction, asset_id, qty_atomic, counterparty, usd_cents, kind, account_id, memo, status')
      .eq('treasury_group_id', treasuryGroupId)
      .order('occurred_at', { ascending: false }),
    supabase
      .from('pay_crypto_lots')
      .select('id, wallet_address_id, asset_id, remaining_atomic, remaining_cost_cents')
      .eq('treasury_group_id', treasuryGroupId),
    supabase
      .from('pay_crypto_chain_balances')
      .select('wallet_address_id, asset_id, qty_atomic')
      .eq('treasury_group_id', treasuryGroupId),
    supabase
      .from('pay_accounts')
      .select('id, code, name, account_type')
      .eq('treasury_group_id', treasuryGroupId)
      .eq('archived', false)
      .order('code'),
    supabase
      .from('pay_wallet_addresses')
      .select('id, chain, chain_id, address, dao_onchain_address')
      .eq('treasury_group_id', treasuryGroupId)
      .order('chain'),
  ]);
  fail(walletRow.error);
  fail(assets.error);
  fail(events.error);
  fail(lots.error);
  fail(balances.error);
  fail(accounts.error);
  fail(addresses.error);
  const method = walletRow.data?.lot_method === 'HIFO' ? 'HIFO' : 'FIFO';
  return {
    lotMethod: method,
    assets: (assets.data ?? []) as PayCryptoAsset[],
    events: (events.data ?? []) as PayCryptoEvent[],
    lots: (lots.data ?? []) as PayCryptoLot[],
    balances: (balances.data ?? []) as PayChainBalance[],
    accounts: (accounts.data ?? []) as PayLotAccount[],
    addresses: (addresses.data ?? []) as TreasuryActivitySnapshot['addresses'],
  };
}

export async function refreshTreasuryActivity(
  treasuryGroupId: string,
  wallet: string | null,
  held: { chain: string; symbol: string; name: string; contract: string; decimals: number; is_stable: boolean }[],
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_refresh_treasury_activity', {
    p_treasury: treasuryGroupId,
    p_held: held,
  });
  fail(error);
}

export async function classifyTreasuryEvent(
  treasuryGroupId: string,
  wallet: string | null,
  eventId: string,
  kind: string,
  accountId: string | null,
  memo: string,
  usdCents: number | null,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_classify_crypto_event', {
    p_treasury: treasuryGroupId,
    p_event: eventId,
    p_kind: kind,
    p_account: accountId,
    p_memo: memo,
    p_usd_cents: usdCents,
  });
  fail(error);
}

export async function recordTreasuryEvent(
  treasuryGroupId: string,
  wallet: string | null,
  body: Record<string, unknown>,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_record_crypto_event', {
    p_treasury: treasuryGroupId,
    p_body: body,
  });
  fail(error);
}

export async function setLotMethod(
  treasuryGroupId: string,
  wallet: string | null,
  method: 'FIFO' | 'HIFO',
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_set_lot_method', {
    p_treasury: treasuryGroupId,
    p_method: method,
  });
  fail(error);
}
