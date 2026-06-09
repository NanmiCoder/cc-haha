/**
 * projectActivityService — derives a per-project "recent activity" snapshot
 * from existing on-disk state (session JSONL transcripts + git working tree).
 * Powers the desktop welcome screen's "Recent activity" panel so a user
 * opening a new chat can see what the previous session did without paying
 * any LLM tokens to recover the context.
 *
 * Token cost: zero. Everything in here is local file IO + git child
 * processes. The result is rendered in the UI for a human to read; nothing
 * is forwarded to the model unless the user explicitly clicks the
 * "Continue" button on the panel, which prefills (only) a short hand-off
 * paragraph into the composer.
 */

import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { sessionService } from './sessionService.js'
import { getRepositoryContext } from './repositoryLaunchService.js'

const execFileAsync = promisify(execFile)

/** Tools that mutate files on disk — same set the verification gate uses. */
const FILE_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
])

/** Cap on filesEdited list length returned to the client. */
const FILES_EDITED_SAMPLE_LIMIT = 8

/** Cap on the chars of the last user message excerpt returned. */
const LAST_USER_MESSAGE_EXCERPT_MAX = 160

/** Hard cap on JSONL lines we'll scan to keep this fast on huge transcripts. */
const JSONL_SCAN_LINE_LIMIT = 50_000

/** Timeout for each git command — short, since this powers a UI panel. */
const GIT_TIMEOUT_MS = 4_000

export type RecentSessionDerived = {
  sessionId: string
  title: string
  modifiedAt: string
  messageCount: number
  /** Up to ${LAST_USER_MESSAGE_EXCERPT_MAX} chars of the most recent user message. */
  lastUserMessageExcerpt?: string
  /** Total number of distinct files mutated across the whole session. */
  filesEditedCount: number
  /** First N distinct file paths, in order of first appearance. */
  filesEditedSample: string[]
}

export type RecentGitActivity = {
  /** Branch checked out at workDir, or null if not on a branch / detached. */
  branch: string | null
  /** origin/HEAD-derived default branch, or null if unknown. */
  defaultBranch: string | null
  /** Number of local commits ahead of upstream (0 if no upstream / clean). */
  aheadCount: number
  /** Number of behind-upstream commits (mostly informational). */
  behindCount: number
  /** Number of files with uncommitted changes (any state). */
  dirtyCount: number
}

export type RecentActivityResult = {
  hasActivity: boolean
  workDir: string
  /** Latest session for this workDir, if any. */
  lastSession?: RecentSessionDerived
  /** Git working-tree state at workDir, if it's a git repo. */
  git?: RecentGitActivity
}

/**
 * Stream a session JSONL file backwards-friendly: we have to scan
 * forward (JSON Lines is line-based, not seekable record-based without
 * an index), but we keep the lookback cheap by remembering only the
 * latest user-message excerpt and an ordered Set of mutated file paths.
 *
 * Capped at JSONL_SCAN_LINE_LIMIT to avoid pathological transcripts.
 */
