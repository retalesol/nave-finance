/**
 * Identifier handling for payroll.
 *
 * The raw tax id and direct-deposit account number are not written into
 * activity text, audit text, or calc JSON. Callers send them only to the
 * save RPC, which encrypts them before storage. This module hashes them for
 * the audit row and rejects any audit sentence that still contains the raw value.
 */

export class PayrollSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollSecretError';
  }
}

export async function identifierHash(raw: string): Promise<string> {
  const normalized = raw.replace(/\s+/g, '').trim();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function identifierLast4(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

/** True when text still carries a tax-id shape or a long digit run. */
export function looksLikeRawIdentifier(text: string): boolean {
  return /\d{3}-\d{2}-\d{4}/.test(text) || /\d{2}-\d{7}/.test(text) || /(?<!\d)\d{9,}(?!\d)/.test(text);
}

/**
 * Audit and activity sentences store the hash. They never store the raw
 * identifier. `action` is a short code such as "identifier_updated".
 */
export function auditLine(action: string, hash: string): string {
  // A SHA-256 hex digest can contain a long digit run. Only the action is
  // checked for a raw identifier. The stored text is the action plus the hash.
  if (looksLikeRawIdentifier(action)) throw new PayrollSecretError('audit_has_raw_identifier');
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new PayrollSecretError('audit_hash_required');
  return `${action} ${hash}`;
}

export function assertTaxId(digits: string, tinType: 'SSN' | 'EIN' | 'ITIN'): void {
  if (!/^\d{9}$/.test(digits)) throw new PayrollSecretError('invalid_tax_id');
  if (tinType === 'EIN') return;
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  if (area === '000' || area === '666' || group === '00' || serial === '0000') {
    throw new PayrollSecretError('invalid_tax_id');
  }
  if (tinType === 'SSN' && digits.startsWith('9')) throw new PayrollSecretError('invalid_tax_id');
}

export function assertAccountNumber(raw: string): string {
  const digits = raw.replace(/\s+/g, '');
  if (!/^\d{4,17}$/.test(digits)) throw new PayrollSecretError('invalid_account_number');
  return digits;
}

export function abaValid(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = [...routing].map((ch) => Number(ch));
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}
