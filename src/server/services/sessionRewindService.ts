import type { UUID } from 'crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { createTwoFilesPatch, diffLines } from 'diff'
import { ApiError } from '../middleware/errorHandler.js'
import { recordedCommandIsReadOnly } from '../../tools/BashTool/readOnlyValidation.js'
import { applyEditToFile } from '../../tools/FileEditTool/utils.js'
import {
  type FileHistorySnapshot,
  readBackupFileSafely,
} from '../../utils/fileHistory.js'
import { conversationService } from './conversationService.js'
import { canonicalizeFilesystemAccessPath } from './filesystemAccessRoots.js'
import { hasMalformedFileHistoryBefore, sessionService, type MessageEntry } from './sessionService.js'
import {
  collectErroredToolUseIds,
  collectSuccessfulToolUseIds,
} from './transcriptToolResults.js'

type RewindTarget = {
  targetUserMessageId: string
  userMessageIndex: number
  userMessageCount: number
  messagesRemoved: number
}

type RewindCodePreview = {
  available: boolean
  reason?: string
  filesChanged: string[]
  insertions: number
  deletions: number
  [fileChangeStats]?: Map<string, FileChangeStats>
}

type FileChangeStats = {
  insertions: number
  deletions: number
  textComparable?: boolean
}

const fileChangeStats = Symbol('fileChangeStats')

type TranscriptFileChange = {
  path: string
  absolutePath: string
  identityPath: string
  additions: number
  deletions: number
  diff?: string
}

type SnapshotTurnCodePreview = {
  preview: RewindCodePreview
  coveredPathIdentities: Set<string>
  restorablePathIdentities: Set<string>
  unrestorablePathIdentities: Set<string>
  restoreAvailable: boolean
}

type TranscriptTurnFileEvidence = {
  confirmedChanges: TranscriptFileChange[]
  uncertainChanges: TranscriptFileChange[]
  /**
   * Tools in this turn whose file effects the transcript cannot describe — a
   * writing shell command, a tool we have no extractor for, a call whose input
   * did not survive. Their changes are only undoable where the file-history
   * snapshot happens to cover them, so this downgrades restore coverage to
   * partial instead of blocking the undo (see mergeTurnCodePreviews).
   */
  unverifiedChangeSources: string[]
}

type MergedTurnCodePreview = {
  preview: RewindCodePreview
  restoreAvailable: boolean
  unverifiedChangeSources: string[]
}

/**
 * What a rewind is allowed to touch.
 *
 * `both` needs a restorable checkpoint and fails loudly without one.
 * `conversation` only trims the transcript, so it stays available for a turn
 * whose files cannot be restored — losing the ability to undo the code should
 * not also cost the user the ability to back out of the prompt.
 */
export type SessionRewindMode = 'both' | 'conversation'

export function parseSessionRewindMode(value: unknown): SessionRewindMode {
  if (value === undefined || value === null) return 'both'
  if (value === 'both' || value === 'conversation') return value
  throw ApiError.badRequest(`Invalid rewind mode: expected 'both' or 'conversation'.`)
}

export type RewindTargetSelector = {
  targetUserMessageId?: string
  userMessageIndex?: number
  expectedContent?: string
}

export type SessionRewindPreview = {
  target: {
    targetUserMessageId: string
    userMessageIndex: number
    userMessageCount: number
  }
  conversation: {
    messagesRemoved: number
  }
  code: RewindCodePreview
  restoreAvailable: boolean
  /**
   * Tool names that may have changed files this checkpoint cannot restore.
   * Empty means the listed files are the whole story; non-empty means undo
   * still works but only covers the files it reports.
   */
  unverifiedChangeSources: string[]
}

export type SessionRewindExecuteResult = SessionRewindPreview & {
  conversation: SessionRewindPreview['conversation'] & {
    removedMessageIds: string[]
  }
  /** What this rewind actually touched, so the client never overstates it. */
  mode: SessionRewindMode
}

export type SessionTurnCheckpointPreview = SessionRewindPreview & {
  workDir: string
  restoreAvailable: boolean
}

export type SessionTurnCheckpointDiffResult = {
  target: SessionRewindPreview['target']
  workDir: string
  path: string
  state: 'ok' | 'missing' | 'error'
  diff?: string
  error?: string
}

function normalizeDiffStats(diffStats: {
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  fileStats?: Map<string, FileChangeStats>
} | undefined): RewindCodePreview {
  const preview: RewindCodePreview = {
    available: true,
    filesChanged: diffStats?.filesChanged ?? [],
    insertions: diffStats?.insertions ?? 0,
    deletions: diffStats?.deletions ?? 0,
  }
  if (diffStats?.fileStats) {
    preview[fileChangeStats] = diffStats.fileStats
    if ([...diffStats.fileStats.values()].some(stats => stats.textComparable === false)) {
      preview.reason = 'Some changed files cannot be compared as UTF-8 text.'
    }
  }
  return preview
}

function normalizePromptText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function extractUserPromptText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const record = block as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
        ? [record.text]
        : []
    })
    .join('\n')
}

function assertExpectedPromptMatches(
  targetMessage: { content: unknown },
  expectedContent: string | undefined,
): void {
  if (expectedContent === undefined) return

  const actual = normalizePromptText(extractUserPromptText(targetMessage.content))
  const expected = normalizePromptText(expectedContent)
  if (actual !== expected) {
    throw ApiError.badRequest(
      'The resolved rewind target does not match the selected prompt. Refresh the session and try again.',
    )
  }
}

async function resolveRewindTarget(
  sessionId: string,
  selector: RewindTargetSelector,
): Promise<RewindTarget> {
  const activeMessages = await sessionService.getSessionMessages(sessionId)
  const userMessages = activeMessages.filter((message) => message.type === 'user')

  if (userMessages.length === 0) {
    throw ApiError.badRequest('This session has no user messages to rewind.')
  }

  let targetUserMessage = null as (typeof userMessages)[number] | null
  let userMessageIndex = -1

  if (selector.targetUserMessageId) {
    const activeMessage = activeMessages.find(
      (message) => message.id === selector.targetUserMessageId,
    )
    if (activeMessage) {
      if (activeMessage.type !== 'user') {
        throw ApiError.badRequest('The selected rewind target is not a user message.')
      }
      targetUserMessage = activeMessage
      userMessageIndex = userMessages.findIndex(
        (message) => message.id === activeMessage.id,
      )
    }
  }

  if (!targetUserMessage && Number.isInteger(selector.userMessageIndex)) {
    userMessageIndex = selector.userMessageIndex!
    if (userMessageIndex >= 0 && userMessageIndex < userMessages.length) {
      targetUserMessage = userMessages[userMessageIndex]!
    }
  }

  if (
    !targetUserMessage ||
    userMessageIndex < 0 ||
    userMessageIndex >= userMessages.length
  ) {
    throw ApiError.badRequest(
      `Invalid rewind target. Expected targetUserMessageId or userMessageIndex 0-${userMessages.length - 1}.`,
    )
  }

  assertExpectedPromptMatches(targetUserMessage, selector.expectedContent)

  const activeMessageIndex = activeMessages.findIndex(
    (message) => message.id === targetUserMessage.id,
  )

  if (activeMessageIndex < 0) {
    throw ApiError.badRequest('The selected user message is not in the active chain.')
  }

  return {
    targetUserMessageId: targetUserMessage.id,
    userMessageIndex,
    userMessageCount: userMessages.length,
    messagesRemoved: activeMessages.length - activeMessageIndex,
  }
}

async function loadFileHistorySnapshots(
  sessionId: string,
): Promise<FileHistorySnapshot[] | null> {
  const snapshots = await sessionService.getSessionFileHistorySnapshots(sessionId)
  if (snapshots.length === 0) {
    return null
  }

  return snapshots
}

function expandTrackingPath(workDir: string, trackingPath: string): string {
  return isAbsolute(trackingPath) ? trackingPath : join(workDir, trackingPath)
}

function collectTrackedPaths(
  snapshots: FileHistorySnapshot[],
): Set<string> {
  const trackedPaths = new Set<string>()
  for (const snapshot of snapshots) {
    for (const trackingPath of Object.keys(snapshot.trackedFileBackups)) {
      trackedPaths.add(trackingPath)
    }
  }
  return trackedPaths
}

function findTargetSnapshot(
  snapshots: FileHistorySnapshot[],
  targetUserMessageId: string,
): FileHistorySnapshot | null {
  return (
    snapshots.findLast((snapshot) => snapshot.messageId === (targetUserMessageId as UUID)) ??
    null
  )
}

function getEarliestBackupFileName(
  trackingPath: string,
  snapshots: FileHistorySnapshot[],
): string | null | undefined {
  for (const snapshot of snapshots) {
    const backup = snapshot.trackedFileBackups[trackingPath]
    if (backup?.version === 1) {
      return backup.backupFileName
    }
  }

  return undefined
}

function getBackupFileNameForTarget(
  trackingPath: string,
  snapshots: FileHistorySnapshot[],
  targetSnapshot: FileHistorySnapshot,
): string | null | undefined {
  const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]
  if (targetBackup && typeof targetBackup === 'object' && 'backupFileName' in targetBackup) {
    return targetBackup.backupFileName
  }

  return getEarliestBackupFileName(trackingPath, snapshots)
}

async function resolveSessionWorkDir(sessionId: string): Promise<string> {
  return (
    (conversationService.hasSession(sessionId)
      ? conversationService.getSessionWorkDir(sessionId)
      : null) ||
    (await sessionService.getSessionWorkDir(sessionId)) ||
    process.cwd()
  )
}

async function resolveCheckpointBaseDir(
  sessionId: string,
  targetUserMessageId: string,
  fallbackWorkDir?: string,
): Promise<string> {
  return (
    (await sessionService.getSessionMessageCwd(sessionId, targetUserMessageId)) ||
    fallbackWorkDir ||
    (await resolveSessionWorkDir(sessionId))
  )
}

function normalizeComparablePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function toCheckpointResponsePath(
  trackingPath: string,
  checkpointBaseDir: string,
): string {
  if (isAbsolute(trackingPath)) {
    return trackingPath
  }

  const absolutePath = expandTrackingPath(checkpointBaseDir, trackingPath)
  const relativePath = normalizeComparablePath(relative(checkpointBaseDir, absolutePath))
  return relativePath && !relativePath.startsWith('../')
    ? relativePath
    : normalizeComparablePath(trackingPath)
}

