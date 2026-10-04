import { RNPackage, TurboModule, TurboModuleContext, TurboModulesFactory } from '@rnoh/react-native-openharmony/ts';
import { GatherNetModule } from './GatherNetModule';
import { RemindersModule } from './RemindersModule';
import { SyncStoreModule } from './SyncStoreModule';

class GatherTurboModulesFactory extends TurboModulesFactory {
  createTurboModule(name: string): TurboModule | null {
    if (name === SyncStoreModule.NAME) {
      return new SyncStoreModule(this.ctx);
    }
    if (name === GatherNetModule.NAME) {
      return new GatherNetModule(this.ctx);
    }
    if (name === RemindersModule.NAME) {
      return new RemindersModule(this.ctx);
    }
    return null;
  }

  hasTurboModule(name: string): boolean {
    return name === SyncStoreModule.NAME || name === GatherNetModule.NAME || name === RemindersModule.NAME;
  }
}

/** Register in the app's RNPackagesFactory: new GatherPackage(ctx). */
export class GatherPackage extends RNPackage {
  createTurboModulesFactory(ctx: TurboModuleContext): TurboModulesFactory {
    return new GatherTurboModulesFactory(ctx);
  }
}
