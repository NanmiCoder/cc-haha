import { normalizeHistory } from './chat'
import {
  canRestoreCode,
  type Checkpoint,
  type DiffLine,
  type RewindMode,
} from './operations'
import type { HistoryEntry } from './types'
import { plural } from './plural'

/** Consistent with kit FileBadge: M modified, A added, D deleted, R renamed, ? untracked. */
export type BadgeStatus = 'M' | 'A' | 'D' | 'R' | '?'

export const turnNumber = (checkpoint: Checkpoint) =>
  checkpoint.target.userMessageIndex + 1

export function latestCheckpoint(checkpoints: readonly Checkpoint[]) {
  return checkpoints.reduce<Checkpoint | undefined>(
    (result, item) =>
      !result || item.target.userMessageIndex > result.target.userMessageIndex
        ? item
        : result,
    undefined
  )
}

export function checkpointsNewestFirst(checkpoints: readonly Checkpoint[]) {
  return [...checkpoints].sort(
    (a, b) => b.target.userMessageIndex - a.target.userMessageIndex
  )
}

/** When files and stats of the same checkpoint are unchanged, per-file cached diffs remain usable. */
export const checkpointSignature = (checkpoint: Checkpoint) =>
  [
    checkpoint.target.targetUserMessageId,
    checkpoint.code.insertions,
    checkpoint.code.deletions,
    checkpoint.code.filesChanged.join('\u0000'),
  ].join('|')

/** `src/core/a.ts` → Name `a.ts`, directory `src/core/` (directory keeps the trailing slash). */
export function splitPath(path: string) {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.replace(/\/+$/, '').lastIndexOf('/')
  if (index < 0) return { name: normalized, dir: '' }
  return { name: normalized.slice(index + 1), dir: normalized.slice(0, index + 1) }
}

/** Directory for the file preview subtitle, without trailing slash. */
export const parentDir = (path: string) => splitPath(path).dir.replace(/\/$/, '')

export function diffTotals(lines: readonly DiffLine[]) {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'remove') removed++
  }
  return { added, removed }
}

/** File headers (diff --git / --- / +++ / Index:) are already in the page title; keep only content from the hunk on. */
export function visibleDiffLines(lines: readonly DiffLine[]) {
  const first = lines.findIndex((line) => line.kind === 'hunk')
  const body = first < 0 ? lines.filter((line) => line.kind !== 'meta') : lines.slice(first)
  let end = body.length
  while (end > 0 && body[end - 1]!.kind === 'meta' && !body[end - 1]!.text) end--
  return body.slice(0, end)
}

/** The checkpoint only gives the file list; added, deleted and renamed are read from the diff itself. */
export function diffBadge(diff: string | undefined): BadgeStatus {
  if (!diff) return 'M'
  if (/^rename (from|to) /m.test(diff)) return 'R'
  if (/^new file mode /m.test(diff) || /^--- \/dev\/null$/m.test(diff)) return 'A'
  if (/^deleted file mode /m.test(diff) || /^\+\+\+ \/dev\/null$/m.test(diff))
    return 'D'
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
  if (hunks.length === 1) {
    const [, beforeStart, beforeCount, afterStart, afterCount] = hunks[0]!
    if (beforeStart === '0' && beforeCount === '0' && afterStart !== '0') return 'A'
    if (afterStart === '0' && afterCount === '0' && beforeStart !== '0') return 'D'
  }
  return 'M'
}

const workspaceBadges: Record<string, BadgeStatus> = {
  modified: 'M',
  type_changed: 'M',
  unknown: 'M',
  added: 'A',
  copied: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
}
export const workspaceBadge = (status: string): BadgeStatus =>
  workspaceBadges[status] ?? 'M'

const workspaceLabels: Record<string, string> = {
  modified: 'Modified',
  type_changed: 'Type changed',
  added: 'Added',
  copied: 'Copy',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
  unknown: 'Changed',
}
export const workspaceStatusLabel = (status: string) =>
  workspaceLabels[status] ?? 'Changed'

