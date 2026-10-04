import type { Cents } from './money.js';
import type { Hlc } from './hlc.js';

/**
 * Everything that happens in a Gather is an immutable operation. Each device
 * only ever writes its own operations (under its own keys in the KV store), so
 * replication never has write conflicts: devices exchange op logs and replay
 * them in HLC order, which makes every phone converge to the same state.
 */

export type PaymentHandle =
  | { kind: 'paypal'; username: string }
  | { kind: 'iban'; iban: string; bic?: string; holder: string }
  | { kind: 'link'; template: string }; // e.g. "https://pay.example/anna?amount={amount}&currency={currency}"

export interface ReceiptItemInput {
  id: string;
  name: string;
  priceCents: Cents; // line total; negative for discounts
  quantity: number;
  shared: boolean; // split across all participants when nobody claims it
  confidence: number; // 0..1 from ReceiptAI, 1 for manual entry
}

export type ExtrasMode = 'proportional' | 'equal';

export type OpBody =
  | { type: 'gather.create'; name: string; ownerMemberId: string; ownerName: string; currency: string }
  | { type: 'gather.rename'; name: string }
  | { type: 'member.join'; memberId: string; name: string; guest: boolean; paymentHandle?: PaymentHandle }
  | { type: 'member.update'; memberId: string; name?: string; paymentHandle?: PaymentHandle | null }
  | { type: 'member.remove'; memberId: string }
  | { type: 'list.add'; itemId: string; text: string; listId: string }
  | { type: 'list.update'; itemId: string; text?: string; done?: boolean }
  | { type: 'list.remove'; itemId: string }
  | {
      type: 'bill.create';
      billId: string;
      title: string;
      payerId: string;
      currency: string;
      items: ReceiptItemInput[];
      taxCents: Cents;
      taxIncluded: boolean;
      tipCents: Cents;
      serviceCents: Cents;
      /** Printed total excluding tip, used to catch misread prices. Null for manual bills. */
      receiptTotalCents: Cents | null;
      participants: string[];
      extrasMode: ExtrasMode;
    }
  | {
      type: 'bill.update';
      billId: string;
      title?: string;
      payerId?: string;
      taxCents?: Cents;
      taxIncluded?: boolean;
      tipCents?: Cents;
      serviceCents?: Cents;
      participants?: string[];
      extrasMode?: ExtrasMode;
    }
  | { type: 'bill.addItem'; billId: string; item: ReceiptItemInput }
  | {
      type: 'bill.updateItem';
      billId: string;
      itemId: string;
      name?: string;
      priceCents?: Cents;
      quantity?: number;
      shared?: boolean;
    }
  | { type: 'bill.removeItem'; billId: string; itemId: string }
  /** shares = 0 removes the claim. Each (item, member) pair is its own register, so concurrent taps never clash. */
  | { type: 'bill.claim'; billId: string; itemId: string; memberId: string; shares: number }
  | { type: 'bill.delete'; billId: string }
  | { type: 'payment.record'; paymentId: string; fromId: string; toId: string; amountCents: Cents; currency: string }
  | { type: 'payment.delete'; paymentId: string }
  | { type: 'photo.add'; photoId: string; fileName: string; takenAt: number; bytes: number }
  | { type: 'photo.remove'; photoId: string };

export type OpType = OpBody['type'];

export interface OpMeta {
  /** `${device}:${seq}` — unique and stable across devices. */
  id: string;
  gatherId: string;
  device: string;
  seq: number;
  hlc: Hlc;
}

export type Op = OpMeta & OpBody;

export const OP_KEY_PREFIX = 'g';

export function gatherPrefix(gatherId: string): string {
  return `${OP_KEY_PREFIX}/${gatherId}/op/`;
}

/** One key per op, written by exactly one device: no last-writer-wins races in the KV layer. */
export function opKey(op: Pick<OpMeta, 'gatherId' | 'device' | 'seq'>): string {
  return `${gatherPrefix(op.gatherId)}${op.device}/${String(op.seq).padStart(10, '0')}`;
}

export function encodeOp(op: Op): string {
  return JSON.stringify(op);
}

export function decodeOp(raw: string): Op | null {
  try {
    const op = JSON.parse(raw) as Op;
    if (
      typeof op?.id !== 'string' ||
      typeof op.type !== 'string' ||
      typeof op.device !== 'string' ||
      typeof op.seq !== 'number' ||
      typeof op.hlc?.wall !== 'number'
    ) {
      return null;
    }
    return op;
  } catch {
    return null;
  }
}
