/**
 * Pure parsing of raw CLI payloads into the shapes the session handler works with.
 *
 * Second cut of `handler.ts`, moved verbatim. Every function here is stateless: none
 * of them touches a module-level container, a service, or the socket registry, which
 * is what makes relocating them a pure move rather than a refactor. They are also the
 * part of the handler most worth testing directly, since a wrong extraction here
 * shows up as a missing or malformed message in the desktop, H5, and IM clients
 * alike.
 */

import type { ServerMessage, StreamingFallbackCause } from './events.js'
import type { SessionTaskNotification } from '../services/sessionService.js'
import {
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import {
  getCommandMetadataDisplayText,
  shouldHideCommandMetadataContent,
} from '../../utils/commandMetadata.js'

export function extractAssistantStreamTextForTitle(cliMsg: any): string | null {
  const event = cliMsg?.event
  if (
    cliMsg?.type !== 'stream_event' ||
    event?.type !== 'content_block_delta' ||
    event.delta?.type !== 'text_delta' ||
    typeof event.delta.text !== 'string'
  ) {
    return null
  }
  return event.delta.text
}

export function extractAssistantMessageTextForTitle(cliMsg: any): string | null {
  if (cliMsg?.type !== 'assistant') return null
  const content = cliMsg.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const typedBlock = block as { type?: unknown; text?: unknown }
      return typedBlock.type === 'text' && typeof typedBlock.text === 'string'
        ? [typedBlock.text]
        : []
    })
    .join('\n')
    .trim()
  return text || null
}

export const ROOT_STREAM_SCOPE = '\u0000root'

export function cliParentToolUseId(cliMsg: any): string | undefined {
  return typeof cliMsg.parent_tool_use_id === 'string' && cliMsg.parent_tool_use_id.length > 0
    ? cliMsg.parent_tool_use_id
    : undefined
}

export function cliStreamScope(cliMsg: any): string {
  return cliParentToolUseId(cliMsg) ?? ROOT_STREAM_SCOPE
}

export function scopedToolUseId(
  parentToolUseId: string | undefined,
  toolUseId: string,
): string {
  if (!parentToolUseId || toolUseId.startsWith(`${parentToolUseId}/`)) {
    return toolUseId
  }
  return `${parentToolUseId}/${toolUseId}`
}

