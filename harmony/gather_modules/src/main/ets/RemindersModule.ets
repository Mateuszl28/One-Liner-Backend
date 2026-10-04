// Reminders: system reminders via reminderAgentManager, so "pay Anna" fires even when the app is closed.
import { TurboModule, TurboModuleContext } from '@rnoh/react-native-openharmony/ts';
import { reminderAgentManager } from '@kit.BackgroundTasksKit';

const MIN_DELAY_SECONDS = 1;

export class RemindersModule extends TurboModule {
  static readonly NAME = 'Reminders';

  constructor(ctx: TurboModuleContext) {
    super(ctx);
  }

  async schedule(title: string, content: string, triggerAtMs: number): Promise<number> {
    const seconds = Math.max(MIN_DELAY_SECONDS, Math.round((triggerAtMs - Date.now()) / 1000));
    const request: reminderAgentManager.ReminderRequestTimer = {
      reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_TIMER,
      triggerTimeInSeconds: seconds,
      title: title.substring(0, 100),
      content: content.substring(0, 500),
      wantAgent: {
        pkgName: this.ctx.uiAbilityContext.abilityInfo.bundleName,
        abilityName: 'EntryAbility'
      }
    };
    return await reminderAgentManager.publishReminder(request);
  }

  async cancel(reminderId: number): Promise<void> {
    await reminderAgentManager.cancelReminder(reminderId);
  }
}
