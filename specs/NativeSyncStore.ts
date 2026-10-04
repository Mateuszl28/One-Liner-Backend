// TurboModule spec (React Native codegen). Native side: harmony/gather_modules/src/main/ets/SyncStoreModule.ets
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type KVEntry = { key: string; value: string };

export interface Spec extends TurboModule {
  /** Opens (or creates) the distributedKVStore with autoSync on. Idempotent. */
  open(storeId: string): Promise<void>;
  putBatch(entries: KVEntry[]): Promise<void>;
  getEntries(prefix: string): Promise<KVEntry[]>;
  /** Push-pull sync with the given trusted devices now (e.g. right after pairing or reconnecting). */
  syncNow(deviceIds: string[]): Promise<void>;
  // Emits 'SyncStore.change' { entries: KVEntry[]; deviceId: string } for data that arrived from other devices.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('SyncStore');
