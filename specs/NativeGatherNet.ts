// TurboModule spec. Native side: harmony/gather_modules/src/main/ets/GatherNetModule.ets
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type NearbyDevice = { deviceId: string; networkId: string; deviceName: string; deviceType: number };

export interface Spec extends TurboModule {
  getLocalDevice(): Promise<NearbyDevice>;
  /** Starts soft bus discovery; emits 'GatherNet.found' { device } for each nearby phone. */
  startDiscovery(): void;
  stopDiscovery(): void;
  /** Pairs with a nearby device. The system shows a confirmation / PIN on both phones; rejects if declined. */
  pair(deviceId: string): Promise<NearbyDevice>;
  unpair(deviceId: string): void;
  getTrustedDevices(): Promise<NearbyDevice[]>;
  // Emits 'GatherNet.online' / 'GatherNet.offline' { device } when a trusted device comes and goes.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('GatherNet');
