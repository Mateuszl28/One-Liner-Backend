import { allocate, type Cents } from './money.js';
import type { Bill } from './state.js';

/** Items below this OCR confidence are highlighted until someone confirms them. */
export const LOW_CONFIDENCE = 0.8;

export type BillWarning =
  | { kind: 'unclaimed-item'; itemId: string; name: string }
  | { kind: 'low-confidence'; itemId: string; name: string; confidence: number }
  | { kind: 'total-mismatch'; receiptTotalCents: Cents; computedTotalCents: Cents; differenceCents: Cents };

export interface MemberShare {
  memberId: string;
  itemsCents: Cents;
  extrasCents: Cents;
  totalCents: Cents;
}

export interface BillSplit {
  billId: string;
  currency: string;
  payerId: string;
  itemsCents: Cents;
  extrasCents: Cents;
  totalCents: Cents;
  shares: Map<string, MemberShare>;
  warnings: BillWarning[];
  /** True when nothing needs a human look: all items claimed or shared, prices confirmed, totals match. */
  ready: boolean;
}

/**
 * Splits a bill:
 *  - a claimed item is split between its claimers by their shares
 *    (Anna 2 beers, Ben 1 beer on a "3 x beer" line);
 *  - an unclaimed item is split equally between all participants; for items
 *    marked `shared` (pizza, wine) that is intended, otherwise it is flagged;
 *  - tax (unless already included in prices), tip and service are spread
 *    proportionally to what each person had, or equally if `extrasMode` says so.
 * All rounding goes through `allocate`, so shares always add up to the bill total.
 */
export function splitBill(bill: Bill): BillSplit {
  const warnings: BillWarning[] = [];
  const itemTotals = new Map<string, Cents>(bill.participants.map((p) => [p, 0]));
  const add = (map: Map<string, Cents>, key: string, value: Cents) => map.set(key, (map.get(key) ?? 0) + value);

  const items = [...bill.items.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  let itemsCents = 0;
  for (const item of items) {
    itemsCents += item.priceCents;
    if (!item.confirmed && item.confidence < LOW_CONFIDENCE) {
      warnings.push({ kind: 'low-confidence', itemId: item.id, name: item.name, confidence: item.confidence });
    }
    const claims = [...(bill.claims.get(item.id) ?? new Map<string, number>()).entries()].filter(([, s]) => s > 0);
    let weights: Array<[string, number]>;
    if (claims.length > 0) {
      weights = claims.sort(([a], [b]) => (a < b ? -1 : 1));
    } else {
      if (!item.shared) warnings.push({ kind: 'unclaimed-item', itemId: item.id, name: item.name });
      weights = bill.participants.map((p) => [p, 1]);
    }
    for (const [memberId, cents] of allocate(item.priceCents, weights)) add(itemTotals, memberId, cents);
  }

  const extrasCents = (bill.taxIncluded ? 0 : bill.taxCents) + bill.tipCents + bill.serviceCents;
  const members = [...itemTotals.keys()].sort();
  const extraWeights: Array<[string, number]> =
    bill.extrasMode === 'equal'
      ? bill.participants.map((p) => [p, 1])
      : members.map((m) => [m, Math.max(0, itemTotals.get(m) ?? 0)]);
  const extras = extrasCents !== 0 ? allocate(extrasCents, extraWeights) : new Map<string, Cents>();

  const shares = new Map<string, MemberShare>();
  for (const memberId of new Set([...members, ...extras.keys()])) {
    const i = itemTotals.get(memberId) ?? 0;
    const e = extras.get(memberId) ?? 0;
    if (i === 0 && e === 0) continue;
    shares.set(memberId, { memberId, itemsCents: i, extrasCents: e, totalCents: i + e });
  }

  const totalCents = itemsCents + extrasCents;
  // The receipt total is compared without tip: a tip is often added at the table, on top of the printed total.
  const beforeTip = totalCents - bill.tipCents;
  if (bill.receiptTotalCents !== null && bill.receiptTotalCents !== beforeTip) {
    warnings.push({
      kind: 'total-mismatch',
      receiptTotalCents: bill.receiptTotalCents,
      computedTotalCents: beforeTip,
      differenceCents: bill.receiptTotalCents - beforeTip,
    });
  }

  return {
    billId: bill.id,
    currency: bill.currency,
    payerId: bill.payerId,
    itemsCents,
    extrasCents,
    totalCents,
    shares,
    warnings,
    ready: warnings.length === 0,
  };
}
