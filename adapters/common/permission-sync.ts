import type { ServerMessage } from './ws-bridge.js'

type PermissionRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  pendingPermissionCount: number
}

// Pending approval is server state; delivery is local state. A reconnect
// snapshot may announce an approval whose prompt has never reached this IM.
// Key by the pending set so clearing a chat also releases its delivery records.
const promptDeliveries = new WeakMap<Set<string>, Map<string, object>>()

export async function deliverImPermissionPrompt(
  chatId: string,
  requestId: string,
  runtime: PermissionRuntimeState,
  pendingPermissions: Map<string, Set<string>>,
  deliver: (isCurrent: () => boolean) => Promise<void>,
): Promise<void> {
  const pending = pendingPermissions.get(chatId) ?? new Set<string>()
  let deliveries = promptDeliveries.get(pending)
  if (!deliveries) {
    deliveries = new Map()
    promptDeliveries.set(pending, deliveries)
  }
  for (const id of deliveries.keys()) {
    if (!pending.has(id)) deliveries.delete(id)
  }
  if (deliveries.has(requestId)) return
  pending.add(requestId)
  pendingPermissions.set(chatId, pending)
  runtime.pendingPermissionCount = pending.size
  runtime.state = 'permission_pending'
  const delivery = {}
  deliveries.set(requestId, delivery)
  const isCurrent = () => pendingPermissions.get(chatId) === pending && pending.has(requestId)
    && deliveries.get(requestId) === delivery
  try {
    await deliver(isCurrent)
  } catch (error) {
    // Keep the approval pending, but allow replay to retry the failed prompt.
    // Never restore a request removed by a resolution/reset during delivery.
    if (deliveries.get(requestId) === delivery) deliveries.delete(requestId)
    throw error
  }
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
    if (pending) promptDeliveries.get(pending)?.delete(message.requestId)
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
    const ids = new Set<string>(message.toolRequestIds.filter((id: unknown): id is string =>
      typeof id === 'string' && id.length > 0,
    ))
    const pending = pendingPermissions.get(chatId) ?? new Set<string>()
    for (const id of pending) {
      if (!ids.has(id)) {
        pending.delete(id)
        promptDeliveries.get(pending)?.delete(id)
      }
    }
    for (const id of ids) {
      // A local response is optimistic until the server confirms it. If the
      // snapshot restores that request, its old prompt no longer owns delivery.
      if (!pending.has(id)) promptDeliveries.get(pending)?.delete(id)
      pending.add(id)
    }
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
