import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HISTORY_SEMANTIC_RECORD_BYTES, streamBoundedHistory, withHistoryReadBudget } from './boundedSessionHistory.js'
import type { MessageEntry, SessionTaskNotification } from './sessionService.js'

const RECOVERY_BYTES = 3 * 1024 * 1024
const STATE_RECORD_BYTES = 64 * 1024
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])
const WORKSPACE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const BACKGROUND_RESULT = /\bCommand (?:running in background|was manually backgrounded by user|exceeded[^\n]*?\band was moved to the background) with ID:\s*([A-Za-z0-9_-]+)/i
export type SessionHistoryRecovery = {
  sourceVersion: string
  status: 'ready' | 'incomplete'
  completeness?: { goal: boolean; todos: boolean; activity: boolean; usage: boolean; workspace?: boolean }
  messages: MessageEntry[]
  taskNotifications: SessionTaskNotification[]
  tokenUsage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number } | null
  omittedRecords: number
}
type Evidence = { ordinal: number; message: MessageEntry }
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : ''
const brief = (value: unknown): string | undefined => typeof value === 'string' ? value.slice(0, 4096) : undefined

/** Whole-source state reduction with bounded resident memory. Large historical
 * tool outputs are never recovery state; preserve their task identity/status,
 * and leave their bodies available through the separately paged transcript. */
