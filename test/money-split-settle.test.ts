import { describe, expect, it } from 'vitest';
import { allocate, toCents } from '../src/money.js';
import { settleUp } from '../src/settle.js';
import { splitBill } from '../src/split.js';
import type { Bill, BillItem } from '../src/state.js';

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('money', () => {
  it('parses common receipt formats', () => {
    expect(toCents('12.50')).toBe(1250);
    expect(toCents('12,5')).toBe(1250);
    expect(toCents('1 234,56')).toBe(123456);
    expect(toCents('1.234,56')).toBe(123456);
    expect(toCents('-3.00')).toBe(-300);
    expect(toCents(18.4)).toBe(1840);
    expect(() => toCents('abc')).toThrow();
  });

  it('allocate always adds up exactly and is deterministic', () => {
    const parts = allocate(1000, [['a', 1], ['b', 1], ['c', 1]]);
    expect(sum(parts)).toBe(1000);
    expect([...parts.values()].sort()).toEqual([333, 333, 334]);
    expect(allocate(1000, [['c', 1], ['b', 1], ['a', 1]])).toEqual(new Map([['c', 333], ['b', 333], ['a', 334]]));
    expect(sum(allocate(-500, [['a', 2], ['b', 1]]))).toBe(-500);
    expect(allocate(10, [['a', 0], ['b', 0]])).toEqual(new Map([['a', 5], ['b', 5]]));
    for (let total = 0; total < 500; total += 7) {
      expect(sum(allocate(total, [['a', 0.5], ['b', 1.5], ['c', 3]]))).toBe(total);
    }
  });
});

function item(id: string, name: string, priceCents: number, extra: Partial<BillItem> = {}): BillItem {
  return { id, name, priceCents, quantity: 1, shared: false, confidence: 1, confirmed: true, ...extra };
}

function bill(partial: Partial<Bill> & { items: BillItem[] }): Bill {
  return {
    id: 'b1',
    title: 'Dinner',
    payerId: 'anna',
    currency: 'EUR',
    claims: new Map(),
    taxCents: 0,
    taxIncluded: false,
    tipCents: 0,
    serviceCents: 0,
    receiptTotalCents: null,
    participants: ['anna', 'ben', 'cleo'],
    extrasMode: 'proportional',
    createdAt: 0,
    createdBy: 'anna',
    ...partial,
    items: new Map(partial.items.map((i) => [i.id, i])),
  };
}

describe('splitBill', () => {
  it('splits claimed, shared and extras, and the shares add up to the total', () => {
    const b = bill({
      items: [item('pasta', 'Pasta', 1400), item('steak', 'Steak', 2600), item('pizza', 'Pizza', 1800, { shared: true }), item('wine', 'Wine', 3000)],
      tipCents: 1000,
      taxCents: 700,
      receiptTotalCents: 9500, // printed total; the tip was added at the table
    });
    b.claims.set('pasta', new Map([['ben', 1]]));
    b.claims.set('steak', new Map([['cleo', 1]]));
    b.claims.set('wine', new Map([['anna', 1], ['cleo', 2]]));

    const s = splitBill(b);
    expect(s.totalCents).toBe(10500);
    expect(s.warnings).toEqual([]);
    expect(s.ready).toBe(true);
    expect(s.shares.get('ben')!.itemsCents).toBe(1400 + 600);
    expect(s.shares.get('anna')!.itemsCents).toBe(600 + 1000);
    expect(s.shares.get('cleo')!.itemsCents).toBe(2600 + 600 + 2000);
    expect([...s.shares.values()].reduce((a, x) => a + x.totalCents, 0)).toBe(10500);
    // Extras follow consumption: Cleo ate most, so pays most of tax + tip.
    expect(s.shares.get('cleo')!.extrasCents).toBeGreaterThan(s.shares.get('ben')!.extrasCents);
  });

  it('does not add tax that is already included in prices', () => {
    const s = splitBill(bill({ items: [item('a', 'Soup', 1230, { shared: true })], taxCents: 230, taxIncluded: true, receiptTotalCents: 1230 }));
    expect(s.totalCents).toBe(1230);
    expect(s.warnings).toEqual([]);
  });

  it('never silently gets it wrong: flags unclaimed items, unsure prices and total mismatch', () => {
    const s = splitBill(
      bill({
        items: [item('a', 'Beer', 450, { confidence: 0.55, confirmed: false }), item('b', 'Fries', 300)],
        receiptTotalCents: 800,
      }),
    );
    expect(s.ready).toBe(false);
    expect(s.warnings.map((w) => w.kind).sort()).toEqual(['low-confidence', 'total-mismatch', 'unclaimed-item', 'unclaimed-item']);
    expect(s.warnings.find((w) => w.kind === 'total-mismatch')).toMatchObject({ differenceCents: 50 });
  });
});

