import { randomUUID, type UUID } from 'crypto'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import * as path from 'node:path'
import type {
  AttributionSnapshotMessage,
  PersistedWorktreeSession,
  SerializedMessage,
  TranscriptMessage,
} from '../types/logs.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { parseJSONL } from './json.js'
import { buildConversationChain, loadTranscriptFile } from './sessionStorage.js'
import { jsonStringify } from './slowOperations.js'
import { escapeRegExp } from './stringUtils.js'
import { inferSessionApiFormat } from '../server/services/sessionProtocolHistory.js'

type SessionMetaEntry = {
  type: 'session-meta'
  isMeta?: boolean
  workDir?: string
  repository?: unknown
  timestamp?: string
  [key: string]: unknown
}

type WorktreeStateEntry = {
  type: 'worktree-state'
  sessionId: string
  worktreeSession: PersistedWorktreeSession | null
  [key: string]: unknown
}

type ModeEntry = {
  type: 'mode'
  sessionId: string
  mode: string
  [key: string]: unknown
}

type PrLinkEntry = {
  type: 'pr-link'
  sessionId: string
  prNumber: number
  prUrl: string
  prRepository: string
  timestamp: string
  [key: string]: unknown
}

type FileHistorySnapshotEntry = {
  type: 'file-history-snapshot'
  messageId: string
  snapshot?: {
    messageId?: string
    trackedFileBackups?: Record<string, unknown>
    timestamp?: string
  }
  [key: string]: unknown
}

type ContentReplacementEntry = {
  type: 'content-replacement'
  sessionId: string
  replacements: ContentReplacementRecord[]
  [key: string]: unknown
}

type TranscriptEntry = TranscriptMessage & {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

type RawEntry =
  | SessionMetaEntry
  | WorktreeStateEntry
  | ModeEntry
  | PrLinkEntry
  | FileHistorySnapshotEntry
  | AttributionSnapshotMessage
  | ContentReplacementEntry
  | Record<string, unknown>

export type SessionBranchResult = {
  sessionId: UUID
  title: string
  forkPath: string
  workDir: string | null
  serializedMessages: SerializedMessage[]
  contentReplacementRecords: ContentReplacementRecord[]
}

export type CreateSessionBranchOptions = {
  sourceSessionId: string
  sourceTranscriptPath: string
  title?: string
  targetMessageId?: string
  sourceWorkDir?: string | null
  sourceRepository?: unknown
  sourceWorktreeSession?: PersistedWorktreeSession | null
}

export class SessionBranchingError extends Error {
  constructor(
    readonly code:
      | 'SOURCE_NOT_FOUND'
      | 'INVALID_TARGET'
      | 'NO_BRANCHABLE_MESSAGES',
    message: string,
  ) {
    super(message)
    this.name = 'SessionBranchingError'
  }
}

function isTranscriptEntry(entry: RawEntry): entry is TranscriptMessage {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry.type === 'user' ||
      entry.type === 'assistant' ||
      entry.type === 'attachment' ||
      entry.type === 'system') &&
    typeof (entry as TranscriptMessage).uuid === 'string'
  )
}

function isSessionMetaEntry(entry: RawEntry): entry is SessionMetaEntry {
  return entry.type === 'session-meta'
}

function isWorktreeStateEntry(entry: RawEntry): entry is WorktreeStateEntry {
  return entry.type === 'worktree-state'
}

function isModeEntry(entry: RawEntry): entry is ModeEntry {
  return entry.type === 'mode'
}

function isPrLinkEntry(entry: RawEntry): entry is PrLinkEntry {
  return entry.type === 'pr-link'
}

function isFileHistorySnapshotEntry(entry: RawEntry): entry is FileHistorySnapshotEntry {
  return entry.type === 'file-history-snapshot'
}

function isAttributionSnapshotEntry(entry: RawEntry): entry is AttributionSnapshotMessage {
  return entry.type === 'attribution-snapshot'
}

function getSnapshotMessageId(entry: FileHistorySnapshotEntry): string | null {
  if (typeof entry.snapshot?.messageId === 'string') return entry.snapshot.messageId
  if (typeof entry.messageId === 'string') return entry.messageId
  return null
}

function getAttributionMessageId(entry: AttributionSnapshotMessage): string | null {
  return typeof entry.messageId === 'string' ? entry.messageId : null
}

