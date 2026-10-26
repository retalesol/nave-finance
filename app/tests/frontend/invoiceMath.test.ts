import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import {
  computeInvoice,
  invoiceState,
  moneyIn,
  muldivRound,
  paymentPosting,
  postingBalances,
  qtyIn,
  rateIn,
  sentInvoicePosting,
  voidBlockedReason,
} from '../../src/lib/pay/invoiceMath';
import { quoteSettlement, rawToCents } from '../../src/lib/pay/settlement';
import {
  buildInvoiceAddresses,
  choosePayable,
  predictForwarder,
  solanaInvoiceVaultPda,
} from '../../src/lib/pay/addresses';

const PROGRAM = new PublicKey('8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB');
const DAO = new PublicKey('9KTuzRJdDs59KU5UXNXdTQrPznEiiz4URk29NC3PkK5Q');
const INVOICE = '11'.repeat(32);

test('discount is applied before tax and allocated to taxable lines', () => {
  assert.equal(rateIn('8.25', 'Tax rate'), 8250);
  assert.equal(moneyIn('$20.00', 'Discount'), 2000);
  const totals = computeInvoice(
    [
      { description: 'Design', qty: '1', rate: '100.00', taxable: true },
      { description: 'Hosting', qty: '2', rate: '50.00', taxable: false },
    ],
    2000,
    8250,
  );
  assert.equal(totals.subtotalCents, 20000);
  assert.equal(totals.taxableCents, 10000);
  assert.equal(totals.taxBaseCents, 9000);
  assert.equal(totals.taxCents, 743);
  assert.equal(totals.totalCents, 18743);
  assert.equal(muldivRound(9000, 8250, 100000), 743);

  const posting = sentInvoicePosting({
    subtotalCents: totals.subtotalCents,
    discountCents: 2000,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
  });
  assert.deepEqual(posting.map((line) => [line.code, line.debitCents, line.creditCents]), [
    ['1100', 18743, 0],
    ['4000', 0, 20000],
    ['4090', 2000, 0],
    ['2300', 0, 743],
  ]);
  assert.equal(postingBalances(posting), true);
});

test('a blank row is skipped and a half cent rounds away from zero', () => {
  const totals = computeInvoice(
    [
      { description: '', qty: '0', rate: '0', taxable: false },
      { description: 'Slice', qty: '0.5', rate: '0.01', taxable: false },
    ],
    0,
    0,
  );
  assert.equal(qtyIn('0.5', 'qty'), 5000);
  assert.equal(totals.lines.length, 1);
  assert.equal(totals.lines[0].amountCents, 1);
  assert.equal(totals.totalCents, 1);
});

test('discount above the subtotal is rejected', () => {
  assert.throws(
    () => computeInvoice([{ description: 'Work', qty: '1', rate: '10.00', taxable: true }], 1001, 0),
    /Discount cannot exceed the subtotal/,
  );
});

test('partial, overdue, and paid come from payments against the total', () => {
  const partial = invoiceState(
    { status: 'sent', totalCents: 10000, paidCents: 4000, dueDate: '2026-12-01' },
    '2026-10-25',
  );
  assert.equal(partial.displayStatus, 'partial');
  assert.equal(partial.balanceCents, 6000);

  const overdue = invoiceState(
    { status: 'sent', totalCents: 10000, paidCents: 0, dueDate: '2026-10-01' },
    '2026-10-25',
  );
  assert.equal(overdue.displayStatus, 'overdue');
  assert.equal(overdue.daysOverdue, 24);
  assert.equal(overdue.balanceCents, 10000);

  const overduePartial = invoiceState(
    { status: 'sent', totalCents: 10000, paidCents: 1000, dueDate: '2026-10-01' },
    '2026-10-25',
  );
  assert.equal(overduePartial.displayStatus, 'overdue');
  assert.equal(overduePartial.balanceCents, 9000);

  const paid = invoiceState(
    { status: 'sent', totalCents: 10000, paidCents: 10000, dueDate: '2026-10-01' },
    '2026-10-25',
  );
  assert.equal(paid.displayStatus, 'paid');
  assert.equal(paid.balanceCents, 0);

  const draft = invoiceState(
    { status: 'draft', totalCents: 10000, paidCents: 0, dueDate: '2026-10-01' },
    '2026-10-25',
  );
  assert.equal(draft.displayStatus, 'draft');
  assert.equal(draft.balanceCents, 0);
});

test('void is blocked when payments exist', () => {
  assert.equal(voidBlockedReason('sent', 0), null);
  assert.match(voidBlockedReason('sent', 1) ?? '', /payments recorded/);
  const voided = invoiceState(
    { status: 'void', totalCents: 10000, paidCents: 0, dueDate: '2026-10-01' },
    '2026-10-25',
  );
  assert.equal(voided.displayStatus, 'void');
  assert.equal(voided.balanceCents, 0);
});

test('a crypto payment debits digital assets and credits accounts receivable', () => {
  const lines = paymentPosting(4000, '1200');
  assert.deepEqual(lines.map((line) => [line.code, line.debitCents, line.creditCents]), [
    ['1200', 4000, 0],
    ['1100', 0, 4000],
  ]);
  assert.equal(postingBalances(lines), true);
});

