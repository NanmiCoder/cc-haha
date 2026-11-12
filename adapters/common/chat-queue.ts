/**
 * Per-chat serial queue
 *
 * Messages for the same chatId are processed serially to avoid concurrency conflicts.
 * Different chatIds do not affect each other.
 * Based on the Promise-chain design of openclaw-lark chat-queue.ts.
 */

import { adapterMigrationLifecycle } from './migration-lifecycle.js'

const queues = new Map<string, Promise<void>>()

export async function enqueue(chatId: string, fn: () => Promise<void>): Promise<void> {
  if (adapterMigrationLifecycle.isQuiescing) return
  const prev = queues.get(chatId) ?? Promise.resolve()
  const invoke = () => adapterMigrationLifecycle.isQuiescing ? undefined : fn()
  const next = adapterMigrationLifecycle.track(prev.then(invoke, invoke)).catch((err) => {
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
