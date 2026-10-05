/**
 * Teammate Mailbox - File-based messaging system for agent swarms
 *
 * Each teammate has an inbox file at .claude/teams/{team_name}/inboxes/{agent_name}.json
 * Other teammates can write messages to it, and the recipient sees them as attachments.
 *
 * The live inbox only holds unread messages. Every locked mutation moves read
 * entries into an append-only {agent_name}.history.jsonl beside it: writers
 * rewrite the live file under the lock, so it has to stay small, while the
 * desktop feed still needs the whole conversation (readMailboxHistory).
 *
 * Note: Inboxes are keyed by agent name within a team.
 */

import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { TEAMMATE_MESSAGE_TAG } from '../constants/xml.js'
import { PermissionModeSchema } from '../entrypoints/sdk/coreSchemas.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import type { Message } from '../types/message.js'
import { generateRequestId } from './agentId.js'
import { logForDebugging } from './debug.js'
import { getTeamsDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { lazySchema } from './lazySchema.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import {
  permissionUpdateSchema,
  type PermissionUpdate,
} from './permissions/PermissionUpdateSchema.js'
import {
  permissionBehaviorSchema,
  permissionRuleValueSchema,
} from './permissions/PermissionRule.js'
import { sleep } from './sleep.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { firstLineOf } from './stringUtils.js'
import {
  isPaneBackend,
  type BackendType,
  type PaneBackendType,
} from './swarm/backends/types.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import { sanitizePathComponent } from './tasks.js'
import { getAgentName, getTeammateColor, getTeamName } from './teammate.js'
import { escapeXmlAttr } from './xml.js'

// Lock options: retry with backoff so concurrent callers (multiple Claudes
// in a swarm) wait for the lock instead of failing immediately. The sync
// lockSync API blocked the event loop; the async API needs explicit retries
// to achieve the same serialization semantics.
//
// The team lead's inbox is a fan-in point for every teammate's messages and
// idle notifications, and a writer that runs out of retries loses its
// message. The budget therefore matches the task-list lock (~2.6s total wait)
// instead of ~650ms; critical sections only rewrite the unread live inbox, so
// holders release quickly.
const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
  // The default handler throws from a timer, which becomes an unhandled
  // exception. A lock stolen after a long event-loop stall is recoverable.
  onCompromised: (error: Error) => {
    logForDebugging(`[TeammateMailbox] inbox lock compromised: ${error}`, {
      level: 'error',
    })
  },
}

// Windows readers can briefly prevent a rename from replacing the inbox.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export type TeammateMessage = {
  /** Stable envelope identity. Older mailbox records may not have one. */
  id?: string
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string // Sender's assigned color (e.g., 'red', 'blue', 'green')
  summary?: string // 5-10 word summary shown as preview in the UI
}

export function createMailboxMessageId(): string {
  return `mailbox-${randomUUID()}`
}

export function createMailboxMessage(
  message: Omit<TeammateMessage, 'read'>,
): TeammateMessage {
  return {
    ...message,
    id: message.id ?? createMailboxMessageId(),
    read: false,
  }
}

export function isTrustedTeamLeaderMessage(
  message: TeammateMessage,
): boolean {
  return message.from === TEAM_LEAD_NAME
}

/**
 * Get the path to a teammate's inbox file
 * Structure: ~/.claude/teams/{team_name}/inboxes/{agent_name}.json
 */
export function getInboxPath(agentName: string, teamName?: string): string {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const safeAgentName = sanitizePathComponent(agentName)
  const inboxDir = join(getTeamsDir(), safeTeam, 'inboxes')
  const fullPath = join(inboxDir, `${safeAgentName}.json`)
  logForDebugging(
    `[TeammateMailbox] getInboxPath: agent=${agentName}, team=${team}, fullPath=${fullPath}`,
  )
  return fullPath
}

/**
 * Ensure the inbox directory exists for a team
 */
async function ensureInboxDir(teamName?: string): Promise<void> {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const inboxDir = join(getTeamsDir(), safeTeam, 'inboxes')
  await mkdir(inboxDir, { recursive: true })
  logForDebugging(`[TeammateMailbox] Ensured inbox directory: ${inboxDir}`)
}

/** Suffix of the append-only file that keeps a recipient's read messages. */
export const MAILBOX_HISTORY_SUFFIX = '.history.jsonl'

/**
 * Path of the history file that sits beside a live inbox file
 * ({agent_name}.json -> {agent_name}.history.jsonl).
 */
export function getInboxHistoryPath(inboxPath: string): string {
  const stem = inboxPath.endsWith('.json')
    ? inboxPath.slice(0, -'.json'.length)
    : inboxPath
  return `${stem}${MAILBOX_HISTORY_SUFFIX}`
}

/**
 * Identity used to acknowledge exactly the messages a consumer delivered.
 * Envelope ids are unique per message; records written before ids existed
 * fall back to sender, timestamp and text.
 */