function matchesCheckpointPath(
  requestedPath: string,
  trackingPath: string,
  checkpointBaseDir: string,
): boolean {
  const normalizedRequestedPath = normalizeComparablePath(requestedPath)
  const absolutePath = normalizeComparablePath(
    expandTrackingPath(checkpointBaseDir, trackingPath),
  )
  const responsePath = normalizeComparablePath(
    toCheckpointResponsePath(trackingPath, checkpointBaseDir),
  )

  return normalizedRequestedPath === absolutePath ||
    normalizedRequestedPath === normalizeComparablePath(trackingPath) ||
    normalizedRequestedPath === responsePath
}

function buildTurnPreview(
  target: RewindTarget,
  preview: RewindCodePreview,
  workDir: string,
  restoreAvailable = true,
  unverifiedChangeSources: string[] = [],
): SessionTurnCheckpointPreview {
  return {
    target: {
      targetUserMessageId: target.targetUserMessageId,
      userMessageIndex: target.userMessageIndex,
      userMessageCount: target.userMessageCount,
    },
    conversation: {
      messagesRemoved: target.messagesRemoved,
    },
    code: preview,
    workDir,
    restoreAvailable,
    unverifiedChangeSources,
  }
}

const MAX_UNVERIFIED_CHANGE_SOURCES = 8

function normalizeUnverifiedChangeSources(sources: Iterable<string>): string[] {
  return [...new Set(sources)].sort().slice(0, MAX_UNVERIFIED_CHANGE_SOURCES)
}

async function readCurrentFileBytes(filePath: string): Promise<Buffer | null | undefined> {
  try {
    const state = await readRestorableFileState(filePath)
    return state.exists ? state.content : null
  } catch {
    return undefined
  }
}

function checkpointBytesMatch(before: Buffer | null, after: Buffer | null): boolean {
  if (before === null || after === null) return before === after
  return before.equals(after)
}

function checkpointText(content: Buffer | null | undefined, strictText = false): string | null | undefined {
  if (content === null || content === undefined) return content
  const text = content.toString('utf-8')
  if (strictText && (content.includes(0) || !Buffer.from(text, 'utf-8').equals(content))) return undefined
  return text
}

function countCheckpointByteDiffStats(before: Buffer | null, after: Buffer | null): FileChangeStats {
  const beforeText = checkpointText(before, true)
  const afterText = checkpointText(after, true)
  if (beforeText === undefined || afterText === undefined) {
    return { insertions: 0, deletions: 0, textComparable: false }
  }
  return countTurnDiffStats(beforeText, afterText)
}

function buildCheckpointDiff(
  displayPath: string,
  oldContent: string,
  newContent: string,
  oldExists: boolean,
  newExists: boolean,
): string {
  const oldFileName = oldExists ? `a/${displayPath}` : '/dev/null'
  const newFileName = newExists ? `b/${displayPath}` : '/dev/null'

  return createTwoFilesPatch(
    oldFileName,
    newFileName,
    oldContent,
    newContent,
    '',
    '',
    { context: 3 },
  )
}

async function readBackupBytes(
  sessionId: string,
  backupFileName: string | null | undefined,
): Promise<Buffer | null | undefined> {
  if (backupFileName === undefined) return undefined
  if (backupFileName === null) return null
  if (typeof backupFileName !== 'string') return undefined
  try {
    const { content } = await readBackupFileSafely(backupFileName, sessionId)
    return content
  } catch {
    return undefined
  }
}

function countTurnDiffStats(
  beforeContent: string | null,
  afterContent: string | null,
): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  for (const change of diffLines(beforeContent ?? '', afterContent ?? '')) {
    if (change.added) insertions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { insertions, deletions }
}

function getTurnMessageRange(
  activeMessages: Awaited<ReturnType<typeof sessionService.getSessionMessages>>,
  targetUserMessageId: string,
): { start: number; end: number } | null {
  const start = activeMessages.findIndex((message) => message.id === targetUserMessageId)
  if (start < 0) return null
  const nextUserIndex = activeMessages.findIndex(
    (message, index) => index > start && message.type === 'user',
  )
  return { start, end: nextUserIndex >= 0 ? nextUserIndex : activeMessages.length }
}

function getNextUserMessageId(
  userMessages: Awaited<ReturnType<typeof sessionService.getSessionMessages>>,
  userMessageIndex: number,
): string | null {
  return userMessages[userMessageIndex + 1]?.id ?? null
}