function findLatestActiveLeaf(
  messages: Map<UUID, TranscriptMessage>,
  leafUuids: Set<UUID>,
): TranscriptMessage | undefined {
  let latest: TranscriptMessage | undefined
  let latestTimestamp = -Infinity

  const candidates = leafUuids.size > 0
    ? [...leafUuids]
      .map((uuid) => messages.get(uuid))
      .filter((message): message is TranscriptMessage => !!message)
    : [...messages.values()]

  for (const message of candidates) {
    if (message.isSidechain) continue
    const timestamp = Date.parse(message.timestamp)
    if (timestamp >= latestTimestamp) {
      latest = message
      latestTimestamp = timestamp
    }
  }

  return latest
}

function extractToolResultIds(message: TranscriptMessage): string[] {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return []
  }

  return message.message.content.flatMap((block) => (
    block.type === 'tool_result' && typeof block.tool_use_id === 'string'
      ? [block.tool_use_id]
      : []
  ))
}

async function readRawEntries(filePath: string): Promise<RawEntry[]> {
  const content = await readFile(filePath)
  return parseJSONL<RawEntry>(content)
}

async function listExistingTitles(projectDirPath: string): Promise<string[]> {
  let dirents: import('fs').Dirent[]
  try {
    dirents = await readdir(projectDirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const titles: string[] = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue
    try {
      const entries = await readRawEntries(path.join(projectDirPath, dirent.name))
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (
          entry?.type === 'custom-title' &&
          typeof (entry as Record<string, unknown>).customTitle === 'string'
        ) {
          titles.push((entry as Record<string, unknown>).customTitle as string)
          break
        }
      }
    } catch {
      continue
    }
  }

  return titles
}

export function deriveFirstPrompt(
  firstUserMessage: Extract<SerializedMessage, { type: 'user' }> | undefined,
): string {
  const content = firstUserMessage?.message?.content
  if (!content) return 'Branched conversation'
  const raw =
    typeof content === 'string'
      ? content
      : content.find(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )?.text
  if (!raw) return 'Branched conversation'
  return (
    raw.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Branched conversation'
  )
}

export async function getUniqueForkName(
  baseName: string,
  projectDirPath: string,
): Promise<string> {
  const existingTitles = new Set(
    (await listExistingTitles(projectDirPath))
      .map((title) => title.trim())
      .filter(Boolean),
  )

  const candidateName = `${baseName} (Branch)`
  if (!existingTitles.has(candidateName)) {
    return candidateName
  }

  const usedNumbers = new Set<number>([1])
  const forkNumberPattern = new RegExp(
    `^${escapeRegExp(baseName)} \\(Branch(?: (\\d+))?\\)$`,
  )

  for (const title of existingTitles) {
    const match = title.match(forkNumberPattern)
    if (!match) continue
    usedNumbers.add(match[1] ? parseInt(match[1], 10) : 1)
  }

  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) {
    nextNumber++
  }
  return `${baseName} (Branch ${nextNumber})`
}

function buildPreservedMetadataEntries(
  sourceEntries: RawEntry[],
  copiedMessageIds: Set<string>,
  forkSessionId: UUID,
): RawEntry[] {
  return sourceEntries.flatMap((entry) => {
    if (isSessionMetaEntry(entry)) {
      return [entry]
    }

    if (isWorktreeStateEntry(entry) && entry.worktreeSession) {
      return [{
        ...entry,
        sessionId: forkSessionId,
        worktreeSession: {
          ...entry.worktreeSession,
          sessionId: forkSessionId,
        },
      }]
    }

    if (isModeEntry(entry)) {
      return [{ ...entry, sessionId: forkSessionId }]
    }

    if (isPrLinkEntry(entry)) {
      return [{ ...entry, sessionId: forkSessionId }]
    }

    if (isFileHistorySnapshotEntry(entry)) {
      const messageId = getSnapshotMessageId(entry)
      return messageId && copiedMessageIds.has(messageId) ? [entry] : []
    }

    if (isAttributionSnapshotEntry(entry)) {
      const messageId = getAttributionMessageId(entry)
      return messageId && copiedMessageIds.has(messageId) ? [entry] : []
    }

    return []
  })
}

