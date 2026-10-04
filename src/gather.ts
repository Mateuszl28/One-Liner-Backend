import { toCents, type Cents } from './money.js';
import type { ExtrasMode, PaymentHandle, ReceiptItemInput } from './ops.js';
import type { ParsedReceipt } from './receipt.js';
import { computeBalances, settleAll, type Transfer } from './settle.js';
import { splitBill, type BillSplit } from './split.js';
import { GatherSession, type KVBackend } from './sync.js';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Random id without relying on crypto APIs that may be missing in the JS runtime. */
export function newId(length = 12, random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < length; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  return id;
}

export class GatherError extends Error {}

/**
 * Typed actions on top of `GatherSession`. This is the API the React Native
 * screens call; each method maps to one or more ops and throws `GatherError`
 * when the change was refused (e.g. a non-owner trying to remove a member).
 */
export class Gather {
  private constructor(readonly session: GatherSession) {}

  static async open(backend: KVBackend, gatherId: string, deviceId: string, now?: () => number): Promise<Gather> {
    return new Gather(await GatherSession.open(backend, gatherId, deviceId, now));
  }

  /** "New Gather": this device becomes the owner. */
  static async create(
    backend: KVBackend,
    opts: { deviceId: string; name: string; ownerName: string; currency?: string; gatherId?: string; now?: () => number },
  ): Promise<Gather> {
    const gather = await Gather.open(backend, opts.gatherId ?? newId(), opts.deviceId, opts.now);
    await gather.do({
      type: 'gather.create',
      name: opts.name,
      ownerMemberId: newId(),
      ownerName: opts.ownerName,
      currency: opts.currency ?? 'EUR',
    });
    return gather;
  }

  get state() {
    return this.session.state;
  }

  get me(): string {
    const id = this.session.memberId;
    if (!id) throw new GatherError('This device has not joined the Gather yet');
    return id;
  }

  get isOwner(): boolean {
    return this.session.state.ownerDevice === this.session.deviceId;
  }

  onChange = (listener: Parameters<GatherSession['onChange']>[0]) => this.session.onChange(listener);

  close(): void {
    this.session.close();
  }

  private async do(body: Parameters<GatherSession['apply']>[0]): Promise<void> {
    const result = await this.session.apply(body);
    if (!result.accepted) throw new GatherError(result.reason ?? 'Change was rejected');
  }

  // Members

  /** Called on the joining phone after GatherNet paired it and the KV store synced the Gather. */
  async join(name: string, paymentHandle?: PaymentHandle): Promise<string> {
    if (this.session.memberId) return this.session.memberId;
    if (!this.state.ownerMemberId) throw new GatherError('Gather data has not arrived yet; stay close to the host and retry');
    const memberId = newId();
    await this.do({ type: 'member.join', memberId, name, guest: false, ...(paymentHandle ? { paymentHandle } : {}) });
    return memberId;
  }

  /** Adds someone without a phone (or without the app) so they can still be part of a split. */
  async addGuest(name: string): Promise<string> {
    const memberId = newId();
    await this.do({ type: 'member.join', memberId, name, guest: true });
    return memberId;
  }

  async rename(memberId: string, name: string): Promise<void> {
    await this.do({ type: 'member.update', memberId, name });
  }

  async setPaymentHandle(handle: PaymentHandle | null): Promise<void> {
    await this.do({ type: 'member.update', memberId: this.me, paymentHandle: handle });
  }

  async removeMember(memberId: string): Promise<void> {
    await this.do({ type: 'member.remove', memberId });
  }

  activeMembers() {
    return [...this.state.members.values()].filter((m) => !m.removed);
  }

  // Shared list

  async addListItem(text: string, listId = 'main'): Promise<string> {
    const itemId = newId();
    await this.do({ type: 'list.add', itemId, text, listId });
    return itemId;
  }

  async setListItemDone(itemId: string, done: boolean): Promise<void> {
    await this.do({ type: 'list.update', itemId, done });
  }

  async editListItem(itemId: string, text: string): Promise<void> {
    await this.do({ type: 'list.update', itemId, text });
  }

  async removeListItem(itemId: string): Promise<void> {
    await this.do({ type: 'list.remove', itemId });
  }

  /** Finds a list item by spoken/typed text, used by voice commands ("tick off sunscreen"). */
  findListItem(text: string) {
    const needle = text.trim().toLowerCase();
    const items = [...this.state.list.values()];
    return (
      items.find((i) => i.text.toLowerCase() === needle) ??
      items.find((i) => i.text.toLowerCase().includes(needle) || needle.includes(i.text.toLowerCase()))
    );
  }

  // Bills

