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
  if (['1', '/1', 'allow', '/allow', 'y', 'yes', '允许', '允许一次', '同意', '批准'].includes(shortcut)) {
    return { requestId, allowed: true }
  }
  if (['2', '/2', 'always', '/always', 'allow-always', '/allow-always', '永久允许', '一直允许'].includes(shortcut)) {
    return { requestId, allowed: true, rule: 'always' }
  }
  if (['3', '/3', 'deny', '/deny', 'n', 'no', '拒绝', '不允许', '否'].includes(shortcut)) {
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

export function formatPermissionInstructions(requestId: string, options: { pendingCount?: number } = {}): string {
  const shortcuts = '回复 1 允许一次，2 永久允许，3 拒绝。'
  if (options.pendingCount === 1) return shortcuts
  if (options.pendingCount !== undefined && options.pendingCount > 1) {
    return `当前有多个待审批请求，请使用带请求 ID 的命令：\n/allow ${requestId}、/always ${requestId}、/deny ${requestId}。`
  }
  return [
    shortcuts,
    `也可回复 /allow ${requestId}、/always ${requestId}、/deny ${requestId}。`,
  ].join('\n')
}

export function formatPermissionDecisionStatus(decision: Pick<PermissionDecision, 'allowed' | 'rule'>): string {
  if (!decision.allowed) return '❌ 已拒绝'
  return decision.rule === 'always' ? '♾️ 已永久允许' : '✅ 已允许'
}
