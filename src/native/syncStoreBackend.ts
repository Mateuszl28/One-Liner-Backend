import type { KVBackend, KVEntry } from '../sync.js';

/** Shape of the SyncStore TurboModule (see specs/NativeSyncStore.ts). */
export interface SyncStoreModule {
  open(storeId: string): Promise<void>;
  putBatch(entries: KVEntry[]): Promise<void>;
  getEntries(prefix: string): Promise<KVEntry[]>;
  syncNow(deviceIds: string[]): Promise<void>;
}

export interface SyncStoreChangeEvent {
  entries: KVEntry[];
  deviceId: string;
}

/** Subscribe function from React Native's NativeEventEmitter / DeviceEventEmitter. */
export type Subscribe = (event: 'SyncStore.change', handler: (e: SyncStoreChangeEvent) => void) => { remove(): void };

export const SYNC_STORE_ID = 'gather_ops_v1';

/** KV backend for the app, built on the native distributedKVStore wrapper. */
export async function createSyncStoreBackend(module: SyncStoreModule, subscribe: Subscribe): Promise<KVBackend> {
  await module.open(SYNC_STORE_ID);
  return {
    put: (entries) => withTimeout(module.putBatch(entries), 5000, 'SyncStore.putBatch'),
    entries: (prefix) => withTimeout(module.getEntries(prefix), 5000, 'SyncStore.getEntries'),
    subscribe(listener) {
      const sub = subscribe('SyncStore.change', (e) => {
        if (Array.isArray(e?.entries)) {
          listener(e.entries.filter((x) => typeof x?.key === 'string' && typeof x.value === 'string'));
        }
      });
      return () => sub.remove();
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
