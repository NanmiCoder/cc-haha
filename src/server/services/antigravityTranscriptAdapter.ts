/**
 * AntigravityTranscriptAdapter — Read-only parser for Antigravity CLI transcripts
 * and subagent registries persisted under `<appDataDir>/brain/<conversationId>/`.
 *
 * Strictly read-only: NEVER writes to or mutates `~/.gemini/antigravity-cli/`
 * or `~/.gemini/antigravity/`.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MessageEntry, MessageUsage } from './sessionService.js'

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity-acp'

const DEFAULT_MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024 // 16 MiB safety bound
const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,256}$/

export type AntigravityAdapterOptions = {
  appDataDir?: string
  maxBytes?: number
  signal?: AbortSignal
}

export type AntigravityTranscriptUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  totalTokens?: number
}

export type AntigravityTranscriptStatus = 'running' | 'completed' | 'failed' | 'unknown'

export type AntigravityTranscriptResult = {
  conversationId: string
  filePath: string
  exists: boolean
  messages: MessageEntry[]
  usage?: AntigravityTranscriptUsage
  model?: string
  effort?: string
  status: AntigravityTranscriptStatus
  finalResult?: string
  updatedAt?: string
  truncated: boolean
  historyComplete: boolean
  skippedLines: number
  fileSize: number
  ctimeMs: number
}

export type AntigravitySubagentRecord = {
  conversationId: string
  typeName?: string
  role?: string
  state?: string
  spawnStepIndex?: number
  workspaceUris: string[]
}

export type AntigravityParentSpawnRef = {
  conversationId: string
  role?: string
  typeName?: string
  prompt?: string
  stepIndex: number
  logAbsoluteUri?: string
}

type RawToolCall = {
  id?: unknown
  call_id?: unknown
  name?: unknown
  args?: unknown
  arguments?: unknown
}

type RawTranscriptStep = {
  step_index?: unknown
  source?: unknown
  type?: unknown
  status?: unknown
  created_at?: unknown
  updated_at?: unknown
  content?: unknown
  thinking?: unknown
  thought?: unknown
  model?: unknown
  input_tokens?: unknown
  cache_read_tokens?: unknown
  output_tokens?: unknown
  tool_calls?: unknown
  error?: unknown
}

export function resolveAntigravityAppDataDir(override?: string): string {
  const configured = override?.trim()
    || process.env.ANTIGRAVITY_APP_DATA_DIR?.trim()
    || process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR?.trim()
  if (configured) return path.resolve(configured)
  return path.join(os.homedir(), '.gemini', 'antigravity-cli')
}

export function isSafeAntigravityId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CONVERSATION_ID_RE.test(value)
}

export function antigravityBrainDir(
  conversationId: string,
  appDataDir?: string,
): string | null {
  if (!isSafeAntigravityId(conversationId)) return null
  return path.join(resolveAntigravityAppDataDir(appDataDir), 'brain', conversationId)
}

export function antigravityTranscriptPath(
  conversationId: string,
  appDataDir?: string,
): string | null {
  const brainDir = antigravityBrainDir(conversationId, appDataDir)
  if (!brainDir) return null
  return path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function normalizeAntigravityTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const trimmed = value.trim()
  // Handle "YYYY-MM-DD HH:MM:SS" (seen in board.jsonl) as well as ISO-8601
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)
    ? trimmed.replace(' ', 'T')
    : trimmed
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) return undefined
  return new Date(parsed).toISOString()
}

export function parseAntigravityModelEffort(model: string | undefined): string | undefined {
  if (!model) return undefined
  const match = model.match(/-(xhigh|high|medium|low)$/i)
  return match?.[1]?.toLowerCase()
}

/**
 * Antigravity `transcript.jsonl` stores `tool_calls[].args` values as
 * JSON-encoded strings (e.g. `"\"ls -la\""`, `"5000"`, `"true"`). Decode them
 * safely back into structured values while falling back to raw strings.
 */
export function decodeAntigravityToolArgs(rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs)
      if (isRecord(parsed)) return decodeAntigravityToolArgs(parsed)
    } catch {
      return { raw: rawArgs }
    }
    return { raw: rawArgs }
  }
  if (!isRecord(rawArgs)) return {}
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawArgs)) {
    if (typeof value === 'string') {
      try {
        decoded[key] = JSON.parse(value)
      } catch {
        decoded[key] = value
      }
    } else {
      decoded[key] = value
    }
  }
  return decoded
}