function ensureSyntheticSessionMeta(
  preservedMetadataEntries: RawEntry[],
  sourceWorkDir: string | null | undefined,
  sourceRepository: unknown,
): RawEntry[] {
  const hasSessionMeta = preservedMetadataEntries.some(isSessionMetaEntry)
  if (hasSessionMeta || (!sourceWorkDir && sourceRepository === undefined)) {
    return preservedMetadataEntries
  }

  return [{
    type: 'session-meta',
    isMeta: true,
    ...(sourceWorkDir ? { workDir: sourceWorkDir } : {}),
    ...(sourceRepository !== undefined ? { repository: sourceRepository } : {}),
    timestamp: new Date().toISOString(),
  }, ...preservedMetadataEntries]
}

function ensureSyntheticWorktreeState(
  preservedMetadataEntries: RawEntry[],
  forkSessionId: UUID,
  sourceWorktreeSession: PersistedWorktreeSession | null | undefined,
): RawEntry[] {
  const hasWorktreeState = preservedMetadataEntries.some(isWorktreeStateEntry)
  if (hasWorktreeState || !sourceWorktreeSession) {
    return preservedMetadataEntries
  }

  return [{
    type: 'worktree-state',
    sessionId: forkSessionId,
    worktreeSession: {
      ...sourceWorktreeSession,
      sessionId: forkSessionId,
    },
  }, ...preservedMetadataEntries]
}