function isWithinBaseDir(absolutePath: string, baseDir: string): boolean {
  const relativePath = relative(baseDir, absolutePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

async function resolveThroughExistingAncestor(filePath: string): Promise<string | null> {
  let existingPath = resolve(filePath)
  const missingSegments: string[] = []

  while (true) {
    try {
      return resolve(await realpath(existingPath), ...missingSegments)
    } catch (error) {
      const maybeErr = error as NodeJS.ErrnoException
      if (maybeErr.code !== 'ENOENT') return null

      const parentPath = dirname(existingPath)
      if (parentPath === existingPath) return null
      missingSegments.unshift(basename(existingPath))
      existingPath = parentPath
    }
  }
}

function findTrackedPathRoot(firstPath: string, secondPath: string): string {
  let rootPath = resolve(firstPath)
  while (!isWithinBaseDir(secondPath, rootPath)) {
    const parentPath = dirname(rootPath)
    if (parentPath === rootPath) return parse(secondPath).root
    rootPath = parentPath
  }
  return rootPath
}

function pathsMatch(firstPath: string, secondPath: string): boolean {
  const first = resolve(firstPath)
  const second = resolve(secondPath)
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second
}

function toFileIdentityPath(filePath: string, frozen = false): string {
  const canonicalPath = frozen ? resolve(filePath) : canonicalizeFilesystemAccessPath(filePath)
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
}

async function isSafeTrackedPath(
  checkpointBaseDir: string,
  trackingPath: string,
): Promise<boolean> {
  const baseDir = resolve(checkpointBaseDir)
  const absolutePath = resolve(expandTrackingPath(baseDir, trackingPath))

  if (!isAbsolute(trackingPath) && !isWithinBaseDir(absolutePath, baseDir)) {
    return false
  }

  const pathRoot = findTrackedPathRoot(baseDir, absolutePath)

  const [canonicalPathRoot, canonicalPath] = await Promise.all([
    resolveThroughExistingAncestor(pathRoot),
    resolveThroughExistingAncestor(absolutePath),
  ])
  if (!canonicalPathRoot || !canonicalPath) return false

  // Resolve the shared root once so system-level aliases above the workspace
  // (for example /var -> /private/var on macOS) remain valid while links in a
  // tracked path are rejected.
  const expectedPath = resolve(canonicalPathRoot, relative(pathRoot, absolutePath))
  if (!pathsMatch(canonicalPath, expectedPath)) return false

  try {
    const stats = await lstat(absolutePath)
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException
    return maybeErr.code === 'ENOENT'
  }
}

function normalizeTranscriptRelativePath(filePath: string): string {
  return normalizeComparablePath(filePath).replace(/^\/+/, '')
}

function resolveTranscriptToolPath(
  filePath: unknown,
  baseDir: string,
): { path: string; absolutePath: string; identityPath: string } | null {
  if (typeof filePath !== 'string' || !filePath.trim()) return null
  const normalizedBaseDir = resolve(baseDir)
  const absolutePath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(normalizedBaseDir, filePath)
  const pathWithinBaseDir = isWithinBaseDir(absolutePath, normalizedBaseDir)

  return {
    path: pathWithinBaseDir
      ? normalizeTranscriptRelativePath(relative(normalizedBaseDir, absolutePath))
      : normalizeComparablePath(absolutePath),
    absolutePath,
    identityPath: toFileIdentityPath(absolutePath),
  }
}

function countTranscriptLines(content: string): number {
  if (!content) return 0
  const lines = content.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.length
}

function buildTranscriptDiff(
  oldPath: string,
  newPath: string,
  oldContent: string,
  newContent: string,
): string {
  const oldLines = oldContent ? oldContent.split('\n') : []
  const newLines = newContent ? newContent.split('\n') : []
  if (oldLines.at(-1) === '') oldLines.pop()
  if (newLines.at(-1) === '') newLines.pop()

  return [
    `diff --session a/${oldPath} b/${newPath}`,
    `--- ${oldPath === '/dev/null' ? '/dev/null' : `a/${oldPath}`}`,
    `+++ b/${newPath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n')
}

function buildTranscriptEditChange(
  filePath: { path: string; absolutePath: string; identityPath: string },
  input: Record<string, unknown>,
): TranscriptFileChange {
  const oldString = typeof input.old_string === 'string' ? input.old_string : ''
  const newString = typeof input.new_string === 'string' ? input.new_string : ''
  return {
    path: filePath.path,
    absolutePath: filePath.absolutePath,
    identityPath: filePath.identityPath,
    additions: countTranscriptLines(newString),
    deletions: countTranscriptLines(oldString),
    diff: buildTranscriptDiff(filePath.path, filePath.path, oldString, newString),
  }
}

function extractApplyPatchTranscriptChanges(
  patch: unknown,
  baseDir: string,
): TranscriptFileChange[] {
  if (typeof patch !== 'string') return []
  const changes: TranscriptFileChange[] = []

  for (const line of patch.split('\n')) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ??
      line.match(/^\*\*\* Move to: (.+)$/)
    if (!match?.[1]) continue
    const filePath = resolveTranscriptToolPath(match[1], baseDir)
    if (!filePath) continue
    changes.push({
      path: filePath.path,
      absolutePath: filePath.absolutePath,
      identityPath: filePath.identityPath,
      additions: 0,
      deletions: 0,
    })
  }

  return changes
}

function extractTranscriptChangesFromTool(
  toolName: string,
  input: Record<string, unknown>,
  baseDir: string,
): TranscriptFileChange[] {
  const normalizedToolName = toolName.toLowerCase()
  if (normalizedToolName === 'write') {
    const filePath = resolveTranscriptToolPath(input.file_path ?? input.path, baseDir)
    if (!filePath) return []
    const content = typeof input.content === 'string' ? input.content : ''
    return [{
      path: filePath.path,
      absolutePath: filePath.absolutePath,
      identityPath: filePath.identityPath,
      additions: countTranscriptLines(content),
      deletions: 0,
      diff: buildTranscriptDiff('/dev/null', filePath.path, '', content),
    }]
  }

  if (normalizedToolName === 'edit') {
    const filePath = resolveTranscriptToolPath(input.file_path ?? input.path, baseDir)
    if (!filePath) return []
    return [buildTranscriptEditChange(filePath, input)]
  }

  if (normalizedToolName === 'multiedit') {
    const filePath = resolveTranscriptToolPath(input.file_path ?? input.path, baseDir)
    if (!filePath || !Array.isArray(input.edits)) return []
    return input.edits
      .filter((edit): edit is Record<string, unknown> => !!edit && typeof edit === 'object')
      .map((edit) => buildTranscriptEditChange(filePath, edit))
  }

  if (normalizedToolName === 'notebookedit') {
    const filePath = resolveTranscriptToolPath(
      input.notebook_path ?? input.file_path ?? input.path,
      baseDir,
    )
    if (!filePath) return []
    const oldString = typeof input.old_source === 'string' ? input.old_source : ''
    const newString = typeof input.new_source === 'string' ? input.new_source : ''
    return [{
      path: filePath.path,
      absolutePath: filePath.absolutePath,
      identityPath: filePath.identityPath,
      additions: countTranscriptLines(newString),
      deletions: countTranscriptLines(oldString),
      diff: buildTranscriptDiff(filePath.path, filePath.path, oldString, newString),
    }]
  }

  if (normalizedToolName === 'apply_patch') {
    return extractApplyPatchTranscriptChanges(input.patch, baseDir)
  }

  return []
}

function isKnownFileMutationTool(toolName: string): boolean {
  return ['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch']
    .includes(toolName.toLowerCase())
}

/**
 * Tools that cannot change workspace files, so their presence in a turn says
 * nothing about restore coverage.
 *
 * Deliberately absent: TaskCreate and TaskStop. TaskCreate spawns background
 * shell commands and agents that write files outside this transcript, so it has
 * to keep counting as an unverified source even though the call itself only
 * records metadata.
 */
function isKnownNonFileTool(toolName: string): boolean {
  return [
    'agent',
    'askuserquestion',
    'enterplanmode',
    'exitplanmode',
    'glob',
    'grep',
    'read',
    'skill',
    'sleep',
    'task',
    'taskget',
    'tasklist',
    'taskupdate',
    'todowrite',
    'toolsearch',
    'webfetch',
    'websearch',
  ].includes(toolName.toLowerCase())
}

/**
 * A shell call whose command the allowlist proves cannot write. Anything the
 * allowlist does not recognize stays unverified, so `bun test` or `npm install`
 * still downgrades coverage while `git status` no longer does.
 */
function isReadOnlyShellCall(toolName: string, input: unknown): boolean {
  if (toolName.toLowerCase() !== 'bash') return false
  const command = (input as { command?: unknown } | null | undefined)?.command
  return typeof command === 'string' && recordedCommandIsReadOnly(command)
}

function isNonMutatingToolCall(toolName: string, input: unknown): boolean {
  return isKnownNonFileTool(toolName) || isReadOnlyShellCall(toolName, input)
}

function getToolUseIds(messages: MessageEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'tool_use' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (record.type === 'tool_use' && typeof record.id === 'string') {
        ids.add(record.id)
      }
    }
  }
  return ids
}

type IndexedTranscriptMessage = {
  index: number
  message: MessageEntry
}

type TranscriptTurnContext = {
  activeMessageIndex: number
  completed: boolean
  messages: MessageEntry[]
  userMessage: MessageEntry
  userMessageIndex: number
}

function buildChildMessagesByParentToolUseId(
  activeMessages: MessageEntry[],
): Map<string, IndexedTranscriptMessage[]> {
  // SubAgent entries sit outside the root turn slice. Index their ownership once
  // so listing every turn does not rescan the complete transcript for each one.
  const childMessagesByParentToolUseId = new Map<string, IndexedTranscriptMessage[]>()
  for (const [index, message] of activeMessages.entries()) {
    if (!message.parentToolUseId) continue
    const existing = childMessagesByParentToolUseId.get(message.parentToolUseId)
    const indexedMessage = { index, message }
    if (existing) existing.push(indexedMessage)
    else childMessagesByParentToolUseId.set(message.parentToolUseId, [indexedMessage])
  }
  return childMessagesByParentToolUseId
}

function collectReachableTranscriptMessages(
  parentTurnMessages: MessageEntry[],
  childMessagesByParentToolUseId: Map<string, IndexedTranscriptMessage[]>,
): MessageEntry[] {
  const pendingToolUseIds = [...getToolUseIds(parentTurnMessages)]
  if (pendingToolUseIds.length === 0) return parentTurnMessages

  const expandedToolUseIds = new Set<string>()
  const includedMessageIds = new Set(parentTurnMessages.map((message) => message.id))
  const childMessages: IndexedTranscriptMessage[] = []
  for (let cursor = 0; cursor < pendingToolUseIds.length; cursor += 1) {
    const toolUseId = pendingToolUseIds[cursor]!
    if (expandedToolUseIds.has(toolUseId)) continue
    expandedToolUseIds.add(toolUseId)

    for (const indexedMessage of childMessagesByParentToolUseId.get(toolUseId) ?? []) {
      if (includedMessageIds.has(indexedMessage.message.id)) continue
      includedMessageIds.add(indexedMessage.message.id)
      childMessages.push(indexedMessage)
      pendingToolUseIds.push(...getToolUseIds([indexedMessage.message]))
    }
  }

  childMessages.sort((left, right) => left.index - right.index)
  return [...parentTurnMessages, ...childMessages.map(({ message }) => message)]
}

function getTranscriptTurnMessages(
  activeMessages: MessageEntry[],
  targetUserMessageId: string,
): MessageEntry[] {
  const range = getTurnMessageRange(activeMessages, targetUserMessageId)
  if (!range) return []

  const rawTurnMessages = activeMessages.slice(range.start + 1, range.end)
  const parentTurnMessages = rawTurnMessages.filter((message) => !message.parentToolUseId)
  return collectReachableTranscriptMessages(
    parentTurnMessages,
    buildChildMessagesByParentToolUseId(activeMessages),
  )
}

function buildTranscriptTurnContexts(
  activeMessages: MessageEntry[],
): TranscriptTurnContext[] {
  const userMessages = activeMessages.flatMap((message, activeMessageIndex) =>
    message.type === 'user' ? [{ activeMessageIndex, message }] : [])
  const childMessagesByParentToolUseId = buildChildMessagesByParentToolUseId(activeMessages)

  return userMessages.map(({ activeMessageIndex, message: userMessage }, userMessageIndex) => {
    const end = userMessages[userMessageIndex + 1]?.activeMessageIndex ?? activeMessages.length
    const rawTurnMessages = activeMessages.slice(activeMessageIndex + 1, end)
    const parentTurnMessages = rawTurnMessages.filter((message) => !message.parentToolUseId)
    return {
      activeMessageIndex,
      // Child-agent transcript entries can be physically interleaved after a
      // later root prompt. They belong to the parent tool's turn and must not
      // make that later, still-unanswered prompt look safely rewindable.
      completed: parentTurnMessages.some((message) =>
        message.type === 'assistant' ||
        message.type === 'tool_use' ||
        message.type === 'tool_result' ||
        message.type === 'error'
      ),
      messages: collectReachableTranscriptMessages(
        parentTurnMessages,
        childMessagesByParentToolUseId,
      ),
      userMessage,
      userMessageIndex,
    }
  })
}

function collectTranscriptFileChanges(
  turnMessages: MessageEntry[],
  baseDir: string,
  frozen = false,
): TranscriptTurnFileEvidence {
  if (turnMessages.length === 0) {
    return { confirmedChanges: [], uncertainChanges: [], unverifiedChangeSources: [] }
  }

  const confirmedChanges = new Map<string, TranscriptFileChange>()
  const uncertainChanges = new Map<string, TranscriptFileChange>()
  const successfulToolUseIds = collectSuccessfulToolUseIds(turnMessages)
  const erroredToolUseIds = collectErroredToolUseIds(turnMessages)
  const seenToolUseIds = new Set<string>()
  const unverifiedChangeSources = new Set<string>()
  for (const message of turnMessages) {
    if (message.type !== 'tool_use' || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (record.type !== 'tool_use' || typeof record.name !== 'string') continue
      if (typeof record.id !== 'string' || seenToolUseIds.has(record.id)) {
        continue
      }
      seenToolUseIds.add(record.id)
      const input = record.input
      // A failed call can still have written before it failed, and a call whose
      // input did not survive tells us nothing about what it touched.
      if (erroredToolUseIds.has(record.id) || !input || typeof input !== 'object') {
        if (!isNonMutatingToolCall(record.name, input)) {
          unverifiedChangeSources.add(record.name)
        }
        continue
      }
      if (isNonMutatingToolCall(record.name, input)) continue
      if (!isKnownFileMutationTool(record.name)) {
        unverifiedChangeSources.add(record.name)
        continue
      }

      const changes = successfulToolUseIds.has(record.id)
        ? confirmedChanges
        : uncertainChanges
      const extractedChanges = extractTranscriptChangesFromTool(
        record.name,
        input as Record<string, unknown>,
        message.cwd ?? baseDir,
      )
      if (extractedChanges.length === 0) unverifiedChangeSources.add(record.name)

      for (const extracted of extractedChanges) {
        const change = frozen ? { ...extracted, identityPath: toFileIdentityPath(extracted.absolutePath, true) } : extracted
        const existing = changes.get(change.identityPath)
        if (!existing) {
          changes.set(change.identityPath, change)
          continue
        }

        changes.set(change.identityPath, {
          ...existing,
          additions: existing.additions + change.additions,
          deletions: existing.deletions + change.deletions,
          diff: [existing.diff, change.diff].filter(Boolean).join('\n'),
        })
      }
    }
  }

  const sortChanges = (changes: Map<string, TranscriptFileChange>) =>
    [...changes.values()].sort((a, b) => a.path.localeCompare(b.path))
  return {
    confirmedChanges: sortChanges(confirmedChanges),
    uncertainChanges: sortChanges(uncertainChanges),
    unverifiedChangeSources: normalizeUnverifiedChangeSources(unverifiedChangeSources),
  }
}

function collectTranscriptTurnFileChanges(
  activeMessages: MessageEntry[],
  targetUserMessageId: string,
  baseDir: string,
  frozen = false,
): TranscriptTurnFileEvidence {
  return collectTranscriptFileChanges(
    getTranscriptTurnMessages(activeMessages, targetUserMessageId),
    baseDir,
    frozen,
  )
}

function buildTranscriptTurnCodePreview(
  changes: TranscriptFileChange[],
): RewindCodePreview {
  if (changes.length === 0) {
    return {
      available: false,
      reason: 'No transcript file changes were recorded for this turn.',
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    }
  }

  const fileStats = new Map<string, FileChangeStats>()
  for (const change of changes) {
    fileStats.set(change.identityPath, {
      insertions: change.additions,
      deletions: change.deletions,
    })
  }
  return normalizeDiffStats({
    filesChanged: changes.map((change) => change.absolutePath),
    insertions: changes.reduce((total, change) => total + change.additions, 0),
    deletions: changes.reduce((total, change) => total + change.deletions, 0),
    fileStats,
  })
}

/**
 * Combines what the file-history snapshot captured with what the transcript
 * says the turn did.
 *
 * `restoreAvailable` answers a deliberately narrow question: can the files this
 * checkpoint reports be put back? It is not a claim that the checkpoint saw
 * every file the turn touched — snapshots only cover the structured file tools,
 * so a shell command that writes off-checkpoint is invisible to them. Blocking
 * undo on that (as this did before) removes the feature from any turn that ran
 * a command, and still leaves the user with no way to reverse the edits that
 * *were* captured. Such turns now restore what is covered and report the tools
 * whose effects were not, so the reported file list stays truthful.
 *
 * `transcriptIntact` is different in kind: a truncated transcript or an
 * unreadable subagent log means the turn cannot be enumerated at all, so even
 * the file list may be wrong. That still blocks.
 */
function mergeTurnCodePreviews(
  snapshotPreview: SnapshotTurnCodePreview | null,
  transcriptEvidence: TranscriptTurnFileEvidence,
  transcriptIntact: boolean,
  frozen = false,
): MergedTurnCodePreview {
  const transcriptChanges = transcriptEvidence.confirmedChanges
  const transcriptPreview = buildTranscriptTurnCodePreview(transcriptChanges)
  const scopedSnapshotPreview = scopeSnapshotPreviewToTurn(
    snapshotPreview,
    transcriptEvidence,
    transcriptIntact,
    frozen,
  )
  const checkpointPreview = scopedSnapshotPreview?.preview ?? null
  const hasUncoveredUncertainChange = transcriptEvidence.uncertainChanges.some((change) =>
    !scopedSnapshotPreview?.coveredPathIdentities.has(change.identityPath)
  )
  const unverifiedChangeSources = transcriptEvidence.unverifiedChangeSources
  const evidenceIncomplete = !transcriptIntact
  if (!checkpointPreview?.available) {
    return {
      preview: transcriptPreview,
      unverifiedChangeSources,
      restoreAvailable: !transcriptPreview.available &&
        !hasUncoveredUncertainChange &&
        !evidenceIncomplete,
    }
  }
  if (!transcriptPreview.available) {
    return {
      preview: checkpointPreview,
      unverifiedChangeSources,
      restoreAvailable: (scopedSnapshotPreview?.restoreAvailable ?? false) &&
        !hasUncoveredUncertainChange &&
        !evidenceIncomplete,
    }
  }

  const missingTranscriptChanges = transcriptChanges.filter((change) =>
    !scopedSnapshotPreview?.coveredPathIdentities.has(change.identityPath)
  )
  if (missingTranscriptChanges.length === 0) {
    return {
      preview: checkpointPreview,
      unverifiedChangeSources,
      restoreAvailable: (scopedSnapshotPreview?.restoreAvailable ?? false) &&
        !hasUncoveredUncertainChange &&
        !evidenceIncomplete,
    }
  }

  const checkpointFileStats = checkpointPreview[fileChangeStats] ?? new Map()
  const transcriptFileStats = transcriptPreview[fileChangeStats] ?? new Map()
  const mergedFileStats = new Map(checkpointFileStats)
  for (const change of missingTranscriptChanges) {
    const stats = transcriptFileStats.get(change.identityPath)
    if (stats) mergedFileStats.set(change.identityPath, stats)
  }

  return {
    preview: normalizeDiffStats({
      filesChanged: [
        ...checkpointPreview.filesChanged,
        ...missingTranscriptChanges.map((change) => change.absolutePath),
      ],
      insertions: checkpointPreview.insertions + missingTranscriptChanges.reduce(
        (total, change) => total + change.additions,
        0,
      ),
      deletions: checkpointPreview.deletions + missingTranscriptChanges.reduce(
        (total, change) => total + change.deletions,
        0,
      ),
      fileStats: mergedFileStats,
    }),
    unverifiedChangeSources,
    restoreAvailable: (scopedSnapshotPreview?.restoreAvailable ?? false) &&
      missingTranscriptChanges.every((change) =>
        scopedSnapshotPreview?.restorablePathIdentities.has(change.identityPath)
      ) &&
      !hasUncoveredUncertainChange &&
      !evidenceIncomplete,
  }
}

function scopeSnapshotPreviewToTurn(
  snapshotPreview: SnapshotTurnCodePreview | null,
  transcriptEvidence: TranscriptTurnFileEvidence,
  transcriptIntact: boolean,
  frozen = false,
): SnapshotTurnCodePreview | null {
  if (
    !snapshotPreview ||
    !transcriptIntact ||
    transcriptEvidence.unverifiedChangeSources.length > 0
  ) {
    return snapshotPreview
  }

  const attributedPathIdentities = new Set([
    ...transcriptEvidence.confirmedChanges,
    ...transcriptEvidence.uncertainChanges,
  ].map((change) => change.identityPath))
  // Snapshot-only turns remain supported: without a structured mutation tool,
  // the snapshot is the only evidence available. Once the transcript names the
  // files this turn attempted to mutate, however, it is also the authoritative
  // turn boundary. Cumulative providers can otherwise carry a pre-rewind backup
  // forward and make an old file look newly created in the replacement turn.
  if (attributedPathIdentities.size === 0) return snapshotPreview

  const checkpointFileStats = snapshotPreview.preview[fileChangeStats] ?? new Map()
  const scopedFileStats = new Map<string, FileChangeStats>()
  const filesChanged = snapshotPreview.preview.filesChanged.filter((filePath) => {
    const identityPath = toFileIdentityPath(filePath, frozen)
    if (!attributedPathIdentities.has(identityPath)) return false
    const stats = checkpointFileStats.get(identityPath)
    if (stats) scopedFileStats.set(identityPath, stats)
    return true
  })
  const scopedStats = [...scopedFileStats.values()]

  return {
    ...snapshotPreview,
    preview: normalizeDiffStats({
      filesChanged,
      insertions: scopedStats.reduce((total, stats) => total + stats.insertions, 0),
      deletions: scopedStats.reduce((total, stats) => total + stats.deletions, 0),
      fileStats: scopedFileStats,
    }),
    restoreAvailable: [...attributedPathIdentities].every((identityPath) =>
      !snapshotPreview.unrestorablePathIdentities.has(identityPath)
    ),
  }
}

function findTranscriptTurnDiff(
  activeMessages: MessageEntry[],
  targetUserMessageId: string,
  baseDir: string,
  requestedPath: string,
  frozen = false,
): TranscriptFileChange | null {
  const { confirmedChanges: changes } = collectTranscriptTurnFileChanges(
    activeMessages,
    targetUserMessageId,
    baseDir,
    frozen,
  )
  return changes.find((change) =>
    matchesCheckpointPath(requestedPath, change.path, baseDir) ||
    normalizeComparablePath(requestedPath) === normalizeComparablePath(change.absolutePath)
  ) ?? null
}

async function getTurnBoundaryContents(
  sessionId: string,
  checkpointBaseDir: string,
  trackingPath: string,
  targetSnapshot: FileHistorySnapshot,
  nextSnapshot: FileHistorySnapshot | null,
  frozen = false,
): Promise<{
  beforeContent: string | null
  afterContent: string | null
  afterBoundaryAvailable: boolean
  restorePointAvailable: boolean
  changed: boolean
  textComparable: boolean
}> {
  const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]
  const absolutePath = expandTrackingPath(checkpointBaseDir, trackingPath)
  const beforeBytes = await readBackupBytes(sessionId, targetBackup?.backupFileName)
  const beforeContent = checkpointText(beforeBytes, frozen)
  let afterBytes: Buffer | null | undefined
  if (frozen && targetSnapshot.completedFileBackups) {
    afterBytes = await readBackupBytes(sessionId, targetSnapshot.completedFileBackups[trackingPath]?.backupFileName)
  } else if (!nextSnapshot) {
    if (!frozen) afterBytes = await readCurrentFileBytes(absolutePath)
  } else {
    const identityPath = toFileIdentityPath(absolutePath, frozen)
    const matchingNextBackups = Object.entries(nextSnapshot.trackedFileBackups)
      .filter(([nextTrackingPath]) =>
        toFileIdentityPath(expandTrackingPath(checkpointBaseDir, nextTrackingPath), frozen) === identityPath
      )
      .map(([, backup]) => backup?.backupFileName)
    const distinctNextBackups = new Set(matchingNextBackups)
    const nextBackupFileName = distinctNextBackups.size === 1
      ? matchingNextBackups[0]
      : undefined
    afterBytes = await readBackupBytes(sessionId, nextBackupFileName)
  }

  const afterContent = checkpointText(afterBytes, frozen)
  const restorePointAvailable = beforeContent !== undefined &&
    (frozen || nextSnapshot !== null || afterBytes !== undefined)
  const afterBoundaryAvailable = afterContent !== undefined && (!frozen || restorePointAvailable)
  const effectiveAfterBytes = afterBoundaryAvailable ? afterBytes : beforeBytes
  return {
    beforeContent: beforeContent ?? null,
    afterContent: afterBoundaryAvailable ? afterContent ?? null : beforeContent ?? null,
    afterBoundaryAvailable,
    restorePointAvailable,
    // Text is presentation only: distinct invalid UTF-8 bytes can decode to
    // the same replacement character, while absence differs from an empty file.
    changed: (!frozen && !nextSnapshot && afterBytes === undefined) ||
      !checkpointBytesMatch(beforeBytes ?? null, effectiveAfterBytes ?? null),
    textComparable: checkpointText(beforeBytes, true) !== undefined &&
      checkpointText(effectiveAfterBytes, true) !== undefined,
  }
}

/** All recorded aliases of a frozen path must agree; live symlinks are irrelevant. */
async function getFrozenTurnBoundaryContents(
  sessionId: string,
  checkpointBaseDir: string,
  trackingPath: string,
  targetSnapshot: FileHistorySnapshot,
  nextSnapshot: FileHistorySnapshot | null,
): Promise<Awaited<ReturnType<typeof getTurnBoundaryContents>>> {
  const identity = toFileIdentityPath(expandTrackingPath(checkpointBaseDir, trackingPath), true)
  const aliases = [...new Set([...Object.keys(targetSnapshot.trackedFileBackups), ...Object.keys(targetSnapshot.completedFileBackups ?? {})])].filter(candidate =>
    toFileIdentityPath(expandTrackingPath(checkpointBaseDir, candidate), true) === identity)
  let result: Awaited<ReturnType<typeof getTurnBoundaryContents>> | undefined
  for (const alias of aliases) {
    const boundary = await getTurnBoundaryContents(sessionId, checkpointBaseDir, alias, targetSnapshot, nextSnapshot, true)
    if (!boundary.afterBoundaryAvailable) return boundary
    if (result && (result.beforeContent !== boundary.beforeContent || result.afterContent !== boundary.afterContent)) {
      return { ...result, afterBoundaryAvailable: false }
    }
    result = boundary
  }
  return result!
}

async function buildTurnCodePreview(
  sessionId: string,
  checkpointBaseDir: string,
  targetSnapshot: FileHistorySnapshot,
  nextSnapshot: FileHistorySnapshot | null,
  signal?: AbortSignal,
  frozen = false,
): Promise<SnapshotTurnCodePreview> {
  const trackedPaths = Object.keys(targetSnapshot.trackedFileBackups)
  const coveredPathIdentities = new Set<string>()
  const restorablePathIdentities = new Set<string>()
  const unrestorablePathIdentities = new Set<string>()
  const processedPathIdentities = new Set<string>()
  const backupByIdentity = new Map<string, string | null>()
  const statsByIdentity = new Map<string, FileChangeStats>()
  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0
  let restoreAvailable = true

  for (const trackingPath of trackedPaths) {
    signal?.throwIfAborted()
    const identityPath = toFileIdentityPath(
      expandTrackingPath(checkpointBaseDir, trackingPath),
      frozen,
    )
    const targetBackupFileName = targetSnapshot.trackedFileBackups[trackingPath]
      ?.backupFileName
    if (targetBackupFileName === undefined) {
      unrestorablePathIdentities.add(identityPath)
      restoreAvailable = false
      continue
    }
    if (backupByIdentity.has(identityPath)) {
      if (backupByIdentity.get(identityPath) !== targetBackupFileName) {
        unrestorablePathIdentities.add(identityPath)
        restoreAvailable = false
      }
      continue
    }
    backupByIdentity.set(identityPath, targetBackupFileName)
    if (processedPathIdentities.has(identityPath)) continue
    processedPathIdentities.add(identityPath)

    const {
      beforeContent,
      afterContent,
      afterBoundaryAvailable,
      restorePointAvailable,
      changed,
      textComparable,
    } =
      await (frozen ? getFrozenTurnBoundaryContents : getTurnBoundaryContents)(
        sessionId,
        checkpointBaseDir,
        trackingPath,
        targetSnapshot,
        nextSnapshot,
      )
    const safeTrackedPath = await isSafeTrackedPath(checkpointBaseDir, trackingPath)
    signal?.throwIfAborted()
    if (restorePointAvailable && safeTrackedPath) {
      restorablePathIdentities.add(identityPath)
    }
    if (afterBoundaryAvailable) coveredPathIdentities.add(identityPath)
    if (!restorePointAvailable || !safeTrackedPath) {
      unrestorablePathIdentities.add(identityPath)
      restoreAvailable = false
    }
    if (!changed) continue

    filesChanged.push(expandTrackingPath(checkpointBaseDir, trackingPath))
    const stats: FileChangeStats = textComparable
      ? countTurnDiffStats(beforeContent, afterContent)
      : { insertions: 0, deletions: 0, textComparable: false }
    statsByIdentity.set(identityPath, stats)
    insertions += stats.insertions
    deletions += stats.deletions
  }

  return {
    preview: normalizeDiffStats({
      filesChanged,
      insertions,
      deletions,
      fileStats: statsByIdentity,
    }),
    coveredPathIdentities,
    restorablePathIdentities,
    unrestorablePathIdentities,
    restoreAvailable,
  }
}

type RestorableFileState =
  | { exists: false }
  | { exists: true; content: Buffer; mode: number }

type RestorePlanEntry = {
  trackingPath: string
  absolutePath: string
  originalState: RestorableFileState
  targetState: RestorableFileState
}

function restorableFileStatesMatch(
  first: RestorableFileState,
  second: RestorableFileState,
): boolean {
  if (!first.exists || !second.exists) return first.exists === second.exists
  return first.content.equals(second.content)
}

async function readRestorableFileState(
  filePath: string,
): Promise<RestorableFileState> {
  let fileHandle: FileHandle
  try {
    fileHandle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException
    if (maybeErr.code === 'ENOENT') return { exists: false }
    throw error
  }

  try {
    const stats = await fileHandle.stat()
    if (!stats.isFile() || stats.nlink !== 1) {
      throw ApiError.badRequest(`File cannot be restored safely: ${filePath}`)
    }
    return {
      exists: true,
      content: await fileHandle.readFile(),
      mode: stats.mode,
    }
  } finally {
    await fileHandle.close()
  }
}

async function writeRestorableFileState(
  filePath: string,
  state: RestorableFileState,
): Promise<void> {
  if (!state.exists) {
    try {
      const currentState = await readRestorableFileState(filePath)
      if (currentState.exists) await unlink(filePath)
    } catch (error) {
      const maybeErr = error as NodeJS.ErrnoException
      if (maybeErr.code !== 'ENOENT') throw error
    }
    return
  }

  let targetFile: FileHandle
  try {
    targetFile = await open(filePath, constants.O_WRONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException
    if (maybeErr.code !== 'ENOENT') throw error
    await mkdir(dirname(filePath), { recursive: true })
    targetFile = await open(
      filePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      state.mode,
    )
  }

  try {
    const targetStats = await targetFile.stat()
    if (!targetStats.isFile() || targetStats.nlink !== 1) {
      throw ApiError.badRequest(`File cannot be restored safely: ${filePath}`)
    }
    await targetFile.truncate(0)
    await targetFile.writeFile(state.content)
    await targetFile.chmod(state.mode)
  } finally {
    await targetFile.close()
  }
}

async function assertRestoreTargetWritable(
  filePath: string,
  originalState: RestorableFileState,
  targetState: RestorableFileState,
): Promise<void> {
  if (originalState.exists && targetState.exists) {
    const fileHandle = await open(filePath, constants.O_WRONLY | constants.O_NOFOLLOW)
    try {
      const stats = await fileHandle.stat()
      if (!stats.isFile() || stats.nlink !== 1) {
        throw ApiError.badRequest(`File cannot be restored safely: ${filePath}`)
      }
    } finally {
      await fileHandle.close()
    }
    return
  }

  let existingParent = dirname(filePath)
  while (true) {
    try {
      await access(existingParent, constants.W_OK)
      return
    } catch (error) {
      const maybeErr = error as NodeJS.ErrnoException
      if (maybeErr.code !== 'ENOENT') throw error
      const parent = dirname(existingParent)
      if (parent === existingParent) throw error
      existingParent = parent
    }
  }
}

async function buildRestorePlan(
  sessionId: string,
  checkpointBaseDir: string,
  snapshots: FileHistorySnapshot[],
  targetSnapshot: FileHistorySnapshot,
  filesToRestore: string[],
  checkWritable = true,
): Promise<RestorePlanEntry[]> {
  const plan: RestorePlanEntry[] = []
  const backupByIdentity = new Map<string, string | null>()
  const restorePathIdentities = new Set(
    filesToRestore.map((filePath) => toFileIdentityPath(filePath)),
  )

  for (const trackingPath of collectTrackedPaths(snapshots)) {
    const absolutePath = expandTrackingPath(checkpointBaseDir, trackingPath)
    const identityPath = toFileIdentityPath(absolutePath)
    if (!restorePathIdentities.has(identityPath)) continue

    const backupFileName = getBackupFileNameForTarget(
      trackingPath,
      snapshots,
      targetSnapshot,
    )
    if (backupFileName === undefined) {
      throw ApiError.badRequest(`No restore point is available for tracked path: ${trackingPath}`)
    }

    if (backupByIdentity.has(identityPath)) {
      if (backupByIdentity.get(identityPath) !== backupFileName) {
        throw ApiError.badRequest(`Conflicting checkpoints for tracked path: ${trackingPath}`)
      }
      continue
    }
    backupByIdentity.set(identityPath, backupFileName)

    if (!(await isSafeTrackedPath(checkpointBaseDir, trackingPath))) {
      throw ApiError.badRequest(`Tracked path became unsafe before restore: ${trackingPath}`)
    }

    const originalState = await readRestorableFileState(absolutePath)
    const targetState = backupFileName === null
      ? { exists: false } as const
      : {
          exists: true as const,
          ...await readBackupFileSafely(backupFileName, sessionId),
        }
    if (!targetState.exists && backupFileName !== null) {
      throw ApiError.badRequest(`Checkpoint backup is missing: ${backupFileName}`)
    }
    if (restorableFileStatesMatch(originalState, targetState)) continue
    if (checkWritable) await assertRestoreTargetWritable(absolutePath, originalState, targetState)
    plan.push({ trackingPath, absolutePath, originalState, targetState })
  }

  for (const identityPath of restorePathIdentities) {
    if (!backupByIdentity.has(identityPath)) {
      throw ApiError.badRequest(`No restore point is available for changed path: ${identityPath}`)
    }
  }
  return plan
}

async function applyRestorePlan(
  checkpointBaseDir: string,
  plan: RestorePlanEntry[],
): Promise<void> {
  const attempted: RestorePlanEntry[] = []
  try {
    for (const entry of plan) {
      if (!(await isSafeTrackedPath(checkpointBaseDir, entry.trackingPath))) {
        throw ApiError.badRequest(
          `Tracked path became unsafe before restore: ${entry.trackingPath}`,
        )
      }
      attempted.push(entry)
      await writeRestorableFileState(entry.absolutePath, entry.targetState)
    }
  } catch (error) {
    const rollbackErrors = await rollbackRestorePlan(checkpointBaseDir, attempted)
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Restore failed and rollback was incomplete: ${rollbackErrors.join('; ')}`,
        { cause: error },
      )
    }
    throw ApiError.badRequest(
      'The checkpoint could not be restored safely. No messages or files were changed.',
    )
  }
}