export function getMailboxMessageIdentity(
  message: Pick<TeammateMessage, 'id' | 'from' | 'timestamp' | 'text'>,
): string {
  return message.id
    ? `id:${message.id}`
    : `legacy:${message.from}|${message.timestamp}|${message.text}`
}

function isMailboxRecord(value: unknown): value is TeammateMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses a live inbox. Returns undefined for a damaged file. Legacy inboxes
 * (pretty-printed, still holding read entries) parse the same way.
 */
function parseInboxContent(content: string): TeammateMessage[] | undefined {
  // A brand-new inbox is created empty before '[]' lands in it.
  if (content.trim() === '') return []
  let parsed: unknown
  try {
    parsed = jsonParse(content)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  // A non-object entry would break every consumer's `message.read` check.
  return parsed.filter(isMailboxRecord)
}

async function readInboxFile(inboxPath: string): Promise<TeammateMessage[]> {
  let content: string
  try {
    content = await readFile(inboxPath, 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      logForDebugging(`[TeammateMailbox] readMailbox: file does not exist`)
      return []
    }
    logForDebugging(`Failed to read inbox ${inboxPath}: ${error}`)
    logError(error)
    return []
  }
  const messages = parseInboxContent(content)
  if (!messages) {
    // Writes are atomic, so this is a damaged file rather than a write in
    // progress. The next locked mutation keeps a copy before replacing it.
    logForDebugging(
      `[TeammateMailbox] readMailbox: unparseable inbox at ${inboxPath}, treating as empty`,
      { level: 'warn' },
    )
    return []
  }
  logForDebugging(
    `[TeammateMailbox] readMailbox: read ${messages.length} message(s)`,
  )
  return messages
}

async function readInboxHistory(
  historyPath: string,
): Promise<TeammateMessage[]> {
  let content: string
  try {
    content = await readFile(historyPath, 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      logForDebugging(`Failed to read inbox history ${historyPath}: ${error}`)
      logError(error)
    }
    return []
  }
  const messages: TeammateMessage[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = jsonParse(line)
      if (isMailboxRecord(parsed)) messages.push({ ...parsed, read: true })
    } catch {
      // A crash can tear the last line; the next append starts a fresh one.
    }
  }
  return messages
}

/**
 * Read all messages from a teammate's inbox
 * @param agentName - The agent name (not UUID) to read inbox for
 * @param teamName - Optional team name (defaults to CLAUDE_CODE_TEAM_NAME env var or 'default')
 */
export async function readMailbox(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const inboxPath = getInboxPath(agentName, teamName)
  logForDebugging(`[TeammateMailbox] readMailbox: path=${inboxPath}`)
  return readInboxFile(inboxPath)
}

/**
 * Read only unread messages from a teammate's inbox
 * @param agentName - The agent name (not UUID) to read inbox for
 * @param teamName - Optional team name
 */
export async function readUnreadMessages(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const messages = await readMailbox(agentName, teamName)
  const unread = messages.filter(m => !m.read)
  logForDebugging(
    `[TeammateMailbox] readUnreadMessages: ${unread.length} unread of ${messages.length} total`,
  )
  return unread
}

/**
 * Every message a recipient has received -- archived history plus the live
 * inbox -- in chronological order, each with its read flag. Lock-free and
 * read-only; this is what the desktop communication feed shows.
 */
export async function readMailboxHistory(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  return readMailboxHistoryAtPath(getInboxPath(agentName, teamName))
}

/**
 * readMailboxHistory for a caller that enumerates inbox files itself.
 * @param inboxPath - The live {agent_name}.json path (it need not exist)
 */
export async function readMailboxHistoryAtPath(
  inboxPath: string,
): Promise<TeammateMessage[]> {
  // Live inbox first: a mutation appends history before it republishes the
  // live file, so in this order an entry being moved is seen twice at worst
  // (deduplicated below), never zero times.
  const live = await readInboxFile(inboxPath)
  const history = await readInboxHistory(getInboxHistoryPath(inboxPath))
  const seen = new Set<string>()
  const messages: TeammateMessage[] = []
  for (const message of [...history, ...live]) {
    const identity = getMailboxMessageIdentity(message)
    if (seen.has(identity)) continue
    seen.add(identity)
    messages.push(message)
  }
  // Entries are archived in the order they were read; restore send order.
  return messages.sort((left, right) =>
    left.timestamp < right.timestamp
      ? -1
      : left.timestamp > right.timestamp
        ? 1
        : 0,
  )
}

/**
 * Locked view of a live inbox. `content` is the raw file text, absent when
 * the file is missing or damaged so the inbox is always republished.
 */
