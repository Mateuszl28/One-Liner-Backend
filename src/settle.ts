import type { Cents } from './money.js';
import { splitBill } from './split.js';
import type { GatherState } from './state.js';

export interface Transfer {
  fromId: string;
  toId: string;
  amountCents: Cents;
  currency: string;
}

/** currency -> memberId -> net balance (positive: is owed money, negative: owes money). */
export type Balances = Map<string, Map<string, Cents>>;

/** Running balance across every bill and recorded payment in the Gather. */
export function computeBalances(state: GatherState): Balances {
  const balances: Balances = new Map();
  const add = (currency: string, memberId: string, cents: Cents) => {
    let perCurrency = balances.get(currency);
    if (!perCurrency) balances.set(currency, (perCurrency = new Map()));
    perCurrency.set(memberId, (perCurrency.get(memberId) ?? 0) + cents);
  };

  for (const bill of state.bills.values()) {
    const split = splitBill(bill);
    add(split.currency, split.payerId, split.totalCents);
    for (const share of split.shares.values()) add(split.currency, share.memberId, -share.totalCents);
  }
  for (const p of state.payments.values()) {
    add(p.currency, p.fromId, p.amountCents);
    add(p.currency, p.toId, -p.amountCents);
  }
  for (const perCurrency of balances.values()) {
    for (const [memberId, cents] of perCurrency) if (cents === 0) perCurrency.delete(memberId);
  }
  return balances;
}

/** Above this many non-zero balances the exact search gets slow, so we fall back to greedy. */
export const EXACT_SETTLE_LIMIT = 16;

/**
 * Works out the smallest number of payments that makes everyone even.
 *
 * The minimum equals (people with a non-zero balance) − (the largest number of
 * groups the balances can be split into where each group sums to zero), since
 * a zero-sum group of k people needs exactly k−1 payments. We find that
 * partition with a DP over subsets (fine for a dinner table or a trip; up to
 * 16 people), then settle each group greedily. Larger groups use plain greedy,
 * which is never more than n−1 payments.
 */
export function settleUp(balances: Map<string, Cents>, currency: string): Transfer[] {
  const people = [...balances.entries()].filter(([, c]) => c !== 0).sort(([a], [b]) => (a < b ? -1 : 1));
  const sum = people.reduce((s, [, c]) => s + c, 0);
  if (sum !== 0) throw new Error(`Balances must sum to zero, got ${sum}`);
  if (people.length === 0) return [];

  const groups = people.length <= EXACT_SETTLE_LIMIT ? zeroSumGroups(people) : [people];
  return groups.flatMap((group) => greedySettle(group, currency));
}

export function settleAll(balances: Balances): Transfer[] {
  return [...balances.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([currency, perMember]) => settleUp(perMember, currency));
}

function zeroSumGroups(people: Array<[string, Cents]>): Array<Array<[string, Cents]>> {
  const n = people.length;
  const full = (1 << n) - 1;
  const sums = new Float64Array(1 << n);
  const best = new Int8Array(1 << n);
  for (let mask = 1; mask <= full; mask++) {
    const low = mask & -mask;
    const i = 31 - Math.clz32(low);
    sums[mask] = sums[mask ^ low]! + people[i]![1];
    let b = 0;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) b = Math.max(b, best[mask ^ (1 << j)]!);
    }
    best[mask] = b + (sums[mask] === 0 ? 1 : 0);
  }

  // Walk back to recover an order in which people were added; every time the
  // running sum hits zero, one group is complete.
  const order: number[] = [];
  let mask = full;
  while (mask) {
    const bonus = sums[mask] === 0 ? 1 : 0;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j) && best[mask ^ (1 << j)]! + bonus === best[mask]) {
        order.push(j);
        mask ^= 1 << j;
        break;
      }
    }
  }
  order.reverse();

  const groups: Array<Array<[string, Cents]>> = [];
  let current: Array<[string, Cents]> = [];
  let running = 0;
  for (const j of order) {
    current.push(people[j]!);
    running += people[j]![1];
    if (running === 0) {
      groups.push(current);
      current = [];
    }
  }
  return groups;
}

function greedySettle(group: Array<[string, Cents]>, currency: string): Transfer[] {
  const debtors = group.filter(([, c]) => c < 0).map(([id, c]) => ({ id, left: -c }));
  const creditors = group.filter(([, c]) => c > 0).map(([id, c]) => ({ id, left: c }));
  const byLargest = (a: { id: string; left: number }, b: { id: string; left: number }) =>
    b.left - a.left || (a.id < b.id ? -1 : 1);
  const transfers: Transfer[] = [];
  while (debtors.length && creditors.length) {
    debtors.sort(byLargest);
    creditors.sort(byLargest);
    const d = debtors[0]!;
    const c = creditors[0]!;
    const amount = Math.min(d.left, c.left);
    transfers.push({ fromId: d.id, toId: c.id, amountCents: amount, currency });
    d.left -= amount;
    c.left -= amount;
    if (d.left === 0) debtors.shift();
    if (c.left === 0) creditors.shift();
  }
  return transfers;
}
