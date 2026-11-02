export const IDLE_POWER_ACTIONS = ['lock', 'sleep', 'hibernate', 'shutdown'] as const
export type IdlePowerAction = typeof IDLE_POWER_ACTIONS[number]
export type IdlePowerSettings = {
  action: IdlePowerAction | 'none'
  scope: 'any' | 'scheduled'
  countdownSeconds: 0 | 30 | 60 | 300
}
export const DEFAULT_IDLE_POWER_SETTINGS: IdlePowerSettings = {
  action: 'none', scope: 'any', countdownSeconds: 60,
}
export type IdlePowerCapabilities = Record<IdlePowerAction, boolean>
export type IdlePowerRecord = {
  action: IdlePowerAction
  requestedAt: number
  result: 'requested' | 'accepted' | 'failed'
}
export type IdlePowerNotice = 'user-activity' | 'new-work' | 'cancelled' | 'unavailable' | 'failed' | null
export type IdlePowerState = {
  settings: IdlePowerSettings
  capabilities: IdlePowerCapabilities
  countdown: { id: string, action: IdlePowerAction, deadline: number } | null
  lastAction: IdlePowerRecord | null
  notice: IdlePowerNotice
}

export function isIdlePowerSettings(value: unknown): value is IdlePowerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 3
    && (record.action === 'none' || IDLE_POWER_ACTIONS.includes(record.action as IdlePowerAction))
    && (record.scope === 'any' || record.scope === 'scheduled')
    && [0, 30, 60, 300].includes(record.countdownSeconds as number)
}