async function readInboxForUpdate(
  inboxPath: string,
): Promise<{ messages: TeammateMessage[]; content?: string }> {
  let content: string
  try {
    content = await readFile(inboxPath, 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return { messages: [] }
    // Never rewrite an inbox that could not be read: that would drop it.
    throw error
  }
  const messages = parseInboxContent(content)
  if (messages) return { messages, content }
  const preservedPath = `${inboxPath}.corrupt-${Date.now()}`
  await copyFile(inboxPath, preservedPath)
  logForDebugging(
    `[TeammateMailbox] unparseable inbox preserved at ${preservedPath} before it is replaced`,
    { level: 'error' },
  )
  return { messages: [] }
}

// Call only while holding the inbox lock.
async function appendInboxHistory(
  historyPath: string,
  messages: TeammateMessage[],
): Promise<void> {
  if (messages.length === 0) return
  const lines = messages
    .map(message => jsonStringify({ ...message, read: true }))
    .join('\n')
  const handle = await open(historyPath, 'a+')
  try {
    // A crash can leave a torn last line; start on a fresh line so the torn
    // fragment cannot swallow the entries appended now.
    const { size } = await handle.stat()
    let separator = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      if (last[0] !== 0x0a) separator = '\n'
    }
    await handle.write(`${separator}${lines}\n`)
  } finally {
    await handle.close()
  }
}

// Call only while holding the inbox lock. Readers take no lock: rename
// exposes either the complete previous inbox or the complete replacement.
async function replaceInboxFile(
  inboxPath: string,
  content: string,
): Promise<void> {
  const temporaryPath = `${inboxPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf-8',
      flag: 'wx',
    })
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporaryPath, inboxPath)
        return
      } catch (error) {
        // Never unlink the live inbox: exhausted retries must leave its
        // previous contents intact.
        if (
          process.platform !== 'win32' ||
          attempt >= 5 ||
          !RENAME_RETRY_CODES.has(getErrnoCode(error) ?? '')
        ) {
          throw error
        }
        await sleep(10 * (attempt + 1))
      }
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

/**
 * Applies `update` to a live inbox under its lock. Entries the result holds
 * as read -- newly acknowledged ones and legacy read entries alike -- move to
 * the history file; only unread entries are republished, as compact JSON.
 * Throws when the lock or the file cannot be used (ENOENT: no inbox).
 */
async function updateInbox(
  inboxPath: string,
  update: (messages: TeammateMessage[]) => TeammateMessage[],
): Promise<void> {
  const release = await lockfile.lock(inboxPath, {
    lockfilePath: `${inboxPath}.lock`,
    ...LOCK_OPTIONS,
  })
  try {
    const current = await readInboxForUpdate(inboxPath)
    const next = update(current.messages)
    // History first: a crash between the two steps can repeat an entry,
    // which readers deduplicate, but can never lose one.
    await appendInboxHistory(
      getInboxHistoryPath(inboxPath),
      next.filter(message => message.read),
    )
    const content = jsonStringify(next.filter(message => !message.read))
    if (content !== current.content) {
      await replaceInboxFile(inboxPath, content)
    }
  } finally {
    try {
      await release()
    } catch (error) {
      logForDebugging(`[TeammateMailbox] inbox lock release failed: ${error}`)
    }
  }
}

/**
 * Write a message to a teammate's inbox
 * Uses file locking to prevent race conditions when multiple agents write concurrently
 * @param recipientName - The recipient's agent name (not UUID)
 * @param message - The message to write
 * @param teamName - Optional team name
 * @returns true once the message is persisted; false when it was not (for
 *   example the inbox stayed locked past the retry budget). Never throws, so
 *   callers must check the result before reporting a message as sent.
 */
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<boolean> {
  const inboxPath = getInboxPath(recipientName, teamName)

  logForDebugging(
    `[TeammateMailbox] writeToMailbox: recipient=${recipientName}, from=${message.from}, path=${inboxPath}`,
  )

  try {
    await ensureInboxDir(teamName)

    // Ensure the inbox file exists before locking (proper-lockfile requires the file to exist)
    try {
      await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
      logForDebugging(
        `[TeammateMailbox] writeToMailbox: created new inbox file`,
      )
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') throw error
    }

    const newMessage = createMailboxMessage(message)
    await updateInbox(inboxPath, messages => [...messages, newMessage])
    logForDebugging(
      `[TeammateMailbox] Wrote message to ${recipientName}'s inbox from ${message.from}`,
    )
    return true
  } catch (error) {
    logForDebugging(`Failed to write to inbox for ${recipientName}: ${error}`, {
      level: 'error',
    })
    // Lock contention is an expected, already-reported outcome.
    if (getErrnoCode(error) !== 'ELOCKED') logError(error)
    return false
  }
}

/**
 * Marks exactly `candidates` read, matched by identity, and resolves to the
 * subset that was still unread -- the messages this caller now owns.
 * Messages appended after the caller's read stay unread, and two consumers
 * racing on one inbox can never both claim the same message. Resolves
 * undefined when the inbox could not be updated; nothing was claimed then.
 * @param agentName - The inbox owner
 * @param teamName - Optional team name
 * @param candidates - Messages the caller read from this inbox
 */
