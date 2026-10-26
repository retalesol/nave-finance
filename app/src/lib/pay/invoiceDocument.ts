/**
 * Printable invoice. The browser print dialog can save it as a PDF.
 * Wire and ACH text are included only when the company stored them.
 */

import { INVOICE_FOOTER } from './billing';
import { formatCents } from './invoiceMath';
import type { PayInvoice } from './booksApi';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function qtyLabel(qtyE4: number): string {
  const neg = qtyE4 < 0;
  const abs = Math.abs(qtyE4);
  const whole = Math.trunc(abs / 10000);
  const frac = String(abs % 10000).padStart(4, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function invoiceDocumentHtml(invoice: PayInvoice, payable: { chain: string; address: string }[]): string {
  const company = invoice.company_snapshot?.legal_name || 'Invoice';
  const companyAddress = invoice.company_snapshot?.address || '';
  const logo = invoice.company_snapshot?.logo_url || '';
  const customer = invoice.customer_snapshot?.name || invoice.customer?.name || 'Customer';
  const customerAddress = invoice.customer_snapshot?.address || '';
  const wire = invoice.rails_snapshot?.wire_instructions?.trim() || '';
  const ach = invoice.rails_snapshot?.ach_instructions?.trim() || '';
  const rows = (invoice.items ?? []).map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${esc(qtyLabel(item.qty_e4))}</td>
      <td class="num">${esc(formatCents(item.rate_cents))}</td>
      <td class="num">${item.taxable ? 'Yes' : ''}</td>
      <td class="num">${esc(formatCents(item.amount_cents))}</td>
    </tr>`).join('');
  const payRows = payable.map((row) => `<p><strong>${esc(row.chain)}</strong><br><span class="mono">${esc(row.address)}</span></p>`).join('');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(invoice.number)}</title>
  <style>
    body { font-family: Georgia, "Iowan Old Style", serif; color: #111827; margin: 40px; }
    h1 { font-weight: 400; font-size: 32px; margin: 0 0 4px; }
    .muted { color: #6B7280; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; }
    th { text-align: left; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #6B7280; border-bottom: 1px solid #E7E2D6; padding: 8px 0; }
    td { border-bottom: 1px solid #F3EFE6; padding: 8px 0; vertical-align: top; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .totals { margin-top: 16px; margin-left: auto; width: 240px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; }
    .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
  </style>
</head>
<body>
    ${logo ? `<img src="${esc(logo)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;" />` : ''}
  <div class="muted">INVOICE</div>
  <h1>${esc(invoice.number)}</h1>
  <p class="muted">${esc(company)}${companyAddress ? `<br>${esc(companyAddress)}` : ''}</p>
  <p><strong>${esc(customer)}</strong>${customerAddress ? `<br><span class="muted">${esc(customerAddress)}</span>` : ''}</p>
  <p class="muted">Issued ${esc(invoice.issue_date)} · Due ${esc(invoice.due_date)}${invoice.po_number ? ` · PO ${esc(invoice.po_number)}` : ''}</p>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${esc(formatCents(invoice.subtotal_cents))}</span></div>
    ${invoice.discount_cents ? `<div><span>Discount</span><span>-${esc(formatCents(invoice.discount_cents))}</span></div>` : ''}
    ${invoice.tax_cents ? `<div><span>${esc(invoice.tax_label || 'Tax')}</span><span>${esc(formatCents(invoice.tax_cents))}</span></div>` : ''}
    <div><strong>Total</strong><strong>${esc(formatCents(invoice.total_cents))}</strong></div>
  </div>
  <h2 style="font-weight:400;font-size:18px;margin-top:28px;">Pay</h2>
  <p class="muted">Reference <span class="mono">${esc(invoice.reference_code)}</span></p>
  ${payRows}
  ${wire ? `<p class="muted"><strong>Wire</strong><br>${esc(wire).replace(/\n/g, '<br>')}</p>` : ''}
  ${ach ? `<p class="muted"><strong>ACH</strong><br>${esc(ach).replace(/\n/g, '<br>')}</p>` : ''}
  ${invoice.notes ? `<p class="muted">${esc(invoice.notes)}</p>` : ''}
  ${invoice.terms ? `<p class="muted">${esc(invoice.terms)}</p>` : ''}
  <p class="muted" style="margin-top:36px;">${esc(INVOICE_FOOTER)}</p>
</body>
</html>`;
}

export function printInvoiceDocument(html: string): void {
  const frame = window.open('', '_blank', 'noopener,noreferrer');
  if (!frame) return;
  frame.document.write(html);
  frame.document.close();
  frame.focus();
  frame.print();
}
