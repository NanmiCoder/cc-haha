/**
 * Rolling local token aggregation for recent session activity (default 5 hours).
 *
 * Reads only transcript JSONL files whose mtime falls inside the rolling window,
 * reusing the exact deduplication and validity rules in `usageAccounting.ts` so
 * numbers stay consistent with Activity Stats while remaining fast and offline.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { SYNTHETIC_MODEL } from '../../utils/messages.js'
import { getProjectsDir } from '../../utils/sessionStorage.js'
import {
  claimUsageIncrement,
  isBillableUsageRecord,
  usageRecordKey,
  type UsageLedger,
} from '../../utils/usageAccounting.js'

export type RollingModelTokenUsage = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  turnCount: number
}

export type RollingLocalTokenSummary = {
  windowHours: number
  since: string
  until: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turnCount: number
  sessionCount: number
  byModel: RollingModelTokenUsage[]
}

const DEFAULT_WINDOW_HOURS = 5
const MAX_SCAN_FILES = 128
const MAX_FULL_READ_BYTES = 32 * 1024 * 1024
const TAIL_READ_BYTES = 8 * 1024 * 1024

type CandidateFile = {
  filePath: string
  sessionId: string
  mtimeMs: number
  size: number
}

async function collectRecentTranscriptFiles(
  rootDir: string,
  cutoffMs: number,
): Promise<CandidateFile[]> {
  const results: CandidateFile[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || results.length >= MAX_SCAN_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= MAX_SCAN_FILES) break
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try {
        const stat = await fs.stat(fullPath)
        if (stat.mtimeMs < cutoffMs || stat.size <= 0) continue
        results.push({
          filePath: fullPath,
          sessionId: path.basename(entry.name, '.jsonl'),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        })
      } catch {
        // Skip files that disappeared mid-scan.
      }
    }
  }

  await walk(rootDir, 0)
  results.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return results
}

async function readTranscriptContent(
  filePath: string,
  size: number,
  maxFullReadBytes: number,
  tailReadBytes: number,
): Promise<string> {
  if (size <= maxFullReadBytes) {
    return await fs.readFile(filePath, 'utf-8')
  }
  const bytesToRead = Math.min(size, Math.max(1, tailReadBytes))
  const offset = Math.max(0, size - bytesToRead)
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead)
    let totalRead = 0
    while (totalRead < bytesToRead) {
      const { bytesRead } = await handle.read(buffer, totalRead, bytesToRead - totalRead, offset + totalRead)
      if (bytesRead <= 0) break
      totalRead += bytesRead
    }
    const text = buffer.subarray(0, totalRead).toString('utf-8')
    if (offset === 0) return text
    const firstNewline = text.indexOf('\n')
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
  } finally {
    await handle.close()
  }
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export async function aggregateRollingLocalTokens(options: {
  windowHours?: number
  now?: Date
  projectsDir?: string
  maxFullReadBytes?: number
  tailReadBytes?: number
} = {}): Promise<RollingLocalTokenSummary> {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const cutoffMs = nowMs - windowHours * 60 * 60 * 1000
  const projectsDir = options.projectsDir ?? getProjectsDir()
  const maxFullReadBytes = options.maxFullReadBytes ?? MAX_FULL_READ_BYTES
  const tailReadBytes = options.tailReadBytes ?? TAIL_READ_BYTES

  const files = await collectRecentTranscriptFiles(projectsDir, cutoffMs)
  const ledger: UsageLedger = new Map()
  const modelMap = new Map<string, RollingModelTokenUsage>()
  const activeSessions = new Set<string>()

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let turnCount = 0

  for (const candidate of files) {
    let content: string
    try {
      content = await readTranscriptContent(
        candidate.filePath,
        candidate.size,
        maxFullReadBytes,
        tailReadBytes,
      )
    } catch {
      continue
    }

    const lines = content.split('\n')
    for (const rawLine of lines) {
      const trimmed = rawLine.trim()
      if (!trimmed || !trimmed.includes('"usage"')) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      if (parsed.type !== 'assistant') continue
      const timestamp = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN
      if (!Number.isFinite(timestamp) || timestamp < cutoffMs || timestamp > nowMs + 60_000) {
        continue
      }

      const message = parsed.message && typeof parsed.message === 'object'
        ? parsed.message as Record<string, unknown>
        : null
      const usage = message?.usage && typeof message.usage === 'object'
        ? message.usage as Record<string, unknown>
        : null
      if (!usage) continue

      const modelRaw = typeof message?.model === 'string' ? message.model.trim() : ''
      if (modelRaw === SYNTHETIC_MODEL) continue
      const model = modelRaw || 'unknown'

      const identity = {
        version: parsed.version,
        sessionId: parsed.sessionId ?? candidate.sessionId,
        requestId: parsed.requestId,
        messageId: message?.id,
        forkedFrom: parsed.forkedFrom,
      }
      if (!isBillableUsageRecord(identity)) continue

      const key = usageRecordKey(identity)
      const claimed = claimUsageIncrement(ledger, key, {
        inputTokens: finiteNonNegative(usage.input_tokens),
        outputTokens: finiteNonNegative(usage.output_tokens),
        cacheReadInputTokens: finiteNonNegative(usage.cache_read_input_tokens),
        cacheCreationInputTokens: finiteNonNegative(usage.cache_creation_input_tokens),
        webSearchRequests: 0,
      })

      const deltaTotal =
        claimed.delta.inputTokens +
        claimed.delta.outputTokens +
        claimed.delta.cacheReadInputTokens +
        claimed.delta.cacheCreationInputTokens
      if (claimed.isEmpty || deltaTotal <= 0) continue

      const isFirstForKey = claimed.previous === null
      inputTokens += claimed.delta.inputTokens
      outputTokens += claimed.delta.outputTokens
      cacheReadTokens += claimed.delta.cacheReadInputTokens
      cacheCreationTokens += claimed.delta.cacheCreationInputTokens
      if (isFirstForKey) turnCount += 1

      const sessionKey = typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
        ? parsed.sessionId.trim()
        : candidate.sessionId
      activeSessions.add(sessionKey)

      const existing = modelMap.get(model) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        turnCount: 0,
      }
      existing.inputTokens += claimed.delta.inputTokens
      existing.outputTokens += claimed.delta.outputTokens
      existing.cacheReadTokens += claimed.delta.cacheReadInputTokens
      existing.cacheCreationTokens += claimed.delta.cacheCreationInputTokens
      existing.totalTokens += deltaTotal
      if (isFirstForKey) existing.turnCount += 1
      modelMap.set(model, existing)
    }
  }

  const byModel = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens

  return {
    windowHours,
    since: new Date(cutoffMs).toISOString(),
    until: now.toISOString(),
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    turnCount,
    sessionCount: activeSessions.size,
    byModel,
  }
}