async function rollbackRestorePlan(
  checkpointBaseDir: string,
  plan: RestorePlanEntry[],
): Promise<string[]> {
  const rollbackErrors: string[] = []
  for (const entry of [...plan].reverse()) {
    try {
      if (!(await isSafeTrackedPath(checkpointBaseDir, entry.trackingPath))) {
        rollbackErrors.push(`Tracked path became unsafe: ${entry.trackingPath}`)
        continue
      }
      await writeRestorableFileState(entry.absolutePath, entry.originalState)
    } catch (rollbackError) {
      rollbackErrors.push(
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      )
    }
  }
  return rollbackErrors
}

async function buildCodePreview(
  sessionId: string,
  checkpointBaseDir: string,
  targetUserMessageId: string,
): Promise<{
  snapshots: FileHistorySnapshot[] | null
  preview: RewindCodePreview
  restoreAvailable: boolean
}> {
  const snapshots = await loadFileHistorySnapshots(sessionId)
  if (!snapshots) {
    return {
      snapshots: null,
      preview: {
        available: false,
        reason: 'No file checkpoints were recorded for this session.',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      },
      restoreAvailable: true,
    }
  }

  const targetSnapshot = findTargetSnapshot(snapshots, targetUserMessageId)
  if (!targetSnapshot) {
    return {
      snapshots,
      preview: {
        available: false,
        reason: 'No file checkpoint is available for the selected message.',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      },
      restoreAvailable: true,
    }
  }

  const trackedPaths = collectTrackedPaths(snapshots)
  const filesChanged: string[] = []
  const backupByIdentity = new Map<string, string | null>()
  const statsByIdentity = new Map<string, FileChangeStats>()
  let insertions = 0
  let deletions = 0
  let restoreAvailable = true

  for (const trackingPath of trackedPaths) {
    const backupFileName = getBackupFileNameForTarget(
      trackingPath,
      snapshots,
      targetSnapshot,
    )

    if (backupFileName === undefined) continue

    const absolutePath = expandTrackingPath(checkpointBaseDir, trackingPath)
    const identityPath = toFileIdentityPath(absolutePath)
    if (backupByIdentity.has(identityPath)) {
      if (backupByIdentity.get(identityPath) !== backupFileName) {
        restoreAvailable = false
      }
      continue
    }
    backupByIdentity.set(identityPath, backupFileName)

    if (!(await isSafeTrackedPath(checkpointBaseDir, trackingPath))) {
      restoreAvailable = false
      continue
    }

    const [currentBytes, backupBytes] = await Promise.all([
      readCurrentFileBytes(absolutePath),
      readBackupBytes(sessionId, backupFileName),
    ])
    if (backupBytes === undefined || currentBytes === undefined) {
      restoreAvailable = false
      continue
    }
    if (checkpointBytesMatch(currentBytes, backupBytes)) continue

    filesChanged.push(absolutePath)
    const fileStats = backupBytes === null
      ? countCheckpointByteDiffStats(backupBytes, currentBytes)
      : countCheckpointByteDiffStats(currentBytes, backupBytes)
    insertions += fileStats.insertions
    deletions += fileStats.deletions
    statsByIdentity.set(identityPath, fileStats)
  }

  return {
    snapshots,
    preview: normalizeDiffStats({
      filesChanged,
      insertions,
      deletions,
      fileStats: statsByIdentity,
    }),
    restoreAvailable,
  }
}

