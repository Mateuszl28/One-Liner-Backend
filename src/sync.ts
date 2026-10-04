import { HlcClock } from './hlc.js';
import { decodeOp, encodeOp, gatherPrefix, opKey, type Op, type OpBody } from './ops.js';
import { materialize, type GatherState } from './state.js';

export interface KVEntry {
  key: string;
  value: string;
}

/**
 * Storage + replication the session runs on. In the app this is the SyncStore
 * TurboModule (OpenHarmony distributedKVStore), which persists locally and
 * syncs to trusted nearby devices on its own, also after being offline.
 * `MemoryNetwork` implements it for tests and the two-device demo.
 */
export interface KVBackend {
  put(entries: KVEntry[]): Promise<void>;
  entries(prefix: string): Promise<KVEntry[]>;
  /** Called with entries that arrived from other devices. Returns an unsubscribe function. */
  subscribe(listener: (entries: KVEntry[]) => void): () => void;
}

export type StateListener = (state: GatherState) => void;

/**
 * Version vector: highest sequence number seen per device. Lets two phones
 * work out which ops the other is missing with one small message, for
 * transports that are not a synced KV store (e.g. a direct socket fallback).
 */
export type VersionVector = Record<string, number>;

export class GatherSession {
  private readonly ops = new Map<string, Op>();
  private readonly listeners = new Set<StateListener>();
  private nextSeq = 1;
  private current: GatherState;
  private unsubscribe: (() => void) | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly backend: KVBackend,
    readonly gatherId: string,
    readonly deviceId: string,
    private readonly clock: HlcClock,
  ) {
    this.current = materialize(gatherId, []);
  }

  /** Opens a Gather on this device: loads the local log and starts listening for remote ops. */
  static async open(
    backend: KVBackend,
    gatherId: string,
    deviceId: string,
    now: () => number = () => Date.now(),
  ): Promise<GatherSession> {
    validateId(gatherId, 'gatherId');
    validateId(deviceId, 'deviceId');
    const session = new GatherSession(backend, gatherId, deviceId, new HlcClock(deviceId, now));
    session.unsubscribe = backend.subscribe((entries) => session.ingest(entries));
    session.ingest(await backend.entries(gatherPrefix(gatherId)), true);
    session.recompute();
    return session;
  }

  get state(): GatherState {
    return this.current;
  }

  /** The member this device acts as, once it created or joined the Gather. */
  get memberId(): string | null {
    return this.current.deviceMembers.get(this.deviceId) ?? null;
  }

  onChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  /**
   * Records a local change. The op is applied to local state immediately (so
   * the UI never waits for the network) and then written to the backend.
   * Returns the op and whether it was accepted by the rules in `materialize`.
   */
  async apply(body: OpBody): Promise<{ op: Op; accepted: boolean; reason?: string }> {
    const seq = this.nextSeq++;
    const op = { ...body, id: `${this.deviceId}:${seq}`, gatherId: this.gatherId, device: this.deviceId, seq, hlc: this.clock.tick() } as Op;
    this.ops.set(op.id, op);
    this.recompute();
    const rejected = this.current.rejected.find((r) => r.id === op.id);
    if (rejected) {
      // Refused by the rules on this device: do not broadcast it.
      this.ops.delete(op.id);
      this.recompute();
      return { op, accepted: false, reason: rejected.reason };
    }

    const write = this.writeQueue.then(() => this.backend.put([{ key: opKey(op), value: encodeOp(op) }]));
    this.writeQueue = write.catch(() => undefined);
    try {
      await write;
    } catch (err) {
      // Not persisted means not shared: roll back so the UI does not show a change other phones will never see.
      this.ops.delete(op.id);
      this.recompute();
      throw err;
    }
    return { op, accepted: true };
  }

  /** All ops this device knows about, for diagnostics and socket-based sync. */
  allOps(): Op[] {
    return [...this.ops.values()];
  }

  versionVector(): VersionVector {
    const vv: VersionVector = {};
    for (const op of this.ops.values()) vv[op.device] = Math.max(vv[op.device] ?? 0, op.seq);
    return vv;
  }

  /** Ops the peer with version vector `theirs` has not seen yet. */
  opsMissingFrom(theirs: VersionVector): Op[] {
    return this.allOps().filter((op) => op.seq > (theirs[op.device] ?? 0));
  }

  /** Accepts ops received over a non-KV transport and persists them locally. */
  async receive(ops: Op[]): Promise<void> {
    const entries = ops.map((op) => ({ key: opKey(op), value: encodeOp(op) }));
    this.ingest(entries);
    await this.backend.put(entries);
  }

  private ingest(entries: KVEntry[], initial = false): void {
    const prefix = gatherPrefix(this.gatherId);
    let changed = false;
    for (const { key, value } of entries) {
      if (!key.startsWith(prefix)) continue;
      const op = decodeOp(value);
      // Drop malformed ops and ops stored under a key that does not match their author/seq, keeping keys single-writer.
      if (!op || op.gatherId !== this.gatherId || opKey(op) !== key || this.ops.has(op.id)) continue;
      this.ops.set(op.id, op);
      this.clock.observe(op.hlc);
      if (op.device === this.deviceId) this.nextSeq = Math.max(this.nextSeq, op.seq + 1);
      changed = true;
    }
    if (changed && !initial) this.recompute();
  }

  private recompute(): void {
    this.current = materialize(this.gatherId, this.ops.values());
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch {
        // A failing UI listener must not stop sync for the others.
      }
    }
  }
}

function validateId(id: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error(`${label} must be 4-64 chars of [A-Za-z0-9_-]`);
}
