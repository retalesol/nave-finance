/**
 * Canonical treasury / DAO registry address form for Supabase filters and
 * deduplication. EVM 0x addresses are case-insensitive on-chain but Postgres
 * text equality is case-sensitive; we normalize to lowercase. Solana base58
 * addresses are case-sensitive and are left trimmed-only.
 */
export function normalizeDaoOnchainAddressForQuery(address: string | null | undefined): string {
  if (address == null) return '';
  const t = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return t.toLowerCase();
  return t;
}

/** True when two treasury addresses refer to the same DAO (EVM: case-insensitive). */
export function daoOnchainAddressEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return normalizeDaoOnchainAddressForQuery(a) === normalizeDaoOnchainAddressForQuery(b);
}
