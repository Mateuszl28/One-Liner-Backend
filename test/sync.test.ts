import { describe, expect, it } from 'vitest';
import { Gather, GatherError } from '../src/gather.js';
import { MemoryNetwork } from '../src/memoryNetwork.js';
import { encodeOp, opKey, type Op } from '../src/ops.js';
import { materialize } from '../src/state.js';

async function twoPhones() {
  const net = new MemoryNetwork();
  const devA = net.device('phoneA');
  const devB = net.device('phoneB');
  let t = 1_000_000;
  const clockA = () => (t += 1);
  // Phone B's clock is 10 minutes behind: HLC must still order its later edits correctly.
  const clockB = () => (t += 1) - 600_000;

  const a = await Gather.create(devA, { deviceId: 'phoneA', name: 'Lisbon trip', ownerName: 'Anna', gatherId: 'trip1', now: clockA });
  await net.settle();
  const b = await Gather.open(devB, 'trip1', 'phoneB', clockB);
  await b.join('Ben');
  await net.settle();
  return { net, devA, devB, a, b };
}

const listTexts = (g: Gather) => [...g.state.list.values()].map((i) => `${i.text}${i.done ? ' ✓' : ''}`).sort();

describe('sync between phones', () => {
  it('B joins and a list item added on A appears on B', async () => {
    const { net, a, b } = await twoPhones();
    expect(b.state.name).toBe('Lisbon trip');
    expect(a.activeMembers().map((m) => m.name).sort()).toEqual(['Anna', 'Ben']);

    let notified = 0;
    b.onChange(() => notified++);
    await a.addListItem('Sunscreen');
    await net.settle();
    expect(listTexts(b)).toEqual(['Sunscreen']);
    expect(notified).toBeGreaterThan(0);
  });

  it('merges offline edits on both phones after reconnect, including the same item', async () => {
    const { net, devB, a, b } = await twoPhones();
    const towels = await a.addListItem('Towels');
    await a.addListItem('Water');
    await net.settle();

    devB.setOnline(false);
    await a.addListItem('Snacks');
    await a.editListItem(towels, 'Beach towels');
    await b.addListItem('Charger');
    await b.setListItemDone(towels, true);
    await b.removeListItem([...b.state.list.values()].find((i) => i.text === 'Water')!.id);
    await net.settle();
    expect(listTexts(a)).not.toEqual(listTexts(b));

    devB.setOnline(true);
    await net.settle();
    expect(listTexts(a)).toEqual(['Beach towels ✓', 'Charger', 'Snacks']);
    expect(listTexts(b)).toEqual(listTexts(a));
  });

  it('two people tapping items at the same time both count', async () => {
    const { net, devB, a, b } = await twoPhones();
    const billId = await a.addBill({
      title: 'Dinner',
      items: [{ name: 'Pizza', priceCents: 2000, id: 'pizza' }, { name: 'Wine', priceCents: 3000, id: 'wine' }],
    });
    await net.settle();

    devB.setOnline(false);
    await a.claim(billId, 'pizza');
    await a.claim(billId, 'wine');
    await b.claim(billId, 'wine');
    devB.setOnline(true);
    await net.settle();

    for (const g of [a, b]) {
      const s = g.split(billId);
      expect(s.shares.get(a.me)!.totalCents).toBe(2000 + 1500);
      expect(s.shares.get(b.me)!.totalCents).toBe(1500);
    }
    expect(a.settleUp()).toEqual([{ fromId: b.me, toId: a.me, amountCents: 1500, currency: 'EUR' }]);
    expect(b.settleUp()).toEqual(a.settleUp());
  });

  it('only the owner can remove a device, and a removed device can no longer change anything', async () => {
    const { net, a, b } = await twoPhones();
    await expect(b.removeMember(a.me)).rejects.toThrow(GatherError);

    const bMember = b.me;
    await a.removeMember(bMember);
    await net.settle();
    await expect(b.addListItem('sneaky')).rejects.toThrow(/not an active member/);
    await net.settle();
    expect(listTexts(a)).toEqual([]);
    // Balances of a removed member are kept: they may still owe money.
    expect(a.state.members.get(bMember)!.removed).toBe(true);
  });

  it('every op order gives the same state', async () => {
    const { net, a, b } = await twoPhones();
    await a.addListItem('One');
    await b.addListItem('Two');
    const id = await a.addListItem('Three');
    await net.settle();
    await b.setListItemDone(id, true);
    await net.settle();

    const ops = a.session.allOps();
    const reference = JSON.stringify(serialize(materialize('trip1', ops)));
    for (let i = 0; i < 20; i++) {
      const shuffled = [...ops].sort(() => Math.random() - 0.5);
      expect(JSON.stringify(serialize(materialize('trip1', shuffled)))).toBe(reference);
    }
  });

  it('ignores garbage and mis-keyed data from the KV store', async () => {
    const { net, devB, a } = await twoPhones();
    const forged: Op = {
      type: 'member.remove',
      memberId: a.me,
      id: 'phoneA:999',
      gatherId: 'trip1',
      device: 'phoneA',
      seq: 999,
      hlc: { wall: 9e12, counter: 0, node: 'phoneA' },
    };
    await devB.put([
      { key: 'g/trip1/op/phoneB/0000000500', value: '{not json' },
      // Claims to be from phoneA but is stored under phoneB's key range.
      { key: 'g/trip1/op/phoneB/0000000501', value: encodeOp(forged) },
    ]);
    await net.settle();
    expect(a.state.members.get(a.me)!.removed).toBe(false);
    expect(a.session.allOps().some((o) => o.seq >= 500)).toBe(false);
    expect(opKey(forged)).not.toBe('g/trip1/op/phoneB/0000000501');
  });

  it('peers can sync over a non-KV transport with version vectors', async () => {
    const netA = new MemoryNetwork();
    const netB = new MemoryNetwork(); // no shared KV: e.g. emulators without the soft bus
    const a = await Gather.create(netA.device('phoneA'), { deviceId: 'phoneA', name: 'Hike', ownerName: 'Anna', gatherId: 'hike1' });
    const b = await Gather.open(netB.device('phoneB'), 'hike1', 'phoneB');
    await b.session.receive(a.session.opsMissingFrom(b.session.versionVector()));
    await b.join('Ben');
    await a.session.receive(b.session.opsMissingFrom(a.session.versionVector()));
    expect(a.activeMembers().map((m) => m.name).sort()).toEqual(['Anna', 'Ben']);
    expect(a.session.opsMissingFrom(b.session.versionVector())).toEqual([]);
  });
});

function serialize(state: ReturnType<typeof materialize>) {
  return JSON.parse(
    JSON.stringify(state, (_k, v) => (v instanceof Map ? Object.fromEntries([...v.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) : v)),
  );
}