/**
 * Extract the inner payload from Antigravity `<SYSTEM_MESSAGE>` envelopes:
 * `[Message] timestamp=... sender=... priority=... content=<payload>`
 */
function parseSystemMessageEnvelope(content: string): {
  isEnvelope: boolean
  sender?: string
  body: string
  isSwarmBoardNudge: boolean
} {
  const tagMatch = content.match(/<SYSTEM_MESSAGE>\s*(\[Message\][\s\S]*?)\s*<\/SYSTEM_MESSAGE>/)
    ?? content.match(/(?:^|\n)<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/)
  if (!tagMatch?.[1]) {
    return { isEnvelope: false, body: content, isSwarmBoardNudge: false }
  }
  const inner = tagMatch[1].trim()
  const messageMatch = inner.match(/^\[Message\]\s+[^\n]*?\bsender=([^\s]+)\s+[^\n]*?\bcontent=([\s\S]*)$/)
  if (!messageMatch) {
    return { isEnvelope: true, body: inner, isSwarmBoardNudge: inner.includes('[swarm] new board message') }
  }
  const sender = messageMatch[1]
  const body = (messageMatch[2] ?? '').trim()
  const isSwarmBoardNudge = body.startsWith('[swarm] new board message')
  return { isEnvelope: true, sender, body, isSwarmBoardNudge }
}

function looksLikeErrorStep(step: RawTranscriptStep, content: string): boolean {
  const status = typeof step.status === 'string' ? step.status.toUpperCase() : ''
  if (status === 'ERROR' || status === 'FAILED' || status === 'CANCELLED') return true
  if (step.error) return true
  if (/\bCommand exited with code [1-9]\d*\./.test(content)) return true
  return false
}

function deriveTranscriptStatus(lastStep: RawTranscriptStep | undefined): AntigravityTranscriptStatus {
  if (!lastStep) return 'unknown'
  const status = typeof lastStep.status === 'string' ? lastStep.status.toUpperCase() : ''
  if (status === 'RUNNING' || status === 'PENDING' || status === 'IN_PROGRESS' || status === 'WAITING') {
    return 'running'
  }
  if (status === 'ERROR' || status === 'FAILED') return 'failed'
  if (status === 'DONE' || status === 'COMPLETED' || status === 'SUCCESS') return 'completed'
  return 'unknown'
}

export type ParsedAntigravityTranscriptBuffer = Omit<
  AntigravityTranscriptResult,
  'filePath' | 'exists' | 'fileSize' | 'ctimeMs'
>

/**
 * Pure parser for Antigravity `transcript.jsonl` content.
 * Tolerates blank, partial (mid-write), and corrupt JSONL lines.
 */