  async addBill(opts: {
    title: string;
    payerId?: string;
    currency?: string;
    items: Array<Omit<ReceiptItemInput, 'id' | 'confidence' | 'quantity' | 'shared'> & Partial<ReceiptItemInput>>;
    taxCents?: Cents;
    taxIncluded?: boolean;
    tipCents?: Cents;
    serviceCents?: Cents;
    receiptTotalCents?: Cents | null;
    participants?: string[];
    extrasMode?: ExtrasMode;
  }): Promise<string> {
    const billId = newId();
    await this.do({
      type: 'bill.create',
      billId,
      title: opts.title,
      payerId: opts.payerId ?? this.me,
      currency: opts.currency ?? this.state.currency,
      items: opts.items.map((i) => ({
        id: i.id ?? newId(),
        name: i.name,
        priceCents: i.priceCents,
        quantity: i.quantity ?? 1,
        shared: i.shared ?? false,
        confidence: i.confidence ?? 1,
      })),
      taxCents: opts.taxCents ?? 0,
      taxIncluded: opts.taxIncluded ?? false,
      tipCents: opts.tipCents ?? 0,
      serviceCents: opts.serviceCents ?? 0,
      receiptTotalCents: opts.receiptTotalCents ?? null,
      participants: opts.participants ?? this.activeMembers().map((m) => m.id),
      extrasMode: opts.extrasMode ?? 'proportional',
    });
    return billId;
  }

  /** Creates a bill straight from ReceiptAI output. Uncertain prices stay flagged until confirmed. */
  async addBillFromReceipt(receipt: ParsedReceipt, opts: { title?: string; payerId?: string; tipCents?: Cents } = {}): Promise<string> {
    return this.addBill({
      title: opts.title ?? receipt.merchant ?? 'Receipt',
      ...(opts.payerId ? { payerId: opts.payerId } : {}),
      currency: receipt.currency ?? this.state.currency,
      items: receipt.items,
      taxCents: receipt.taxCents,
      taxIncluded: receipt.taxIncluded,
      tipCents: opts.tipCents ?? receipt.tipCents,
      serviceCents: receipt.serviceCents,
      receiptTotalCents: receipt.totalCents === null ? null : receipt.totalCents - receipt.tipCents,
    });
  }

  /** "I had this" tap. Tapping again with shares 0 removes the claim. */
  async claim(billId: string, itemId: string, shares = 1, memberId = this.me): Promise<void> {
    await this.do({ type: 'bill.claim', billId, itemId, memberId, shares });
  }

  async markShared(billId: string, itemId: string, shared = true): Promise<void> {
    await this.do({ type: 'bill.updateItem', billId, itemId, shared });
  }

  /** Fixes a misread item; also marks it confirmed so the warning goes away. */
  async fixItem(billId: string, itemId: string, fix: { name?: string; price?: string | number; quantity?: number }): Promise<void> {
    await this.do({
      type: 'bill.updateItem',
      billId,
      itemId,
      ...(fix.name !== undefined ? { name: fix.name } : {}),
      ...(fix.price !== undefined ? { priceCents: toCents(fix.price) } : {}),
      ...(fix.quantity !== undefined ? { quantity: fix.quantity } : {}),
    });
  }

  async setTip(billId: string, tipCents: Cents): Promise<void> {
    await this.do({ type: 'bill.update', billId, tipCents });
  }

  async deleteBill(billId: string): Promise<void> {
    await this.do({ type: 'bill.delete', billId });
  }

  split(billId: string): BillSplit {
    const bill = this.state.bills.get(billId);
    if (!bill) throw new GatherError(`Unknown bill ${billId}`);
    return splitBill(bill);
  }

  // Settle up

  balances() {
    return computeBalances(this.state);
  }

  settleUp(): Transfer[] {
    return settleAll(this.balances());
  }

  async recordPayment(transfer: Pick<Transfer, 'fromId' | 'toId' | 'amountCents'> & { currency?: string }): Promise<void> {
    await this.do({
      type: 'payment.record',
      paymentId: newId(),
      fromId: transfer.fromId,
      toId: transfer.toId,
      amountCents: transfer.amountCents,
      currency: transfer.currency ?? this.state.currency,
    });
  }

  // Photo drop (metadata only; files move phone-to-phone via GatherNet)

  async addPhoto(fileName: string, takenAt: number, bytes: number): Promise<string> {
    const photoId = newId();
    await this.do({ type: 'photo.add', photoId, fileName, takenAt, bytes });
    return photoId;
  }

  /** Photos other phones hold that this phone has not received yet. */
  missingPhotos(localPhotoIds: Iterable<string>) {
    const have = new Set(localPhotoIds);
    return [...this.state.photos.values()].filter((p) => p.ownerDevice !== this.session.deviceId && !have.has(p.id));
  }
}