export async function createSessionBranch(
  options: CreateSessionBranchOptions,
): Promise<SessionBranchResult> {
  const {
    sourceSessionId,
    sourceTranscriptPath,
    title,
    targetMessageId,
    sourceWorkDir,
    sourceRepository,
    sourceWorktreeSession,
  } = options

  const projectDirPath = path.dirname(sourceTranscriptPath)
  const sourceEntries = await readRawEntries(sourceTranscriptPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SessionBranchingError(
        'SOURCE_NOT_FOUND',
        `Session not found: ${sourceSessionId}`,
      )
    }
    throw error
  })

  const transcript = await loadTranscriptFile(sourceTranscriptPath, {
    keepAllLeaves: true,
  })
  const activeLeaf = findLatestActiveLeaf(transcript.messages, transcript.leafUuids)
  if (!activeLeaf) {
    throw new SessionBranchingError(
      'NO_BRANCHABLE_MESSAGES',
      'No conversation to branch',
    )
  }

  const activeChain = buildConversationChain(transcript.messages, activeLeaf)
    .filter((message) => !message.isSidechain)

  if (activeChain.length === 0) {
    throw new SessionBranchingError(
      'NO_BRANCHABLE_MESSAGES',
      'No conversation to branch',
    )
  }

  const targetIndex = targetMessageId
    ? activeChain.findIndex((message) => message.uuid === targetMessageId)
    : activeChain.length - 1

  if (targetIndex < 0) {
    throw new SessionBranchingError(
      'INVALID_TARGET',
      'targetMessageId must reference a main conversation message in the active chain',
    )
  }

  const copiedMessages = activeChain.slice(0, targetIndex + 1)
  if (copiedMessages.length === 0) {
    throw new SessionBranchingError(
      'NO_BRANCHABLE_MESSAGES',
      'No messages to branch',
    )
  }

  const copiedMessageIds = new Set(copiedMessages.map((message) => message.uuid))
  const sourceMessageEntriesById = new Map(
    sourceEntries
      .filter(
        (entry): entry is TranscriptMessage =>
          isTranscriptEntry(entry) &&
          entry.isSidechain !== true &&
          copiedMessageIds.has(entry.uuid),
      )
      .map((entry) => [entry.uuid, entry]),
  )
  const branchMessageEntries = copiedMessages.flatMap((message) => {
    const entry = sourceMessageEntriesById.get(message.uuid)
    return entry ? [entry] : []
  })

  if (branchMessageEntries.length === 0) {
    throw new SessionBranchingError(
      'NO_BRANCHABLE_MESSAGES',
      'No messages to branch',
    )
  }

  // Provider snapshots describe the messages that follow them. Hoisting every
  // session-meta record to the header would assign the final provider to all
  // inherited replies. Keep those records next to the copied message that
  // originally followed them, while preserving the active chain's message order.
  const metadataBeforeMessage = new Map<string, SessionMetaEntry[]>()
  let trailingSessionMetadata: SessionMetaEntry[] = []
  const inheritedProtocolEntries: Parameters<typeof inferSessionApiFormat>[0] = []
  for (const entry of sourceEntries) {
    if (isSessionMetaEntry(entry)) {
      trailingSessionMetadata.push(entry)
      inheritedProtocolEntries.push(entry)
    } else if (isTranscriptEntry(entry) && sourceMessageEntriesById.get(entry.uuid) === entry) {
      metadataBeforeMessage.set(entry.uuid, trailingSessionMetadata)
      trailingSessionMetadata = []
      inheritedProtocolEntries.push(entry)
    }
  }
  // Include explicit parent locks even if they were appended after the target.
  // Later provider selections alone do not count as using that protocol.
  const inheritedApiFormat = inferSessionApiFormat(inheritedProtocolEntries)

  const copiedToolResultIds = new Set(
    copiedMessages.flatMap((message) => extractToolResultIds(message)),
  )
  const contentReplacementRecords = (
    transcript.contentReplacements.get(sourceSessionId as UUID) ?? []
  ).filter((record) => copiedToolResultIds.has(record.toolUseId))

  const forkSessionId = randomUUID() as UUID
  const forkPath = path.join(projectDirPath, `${forkSessionId}.jsonl`)
  await mkdir(projectDirPath, { recursive: true, mode: 0o700 })

  const serializedMessages: SerializedMessage[] = []
  const messageLines: string[] = []
  let parentUuid: UUID | null = null

  for (const entry of branchMessageEntries) {
    messageLines.push(...(metadataBeforeMessage.get(entry.uuid) ?? []).map(metadata => jsonStringify(metadata)))
    const forkedEntry: TranscriptEntry = {
      ...entry,
      sessionId: forkSessionId,
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId: sourceSessionId,
        messageUuid: entry.uuid,
      },
    }

    serializedMessages.push({
      ...entry,
      sessionId: forkSessionId,
    })
    messageLines.push(jsonStringify(forkedEntry))
    parentUuid = entry.uuid
  }

  const firstPrompt = deriveFirstPrompt(
    serializedMessages.find(
      (message): message is Extract<SerializedMessage, { type: 'user' }> =>
        message.type === 'user',
    ),
  )
  const effectiveTitle = await getUniqueForkName(title ?? firstPrompt, projectDirPath)

  let metadataEntries = buildPreservedMetadataEntries(
    sourceEntries,
    copiedMessageIds,
    forkSessionId,
  )
  metadataEntries = ensureSyntheticSessionMeta(
    metadataEntries,
    sourceWorkDir ?? null,
    sourceRepository,
  )
  metadataEntries = ensureSyntheticWorktreeState(
    metadataEntries,
    forkSessionId,
    sourceWorktreeSession,
  )

  const lines = [
    // Only synthesized session metadata belongs in the header; source records
    // retain their relationship to the inherited messages above.
    ...metadataEntries
      .filter(entry => !isSessionMetaEntry(entry) || !sourceEntries.includes(entry))
      .map((entry) => jsonStringify(entry)),
    ...messageLines,
    ...trailingSessionMetadata.map(entry => jsonStringify(entry)),
  ]

  if (inheritedApiFormat) {
    lines.push(jsonStringify({
      type: 'session-meta',
      isMeta: true,
      sessionApiFormat: inheritedApiFormat,
      timestamp: new Date().toISOString(),
    }))
  }

  if (contentReplacementRecords.length > 0) {
    lines.push(jsonStringify({
      type: 'content-replacement',
      sessionId: forkSessionId,
      replacements: contentReplacementRecords,
    } satisfies ContentReplacementEntry))
  }

  lines.push(jsonStringify({
    type: 'custom-title',
    sessionId: forkSessionId,
    customTitle: effectiveTitle,
  }))

  await writeFile(forkPath, `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })

  const workDirFromMetadata =
    (
      metadataEntries.find(isSessionMetaEntry)?.workDir as string | undefined
    ) ??
    sourceWorkDir ??
    branchMessageEntries.findLast((entry) => typeof entry.cwd === 'string')?.cwd ??
    null

  return {
    sessionId: forkSessionId,
    title: effectiveTitle,
    forkPath,
    workDir: workDirFromMetadata,
    serializedMessages,
    contentReplacementRecords,
  }
}