export async function claimMailboxMessages(
  agentName: string,
  teamName: string | undefined,
  candidates: readonly TeammateMessage[],
): Promise<TeammateMessage[] | undefined> {
  if (candidates.length === 0) return []
  const identities = new Set(candidates.map(getMailboxMessageIdentity))
  const inboxPath = getInboxPath(agentName, teamName)
  let claimed: TeammateMessage[] = []
  try {
    await updateInbox(inboxPath, messages => {
      claimed = []
      return messages.map(message => {
        if (
          message.read ||
          !identities.has(getMailboxMessageIdentity(message))
        ) {
          return message
        }
        claimed.push(message)
        return { ...message, read: true }
      })
    })
    logForDebugging(
      `[TeammateMailbox] claimed ${claimed.length} of ${candidates.length} message(s) for ${agentName}`,
    )
    return claimed
  } catch (error) {
    // Without an inbox there is nothing left to claim.
    if (getErrnoCode(error) === 'ENOENT') return []
    logForDebugging(
      `[TeammateMailbox] could not mark ${candidates.length} message(s) read for ${agentName}: ${error}`,
      { level: 'warn' },
    )
    if (getErrnoCode(error) !== 'ELOCKED') logError(error)
    return undefined
  }
}

/**
 * Marks exactly the delivered messages read (by identity), leaving anything
 * that arrived after the caller's read untouched.
 * @returns true when none of `delivered` is unread any more; false when the
 *   inbox could not be updated (the messages will be read again).
 */
export async function markMessagesAsReadByIdentity(
  agentName: string,
  teamName: string | undefined,
  delivered: readonly TeammateMessage[],
): Promise<boolean> {
  return (
    (await claimMailboxMessages(agentName, teamName, delivered)) !== undefined
  )
}

/**
 * Clear a teammate's inbox. The messages leave the live inbox but remain in
 * its history.
 * @param agentName - The agent name to clear inbox for
 * @param teamName - Optional team name
 */
export async function clearMailbox(
  agentName: string,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)

  try {
    // Locking a missing file fails with ENOENT, so a clear never creates one.
    await updateInbox(inboxPath, messages =>
      messages.map(message =>
        message.read ? message : { ...message, read: true },
      ),
    )
    logForDebugging(`[TeammateMailbox] Cleared inbox for ${agentName}`)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return
    }
    logForDebugging(`Failed to clear inbox for ${agentName}: ${error}`)
    logError(error)
  }
}

type TeammateMessageEnvelope = {
  from: string
  text: string
  color?: string
  summary?: string
}

/**
 * Formats one teammate message as the `<teammate-message>` block that models
 * and transcript renderers parse. Attribute values are escaped so a sender
 * name, color or summary can neither end its attribute nor forge another
 * envelope.
 */
export function formatTeammateMessage(
  message: TeammateMessageEnvelope,
): string {
  const colorAttr = message.color
    ? ` color="${escapeXmlAttr(message.color)}"`
    : ''
  const summaryAttr = message.summary
    ? ` summary="${escapeXmlAttr(message.summary)}"`
    : ''
  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${escapeXmlAttr(message.from)}"${colorAttr}${summaryAttr}>\n${message.text}\n</${TEAMMATE_MESSAGE_TAG}>`
}

/**
 * Format teammate messages as XML for attachment display
 */
export function formatTeammateMessages(
  messages: readonly TeammateMessageEnvelope[],
): string {
  return messages.map(formatTeammateMessage).join('\n\n')
}

/**
 * Structured message sent when a teammate becomes idle (via Stop hook)
 */
export type IdleNotificationMessage = {
  type: 'idle_notification'
  from: string
  timestamp: string
  /** Why the agent went idle */
  idleReason?: 'available' | 'interrupted' | 'failed'
  /** Brief summary of the last DM sent this turn (if any) */
  summary?: string
  completedTaskId?: string
  completedStatus?: 'resolved' | 'blocked' | 'failed'
  failureReason?: string
  /** The agent's final response this turn, capped by capIdleResult */
  result?: string
}

/** Longest final response an idle notification carries. */
export const IDLE_RESULT_MAX_CHARS = 4000
/** Longest failure reason (a single line) an idle notification carries. */
export const IDLE_FAILURE_REASON_MAX_CHARS = 200

const IDLE_RESULT_TRUNCATED = `[result truncated — ask the agent for the rest via ${SEND_MESSAGE_TOOL_NAME}]`

// C0/C1 controls except tab and newline, line/paragraph separators, and
// invisible format characters other than the joiners real text relies on.
const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]|(?![\u200C\u200D])\p{Cf}/gu

function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '')
}

/** First `max` UTF-16 units, without splitting a surrogate pair. */
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const last = head.charCodeAt(head.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
}

/**
 * Caps an agent's final response for an idle notification: control
 * characters removed and at most IDLE_RESULT_MAX_CHARS, followed by a marker
 * when cut. The marker points the lead at SendMessage only while the agent
 * can still answer.
 */
export function capIdleResult(
  result: string | undefined,
  senderReachable = true,
): string | undefined {
  const text = stripControlCharacters(result?.trim() ?? '').trim()
  if (!text) return undefined
  const head = truncateText(text, IDLE_RESULT_MAX_CHARS)
  if (head.length === text.length) return text
  const marker = senderReachable ? IDLE_RESULT_TRUNCATED : '[result truncated]'
  return `${head}\n${marker}`
}