function replayKnownTurnFileContent(
  messages: MessageEntry[],
  baseDir: string,
  identity: string,
  before: string | null | undefined,
  frozen = false,
): string | null | undefined {
  let content = before
  const successfulIds = collectSuccessfulToolUseIds(messages)
  for (const message of messages) {
    if (message.type !== 'tool_use' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const tool = block as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
      if (tool.type !== 'tool_use' || !tool.id || !successfulIds.has(tool.id) || !tool.name || !tool.input) continue
      const changes = extractTranscriptChangesFromTool(tool.name, tool.input, message.cwd ?? baseDir)
      if (!changes.some((change) => (frozen ? toFileIdentityPath(change.absolutePath, true) : change.identityPath) === identity)) continue
      if (tool.name.toLowerCase() === 'write' && typeof tool.input.content === 'string') {
        content = tool.input.content
        continue
      }
      const edits = tool.name.toLowerCase() === 'edit'
        ? [tool.input]
        : tool.name.toLowerCase() === 'multiedit' && Array.isArray(tool.input.edits)
          ? tool.input.edits
          : null
      if (!edits) {
        content = undefined
        continue
      }
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object' || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
          content = undefined
          break
        }
        if (edit.old_string === '') {
          content = edit.new_string
          continue
        }
        // An unknown or ambiguous edit loses exact state, but a later complete
        // Write can establish it again. Do not abandon the rest of the turn.
        if (typeof content !== 'string' || !content.includes(edit.old_string) ||
          (edit.replace_all !== true && content.indexOf(edit.old_string) !== content.lastIndexOf(edit.old_string))) {
          content = undefined
          break
        }
        content = applyEditToFile(content, edit.old_string, edit.new_string, edit.replace_all === true)
      }
    }
  }
  return content
}

