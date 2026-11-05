/**
 * Counts Latin-script terms in the user's own chat messages, entirely on this
 * computer. Only the resulting words and counts ever leave the scan (to the
 * pick model); message text never does.
 *
 * Ported from the benchmark probe `history_terms.py`, validated on a real
 * machine (1,231 sessions in ~9 s with useful top terms).
 *
 * Only recent history is read (`HISTORY_WINDOW_DAYS`): a heavy user's whole
 * history is gigabytes, which made the scan take tens of seconds, and the
 * words someone says now are the ones dictation needs.
 *
 * Sources:
 * - Claude Code: `<Claude config home>/projects/<project>/<session>.jsonl`, one
 *   session per file. Subagent folders and `agent-*.jsonl` sidechain files are
 *   not the user's own messages and are skipped.
 * - Codex: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and
 *   `$CODEX_HOME/archived_sessions/` (default `~/.codex`), one thread per file,
 *   written by both the CLI and the app. Only threads the user typed into count:
 *   `codex exec` runs, subagents and agent-created threads are skipped.
 *   `history.jsonl` is only the CLI's prompt recall; the app never writes it.
 */

import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import { getClaudeConfigHomeDir } from '../../../../utils/envUtils.js'
import type { VoiceHistorySource, VoiceHistorySourceId } from '../types.js'

export const VOICE_HISTORY_SOURCE_IDS: readonly VoiceHistorySourceId[] = ['claude-code', 'codex']

export interface HistoryPaths {
  /** Claude config home (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
  claudeConfigDir: string
  /** Codex home (`CODEX_HOME` or `~/.codex`). */
  codexHome: string
}

export interface HistoryCandidate {
  /** The most frequent spelling. */
  term: string
  /** Distinct sessions the term appeared in. */
  sessions: number
  /** Messages the term appeared in (once per message). */
  count: number
}

export interface HistoryScanResult {
  sessions: number
  messages: number
  candidates: HistoryCandidate[]
}

export const HISTORY_CANDIDATE_LIMIT = 400
/** How far back the scan reads. */
export const HISTORY_WINDOW_DAYS = 14
const DAY_MS = 86_400_000
/** A term must recur across sessions to be more than a one-off. */
const MIN_SESSIONS = 3
/** Light users get a lower bar so the dialog is not empty. */
const MIN_SESSIONS_SMALL_HISTORY = 2
const SMALL_HISTORY_SESSIONS = 30
const MIN_TERM_LENGTH = 2
const MAX_TERM_LENGTH = 32
const MAX_LINE_LENGTH = 400
const MAX_SYMBOL_RATIO = 0.15
/** Lines between event-loop yields and abort checks while reading. */
const YIELD_EVERY_LINES = 2000

export function defaultHistoryPaths(): HistoryPaths {
  return {
    claudeConfigDir: getClaudeConfigHomeDir(),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  }
}

/** The earliest moment (epoch ms) a message may have been written to count. */
export function historyWindowStart(now: number = Date.now()): number {
  return now - HISTORY_WINDOW_DAYS * DAY_MS
}

export function isVoiceHistorySourceId(value: unknown): value is VoiceHistorySourceId {
  return typeof value === 'string' && (VOICE_HISTORY_SOURCE_IDS as readonly string[]).includes(value)
}

