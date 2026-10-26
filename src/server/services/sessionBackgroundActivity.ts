import { activeAgentTasks, activeNonAgentTasks } from '../ws/agentTaskState.js'
import type { MessageEntry, SessionTaskNotification } from './sessionService.js'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import * as path from 'node:path'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { ApiError } from '../middleware/errorHandler.js'
import { HISTORY_SEMANTIC_RECORD_BYTES, streamBoundedHistory, withHistoryReadBudget } from './boundedSessionHistory.js'

export type SessionBackgroundTask = {
  taskId: string
  toolUseId?: string
  taskType?: string
  description?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  stopping?: boolean
  summary?: string
  result?: string
  outputFile?: string
  startedAt?: string
}

/** Runtime ownership decides what is running; history only supplies its display metadata. */
export function projectSessionBackgroundActivity(sessionId: string, messages: MessageEntry[], notifications: SessionTaskNotification[]) {
  const tasks = new Map<string, SessionBackgroundTask>()
  for (const notice of notifications) {
    if (notice.ownerAgentId) continue
    tasks.set(notice.taskId, { taskId: notice.taskId, toolUseId: notice.toolUseId, status: notice.status, summary: notice.summary, result: notice.result, outputFile: notice.outputFile })
  }
  for (const task of [...(activeAgentTasks.get(sessionId)?.values() ?? []), ...(activeNonAgentTasks.get(sessionId)?.values() ?? [])]) {
    if (task.ownerAgentId || task.taskType === 'in_process_teammate') continue
    tasks.set(task.taskId, { ...tasks.get(task.taskId), taskId: task.taskId, toolUseId: task.toolUseId, taskType: task.taskType, description: task.description, status: task.localStopConfirmed ? 'stopped' : 'running', stopping: task.stopRequested })
  }
  const tools = new Map<string, { name: string; input: Record<string, unknown>; timestamp: string }>()
  for (const message of messages) {
    if (message.parentToolUseId || message.isSidechain || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') tools.set(block.id, { name: block.name, input: block.input ?? {}, timestamp: message.timestamp })
    }
  }
  return [...tasks.values()].map(task => {
    const tool = task.toolUseId ? tools.get(task.toolUseId) : undefined
    const description = tool?.input.description ?? tool?.input.command
    return { ...task, taskType: task.taskType ?? (tool?.name === 'Agent' || tool?.name === 'Task' ? 'local_agent' : tool?.name === 'Bash' || tool?.name === 'PowerShell' ? 'local_bash' : undefined), description: task.description ?? (typeof description === 'string' ? description : undefined), startedAt: tool?.timestamp }
  })
}

export const MAX_BACKGROUND_OUTPUT_BYTES = 64 * 1024
export type SessionBackgroundOutput = {
  taskId: string
  state: 'available' | 'empty' | 'missing'
  text: string
  totalBytes: number
  truncated: boolean
}

const safeId = /^[A-Za-z0-9_-]{1,128}$/
const legacyBackgroundResult = /^Command (?:running in background|was manually backgrounded by user|exceeded[^\n]*?\band was moved to the background) with ID:\s*([A-Za-z0-9_-]+)(?:\.|$)/m
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const rootMessage = (message: MessageEntry) => !message.parentToolUseId && !message.isSidechain
const resultText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((item: unknown) => record(item) && item.type === 'text' && typeof item.text === 'string').map((item: { text: string }) => item.text).join('\n') : ''
const resultLaunchLine = (content: unknown, taskId: string) => resultText(content).split(/\r?\n/).find(line => legacyBackgroundResult.exec(line)?.[1] === taskId)

/** A shell task must be evidenced by its own root tool_use/result pair, not a client path or a task notification. */
function shellTaskLocation(messages: MessageEntry[], taskId: string): { cwd: string; toolUseId: string; outputFile?: string } | undefined {
  const uses = new Map<string, { cwd: string; legacy: boolean }>()
  for (const message of messages) {
    if (!rootMessage(message) || !['assistant', 'tool_use'].includes(message.type) || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!record(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || !['Bash', 'PowerShell'].includes(String(block.name)) || !record(block.input)) continue
      if (typeof block.input.command !== 'string' || typeof message.cwd !== 'string' || !path.isAbsolute(message.cwd)) continue
      uses.set(block.id, { cwd: message.cwd, legacy: block.input.run_in_background === true })
    }
  }
  for (const message of messages) {
    if (!rootMessage(message) || !['user', 'tool_result'].includes(message.type) || !Array.isArray(message.content)) continue
    const results = message.content.filter((block: unknown) => record(block) && block.type === 'tool_result') as Record<string, unknown>[]
    for (const block of results) {
      const use = typeof block.tool_use_id === 'string' ? uses.get(block.tool_use_id) : undefined
      if (!use || block.is_error) continue
      const launchLine = resultLaunchLine(block.content, taskId)
      const outputFile = launchLine?.split('Output is being written to: ')[1]?.replace(/\. In assistant mode,.*$/, '')
      const location = { cwd: use.cwd, toolUseId: block.tool_use_id as string, ...(outputFile ? { outputFile } : {}) }
      const structured = record(message.toolUseResult) ? message.toolUseResult : undefined
      if (structured) {
        // Per-message structured output cannot be attributed to one of several results.
        if (results.length === 1 && (structured.backgroundTaskId ?? structured.background_task_id) === taskId) return location
        continue
      }
      if (!use.legacy) continue
      if (launchLine) return location
    }
  }
  return undefined
}

