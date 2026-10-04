/**
 * The hackathon demo script, run headless on two simulated phones:
 *   1. A creates a Gather, B joins
 *   2. list item added on A shows up on B
 *   3. receipt is read, each person taps their items, balances update on both
 *   4. settle-up and a payment reminder
 *   5. B goes offline, both edit, reconnect, changes merge
 * Run: npm run demo
 */
import {
  Gather,
  MemoryNetwork,
  describeTransfers,
  encodeInvite,
  decodeInvite,
  formatMoney,
  makeInviteCode,
  parseReceipt,
  parseVoiceCommand,
  paymentLink,
  planPaymentReminders,
  INVITE_TTL_MS,
} from '../src/index.js';

const log = (step: string, ...rest: unknown[]) => console.log(`\x1b[36m${step}\x1b[0m`, ...rest);
const list = (g: Gather) => [...g.state.list.values()].map((i) => (i.done ? `[x] ${i.text}` : `[ ] ${i.text}`));

const net = new MemoryNetwork();
const phoneA = net.device('emulatorA');
const phoneB = net.device('emulatorB');

// 1. Start a Gather and join with the QR invite
const a = await Gather.create(phoneA, { deviceId: 'emulatorA', name: 'Dinner in Lisbon', ownerName: 'Anna', currency: 'EUR' });
await a.setPaymentHandle({ kind: 'paypal', username: 'annaLisbon' });
const qr = encodeInvite({
  gatherId: a.state.gatherId,
  gatherName: a.state.name,
  hostDeviceId: 'emulatorA',
  code: makeInviteCode(),
  expiresAt: Date.now() + INVITE_TTL_MS,
});
log('1. A shows QR:', qr);
const scanned = decodeInvite(qr);
if (!scanned.ok) throw new Error(scanned.error);
await net.settle(); // GatherNet pairing + distributedKVStore sync happen here on real devices
const b = await Gather.open(phoneB, scanned.invite.gatherId, 'emulatorB');
await b.join('Ben');
await net.settle();
const cleo = await b.addGuest('Cleo (no phone)');
await net.settle();
log('   members on A:', a.activeMembers().map((m) => m.name).join(', '));

// 2. Shared list, including a voice command on B
await a.addListItem('Book table for tomorrow');
const voice = parseVoiceCommand('Add sunscreen and water to the list');
if (voice.kind === 'list.add') for (const item of voice.items) await b.addListItem(item);
await net.settle();
log('2. list on B:', list(b));
log('   list on A:', list(a));

// 3. Receipt photo -> OCR lines -> items; everybody taps what they had
const receipt = parseReceipt([
  { text: 'Taberna do Bairro', confidence: 0.98 },
  { text: 'Bacalhau à Brás       16.50', confidence: 0.97 },
  { text: 'Polvo grelhado        22.00', confidence: 0.96 },
  { text: 'Francesinha           14.00', confidence: 0.6 },
  { text: 'Vinho verde 1 x 21.00 21.00', confidence: 0.95 },
  { text: 'Pão e azeitonas        4.50', confidence: 0.93 },
  { text: 'IVA 23%               14.47', confidence: 0.9 },
  { text: 'TOTAL                 78.00', confidence: 0.97 },
]);
log('3. receipt read:', receipt.items.map((i) => `${i.name} ${formatMoney(i.priceCents, 'EUR')}${i.confidence < 0.8 ? ' (check!)' : ''}`).join(' | '));
log('   receipt warnings:', receipt.warnings.length ? receipt.warnings : 'none');
const billId = await a.addBillFromReceipt(receipt, { tipCents: 600 });
await net.settle();

const byName = (g: Gather, name: string) => [...g.state.bills.get(billId)!.items.values()].find((i) => i.name.startsWith(name))!.id;
await a.claim(billId, byName(a, 'Polvo'));
await b.claim(billId, byName(b, 'Bacalhau'));
await b.claim(billId, byName(b, 'Francesinha'), 1, cleo);
await b.markShared(billId, byName(b, 'Vinho'));
await a.markShared(billId, byName(a, 'Pão'));
await net.settle();
log('   warnings before fixing:', a.split(billId).warnings.map((w) => w.kind));
await b.fixItem(billId, byName(b, 'Francesinha'), { price: '14.00' }); // Ben confirms the uncertain price
await net.settle();

for (const [label, g] of [['A', a], ['B', b]] as const) {
  const split = g.split(billId);
  const rows = [...split.shares.values()].map((s) => `${g.state.members.get(s.memberId)!.name}: ${formatMoney(s.totalCents, 'EUR')}`);
  log(`   split on ${label} (total ${formatMoney(split.totalCents, 'EUR')}, ready=${split.ready}):`, rows.join(', '));
}

// 4. Settle up + reminder
const transfers = b.settleUp();
log('4. on B:', describeTransfers(b.state, transfers, b.me));
const toAnna = transfers.find((t) => t.fromId === b.me)!;
log('   pay link:', paymentLink(a.state.members.get(a.me)!.paymentHandle, toAnna.amountCents, 'EUR', 'Gather: Dinner in Lisbon'));
log('   reminders:', planPaymentReminders(b.state, transfers, b.me, Date.now()).map((r) => new Date(r.triggerAt).toISOString()));

// 5. Offline edits on both phones, then reconnect
phoneB.setOnline(false);
const table = a.findListItem('book table')!;
await a.setListItemDone(table.id, true);
await a.addListItem('Taxi to airport');
await b.addListItem('Postcards');
await b.editListItem(b.findListItem('water')!.id, 'Water (2 l)');
await b.recordPayment({ fromId: b.me, toId: a.me, amountCents: toAnna.amountCents });
await net.settle();
log('5. while offline, A:', list(a));
log('                  B:', list(b));
phoneB.setOnline(true);
await net.settle();
log('   after reconnect A:', list(a));
log('                   B:', list(b));
log('   same state on both:', JSON.stringify(list(a).sort()) === JSON.stringify(list(b).sort()));
log('   remaining on A:', describeTransfers(a.state, a.settleUp(), a.me));
