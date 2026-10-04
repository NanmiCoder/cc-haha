/**
 * Pure projection of transcript JSONL records into trajectory (轨迹) rows.
 *
 * Input is one page of records in file order with their byte ranges; output
 * is the compact ledger described in `trajectoryTypes.ts`. Nothing here does
 * I/O, and nothing reuses the chat projection (`entriesToMessages`) so the
 * `/messages` surface stays untouched.
 */

import {
  parseSessionCollaborationEnvelope,
  SESSION_COLLABORATION_PROMPT_PREFIX,
} from '../../utils/sessionCollaborationEnvelope.js'
import type { TrajectoryLoc, TrajectoryRow, TrajectoryUsage } from './trajectoryTypes.js'

export type ProjectionEntry = {
  entry: Record<string, unknown>
  byteStart: number
  byteEnd: number
  /**
   * The record exceeded the reader's record budget and was not parsed; `entry`
   * is the stub built by `oversizedProjectionEntry` from the line head.
   */
  oversizedBytes?: number
}

export type ProjectionOptions = {
  /** Turns completed before the first entry; null when unknown (rows then carry relative turns). */
  turnBase: number | null
  /** Main transcripts skip `isSidechain` records; subagent transcripts are all sidechain. */
  skipSidechain: boolean
  /**
   * Timestamps of the projected records right before the first entry, in
   * file order. Lets a response that opens the page still get its `startTs`.
   */
  precedingTimestamps?: string[]
}

export const PREVIEW_CHARS = 512
export const TOOL_PREVIEW_CHARS = 300
export const INPUT_SUMMARY_CHARS = 200
/** How many preceding records a response looks back through for its start time. */
export const START_TS_LOOKBACK = 16

const TRANSCRIPT_TYPES = new Set(['user', 'assistant', 'attachment', 'system'])
const USER_INTERRUPTION_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])
const TASK_NOTIFICATION_RE = /^<task-notification>\s*[\s\S]*<\/task-notification>$/i
const LOCAL_COMMAND_OUTPUT_RE = /^<local-command-(?:stdout|stderr)>/
const SKILL_PREFIX = 'Base directory for this skill:'
const AGENT_ID_RE = /(?:^|\n)\s*(?:agentId|agent_id):\s*([A-Za-z0-9_@.-]+)/
const TEAMMATE_MESSAGE_RE = /^(?:Another Claude session sent a message:\s*)?<teammate-message\b([^>]*)>\s*([\s\S]*?)\s*(?:<\/teammate-message>|$)/
const TEAMMATE_ID_RE = /\bteammate_id="([^"]*)"/
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/
const COMMAND_TAG_RE = /<\/?(?:local-command-stdout|local-command-stderr|command-name|command-message|command-args)>/g
/** Bounded probes over an oversized record's line head (never a full parse). */
const HEAD_TYPE_RE = /"type":"(user|assistant|attachment|system)"/
const HEAD_UUID_RE = /"uuid":"([0-9A-Za-z_-]{1,128})"/
const HEAD_TIMESTAMP_RE = /"timestamp":"(\d{4}-\d{2}-\d{2}T[0-9:.]{1,20}(?:Z|[+-]\d{2}:?\d{2}))"/
const HEAD_TOOL_USE_ID_RE = /"tool_use_id":"([^"\\]{1,256})"/g
const HEAD_MAX_TOOL_USE_IDS = 64

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Collapse whitespace and bound to `max` chars. */
export function previewText(value: string, max = PREVIEW_CHARS): string {
  // Bound before collapsing so a huge body never gets fully regex-scanned.
  const collapsed = value.slice(0, max * 4).replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed
}

function compactJson(value: unknown, max = TOOL_PREVIEW_CHARS): string {
  let text: string
  try { text = JSON.stringify(value) ?? '' } catch { text = '' }
  return previewText(text, max)
}

function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
}

function contentPreview(content: unknown, max = PREVIEW_CHARS): string {
  if (typeof content === 'string') return previewText(content, max)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  let length = 0
  for (const block of content) {
    if (length > max) break
    let part = ''
    if (typeof block === 'string') part = block
    else if (isRecord(block)) {
      if (block.type === 'text' && typeof block.text === 'string') part = block.text
      else if (block.type === 'image') part = '[image]'
      else if (block.type === 'document') part = '[document]'
      else if (block.type === 'tool_result') part = contentPreview(block.content, max)
    }
    if (part) { parts.push(part.slice(0, max * 4)); length += part.length }
  }
  return previewText(parts.join(' '), max)
}

