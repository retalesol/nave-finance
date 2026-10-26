/**
 * Invoice email.
 *
 * Nave Pay does not have a mail provider configured. This module does not
 * read SMTP host, username, or password, and it does not invent any.
 * The invoice screen shows the result of `invoiceEmailAvailability` instead
 * of attempting a send.
 */

export interface InvoiceEmailAvailability {
  configured: false;
  reason: string;
}

export function invoiceEmailAvailability(): InvoiceEmailAvailability {
  return {
    configured: false,
    reason:
      'Email is not configured. No mail provider is set up for Nave Pay, so this invoice was not emailed.',
  };
}
