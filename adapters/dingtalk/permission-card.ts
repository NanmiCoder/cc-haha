import { truncateInput } from '../common/format.js'
import { t } from '../common/i18n.js'
import { parsePermitCallbackData, type PermissionDecision } from '../common/permission.js'

export const DINGTALK_PERMISSION_CARD_CALLBACK_ROUTE = 'permission'

export type DingTalkPermissionCardAction = PermissionDecision & {
  outTrackId?: string
  chatId?: string
}

export function buildDingTalkPermissionCardParams(
  toolName: string,
  input: unknown,
  requestId: string,
): Record<string, unknown> {
  const allowValue = { action: 'permit', requestId, allowed: true }
  const alwaysValue = { action: 'permit', requestId, allowed: true, rule: 'always' }
  const denyValue = { action: 'permit', requestId, allowed: false }

  return {
    title: t('dingtalk.permissionCardTitle'),
    toolName,
    requestId,
    inputPreview: truncateInput(input, 600),
    allowText: t('permission.button.allowPlain'),
    alwaysText: t('permission.button.alwaysPlain'),
    denyText: t('permission.button.denyPlain'),
    allowValue: JSON.stringify(allowValue),
    alwaysValue: JSON.stringify(alwaysValue),
    denyValue: JSON.stringify(denyValue),
    permissionActions: JSON.stringify([
      { text: t('permission.button.allowPlain'), value: allowValue },
      { text: t('permission.button.alwaysPlain'), value: alwaysValue },
      { text: t('permission.button.denyPlain'), value: denyValue },
    ]),
    sys_full_json_obj: JSON.stringify({
      order: ['title', 'toolName', 'inputPreview'],
      actions: ['allowValue', 'alwaysValue', 'denyValue'],
    }),
    config: JSON.stringify({ autoLayout: true }),
  }
}

export function parseDingTalkPermissionCardAction(raw: unknown): DingTalkPermissionCardAction | null {
  const root = parseMaybeJson(raw)
  const values = collectValues(root)

  for (const value of values) {
    if (typeof value === 'string') {
      const direct = parsePermitCallbackData(value)
      if (direct) return direct
      const parsed = parseMaybeJson(value)
      if (parsed !== value) {
        const nested = parseDingTalkPermissionCardAction(parsed)
        if (nested) return nested
      }
    }
  }

  const objects = values.filter(isRecord)
  for (const obj of objects) {
    const requestId = readString(obj, ['requestId', 'request_id', 'permissionRequestId'])
    if (!requestId) continue

    const action = readString(obj, ['action', 'actionType', 'decision', 'value', 'actionValue', 'command'])?.toLowerCase()
    const allowed = readBoolean(obj, ['allowed', 'allow', 'approved'])
    const rule = readString(obj, ['rule']) === 'always' ? 'always' : undefined
    const outTrackId = readString(obj, ['outTrackId', 'cardInstanceId'])
    const chatId = readString(obj, ['chatId', 'conversationId', 'openConversationId'])

    if (allowed !== undefined) return { requestId, allowed, rule, outTrackId, chatId }
    if (action && ['allow', 'yes', 'approve', 'approved', 'permit'].includes(action)) {
      return { requestId, allowed: true, rule, outTrackId, chatId }
    }
    if (action && ['always', 'allow-always', 'approve-always'].includes(action)) {
      return { requestId, allowed: true, rule: 'always', outTrackId, chatId }
    }
    if (action && ['deny', 'no', 'reject', 'rejected'].includes(action)) {
      return { requestId, allowed: false, outTrackId, chatId }
    }
  }

  return null
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function collectValues(value: unknown, seen = new Set<unknown>()): unknown[] {
  const parsed = parseMaybeJson(value)
  if (parsed && typeof parsed === 'object') {
    if (seen.has(parsed)) return []
    seen.add(parsed)
  }

  const values = [parsed]
  if (Array.isArray(parsed)) {
    for (const item of parsed) values.push(...collectValues(item, seen))
  } else if (isRecord(parsed)) {
    for (const item of Object.values(parsed)) values.push(...collectValues(item, seen))
  }
  return values
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readBoolean(obj: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      if (/^(true|yes|allow|approve|permit)$/i.test(value)) return true
      if (/^(false|no|deny|reject)$/i.test(value)) return false
    }
  }
  return undefined
}
