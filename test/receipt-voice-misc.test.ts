import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite } from '../src/invite.js';
import { epcQrPayload, ibanChecksumOk, paymentLink } from '../src/payments.js';
import { parseReceipt, type OcrLine } from '../src/receipt.js';
import { parseVoiceCommand } from '../src/voice.js';

const lines = (text: string, confidence = 0.95): OcrLine[] => text.trim().split('\n').map((t) => ({ text: t, confidence }));
let n = 0;
const ids = () => `i${++n}`;

describe('parseReceipt', () => {
  it('reads an English restaurant receipt with tax and tip on top', () => {
    const r = parseReceipt(
      lines(`
        Trattoria Roma
        Table 4   Waiter: Luca
        2 x Margherita        24.00
        Carbonara             14.50
        Wine 2 x 18.00        36.00
        Subtotal              74.50
        Tax 10%                7.45
        Tip                   10.00
        TOTAL                 91.95
        VISA ****1234         91.95
      `),
      ids,
    );
    expect(r.merchant).toBe('Trattoria Roma');
    expect(r.items.map((i) => [i.name, i.priceCents, i.quantity])).toEqual([
      ['Margherita', 2400, 2],
      ['Carbonara', 1450, 1],
      ['Wine', 3600, 2],
    ]);
    expect(r).toMatchObject({ subtotalCents: 7450, taxCents: 745, tipCents: 1000, totalCents: 9195, taxIncluded: false, warnings: [] });
  });

  it('reads a Polish receipt where VAT (PTU) is already in the prices', () => {
    const r = parseReceipt(
      lines(`
        Pierogarnia u Zosi
        Pierogi ruskie A      28,00
        Żurek A               19,50
        Kompot 3 x 6,00 B     18,00
        Rabat -10%            -6,55
        PTU A 8%               3,38
        PTU B 23%              3,37
        SUMA PLN              58,95
        Karta                 58,95
      `),
      ids,
    );
    expect(r.currency).toBe('PLN');
    expect(r.items.map((i) => i.name)).toEqual(['Pierogi ruskie', 'Żurek', 'Kompot', 'Rabat -10%']);
    expect(r.totalCents).toBe(5895);
    expect(r.taxIncluded).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('warns and lowers confidence when the AI misread something', () => {
    const r = parseReceipt(
      lines(`
        Beer 2 x 4.50          9.80
        Fries                  3.00
        TOTAL                 12.00
      `),
      ids,
    );
    expect(r.items[0]!.confidence).toBeLessThan(0.8);
    expect(r.warnings.join(' ')).toMatch(/difference -0\.80/);
  });

  it('handles empty or garbage input without throwing', () => {
    expect(parseReceipt([], ids).warnings.length).toBe(2);
    const r = parseReceipt([{ text: '@@@ 1.00', confidence: Number.NaN }], ids);
    expect(r.items[0]!.confidence).toBe(0);
  });
});

describe('parseVoiceCommand', () => {
  it.each([
    ['Add sunscreen to the list', { kind: 'list.add', items: ['sunscreen'] }],
    ['add some bread, milk and eggs', { kind: 'list.add', items: ['bread', 'milk', 'eggs'] }],
    ['Dodaj krem do opalania i ręczniki do listy', { kind: 'list.add', items: ['krem do opalania', 'ręczniki'] }],
    ['tick off sunscreen', { kind: 'list.done', item: 'sunscreen' }],
    ['usuń chleb z listy', { kind: 'list.remove', item: 'chleb' }],
    ['How much do I owe?', { kind: 'balance.mine' }],
    ['ile jestem winien', { kind: 'balance.mine' }],
    ['who owes whom', { kind: 'settle.read' }],
    ['read the total', { kind: 'bill.total' }],
    ['play some music', { kind: 'unknown', text: 'play some music' }],
  ])('%s', (text, intent) => {
    expect(parseVoiceCommand(text)).toEqual(intent);
  });
});

describe('invite', () => {
  it('round-trips and rejects expired or foreign codes', () => {
    const invite = { gatherId: 'trip1', gatherName: 'Lisbon & co', hostDeviceId: 'dev-123', code: '042917', expiresAt: 2000 };
    const text = encodeInvite(invite);
    expect(decodeInvite(text, 1000)).toEqual({ ok: true, invite });
    expect(decodeInvite(text, 3000)).toEqual({ ok: false, error: 'expired' });
    expect(decodeInvite('https://evil.example', 1000)).toEqual({ ok: false, error: 'not-a-gather-code' });
    expect(decodeInvite('gather://join?g=x&c=1', 1000)).toEqual({ ok: false, error: 'malformed' });
    expect(decodeInvite('gather://join?g=%E0%A4%A&h=x&c=123456&e=5000', 1000)).toEqual({ ok: false, error: 'malformed' });
  });
});

describe('payments', () => {
  it('builds payment links only for safe handles', () => {
    expect(paymentLink({ kind: 'paypal', username: 'annaR' }, 1840, 'EUR', 'Dinner')).toBe('https://paypal.me/annaR/18.40EUR');
    expect(paymentLink({ kind: 'link', template: 'javascript:alert(1)//{amount}' }, 100, 'EUR', '')).toBeNull();
    expect(paymentLink({ kind: 'link', template: 'https://pay.example/a?x={amount}&n={note}' }, 1840, 'PLN', 'Pizza & wine')).toBe(
      'https://pay.example/a?x=18.40&n=Pizza%20%26%20wine',
    );
    expect(paymentLink(null, 100, 'EUR', '')).toBeNull();
  });

  it('builds a SEPA QR payload and validates the IBAN', () => {
    expect(ibanChecksumOk('DE89370400440532013000')).toBe(true);
    expect(ibanChecksumOk('DE89370400440532013001')).toBe(false);
    const qr = epcQrPayload({ kind: 'iban', iban: 'DE89 3704 0044 0532 0130 00', holder: 'Anna R' }, 1840, 'EUR', 'Gather: Lisbon');
    expect(qr?.split('\n')).toEqual(['BCD', '002', '1', 'SCT', '', 'Anna R', 'DE89370400440532013000', 'EUR18.40', '', '', 'Gather: Lisbon']);
    expect(epcQrPayload({ kind: 'iban', iban: 'DE89370400440532013000', holder: 'A' }, 1840, 'PLN', '')).toBeNull();
  });
});
