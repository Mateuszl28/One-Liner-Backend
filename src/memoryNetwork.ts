import type { KVBackend, KVEntry } from './sync.js';

/**
 * In-memory stand-in for distributedKVStore across several devices. Each
 * device has its own store; while online, writes reach the other online
 * devices asynchronously. Going back online exchanges everything that was
 * missed, like the KV store does after a reconnect.
 */
export class MemoryNetwork {
  private readonly devices = new Map<string, MemoryDevice>();

  device(id: string): MemoryDevice {
    let d = this.devices.get(id);
    if (!d) this.devices.set(id, (d = new MemoryDevice(id, this)));
    return d;
  }

  /** Resolves once all in-flight deliveries have been processed. */
  async settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
  }

  /** @internal */
  broadcast(from: MemoryDevice, entries: KVEntry[]): void {
    for (const peer of this.devices.values()) {
      if (peer !== from && peer.online && from.online) setTimeout(() => peer.deliver(entries), 0);
    }
  }

  /** @internal */
  reconcile(device: MemoryDevice): void {
    for (const peer of this.devices.values()) {
      if (peer === device || !peer.online) continue;
      const toPeer = device.snapshot();
      const toDevice = peer.snapshot();
      setTimeout(() => {
        peer.deliver(toPeer);
        device.deliver(toDevice);
      }, 0);
    }
  }
}

export class MemoryDevice implements KVBackend {
  online = true;
  private readonly data = new Map<string, string>();
  private readonly listeners = new Set<(entries: KVEntry[]) => void>();

  constructor(
    readonly id: string,
    private readonly network: MemoryNetwork,
  ) {}

  setOnline(online: boolean): void {
    const wasOffline = !this.online;
    this.online = online;
    if (online && wasOffline) this.network.reconcile(this);
  }

  async put(entries: KVEntry[]): Promise<void> {
    for (const e of entries) this.data.set(e.key, e.value);
    this.network.broadcast(this, entries);
  }

  async entries(prefix: string): Promise<KVEntry[]> {
    return [...this.data.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
  }

  subscribe(listener: (entries: KVEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @internal */
  snapshot(): KVEntry[] {
    return [...this.data.entries()].map(([key, value]) => ({ key, value }));
  }

  /** @internal */
  deliver(entries: KVEntry[]): void {
    if (!this.online) return;
    const fresh = entries.filter((e) => this.data.get(e.key) !== e.value);
    if (fresh.length === 0) return;
    for (const e of fresh) this.data.set(e.key, e.value);
    for (const listener of this.listeners) listener(fresh);
  }
}