export async function recoverBoundedSessionHistory(options: {
  filePath: string
  signal?: AbortSignal
  toMessage: (entry: Record<string, unknown>, parentToolUseId?: string) => MessageEntry | null
  notifications: (entry: Record<string, unknown>) => SessionTaskNotification[]
}): Promise<SessionHistoryRecovery> {
  return withHistoryReadBudget(options.signal, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-history-recovery-'))
    let database: Database | undefined
    try {
      database = new Database(join(directory, 'state.sqlite'))
      database.exec('PRAGMA journal_mode=OFF; PRAGMA cache_size=-512; PRAGMA temp_store=FILE; CREATE TABLE usage_keys (id TEXT PRIMARY KEY); CREATE TABLE parents (id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE tools (id TEXT PRIMARY KEY, ordinal INTEGER, json TEXT, legacy INTEGER, name TEXT); CREATE TABLE evidence (id TEXT PRIMARY KEY, ordinal INTEGER, json TEXT, category TEXT); CREATE TABLE notices (id TEXT PRIMARY KEY, ordinal INTEGER, json TEXT); CREATE TABLE teammates (name TEXT PRIMARY KEY)')
      database.exec('BEGIN')
      const usageKey = database.query('INSERT OR IGNORE INTO usage_keys VALUES (?)')
      const saveParent = database.query('INSERT OR REPLACE INTO parents VALUES (?, ?)')
      const getParent = database.query('SELECT owner FROM parents WHERE id = ?')
      const saveTool = database.query('INSERT OR REPLACE INTO tools VALUES (?, ?, ?, ?, ?)')
      const getTool = database.query('SELECT ordinal, json, legacy, name FROM tools WHERE id = ?')
      const saveEvidence = database.query('INSERT OR REPLACE INTO evidence VALUES (?, ?, ?, ?)')
      const saveNotice = database.query('INSERT OR REPLACE INTO notices VALUES (?, ?, ?)')
      const teammate = database.query('INSERT OR IGNORE INTO teammates VALUES (?)')
      let ordinal = 0
      let lastUser: Evidence | undefined
      let lastTodo: Evidence | undefined
      let lastTask: Evidence | undefined
      let goalBase: Evidence | undefined
      let goalStatus: Evidence | undefined
      let omitted = 0
      let suppressTaskNotificationResponse = false
      const completeness = { goal: true, todos: true, activity: true, usage: true, workspace: true }
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }
      const saveActivity = (evidence: Evidence, category: 'activity' | 'workspace' = 'activity') => {
        const json = JSON.stringify(evidence.message)
        if (Buffer.byteLength(json) > STATE_RECORD_BYTES) { omitted++; completeness[category] = false; return }
        saveEvidence.run(evidence.message.id, evidence.ordinal, json, category)
      }
      const scan = await streamBoundedHistory(options.filePath, (entry) => {
        ordinal++
        const inherited = typeof entry.parentUuid === 'string' ? (getParent.get(entry.parentUuid) as { owner?: string } | null)?.owner : undefined
        const owner = typeof entry.parent_tool_use_id === 'string' && entry.parent_tool_use_id
          ? entry.parent_tool_use_id : entry.isSidechain === true ? inherited : undefined
        const rawContent = (entry.message as { content?: unknown } | undefined)?.content
        const agentCall = Array.isArray(rawContent) ? rawContent.find(block => block?.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task') && typeof block.id === 'string') : undefined
        if (typeof entry.uuid === 'string') saveParent.run(entry.uuid, agentCall?.id ?? inherited ?? null)
        const notifications = options.notifications(entry)
        for (const notice of notifications) {
          const compact = { ...notice, ...(notice.summary ? { summary: brief(notice.summary) } : {}), ...(notice.result ? { result: brief(notice.result) } : {}) }
          const json = JSON.stringify(compact)
          if (Buffer.byteLength(json) > STATE_RECORD_BYTES) { omitted++; completeness.activity = false; continue }
          saveNotice.run(JSON.stringify([notice.ownerAgentId ?? null, notice.toolUseId]), ordinal, json)
        }
        const rawMessage = entry.message as { role?: string; content?: unknown } | undefined
        const notificationUser = rawMessage?.role === 'user' && notifications.length > 0
        const hasToolResult = Array.isArray(rawMessage?.content) && rawMessage.content.some((block: any) => block?.type === 'tool_result')
        if (notificationUser) { suppressTaskNotificationResponse = true; return }
        if (rawMessage?.role === 'user' && !hasToolResult) suppressTaskNotificationResponse = false
        else if (suppressTaskNotificationResponse) return
        const message = options.toMessage(entry, owner)
        if (!message) return
        if (message.usage && (!message.usageKey || usageKey.run(message.usageKey).changes > 0)) {
          const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
          usage.input_tokens += amount(message.usage.input_tokens)
          usage.output_tokens += amount(message.usage.output_tokens)
          usage.cache_read_tokens += amount(message.usage.cache_read_input_tokens)
          usage.cache_creation_tokens += amount(message.usage.cache_creation_input_tokens)
        }
        if (owner || entry.isSidechain === true) return
        const base = { ...message, usage: undefined, toolUseResult: undefined }
        if (message.type === 'user') {
          lastUser = { ordinal, message: { ...base, content: '[user message]' } }
          const teammateParts: string[] = []
          for (const match of text(message.content).matchAll(/<teammate-message\s+teammate_id="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>/g)) {
            const body = match[2]!.trim()
            // Lifecycle JSON is not a meaningful completed task result.
            try {
              const lifecycle = JSON.parse(body)
              if (['shutdown_approved', 'shutdown_rejected', 'shutdown_request', 'teammate_terminated', 'idle_notification'].includes(lifecycle?.type)) continue
            } catch { /* Plain text is a meaningful teammate response. */ }
            if (teammate.run(match[1]!).changes) teammateParts.push(`<teammate-message teammate_id="${match[1]}">${body.slice(0, 4096)}</teammate-message>`)
          }
          if (teammateParts.length) saveActivity({ ordinal, message: { ...base, content: teammateParts.join('\n') } })
        }
        if (message.type === 'system' && typeof message.content === 'string') {
          const output = message.content.match(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/)?.[1]?.trim()
          if (output && /^(?:Goal set:|Goal cleared[.:]|No active goal\.|Goal continuing:|Goal marked complete\.)/.test(output)) {
            const evidence = { ordinal, message: { ...base, content: `<local-command-stdout>${output}</local-command-stdout>` } }
            if (/^(?:Goal set:|Goal cleared[.:]|No active goal\.)/.test(output)) {
              goalBase = undefined; goalStatus = undefined; completeness.goal = true
              if (Buffer.byteLength(JSON.stringify(evidence)) <= STATE_RECORD_BYTES) goalBase = evidence
              else { omitted++; completeness.goal = false }
            } else if (Buffer.byteLength(JSON.stringify(evidence)) <= STATE_RECORD_BYTES) goalStatus = evidence
            else { omitted++; completeness.goal = false }
          }
          return
        }
        if (!Array.isArray(message.content)) return
        const agentBlocks: unknown[] = []
        const workspaceCalls: Array<Record<string, any>> = []
        const workspaceResults: Array<Record<string, any>> = []
        for (const block of message.content as Array<Record<string, any>>) {
          if (block?.type === 'tool_use' && typeof block.id === 'string') {
            const input = record(block.input) ?? {}
            if (WORKSPACE_TOOLS.has(block.name)) workspaceCalls.push(block)
            if (TASK_TOOLS.has(block.name)) {
              lastTask = { ordinal, message: { ...base, content: [{ type: 'tool_use', id: block.id, name: block.name, input: {} }] } }
              if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
                const evidence = { ordinal, message: { ...base, content: [block] } }
                completeness.todos = Buffer.byteLength(JSON.stringify(evidence)) <= STATE_RECORD_BYTES
                lastTodo = completeness.todos ? evidence : undefined
                if (!completeness.todos) omitted++
              }
            }
            if (block.name === 'Agent' || block.name === 'Task') {
              agentBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: { name: input.name, description: brief(input.description), subagent_type: input.subagent_type, run_in_background: input.run_in_background } })
            }
            if (SHELL_TOOLS.has(block.name)) {
              const compact = { ...base, id: `${base.id}:background:${block.id}`, content: [{ type: 'tool_use', id: block.id, name: block.name, input: { description: brief(input.description), command: brief(input.command), run_in_background: input.run_in_background } }] }
              const json = JSON.stringify(compact)
              if (Buffer.byteLength(json) <= STATE_RECORD_BYTES) saveTool.run(block.id, ordinal, json, input.run_in_background === true ? 1 : 0, block.name)
              else { omitted++; completeness.activity = false }
            }
          } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const tool = getTool.get(block.tool_use_id) as { ordinal: number; json: string; legacy: number; name: string } | null
            if (!tool) continue
            if (WORKSPACE_TOOLS.has(tool.name)) { workspaceResults.push(block); continue }
            const structured = record(message.toolUseResult)
            const taskId = structured
              ? structured.backgroundTaskId ?? structured.background_task_id
              : tool.legacy ? text(block.content).match(BACKGROUND_RESULT)?.[1] : undefined
            if (typeof taskId !== 'string' || !taskId) continue
            saveActivity({ ordinal: tool.ordinal, message: JSON.parse(tool.json) })
            saveActivity({ ordinal, message: { ...base, content: [{ type: 'tool_result', tool_use_id: block.tool_use_id, content: '' }], toolUseResult: { backgroundTaskId: taskId } } })
          }
        }
        if (workspaceCalls.length) {
          const compact = { ...base, content: workspaceCalls }
          const json = JSON.stringify(compact)
          if (Buffer.byteLength(json) > STATE_RECORD_BYTES) { omitted++; completeness.workspace = false }
          else {
            saveActivity({ ordinal, message: compact }, 'workspace')
            for (const block of workspaceCalls) saveTool.run(block.id, ordinal, json, 0, block.name)
          }
        }
        if (workspaceResults.length) saveActivity({ ordinal, message: { ...base, content: workspaceResults, toolUseResult: message.toolUseResult } }, 'workspace')
        if (agentBlocks.length) saveActivity({ ordinal, message: { ...base, content: agentBlocks } })
      }, options.signal, { maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES })
      database.exec('COMMIT')
      const priority = [goalBase, goalStatus, lastTodo, lastTask?.message.id === lastTodo?.message.id ? undefined : lastTask, lastUser].filter((value): value is Evidence => Boolean(value))
      const messages = new Map(priority.map(evidence => [evidence.message.id, evidence]))
      const taskNotifications: SessionTaskNotification[] = []
      let bytes = Buffer.byteLength(JSON.stringify(priority))
      for (const row of database.query('SELECT ordinal, json, category FROM evidence ORDER BY ordinal DESC').iterate() as Iterable<{ ordinal: number; json: string; category: 'activity' | 'workspace' }>) {
        if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
        bytes += Buffer.byteLength(row.json)
        if (bytes > RECOVERY_BYTES || messages.size >= 2048) { omitted++; completeness.activity = false; completeness.workspace = false; break }
        const message = JSON.parse(row.json)
        messages.set(message.id, { ordinal: row.ordinal, message })
        if (messages.size % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      for (const row of database.query('SELECT json FROM notices ORDER BY ordinal DESC').iterate() as Iterable<{ json: string }>) {
        bytes += Buffer.byteLength(row.json)
        if (bytes > RECOVERY_BYTES || taskNotifications.length >= 2048) { omitted++; completeness.activity = false; break }
        if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
        taskNotifications.push(JSON.parse(row.json))
        if (taskNotifications.length % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      if (scan.omittedRecords) {
        omitted += scan.omittedRecords
        completeness.goal = completeness.todos = completeness.activity = completeness.usage = completeness.workspace = false
      }
      return {
        sourceVersion: scan.sourceVersion,
        status: Object.values(completeness).every(Boolean) ? 'ready' : 'incomplete',
        completeness,
        messages: [...messages.values()].sort((a, b) => a.ordinal - b.ordinal).map(item => item.message),
        taskNotifications: taskNotifications.reverse(),
        tokenUsage: Object.values(usage).some(value => value > 0) ? usage : null,
        omittedRecords: omitted,
      }
    } finally {
      database?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 'recovery')
}
