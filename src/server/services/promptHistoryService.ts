import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { expandPastedTextRefs } from '../../history.js'
import type { PastedContent } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { readLinesReverse } from '../../utils/fsOperations.js'
import { lock } from '../../utils/lockfile.js'
import { retrievePastedText } from '../../utils/pasteStore.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

export const DEFAULT_PROMPT_HISTORY_LIMIT = 100
export const MAX_PROMPT_HISTORY_LIMIT = 200
const MAX_DISPLAY_LENGTH = 100_000

type StoredPastedContent = {
  id: number
  type: 'text' | 'image'
  content?: string
  contentHash?: string
  mediaType?: string
  filename?: string
}

type HistoryLogEntry = {
  display: string
  pastedContents?: Record<number, StoredPastedContent>
  timestamp?: number
  project?: string
  sessionId?: string
}

export type PromptHistoryItem = {
  display: string
  timestamp: number
  sessionId?: string
}

export type ListPromptHistoryOptions = {
  project?: string
  projectRoot?: string
  sessionId?: string
  limit?: number
  sessionOnly?: boolean
}

export type AppendPromptHistoryInput = {
  display: string
  project?: string
  sessionId?: string
  timestamp?: number
}

function getHistoryFilePath(): string {
  return path.join(getClaudeConfigHomeDir(), 'history.jsonl')
}

function normalizeProjectPath(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return path.resolve(trimmed).normalize('NFC')
}

async function resolveDisplayText(entry: HistoryLogEntry): Promise<string> {
  const rawPasted = entry.pastedContents
  if (!rawPasted || typeof rawPasted !== 'object') {
    return entry.display
  }

  const entries = Object.entries(rawPasted)
  if (entries.length === 0) {
    return entry.display
  }

  const resolvedPasted: Record<number, PastedContent> = {}
  for (const [id, stored] of entries) {
    if (!stored || typeof stored !== 'object' || stored.type !== 'text') continue
    if (typeof stored.content === 'string') {
      resolvedPasted[Number(id)] = {
        id: stored.id ?? Number(id),
        type: 'text',
        content: stored.content,
        mediaType: stored.mediaType,
        filename: stored.filename,
      }
      continue
    }
    if (typeof stored.contentHash === 'string' && stored.contentHash) {
      const content = await retrievePastedText(stored.contentHash)
      if (content) {
        resolvedPasted[Number(id)] = {
          id: stored.id ?? Number(id),
          type: 'text',
          content,
          mediaType: stored.mediaType,
          filename: stored.filename,
        }
      }
    }
  }

  if (Object.keys(resolvedPasted).length === 0) {
    return entry.display
  }
  return expandPastedTextRefs(entry.display, resolvedPasted)
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_PROMPT_HISTORY_LIMIT
  }
  return Math.max(1, Math.min(Math.floor(limit), MAX_PROMPT_HISTORY_LIMIT))
}

/**
 * Reads prompt history from `<CLAUDE_CONFIG_DIR>/history.jsonl` (shared with the
 * TUI's `src/history.ts`). Current session entries come first (newest-first),
 * followed by other sessions in the same project (newest-first), within the
 * bounded `limit` window — matching the TUI's Up/Down history ordering.
 */
export async function listPromptHistory(
  options: ListPromptHistoryOptions = {},
): Promise<PromptHistoryItem[]> {
  const limit = clampLimit(options.limit)
  const sessionId = options.sessionId?.trim() || undefined
  const sessionOnly = options.sessionOnly === true
  const acceptedProjects = new Set<string>()
  const normalizedProject = normalizeProjectPath(options.project)
  const normalizedProjectRoot = normalizeProjectPath(options.projectRoot)
  if (normalizedProject) acceptedProjects.add(normalizedProject)
  if (normalizedProjectRoot) acceptedProjects.add(normalizedProjectRoot)

  if (sessionOnly && !sessionId) {
    return []
  }

  // Fail closed when neither a project nor a session scope is given so an
  // unscoped request cannot enumerate prompts across every project on disk.
  if (acceptedProjects.size === 0 && !sessionId) {
    return []
  }

  const currentSessionRaw: HistoryLogEntry[] = []
  const otherSessionRaw: HistoryLogEntry[] = []
  const historyPath = getHistoryFilePath()

  try {
    for await (const line of readLinesReverse(historyPath)) {
      let parsed: unknown
      try {
        parsed = jsonParse(line)
      } catch (error) {
        logForDebugging(`Failed to parse prompt history line: ${error}`)
        continue
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const entry = parsed as HistoryLogEntry
      if (typeof entry.display !== 'string' || entry.display.trim().length === 0) continue

      const matchesSession = Boolean(sessionId && entry.sessionId === sessionId)
      if (sessionOnly) {
        if (!matchesSession) continue
      } else if (acceptedProjects.size > 0) {
        const entryProject = typeof entry.project === 'string'
          ? normalizeProjectPath(entry.project)
          : null
        const matchesProject = Boolean(entryProject && acceptedProjects.has(entryProject))
        if (!matchesSession && !matchesProject) continue
      } else if (sessionId) {
        if (!matchesSession) continue
      }

      if (matchesSession) {
        currentSessionRaw.push(entry)
      } else {
        otherSessionRaw.push(entry)
      }

      if (currentSessionRaw.length + otherSessionRaw.length >= limit) {
        break
      }
    }
  } catch (error: unknown) {
    if (getErrnoCode(error) === 'ENOENT') {
      return []
    }
    throw error
  }

  const ordered = [...currentSessionRaw, ...otherSessionRaw].slice(0, limit)
  const items: PromptHistoryItem[] = []
  for (const entry of ordered) {
    const display = await resolveDisplayText(entry)
    if (!display.trim()) continue
    items.push({
      display,
      timestamp: typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : 0,
      ...(typeof entry.sessionId === 'string' && entry.sessionId ? { sessionId: entry.sessionId } : {}),
    })
  }
  return items
}

/**
 * Appends a desktop prompt submission to `<CLAUDE_CONFIG_DIR>/history.jsonl`
 * using the exact entry schema read by the TUI (`src/history.ts`) so desktop
 * and TUI share prompt recall history.
 */
export async function appendPromptHistory(input: AppendPromptHistoryInput): Promise<void> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)) {
    return
  }

  const display = input.display.trimEnd()
  if (!display.trim()) {
    return
  }

  const cappedDisplay = display.length > MAX_DISPLAY_LENGTH
    ? display.slice(0, MAX_DISPLAY_LENGTH)
    : display

  const project = normalizeProjectPath(input.project) ?? ''
  const sessionId = input.sessionId?.trim() || undefined
  const timestamp = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
    ? input.timestamp
    : Date.now()

  const logEntry: HistoryLogEntry = {
    display: cappedDisplay,
    pastedContents: {},
    timestamp,
    project,
    ...(sessionId ? { sessionId } : {}),
  }

  const historyPath = getHistoryFilePath()
  await mkdir(path.dirname(historyPath), { recursive: true })
  await writeFile(historyPath, '', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'a',
  })

  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(historyPath, {
      stale: 10000,
      retries: {
        retries: 3,
        minTimeout: 50,
      },
    })
    await appendFile(historyPath, `${jsonStringify(logEntry)}\n`, { mode: 0o600 })
  } finally {
    if (release) {
      await release()
    }
  }
}
