import { readFile } from 'node:fs/promises'
import { parseJSONL } from '../../utils/json.js'

const DEFAULT_MAX_SEED_CHARS = 48_000
const RECENT_TOOL_RESULT_MAX_CHARS = 1_200
const OLDER_TOOL_RESULT_MAX_CHARS = 320
const TOOL_ARGS_MAX_CHARS = 240
const RECENT_TAIL_ENTRY_COUNT = 8
const CLOSING_WRAPPER_TAG = '</forked_conversation_history>'

export const ANTIGRAVITY_FORK_SYSTEM_PROMPT_APPEND =
  'When the first user message begins with a <forked_conversation_history> block, treat it as the established prior conversation history from before this branch was forked and continue directly from the latest user request without repeating or mentioning the wrapper.'

type RawContentBlock = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n... [truncated ${omitted} chars]`
}

function escapeClosingWrapperTag(text: string): string {
  return text.includes(CLOSING_WRAPPER_TAG)
    ? text.replaceAll(CLOSING_WRAPPER_TAG, '<\\/forked_conversation_history>')
    : text
}

function summarizeToolInput(input: unknown): string {
  if (!isRecord(input)) return ''
  const preferredKeys = [
    'file_path', 'path', 'Path', 'TargetFile', 'AbsolutePath',
    'command', 'CommandLine', 'pattern', 'Query', 'url', 'prompt',
  ]
  const pairs: string[] = []
  for (const key of preferredKeys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      pairs.push(`${key}=${JSON.stringify(truncateText(value.trim(), 140))}`)
      if (pairs.length >= 2) break
    }
  }
  if (pairs.length > 0) {
    return truncateText(pairs.join(', '), TOOL_ARGS_MAX_CHARS)
  }
  try {
    const serialized = JSON.stringify(input)
    if (!serialized || serialized === '{}') return ''
    return truncateText(serialized, TOOL_ARGS_MAX_CHARS)
  } catch {
    return ''
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (!isRecord(item)) continue
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        parts.push(item.text.trim())
      } else if (item.type === 'image') {
        parts.push('[Image]')
      }
    }
    return parts.join('\n')
  }
  if (isRecord(content)) {
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  return ''
}

function collectFilePath(input: unknown, files: Set<string>): void {
  if (!isRecord(input)) return
  for (const key of ['file_path', 'path', 'Path', 'TargetFile', 'AbsolutePath']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() && value.length <= 512) {
      files.add(value.trim())
    }
  }
}

type RenderedEntry = {
  role: 'user' | 'assistant' | 'tool_result' | 'system'
  text: string
  files: string[]
}

function renderEntry(
  entry: Record<string, unknown>,
  isRecent: boolean,
): RenderedEntry | null {
  if (entry.isSidechain === true || entry.isMeta === true) return null
  const type = entry.type
  if (type !== 'user' && type !== 'assistant' && type !== 'system') return null

  if (type === 'system') {
    if (entry.subtype === 'compact_boundary') {
      return { role: 'system', text: '[Earlier conversation compacted]', files: [] }
    }
    return null
  }

  const message = isRecord(entry.message) ? entry.message : null
  const content = message?.content
  const files = new Set<string>()

  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (!trimmed) return null
    return {
      role: type,
      text: `${type === 'user' ? '[User]' : '[Assistant]'}\n${trimmed}`,
      files: [],
    }
  }

  if (!Array.isArray(content)) return null

  const parts: string[] = []
  let hasToolResult = false
  let hasUserText = false
  const toolResultLimit = isRecent ? RECENT_TOOL_RESULT_MAX_CHARS : OLDER_TOOL_RESULT_MAX_CHARS

  for (const rawBlock of content) {
    if (!isRecord(rawBlock)) continue
    const block = rawBlock as RawContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      if (type === 'user') hasUserText = true
      parts.push(block.text.trim())
    } else if (block.type === 'image') {
      if (type === 'user') hasUserText = true
      parts.push('[Image attached]')
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      collectFilePath(block.input, files)
      const summary = summarizeToolInput(block.input)
      parts.push(summary ? `[Tool call: ${block.name}(${summary})]` : `[Tool call: ${block.name}]`)
    } else if (block.type === 'tool_result') {
      hasToolResult = true
      const status = block.is_error === true ? 'error' : 'ok'
      const resultText = extractToolResultText(block.content)
      if (resultText) {
        parts.push(`[Tool result (${status}): ${truncateText(resultText, toolResultLimit)}]`)
      } else {
        parts.push(`[Tool result (${status})]`)
      }
    }
  }

  if (parts.length === 0) return null

  if (type === 'user' && hasToolResult && !hasUserText) {
    return {
      role: 'tool_result',
      text: parts.join('\n'),
      files: [...files],
    }
  }

  const header = type === 'user' ? '[User]' : '[Assistant]'
  return {
    role: type,
    text: `${header}\n${parts.join('\n')}`,
    files: [...files],
  }
}

function wrapForkHistory(body: string): string {
  return [
    '<forked_conversation_history>',
    'This session was forked from an earlier conversation at a chosen checkpoint.',
    'Continue seamlessly from this prior transcript as established context; do not mention this wrapper unless asked.',
    '',
    escapeClosingWrapperTag(body),
    CLOSING_WRAPPER_TAG,
  ].join('\n')
}

function hasCompactSummaryAfter(entries: Record<string, unknown>[], boundaryIndex: number): boolean {
  for (let i = boundaryIndex + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (entry?.isCompactSummary === true) return true
    // Stop scanning once normal non-meta conversation resumes without a summary entry.
    if ((entry?.type === 'user' || entry?.type === 'assistant') && entry.isMeta !== true) {
      return false
    }
  }
  return false
}

export function buildAntigravityForkSeedContext(
  entries: Record<string, unknown>[],
  options: { maxChars?: number } = {},
): string | undefined {
  const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_SEED_CHARS)

  // Only trim before a compact_boundary when a persisted summary entry follows it.
  // Antigravity `/compact` writes only a boundary marker without a transcript summary,
  // so slicing there would discard all pre-compact history for a fresh `session/new`.
  let startIndex = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type === 'system' && entry.subtype === 'compact_boundary' && hasCompactSummaryAfter(entries, i)) {
      startIndex = i
      break
    }
  }

  const relevant = entries.slice(startIndex)
  const rendered: RenderedEntry[] = []
  for (let i = 0; i < relevant.length; i++) {
    const isRecent = i >= relevant.length - RECENT_TAIL_ENTRY_COUNT
    const item = renderEntry(relevant[i]!, isRecent)
    if (item) rendered.push(item)
  }

  if (rendered.length === 0) return undefined

  const fullBody = rendered.map((item) => item.text).join('\n\n')
  if (fullBody.length <= maxChars) {
    return wrapForkHistory(fullBody)
  }

  if (rendered.length === 1) {
    return wrapForkHistory(truncateText(rendered[0]!.text, maxChars))
  }

  // Budgeted trimming: preserve the opening user goal + the most recent tail,
  // plus a bounded list of referenced files from omitted middle turns.
  const openingBudget = Math.floor(maxChars * 0.18)
  const tailBudget = Math.floor(maxChars * 0.72)

  const openingParts: string[] = []
  let openingChars = 0
  let headCount = 0
  for (let i = 0; i < rendered.length - 1; i++) {
    const item = rendered[i]!
    const candidate = openingParts.length === 0
      ? truncateText(item.text, openingBudget)
      : item.text
    if (openingParts.length > 0 && openingChars + candidate.length + 2 > openingBudget) break
    openingParts.push(candidate)
    openingChars += candidate.length + 2
    headCount = i + 1
    if (item.role === 'assistant' && headCount >= 2) break
  }

  const tailParts: string[] = []
  let tailChars = 0
  let tailStart = rendered.length
  for (let i = rendered.length - 1; i >= headCount; i--) {
    const item = rendered[i]!
    if (tailParts.length === 0 && item.text.length > tailBudget) {
      tailParts.unshift(truncateText(item.text, tailBudget))
      tailChars = tailParts[0]!.length
      tailStart = i
      break
    }
    if (tailChars + item.text.length + 2 > tailBudget) break
    tailParts.unshift(item.text)
    tailChars += item.text.length + 2
    tailStart = i
  }

  const omittedCount = Math.max(0, tailStart - headCount)
  const omittedBudget = Math.max(120, maxChars - openingChars - tailChars - 4)
  const omittedFiles: string[] = []
  const seenFiles = new Set<string>()
  let filesChars = 0
  const maxFileListChars = Math.max(0, omittedBudget - 96)
  for (let i = headCount; i < tailStart && filesChars < maxFileListChars; i++) {
    for (const file of rendered[i]!.files) {
      if (seenFiles.has(file)) continue
      const addition = (omittedFiles.length > 0 ? 2 : 0) + file.length
      if (filesChars + addition > maxFileListChars) break
      seenFiles.add(file)
      omittedFiles.push(file)
      filesChars += addition
      if (omittedFiles.length >= 25) break
    }
    if (omittedFiles.length >= 25) break
  }

  const sections: string[] = []
  if (openingParts.length > 0) {
    sections.push(openingParts.join('\n\n'))
  }
  if (omittedCount > 0) {
    const fileNote = omittedFiles.length > 0
      ? `\nFiles referenced in omitted turns: ${omittedFiles.join(', ')}`
      : ''
    sections.push(`[... ${omittedCount} earlier messages omitted to fit context budget ...${fileNote}]`)
  }
  if (tailParts.length > 0) {
    sections.push(tailParts.join('\n\n'))
  }

  return wrapForkHistory(sections.join('\n\n'))
}

export type LoadAntigravityForkSeedResult =
  | { status: 'loaded'; context: string }
  | { status: 'empty' }
  | { status: 'error'; error: unknown }

export async function loadAntigravityForkSeedContext(
  filePath: string,
  options: { maxChars?: number } = {},
): Promise<LoadAntigravityForkSeedResult> {
  try {
    const content = await readFile(filePath)
    const entries = parseJSONL<Record<string, unknown>>(content)
    const context = buildAntigravityForkSeedContext(entries, options)
    return context ? { status: 'loaded', context } : { status: 'empty' }
  } catch (error) {
    console.warn(`[AntigravityFork] Failed to load fork seed context from ${filePath}:`, error)
    return { status: 'error', error }
  }
}
