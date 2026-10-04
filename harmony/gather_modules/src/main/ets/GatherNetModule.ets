// GatherNet: nearby discovery and pairing over the distributed soft bus. Pairing (bindTarget) shows a
// system confirmation on both phones, so nobody joins a Gather without the host accepting it.
import { TurboModule, TurboModuleContext } from '@rnoh/react-native-openharmony/ts';
import { distributedDeviceManager } from '@kit.DistributedServiceKit';
import { BusinessError } from '@kit.BasicServicesKit';

interface NearbyDevice {
  deviceId: string;
  networkId: string;
  deviceName: string;
  deviceType: number;
}

interface DeviceEvent {
  device: NearbyDevice;
}

const ERR_DISCOVERY_RUNNING = 11600104;

function toNearby(d: distributedDeviceManager.DeviceBasicInfo): NearbyDevice {
  return {
    deviceId: d.deviceId,
    networkId: d.networkId ?? '',
    deviceName: d.deviceName,
    deviceType: Number(d.deviceType)
  };
}

export class GatherNetModule extends TurboModule {
  static readonly NAME = 'GatherNet';
  private dm: distributedDeviceManager.DeviceManager | null = null;

  constructor(ctx: TurboModuleContext) {
    super(ctx);
  }

  private manager(): distributedDeviceManager.DeviceManager {
    if (this.dm === null) {
      const dm = distributedDeviceManager.createDeviceManager(this.ctx.uiAbilityContext.abilityInfo.bundleName);
      dm.on('discoverSuccess', (data) => {
        this.emit('GatherNet.found', toNearby(data.device));
      });
      dm.on('deviceStateChange', (data) => {
        if (data.action === distributedDeviceManager.DeviceStateChange.AVAILABLE) {
          this.emit('GatherNet.online', toNearby(data.device));
        } else if (data.action === distributedDeviceManager.DeviceStateChange.UNAVAILABLE) {
          this.emit('GatherNet.offline', toNearby(data.device));
        }
      });
      this.dm = dm;
    }
    return this.dm;
  }

  private emit(name: string, device: NearbyDevice): void {
    const event: DeviceEvent = { device: device };
    this.ctx.rnInstance.emitDeviceEvent(name, event);
  }

  async getLocalDevice(): Promise<NearbyDevice> {
    const dm = this.manager();
    return {
      deviceId: dm.getLocalDeviceId(),
      networkId: dm.getLocalDeviceNetworkId(),
      deviceName: dm.getLocalDeviceName(),
      deviceType: dm.getLocalDeviceType()
    };
  }

  startDiscovery(): void {
    const filter: Record<string, Object> = { 'discoverTargetType': 1 };
    try {
      this.manager().startDiscovering(filter);
    } catch (e) {
      const err = e as BusinessError;
      if (err.code !== ERR_DISCOVERY_RUNNING) {
        throw new Error(`GatherNet.startDiscovery failed: ${err.code} ${err.message}`);
      }
    }
  }

  stopDiscovery(): void {
    try {
      this.manager().stopDiscovering();
    } catch (e) {
      // Not discovering: nothing to stop.
    }
  }

  pair(deviceId: string): Promise<NearbyDevice> {
    const bindParam: Record<string, string | number> = {
      'bindType': 1, // system shows a PIN / confirmation on both devices
      'targetPkgName': this.ctx.uiAbilityContext.abilityInfo.bundleName,
      'appName': 'Gather'
    };
    return new Promise<NearbyDevice>((resolve, reject) => {
      this.manager().bindTarget(deviceId, bindParam, (err: BusinessError) => {
        if (err) {
          reject(new Error(`Pairing refused or failed: ${err.code} ${err.message}`));
          return;
        }
        const trusted = this.manager().getAvailableDeviceListSync().find(
          (d: distributedDeviceManager.DeviceBasicInfo) => d.deviceId === deviceId);
        const fallback: NearbyDevice = { deviceId: deviceId, networkId: '', deviceName: '', deviceType: 0 };
        resolve(trusted ? toNearby(trusted) : fallback);
      });
    });
  }

  unpair(deviceId: string): void {
    this.manager().unbindTarget(deviceId);
  }

  async getTrustedDevices(): Promise<NearbyDevice[]> {
    return this.manager().getAvailableDeviceListSync().map(toNearby);
  }

  addListener(eventName: string): void {
  }

  removeListeners(count: number): void {
  }
}
