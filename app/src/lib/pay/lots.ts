/**
 * Lot replay for non-invoice treasury flows.
 * Ported from nave-books/lib/treasury.php: FIFO by default, HIFO per wallet,
 * internal transfers carry basis and acquisition date, gas is a disposal.
 * Invoice settlements are not events here.
 */

export type LotMethod = 'FIFO' | 'HIFO';
export type FlowDirection = 'in' | 'out';
export type FlowKind = 'income' | 'capital' | 'transfer' | 'expense' | 'unclassified';
export type DisposalRole = 'disposal' | 'transfer' | 'fee';

export interface LotAsset {
  id: string;
  decimals: number;
  isStable: boolean;
}

export interface CryptoEvent {
  id: string;
  at: string;
  date: string;
  chain: string;
  txHash: string;
  container: string;
  direction: FlowDirection;
  assetId: string;
  qtyAtomic: string;
  usdCents: number | null;
  feeAssetId: string | null;
  feeQtyAtomic: string;
  feeUsdCents: number;
  kind: FlowKind;
  pairEventId: string | null;
  status: 'confirmed' | 'failed';
}

export interface CryptoLot {
  id: string;
  container: string;
  assetId: string;
  acquired: string;
  qtyAtomic: string;
  remainingAtomic: string;
  costCents: number;
  remainingCostCents: number;
  originEventId: string;
  viaEventId: string | null;
  flags: string;
}

export interface CryptoDisposal {
  eventId: string;
  lotId: string | null;
  container: string;
  assetId: string;
  role: DisposalRole;
  qtyAtomic: string;
  basisCents: number;
  proceedsCents: number;
  gainCents: number;
  acquired: string | null;
  disposed: string;
  term: '' | 'short' | 'long';
  flags: string;
}

export interface LotReplay {
  method: LotMethod;
  lots: CryptoLot[];
  disposals: CryptoDisposal[];
  events: CryptoEvent[];
}

export interface JournalDraftLine {
  role: 'asset' | 'offset' | 'gain' | 'gas' | 'fee_asset';
  assetId: string | null;
  debitCents: number;
  creditCents: number;
}

interface Piece {
  lotId: string | null;
  qty: bigint;
  basis: number;
  acquired: string | null;
  origin: string | null;
  missing: boolean;
}

const POSTED_KINDS = new Set<FlowKind>(['income', 'capital', 'expense', 'transfer']);

export function kindsForDirection(direction: FlowDirection): FlowKind[] {
  return direction === 'in'
    ? ['income', 'capital', 'transfer', 'unclassified']
    : ['expense', 'transfer', 'unclassified'];
}

export function atomicFromDecimal(amount: string, decimals: number): string {
  const s = amount.trim().replace(/,/g, '');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!match) throw new Error('invalid_amount');
  const frac = match[2] ?? '';
  if (frac.length > decimals) throw new Error('invalid_amount');
  const combined = `${match[1]}${frac.padEnd(decimals, '0')}`.replace(/^0+/, '');
  return combined === '' ? '0' : combined;
}

export function decimalFromAtomic(atomic: string, decimals: number): string {
  const negative = atomic.startsWith('-');
  const digits = (negative ? atomic.slice(1) : atomic).replace(/^0+/, '') || '0';
  if (decimals === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+/, '') || '0';
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : whole;
  return negative ? `-${body}` : body;
}

/** USD cents at $1 per token, half up. */
export function stableParCents(qtyAtomic: string, decimals: number): number {
  const qty = BigInt(qtyAtomic);
  const scale = 10n ** BigInt(decimals);
  if (scale === 0n) return 0;
  return Number((qty * 100n + scale / 2n) / scale);
}

/** round(total * part / whole), half up at 4 decimal places, matching treasury.php prorate. */
export function prorateCents(total: number, part: bigint, whole: bigint): number {
  if (whole === 0n || total === 0 || part === 0n) return 0;
  const negative = total < 0;
  const scaled = (BigInt(Math.abs(total)) * part * 10000n) / whole;
  const rounded = (scaled + 5000n) / 10000n;
  return Number(negative ? -rounded : rounded);
}