/**
 * First line of a failure reason, control characters removed, at most
 * IDLE_FAILURE_REASON_MAX_CHARS.
 */
export function capIdleFailureReason(
  reason: string | undefined,
): string | undefined {
  const line = stripControlCharacters(
    firstLineOf(reason?.trim() ?? ''),
  ).trim()
  return line ? truncateText(line, IDLE_FAILURE_REASON_MAX_CHARS) : undefined
}

/**
 * Creates an idle notification message to send to the team leader
 */
export function createIdleNotification(
  agentId: string,
  options?: {
    idleReason?: IdleNotificationMessage['idleReason']
    summary?: string
    completedTaskId?: string
    completedStatus?: 'resolved' | 'blocked' | 'failed'
    failureReason?: string
    /** The agent's final response; capped with capIdleResult */
    result?: string
  },
): IdleNotificationMessage {
  return {
    type: 'idle_notification',
    from: agentId,
    timestamp: new Date().toISOString(),
    idleReason: options?.idleReason,
    summary: options?.summary,
    completedTaskId: options?.completedTaskId,
    completedStatus: options?.completedStatus,
    failureReason: capIdleFailureReason(options?.failureReason),
    result: capIdleResult(options?.result, options?.idleReason !== 'failed'),
  }
}

/**
 * Checks if a message text contains an idle notification
 */
export function isIdleNotification(
  messageText: string,
): IdleNotificationMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'idle_notification') {
      return parsed as IdleNotificationMessage
    }
  } catch {
    // Not JSON or not a valid idle notification
  }
  return null
}

/**
 * Permission request message sent from worker to leader via mailbox.
 * Field names align with SDK `can_use_tool` (snake_case).
 */
export type PermissionRequestMessage = {
  type: 'permission_request'
  request_id: string
  agent_id: string
  tool_name: string
  tool_use_id: string
  description: string
  input: Record<string, unknown>
  permission_suggestions: unknown[]
}

/**
 * Permission response message sent from leader to worker via mailbox.
 * Shape mirrors SDK ControlResponseSchema / ControlErrorResponseSchema.
 */
const PermissionResponseMessageSchema = lazySchema(() =>
  z.discriminatedUnion('subtype', [
    z.strictObject({
      type: z.literal('permission_response'),
      request_id: z.string().min(1),
      subtype: z.literal('success'),
      response: z
        .strictObject({
          updated_input: z.record(z.string(), z.unknown()).optional(),
          permission_updates: z.array(permissionUpdateSchema()).optional(),
        })
        .optional(),
    }),
    z.strictObject({
      type: z.literal('permission_response'),
      request_id: z.string().min(1),
      subtype: z.literal('error'),
      error: z.string(),
    }),
  ]),
)

export type PermissionResponseMessage = z.infer<
  ReturnType<typeof PermissionResponseMessageSchema>
>

/**
 * Creates a permission request message to send to the team leader
 */
export function createPermissionRequestMessage(params: {
  request_id: string
  agent_id: string
  tool_name: string
  tool_use_id: string
  description: string
  input: Record<string, unknown>
  permission_suggestions?: unknown[]
}): PermissionRequestMessage {
  return {
    type: 'permission_request',
    request_id: params.request_id,
    agent_id: params.agent_id,
    tool_name: params.tool_name,
    tool_use_id: params.tool_use_id,
    description: params.description,
    input: params.input,
    permission_suggestions: params.permission_suggestions || [],
  }
}

/**
 * Creates a permission response message to send back to a worker
 */
export function createPermissionResponseMessage(params: {
  request_id: string
  subtype: 'success' | 'error'
  error?: string
  updated_input?: Record<string, unknown>
  permission_updates?: PermissionUpdate[]
}): PermissionResponseMessage {
  if (params.subtype === 'error') {
    return {
      type: 'permission_response',
      request_id: params.request_id,
      subtype: 'error',
      error: params.error || 'Permission denied',
    }
  }
  return {
    type: 'permission_response',
    request_id: params.request_id,
    subtype: 'success',
    response: {
      updated_input: params.updated_input,
      permission_updates: params.permission_updates,
    },
  }
}

/**
 * Checks if a message text contains a permission request
 */
export function isPermissionRequest(
  messageText: string,
): PermissionRequestMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'permission_request') {
      return parsed as PermissionRequestMessage
    }
  } catch {
    // Not JSON or not a valid permission request
  }
  return null
}

/**
 * Checks if a message text contains a permission response
 */
export function isPermissionResponse(
  messageText: string,
): PermissionResponseMessage | null {
  try {
    const parsed = PermissionResponseMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (parsed.success) return parsed.data
  } catch {
    // Not JSON or not a valid permission response
  }
  return null
}

/**
 * Sandbox permission request message sent from worker to leader via mailbox
 * This is triggered when sandbox runtime detects a network access to a non-allowed host
 */
