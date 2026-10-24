import { t } from './i18n.js'

export type PermissionDecision = {
  requestId: string
  allowed: boolean
  rule?: 'always'
}

function getSinglePendingRequestId(requestIds?: Iterable<string> | null): string | null {
  if (!requestIds) return null
  const ids = Array.from(requestIds)
  return ids.length === 1 ? ids[0]! : null
}

export function parsePermissionCommand(
  text: string,
  pendingRequestIds?: Iterable<string> | null,
): PermissionDecision | null {
  const trimmed = text.trim()
  const match = text.trim().match(/^\/(allow|always|allow-always|deny)\s+(\S+)/i)
  if (match) {
    const action = match[1]!.toLowerCase()
    const requestId = match[2]!
    if (action === 'deny') return { requestId, allowed: false }
    if (action === 'always' || action === 'allow-always') return { requestId, allowed: true, rule: 'always' }
    return { requestId, allowed: true }
  }

  const requestId = getSinglePendingRequestId(pendingRequestIds)
  if (!requestId) return null

  const shortcut = trimmed.toLowerCase()
  // Keep the Chinese aliases: existing conversations and muscle memory should
  // not break when the bot's reply language changes.
  if (['1', '/1', 'allow', '/allow', 'y', 'yes', '允许', '允许一次', '同意', '批准', 'cho phép', 'cho phép một lần', 'đồng ý'].includes(shortcut)) {
    return { requestId, allowed: true }
  }
  if (['2', '/2', 'always', '/always', 'allow-always', '/allow-always', '永久允许', '一直允许', 'cho phép vĩnh viễn', 'luôn cho phép'].includes(shortcut)) {
    return { requestId, allowed: true, rule: 'always' }
  }
  if (['3', '/3', 'deny', '/deny', 'n', 'no', '拒绝', '不允许', '否', 'từ chối', 'không'].includes(shortcut)) {
    return { requestId, allowed: false }
  }

  return null
}

export function parsePermitCallbackData(data: string): PermissionDecision | null {
  const parts = data.split(':')
  if (parts.length !== 3 || parts[0] !== 'permit' || !parts[1]) return null

  switch (parts[2]) {
    case 'yes':
      return { requestId: parts[1], allowed: true }
    case 'always':
      return { requestId: parts[1], allowed: true, rule: 'always' }
    case 'no':
      return { requestId: parts[1], allowed: false }
    default:
      return null
  }
}

export function formatPermissionInstructions(requestId: string): string {
  return t('permission.instructions', { requestId })
}

export function formatPermissionDecisionStatus(decision: Pick<PermissionDecision, 'allowed' | 'rule'>): string {
  if (!decision.allowed) return t('permission.decision.denied')
  return decision.rule === 'always' ? t('permission.decision.always') : t('permission.decision.allowed')
}
