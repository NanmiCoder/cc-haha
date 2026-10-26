import type { ClientMessage } from './types'

type Sender = (message: ClientMessage) => boolean

const senders = new Map<string, Sender>()

/**
 * 会话页把它的 WebSocket 发送函数登记在这里，其他页面（如子 Agent 全屏页）
 * 不必再开一条连接就能发「停止后台任务」。返回注销函数；同一会话后登记的覆盖先登记的。
 */
export function registerSessionSender(sessionId: string, send: Sender) {
  senders.set(sessionId, send)
  return () => {
    if (senders.get(sessionId) === send) senders.delete(sessionId)
  }
}

/** 没有登记或连接没就绪时返回 false。 */
export function sendToSession(sessionId: string, message: ClientMessage) {
  return senders.get(sessionId)?.(message) ?? false
}