test('USDC settles at par and an overpay leaves an unclassified remainder', () => {
  const exact = quoteSettlement({
    openCents: 15000,
    rawAmount: 150_000_000n,
    decimals: 6,
    priceUsd: null,
    stable: true,
    assetLabel: 'USDC',
  });
  assert.equal(rawToCents(1_500_000n, 6, 1), 150);
  assert.equal(exact.usdBooked, true);
  assert.equal(exact.quotedCents, 15000);
  assert.equal(exact.appliedCents, 15000);
  assert.equal(exact.excessCents, 0);
  assert.equal(exact.excessNote, '');

  const over = quoteSettlement({
    openCents: 5000,
    rawAmount: 80_000_000n,
    decimals: 6,
    priceUsd: null,
    stable: true,
    assetLabel: 'USDC',
  });
  assert.equal(over.appliedCents, 5000);
  assert.equal(over.excessCents, 3000);
  assert.match(over.excessNote, /Unclassified inflow of \$30\.00/);
  assert.match(over.excessNote, /not applied/);

  const partial = quoteSettlement({
    openCents: 10000,
    rawAmount: 40_000_000n,
    decimals: 6,
    priceUsd: null,
    stable: true,
  });
  assert.equal(partial.appliedCents, 4000);
  assert.equal(partial.excessCents, 0);
  const after = invoiceState(
    { status: 'sent', totalCents: 10000, paidCents: partial.appliedCents, dueDate: '2026-12-01' },
    '2026-10-25',
  );
  assert.equal(after.displayStatus, 'partial');
  assert.equal(after.balanceCents, 6000);
});

test('a non-stable without a cached price is not given an invented USD amount', () => {
  const quote = quoteSettlement({
    openCents: 10000,
    rawAmount: 1_000_000_000n,
    decimals: 9,
    priceUsd: null,
    stable: false,
    assetLabel: 'SOL',
  });
  assert.equal(quote.usdBooked, false);
  assert.equal(quote.appliedCents, 0);
  assert.equal(quote.rawAmount, '1000000000');
  assert.match(quote.excessNote, /manual payment/);

  const priced = quoteSettlement({
    openCents: 1_000_000,
    rawAmount: 1_000_000_000n,
    decimals: 9,
    priceUsd: 150.25,
    stable: false,
    assetLabel: 'SOL',
  });
  assert.equal(priced.usdBooked, true);
  assert.equal(priced.quotedCents, 15025);
  assert.equal(priced.appliedCents, 15025);
});

test('the Solana invoice vault uses the invoice_vault seed and the ATA allows a PDA owner', () => {
  const vault = solanaInvoiceVaultPda(PROGRAM, DAO, INVOICE);
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from('invoice_vault'), DAO.toBuffer(), Buffer.from(INVOICE, 'hex')],
    PROGRAM,
  );
  assert.equal(vault.toBase58(), expected.toBase58());
  const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const ata = getAssociatedTokenAddressSync(mint, vault, true);
  const rows = buildInvoiceAddresses({
    invoiceIdHex: INVOICE,
    wallets: [{ chain: 'solana', chain_id: null, address: 'vault-authority', dao_onchain_address: DAO.toBase58() }],
    solanaProgramId: PROGRAM,
    solanaUsdcMint: mint.toBase58(),
    routers: {},
  });
  assert.equal(rows.find((row) => row.kind === 'solana_vault')?.address, vault.toBase58());
  assert.equal(rows.find((row) => row.kind === 'solana_ata')?.address, ata.toBase58());
});

test('with no router the payable address is the canonical treasury address', () => {
  const treasury = '0x1111111111111111111111111111111111111111';
  const rows = buildInvoiceAddresses({
    invoiceIdHex: INVOICE,
    wallets: [
      { chain: 'solana', chain_id: null, address: 'So11111111111111111111111111111111111111112', dao_onchain_address: DAO.toBase58() },
      { chain: 'ethereum', chain_id: 1, address: treasury, dao_onchain_address: treasury },
    ],
    solanaProgramId: PROGRAM,
    routers: {},
    evmUsdc: { '1': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  });
  assert.equal(rows.some((row) => row.kind === 'evm_forwarder'), false);
  assert.equal(rows.some((row) => row.kind === 'solana_ata'), false);
  const payable = choosePayable('ethereum', rows, treasury);
  assert.equal(payable.unique, false);
  assert.equal(payable.address, treasury);
  assert.equal(predictForwarder(null, treasury, INVOICE, '0x0000000000000000000000000000000000000000'), null);
});

test('predictAddress matches the router CREATE2 vector', () => {
  const address = predictForwarder(
    '0x3333333333333333333333333333333333333333',
    '0x1111111111111111111111111111111111111111',
    '22'.repeat(32),
    '0x0000000000000000000000000000000000000000',
  );
  assert.equal(address, '0xd8098596c8B5B86C92EA2949BF8356995D525E98');
});
