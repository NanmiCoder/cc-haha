import type { AdapterHttpClient } from './http-client.js'
import type { SessionEntry, SessionStore } from './session-store.js'
import type { ServerMessage, WsBridge } from './ws-bridge.js'

export type SessionRestoreResult =
  | { status: 'restored'; session: SessionEntry }
  | { status: 'missing' }
  | { status: 'unavailable'; session: SessionEntry }

export const SESSION_RECONNECT_NOTICE = '暂时无法连接原会话，已保留会话和工作目录，请稍后重试。'

type BridgeSessionOps = Pick<
  WsBridge,
  | 'connectSession'
  | 'getSessionId'
  | 'hasSession'
  | 'isSessionOpen'
  | 'onServerMessage'
  | 'resetSession'
  | 'waitForOpen'
>

type RestoreStoredSessionBindingOptions = {
  chatId: string
  bridge: BridgeSessionOps
  sessionStore: Pick<SessionStore, 'delete' | 'get'>
  httpClient: Pick<AdapterHttpClient, 'sessionExists'>
  onServerMessage: (msg: ServerMessage) => void | Promise<void>
  logPrefix: string
  clearTransientState?: () => void
}

function resetStaleBridge(
  chatId: string,
  bridge: BridgeSessionOps,
  clearTransientState?: () => void,
): void {
  if (!bridge.hasSession(chatId)) return
  bridge.resetSession(chatId)
  clearTransientState?.()
}

export async function restoreStoredSessionBinding({
  chatId,
  bridge,
  sessionStore,
  httpClient,
  onServerMessage,
  logPrefix,
  clearTransientState,
}: RestoreStoredSessionBindingOptions): Promise<SessionRestoreResult> {
  const stored = sessionStore.get(chatId)
  if (!stored) {
    resetStaleBridge(chatId, bridge, clearTransientState)
    return { status: 'missing' }
  }

  const currentSessionId = bridge.getSessionId(chatId)
  if (currentSessionId && currentSessionId !== stored.sessionId) {
    resetStaleBridge(chatId, bridge, clearTransientState)
  }

  if (bridge.isSessionOpen(chatId, stored.sessionId)) {
    return { status: 'restored', session: stored }
  }

  let exists = true
  try {
    exists = await httpClient.sessionExists(stored.sessionId)
  } catch (err) {
    console.warn(
      `${logPrefix} Failed to verify stored session ${stored.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  if (!exists) {
    sessionStore.delete(chatId)
    const hadBridgeSession = bridge.hasSession(chatId)
    resetStaleBridge(chatId, bridge, clearTransientState)
    if (!hadBridgeSession) clearTransientState?.()
    return { status: 'missing' }
  }

  // A transport failure is not evidence that the session was deleted. Keep
  // its binding so the next inbound message can retry the same session.
  try {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, onServerMessage)
    if (await bridge.waitForOpen(chatId)) {
      return { status: 'restored', session: stored }
    }
  } catch (err) {
    console.warn(
      `${logPrefix} Failed to reconnect stored session ${stored.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  return { status: 'unavailable', session: stored }
}