export function parseAntigravityTranscriptContent(
  conversationId: string,
  text: string,
  options: { truncated?: boolean; historyComplete?: boolean } = {},
): ParsedAntigravityTranscriptBuffer {
  const messages: MessageEntry[] = []
  const pendingToolCalls: Array<{ id: string; name: string }> = []
  const idPrefix = conversationId.slice(0, 8) || 'agy'

  let skippedLines = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let hasUsage = false
  let latestModel: string | undefined
  let latestTimestamp: string | undefined
  let finalResult: string | undefined
  let lastStep: RawTranscriptStep | undefined
  let fallbackIndex = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      skippedLines += 1
      continue
    }
    if (!isRecord(parsed)) {
      skippedLines += 1
      continue
    }

    const step = parsed as RawTranscriptStep
    lastStep = step
    const stepIndex = finiteNumber(step.step_index) ?? fallbackIndex
    fallbackIndex = stepIndex + 1

    const timestamp = normalizeAntigravityTimestamp(step.created_at)
      ?? normalizeAntigravityTimestamp(step.updated_at)
      ?? latestTimestamp
      ?? new Date(0).toISOString()
    if (!latestTimestamp || Date.parse(timestamp) >= Date.parse(latestTimestamp)) {
      latestTimestamp = timestamp
    }

    const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : ''
    const stepSource = typeof step.source === 'string' ? step.source.toUpperCase() : ''
    const model = nonEmptyString(step.model)
    if (model) latestModel = model

    if (stepType === 'PLANNER_RESPONSE') {
      const stepIn = finiteNumber(step.input_tokens)
      const stepOut = finiteNumber(step.output_tokens)
      const stepCache = finiteNumber(step.cache_read_tokens)
      let usage: MessageUsage | undefined
      if (stepIn !== undefined || stepOut !== undefined || stepCache !== undefined) {
        hasUsage = true
        if (stepIn !== undefined) inputTokens += stepIn
        if (stepOut !== undefined) outputTokens += stepOut
        if (stepCache !== undefined) cacheReadTokens += stepCache
        usage = {
          ...(stepIn !== undefined ? { input_tokens: stepIn } : {}),
          ...(stepOut !== undefined ? { output_tokens: stepOut } : {}),
          ...(stepCache !== undefined ? { cache_read_input_tokens: stepCache } : {}),
        }
      }

      const blocks: Array<Record<string, unknown>> = []
      const thinkingText = nonEmptyString(step.thinking) ?? nonEmptyString(step.thought)
      if (thinkingText) {
        blocks.push({ type: 'thinking', thinking: thinkingText })
      }

      const textBody = nonEmptyString(step.content)
      if (textBody) {
        blocks.push({ type: 'text', text: textBody })
        finalResult = textBody
      }

      const rawToolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : []
      rawToolCalls.forEach((rawTool, toolIndex) => {
        if (!isRecord(rawTool)) return
        const tool = rawTool as RawToolCall
        const name = nonEmptyString(tool.name)
        if (!name) return
        const toolId = nonEmptyString(tool.id)
          ?? nonEmptyString(tool.call_id)
          ?? `ag-${idPrefix}-s${stepIndex}-t${toolIndex}`
        const input = decodeAntigravityToolArgs(tool.args ?? tool.arguments)
        blocks.push({
          type: 'tool_use',
          id: toolId,
          name,
          input,
        })
        pendingToolCalls.push({ id: toolId, name })

        // Antigravity subagents report back via `send_message`, swarm workers via `post_message`.
        if (name === 'send_message' && typeof input.Message === 'string' && input.Message.trim()) {
          finalResult = input.Message.trim()
        } else if (name === 'post_message' && typeof input.text === 'string' && input.text.trim()) {
          finalResult = input.text.trim()
        }
      })

      if (blocks.length > 0) {
        messages.push({
          id: `ag-${idPrefix}-step-${stepIndex}`,
          type: 'assistant',
          content: blocks,
          timestamp,
          ...(model ? { model } : {}),
          ...(usage ? { usage, usageKey: `${conversationId}:${stepIndex}` } : {}),
        })
      }
      continue
    }

    if (stepType === 'GENERIC') {
      const content = typeof step.content === 'string'
        ? step.content
        : step.content !== undefined
          ? JSON.stringify(step.content)
          : ''
      const pending = pendingToolCalls.shift()
      if (pending) {
        const isError = looksLikeErrorStep(step, content)
        messages.push({
          id: `ag-${idPrefix}-step-${stepIndex}`,
          type: 'tool_result',
          content: [{
            type: 'tool_result',
            tool_use_id: pending.id,
            content,
            ...(isError ? { is_error: true } : {}),
          }],
          timestamp,
        })
      } else if (content.trim()) {
        messages.push({
          id: `ag-${idPrefix}-step-${stepIndex}`,
          type: stepSource === 'USER_EXPLICIT' ? 'user' : 'system',
          content,
          timestamp,
        })
      }
      continue
    }

    if (stepType === 'USER_INPUT' || stepSource === 'USER_EXPLICIT') {
      const content = typeof step.content === 'string' ? step.content : ''
      if (content.trim()) {
        messages.push({
          id: `ag-${idPrefix}-step-${stepIndex}`,
          type: 'user',
          content,
          timestamp,
        })
      }
      continue
    }

    if (stepType === 'SYSTEM_MESSAGE') {
      const rawContent = typeof step.content === 'string' ? step.content : ''
      if (!rawContent.trim()) continue
      const parsedEnvelope = parseSystemMessageEnvelope(rawContent)
      if (!parsedEnvelope.body) continue
      // Surface initial subagent/worker assignments as readable user-position prompts,
      // while keeping wakeup nudges as compact system messages.
      const isAssignment = parsedEnvelope.isEnvelope
        && !parsedEnvelope.isSwarmBoardNudge
        && Boolean(parsedEnvelope.sender)
        && parsedEnvelope.sender !== 'system'
      messages.push({
        id: `ag-${idPrefix}-step-${stepIndex}`,
        type: isAssignment ? 'user' : 'system',
        content: parsedEnvelope.body,
        timestamp,
      })
      continue
    }

    // Fallback for any unrecognized future step types carrying content
    const fallbackContent = typeof step.content === 'string' ? step.content : ''
    if (fallbackContent.trim()) {
      messages.push({
        id: `ag-${idPrefix}-step-${stepIndex}`,
        type: stepSource === 'MODEL' ? 'assistant' : 'system',
        content: stepSource === 'MODEL'
          ? [{ type: 'text', text: fallbackContent }]
          : fallbackContent,
        timestamp,
        ...(model ? { model } : {}),
      })
    }
  }

  const usage: AntigravityTranscriptUsage | undefined = hasUsage
    ? {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        totalTokens: inputTokens + outputTokens,
      }
    : undefined

  return {
    conversationId,
    messages,
    ...(usage ? { usage } : {}),
    ...(latestModel ? { model: latestModel } : {}),
    ...(parseAntigravityModelEffort(latestModel) ? { effort: parseAntigravityModelEffort(latestModel) } : {}),
    status: deriveTranscriptStatus(lastStep),
    ...(finalResult ? { finalResult } : {}),
    ...(latestTimestamp ? { updatedAt: latestTimestamp } : {}),
    truncated: options.truncated === true,
    historyComplete: options.historyComplete !== false,
    skippedLines,
  }
}