function isInterruption(content: unknown): boolean {
  const texts = textBlocks(content).map(text => text.trim()).filter(Boolean)
  return texts.length > 0 && texts.every(text => USER_INTERRUPTION_TEXTS.has(text))
}

function isTaskNotification(content: unknown): boolean {
  const texts = textBlocks(content).map(text => text.trim()).filter(Boolean)
  return texts.length > 0 && texts.every(text => TASK_NOTIFICATION_RE.test(text))
}

function firstText(content: unknown): string {
  return textBlocks(content).map(text => text.trim()).find(Boolean) ?? ''
}

function hasNonToolResultBlock(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  return Array.isArray(content) && content.some(block => isRecord(block) && block.type !== 'tool_result')
}

/** Marker the turn index prefilter can match in raw bytes before parsing. */
export const SESSION_MESSAGE_META_MARKER = SESSION_COLLABORATION_PROMPT_PREFIX.slice(0, 40)

/**
 * A message delivered from another session or teammate: the desktop
 * collaboration envelope (persisted as `isMeta`) or a `<teammate-message>`
 * (optionally behind "Another Claude session sent a message:").
 */
export function sessionMessage(content: unknown): { from?: string; text: string } | null {
  const raw = typeof content === 'string' ? content : textBlocks(content)[0]
  if (!raw) return null
  if (raw.startsWith(SESSION_COLLABORATION_PROMPT_PREFIX)) {
    const envelope = parseSessionCollaborationEnvelope(raw)
    return envelope ? { from: envelope.senderSessionId, text: envelope.text } : null
  }
  const match = TEAMMATE_MESSAGE_RE.exec(raw.slice(0, PREVIEW_CHARS * 8))
  if (!match) return null
  const from = TEAMMATE_ID_RE.exec(match[1] ?? '')?.[1]
  return { ...(from ? { from } : {}), text: match[2] ?? '' }
}

function isCollaborationDelivery(entry: Rec): boolean {
  const message = entry.message
  return isRecord(message) && typeof message.content === 'string' &&
    message.content.startsWith(SESSION_COLLABORATION_PROMPT_PREFIX) && parseSessionCollaborationEnvelope(message.content) !== null
}

/**
 * A prompt that starts a new turn: human-authored input, or a message
 * delivered from another session (persisted as `isMeta` but still the input of
 * a model turn). Synthetic interruptions, task notifications, local command
 * output, tool results and every other injected (meta / compact summary /
 * transcript-only) user record are excluded. The turn index
 * (`trajectoryService.ts`) uses this exact predicate.
 */
export function isRealUserPrompt(entry: Rec): boolean {
  if (entry.type !== 'user' || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return false
  if (entry.isMeta === true && !isCollaborationDelivery(entry)) return false
  const message = entry.message
  if (!isRecord(message) || message.role !== 'user') return false
  const content = message.content
  if (!hasNonToolResultBlock(content)) return false
  if (isInterruption(content) || isTaskNotification(content)) return false
  const text = firstText(content)
  return !LOCAL_COMMAND_OUTPUT_RE.test(text)
}

/** Records the projection ignores entirely; the turn index honours the same rule. */
export function isProjectionSkipped(entry: Rec, skipSidechain: boolean): boolean {
  return !TRANSCRIPT_TYPES.has(String(entry.type)) || (skipSidechain && entry.isSidechain === true)
}

export function extractAgentIdFromText(text: string): string | undefined {
  return text.match(AGENT_ID_RE)?.[1]
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (typeof block === 'string') return [block]
    if (isRecord(block) && typeof block.text === 'string') return [block.text]
    return []
  }).join('\n')
}

function mapUsage(value: unknown): TrajectoryUsage | undefined {
  if (!isRecord(value)) return undefined
  const num = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] as number : 0
  return {
    input: num('input_tokens'),
    output: num('output_tokens'),
    cacheRead: num('cache_read_input_tokens'),
    cacheWrite: num('cache_creation_input_tokens'),
  }
}

function isForkInherited(entry: Rec): boolean {
  const forkedFrom = entry.forkedFrom
  return isRecord(forkedFrom) && typeof forkedFrom.sessionId === 'string' && forkedFrom.sessionId.length > 0 &&
    typeof forkedFrom.messageUuid === 'string' && forkedFrom.messageUuid.length > 0
}

function list(values: unknown, max = 8): string {
  if (!Array.isArray(values)) return ''
  const names = values.filter((value): value is string => typeof value === 'string')
  return names.slice(0, max).join(', ') + (names.length > max ? ` +${names.length - max}` : '')
}

