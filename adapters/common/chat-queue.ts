/**
 * 会话串行队列
 *
 * 同一 chatId 的消息串行处理，防并发冲突。
 * 不同 chatId 之间互不影响。
 * 参考 openclaw-lark chat-queue.ts 的 Promise 链设计。
 */

const queues = new Map<string, Promise<void>>()

export async function enqueue(chatId: string, fn: () => Promise<void>): Promise<void> {
  const prev = queues.get(chatId) ?? Promise.resolve()
  const next = prev.then(fn, () => fn()).catch((err) => {
    console.error(`[ChatQueue] Error in task for chat ${chatId}:`, err)
  })
  queues.set(chatId, next)
  // Clean up after completion to avoid memory leak for one-off chats
  next.finally(() => {
    if (queues.get(chatId) === next) {
      queues.delete(chatId)
    }
  })
  return next
}