/** Recovery intentionally removes tool-result bodies. Hydrate only the addressed
 * root result's launch metadata, bounded per record, without widening HTTP history. */
export async function readSessionBackgroundTaskOutputFromTranscript(
  sessionId: string,
  taskId: string,
  recovery: MessageEntry[],
  transcriptPath: string,
  signal?: AbortSignal,
): Promise<SessionBackgroundOutput> {
  signal?.throwIfAborted()
  if (!safeId.test(sessionId) || !safeId.test(taskId)) throw ApiError.badRequest('Invalid session or task ID')
  const location = shellTaskLocation(recovery, taskId)
  if (!location) throw ApiError.notFound('Background shell task not found in this session')
  const expectedIds = new Set(recovery.filter(message => rootMessage(message) &&
    ['user', 'tool_result'].includes(message.type) && Array.isArray(message.content) &&
    message.content.some(block => record(block) && block.type === 'tool_result' && block.tool_use_id === location.toolUseId)
  ).map(message => message.id))
  let selected: MessageEntry | undefined
  await withHistoryReadBudget(signal, async () => {
    await streamBoundedHistory(transcriptPath, raw => {
      if (typeof raw.uuid !== 'string' || !expectedIds.has(raw.uuid) || raw.isSidechain || raw.parent_tool_use_id) return
      const message = record(raw.message) ? raw.message : undefined
      if (message?.role !== 'user' || !Array.isArray(message.content)) return
      const results = message.content.filter(block => record(block) && block.type === 'tool_result') as Record<string, unknown>[]
      if (results.length !== 1 || results[0]?.tool_use_id !== location.toolUseId) return
      const result = results[0]!
      const line = resultLaunchLine(result.content, taskId)
      if (line && line.length > 8192) return
      const structured = record(raw.toolUseResult) ? raw.toolUseResult : undefined
      selected = {
        id: raw.uuid, type: 'tool_result', timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
        content: [{ type: 'tool_result', tool_use_id: location.toolUseId, is_error: result.is_error, content: line ?? '' }],
        ...(structured ? { toolUseResult: { backgroundTaskId: structured.backgroundTaskId ?? structured.background_task_id } } : {}),
      }
    }, signal, { maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES })
  }, 'metadata')
  if (!selected) throw ApiError.notFound('Original background shell result is unavailable')
  const uses = recovery.filter(message => rootMessage(message) && ['assistant', 'tool_use'].includes(message.type))
  return readSessionBackgroundTaskOutput(sessionId, taskId, [...uses, selected], signal)
}

/** Read only this session's proven shell output. Never use diskOutput's process-global CLI session directory in the multi-session server. */
export async function readSessionBackgroundTaskOutput(
  sessionId: string,
  taskId: string,
  messages: MessageEntry[],
  signal?: AbortSignal,
  outputRoot = getClaudeTempDir(),
): Promise<SessionBackgroundOutput> {
  signal?.throwIfAborted()
  if (!safeId.test(sessionId) || !safeId.test(taskId)) throw ApiError.badRequest('Invalid session or task ID')
  const location = shellTaskLocation(messages, taskId)
  if (!location) throw ApiError.notFound('Background shell task not found in this session')
  const empty = (state: 'missing' | 'empty'): SessionBackgroundOutput => ({ taskId, state, text: '', totalBytes: 0, truncated: false })
  const forbidden = () => new ApiError(403, 'Background task output is not a regular session-owned file', 'FORBIDDEN')
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const root = await fs.realpath(outputRoot)
    // CLI task directories survive cwd changes. Prefer its own result's location,
    // but accept only the fixed task-file shape beneath the trusted temporary root.
    const candidate = location.outputFile ?? path.join(root, sanitizePath(location.cwd), sessionId, 'tasks', `${taskId}.output`)
    const relative = path.relative(root, candidate)
    const parts = relative.split(path.sep)
    if (!path.isAbsolute(candidate) || candidate.includes('\0') || path.isAbsolute(relative) || parts.length !== 4 || !parts[0] || parts[0] === '..' || parts[1] !== sessionId || parts[2] !== 'tasks' || parts[3] !== `${taskId}.output`) throw forbidden()
    // A symlink at any level below the trusted task root must not redirect this read.
    if (await fs.realpath(candidate) !== candidate) throw forbidden()
    const before = await fs.lstat(candidate)
    if (!before.isFile() || before.nlink !== 1) throw forbidden()
    signal?.throwIfAborted()
    handle = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw forbidden()
    if (await fs.realpath(candidate) !== candidate) throw forbidden()
    const after = await fs.lstat(candidate)
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) throw forbidden()
    signal?.throwIfAborted()
    if (!opened.size) return empty('empty')
    const offset = Math.max(0, opened.size - MAX_BACKGROUND_OUTPUT_BYTES)
    const buffer = Buffer.alloc(Math.min(opened.size, MAX_BACKGROUND_OUTPUT_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    signal?.throwIfAborted()
    // Tail offsets can cut through a UTF-8 code point; omit its continuation bytes.
    let start = 0
    if (offset) while (start < bytesRead && (buffer[start]! & 0xc0) === 0x80) start++
    return { taskId, state: bytesRead ? 'available' : 'empty', text: buffer.subarray(start, bytesRead).toString('utf8'), totalBytes: opened.size, truncated: offset > 0 }
  } catch (error) {
    signal?.throwIfAborted()
    if (record(error) && error.code === 'ENOENT') return empty('missing')
    if (record(error) && ['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code))) throw forbidden()
    throw error
  } finally {
    await handle?.close()
  }
}