export function formatBytes(size: number | undefined) {
  if (size === undefined || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  const mb = size / (1024 * 1024)
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`
}

/** Breadcrumbs: root (project name) + each directory level, each segment with a navigable relative path. */
export function breadcrumbs(root: string, path: string) {
  const parts = path.split('/').filter(Boolean)
  return [
    { label: root, path: '' },
    ...parts.map((label, index) => ({
      label,
      path: parts.slice(0, index + 1).join('/'),
    })),
  ]
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Today shows only HH:mm, earlier adds the date; the latest turn adds "Latest". */
export function turnTimeLabel(
  startedAt: number | undefined,
  latest: boolean,
  now = new Date()
) {
  const parts: string[] = []
  if (startedAt !== undefined && Number.isFinite(startedAt)) {
    const date = new Date(startedAt)
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    parts.push(
      sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
    )
  }
  if (latest) parts.push('Latest')
  return parts.join(' · ')
}

/** Text of the user message that starts this turn, collapsed into one line; returns undefined when there is no text (only images etc). */
export function checkpointPrompt(
  entries: readonly HistoryEntry[],
  targetUserMessageId: string
) {
  const owned = entries.filter((entry) => entry.id === targetUserMessageId)
  if (!owned.length) return undefined
  const text = normalizeHistory(owned)
    .filter((item) => item.type === 'user')
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
}

const knownReasons: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^Some changed files cannot be compared as UTF-8 text\.?$/, () => 'Some files are not UTF-8 text and cannot be compared.'],
  [/^No transcript file changes were recorded for this turn\.?$/, () => 'No file changes were recorded in this turn.'],
  [/^No file checkpoints were recorded for this session\.?$/, () => 'This session has no file checkpoints recorded.'],
  [/^No file checkpoint is available for the selected message\.?$/, () => 'No usable file checkpoint for this turn.'],
  [/^The checkpoint could not be prepared safely\.?$/, () => 'The checkpoint could not be prepared safely.'],
  [/^Recorded file history is incomplete for: (.+)$/, (m) => `History for these files is incomplete: ${m[1]}`],
  [/^Recorded restore points are incomplete for: (.+)$/, (m) => `Restore points for these files are incomplete: ${m[1]}`],
]

/** Translate checkpoint reasons from the computer into readable text; unknown reasons are kept as is. */
export function translateReason(reason: string | undefined) {
  const text = reason?.trim()
  if (!text) return undefined
  for (const [pattern, render] of knownReasons) {
    const match = pattern.exec(text)
    if (match) return render(match)
  }
  return text
}

export type RewindChoice = {
  mode: RewindMode
  title: string
  description: string
  disabled: boolean
}

const fileCount = (checkpoint: Checkpoint) => checkpoint.code.filesChanged.length
const messageCount = (checkpoint: Checkpoint) =>
  checkpoint.conversation?.messagesRemoved ?? 0

/** Choose one of three rewind scopes; with no recoverable files only "Rewind conversation only" remains, and when code is unrecoverable the first two are disabled. */
export function rewindChoices(preview: Checkpoint): RewindChoice[] {
  const files = fileCount(preview)
  const messages = messageCount(preview)
  const conversation: RewindChoice = {
    mode: 'conversation',
    title: 'Rewind conversation only',
    description: `Delete the ${plural(messages, 'message')} after, files untouched`,
    disabled: false,
  }
  if (!files) return [conversation]
  const disabled = !canRestoreCode(preview)
  return [
    {
      mode: 'both',
      title: 'Code and conversation',
      description: `Restore ${plural(files, 'file')}, delete the ${plural(messages, 'message')} after`,
      disabled,
    },
    {
      mode: 'code',
      title: 'Rewind code only',
      description: `Restore ${plural(files, 'file')}, keep chat history`,
      disabled,
    },
    conversation,
  ]
}

export const defaultRewindMode = (preview: Checkpoint): RewindMode =>
  fileCount(preview) && canRestoreCode(preview) ? 'both' : 'conversation'

/** Risks under the chosen scope that must be stated upfront. */
export function rewindRisks(preview: Checkpoint, mode: RewindMode) {
  const files = fileCount(preview)
  const risks: string[] = []
  if (!files) {
    risks.push('No recoverable files in this turn; only the conversation can be rewound.')
    return risks
  }
  if (!canRestoreCode(preview)) {
    const reason = translateReason(preview.code.reason)
    risks.push(
      `File checkpoint is incomplete; only the conversation can be rewound.${reason ? ` ${reason}` : ''}`
    )
    return risks
  }
  if (mode === 'conversation') return risks
  risks.push(
    `Restoring code overwrites changes to ${files === 1 ? 'this file' : `these ${files} files`} after the checkpoint. If you are also editing on the computer, save first.`
  )
  const sources = preview.unverifiedChangeSources ?? []
  if (sources.length)
    risks.push(
      `Changes by these tools were not fully verified: ${sources.join(', ')}. Rewind only restores files recoverable from the checkpoint; other changes may remain.`
    )
  return risks
}

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif'])
export function isImagePath(path: string) {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension ? imageExtensions.has(extension) : false
}

/** Previous / next file; no wraparound at the ends. */
export function stepPath(paths: readonly string[], current: string, delta: number) {
  const index = paths.indexOf(current)
  if (index < 0) return undefined
  return paths[index + delta]
}

export type PreviewFile = {
  state: string
  content?: string
  dataUrl?: string
  previewType?: string
  error?: string
}

/** Explanation when it cannot be shown on the phone; returns null when it can. */
export function previewFallback(file: PreviewFile) {
  if (file.state === 'ok') {
    if (file.previewType === 'image' && file.dataUrl) return null
    if (file.content !== undefined && file.previewType !== 'image') return null
    return {
      title: 'Open on the computer',
      detail: 'This app supports previewing text, images and code diffs; this file format is not supported yet.',
    }
  }
  const named: Record<string, string> = {
    binary: 'binary file',
    too_large: 'file too large',
    missing: 'file does not exist',
  }
  return {
    title: 'Open on the computer',
    detail:
      file.error ||
      `This file cannot be previewed yet (${named[file.state] ?? file.state})`,
  }
}

/** Explanation when reading the workspace diff fails. */
export function workspaceDiffProblem(result: { state: string; error?: string }) {
  if (result.state === 'ok') return undefined
  if (result.state === 'not_git_repo') return 'This workspace has no Git repository, so changes cannot be compared.'
  if (result.state === 'missing') return 'This file is no longer in the workspace.'
  return result.error || 'Cannot compare this file right now.'
}

export const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Action did not complete, please retry'

/** Project name: prefer the repo name, otherwise the last segment of the working directory. */
export function projectName(status: { repoName?: string | null; workDir?: string } | null) {
  if (status?.repoName) return status.repoName
  const dir = status?.workDir?.replace(/[\\/]+$/, '')
  return dir ? (dir.split(/[\\/]/).pop() ?? '') : ''
}

/** Screen reader text for the in-session changes card: `3 files, 18 lines added, 4 lines deleted`; without add/delete stats only the file count. */
export function changesCardLabel(files: number, insertions: number, deletions: number) {
  return [
    plural(files, 'file'),
    insertions ? `${plural(insertions, 'line')} added` : '',
    deletions ? `${plural(deletions, 'line')} deleted` : '',
  ]
    .filter(Boolean)
    .join(', ')
}