/**
 * Some resumed providers repeat an earlier turn's pre-edit backups in later
 * snapshots. Those backups cannot be the later turn's before-state. Discard
 * only entries we can trace to a nonzero earlier mutation with the same
 * backup/version. Exact tool replay distinguishes stale backups from legitimate
 * reuse after an edit was reverted; unknown and snapshot-only evidence stays intact.
 * Use this view for both sides of a turn boundary, otherwise a carried backup
 * also makes the original edit look like a zero-net change.
 */
async function scopeCarriedForwardSnapshots(
  sessionId: string,
  snapshots: FileHistorySnapshot[] | null,
  activeMessages: MessageEntry[],
  transcriptEvidenceComplete: boolean,
  workDir: string,
  frozen = false,
): Promise<FileHistorySnapshot[] | null> {
  if (!snapshots || !transcriptEvidenceComplete) return snapshots
  const snapshotsByMessageId = new Map<string, FileHistorySnapshot>(
    snapshots.map((snapshot) => [snapshot.messageId, snapshot]),
  )
  const attributedBackups = new Map<string, { backupFileName: string | null; version: number }>()
  const scopedByMessageId = new Map<string, FileHistorySnapshot>()

  for (const turn of buildTranscriptTurnContexts(activeMessages)) {
    const baseDir = turn.userMessage.cwd ?? workDir
    const evidence = collectTranscriptFileChanges(turn.messages, baseDir, frozen)
    if (evidence.unverifiedChangeSources.length > 0) {
      // Unknown writes break the attribution chain; do not infer their effects.
      attributedBackups.clear()
      continue
    }
    const snapshot = snapshotsByMessageId.get(turn.userMessage.id)
    const attemptedPaths = new Set([
      ...evidence.confirmedChanges,
      ...evidence.uncertainChanges,
    ].map((change) => change.identityPath))
    const uncertainPaths = new Set(evidence.uncertainChanges.map((change) => change.identityPath))
    const confirmedPaths = new Set(evidence.confirmedChanges.map((change) => change.identityPath))
    for (const identity of attemptedPaths) attributedBackups.delete(identity)
    const backups = { ...snapshot?.trackedFileBackups }
    for (const [trackingPath, backup] of Object.entries(backups)) {
      // Keep malformed keys for the frozen completeness check; they provide
      // no trustworthy attribution and must never crash a checkpoint read.
      if (!backup || typeof backup !== 'object' || Array.isArray(backup) ||
        (backup.backupFileName !== null && typeof backup.backupFileName !== 'string')) continue
      const identity = toFileIdentityPath(expandTrackingPath(baseDir, trackingPath), frozen)
      const previous = attributedBackups.get(identity)
      if (previous && previous.backupFileName === backup.backupFileName && previous.version === backup.version) {
        if (!attemptedPaths.has(identity)) delete backups[trackingPath]
      } else {
        attributedBackups.delete(identity)
      }
      if (confirmedPaths.has(identity) && !uncertainPaths.has(identity)) {
        attributedBackups.delete(identity)
        const beforeBytes = await readBackupBytes(sessionId, backup.backupFileName)
        if (beforeBytes !== undefined) {
          // Full Write supplies exact UTF-8 output even when before is binary.
          // Edit replay must never start from replacement-decoded before bytes.
          const beforeText = checkpointText(beforeBytes, true)
          const after = replayKnownTurnFileContent(turn.messages, baseDir, identity, beforeText, frozen)
          if (after !== undefined && !checkpointBytesMatch(beforeBytes, after === null ? null : Buffer.from(after, 'utf-8'))) {
            attributedBackups.set(identity, backup)
          }
        }
      }
    }
    if (snapshot) scopedByMessageId.set(snapshot.messageId, { ...snapshot, trackedFileBackups: backups })
  }
  return snapshots.map((snapshot) => scopedByMessageId.get(snapshot.messageId) ?? snapshot)
}

async function buildTurnCheckpointState(
  sessionId: string,
  activeMessages: MessageEntry[],
  transcriptEvidenceComplete: boolean,
  snapshots: FileHistorySnapshot[] | null,
  workDir: string,
  target: RewindTarget,
): Promise<SessionTurnCheckpointPreview> {
  const userMessages = activeMessages.filter((message) => message.type === 'user')
  const checkpointBaseDir = await resolveCheckpointBaseDir(
    sessionId,
    target.targetUserMessageId,
    workDir,
  )
  const targetSnapshot = snapshots
    ? findTargetSnapshot(snapshots, target.targetUserMessageId)
    : null
  const nextUserMessageId = getNextUserMessageId(userMessages, target.userMessageIndex)
  const nextSnapshot = nextUserMessageId && snapshots
    ? findTargetSnapshot(snapshots, nextUserMessageId)
    : null
  return await buildTurnCheckpointStateFromContext(
    sessionId,
    transcriptEvidenceComplete,
    target,
    checkpointBaseDir,
    targetSnapshot,
    nextSnapshot,
    getTranscriptTurnMessages(activeMessages, target.targetUserMessageId),
  )
}

