// SyncStore: thin wrapper over distributedKVStore. All merge logic lives in @gather/core (TypeScript);
// this module only persists op entries and forwards changes that arrive from other devices.
import { TurboModule, TurboModuleContext } from '@rnoh/react-native-openharmony/ts';
import { distributedKVStore } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';

interface KVEntry {
  key: string;
  value: string;
}

interface ChangeEvent {
  entries: KVEntry[];
  deviceId: string;
}

const MAX_KEY_LENGTH = 1024; // distributedKVStore.MAX_KEY_LENGTH
const ERR_DEVICE_NOT_ONLINE = 15100004;

export class SyncStoreModule extends TurboModule {
  static readonly NAME = 'SyncStore';
  private kvManager: distributedKVStore.KVManager | null = null;
  private store: distributedKVStore.SingleKVStore | null = null;
  private storeId: string = '';

  constructor(ctx: TurboModuleContext) {
    super(ctx);
  }

  async open(storeId: string): Promise<void> {
    if (this.store !== null && this.storeId === storeId) {
      return;
    }
    const context = this.ctx.uiAbilityContext;
    const config: distributedKVStore.KVManagerConfig = {
      context: context,
      bundleName: context.abilityInfo.bundleName
    };
    this.kvManager = distributedKVStore.createKVManager(config);
    const options: distributedKVStore.Options = {
      createIfMissing: true,
      encrypt: true,
      backup: false,
      autoSync: true,
      kvStoreType: distributedKVStore.KVStoreType.SINGLE_VERSION,
      securityLevel: distributedKVStore.SecurityLevel.S1
    };
    this.store = await this.kvManager.getKVStore<distributedKVStore.SingleKVStore>(storeId, options);
    this.storeId = storeId;
    this.store.on('dataChange', distributedKVStore.SubscribeType.SUBSCRIBE_TYPE_REMOTE,
      (data: distributedKVStore.ChangeNotification) => {
        const entries: KVEntry[] = [];
        data.insertEntries.concat(data.updateEntries).forEach((e: distributedKVStore.Entry) => {
          if (typeof e.value.value === 'string') {
            entries.push({ key: e.key, value: e.value.value as string });
          }
        });
        if (entries.length > 0) {
          const event: ChangeEvent = { entries: entries, deviceId: data.deviceId };
          this.ctx.rnInstance.emitDeviceEvent('SyncStore.change', event);
        }
      });
  }

  async putBatch(entries: KVEntry[]): Promise<void> {
    const store = this.requireStore();
    const batch: distributedKVStore.Entry[] = [];
    for (const e of entries) {
      if (e.key.length === 0 || e.key.length > MAX_KEY_LENGTH) {
        throw new Error(`Invalid key length: ${e.key.length}`);
      }
      batch.push({ key: e.key, value: { type: distributedKVStore.ValueType.STRING, value: e.value } });
    }
    await store.putBatch(batch);
  }

  async getEntries(prefix: string): Promise<KVEntry[]> {
    const store = this.requireStore();
    const found: distributedKVStore.Entry[] = await store.getEntries(prefix);
    const result: KVEntry[] = [];
    found.forEach((e: distributedKVStore.Entry) => {
      if (typeof e.value.value === 'string') {
        result.push({ key: e.key, value: e.value.value as string });
      }
    });
    return result;
  }

  async syncNow(deviceIds: string[]): Promise<void> {
    if (deviceIds.length === 0) {
      return;
    }
    const store = this.requireStore();
    try {
      store.sync(deviceIds, distributedKVStore.SyncMode.PUSH_PULL);
    } catch (e) {
      const err = e as BusinessError;
      // Device not online / not trusted yet: autoSync catches up when it reappears.
      if (err.code !== ERR_DEVICE_NOT_ONLINE) {
        throw new Error(`SyncStore.syncNow failed: ${err.code} ${err.message}`);
      }
    }
  }

  addListener(eventName: string): void {
  }

  removeListeners(count: number): void {
  }

  private requireStore(): distributedKVStore.SingleKVStore {
    if (this.store === null) {
      throw new Error('SyncStore.open() must be called first');
    }
    return this.store;
  }
}