export type SandboxPermissionRequestMessage = {
  type: 'sandbox_permission_request'
  /** Unique identifier for this request */
  requestId: string
  /** Worker's CLAUDE_CODE_AGENT_ID */
  workerId: string
  /** Worker's CLAUDE_CODE_AGENT_NAME */
  workerName: string
  /** Worker's CLAUDE_CODE_AGENT_COLOR */
  workerColor?: string
  /** The host pattern requesting network access */
  hostPattern: {
    host: string
  }
  /** Timestamp when request was created */
  createdAt: number
}

/**
 * Sandbox permission response message sent from leader to worker via mailbox
 */
const SandboxPermissionResponseMessageSchema = lazySchema(() =>
  z.strictObject({
    type: z.literal('sandbox_permission_response'),
    /** ID of the request this responds to */
    requestId: z.string().min(1),
    /** The host that was approved/denied */
    host: z.string().min(1),
    /** Whether the connection was allowed */
    allow: z.boolean(),
    /** Timestamp when response was created */
    timestamp: z.string(),
  }),
)

export type SandboxPermissionResponseMessage = z.infer<
  ReturnType<typeof SandboxPermissionResponseMessageSchema>
>

/**
 * Creates a sandbox permission request message to send to the team leader
 */
export function createSandboxPermissionRequestMessage(params: {
  requestId: string
  workerId: string
  workerName: string
  workerColor?: string
  host: string
}): SandboxPermissionRequestMessage {
  return {
    type: 'sandbox_permission_request',
    requestId: params.requestId,
    workerId: params.workerId,
    workerName: params.workerName,
    workerColor: params.workerColor,
    hostPattern: { host: params.host },
    createdAt: Date.now(),
  }
}

/**
 * Creates a sandbox permission response message to send back to a worker
 */
export function createSandboxPermissionResponseMessage(params: {
  requestId: string
  host: string
  allow: boolean
}): SandboxPermissionResponseMessage {
  return {
    type: 'sandbox_permission_response',
    requestId: params.requestId,
    host: params.host,
    allow: params.allow,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Checks if a message text contains a sandbox permission request
 */
export function isSandboxPermissionRequest(
  messageText: string,
): SandboxPermissionRequestMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'sandbox_permission_request') {
      return parsed as SandboxPermissionRequestMessage
    }
  } catch {
    // Not JSON or not a valid sandbox permission request
  }
  return null
}

/**
 * Checks if a message text contains a sandbox permission response
 */
export function isSandboxPermissionResponse(
  messageText: string,
): SandboxPermissionResponseMessage | null {
  try {
    const parsed = SandboxPermissionResponseMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (parsed.success) return parsed.data
  } catch {
    // Not JSON or not a valid sandbox permission response
  }
  return null
}

/**
 * Message sent when a teammate requests plan approval from the team leader
 */
export const PlanApprovalRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('plan_approval_request'),
    from: z.string(),
    timestamp: z.string(),
    planFilePath: z.string(),
    planContent: z.string(),
    requestId: z.string(),
  }),
)

export type PlanApprovalRequestMessage = z.infer<
  ReturnType<typeof PlanApprovalRequestMessageSchema>
>

/**
 * Message sent by the team leader in response to a plan approval request
 */
export const PlanApprovalResponseMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('plan_approval_response'),
    requestId: z.string(),
    approved: z.boolean(),
    feedback: z.string().optional(),
    timestamp: z.string(),
    permissionMode: PermissionModeSchema().optional(),
  }),
)

export type PlanApprovalResponseMessage = z.infer<
  ReturnType<typeof PlanApprovalResponseMessageSchema>
>

/**
 * Shutdown request message sent from leader to teammate via mailbox
 */
export const ShutdownRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_request'),
    requestId: z.string(),
    from: z.string(),
    reason: z.string().optional(),
    timestamp: z.string(),
  }),
)

export type ShutdownRequestMessage = z.infer<
  ReturnType<typeof ShutdownRequestMessageSchema>
>

/**
 * Shutdown approved message sent from teammate to leader via mailbox
 *
 * `backendType` deliberately leaves out `process`, the desktop's members.
 * Whoever recognises an approval here removes the member from the team file
 * and unassigns its unfinished tasks, which is right for a teammate the lead
 * itself runs. A desktop member belongs to the server's team runtime instead:
 * it stays on the roster as stopped so a message can restart it, and its tasks
 * keep the owners the user approved, which is what wakes the members waiting
 * on them. Its approval therefore reaches the lead as an ordinary message.
 */
export const ShutdownApprovedMessageSchema = lazySchema(() =>
  z.strictObject({
    type: z.literal('shutdown_approved'),
    requestId: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.string(),
    paneId: z.string().optional(),
    backendType: z.enum(['tmux', 'iterm2', 'in-process']).optional(),
  }),
)

export type ShutdownApprovedMessage = z.infer<
  ReturnType<typeof ShutdownApprovedMessageSchema>
>