describe('settleUp', () => {
  const total = (t: { amountCents: number }[]) => t.reduce((a, x) => a + x.amountCents, 0);

  function applyTransfers(balances: Map<string, number>, transfers: ReturnType<typeof settleUp>) {
    const after = new Map(balances);
    for (const t of transfers) {
      after.set(t.fromId, after.get(t.fromId)! + t.amountCents);
      after.set(t.toId, after.get(t.toId)! - t.amountCents);
    }
    return after;
  }

  it('makes everyone even', () => {
    const balances = new Map([['anna', 5000], ['ben', -2000], ['cleo', -3000]]);
    const transfers = settleUp(balances, 'EUR');
    expect(transfers).toHaveLength(2);
    expect(total(transfers)).toBe(5000);
    expect([...applyTransfers(balances, transfers).values()].every((v) => v === 0)).toBe(true);
  });

  it('finds the minimum where greedy does not', () => {
    // Largest-debtor-to-largest-creditor needs 7 payments here; the optimum is 5
    // (the eight balances split into three zero-sum groups: 8 - 3 = 5).
    const values = [-900, 400, -600, 400, -800, -300, 600, 1200];
    const balances = new Map(values.map((v, i) => [`p${i}`, v]));
    const transfers = settleUp(balances, 'EUR');
    expect(transfers).toHaveLength(5);
    expect(bruteForceMin(values)).toBe(5);
    expect([...applyTransfers(balances, transfers).values()].every((v) => v === 0)).toBe(true);
  });

  it('matches brute-force optimum on random cases', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 60; round++) {
      const n = 2 + Math.floor(rand() * 6);
      const values = Array.from({ length: n - 1 }, () => Math.round((rand() - 0.5) * 20) * 100);
      values.push(-values.reduce((a, b) => a + b, 0));
      const balances = new Map(values.map((v, i) => [`p${i}`, v]));
      const transfers = settleUp(balances, 'EUR');
      expect([...applyTransfers(balances, transfers).values()].every((v) => v === 0)).toBe(true);
      expect(transfers.length).toBe(bruteForceMin(values.filter((v) => v !== 0)));
    }
  });

  it('rejects balances that do not sum to zero', () => {
    expect(() => settleUp(new Map([['a', 100], ['b', -50]]), 'EUR')).toThrow();
  });
});

/** n − (max number of zero-sum groups), by exhaustive search. */
function bruteForceMin(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const memo = new Map<number, number>();
  const groups = (mask: number): number => {
    if (mask === 0) return 0;
    if (memo.has(mask)) return memo.get(mask)!;
    const first = mask & -mask;
    let best = -Infinity;
    for (let sub = mask; sub > 0; sub = (sub - 1) & mask) {
      if (!(sub & first)) continue;
      let s = 0;
      for (let i = 0; i < n; i++) if (sub & (1 << i)) s += values[i]!;
      if (s === 0) best = Math.max(best, 1 + groups(mask ^ sub));
    }
    memo.set(mask, best);
    return best;
  };
  return n - groups((1 << n) - 1);
}
