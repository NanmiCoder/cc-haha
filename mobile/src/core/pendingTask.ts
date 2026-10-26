import type { ComposerReference } from './composerReferences'
import { visibleMessageText, type ComposerAttachment } from './chatComposer'
import type { RuntimeConfig } from './types'

export type PendingTask = {
  content: string
  displayText?: string
  references?: ComposerReference[]
  runtime?: RuntimeConfig
  attachments: ComposerAttachment[]
}
const tasks = new Map<string, PendingTask>()
const key = (hostId: string, sessionId: string) =>
  JSON.stringify([hostId, sessionId])

/** One in-memory handoff per created session. Clear only after its first send succeeds. */
export function putPendingTask(
  hostId: string,
  sessionId: string,
  task: PendingTask
) {
  tasks.set(key(hostId, sessionId), {
    content: task.content,
    ...(task.displayText !== undefined ? { displayText: task.displayText } : {}),
    ...(task.references?.length ? { references: task.references.map((value) => ({ ...value })) } : {}),
    runtime: task.runtime && { ...task.runtime },
    attachments: task.attachments.map((value) => ({ ...value })),
  })
}
export function peekPendingTask(hostId: string, sessionId: string) {
  return tasks.get(key(hostId, sessionId))
}
export function clearPendingTask(hostId: string, sessionId: string) {
  tasks.delete(key(hostId, sessionId))
}

/**
 * A new task's content already carries the team request block, so it is sent as-is.
 * Show only the user's words in an input box; `team` tells the box the block is there.
 */
export function pendingTaskDraft(task: PendingTask) {
  const text = visibleMessageText(task.content)
  return { text: task.displayText ?? text, team: text !== task.content }
}
