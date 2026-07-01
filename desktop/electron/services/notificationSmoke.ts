import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  sendDesktopNotification,
  type ElectronNotificationConstructor,
} from './notifications'

const DEFAULT_DELAY_MS = 2500
const MAX_DELAY_MS = 60_000

export type NotificationSmokeTimer = (handler: () => void, delayMs: number) => unknown
export type NotificationSmokeLogEvent =
  | {
    event: 'scheduled'
    timestamp: string
    sessionId: string
    title: string
    body: string
    delayMs: number
  }
  | {
    event: 'sent'
    timestamp: string
    sessionId: string
    sent: boolean
  }
  | {
    event: 'action'
    timestamp: string
    sessionId: string
    payload: unknown
  }
  | {
    event: 'synthetic_action'
    timestamp: string
    sessionId: string
    payload: unknown
  }
  | {
    event: 'renderer_ack'
    timestamp: string
    payload: unknown
  }
  | {
    event: 'lifecycle'
    timestamp: string
    sessionId: string
    lifecycle: 'close' | 'failed'
  }
  | {
    event: 'send_failed'
    timestamp: string
    sessionId: string
    error: string
  }
export type NotificationSmokeLogWriter = (event: NotificationSmokeLogEvent) => void

export function parseNotificationSmokeDelay(value: string | undefined): number {
  if (!value) return DEFAULT_DELAY_MS
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_DELAY_MS
  return Math.min(Math.max(Math.round(parsed), 0), MAX_DELAY_MS)
}

function shouldTriggerSyntheticAction(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

export function appendNotificationSmokeLog(logPath: string, event: NotificationSmokeLogEvent) {
  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, `${JSON.stringify(event)}\n`)
}

export function logNotificationSmokeRendererAck(env: NodeJS.ProcessEnv, payload: unknown): boolean {
  const logPath = env.CC_HAHA_ELECTRON_NOTIFICATION_SMOKE_LOG?.trim()
  if (!logPath) return false
  appendNotificationSmokeLog(logPath, {
    event: 'renderer_ack',
    timestamp: new Date().toISOString(),
    payload,
  })
  return true
}

export function scheduleNotificationSmoke({
  env,
  NotificationClass,
  onAction,
  setTimer = setTimeout,
  writeLog,
}: {
  env: NodeJS.ProcessEnv
  NotificationClass: ElectronNotificationConstructor
  onAction: (payload: unknown) => void
  setTimer?: NotificationSmokeTimer
  writeLog?: NotificationSmokeLogWriter
}): boolean {
  const sessionId = env.CC_HAHA_ELECTRON_NOTIFICATION_SMOKE_SESSION_ID?.trim()
  if (!sessionId) return false

  const title = env.CC_HAHA_ELECTRON_NOTIFICATION_SMOKE_TITLE?.trim() || 'Code Council notification smoke'
  const body = env.CC_HAHA_ELECTRON_NOTIFICATION_SMOKE_BODY?.trim() || 'Click to return to the target session.'
  const delayMs = parseNotificationSmokeDelay(env.CC_HAHA_ELECTRON_NOTIFICATION_SMOKE_DELAY_MS)
  const triggerSyntheticAction = shouldTriggerSyntheticAction(env.CC_HAHA_ELECTRON_NOTIFICATION_SMOKE_TRIGGER_ACTION)
  const logPath = env.CC_HAHA_ELECTRON_NOTIFICATION_SMOKE_LOG?.trim()
  const log: NotificationSmokeLogWriter = (event) => {
    if (writeLog) {
      writeLog(event)
      return
    }
    if (logPath) appendNotificationSmokeLog(logPath, event)
  }

  log({ event: 'scheduled', timestamp: new Date().toISOString(), sessionId, title, body, delayMs })

  setTimer(() => {
    try {
      const target = {
        type: 'session' as const,
        sessionId,
        title,
      }
      const sent = sendDesktopNotification({
        NotificationClass,
        options: {
          title,
          body,
          target,
        },
        onAction: (payload) => {
          log({ event: 'action', timestamp: new Date().toISOString(), sessionId, payload })
          onAction(payload)
        },
        onLifecycle: (lifecycle) => {
          log({ event: 'lifecycle', timestamp: new Date().toISOString(), sessionId, lifecycle })
        },
      })
      log({ event: 'sent', timestamp: new Date().toISOString(), sessionId, sent })
      if (sent && triggerSyntheticAction) {
        const payload = {
          target,
          action: 'synthetic-click',
        }
        log({ event: 'synthetic_action', timestamp: new Date().toISOString(), sessionId, payload })
        onAction(payload)
      }
    } catch (error) {
      log({
        event: 'send_failed',
        timestamp: new Date().toISOString(),
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }, delayMs)

  return true
}
