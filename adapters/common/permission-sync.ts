import type { ServerMessage } from './ws-bridge.js'

type PermissionRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  pendingPermissionCount: number
}

/** Reconcile approvals handled by another client or while this IM was offline. */
export function syncImPermissionState(
  chatId: string,
  message: ServerMessage,
  runtime: PermissionRuntimeState,
  pendingPermissions: Map<string, Set<string>>,
): boolean {
  if (message.type === 'permission_resolved') {
    if (message.permissionType !== 'tool' || typeof message.requestId !== 'string') return true
    const pending = pendingPermissions.get(chatId)
    pending?.delete(message.requestId)
    runtime.pendingPermissionCount = pending?.size ?? 0
    if (!runtime.pendingPermissionCount) {
      pendingPermissions.delete(chatId)
      if (runtime.state === 'permission_pending') runtime.state = 'thinking'
    }
    return true
  }

  if (message.type !== 'permission_requests_snapshot') return false
  // Only an explicit array is authoritative. Older/partial snapshots may carry
  // turnActive alone and must not silently discard a replayed request.
  if (Array.isArray(message.toolRequestIds)) {
    const pending = new Set<string>(message.toolRequestIds.filter((id: unknown): id is string =>
      typeof id === 'string' && id.length > 0,
    ))
    if (pending.size) pendingPermissions.set(chatId, pending)
    else pendingPermissions.delete(chatId)
  }
  runtime.pendingPermissionCount = pendingPermissions.get(chatId)?.size ?? 0
  if (runtime.pendingPermissionCount) {
    runtime.state = 'permission_pending'
  } else if (!message.turnActive) {
    runtime.state = 'idle'
  } else if (runtime.state === 'idle' || runtime.state === 'permission_pending') {
    runtime.state = 'thinking'
  }
  return true
}