const TERM = /(?<![A-Za-z0-9_./\\-])[A-Za-z][A-Za-z0-9]*(?:[.\-+][A-Za-z0-9]+)*(?![A-Za-z0-9_/\\])/g
const SKIP_PREFIXES = [
  '<command-',
  '<local-command',
  '<system-reminder',
  'Caveat:',
  '[Request interrupted',
  '<task-notification',
  '<bash-',
  'This session is being continued',
  '<user-prompt-submit-hook',
]
const SKIP_ANYWHERE = ['<teammate-message', '<task-notification']
const STOP_WORDS = new Set(`
a an the and or but if then else when while for to of in on at by with from as is are was were be been being am do does did done
have has had not no yes so than too very can could should would will shall may might must it its this that these those there here
i you he she we they me him her us them my your our their mine yours what which who whom whose why how all any both each few more
most other some such only own same just also into over under again further once about above below up down out off between through
during before after because until against among per via vs etc ok okay please thanks thank hi hello let lets make makes made get gets
got go goes going use used using new old one two three first last next now then still even well like see look need want try add run
file files code line lines error errors test tests fix bug issue issues update change changes check work works working way time
`.split(/\s+/).filter(Boolean))
/** Pasted code, JSON, logs and stack frames. */
const CODE_LINE = /^(at |\d+\s|[{}[\]<]|[A-Z_]{3,}:|[\p{L}\p{N}_]+\.[\p{L}\p{N}_]+:\d+)/u
const STRIPPED_SPANS = /```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|\S+@\S+/g
const NOT_SYMBOL = /[\p{L}\p{N}\s一-鿿]/u

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function* readLines(filePath: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let read = 0
  try {
    for await (const line of lines) {
      read += 1
      if (read % YIELD_EVERY_LINES === 0) {
        if (signal?.aborted) throw abortError()
        await yieldToEventLoop()
      }
      yield line
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

async function modifiedSince(file: string, since: number): Promise<boolean> {
  try {
    return (await fs.stat(file)).mtimeMs >= since
  } catch {
    return false
  }
}

/** Whether a row's write time is before `since`; rows without a readable time count as recent. */
function writtenBefore(at: number, since: number | undefined): boolean {
  return since !== undefined && Number.isFinite(at) && at < since
}

/**
 * One file per main session; subagent folders are not descended into. With
 * `since`, a transcript last written before it is skipped without being read.
 */
export async function listClaudeTranscripts(claudeConfigDir: string, since?: number): Promise<string[]> {
  const projectsDir = path.join(claudeConfigDir, 'projects')
  let projects: import('node:fs').Dirent[]
  try {
    projects = await fs.readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(path.join(projectsDir, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('agent-')) continue
      const file = path.join(projectsDir, project.name, entry.name)
      if (since === undefined || await modifiedSince(file, since)) files.push(file)
    }
  }
  return files.sort()
}

const CODEX_ROLLOUT_DIRS = ['sessions', 'archived_sessions']
/** Codex's `INTERACTIVE_SESSION_SOURCES`: where a person types the prompts. */
const CODEX_INTERACTIVE_SOURCES = ['cli', 'vscode']
const CODEX_INTERACTIVE_CUSTOM_SOURCES = ['atlas', 'chatgpt']

async function collectCodexRollouts(dir: string, since: number | undefined, files: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectCodexRollouts(entryPath, since, files)
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      if (since === undefined || await modifiedSince(entryPath, since)) files.push(entryPath)
    }
  }
}

/** Every Codex thread file; with `since`, one last written before it is skipped without being read. */
async function listCodexRollouts(codexHome: string, since?: number): Promise<string[]> {
  const files: string[] = []
  for (const dir of CODEX_ROLLOUT_DIRS) await collectCodexRollouts(path.join(codexHome, dir), since, files)
  return files.sort()
}

/**
 * The thread id from a rollout's first line, or null when the user did not type
 * into it (`codex exec`, a subagent, a thread an agent created) or it is not a
 * rollout. Only the first `session_meta` is the file's own; later ones are
 * copied in from a forked parent.
 */
export function codexUserThreadId(firstLine: string): string | null {
  let row: unknown
  try {
    row = JSON.parse(firstLine)
  } catch {
    return null
  }
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const meta = record.payload
  if (record.type !== 'session_meta' || !meta || typeof meta !== 'object') return null
  const { id, source, thread_source: threadSource } = meta as Record<string, unknown>
  const custom = source && typeof source === 'object' ? (source as Record<string, unknown>).custom : undefined
  // Rollouts from before `source` existed were all typed in the app or CLI.
  const interactive = source === undefined
    || (typeof source === 'string' && CODEX_INTERACTIVE_SOURCES.includes(source))
    || (typeof custom === 'string' && CODEX_INTERACTIVE_CUSTOM_SOURCES.includes(custom))
  if (!interactive || (threadSource !== undefined && threadSource !== 'user')) return null
  return typeof id === 'string' && id ? id : null
}

/**
 * Where the context the app or IDE puts ahead of a prompt ends: Codex's
 * `USER_MESSAGE_BEGIN`, and the app's shorter form.
 */
const CODEX_REQUEST_MARKERS = ['## My request for Codex:', '## My request:']

/** The typed request without the attachment or IDE context put ahead of it. */
function codexRequestText(text: string): string {
  for (const marker of CODEX_REQUEST_MARKERS) {
    const at = text.lastIndexOf(marker)
    if (at >= 0) return text.slice(at + marker.length).trim()
  }
  return text.trim()
}

function textParts(content: unknown[], keep: (part: Record<string, unknown>, index: number) => boolean): string {
  const texts: string[] = []
  content.forEach((part, index) => {
    if (!part || typeof part !== 'object') return
    const record = part as Record<string, unknown>
    if (typeof record.text === 'string' && keep(record, index)) texts.push(record.text)
  })
  return texts.join('\n')
}

export interface CodexUserRow {
  /** The typed text; empty when the row holds none (a heartbeat, injected context). */
  text: string
  /** Read from origin-tagged model input rather than an untagged event. */
  tagged: boolean
}

/**
 * The user's own text from one rollout row, or null for any other row,
 * including one written before `since`.
 *
 * Current Codex tags every part of a user-role model input with its origin
 * (`content_item_kinds`), so typed text (`user.text`) is told apart from
 * scheduled heartbeats and AGENTS.md, environment or skill context. Rollouts
 * written before those tags carry each prompt as a `user_message` event
 * (legacy) or a completed `UserMessage` item (paginated); the same prompt also
 * appears in those events when tags exist, so a thread with tags reads only those.
 */
export function codexUserRow(line: string, since?: number): CodexUserRow | null {
  if (!line.includes('"role":"user"') && !line.includes('"user_message"') && !line.includes('"UserMessage"')) {
    return null
  }
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const payload = record.payload
  if (!payload || typeof payload !== 'object') return null
  if (typeof record.timestamp === 'string' && writtenBefore(Date.parse(record.timestamp), since)) return null
  const item = payload as Record<string, unknown>

  if (record.type === 'response_item') {
    if (item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content)) return null
    const metadata = item.internal_chat_message_metadata_passthrough
    const kinds = metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>).content_item_kinds
      : undefined
    if (!Array.isArray(kinds) || kinds.length !== item.content.length) return null
    return { text: codexRequestText(textParts(item.content, (_, index) => kinds[index] === 'user.text')), tagged: true }
  }

  if (record.type !== 'event_msg') return null
  let text: string | undefined
  if (item.type === 'user_message' && typeof item.message === 'string') {
    text = item.message
  } else if (item.type === 'item_completed') {
    const completed = item.item
    const content = completed && typeof completed === 'object' && (completed as Record<string, unknown>).type === 'UserMessage'
      ? (completed as Record<string, unknown>).content
      : undefined
    if (Array.isArray(content)) text = textParts(content, part => part.type === 'text')
  }
  return text === undefined ? null : { text: codexRequestText(text), tagged: false }
}

async function firstLine(file: string): Promise<string | null> {
  try {
    for await (const line of readLines(file)) return line
  } catch {
    // Deleted or unreadable: it has no thread to offer.
  }
  return null
}

interface UserMessage {
  session: string
  text: string
}

/**
 * The user's own typed text from one transcript row, or null for anything
 * else, including a message written before `since`.
 */
export function claudeUserText(line: string, since?: number): string | null {
  if (!line.includes('"type":"user"')) return null
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true) return null
  if (typeof record.timestamp === 'string' && writtenBefore(Date.parse(record.timestamp), since)) return null
  const message = record.message
  let content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : undefined
  if (Array.isArray(content)) {
    const blocks = content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object')
    if (blocks.some(block => block.type === 'tool_result')) return null
    content = blocks
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
  }
  if (typeof content !== 'string') return null
  const text = content.trim()
  if (!text || SKIP_PREFIXES.some(prefix => text.startsWith(prefix))) return null
  return text
}

async function* claudeMessages(
  claudeConfigDir: string,
  since: number | undefined,
  signal?: AbortSignal,
): AsyncGenerator<UserMessage> {
  for (const file of await listClaudeTranscripts(claudeConfigDir, since)) {
    if (signal?.aborted) throw abortError()
    const session = `claude-code:${path.basename(file, '.jsonl')}`
    try {
      for await (const line of readLines(file, signal)) {
        const text = claudeUserText(line, since)
        if (text) yield { session, text }
      }
    } catch (error) {
      if (signal?.aborted) throw abortError()
      // A transcript deleted or unreadable mid-scan only loses its own terms.
      if (!(error instanceof Error && 'code' in error)) throw error
    }
  }
}

async function* codexMessages(
  codexHome: string,
  since: number | undefined,
  signal?: AbortSignal,
): AsyncGenerator<UserMessage> {
  for (const file of await listCodexRollouts(codexHome, since)) {
    if (signal?.aborted) throw abortError()
    let thread: string | null | undefined
    let sawTags = false
    const tagged: string[] = []
    const untagged: string[] = []
    try {
      for await (const line of readLines(file, signal)) {
        if (thread === undefined) {
          thread = codexUserThreadId(line)
          if (!thread) break
          continue
        }
        const row = codexUserRow(line, since)
        if (!row) continue
        sawTags ||= row.tagged
        if (row.text) (row.tagged ? tagged : untagged).push(row.text)
      }
    } catch (error) {
      if (signal?.aborted) throw abortError()
      // A rollout deleted or unreadable mid-scan only loses its own terms.
      if (!(error instanceof Error && 'code' in error)) throw error
      continue
    }
    for (const text of sawTags ? tagged : untagged) yield { session: `codex:${thread}`, text }
  }
}

async function countCodexThreads(codexHome: string, since: number | undefined): Promise<number> {
  let threads = 0
  for (const file of await listCodexRollouts(codexHome, since)) {
    const line = await firstLine(file)
    if (line !== null && codexUserThreadId(line)) threads += 1
  }
  return threads
}

/** Sessions per source; with `since`, only those written to since then. */
export async function listHistorySources(paths: HistoryPaths, since?: number): Promise<VoiceHistorySource[]> {
  const claudeSessions = (await listClaudeTranscripts(paths.claudeConfigDir, since)).length
  const codexSessions = await countCodexThreads(paths.codexHome, since)
  return [
    { id: 'claude-code', available: claudeSessions > 0, sessions: claudeSessions },
    { id: 'codex', available: codexSessions > 0, sessions: codexSessions },
  ]
}

/** Drops pasted logs, JSON and code: symbol-heavy, stack-frame-like or very long lines. */
export function keepProseLines(text: string): string[] {
  const kept: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const chars = [...line]
    if (chars.length > MAX_LINE_LENGTH) continue
    let symbols = 0
    for (const char of chars) if (!NOT_SYMBOL.test(char)) symbols += 1
    if (symbols / chars.length > MAX_SYMBOL_RATIO || CODE_LINE.test(line)) continue
    kept.push(line)
  }
  return kept
}

/** Distinct terms in one message, keyed by lowercase, with the spelling used. */
export function messageTerms(text: string): Map<string, string> {
  const terms = new Map<string, string>()
  if (SKIP_ANYWHERE.some(marker => text.includes(marker))) return terms
  const prose = keepProseLines(text.replace(STRIPPED_SPANS, ' ')).join('\n')
  for (const match of prose.matchAll(TERM)) {
    const term = match[0]
    const key = term.toLowerCase()
    if (key.length < MIN_TERM_LENGTH || key.length > MAX_TERM_LENGTH || STOP_WORDS.has(key) || terms.has(key)) continue
    terms.set(key, term)
  }
  return terms
}

export async function scanHistoryTerms(
  sources: readonly VoiceHistorySourceId[],
  options: {
    paths: HistoryPaths
    signal?: AbortSignal
    /** Lowercased terms not to offer again (already in the vocabulary, or dismissed). */
    exclude?: ReadonlySet<string>
    limit?: number
    /** Epoch ms; messages written before it are not read. Omitted reads everything. */
    since?: number
  },
): Promise<HistoryScanResult> {
  const counts = new Map<string, number>()
  const termSessions = new Map<string, Set<string>>()
  const spellings = new Map<string, Map<string, number>>()
  const sessions = new Set<string>()
  let messages = 0

  const streams: AsyncGenerator<UserMessage>[] = []
  if (sources.includes('claude-code')) {
    streams.push(claudeMessages(options.paths.claudeConfigDir, options.since, options.signal))
  }
  if (sources.includes('codex')) streams.push(codexMessages(options.paths.codexHome, options.since, options.signal))

  for (const stream of streams) {
    for await (const message of stream) {
      messages += 1
      sessions.add(message.session)
      for (const [key, spelling] of messageTerms(message.text)) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
        let seenIn = termSessions.get(key)
        if (!seenIn) termSessions.set(key, seenIn = new Set())
        seenIn.add(message.session)
        let forms = spellings.get(key)
        if (!forms) spellings.set(key, forms = new Map())
        forms.set(spelling, (forms.get(spelling) ?? 0) + 1)
      }
    }
  }
  if (options.signal?.aborted) throw abortError()

  const minSessions = sessions.size < SMALL_HISTORY_SESSIONS ? MIN_SESSIONS_SMALL_HISTORY : MIN_SESSIONS
  const candidates: HistoryCandidate[] = []
  for (const [key, count] of counts) {
    const seenIn = termSessions.get(key)!.size
    if (seenIn < minSessions || options.exclude?.has(key)) continue
    let term = key
    let best = 0
    for (const [spelling, uses] of spellings.get(key)!) {
      if (uses > best) {
        term = spelling
        best = uses
      }
    }
    candidates.push({ term, sessions: seenIn, count })
  }
  candidates.sort((left, right) => right.sessions - left.sessions || right.count - left.count)
  return {
    sessions: sessions.size,
    messages,
    candidates: candidates.slice(0, options.limit ?? HISTORY_CANDIDATE_LIMIT),
  }
}