async function deriveSessionSummaryFromJsonl(filePath: string): Promise<{
  lastUserMessageExcerpt?: string
  filesEdited: string[]
}> {
  const filesEdited = new Map<string, true>() // ordered Set
  let latestUserText: string | null = null

  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  let scanned = 0
  try {
    for await (const line of lines) {
      if (++scanned > JSONL_SCAN_LINE_LIMIT) break
      const trimmed = line.trim()
      if (!trimmed) continue

      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }

      // Track latest user message text. Skip meta/tool-result-only entries.
      if (entry.type === 'user' && entry.isMeta !== true) {
        const message = entry.message as { role?: string; content?: unknown } | undefined
        if (message?.role === 'user') {
          const text = extractTextFromUserContent(message.content)
          if (text) latestUserText = text
        }
      }

      // Track file-mutating tool uses (regardless of which agent emitted them).
      if (entry.type === 'assistant') {
        const message = entry.message as { content?: unknown } | undefined
        const blocks = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : []
        for (const block of blocks) {
          if (block.type !== 'tool_use') continue
          const toolName = typeof block.name === 'string' ? block.name : ''
          if (!FILE_MUTATING_TOOL_NAMES.has(toolName)) continue
          const input = block.input as { file_path?: unknown; notebook_path?: unknown } | undefined
          const filePathRaw = input?.file_path ?? input?.notebook_path
          if (typeof filePathRaw !== 'string' || !filePathRaw.trim()) continue
          // Insert order is preserved by Map iteration.
          if (!filesEdited.has(filePathRaw)) filesEdited.set(filePathRaw, true)
        }
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  return {
    ...(latestUserText
      ? { lastUserMessageExcerpt: truncateExcerpt(latestUserText) }
      : {}),
    filesEdited: Array.from(filesEdited.keys()),
  }
}

function extractTextFromUserContent(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      const text = (block as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
    }
  }
  if (parts.length === 0) return null
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function truncateExcerpt(text: string): string {
  if (text.length <= LAST_USER_MESSAGE_EXCERPT_MAX) return text
  // Trim mid-word + leave an ellipsis. Keep code-fence-like blocks
  // out by collapsing whitespace before truncation.
  return text.slice(0, LAST_USER_MESSAGE_EXCERPT_MAX - 1).trimEnd() + '…'
}

/**
 * Resolve the workDir to a real path, then read three short git facts
 * (current branch, ahead/behind counts, dirty count). Each runs with
 * its own timeout; failures degrade gracefully — we still return the
 * other facts we did get. Returns undefined if workDir isn't a git repo.
 */
async function deriveGitActivity(workDir: string): Promise<RecentGitActivity | undefined> {
  // Reuse the existing repository service for branch + default branch +
  // dirty-or-not. It's cached, well-tested, and handles edge cases
  // (worktrees, detached HEAD, missing remote) for us.
  const ctx = await getRepositoryContext(workDir)
  if (ctx.state !== 'ok' || !ctx.repoRoot) {
    return undefined
  }

  // ahead/behind vs upstream — best-effort; returns 0/0 if no upstream.
  let aheadCount = 0
  let behindCount = 0
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      { cwd: ctx.repoRoot, timeout: GIT_TIMEOUT_MS },
    )
    // Output: "<behind>\t<ahead>"
    const match = String(stdout).trim().match(/^(\d+)\s+(\d+)$/)
    if (match) {
      behindCount = Number.parseInt(match[1] ?? '0', 10) || 0
      aheadCount = Number.parseInt(match[2] ?? '0', 10) || 0
    }
  } catch {
    // No upstream tracking, or rev-list failed — leave at 0/0.
  }

  // Distinct dirty files. `git status --porcelain` emits one line per file.
  let dirtyCount = 0
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', 'status', '--porcelain'],
      { cwd: ctx.repoRoot, timeout: GIT_TIMEOUT_MS },
    )
    const text = String(stdout)
    if (text.trim().length > 0) {
      dirtyCount = text.split(/\r?\n/).filter((line) => line.length > 0).length
    }
  } catch {
    // Fall through with dirtyCount=0.
  }

  return {
    branch: ctx.currentBranch,
    defaultBranch: ctx.defaultBranch,
    aheadCount,
    behindCount,
    dirtyCount,
  }
}

/**
 * Public API: produce a "recent activity" snapshot for `workDir`.
 *
 * Cheap and idempotent. Safe to call on every welcome-screen render
 * (the SessionService listing has its own short cache, and git
 * commands here are bounded by GIT_TIMEOUT_MS per call).
 *
 * `excludeSessionId` skips a session by id when picking "the latest".
 * Use case: in ActiveSession's empty welcome state, the just-created
 * empty session is itself the most recent — but it has zero messages
 * and isn't useful as "recent activity". Skipping it surfaces the
 * actually-meaningful previous session instead.
 */
export async function getRecentActivity(
  workDir: string,
  options?: { excludeSessionId?: string },
): Promise<RecentActivityResult> {
  if (!workDir || !workDir.trim()) {
    return { hasActivity: false, workDir: workDir ?? '' }
  }

  // When excluding, ask for a few more so we have a real fallback. Always
  // grab a small window so we can also skip empty (messageCount === 0)
  // sessions, which carry no meaningful "what was happening" signal.
  const limit = 8
  const [{ sessions }, git] = await Promise.all([
    sessionService.listSessions({ project: workDir, limit }),
    deriveGitActivity(workDir),
  ])

  const excludeId = options?.excludeSessionId
  const candidate = sessions.find(
    (s) => (!excludeId || s.id !== excludeId) && s.messageCount > 0,
  )

  if (!candidate) {
    return {
      hasActivity: git ? git.dirtyCount > 0 || git.aheadCount > 0 : false,
      workDir,
      ...(git ? { git } : {}),
    }
  }

  const found = await sessionService.findSessionFile(candidate.id)
  let derived: { lastUserMessageExcerpt?: string; filesEdited: string[] } = { filesEdited: [] }
  if (found) {
    try {
      derived = await deriveSessionSummaryFromJsonl(found.filePath)
    } catch {
      // Fall back to empty derived data on parse failure.
    }
  }

  const lastSession: RecentSessionDerived = {
    sessionId: candidate.id,
    title: candidate.title,
    modifiedAt: candidate.modifiedAt,
    messageCount: candidate.messageCount,
    ...(derived.lastUserMessageExcerpt
      ? { lastUserMessageExcerpt: derived.lastUserMessageExcerpt }
      : {}),
    filesEditedCount: derived.filesEdited.length,
    filesEditedSample: derived.filesEdited.slice(0, FILES_EDITED_SAMPLE_LIMIT),
  }

  return {
    hasActivity: true,
    workDir,
    lastSession,
    ...(git ? { git } : {}),
  }
}

/** Test-only: exposed limits so tests can set their own caps. */
export const _PROJECT_ACTIVITY_INTERNALS = {
  FILES_EDITED_SAMPLE_LIMIT,
  LAST_USER_MESSAGE_EXCERPT_MAX,
  JSONL_SCAN_LINE_LIMIT,
}