export function applyStablePar(events: CryptoEvent[], assets: LotAsset[]): CryptoEvent[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return events.map((event) => {
    const asset = byId.get(event.assetId);
    if (!asset?.isStable || event.usdCents != null || event.status !== 'confirmed') return event;
    return { ...event, usdCents: stableParCents(event.qtyAtomic, asset.decimals) };
  });
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function holdingTerm(acquired: string | null, disposed: string): '' | 'short' | 'long' {
  if (!acquired) return '';
  const [ay, am, ad] = acquired.split('-').map(Number);
  const [dy, dm, dd] = disposed.split('-').map(Number);
  if (!ay || !dy) return '';
  const anniversary = Date.UTC(ay + 1, (am || 1) - 1, ad || 1);
  const sold = Date.UTC(dy, (dm || 1) - 1, dd || 1);
  return sold > anniversary ? 'long' : 'short';
}

function pairTransfers(events: CryptoEvent[]): CryptoEvent[] {
  const copy = events.map((event) => ({ ...event }));
  const used = new Set<string>();
  for (const out of copy) {
    if (out.kind !== 'transfer' || out.direction !== 'out' || out.pairEventId || used.has(out.id)) continue;
    const incoming = copy.find((candidate) =>
      candidate.kind === 'transfer'
      && candidate.direction === 'in'
      && !candidate.pairEventId
      && !used.has(candidate.id)
      && candidate.chain === out.chain
      && candidate.txHash === out.txHash
      && candidate.assetId === out.assetId
      && candidate.container !== out.container,
    );
    if (!incoming) continue;
    out.pairEventId = incoming.id;
    incoming.pairEventId = out.id;
    used.add(out.id);
    used.add(incoming.id);
  }
  return copy;
}

export function replayLots(events: CryptoEvent[], method: LotMethod = 'FIFO'): LotReplay {
  const prepared = pairTransfers(events);
  const ordered = prepared
    .filter((event) => event.status === 'confirmed')
    .sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1;
      if (a.direction !== b.direction) return a.direction === 'in' ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const lots: CryptoLot[] = [];
  const byId = new Map<string, CryptoLot>();
  const index = new Map<string, string[]>();
  const disposals: CryptoDisposal[] = [];
  const moved = new Map<string, Piece[]>();
  const deferred = new Map<string, CryptoEvent[]>();
  const seen = new Set<string>();
  let seq = 0;

  const addLot = (
    container: string,
    assetId: string,
    acquired: string,
    qty: bigint,
    cost: number,
    origin: string,
    via: string | null,
    flags: string,
  ) => {
    if (qty <= 0n) return;
    seq += 1;
    const lot: CryptoLot = {
      id: String(seq),
      container,
      assetId,
      acquired,
      qtyAtomic: qty.toString(),
      remainingAtomic: qty.toString(),
      costCents: cost,
      remainingCostCents: cost,
      originEventId: origin,
      viaEventId: via,
      flags,
    };
    lots.push(lot);
    byId.set(lot.id, lot);
    const key = `${container}|${assetId}`;
    const ids = index.get(key) ?? [];
    ids.push(lot.id);
    index.set(key, ids);
  };

  const consume = (container: string, assetId: string, qty: bigint): Piece[] => {
    const pieces: Piece[] = [];
    if (qty <= 0n) return pieces;
    const key = `${container}|${assetId}`;
    let ids = [...(index.get(key) ?? [])];
    if (method === 'HIFO') {
      ids.sort((a, b) => {
        const left = byId.get(a);
        const right = byId.get(b);
        if (!left || !right) return a < b ? -1 : 1;
        const leftQty = BigInt(left.qtyAtomic);
        const rightQty = BigInt(right.qtyAtomic);
        const cross = cmpBig(BigInt(right.costCents) * leftQty, BigInt(left.costCents) * rightQty);
        return cross || (a < b ? -1 : a > b ? 1 : 0);
      });
    }
    let left = qty;
    for (const lotId of ids) {
      if (left <= 0n) break;
      const lot = byId.get(lotId);
      if (!lot) continue;
      const rem = BigInt(lot.remainingAtomic);
      if (rem <= 0n) continue;
      const take = left < rem ? left : rem;
      const basis = take === rem ? lot.remainingCostCents : prorateCents(lot.remainingCostCents, take, rem);
      lot.remainingAtomic = (rem - take).toString();
      lot.remainingCostCents -= basis;
      pieces.push({
        lotId,
        qty: take,
        basis,
        acquired: lot.acquired,
        origin: lot.originEventId,
        missing: false,
      });
      left -= take;
    }
    if (left > 0n) {
      pieces.push({ lotId: null, qty: left, basis: 0, acquired: null, origin: null, missing: true });
    }
    return pieces;
  };

  const writePieces = (
    event: CryptoEvent,
    assetId: string,
    pieces: Piece[],
    role: DisposalRole,
    proceedsTotal: number,
    qtyWhole: bigint,
  ) => {
    let allocated = 0;
    pieces.forEach((piece, index) => {
      const proceeds = role === 'transfer'
        ? 0
        : index === pieces.length - 1
          ? proceedsTotal - allocated
          : prorateCents(proceedsTotal, piece.qty, qtyWhole);
      allocated += proceeds;
      disposals.push({
        eventId: event.id,
        lotId: piece.lotId,
        container: event.container,
        assetId,
        role,
        qtyAtomic: piece.qty.toString(),
        basisCents: piece.basis,
        proceedsCents: proceeds,
        gainCents: role === 'transfer' ? 0 : proceeds - piece.basis,
        acquired: piece.acquired,
        disposed: event.date,
        term: role === 'transfer' ? '' : holdingTerm(piece.acquired, event.date),
        flags: piece.missing ? 'missing_basis' : '',
      });
    });
  };

  const process = (event: CryptoEvent, forceUnpaired = false) => {
    if (seen.has(event.id)) return;
    const qty = BigInt(event.qtyAtomic);
    if (event.direction === 'in') {
      if (event.kind === 'transfer' && event.pairEventId && !forceUnpaired) {
        const carried = moved.get(event.pairEventId);
        if (!carried) {
          const waiting = deferred.get(event.pairEventId) ?? [];
          waiting.push(event);
          deferred.set(event.pairEventId, waiting);
          return;
        }
        seen.add(event.id);
        for (const piece of carried) {
          addLot(
            event.container,
            event.assetId,
            piece.acquired ?? event.date,
            piece.qty,
            piece.basis,
            piece.origin ?? event.id,
            event.id,
            piece.missing ? 'missing_basis' : '',
          );
        }
      } else {
        seen.add(event.id);
        let flags = '';
        let cost = event.usdCents ?? 0;
        if (event.usdCents == null) {
          cost = 0;
          flags = 'unpriced';
        }
        if (event.kind === 'transfer') flags = `${flags} unpaired_transfer`.trim();
        addLot(event.container, event.assetId, event.date, qty, cost, event.id, null, flags);
      }
    } else {
      seen.add(event.id);
      const pieces = consume(event.container, event.assetId, qty);
      const isTransfer = event.kind === 'transfer';
      const proceedsTotal = isTransfer ? 0 : (event.usdCents ?? 0);
      writePieces(event, event.assetId, pieces, isTransfer ? 'transfer' : 'disposal', proceedsTotal, qty);
      if (isTransfer) {
        moved.set(event.id, pieces);
        const waiting = deferred.get(event.id) ?? [];
        deferred.delete(event.id);
        for (const incoming of waiting) process(incoming);
      }
    }

    if (event.feeAssetId && BigInt(event.feeQtyAtomic) > 0n) {
      const feeQty = BigInt(event.feeQtyAtomic);
      const feePieces = consume(event.container, event.feeAssetId, feeQty);
      writePieces(event, event.feeAssetId, feePieces, 'fee', event.feeUsdCents, feeQty);
    }
  };

  for (const event of ordered) process(event);
  for (const waiting of deferred.values()) {
    for (const event of waiting) process({ ...event, pairEventId: null }, true);
  }

  return { method, lots, disposals, events: prepared };
}

export function remainingAtomic(lots: CryptoLot[], container: string, assetId: string): string {
  return lots
    .filter((lot) => lot.container === container && lot.assetId === assetId)
    .reduce((sum, lot) => sum + BigInt(lot.remainingAtomic), 0n)
    .toString();
}

/** Journal lines for one classified event. Unclassified events post nothing. */
export function journalDraft(event: CryptoEvent, disposals: CryptoDisposal[]): JournalDraftLine[] {
  if (event.status !== 'confirmed' || !POSTED_KINDS.has(event.kind)) return [];
  const lines: JournalDraftLine[] = [];
  const push = (role: JournalDraftLine['role'], assetId: string | null, debit: number, credit: number) => {
    if (debit === 0 && credit === 0) return;
    lines.push({ role, assetId, debitCents: debit, creditCents: credit });
  };

  if (event.direction === 'in' && (event.kind === 'income' || event.kind === 'capital') && event.usdCents != null) {
    push('asset', event.assetId, event.usdCents, 0);
    push('offset', null, 0, event.usdCents);
  }

  if (event.direction === 'out' && event.kind === 'expense' && event.usdCents != null) {
    const basis = disposals
      .filter((row) => row.eventId === event.id && row.role === 'disposal' && row.assetId === event.assetId)
      .reduce((sum, row) => sum + row.basisCents, 0);
    push('offset', null, event.usdCents, 0);
    push('asset', event.assetId, 0, basis);
    const gain = event.usdCents - basis;
    if (gain > 0) push('gain', null, 0, gain);
    if (gain < 0) push('gain', null, -gain, 0);
  }

  if (event.kind !== 'unclassified') {
    const feeGroups = new Map<string, { proceeds: number; basis: number }>();
    for (const row of disposals) {
      if (row.eventId !== event.id || row.role !== 'fee') continue;
      const group = feeGroups.get(row.assetId) ?? { proceeds: 0, basis: 0 };
      group.proceeds += row.proceedsCents;
      group.basis += row.basisCents;
      feeGroups.set(row.assetId, group);
    }
    for (const [assetId, group] of feeGroups) {
      push('gas', null, group.proceeds, 0);
      push('fee_asset', assetId, 0, group.basis);
      const gain = group.proceeds - group.basis;
      if (gain > 0) push('gain', null, 0, gain);
      if (gain < 0) push('gain', null, -gain, 0);
    }
  }

  return lines;
}