async function buildTurnCheckpointStateFromContext(
  sessionId: string,
  transcriptEvidenceComplete: boolean,
  target: RewindTarget,
  checkpointBaseDir: string,
  targetSnapshot: FileHistorySnapshot | null,
  nextSnapshot: FileHistorySnapshot | null,
  turnMessages: MessageEntry[],
  signal?: AbortSignal,
  frozen = false,
): Promise<SessionTurnCheckpointPreview> {
  signal?.throwIfAborted()
  const snapshotPreview = targetSnapshot
    ? await buildTurnCodePreview(
      sessionId,
      checkpointBaseDir,
      targetSnapshot,
      nextSnapshot,
      signal,
      frozen,
    )
    : null
  signal?.throwIfAborted()
  const transcriptEvidence = collectTranscriptFileChanges(
    turnMessages,
    checkpointBaseDir,
    frozen,
  )
  const { preview, restoreAvailable, unverifiedChangeSources } = mergeTurnCodePreviews(
    snapshotPreview,
    transcriptEvidence,
    transcriptEvidenceComplete,
    frozen,
  )

  // Completion can safely capture some paths and refuse others. Compare every
  // expected path, rather than treating one successful copy as a complete turn.
  // Only an explicit recorded diff for the same path can cover a missing pair.
  const transcriptDiffPaths = new Set(transcriptEvidence.confirmedChanges.filter(change => change.diff).map(change => change.identityPath))
  const beforeMapMalformed = frozen && targetSnapshot !== null && hasMalformedFileHistoryBefore(targetSnapshot)
  const unavailablePaths = frozen && targetSnapshot
    ? [...new Set([...Object.keys(targetSnapshot.trackedFileBackups), ...Object.keys(targetSnapshot.completedFileBackups ?? {})])].filter(trackingPath => {
      const identityPath = toFileIdentityPath(expandTrackingPath(checkpointBaseDir, trackingPath), true)
      return !snapshotPreview?.coveredPathIdentities.has(identityPath) && !transcriptDiffPaths.has(identityPath)
    }).map(trackingPath => toCheckpointResponsePath(trackingPath, checkpointBaseDir))
    : []
  const boundaryUnavailable = beforeMapMalformed || unavailablePaths.length > 0
  const missingEvidence = [...unavailablePaths, ...(beforeMapMalformed ? ['invalid before-file map'] : [])]
  return buildTurnPreview(
    target,
    boundaryUnavailable ? { ...preview, available: false, reason: `Recorded file history is incomplete for: ${missingEvidence.join(', ')}` } : preview,
    checkpointBaseDir,
    boundaryUnavailable ? false : restoreAvailable,
    boundaryUnavailable ? normalizeUnverifiedChangeSources([...unverifiedChangeSources, ...missingEvidence.map(filePath => `file-history:${filePath}`)]) : unverifiedChangeSources,
  )
}

async function findUnavailableRestorePoints(
  sessionId: string,
  snapshot: FileHistorySnapshot,
  checkpointBaseDir: string,
): Promise<string[]> {
  const unavailable = new Set<string>()
  if (hasMalformedFileHistoryBefore(snapshot)) unavailable.add('invalid before-file map')

  // Validate the original recorded keys, before carried-forward entries are
  // scoped out of the turn preview. Completion keys prove that a path needs a
  // before-state; restoring that state does not require readable after bytes.
  const trackedPaths = new Set([
    ...Object.keys(snapshot.trackedFileBackups),
    ...Object.keys(snapshot.completedFileBackups ?? {}),
  ])
  const backupByIdentity = new Map<string, string | null>()
  for (const trackingPath of trackedPaths) {
    const responsePath = toCheckpointResponsePath(trackingPath, checkpointBaseDir)
    const backup = snapshot.trackedFileBackups[trackingPath]
    if (!backup || typeof backup !== 'object' || Array.isArray(backup) ||
      (backup.backupFileName !== null && typeof backup.backupFileName !== 'string')) {
      unavailable.add(responsePath)
      continue
    }
    const identityPath = toFileIdentityPath(expandTrackingPath(checkpointBaseDir, trackingPath))
    if (backupByIdentity.has(identityPath) && backupByIdentity.get(identityPath) !== backup.backupFileName) {
      unavailable.add(responsePath)
      continue
    }
    backupByIdentity.set(identityPath, backup.backupFileName)
    if (backup.backupFileName !== null) {
      try {
        // Restore is byte-preserving, including binary legacy backups.
        await readBackupFileSafely(backup.backupFileName, sessionId)
      } catch {
        unavailable.add(responsePath)
      }
    }
  }
  return [...unavailable]
}

function buildRewindCodePreviewFromPlan(
  preview: RewindCodePreview,
  plan: RestorePlanEntry[],
): RewindCodePreview {
  const previousStats = preview[fileChangeStats] ?? new Map<string, FileChangeStats>()
  const fileStats = new Map<string, FileChangeStats>()
  for (const entry of plan) {
    const identity = toFileIdentityPath(entry.absolutePath)
    const byteStats = countCheckpointByteDiffStats(
      entry.targetState.exists ? entry.targetState.content : null,
      entry.originalState.exists ? entry.originalState.content : null,
    )
    const recordedStats = previousStats.get(identity)
    fileStats.set(identity, byteStats.textComparable === false || recordedStats?.textComparable === false
      ? byteStats
      : recordedStats ?? byteStats)
  }
  const stats = [...fileStats.values()]
  return normalizeDiffStats({
    filesChanged: plan.map(entry => entry.absolutePath),
    insertions: stats.reduce((total, entry) => total + entry.insertions, 0),
    deletions: stats.reduce((total, entry) => total + entry.deletions, 0),
    fileStats,
  })
}

async function buildRewindTurnCheckpointState(
  sessionId: string,
  activeMessages: MessageEntry[],
  transcriptEvidenceComplete: boolean,
  snapshots: FileHistorySnapshot[] | null,
  workDir: string,
  target: RewindTarget,
): Promise<SessionTurnCheckpointPreview> {
  const scopedSnapshots = await scopeCarriedForwardSnapshots(
    sessionId, snapshots, activeMessages, transcriptEvidenceComplete, workDir,
  )
  const userMessages = activeMessages.filter((message) => message.type === 'user')
  const checkpoints: SessionTurnCheckpointPreview[] = []
  const unavailableRestorePoints = new Set<string>()

  for (let userMessageIndex = target.userMessageIndex;
    userMessageIndex < userMessages.length;
    userMessageIndex += 1) {
    const userMessage = userMessages[userMessageIndex]
    if (!userMessage) continue
    const checkpoint = await buildTurnCheckpointState(
      sessionId,
      activeMessages,
      transcriptEvidenceComplete,
      scopedSnapshots,
      workDir,
      {
        targetUserMessageId: userMessage.id,
        userMessageIndex,
        userMessageCount: userMessages.length,
        messagesRemoved: target.messagesRemoved,
      },
    )
    checkpoints.push(checkpoint)
    const snapshot = snapshots ? findTargetSnapshot(snapshots, userMessage.id) : null
    if (snapshot) {
      for (const unavailable of await findUnavailableRestorePoints(sessionId, snapshot, checkpoint.workDir)) {
        unavailableRestorePoints.add(unavailable)
      }
    }
  }

  const [firstCheckpoint, ...laterCheckpoints] = checkpoints
  if (!firstCheckpoint) {
    return await buildTurnCheckpointState(
      sessionId,
      activeMessages,
      transcriptEvidenceComplete,
      scopedSnapshots,
      workDir,
      target,
    )
  }
  let code = laterCheckpoints.reduce(
    (preview, checkpoint) => mergeRewindCodePreview(preview, checkpoint.code),
    firstCheckpoint.code,
  )
  const restorePointsComplete = unavailableRestorePoints.size === 0
  let restoreAvailable = restorePointsComplete && checkpoints.every((checkpoint) => checkpoint.restoreAvailable)
  const targetSnapshot = snapshots ? findTargetSnapshot(snapshots, target.targetUserMessageId) : null
  if (restoreAvailable && code.available && snapshots && targetSnapshot) {
    try {
      // Turn boundaries identify candidates. The actual before/current byte
      // states decide which candidates a rewind would write, including net
      // no-ops across several turns. Execution repeats writable preflight.
      const plan = await buildRestorePlan(sessionId, firstCheckpoint.workDir, snapshots, targetSnapshot, code.filesChanged, false)
      code = buildRewindCodePreviewFromPlan(code, plan)
    } catch {
      restoreAvailable = false
      code = { ...code, available: false, reason: 'The checkpoint could not be prepared safely.' }
    }
  }
  return {
    ...firstCheckpoint,
    code: restorePointsComplete ? code : {
      ...code,
      available: false,
      reason: `Recorded restore points are incomplete for: ${[...unavailableRestorePoints].join(', ')}`,
    },
    restoreAvailable,
    unverifiedChangeSources: normalizeUnverifiedChangeSources(
      [
        ...checkpoints.flatMap((checkpoint) => checkpoint.unverifiedChangeSources),
        ...[...unavailableRestorePoints].map(filePath => `file-history:${filePath}`),
      ],
    ),
  }
}

function mergeRewindCodePreview(
  rewindPreview: RewindCodePreview,
  turnPreview: RewindCodePreview,
): RewindCodePreview {
  if (!rewindPreview.available) return turnPreview
  if (!turnPreview.available) return rewindPreview

  const knownPathIdentities = new Set(
    rewindPreview.filesChanged.map((filePath) => toFileIdentityPath(filePath)),
  )
  const missingPaths = turnPreview.filesChanged.filter((filePath) =>
    !knownPathIdentities.has(toFileIdentityPath(filePath))
  )
  const turnFileStats = turnPreview[fileChangeStats] ?? new Map()
  const mergedFileStats = new Map(rewindPreview[fileChangeStats] ?? [])
  let missingInsertions = 0
  let missingDeletions = 0
  for (const filePath of missingPaths) {
    const stats = turnFileStats.get(toFileIdentityPath(filePath))
    if (stats) mergedFileStats.set(toFileIdentityPath(filePath), stats)
    missingInsertions += stats?.insertions ?? 0
    missingDeletions += stats?.deletions ?? 0
  }

  return normalizeDiffStats({
    filesChanged: [...rewindPreview.filesChanged, ...missingPaths],
    insertions: rewindPreview.insertions + missingInsertions,
    deletions: rewindPreview.deletions + missingDeletions,
    fileStats: mergedFileStats,
  })
}

export async function previewSessionRewind(
  sessionId: string,
  selector: RewindTargetSelector,
): Promise<SessionRewindPreview> {
  const target = await resolveRewindTarget(sessionId, selector)
  const {
    messages: activeMessages,
    transcriptEvidenceComplete,
  } = await sessionService.getSessionMessagesWithEvidence(sessionId)
  const snapshots = await loadFileHistorySnapshots(sessionId)
  const workDir = await resolveSessionWorkDir(sessionId)
  const checkpointBaseDir = await resolveCheckpointBaseDir(
    sessionId,
    target.targetUserMessageId,
    workDir,
  )
  const codePreview = await buildCodePreview(
    sessionId,
    checkpointBaseDir,
    target.targetUserMessageId,
  )
  const turnCheckpoint = await buildRewindTurnCheckpointState(
    sessionId,
    activeMessages,
    transcriptEvidenceComplete,
    snapshots,
    workDir,
    target,
  )

  const hasTurnScopedPreview = turnCheckpoint.code.available || !turnCheckpoint.restoreAvailable
  return {
    target: {
      targetUserMessageId: target.targetUserMessageId,
      userMessageIndex: target.userMessageIndex,
      userMessageCount: target.userMessageCount,
    },
    conversation: {
      messagesRemoved: target.messagesRemoved,
    },
    code: hasTurnScopedPreview ? turnCheckpoint.code : codePreview.preview,
    restoreAvailable: hasTurnScopedPreview
      ? turnCheckpoint.restoreAvailable
      : codePreview.restoreAvailable,
    unverifiedChangeSources: turnCheckpoint.unverifiedChangeSources,
  }
}