/**
 * Read a potentially large file safely within `maxBytes`. When the file exceeds
 * `maxBytes`, reads only the trailing slice starting from the next newline so
 * JSONL parsing stays valid and memory usage remains bounded.
 */
async function readBoundedTextFile(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{
  bytes: Buffer
  text: string
  truncated: boolean
  fileSize: number
  ctimeMs: number
  dev: number
  ino: number
} | null> {
  signal?.throwIfAborted()
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile()) return null

  signal?.throwIfAborted()
  if (stat.size <= maxBytes) {
    const bytes = await fs.readFile(filePath)
    return {
      bytes,
      text: bytes.toString('utf8'),
      truncated: false,
      fileSize: stat.size,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
    }
  }

  const startOffset = Math.max(0, stat.size - maxBytes)
  const readLength = stat.size - startOffset
  const handle = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(readLength)
    const { bytesRead } = await handle.read(buf, 0, readLength, startOffset)
    const slice = buf.subarray(0, bytesRead)
    const firstNewline = slice.indexOf(0x0a)
    const aligned = firstNewline >= 0 ? slice.subarray(firstNewline + 1) : slice
    return {
      bytes: aligned,
      text: aligned.toString('utf8'),
      truncated: true,
      fileSize: stat.size,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function readAntigravityTranscript(
  conversationId: string,
  options: AntigravityAdapterOptions = {},
): Promise<AntigravityTranscriptResult | null> {
  const filePath = antigravityTranscriptPath(conversationId, options.appDataDir)
  if (!filePath) return null

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES
  const file = await readBoundedTextFile(filePath, maxBytes, options.signal)
  if (!file) {
    return {
      conversationId,
      filePath,
      exists: false,
      messages: [],
      status: 'unknown',
      truncated: false,
      historyComplete: true,
      skippedLines: 0,
      fileSize: 0,
      ctimeMs: 0,
    }
  }

  const parsed = parseAntigravityTranscriptContent(conversationId, file.text, {
    truncated: file.truncated,
    historyComplete: !file.truncated,
  })
  return {
    ...parsed,
    filePath,
    exists: true,
    fileSize: file.fileSize,
    ctimeMs: file.ctimeMs,
  }
}

export async function readAntigravityTranscriptRaw(
  conversationId: string,
  options: AntigravityAdapterOptions = {},
): Promise<{
  filePath: string
  bytes: Buffer
  text: string
  truncated: boolean
  fileSize: number
  ctimeMs: number
  dev: number
  ino: number
} | null> {
  const filePath = antigravityTranscriptPath(conversationId, options.appDataDir)
  if (!filePath) return null
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES
  const file = await readBoundedTextFile(filePath, maxBytes, options.signal)
  if (!file) return null
  return { filePath, ...file }
}

/**
 * Read `<appDataDir>/brain/<parentConversationId>/.system_generated/subagents/*.json`.
 * This is the authoritative immediate-on-spawn registry for both standalone
 * subagents (`invoke_subagent`) and Swarm workers.
 */
export async function readAntigravitySubagentRegistry(
  parentConversationId: string,
  options: AntigravityAdapterOptions = {},
): Promise<AntigravitySubagentRecord[]> {
  options.signal?.throwIfAborted()
  const brainDir = antigravityBrainDir(parentConversationId, options.appDataDir)
  if (!brainDir) return []

  const subagentsDir = path.join(brainDir, '.system_generated', 'subagents')
  let files: string[]
  try {
    files = await fs.readdir(subagentsDir)
  } catch {
    return []
  }

  const records: AntigravitySubagentRecord[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    options.signal?.throwIfAborted()
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(subagentsDir, file), 'utf8'),
      ) as Record<string, unknown>
      const conversationId = nonEmptyString(raw.conversationId)
        ?? file.replace(/\.json$/, '')
      if (!isSafeAntigravityId(conversationId)) continue
      const descriptor = isRecord(raw.subagentDescriptor) ? raw.subagentDescriptor : null
      const workspaceUris = Array.isArray(raw.workspaceUris)
        ? raw.workspaceUris.filter((u): u is string => typeof u === 'string' && u.length > 0)
        : []
      records.push({
        conversationId,
        ...(nonEmptyString(descriptor?.typeName) ? { typeName: descriptor!.typeName as string } : {}),
        ...(nonEmptyString(descriptor?.role) ? { role: descriptor!.role as string } : {}),
        ...(nonEmptyString(raw.state) ? { state: raw.state as string } : {}),
        ...(finiteNumber(raw.spawnStepIndex) !== undefined ? { spawnStepIndex: raw.spawnStepIndex as number } : {}),
        workspaceUris,
      })
    } catch {
      // Skip malformed or mid-write registry entries
    }
  }

  return records.sort((left, right) => (
    (left.spawnStepIndex ?? Number.MAX_SAFE_INTEGER) - (right.spawnStepIndex ?? Number.MAX_SAFE_INTEGER)
    || left.conversationId.localeCompare(right.conversationId)
  ))
}