function firstStringField(value: Rec): string {
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'type' && typeof child === 'string' && child.trim()) return child
  }
  return ''
}

/** `key=value` / `key[n]` / `key{…}` for the first few fields, for shapes without a known summary. */
function fieldSummary(value: Rec, max = 6): string {
  const parts: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (key === 'type') continue
    if (parts.length >= max) { parts.push('…'); break }
    if (typeof child === 'string') parts.push(child.length > 60 ? `${key}=${child.slice(0, 60)}…` : `${key}=${child}`)
    else if (typeof child === 'number' || typeof child === 'boolean') parts.push(`${key}=${child}`)
    else if (Array.isArray(child)) parts.push(`${key}[${child.length}]`)
    else if (isRecord(child)) parts.push(`${key}{${Object.keys(child).slice(0, 4).join(', ')}}`)
  }
  return parts.join(' ')
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Slash command / local command envelopes as plain text (`/model args`, command stdout). */
export function commandText(text: string): string {
  const bounded = text.slice(0, PREVIEW_CHARS * 4)
  const name = COMMAND_NAME_RE.exec(bounded)?.[1]?.trim()
  if (name) return `${name} ${COMMAND_ARGS_RE.exec(bounded)?.[1]?.trim() ?? ''}`.trim()
  return bounded.replace(COMMAND_TAG_RE, ' ')
}

/** Drop simple markdown markers so a preview reads as plain text. */
export function stripMarkdown(text: string): string {
  return text.slice(0, PREVIEW_CHARS * 4)
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|(?:>[ \t]?)+|[-*+][ \t]+|\d{1,3}[.)][ \t]+)/gm, '')
    .replace(/\*\*|__|`+/g, '')
}

const SUMMARY_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt', 'name']

/** The argument that identifies a tool call, as plain text. */
export function toolInputSummary(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const field = (key: string) => typeof input[key] === 'string' && (input[key] as string).trim() ? input[key] as string : undefined
  let value: string | undefined
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      value = field('command')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      value = field('file_path') ?? field('notebook_path') ?? field('path')
      break
    case 'Grep':
    case 'Glob': {
      const pattern = field('pattern')
      const where = field('path')
      value = pattern && where ? `${pattern} in ${where}` : pattern
      break
    }
    case 'WebFetch':
      value = field('url')
      break
    case 'WebSearch':
      value = field('query')
      break
    case 'Agent':
    case 'Task':
      value = field('description') ?? field('subagent_type')
      break
    case 'Skill':
      value = field('skill')
      break
  }
  value ??= SUMMARY_FIELDS.map(field).find(Boolean)
  return value ? previewText(value, INPUT_SUMMARY_CHARS) : undefined
}

/** Preview of a tool result: its text, plus an `[image]` marker per image block. */
function toolResultPreview(content: unknown, text: string): string {
  const images = Array.isArray(content) ? content.filter(block => isRecord(block) && block.type === 'image').length : 0
  if (!images) return previewText(text || contentPreview(content), TOOL_PREVIEW_CHARS)
  const markers = Array.from({ length: Math.min(images, 4) }, () => '[image]').join(' ') + (images > 4 ? ` +${images - 4}` : '')
  const body = text ? previewText(text, TOOL_PREVIEW_CHARS - markers.length - 1) : ''
  return body ? `${body} ${markers}` : markers
}

/** Retry notices (`api_error` with an attempt still to come) versus a terminal error. */
function apiErrorRow(entry: Rec): { label: 'api_retry' | 'api_error'; preview: string } {
  const error = isRecord(entry.error) ? entry.error : undefined
  const body = error && isRecord(error.error) ? (isRecord(error.error.error) ? error.error.error : error.error) : undefined
  const cause = isRecord(entry.cause) ? entry.cause : error && isRecord(error.cause) ? error.cause : undefined
  const message = str(entry.content) ?? str(body?.message) ?? str(error?.message) ?? str(cause?.code) ?? str(cause?.message)
  const attempt = num(entry.retryAttempt)
  const max = num(entry.maxRetries)
  const wait = num(entry.retryInMs)
  const retry = attempt !== undefined && (max === undefined || attempt <= max)
  const parts = [
    attempt !== undefined ? `attempt ${attempt}${max !== undefined ? `/${max}` : ''}${retry && wait !== undefined ? `, retry in ${formatMs(wait)}` : ''}` : undefined,
    num(error?.status) !== undefined ? `HTTP ${error!.status}` : undefined,
    message,
  ].filter(Boolean)
  return { label: retry ? 'api_retry' : 'api_error', preview: parts.join(' · ') || (error ? compactJson(error) : '') }
}

function hookSummaryPreview(entry: Rec): string {
  const infos = Array.isArray(entry.hookInfos) ? entry.hookInfos.filter(isRecord) : []
  const errors = Array.isArray(entry.hookErrors) ? entry.hookErrors.filter((error): error is string => typeof error === 'string') : []
  const hooks = infos.slice(0, 4).map(info => {
    const command = (str(info.command) ?? '').split(/[\\/]/).pop() ?? ''
    return `${command}${num(info.durationMs) !== undefined ? ` (${formatMs(info.durationMs as number)})` : ''}`
  }).filter(Boolean)
  const count = num(entry.hookCount) ?? infos.length
  return [
    `${str(entry.hookLabel) ?? 'Stop'} hooks ×${count}${hooks.length ? `: ${hooks.join(', ')}${infos.length > 4 ? ` +${infos.length - 4}` : ''}` : ''}`,
    num(entry.totalDurationMs) !== undefined ? `total ${formatMs(entry.totalDurationMs as number)}` : undefined,
    errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}: ${errors[0]}` : undefined,
    entry.preventedContinuation === true ? `prevented continuation${str(entry.stopReason) ? `: ${str(entry.stopReason)}` : ''}` : undefined,
  ].filter(Boolean).join(' · ')
}

