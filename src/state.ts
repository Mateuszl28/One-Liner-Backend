import { compareHlc } from './hlc.js';
import type { Cents } from './money.js';
import type { ExtrasMode, Op, PaymentHandle, ReceiptItemInput } from './ops.js';

export interface Member {
  id: string;
  name: string;
  /** Device that owns this member; null for guests added by someone else (e.g. a friend without the app). */
  deviceId: string | null;
  paymentHandle: PaymentHandle | null;
  removed: boolean;
  joinedAt: number;
}

export interface ListItem {
  id: string;
  listId: string;
  text: string;
  done: boolean;
  addedBy: string | null; // member id
  createdAt: number;
}

export interface BillItem extends ReceiptItemInput {
  /** True once a person edited the AI-read price/name, so it is no longer "uncertain". */
  confirmed: boolean;
}

export interface Bill {
  id: string;
  title: string;
  payerId: string;
  currency: string;
  items: Map<string, BillItem>;
  /** itemId -> memberId -> shares */
  claims: Map<string, Map<string, number>>;
  taxCents: Cents;
  taxIncluded: boolean;
  tipCents: Cents;
  serviceCents: Cents;
  receiptTotalCents: Cents | null;
  participants: string[];
  extrasMode: ExtrasMode;
  createdAt: number;
  createdBy: string | null;
}

export interface Payment {
  id: string;
  fromId: string;
  toId: string;
  amountCents: Cents;
  currency: string;
  createdAt: number;
}

export interface Photo {
  id: string;
  fileName: string;
  ownerDevice: string;
  takenAt: number;
  bytes: number;
}

export interface RejectedOp {
  id: string;
  type: string;
  reason: string;
}

export interface GatherState {
  gatherId: string;
  name: string;
  currency: string;
  ownerMemberId: string | null;
  ownerDevice: string | null;
  members: Map<string, Member>;
  /** deviceId -> memberId */
  deviceMembers: Map<string, string>;
  list: Map<string, ListItem>;
  bills: Map<string, Bill>;
  payments: Map<string, Payment>;
  photos: Map<string, Photo>;
  /** Ops that were ignored, with the reason. Useful for debugging sync and for the demo. */
  rejected: RejectedOp[];
  opCount: number;
}

export function emptyState(gatherId: string): GatherState {
  return {
    gatherId,
    name: '',
    currency: 'EUR',
    ownerMemberId: null,
    ownerDevice: null,
    members: new Map(),
    deviceMembers: new Map(),
    list: new Map(),
    bills: new Map(),
    payments: new Map(),
    photos: new Map(),
    rejected: [],
    opCount: 0,
  };
}