export function extractAssistantText(cliMsg: any): string {
  const content = cliMsg?.message?.content
  if (!Array.isArray(content)) return ''
  const textBlock = content.find(
    (block: unknown): block is { type: string; text: string } =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
  return textBlock?.text || ''
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function normalizeAskUserQuestionToolResult(content: unknown, toolUseResult: unknown): unknown {
  const result = readObject(toolUseResult)
  const answers = readObject(result?.answers)
  if (!result || !answers || !Array.isArray(result.questions)) return content
  return {
    questions: result.questions,
    answers,
  }
}

export function classifyRuntimeErrorCode(message: string, fallbackCode: string): string {
  if (/Tool input generation exceeded/i.test(message)) {
    return 'STREAM_TOOL_INPUT_DURATION'
  }
  if (/Stream max duration exceeded/i.test(message)) {
    return 'STREAM_MAX_DURATION'
  }
  if (
    /Provider stream stalled after partial response/i.test(message) ||
    /Stream idle timeout/i.test(message)
  ) {
    return 'STREAM_IDLE_TIMEOUT'
  }
  return fallbackCode
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeRetryCount(value: unknown): number | null {
  const numeric = finiteNumber(value)
  if (numeric === null) return null
  return Math.max(0, Math.trunc(numeric))
}

function readRetryErrorRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readRetryErrorString(value: unknown, keys: string[]): string | undefined {
  const record = readRetryErrorRecord(value)
  if (!record) return undefined
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

export function toApiRetryServerMessage(cliMsg: any): ServerMessage | null {
  const attempt = normalizeRetryCount(cliMsg.attempt)
  const maxRetries = normalizeRetryCount(cliMsg.max_retries)
  const retryDelayMs = normalizeRetryCount(cliMsg.retry_delay_ms)
  if (attempt === null || maxRetries === null || retryDelayMs === null) return null

  const embeddedError = readRetryErrorRecord(cliMsg.error)
  const embeddedStatus = embeddedError ? finiteNumber(embeddedError.status) : null
  const rawStatus = cliMsg.error_status === null
    ? null
    : finiteNumber(cliMsg.error_status) ?? embeddedStatus
  const errorType = typeof cliMsg.error === 'string' && cliMsg.error.trim()
    ? cliMsg.error.trim()
    : readRetryErrorString(cliMsg.error, ['type', 'code', 'name'])
  const errorMessage = readRetryErrorString(cliMsg.error, ['message', 'error'])

  return {
    type: 'api_retry',
    attempt,
    maxRetries,
    retryDelayMs,
    errorStatus: rawStatus === null ? null : Math.trunc(rawStatus),
    ...(errorType ? { errorType } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  }
}

const STREAMING_FALLBACK_CAUSES: ReadonlySet<StreamingFallbackCause> = new Set([
  'watchdog',
  'stream_error',
  '404_stream_creation',
  'stream_retry',
])

export function toStreamingFallbackServerMessage(cliMsg: any): ServerMessage {
  // 未识别的 cause 兜底为 unknown 而不是丢消息：提示本身比成因重要。
  const cause: StreamingFallbackCause =
    typeof cliMsg.cause === 'string' && STREAMING_FALLBACK_CAUSES.has(cliMsg.cause as StreamingFallbackCause)
      ? (cliMsg.cause as StreamingFallbackCause)
      : 'unknown'
  return { type: 'streaming_fallback', cause }
}

export function extractLocalCommandOutput(
  content: unknown,
  options: { allowUntagged?: boolean } = {},
): string | null {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' ? [text] : []
        })
        .join('\n')
      : ''

  if (!raw) return null

  const stdout = extractTaggedContent(raw, LOCAL_COMMAND_STDOUT_TAG)
  if (stdout !== null) return stdout

  const stderr = extractTaggedContent(raw, LOCAL_COMMAND_STDERR_TAG)
  if (stderr !== null) return stderr

  if (options.allowUntagged) {
    const normalized = raw.trim()
    return normalized || null
  }

  return null
}

export function isCompactLocalCommandOutput(output: string): boolean {
  return output.trim() === 'Compacted'
}

function extractTaggedContent(raw: string, tag: string): string | null {
  const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match?.[1]?.trim() ?? null
}

export function extractLocalCommand(content: unknown): { name: string; args: string } | null {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' ? [text] : []
        })
        .join('\n')
      : ''

  const name = extractTaggedContent(raw, COMMAND_NAME_TAG)
  if (!name) return null
  return {
    name: name.replace(/^\//, ''),
    args: extractTaggedContent(raw, 'command-args') ?? '',
  }
}

type GoalEventData = {
  action: 'created' | 'replaced' | 'status' | 'paused' | 'resumed' | 'completed' | 'cleared' | 'message'
  status?: string
  objective?: string
  budget?: string
  elapsed?: string
  continuations?: string
  message?: string
}

export function extractGoalEvent(
  output: string,
  command?: { name: string; args: string },
): GoalEventData | null {
  if (command && command.name !== 'goal') return null

  const trimmed = output.trim()
  if (!trimmed) return null

  if (trimmed === 'Goal cleared.' || trimmed.startsWith('Goal cleared:')) {
    return { action: 'cleared', message: trimmed }
  }
  if (trimmed === 'Goal marked complete.') {
    return { action: 'completed', message: trimmed }
  }
  if (trimmed === 'No active goal.') {
    return { action: 'message', message: trimmed }
  }
  if (trimmed.startsWith('Goal continuing:')) {
    return {
      action: 'status',
      status: 'continuing',
      message: trimmed,
    }
  }

  if (trimmed.startsWith('Goal set:')) {
    const objective = trimmed.slice('Goal set:'.length).trim()
    return {
      action: 'created',
      status: 'active',
      objective: objective || undefined,
      message: trimmed,
    }
  }

  return command?.name === 'goal' ? { action: 'message', message: trimmed } : null
}

export function looksLikeGoalCommandOutput(output: string): boolean {
  const trimmed = output.trim()
  return (
    trimmed.startsWith('Goal set:') ||
    trimmed.startsWith('Goal continuing:') ||
    trimmed.startsWith('Goal cleared:') ||
    trimmed === 'Goal cleared.' ||
    trimmed === 'Goal marked complete.' ||
    trimmed === 'No active goal.'
  )
}

export function getCompactBoundaryMessage(cliMsg: any): string {
  const message = typeof cliMsg?.message === 'string' ? cliMsg.message.trim() : ''
  if (message) return message

  const content = typeof cliMsg?.content === 'string' ? cliMsg.content.trim() : ''
  if (content) return content

  return 'Context compacted'
}

export function isCompactSummaryMessageContent(content: unknown): content is string {
  return (
    typeof content === 'string' &&
    content.trim().startsWith(
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
    )
  )
}

function hasToolResultBlock(content: unknown): boolean {
  return Array.isArray(content) &&
    content.some((block) =>
      Boolean(block) &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_result')
}

export function extractReplayUserText(cliMsg: any): string | null {
  if (cliMsg?.isReplay !== true) return null
  const content = cliMsg.message?.content
  const commandDisplayText = getCommandMetadataDisplayText(content)
  if (commandDisplayText) return commandDisplayText
  if (shouldHideCommandMetadataContent(content)) return null
  if (isCompactSummaryMessageContent(content)) return null
  if (hasToolResultBlock(content)) return null
  if (extractLocalCommandOutput(content)) return null

  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const typedBlock = block as { type?: unknown; text?: unknown }
          return typedBlock.type === 'text' && typeof typedBlock.text === 'string'
            ? [typedBlock.text]
            : []
        })
        .join('\n')
      : ''

  const trimmed = text.trim()
  return trimmed || null
}

export function normalizeCliTaskNotification(cliMsg: any): SessionTaskNotification | null {
  if (cliMsg?.type !== 'system' || cliMsg.subtype !== 'task_notification') return null
  const toolUseId = typeof cliMsg.tool_use_id === 'string' && cliMsg.tool_use_id
    ? cliMsg.tool_use_id
    : null
  const rawStatus = cliMsg.status
  const status = rawStatus === 'killed' ? 'stopped' : rawStatus
  if (
    !toolUseId ||
    (status !== 'completed' && status !== 'failed' && status !== 'stopped')
  ) {
    return null
  }

  const optionalString = (value: unknown) =>
    typeof value === 'string' && value ? value : undefined
  return {
    taskId: optionalString(cliMsg.task_id) ?? toolUseId,
    toolUseId,
    ...(optionalString(cliMsg.owner_agent_id)
      ? { ownerAgentId: optionalString(cliMsg.owner_agent_id) }
      : {}),
    status,
    ...(optionalString(cliMsg.workflow_run_id)
      ? { workflowRunId: optionalString(cliMsg.workflow_run_id) }
      : {}),
    ...(optionalString(cliMsg.summary) ? { summary: optionalString(cliMsg.summary) } : {}),
    ...(optionalString(cliMsg.result) ? { result: optionalString(cliMsg.result) } : {}),
    ...(optionalString(cliMsg.output_file) ? { outputFile: optionalString(cliMsg.output_file) } : {}),
    timestamp: optionalString(cliMsg.timestamp) ?? new Date().toISOString(),
  }
}