/**
 * Shutdown rejected message sent from teammate to leader via mailbox
 */
export const ShutdownRejectedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_rejected'),
    requestId: z.string(),
    from: z.string(),
    reason: z.string(),
    timestamp: z.string(),
  }),
)

export type ShutdownRejectedMessage = z.infer<
  ReturnType<typeof ShutdownRejectedMessageSchema>
>

/**
 * Creates a shutdown request message to send to a teammate
 */
export function createShutdownRequestMessage(params: {
  requestId: string
  from: string
  reason?: string
}): ShutdownRequestMessage {
  return {
    type: 'shutdown_request',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Creates a shutdown approved message to send to the team leader
 */
export function createShutdownApprovedMessage(params: {
  requestId: string
  from: string
  paneId?: string
  backendType?: BackendType
}): ShutdownApprovedMessage {
  return {
    type: 'shutdown_approved',
    requestId: params.requestId,
    from: params.from,
    timestamp: new Date().toISOString(),
    paneId: params.paneId,
    backendType: params.backendType,
  }
}

/**
 * Creates a shutdown rejected message to send to the team leader
 */
export function createShutdownRejectedMessage(params: {
  requestId: string
  from: string
  reason: string
}): ShutdownRejectedMessage {
  return {
    type: 'shutdown_rejected',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Sends a shutdown request to a teammate's mailbox.
 * This is the core logic extracted for reuse by both the tool and UI components.
 *
 * @param targetName - Name of the teammate to send shutdown request to
 * @param teamName - Optional team name (defaults to CLAUDE_CODE_TEAM_NAME env var)
 * @param reason - Optional reason for the shutdown request
 * @returns The request ID and target name
 */
export async function sendShutdownRequestToMailbox(
  targetName: string,
  teamName?: string,
  reason?: string,
): Promise<{ requestId: string; target: string }> {
  const resolvedTeamName = teamName || getTeamName()

  // Get sender name (supports in-process teammates via AsyncLocalStorage)
  const senderName = getAgentName() || TEAM_LEAD_NAME

  // Generate a deterministic request ID for this shutdown request
  const requestId = generateRequestId('shutdown', targetName)

  // Create and send the shutdown request message
  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    resolvedTeamName,
  )

  return { requestId, target: targetName }
}

/**
 * Checks if a message text contains a shutdown request
 */
export function isShutdownRequest(
  messageText: string,
): ShutdownRequestMessage | null {
  try {
    const result = ShutdownRequestMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Checks if a message text contains a plan approval request
 */
export function isPlanApprovalRequest(
  messageText: string,
): PlanApprovalRequestMessage | null {
  try {
    const result = PlanApprovalRequestMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Checks if a message text contains a shutdown approved message
 */
export function isShutdownApproved(
  messageText: string,
): ShutdownApprovedMessage | null {
  try {
    const result = ShutdownApprovedMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

export type TrustedShutdownTeamMember = {
  agentId: string
  name: string
  tmuxPaneId: string
  backendType?: BackendType
}

export type TrustedShutdownApproval = {
  approval: ShutdownApprovedMessage
  agentId: string
  name: string
  paneId?: string
  backendType?: PaneBackendType
}

/**
 * Resolves a shutdown approval against mailbox and leader-owned team state.
 * The mailbox envelope is the sender identity. Pane metadata from the message
 * body is informational only and must never select the process to terminate.
 */
export function getTrustedShutdownApproval(
  message: TeammateMessage,
  teamMembers: readonly TrustedShutdownTeamMember[],
): TrustedShutdownApproval | null {
  const approval = isShutdownApproved(message.text)
  if (!approval || approval.from !== message.from) return null

  const member = teamMembers.find(candidate => candidate.name === message.from)
  if (!member) return null

  const backendType =
    member.backendType && isPaneBackend(member.backendType)
      ? member.backendType
      : undefined

  return {
    approval,
    agentId: member.agentId,
    name: member.name,
    paneId: backendType ? member.tmuxPaneId : undefined,
    backendType,
  }
}

/**
 * Checks if a message text contains a shutdown rejected message
 */
export function isShutdownRejected(
  messageText: string,
): ShutdownRejectedMessage | null {
  try {
    const result = ShutdownRejectedMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Checks if a message text contains a plan approval response
 */
export function isPlanApprovalResponse(
  messageText: string,
): PlanApprovalResponseMessage | null {
  try {
    const result = PlanApprovalResponseMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Task assignment message sent when a task is assigned to a teammate
 */
export type TaskAssignmentMessage = {
  type: 'task_assignment'
  taskId: string
  subject: string
  description: string
  assignedBy: string
  timestamp: string
}

/**
 * Checks if a message text contains a task assignment
 */
export function isTaskAssignment(
  messageText: string,
): TaskAssignmentMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'task_assignment') {
      return parsed as TaskAssignmentMessage
    }
  } catch {
    // Not JSON or not a valid task assignment
  }
  return null
}

/**
 * Team permission update message sent from leader to teammates via mailbox
 * Broadcasts a permission update that applies to all teammates
 */
const TeamPermissionUpdateMessageSchema = lazySchema(() =>
  z.strictObject({
    type: z.literal('team_permission_update'),
    /** The permission update to apply */
    permissionUpdate: z.strictObject({
      type: z.literal('addRules'),
      rules: z.array(permissionRuleValueSchema()),
      behavior: permissionBehaviorSchema(),
      destination: z.literal('session'),
    }),
    /** The directory path that was allowed */
    directoryPath: z.string(),
    /** The tool name this applies to */
    toolName: z.string(),
  }),
)

export type TeamPermissionUpdateMessage = z.infer<
  ReturnType<typeof TeamPermissionUpdateMessageSchema>
>

/**
 * Checks if a message text contains a team permission update
 */
export function isTeamPermissionUpdate(
  messageText: string,
): TeamPermissionUpdateMessage | null {
  try {
    const parsed = TeamPermissionUpdateMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (parsed.success) return parsed.data
  } catch {
    // Not JSON or not a valid team permission update
  }
  return null
}

/**
 * Mode set request message sent from leader to teammate via mailbox
 * Uses SDK PermissionModeSchema for validated mode values
 */
export const ModeSetRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('mode_set_request'),
    mode: PermissionModeSchema(),
    from: z.string(),
  }),
)

export type ModeSetRequestMessage = z.infer<
  ReturnType<typeof ModeSetRequestMessageSchema>
>

/**
 * Creates a mode set request message to send to a teammate
 */
export function createModeSetRequestMessage(params: {
  mode: string
  from: string
}): ModeSetRequestMessage {
  return {
    type: 'mode_set_request',
    mode: params.mode as ModeSetRequestMessage['mode'],
    from: params.from,
  }
}

/**
 * Checks if a message text contains a mode set request
 */
export function isModeSetRequest(
  messageText: string,
): ModeSetRequestMessage | null {
  try {
    const parsed = ModeSetRequestMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    // Not JSON or not a valid mode set request
  }
  return null
}

/**
 * Checks if a message text is a structured protocol message that should be
 * routed by useInboxPoller rather than consumed as raw LLM context.
 *
 * These message types have specific handlers in useInboxPoller that route them
 * to the correct queues (workerPermissions, workerSandboxPermissions, etc.).
 * If getTeammateMailboxAttachments consumes them first, they get bundled as
 * raw text in attachments and never reach their intended handlers.
 */
export function isStructuredProtocolMessage(messageText: string): boolean {
  try {
    const parsed = jsonParse(messageText)
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return false
    }
    const type = (parsed as { type: unknown }).type
    return (
      type === 'permission_request' ||
      type === 'permission_response' ||
      type === 'sandbox_permission_request' ||
      type === 'sandbox_permission_response' ||
      type === 'shutdown_request' ||
      type === 'shutdown_approved' ||
      type === 'team_permission_update' ||
      type === 'mode_set_request' ||
      type === 'plan_approval_request' ||
      type === 'plan_approval_response'
    )
  } catch {
    return false
  }
}

/**
 * Marks only messages matching a predicate as read, leaving others unread.
 * Uses the same locked, archiving update as claimMailboxMessages.
 * @returns false when the inbox could not be updated
 */
export async function markMessagesAsReadByPredicate(
  agentName: string,
  predicate: (msg: TeammateMessage) => boolean,
  teamName?: string,
): Promise<boolean> {
  const inboxPath = getInboxPath(agentName, teamName)

  try {
    await updateInbox(inboxPath, messages =>
      messages.map(m => (!m.read && predicate(m) ? { ...m, read: true } : m)),
    )
    return true
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return true
    }
    logForDebugging(
      `[TeammateMailbox] markMessagesAsReadByPredicate failed for ${agentName}: ${error}`,
      { level: 'warn' },
    )
    if (code !== 'ELOCKED') logError(error)
    return false
  }
}

/**
 * Extracts a "[to {name}] {summary}" string from the last assistant message
 * if it ended with a SendMessage tool_use targeting a peer (not the team lead).
 * Returns undefined when the turn didn't end with a peer DM.
 */
export function getLastPeerDmSummary(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue

    // Stop at wake-up boundary: a user prompt (string content), not tool results (array content)
    if (msg.type === 'user' && typeof msg.message.content === 'string') {
      break
    }

    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        block.name === SEND_MESSAGE_TOOL_NAME &&
        typeof block.input === 'object' &&
        block.input !== null &&
        'to' in block.input &&
        typeof block.input.to === 'string' &&
        block.input.to !== '*' &&
        block.input.to.toLowerCase() !== TEAM_LEAD_NAME.toLowerCase() &&
        'message' in block.input &&
        typeof block.input.message === 'string'
      ) {
        const to = block.input.to
        const summary =
          'summary' in block.input && typeof block.input.summary === 'string'
            ? block.input.summary
            : block.input.message.slice(0, 80)
        return `[to ${to}] ${summary}`
      }
    }
  }
  return undefined
}
