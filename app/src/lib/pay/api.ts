import { PublicKey } from '@solana/web3.js';
import { supabase, setSupabaseWalletAddress } from '../supabaseClient';
import { getVaultAuthorityPDA } from '../pdaDerivation';

export interface PayAccess {
  group_exists: boolean;
  enabled: boolean;
  can_operate: boolean;
}

export interface PayCompanySettings {
  legal_name: string;
  address: string;
  ein: string;
  email: string;
  wire_instructions: string;
  ach_instructions: string;
  invoice_prefix: string;
  invoice_next_number: number;
  invoice_terms_days: number;
  default_notes: string;
  default_terms: string;
  logo_url: string;
}

export interface PayWalletAddressRow {
  chain: string;
  chain_id: number | null;
  address: string;
  dao_onchain_address: string;
}

export interface PayCashAccount {
  code: string;
  name: string;
}

export interface PayBooksSnapshot {
  company: PayCompanySettings | null;
  addresses: PayWalletAddressRow[];
  cashAccount: PayCashAccount | null;
}

/**
 * On-chain guardians are not stored in Postgres. The enable RPC accepts the
 * founder (dao_registry.creator_wallet) and dao_authorized_wallets only.
 * A guardian who is neither of those is refused server-side.
 */
export const PAY_GUARDIAN_GAP =
  'This wallet is a guardian on chain, and the books database does not have that guardian set. Pay can be turned on by the founder, or by a wallet already listed on the treasury’s authorized wallets.';

const PAY_ERROR_CODES = [
  'not_authorized',
  'invalid_solana_vault',
  'solana_vault_required',
  'multiple_solana_deployments',
  'treasury_not_found',
  'unsupported_deployment',
] as const;

export type PayErrorCode = (typeof PAY_ERROR_CODES)[number] | 'enable_failed';

export function payErrorCode(message: string): PayErrorCode {
  const hit = PAY_ERROR_CODES.find((code) => message.includes(code));
  return hit ?? 'enable_failed';
}

export function payErrorMessage(code: PayErrorCode, guardianGap: boolean): string {
  if (code === 'not_authorized' && guardianGap) return PAY_GUARDIAN_GAP;
  if (code === 'not_authorized') {
    return 'This wallet cannot turn on Pay. Use the founder wallet, or a wallet on the treasury’s authorized list.';
  }
  if (code === 'solana_vault_required' || code === 'invalid_solana_vault') {
    return 'The Solana treasury address could not be recorded. Pay was not turned on.';
  }
  if (code === 'multiple_solana_deployments') {
    return 'This treasury group has more than one Solana deployment, so Pay was not turned on.';
  }
  if (code === 'treasury_not_found') {
    return 'This treasury is not in the registry, so Pay was not turned on.';
  }
  if (code === 'unsupported_deployment') {
    return 'A chain on this treasury could not be recorded, so Pay was not turned on.';
  }
  return 'Pay could not be turned on. Nothing was saved.';
}

function asAccess(value: unknown): PayAccess {
  const row = (value ?? {}) as Partial<PayAccess>;
  return {
    group_exists: row.group_exists === true,
    enabled: row.enabled === true,
    can_operate: row.can_operate === true,
  };
}

export async function fetchPayAccess(
  treasuryGroupId: string,
  wallet: string | null,
): Promise<PayAccess> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_treasury_access', {
    p_treasury_group_id: treasuryGroupId,
  });
  if (error) throw new Error(error.message);
  return asAccess(data);
}

export async function fetchPayBooks(treasuryGroupId: string): Promise<PayBooksSnapshot> {
  const [company, addresses, cash] = await Promise.all([
    supabase
      .from('pay_company_settings')
      .select('legal_name, address, ein, email, wire_instructions, ach_instructions, invoice_prefix, invoice_next_number, invoice_terms_days, default_notes, default_terms, logo_url')
      .eq('treasury_group_id', treasuryGroupId)
      .maybeSingle(),
    supabase
      .from('pay_wallet_addresses')
      .select('chain, chain_id, address, dao_onchain_address')
      .eq('treasury_group_id', treasuryGroupId)
      .order('chain', { ascending: true }),
    supabase
      .from('pay_accounts')
      .select('code, name')
      .eq('treasury_group_id', treasuryGroupId)
      .eq('code', '1200')
      .maybeSingle(),
  ]);

  if (company.error) throw new Error(company.error.message);
  if (addresses.error) throw new Error(addresses.error.message);
  if (cash.error) throw new Error(cash.error.message);

  return {
    company: (company.data as PayCompanySettings | null) ?? null,
    addresses: (addresses.data as PayWalletAddressRow[] | null) ?? [],
    cashAccount: (cash.data as PayCashAccount | null) ?? null,
  };
}

/**
 * Seeds books for one treasury group. The Solana address is the vault
 * authority PDA from getVaultAuthorityPDA. EVM addresses are read from
 * dao_registry inside the database function.
 */
export async function enablePayForTreasury(
  treasuryGroupId: string,
  wallet: string | null,
): Promise<void> {
  setSupabaseWalletAddress(wallet);

  const solanaDao = await supabase.rpc('pay_solana_dao_for_enable', {
    p_treasury_group_id: treasuryGroupId,
  });
  if (solanaDao.error) throw new Error(solanaDao.error.message);

  let vault: string | null = null;
  const solanaAddress = typeof solanaDao.data === 'string' ? solanaDao.data : null;
  if (solanaAddress) {
    vault = getVaultAuthorityPDA(new PublicKey(solanaAddress))[0].toBase58();
  }

  const enabled = await supabase.rpc('pay_enable_treasury', {
    p_treasury_group_id: treasuryGroupId,
    p_solana_vault: vault,
  });
  if (enabled.error) throw new Error(enabled.error.message);
}

export interface PaySubscription {
  state: 'none' | 'active' | 'grace' | 'locked' | 'purged';
  usable: boolean;
  period_end: string | null;
  term_months: number | null;
  price_cents: number | null;
}

export async function fetchPaySubscription(
  treasuryGroupId: string,
  wallet: string | null,
): Promise<PaySubscription> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_subscription_status', {
    p_treasury_group_id: treasuryGroupId,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Partial<PaySubscription>;
  return {
    state: row.state ?? 'none',
    usable: row.usable === true,
    period_end: row.period_end ?? null,
    term_months: row.term_months ?? null,
    price_cents: row.price_cents ?? null,
  };
}

export async function setPayLogo(
  treasuryGroupId: string,
  wallet: string | null,
  url: string,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_set_logo', {
    p_treasury_group_id: treasuryGroupId,
    p_url: url,
  });
  if (error) throw new Error(error.message);
}

export async function activatePaySubscription(input: {
  treasuryGroupId: string;
  wallet: string | null;
  termMonths: number;
  txHash: string;
  chain: string;
}): Promise<void> {
  setSupabaseWalletAddress(input.wallet);
  const { error } = await supabase.rpc('pay_activate_subscription', {
    p_treasury_group_id: input.treasuryGroupId,
    p_term: input.termMonths,
    p_tx_hash: input.txHash,
    p_chain: input.chain,
    p_payer: input.wallet ?? '',
    p_source: 'treasury',
  });
  if (error) throw new Error(error.message);
}