export async function listSessionTurnCheckpoints(
  sessionId: string,
  signal?: AbortSignal,
  frozen = false,
): Promise<SessionTurnCheckpointPreview[]> {
  const {
    messages: activeMessages,
    transcriptEvidenceComplete,
  } = await sessionService.getSessionMessagesWithEvidence(sessionId)
  signal?.throwIfAborted()
  const turns = buildTranscriptTurnContexts(activeMessages)
  if (turns.length === 0) {
    return []
  }

  const workDir = await resolveSessionWorkDir(sessionId)
  const snapshots = await scopeCarriedForwardSnapshots(
    sessionId, await loadFileHistorySnapshots(sessionId), activeMessages, transcriptEvidenceComplete, workDir, frozen,
  )
  signal?.throwIfAborted()
  const snapshotByMessageId = new Map<string, FileHistorySnapshot>()
  for (const snapshot of snapshots ?? []) {
    snapshotByMessageId.set(snapshot.messageId, snapshot)
  }
  const checkpoints: SessionTurnCheckpointPreview[] = []

  for (const turn of turns) {
    signal?.throwIfAborted()
    if (!turn.completed) continue

    const target: RewindTarget = {
      targetUserMessageId: turn.userMessage.id,
      userMessageIndex: turn.userMessageIndex,
      userMessageCount: turns.length,
      messagesRemoved: activeMessages.length - turn.activeMessageIndex,
    }
    const nextUserMessageId = turns[turn.userMessageIndex + 1]?.userMessage.id
    // `getSessionMessagesWithEvidence` already preserved this entry's cwd. Using
    // it here avoids reading and parsing the complete JSONL again for every turn.
    const checkpoint = await buildTurnCheckpointStateFromContext(
      sessionId,
      transcriptEvidenceComplete,
      target,
      turn.userMessage.cwd ?? workDir,
      snapshotByMessageId.get(turn.userMessage.id) ?? null,
      nextUserMessageId ? snapshotByMessageId.get(nextUserMessageId) ?? null : null,
      turn.messages,
      signal,
      frozen,
    )

    checkpoints.push(checkpoint)
  }

  return checkpoints
}

export async function getSessionTurnCheckpointDiff(
  sessionId: string,
  selector: RewindTargetSelector,
  requestedPath: string,
  frozen = false,
): Promise<SessionTurnCheckpointDiffResult> {
  const target = await resolveRewindTarget(sessionId, selector)
  if (frozen && ((selector.targetUserMessageId && selector.targetUserMessageId !== target.targetUserMessageId) || (selector.userMessageIndex !== undefined && selector.userMessageIndex !== target.userMessageIndex))) {
    throw ApiError.badRequest('The recorded checkpoint identity no longer matches this turn')
  }
  const workDir = await resolveSessionWorkDir(sessionId)
  const checkpointBaseDir = await resolveCheckpointBaseDir(
    sessionId,
    target.targetUserMessageId,
    workDir,
  )
  const { messages: activeMessages, transcriptEvidenceComplete } =
    await sessionService.getSessionMessagesWithEvidence(sessionId)
  const snapshots = await scopeCarriedForwardSnapshots(
    sessionId, await loadFileHistorySnapshots(sessionId), activeMessages, transcriptEvidenceComplete, workDir, frozen,
  )
  const missingResult = {
    target: buildTurnPreview(
      target,
      {
        available: false,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      },
      checkpointBaseDir,
    ).target,
    workDir: checkpointBaseDir,
    path: normalizeComparablePath(requestedPath),
    state: 'missing' as const,
  }
  const transcriptChange = findTranscriptTurnDiff(
    activeMessages,
    target.targetUserMessageId,
    checkpointBaseDir,
    requestedPath,
    frozen,
  )
  const transcriptResult = transcriptChange?.diff
    ? {
        target: missingResult.target,
        workDir: checkpointBaseDir,
        path: transcriptChange.path,
        state: 'ok' as const,
        diff: transcriptChange.diff,
      }
    : null

  if (!snapshots) {
    return transcriptResult ?? missingResult
  }

  const targetSnapshot = findTargetSnapshot(snapshots, target.targetUserMessageId)
  if (!targetSnapshot) {
    return transcriptResult ?? missingResult
  }
  const userMessages = activeMessages.filter((message) => message.type === 'user')
  const nextUserMessageId = getNextUserMessageId(userMessages, target.userMessageIndex)
  const nextSnapshot = nextUserMessageId
    ? findTargetSnapshot(snapshots, nextUserMessageId)
    : null

  const inspectedPathIdentities = new Set<string>()
  for (const trackingPath of Object.keys(targetSnapshot.trackedFileBackups)) {
    const identityPath = toFileIdentityPath(
      expandTrackingPath(checkpointBaseDir, trackingPath),
      frozen,
    )
    if (inspectedPathIdentities.has(identityPath)) continue
    inspectedPathIdentities.add(identityPath)
    if (!matchesCheckpointPath(requestedPath, trackingPath, checkpointBaseDir)) {
      continue
    }

    const displayPath = toCheckpointResponsePath(trackingPath, checkpointBaseDir)

    try {
      const { beforeContent, afterContent, afterBoundaryAvailable, changed, textComparable } =
        await (frozen ? getFrozenTurnBoundaryContents : getTurnBoundaryContents)(
        sessionId,
        checkpointBaseDir,
        trackingPath,
        targetSnapshot,
        nextSnapshot,
      )

      if (!afterBoundaryAvailable) {
        return transcriptResult ?? {
          ...missingResult,
          path: displayPath,
        }
      }
      if (!changed) {
        return {
          ...missingResult,
          path: displayPath,
        }
      }
      if (!textComparable) {
        return {
          ...missingResult,
          path: displayPath,
          error: 'This file cannot be compared as UTF-8 text.',
        }
      }

      return {
        target: missingResult.target,
        workDir: checkpointBaseDir,
        path: displayPath,
        state: 'ok',
        diff: buildCheckpointDiff(
          displayPath,
          beforeContent ?? '',
          afterContent ?? '',
          beforeContent !== null,
          afterContent !== null,
        ),
      }
    } catch (error) {
      return {
        target: missingResult.target,
        workDir: checkpointBaseDir,
        path: displayPath,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return transcriptResult ?? missingResult
}

export async function executeSessionRewind(
  sessionId: string,
  selector: RewindTargetSelector,
  mode: SessionRewindMode = 'both',
): Promise<SessionRewindExecuteResult> {
  const restoreFiles = mode === 'both'
  const selectedTarget = await resolveRewindTarget(sessionId, selector)

  // Stop and drain the runtime before the final completeness check. Otherwise
  // a late tool result or snapshot can land between validation and restore.
  await conversationService.stopSessionAndWait(sessionId)

  const target = await resolveRewindTarget(sessionId, {
    targetUserMessageId: selectedTarget.targetUserMessageId,
    expectedContent: selector.expectedContent,
  })
  const {
    messages: activeMessages,
    transcriptEvidenceComplete,
  } = await sessionService.getSessionMessagesWithEvidence(sessionId)
  const snapshots = await loadFileHistorySnapshots(sessionId)
  const workDir = await resolveSessionWorkDir(sessionId)
  const turnCheckpoint = await buildRewindTurnCheckpointState(
    sessionId,
    activeMessages,
    transcriptEvidenceComplete,
    snapshots,
    workDir,
    target,
  )
  if (restoreFiles && !turnCheckpoint.restoreAvailable) {
    throw ApiError.badRequest(
      'This turn includes file changes without a complete restorable checkpoint. No messages or files were changed.',
    )
  }
  const checkpointBaseDir = await resolveCheckpointBaseDir(
    sessionId,
    target.targetUserMessageId,
    workDir,
  )
  const codePreview = await buildCodePreview(
    sessionId,
    checkpointBaseDir,
    target.targetUserMessageId,
  )
  const hasTurnScopedPreview = turnCheckpoint.code.available || !turnCheckpoint.restoreAvailable
  if (restoreFiles && !hasTurnScopedPreview && !codePreview.restoreAvailable) {
    throw ApiError.badRequest(
      'One or more tracked files cannot be safely restored from this checkpoint. No messages or files were changed.',
    )
  }
  const preview = hasTurnScopedPreview ? turnCheckpoint.code : codePreview.preview

  let appliedRestorePlan: RestorePlanEntry[] = []
  if (restoreFiles && preview.available && snapshots) {
    const targetSnapshot = findTargetSnapshot(snapshots, target.targetUserMessageId)
    if (!targetSnapshot) {
      throw ApiError.badRequest('No file checkpoint is available for the selected message.')
    }
    try {
      appliedRestorePlan = await buildRestorePlan(
        sessionId,
        checkpointBaseDir,
        snapshots,
        targetSnapshot,
        preview.filesChanged,
      )
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw ApiError.badRequest(
        'The checkpoint could not be prepared safely. No messages or files were changed.',
      )
    }
    await applyRestorePlan(checkpointBaseDir, appliedRestorePlan)
  }

  let trimResult: Awaited<ReturnType<typeof sessionService.trimSessionMessagesFrom>>
  try {
    trimResult = await sessionService.trimSessionMessagesFrom(
      sessionId,
      target.targetUserMessageId,
    )
  } catch (error) {
    const rollbackErrors = await rollbackRestorePlan(
      checkpointBaseDir,
      appliedRestorePlan,
    )
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Transcript trim failed and file rollback was incomplete: ${rollbackErrors.join('; ')}`,
        { cause: error },
      )
    }
    throw error
  }

  return {
    target: {
      targetUserMessageId: target.targetUserMessageId,
      userMessageIndex: target.userMessageIndex,
      userMessageCount: target.userMessageCount,
    },
    conversation: {
      messagesRemoved: trimResult.removedCount,
      removedMessageIds: trimResult.removedMessageIds,
    },
    code: preview,
    // For `both` this is necessarily true — we threw above otherwise. For
    // `conversation` it reports whether the files *could* have been restored,
    // so the caller can tell "user chose not to" from "we could not".
    restoreAvailable: hasTurnScopedPreview
      ? turnCheckpoint.restoreAvailable
      : codePreview.restoreAvailable,
    unverifiedChangeSources: turnCheckpoint.unverifiedChangeSources,
    mode,
  }
}
