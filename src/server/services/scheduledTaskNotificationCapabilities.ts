import { adapterService } from './adapterService.js'
import type { TaskNotificationConfig } from '../../shared/taskSchedule.js'

export type ScheduledTaskNotificationCapabilities = {
  channels: Record<TaskNotificationConfig['channels'][number], boolean>
}

/** Expose readiness only; credentials, recipients and pairing details stay on the host. */
export async function getScheduledTaskNotificationCapabilities(): Promise<ScheduledTaskNotificationCapabilities> {
  const config = await adapterService.getConfig()
  return {
    channels: {
      desktop: true,
      feishu: !!(config.feishu?.appId && config.feishu.appSecret &&
        ((config.feishu.pairedUsers?.length ?? 0) > 0 || (config.feishu.allowedUsers?.length ?? 0) > 0)),
      telegram: !!(config.telegram?.botToken &&
        ((config.telegram.pairedUsers?.length ?? 0) > 0 || (config.telegram.allowedUsers?.length ?? 0) > 0)),
    },
  }
}