/**
 * Fallback discovery: scan parent's Antigravity `transcript.jsonl` for
 * `invoke_subagent` calls followed by a `GENERIC` step containing
 * `conversationId` / `logAbsoluteUri`.
 */
export async function readAntigravityParentSubagentSpawns(
  parentConversationId: string,
  options: AntigravityAdapterOptions = {},
): Promise<AntigravityParentSpawnRef[]> {
  const raw = await readAntigravityTranscriptRaw(parentConversationId, options)
  if (!raw) return []

  const spawns: AntigravityParentSpawnRef[] = []
  const pendingInvocations: Array<{
    role?: string
    typeName?: string
    prompt?: string
    stepIndex: number
  }> = []

  let fallbackIndex = 0
  for (const rawLine of raw.text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const step = parsed as RawTranscriptStep
    const stepIndex = finiteNumber(step.step_index) ?? fallbackIndex
    fallbackIndex = stepIndex + 1
    const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : ''

    if (stepType === 'PLANNER_RESPONSE' && Array.isArray(step.tool_calls)) {
      for (const rawTool of step.tool_calls) {
        if (!isRecord(rawTool)) continue
        const name = nonEmptyString((rawTool as RawToolCall).name)
        if (name !== 'invoke_subagent') continue
        const args = decodeAntigravityToolArgs((rawTool as RawToolCall).args ?? (rawTool as RawToolCall).arguments)
        pendingInvocations.push({
          role: nonEmptyString(args.Role) ?? nonEmptyString(args.role),
          typeName: nonEmptyString(args.TypeName) ?? nonEmptyString(args.typeName),
          prompt: nonEmptyString(args.Prompt) ?? nonEmptyString(args.prompt),
          stepIndex,
        })
      }
      continue
    }

    if (stepType === 'GENERIC' && pendingInvocations.length > 0 && typeof step.content === 'string') {
      const convIdMatch = step.content.match(/"conversationId"\s*:\s*"([A-Za-z0-9_-]+)"/)
        ?? step.content.match(/conversationId\s*[:=]\s*([A-Za-z0-9_-]+)/)
      const logUriMatch = step.content.match(/"logAbsoluteUri"\s*:\s*"([^"]+)"/)
      if (convIdMatch?.[1] && isSafeAntigravityId(convIdMatch[1])) {
        const inv = pendingInvocations.shift()!
        spawns.push({
          conversationId: convIdMatch[1],
          role: inv.role,
          typeName: inv.typeName,
          prompt: inv.prompt,
          stepIndex: inv.stepIndex,
          ...(logUriMatch?.[1] ? { logAbsoluteUri: logUriMatch[1] } : {}),
        })
      }
    }
  }

  return spawns
}
