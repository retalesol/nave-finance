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

/** Opens the operator's mail app with the invoice summary. Returns false when the customer has no email. */
export function openInvoiceMailto(input: {
  to: string;
  number: string;
  amount: string;
  dueDate: string;
  link: string;
}): boolean {
  const to = input.to.trim();
  if (!to) return false;
  const subject = encodeURIComponent(`Invoice ${input.number}`);
  const body = encodeURIComponent(
    `Invoice ${input.number}\nAmount due: ${input.amount}\nDue: ${input.dueDate}\n${input.link}`,
  );
  window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  return true;
}