const SYSTEM_CONTEXT_LABELS: Record<string, string> = {
  local_command: 'local_command',
  stop_hook_summary: 'hook_summary',
  streaming_fallback: 'stream_retry',
  informational: 'informational',
  away_summary: 'away_summary',
  scheduled_task_fire: 'scheduled_task',
  permission_retry: 'permission_retry',
  memory_saved: 'memory_saved',
  agents_killed: 'agents_killed',
  model_refusal_fallback: 'model_fallback',
}

/** Pure metrics: they describe a turn rather than add anything to it. */
const SYSTEM_METRIC_SUBTYPES = new Set(['turn_duration', 'api_metrics'])

/** Readable text of a system record that has no `content`, from its known fields or its first string. */
function systemRecordText(entry: Rec): string {
  const content = str(entry.content)
  if (content) return content
  if (Array.isArray(entry.writtenPaths)) return entry.writtenPaths.filter((item): item is string => typeof item === 'string').join(', ')
  if (Array.isArray(entry.commands)) return entry.commands.filter((item): item is string => typeof item === 'string').join(', ')
  const model = [str(entry.fromModel) ?? str(entry.originalModel), str(entry.toModel) ?? str(entry.fallbackModel)].filter(Boolean)
  if (model.length) return model.join(' → ')
  for (const [key, value] of Object.entries(entry)) {
    if (['type', 'subtype', 'uuid', 'parentUuid', 'timestamp', 'sessionId', 'cwd', 'version', 'gitBranch', 'level', 'userType'].includes(key)) continue
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/**
 * Stub entry for a record the reader skipped as oversized, from bounded
 * probes over its line head: the record type, the tool results it carries,
 * and uuid/timestamp when they happen to sit in the head.
 */
export function oversizedProjectionEntry(head: string): Rec {
  const toolUseIds: string[] = []
  for (const match of head.matchAll(HEAD_TOOL_USE_ID_RE)) {
    if (toolUseIds.length >= HEAD_MAX_TOOL_USE_IDS) break
    if (!toolUseIds.includes(match[1]!)) toolUseIds.push(match[1]!)
  }
  const uuid = HEAD_UUID_RE.exec(head)?.[1]
  const timestamp = HEAD_TIMESTAMP_RE.exec(head)?.[1]
  return {
    type: HEAD_TYPE_RE.exec(head)?.[1] ?? 'unknown',
    ...(uuid ? { uuid } : {}),
    ...(timestamp ? { timestamp } : {}),
    toolUseIds,
  }
}

/** Per-field max: block lines of one response may carry partial usage (cc-haha writes the final usage on the last line only). */
function mergeUsage(current: TrajectoryUsage | undefined, next: TrajectoryUsage | undefined): TrajectoryUsage | undefined {
  if (!current || !next) return current ?? next
  return {
    input: Math.max(current.input, next.input),
    output: Math.max(current.output, next.output),
    cacheRead: Math.max(current.cacheRead, next.cacheRead),
    cacheWrite: Math.max(current.cacheWrite, next.cacheWrite),
  }
}

function timeOf(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : Number.NaN
}

/**
 * Request start estimate: the nearest preceding record not later than the
 * response's first line. Records written after the response completed but
 * placed before it in the file (some attachments) are skipped.
 */
function startTimestamp(recent: string[], ts: string): string | undefined {
  const at = timeOf(ts)
  if (Number.isNaN(at)) return undefined
  for (let index = recent.length - 1, seen = 0; index >= 0 && seen < START_TS_LOOKBACK; index--, seen++) {
    const candidate = timeOf(recent[index]!)
    if (!Number.isNaN(candidate) && candidate <= at) return recent[index]
  }
  return undefined
}

/** Short readable summary per attachment type. Never normalizes for the API. */
export function attachmentPreview(attachment: Rec): string {
  const type = String(attachment.type)
  const a = attachment as Rec & Record<string, any>
  switch (type) {
    case 'skill_listing':
      return `${typeof a.skillCount === 'number' ? a.skillCount : '?'} skills` + (typeof a.content === 'string' ? ': ' + a.content.slice(0, TOOL_PREVIEW_CHARS) : '')
    case 'invoked_skills':
      return list(Array.isArray(a.skills) ? a.skills.map((skill: unknown) => isRecord(skill) ? skill.name : undefined) : [])
    case 'dynamic_skill':
      return list(a.skillNames)
    case 'skill_discovery':
      return list(Array.isArray(a.skills) ? a.skills.map((skill: unknown) => isRecord(skill) ? skill.name : undefined) : [])
    case 'todo_reminder':
    case 'task_reminder':
      return `${typeof a.itemCount === 'number' ? a.itemCount : Array.isArray(a.content) ? a.content.length : 0} items`
    case 'nested_memory':
      return str(a.displayPath) ?? str(a.path) ?? ''
    case 'relevant_memories':
      return list(Array.isArray(a.memories) ? a.memories.map((memory: unknown) => isRecord(memory) ? memory.path : undefined) : [])
    case 'current_session_memory':
      return str(a.path) ?? ''
    case 'async_hook_response':
    case 'hook_blocking_error':
    case 'hook_stopped_continuation':
    case 'hook_additional_context':
    case 'hook_permission_decision':
    case 'hook_system_message':
    case 'hook_cancelled':
    case 'hook_error_during_execution':
    case 'hook_success':
    case 'hook_non_blocking_error':
      return [a.hookName, a.hookEvent, typeof a.exitCode === 'number' ? `exit ${a.exitCode}` : undefined, type === 'hook_permission_decision' ? a.decision : undefined]
        .filter(part => typeof part === 'string' && part).join(' · ')
    case 'plan_mode':
    case 'plan_mode_reentry':
    case 'plan_mode_exit':
      return [str(a.reminderType), str(a.planFilePath)].filter(Boolean).join(' · ')
    case 'auto_mode':
      return str(a.reminderType) ?? fieldSummary(attachment)
    case 'ultra_effort_enter':
      return str(a.reminderType) ?? ''
    case 'deferred_tools_record': {
      const names = Array.isArray(a.entries) ? a.entries.map((entry: unknown) => isRecord(entry) ? entry.name : undefined) : []
      return [
        names.length ? `${names.length} tools: ${list(names)}` : '',
        Array.isArray(a.nameOnlyAnnouncements) && a.nameOnlyAnnouncements.length ? `${a.nameOnlyAnnouncements.length} name-only` : '',
        Array.isArray(a.toolInputCopies) && a.toolInputCopies.length ? `${a.toolInputCopies.length} input copies` : '',
      ].filter(Boolean).join(' · ') || fieldSummary(attachment)
    }
    case 'environment': {
      const snapshot = isRecord(a.snapshot) ? a.snapshot as Record<string, any> : {}
      const changes = Array.isArray(a.changes) ? a.changes.map((change: unknown) => isRecord(change) ? change.field : undefined) : []
      return [str(snapshot.workingDirectory), str(snapshot.platform), str(snapshot.shell), str(snapshot.osVersion),
        changes.length ? `changed: ${list(changes)}` : undefined].filter(Boolean).join(' · ') || fieldSummary(attachment)
    }
    case 'instructions': {
      const files = Array.isArray(a.files) ? a.files.filter(isRecord) : []
      return files.length
        ? `${files.length} file${files.length > 1 ? 's' : ''}: ${list(files.map((file: Rec) => [str(file.type), str(file.path)?.split(/[\\/]/).slice(-2).join('/')].filter(Boolean).join(' ')), 4)}`
        : fieldSummary(attachment)
    }
    case 'session_context':
      return isRecord(a.context) ? list(Object.keys(a.context)) : fieldSummary(attachment)
    case 'date_change':
      return str(a.newDate) ?? ''
    case 'deferred_tools_delta':
      return [a.addedNames?.length ? `+${list(a.addedNames)}` : '', a.removedNames?.length ? `-${list(a.removedNames)}` : ''].filter(Boolean).join(' ')
    case 'mcp_instructions_delta':
      return [a.addedNames?.length ? `+${list(a.addedNames)}` : '', a.removedNames?.length ? `-${list(a.removedNames)}` : ''].filter(Boolean).join(' ')
    case 'agent_listing_delta':
      return [a.addedTypes?.length ? `+${list(a.addedTypes)}` : '', a.removedTypes?.length ? `-${list(a.removedTypes)}` : ''].filter(Boolean).join(' ')
    case 'critical_system_reminder':
      return str(a.content) ?? ''
    case 'diagnostics':
      return `${Array.isArray(a.files) ? a.files.length : 0} files`
    case 'file':
    case 'already_read_file':
    case 'compact_file_reference':
    case 'pdf_reference':
    case 'directory':
    case 'selected_lines_in_ide':
      return str(a.displayPath) ?? str(a.filename) ?? str(a.path) ?? ''
    case 'edited_text_file':
    case 'edited_image_file':
    case 'opened_file_in_ide':
      return str(a.filename) ?? ''
    case 'token_usage':
    case 'budget_usd':
      return `${a.used ?? '?'} / ${a.total ?? '?'}`
    case 'output_token_usage':
      return `${a.turn ?? '?'} / ${a.budget ?? '∞'}`
    case 'task_status':
      return [str(a.status), str(a.description)].filter(Boolean).join(' · ')
    case 'mcp_resource':
      return [str(a.server), str(a.uri)].filter(Boolean).join(' ')
    case 'command_permissions':
      return list(a.allowedTools)
    case 'max_turns_reached':
      return `${a.turnCount ?? '?'} / ${a.maxTurns ?? '?'}`
    case 'agent_mention':
      return str(a.agentType) ?? ''
    case 'output_style':
      return str(a.style) ?? ''
    case 'teammate_mailbox':
      return `${Array.isArray(a.messages) ? a.messages.length : 0} messages`
    case 'team_context':
      return [str(a.teamName), str(a.agentName)].filter(Boolean).join(' · ')
    case 'queued_command':
      return contentPreview(a.prompt)
    default:
      return firstStringField(attachment) || fieldSummary(attachment)
  }
}

type Turn = { value: number }

/** Project one page of transcript records into ledger rows in file order. */
export function projectTrajectoryRows(entries: ProjectionEntry[], options: ProjectionOptions): TrajectoryRow[] {
  const rows: TrajectoryRow[] = []
  const assistants = new Map<string, TrajectoryRow>()
  const tools = new Map<string, TrajectoryRow>()
  const turn: Turn = { value: options.turnBase ?? 0 }
  const firstOffset = entries[0]?.byteStart
  // Timestamps of projected records seen so far (file order), seeded with
  // the records right before this page; only the tail is ever consulted.
  const recent = [...(options.precedingTimestamps ?? [])].slice(-START_TS_LOOKBACK)
  let previous: ProjectionEntry | undefined

  const push = (row: TrajectoryRow) => { rows.push(row); return row }
  const remember = (ts: string) => {
    if (!ts) return
    recent.push(ts)
    if (recent.length > START_TS_LOOKBACK * 2) recent.splice(0, recent.length - START_TS_LOOKBACK)
  }
  const patchTool = (toolUseId: string, ts: string, loc: TrajectoryLoc, patch: Partial<TrajectoryRow>) => {
    const existing = tools.get(toolUseId)
    if (existing) {
      Object.assign(existing, patch)
      existing.loc.push(loc)
    } else {
      // The call itself is on an older page (or was never recorded).
      tools.set(toolUseId, push({ id: `t:${toolUseId}`, kind: 'tool', turn: turn.value, ts, preview: '', loc: [loc], partial: true, toolUseId, ...patch }))
    }
  }

  for (const item of entries) {
    const { entry } = item
    if (isProjectionSkipped(entry, options.skipSidechain)) continue
    const loc: TrajectoryLoc = [item.byteStart, item.byteEnd]
    const ts = str(entry.timestamp) ?? ''
    const uuid = str(entry.uuid) ?? `@${item.byteStart}`
    const prior = previous
    previous = item

    if (item.oversizedBytes !== undefined) {
      // Only the line head was read: attach the omitted result to its call.
      const toolUseIds = Array.isArray(entry.toolUseIds) ? entry.toolUseIds.filter((id): id is string => typeof id === 'string') : []
      if (entry.type === 'user') {
        for (const toolUseId of toolUseIds) {
          patchTool(toolUseId, ts, loc, { resultOmittedBytes: item.oversizedBytes, ...(ts ? { resultTs: ts } : {}) })
        }
      }
      remember(ts)
      continue
    }

    if (entry.type === 'user') {
      const message = isRecord(entry.message) ? entry.message : undefined
      if (!message) { remember(ts); continue }
      const content = message.content
      const results = Array.isArray(content) ? content.filter((block): block is Rec => isRecord(block) && block.type === 'tool_result') : []
      if (results.length) {
        const toolUseResult = isRecord(entry.toolUseResult) ? entry.toolUseResult : undefined
        for (const block of results) {
          const toolUseId = str(block.tool_use_id)
          if (!toolUseId) continue
          const text = resultText(block.content)
          const agentId = str(toolUseResult?.agentId) ?? extractAgentIdFromText(text)
          patchTool(toolUseId, ts, loc, {
            resultPreview: toolResultPreview(block.content, text),
            resultTs: ts,
            ...(block.is_error === true ? { isError: true } : {}),
            ...(agentId ? { agentId } : {}),
          })
        }
        // A record carrying only tool results has no row of its own.
        if (results.length === (content as unknown[]).length) { remember(ts); continue }
      }
      if (isRealUserPrompt(entry)) {
        turn.value++
        const text = firstText(content)
        const delivered = sessionMessage(content)
        if (delivered) {
          push({ id: `u:${uuid}`, kind: 'user', turn: turn.value, ts, label: 'session_message', loc: [loc],
            preview: previewText(delivered.from ? `${delivered.from}: ${delivered.text}` : delivered.text) })
        } else if (text.startsWith('<command-name>')) {
          push({ id: `u:${uuid}`, kind: 'user', turn: turn.value, ts, label: 'command', preview: previewText(commandText(text)), loc: [loc] })
        } else {
          push({ id: `u:${uuid}`, kind: 'user', turn: turn.value, ts, preview: contentPreview(content), loc: [loc] })
        }
        remember(ts)
        continue
      }
      const text = firstText(content)
      // Injected records: skills / meta / compact summary, plus non-prompt
      // user records (interruptions, task notifications, command output).
      const label = entry.isCompactSummary === true ? 'summary'
        : entry.isMeta === true ? (text.startsWith(SKILL_PREFIX) ? 'skill' : 'meta')
          : isInterruption(content) ? 'interrupted'
            : isTaskNotification(content) ? 'task_notification'
              : LOCAL_COMMAND_OUTPUT_RE.test(text) ? 'command_output' : 'meta'
      push({ id: `c:${uuid}`, kind: 'context', turn: turn.value, ts, label, loc: [loc],
        preview: label === 'command_output' ? previewText(commandText(text)) : contentPreview(content) })
      remember(ts)
      continue
    }

    if (entry.type === 'assistant') {
      const message = isRecord(entry.message) ? entry.message : {}
      const messageId = str(message.id) ?? uuid
      const content = Array.isArray(message.content) ? message.content.filter(isRecord) : []
      const text = content.find(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim())
      const thinking = content.some(block => block.type === 'thinking' || block.type === 'redacted_thinking')
      const stopReason = str(message.stop_reason)
      const isError = entry.isApiErrorMessage === true || entry.error !== undefined
      const usage = isForkInherited(entry) ? undefined : mapUsage(message.usage)
      let row = assistants.get(messageId)
      if (!row) {
        const startTs = ts ? startTimestamp(recent, ts) : undefined
        row = push({
          id: `a:${messageId}`, kind: 'assistant', turn: turn.value, ts, endTs: ts,
          preview: text ? previewText(stripMarkdown(String(text.text))) : '', loc: [loc], messageId, toolOnly: !text, hasThinking: thinking,
          ...(str(message.model) ? { model: str(message.model) } : {}),
          ...(str(entry.requestId) ? { requestId: str(entry.requestId) } : {}),
          ...(usage ? { usage } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(isError ? { isError: true } : {}),
          ...(startTs ? { startTs } : {}),
        })
        // A response that opens the page (below the file head) may have
        // earlier block lines on the previous page; the client merges by id.
        if (!prior && (firstOffset ?? 0) > 0) row.partial = true
        assistants.set(messageId, row)
      } else {
        row.loc.push(loc)
        row.endTs = ts
        if (text) {
          if (!row.preview) row.preview = previewText(stripMarkdown(String(text.text)))
          row.toolOnly = false
        }
        if (thinking) row.hasThinking = true
        if (stopReason) row.stopReason = stopReason
        if (isError) row.isError = true
        if (!row.requestId && str(entry.requestId)) row.requestId = str(entry.requestId)
        if (!row.model && str(message.model)) row.model = str(message.model)
        const merged = mergeUsage(row.usage, usage)
        if (merged) row.usage = merged
      }
      for (const block of content) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue
        const existing = tools.get(block.id)
        const name = str(block.name) ?? ''
        const inputSummary = toolInputSummary(name, block.input)
        const fields: Partial<TrajectoryRow> = {
          toolName: name, toolUseId: block.id, parentId: `a:${messageId}`,
          inputPreview: compactJson(block.input), preview: name,
          ...(inputSummary ? { inputSummary } : {}),
        }
        if (existing) {
          Object.assign(existing, fields)
          existing.loc.unshift(loc)
          existing.ts = ts
        } else {
          tools.set(block.id, push({ id: `t:${block.id}`, kind: 'tool', turn: turn.value, ts, loc: [loc], ...fields } as TrajectoryRow))
        }
      }
      remember(ts)
      continue
    }

    remember(ts)
    if (entry.type === 'attachment') {
      const attachment = isRecord(entry.attachment) ? entry.attachment : undefined
      if (!attachment) continue
      const type = String(attachment.type ?? 'unknown')
      if (type === 'queued_command' && attachment.isMeta !== true &&
        (attachment.commandMode === undefined || attachment.commandMode === 'prompt')) {
        push({ id: `u:${uuid}`, kind: 'user', turn: turn.value, ts, label: 'queued', preview: contentPreview(attachment.prompt), loc: [loc] })
        continue
      }
      push({ id: `c:${uuid}`, kind: 'context', turn: turn.value, ts, label: type, attachmentType: type,
        preview: previewText(attachmentPreview(attachment)), loc: [loc] })
      continue
    }

    if (entry.type === 'system') {
      const subtype = str(entry.subtype)
      if (subtype === 'compact_boundary' || subtype === 'microcompact_boundary') {
        const meta = isRecord(entry.compactMetadata) ? entry.compactMetadata
          : isRecord(entry.microcompactMetadata) ? entry.microcompactMetadata : undefined
        const parts = [meta ? str(meta.trigger) : undefined, meta && typeof meta.preTokens === 'number' ? `${meta.preTokens} tokens` : undefined].filter(Boolean)
        push({ id: `m:${uuid}`, kind: 'compact', turn: turn.value, ts, label: subtype, preview: parts.join(' · ') || previewText(str(entry.content) ?? ''), loc: [loc] })
      } else if (subtype === 'api_error') {
        const { label, preview } = apiErrorRow(entry)
        push({ id: `c:${uuid}`, kind: 'context', turn: turn.value, ts, label, preview: previewText(preview), loc: [loc],
          ...(label === 'api_error' ? { isError: true } : {}) })
      } else if (subtype === 'stop_hook_summary') {
        const failed = Array.isArray(entry.hookErrors) && entry.hookErrors.length > 0
        push({ id: `c:${uuid}`, kind: 'context', turn: turn.value, ts, label: 'hook_summary', preview: previewText(hookSummaryPreview(entry)), loc: [loc],
          ...(failed ? { isError: true } : {}) })
      } else if (subtype && !SYSTEM_METRIC_SUBTYPES.has(subtype)) {
        // Every other system record is shown — a new subtype must not vanish silently.
        // Unknown ones keep their subtype as the label.
        const content = systemRecordText(entry)
        push({ id: `c:${uuid}`, kind: 'context', turn: turn.value, ts, label: SYSTEM_CONTEXT_LABELS[subtype] ?? subtype,
          preview: previewText(subtype === 'local_command' ? commandText(content) : content), loc: [loc],
          ...((subtype === 'informational' || !SYSTEM_CONTEXT_LABELS[subtype]) && entry.level === 'error' ? { isError: true } : {}) })
      }
    }
  }

  // Fill a tool call's end time from its result when both are on this page.
  for (const row of tools.values()) {
    if (row.resultTs && row.resultTs !== row.ts) row.endTs = row.resultTs
    else delete row.endTs
  }
  return rows
}