export function sortOps(ops: Iterable<Op>): Op[] {
  return [...ops].sort((a, b) => compareHlc(a.hlc, b.hlc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const MAX_TEXT = 500;
const MAX_ITEMS_PER_BILL = 300;

class Rejection extends Error {}

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Rejection(reason);
}

function cleanText(value: unknown, label: string): string {
  check(typeof value === 'string', `${label} must be a string`);
  const text = value.trim();
  check(text.length > 0, `${label} is empty`);
  check(text.length <= MAX_TEXT, `${label} is too long`);
  return text;
}

function checkCents(value: unknown, label: string, allowNegative = false): asserts value is number {
  check(typeof value === 'number' && Number.isSafeInteger(value), `${label} must be integer cents`);
  check(allowNegative || value >= 0, `${label} must not be negative`);
}

function checkCurrency(value: unknown): asserts value is string {
  check(typeof value === 'string' && /^[A-Z]{3}$/.test(value), 'currency must be an ISO 4217 code');
}

function checkItem(item: ReceiptItemInput): void {
  check(typeof item?.id === 'string' && item.id.length > 0, 'item id missing');
  cleanText(item.name, 'item name');
  checkCents(item.priceCents, 'item price', true);
  check(Number.isFinite(item.quantity) && item.quantity > 0, 'item quantity must be positive');
  check(Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1, 'confidence must be 0..1');
}

/**
 * Replays an op log into state. Pure and deterministic: any device holding the
 * same set of ops computes exactly the same state, regardless of arrival order.
 * Invalid or unauthorised ops are skipped and listed in `rejected` instead of
 * throwing, so one bad op from a buggy or hostile peer cannot break the Gather.
 */
export function materialize(gatherId: string, ops: Iterable<Op>): GatherState {
  const state = emptyState(gatherId);
  const seen = new Set<string>();
  for (const op of sortOps(ops)) {
    if (op.gatherId !== gatherId || seen.has(op.id)) continue;
    seen.add(op.id);
    state.opCount++;
    try {
      applyOp(state, op);
    } catch (err) {
      if (!(err instanceof Rejection)) throw err;
      state.rejected.push({ id: op.id, type: op.type, reason: err.message });
    }
  }
  return state;
}

function authorMemberId(state: GatherState, op: Op): string | null {
  const memberId = state.deviceMembers.get(op.device);
  if (!memberId) return null;
  const member = state.members.get(memberId);
  return member && !member.removed ? memberId : null;
}

function activeMember(state: GatherState, memberId: string): Member {
  const m = state.members.get(memberId);
  check(m && !m.removed, `member ${memberId} is not active`);
  return m;
}

function getBill(state: GatherState, billId: string): Bill {
  const bill = state.bills.get(billId);
  check(bill, `bill ${billId} does not exist`);
  return bill;
}

function applyOp(state: GatherState, op: Op): void {
  if (op.type === 'gather.create') {
    check(state.ownerMemberId === null, 'gather already created');
    checkCurrency(op.currency);
    state.name = cleanText(op.name, 'gather name');
    state.currency = op.currency;
    state.ownerMemberId = op.ownerMemberId;
    state.ownerDevice = op.device;
    state.members.set(op.ownerMemberId, {
      id: op.ownerMemberId,
      name: cleanText(op.ownerName, 'name'),
      deviceId: op.device,
      paymentHandle: null,
      removed: false,
      joinedAt: op.hlc.wall,
    });
    state.deviceMembers.set(op.device, op.ownerMemberId);
    return;
  }

  check(state.ownerMemberId !== null, 'gather not created yet');

  if (op.type === 'member.join') {
    const name = cleanText(op.name, 'name');
    const existing = state.members.get(op.memberId);
    if (op.guest) {
      check(authorMemberId(state, op), 'only members can add guests');
      check(!existing, 'member id already used');
    } else {
      check(!state.deviceMembers.has(op.device), 'device already joined');
      check(!existing, 'member id already used');
      state.deviceMembers.set(op.device, op.memberId);
    }
    state.members.set(op.memberId, {
      id: op.memberId,
      name,
      deviceId: op.guest ? null : op.device,
      paymentHandle: op.paymentHandle ?? null,
      removed: false,
      joinedAt: op.hlc.wall,
    });
    return;
  }

  // Every op below needs an active member as author. Ops a removed device made
  // after it was removed sort after the removal and are therefore dropped.
  const author = authorMemberId(state, op);
  check(author, 'author device is not an active member');

  switch (op.type) {
    case 'gather.rename':
      state.name = cleanText(op.name, 'gather name');
      return;

    case 'member.update': {
      const member = activeMember(state, op.memberId);
      const isGuest = member.deviceId === null;
      check(op.memberId === author || isGuest || op.device === state.ownerDevice, 'cannot edit another member');
      if (op.name !== undefined) member.name = cleanText(op.name, 'name');
      if (op.paymentHandle !== undefined) member.paymentHandle = op.paymentHandle;
      return;
    }

    case 'member.remove': {
      check(op.device === state.ownerDevice, 'only the owner can remove members');
      check(op.memberId !== state.ownerMemberId, 'owner cannot be removed');
      activeMember(state, op.memberId).removed = true;
      return;
    }

    case 'list.add':
      check(!state.list.has(op.itemId), 'list item id already used');
      state.list.set(op.itemId, {
        id: op.itemId,
        listId: op.listId || 'main',
        text: cleanText(op.text, 'list text'),
        done: false,
        addedBy: author,
        createdAt: op.hlc.wall,
      });
      return;

    case 'list.update': {
      const item = state.list.get(op.itemId);
      check(item, 'list item does not exist');
      if (op.text !== undefined) item.text = cleanText(op.text, 'list text');
      if (op.done !== undefined) item.done = Boolean(op.done);
      return;
    }

    case 'list.remove':
      check(state.list.delete(op.itemId), 'list item does not exist');
      return;

    case 'bill.create': {
      check(!state.bills.has(op.billId), 'bill id already used');
      checkCurrency(op.currency);
      check(Array.isArray(op.items) && op.items.length <= MAX_ITEMS_PER_BILL, 'invalid items');
      check(state.members.has(op.payerId), 'payer is not a member');
      check(Array.isArray(op.participants) && op.participants.length > 0, 'bill needs participants');
      for (const p of op.participants) check(state.members.has(p), `participant ${p} is not a member`);
      checkCents(op.taxCents, 'tax');
      checkCents(op.tipCents, 'tip');
      checkCents(op.serviceCents, 'service');
      if (op.receiptTotalCents !== null) checkCents(op.receiptTotalCents, 'receipt total');
      const items = new Map<string, BillItem>();
      for (const item of op.items) {
        checkItem(item);
        items.set(item.id, { ...item, name: item.name.trim(), confirmed: item.confidence >= 1 });
      }
      state.bills.set(op.billId, {
        id: op.billId,
        title: cleanText(op.title, 'bill title'),
        payerId: op.payerId,
        currency: op.currency,
        items,
        claims: new Map(),
        taxCents: op.taxCents,
        taxIncluded: Boolean(op.taxIncluded),
        tipCents: op.tipCents,
        serviceCents: op.serviceCents,
        receiptTotalCents: op.receiptTotalCents,
        participants: [...new Set(op.participants)],
        extrasMode: op.extrasMode === 'equal' ? 'equal' : 'proportional',
        createdAt: op.hlc.wall,
        createdBy: author,
      });
      return;
    }

    case 'bill.update': {
      const bill = getBill(state, op.billId);
      if (op.title !== undefined) bill.title = cleanText(op.title, 'bill title');
      if (op.payerId !== undefined) {
        check(state.members.has(op.payerId), 'payer is not a member');
        bill.payerId = op.payerId;
      }
      if (op.taxCents !== undefined) {
        checkCents(op.taxCents, 'tax');
        bill.taxCents = op.taxCents;
      }
      if (op.taxIncluded !== undefined) bill.taxIncluded = Boolean(op.taxIncluded);
      if (op.tipCents !== undefined) {
        checkCents(op.tipCents, 'tip');
        bill.tipCents = op.tipCents;
      }
      if (op.serviceCents !== undefined) {
        checkCents(op.serviceCents, 'service');
        bill.serviceCents = op.serviceCents;
      }
      if (op.participants !== undefined) {
        check(Array.isArray(op.participants) && op.participants.length > 0, 'bill needs participants');
        for (const p of op.participants) check(state.members.has(p), `participant ${p} is not a member`);
        bill.participants = [...new Set(op.participants)];
      }
      if (op.extrasMode !== undefined) bill.extrasMode = op.extrasMode === 'equal' ? 'equal' : 'proportional';
      return;
    }

    case 'bill.addItem': {
      const bill = getBill(state, op.billId);
      check(bill.items.size < MAX_ITEMS_PER_BILL, 'too many items');
      check(!bill.items.has(op.item.id), 'item id already used');
      checkItem(op.item);
      bill.items.set(op.item.id, { ...op.item, name: op.item.name.trim(), confirmed: op.item.confidence >= 1 });
      return;
    }

    case 'bill.updateItem': {
      const item = getBill(state, op.billId).items.get(op.itemId);
      check(item, 'item does not exist');
      if (op.name !== undefined) item.name = cleanText(op.name, 'item name');
      if (op.priceCents !== undefined) {
        checkCents(op.priceCents, 'item price', true);
        item.priceCents = op.priceCents;
      }
      if (op.quantity !== undefined) {
        check(Number.isFinite(op.quantity) && op.quantity > 0, 'item quantity must be positive');
        item.quantity = op.quantity;
      }
      if (op.shared !== undefined) item.shared = Boolean(op.shared);
      if (op.name !== undefined || op.priceCents !== undefined) item.confirmed = true;
      return;
    }

    case 'bill.removeItem': {
      const bill = getBill(state, op.billId);
      check(bill.items.delete(op.itemId), 'item does not exist');
      bill.claims.delete(op.itemId);
      return;
    }

    case 'bill.claim': {
      const bill = getBill(state, op.billId);
      check(bill.items.has(op.itemId), 'item does not exist');
      check(state.members.has(op.memberId), 'claimer is not a member');
      check(Number.isFinite(op.shares) && op.shares >= 0 && op.shares <= 1000, 'invalid shares');
      let claims = bill.claims.get(op.itemId);
      if (!claims) bill.claims.set(op.itemId, (claims = new Map()));
      if (op.shares === 0) claims.delete(op.memberId);
      else claims.set(op.memberId, op.shares);
      if (op.shares > 0 && !bill.participants.includes(op.memberId)) bill.participants.push(op.memberId);
      return;
    }

    case 'bill.delete':
      check(state.bills.delete(op.billId), 'bill does not exist');
      return;

    case 'payment.record':
      check(!state.payments.has(op.paymentId), 'payment id already used');
      check(state.members.has(op.fromId) && state.members.has(op.toId), 'payment parties must be members');
      check(op.fromId !== op.toId, 'payment to self');
      checkCents(op.amountCents, 'payment amount');
      check(op.amountCents > 0, 'payment amount must be positive');
      checkCurrency(op.currency);
      state.payments.set(op.paymentId, {
        id: op.paymentId,
        fromId: op.fromId,
        toId: op.toId,
        amountCents: op.amountCents,
        currency: op.currency,
        createdAt: op.hlc.wall,
      });
      return;

    case 'payment.delete':
      check(state.payments.delete(op.paymentId), 'payment does not exist');
      return;

    case 'photo.add':
      check(!state.photos.has(op.photoId), 'photo id already used');
      state.photos.set(op.photoId, {
        id: op.photoId,
        fileName: cleanText(op.fileName, 'file name'),
        ownerDevice: op.device,
        takenAt: op.takenAt,
        bytes: op.bytes,
      });
      return;

    case 'photo.remove': {
      const photo = state.photos.get(op.photoId);
      check(photo, 'photo does not exist');
      check(photo.ownerDevice === op.device || op.device === state.ownerDevice, 'only the owner of a photo can remove it');
      state.photos.delete(op.photoId);
      return;
    }

    default:
      // Op from a newer app version: ignore so older phones keep working.
      throw new Rejection(`unknown op type ${(op as { type: string }).type}`);
  }
}
