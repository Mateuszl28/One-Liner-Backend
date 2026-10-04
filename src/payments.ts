import { formatMoney, type Cents } from './money.js';
import type { PaymentHandle } from './ops.js';
import type { Transfer } from './settle.js';
import type { GatherState } from './state.js';

export type Lang = 'en' | 'pl';

/** "You owe Anna €18.40" / "Ben owes you €5.00" lines for one member, ready for the screen and TTS. */
export function describeTransfers(state: GatherState, transfers: Transfer[], me: string, lang: Lang = 'en'): string[] {
  const name = (id: string) => state.members.get(id)?.name ?? '?';
  const lines: string[] = [];
  for (const t of transfers) {
    const amount = formatMoney(t.amountCents, t.currency, lang);
    if (t.fromId === me) lines.push(lang === 'pl' ? `Jesteś winien ${name(t.toId)} ${amount}` : `You owe ${name(t.toId)} ${amount}`);
    else if (t.toId === me) lines.push(lang === 'pl' ? `${name(t.fromId)} jest Ci winien ${amount}` : `${name(t.fromId)} owes you ${amount}`);
    else lines.push(lang === 'pl' ? `${name(t.fromId)} → ${name(t.toId)}: ${amount}` : `${name(t.fromId)} owes ${name(t.toId)} ${amount}`);
  }
  if (lines.length === 0) lines.push(lang === 'pl' ? 'Wszyscy są rozliczeni' : 'Everyone is settled up');
  return lines;
}

/**
 * Link that opens the payee's normal payment app with the amount filled in.
 * Returns null when the payee has no handle; the UI then shows the amount to
 * pay in cash. Nothing goes through a Gather server.
 */
export function paymentLink(handle: PaymentHandle | null, amountCents: Cents, currency: string, note: string): string | null {
  if (!handle) return null;
  const amount = (amountCents / 100).toFixed(2);
  switch (handle.kind) {
    case 'paypal':
      if (!/^[A-Za-z0-9]{1,64}$/.test(handle.username)) return null;
      return `https://paypal.me/${handle.username}/${amount}${currency}`;
    case 'iban':
      return null; // use epcQrPayload for bank transfers
    case 'link': {
      if (!/^https:\/\//.test(handle.template)) return null; // never open arbitrary schemes from synced data
      return handle.template
        .replace('{amount}', encodeURIComponent(amount))
        .replace('{currency}', encodeURIComponent(currency))
        .replace('{note}', encodeURIComponent(note));
    }
  }
}

/**
 * EPC069-12 ("SEPA QR" / GiroCode) payload: most European banking apps scan
 * it and pre-fill a transfer. Works fully offline. Only valid for EUR.
 */
export function epcQrPayload(handle: Extract<PaymentHandle, { kind: 'iban' }>, amountCents: Cents, currency: string, note: string): string | null {
  if (currency !== 'EUR' || amountCents <= 0 || amountCents > 99_999_999_999) return null;
  const iban = handle.iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban) || !ibanChecksumOk(iban)) return null;
  return [
    'BCD',
    '002',
    '1',
    'SCT',
    (handle.bic ?? '').toUpperCase(),
    handle.holder.slice(0, 70),
    iban,
    `EUR${(amountCents / 100).toFixed(2)}`,
    '',
    '',
    note.slice(0, 140),
  ].join('\n');
}

export function ibanChecksumOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export interface ReminderPlan {
  title: string;
  content: string;
  /** Unix ms, for @ohos.reminderAgentManager (ReminderRequestTimer / Calendar). */
  triggerAt: number;
}

/** Reminders for payments this member still owes: the evening after, then two days later. */
export function planPaymentReminders(state: GatherState, transfers: Transfer[], me: string, now: number, lang: Lang = 'en'): ReminderPlan[] {
  const owed = transfers.filter((t) => t.fromId === me);
  if (owed.length === 0) return [];
  const lines = describeTransfers(state, owed, me, lang);
  const title = lang === 'pl' ? `Gather: ${state.name} – do zapłaty` : `Gather: ${state.name} – time to settle up`;
  const content = lines.join('\n');
  const DAY = 24 * 60 * 60 * 1000;
  return [{ title, content, triggerAt: now + DAY }, { title, content, triggerAt: now + 3 * DAY }];
}
