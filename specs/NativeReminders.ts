// TurboModule spec. Native side: harmony/gather_modules/src/main/ets/RemindersModule.ets (reminderAgentManager).
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** Schedules a system reminder that fires even if the app is closed. Resolves with the reminder id. */
  schedule(title: string, content: string, triggerAtMs: number): Promise<number>;
  cancel(reminderId: number): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Reminders');
