import type { PowerMonitor, PowerSaveBlocker, Screen, WebContents } from 'electron'
import { en } from '../../src/i18n/locales/en'
import { zh } from '../../src/i18n/locales/zh'
import { zh as zhTW } from '../../src/i18n/locales/zh-TW'
import { jp } from '../../src/i18n/locales/jp'
import { kr } from '../../src/i18n/locales/kr'
import type { Locale } from '../../src/i18n/locale'
import type { IdlePowerAction, IdlePowerState } from '../../src/lib/idlePower'
import { IdlePowerService, type PowerActivitySnapshot } from './idlePower'
import { detectPowerCapabilities, executePowerAction } from './idlePowerPlatform'
import { readIdlePowerPreferences, writeIdlePowerPreferences, type PowerPreferenceApp } from './idlePowerPersistence'
import { sendDesktopNotification, type ElectronNotificationConstructor } from './notifications'

const dictionaries: Record<Locale, Record<string, string>> = { en, zh, 'zh-TW': zhTW, jp, kr }
export async function createIdlePowerHost(options: {
  app: PowerPreferenceApp
  blocker: Pick<PowerSaveBlocker, 'start' | 'stop'>
  monitor: Pick<PowerMonitor, 'getSystemIdleTime'>
  screen: Pick<Screen, 'getCursorScreenPoint'>
  NotificationClass: ElectronNotificationConstructor
  locale(): Locale
  readActivity(signal: AbortSignal): Promise<PowerActivitySnapshot>
  onChange(state: IdlePowerState): void
  detectCapabilities?: typeof detectPowerCapabilities
  executeAction?: typeof executePowerAction
}): Promise<IdlePowerService> {
  const preferences = readIdlePowerPreferences(options.app)
  const translate = (key: string, params: Record<string, string | number> = {}) => {
    let value = dictionaries[options.locale()][key] ?? dictionaries.en[key] ?? key
    for (const [name, replacement] of Object.entries(params)) value = value.replaceAll(`{${name}}`, String(replacement))
    return value
  }
  const actionName = (action: IdlePowerAction) => translate(`power.action.${action}`)
  const capabilities = await (options.detectCapabilities ?? detectPowerCapabilities)()
  const service = new IdlePowerService({
    settings: preferences.settings,
    blocker: options.blocker,
    lastAction: preferences.lastAction,
    capabilities,
    readActivity: options.readActivity,
    getIdleSeconds: () => options.monitor.getSystemIdleTime(),
    getPointerPosition: () => options.screen.getCursorScreenPoint(),
    execute: (action, beforeExecute) => (options.executeAction ?? executePowerAction)(action, { beforeExecute }),
    save: value => writeIdlePowerPreferences(options.app, value),
    onChange: options.onChange,
    notifyCountdown: (countdown, seconds, cancel) => sendDesktopNotification({
      NotificationClass: options.NotificationClass,
      options: { title: 'cc-haha', body: translate('power.countdown', { action: actionName(countdown.action), seconds }) },
      onAction: () => cancel(),
      onLifecycle: event => { if (event === 'failed') cancel('unavailable') },
    }),
    notifyNotice: notice => {
      sendDesktopNotification({ NotificationClass: options.NotificationClass,
        options: { title: 'cc-haha', body: translate(`power.cancelled.${notice}`) }, onAction: () => {} })
    },
  })
  service.start()
  return service
}

export function installIdlePowerLifecycle(
  contents: Pick<WebContents, 'on'>,
  getService: () => IdlePowerService | null,
  onStop: () => void = () => {},
): void {
  const stop = () => { onStop(); getService()?.stop() }
  contents.on('did-navigate', stop)
  contents.on('render-process-gone', stop)
  contents.on('destroyed', stop)
  contents.on('before-input-event', () => {
    if (getService()?.getState().countdown) getService()?.cancel('user-activity')
  })
}
