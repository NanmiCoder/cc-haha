import { forkSession, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { link, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getUniqueForkName, SessionBranchingError } from '../../utils/sessionBranching.js'
import { loadTranscriptFile } from '../../utils/sessionStorage.js'
import type { SessionLaunchInfo } from './sessionService.js'
import { markAgentSdkSession } from './officialAgentSdkRuntime.js'
import { prepareLegacyAgentSdkImport } from './officialAgentSdkImport.js'

export async function getOfficialAgentSdkSideChatBoundary(filePath: string): Promise<string | undefined> {
  const { messages } = await loadTranscriptFile(filePath, { keepAllLeaves: true })
  const parents = new Set([...messages.values()].map(entry => entry.parentUuid))
  let latest: { uuid: string; timestamp: number } | undefined
  for (const entry of messages.values()) {
    if (entry.isSidechain || parents.has(entry.uuid)) continue
    const visited = new Set<string>()
    let ancestor: typeof entry | undefined = entry
    let hasConversation = false
    while (ancestor && !visited.has(ancestor.uuid)) {
      visited.add(ancestor.uuid)
      if (ancestor.isSidechain) break
      if (ancestor.type === 'user' || ancestor.type === 'assistant') { hasConversation = true; break }
      ancestor = ancestor.parentUuid ? messages.get(ancestor.parentUuid) : undefined
    }
    const timestamp = Date.parse(entry.timestamp)
    if (hasConversation && Number.isFinite(timestamp) && (!latest || timestamp >= latest.timestamp)) {
      latest = { uuid: entry.uuid, timestamp }
    }
  }
  return latest?.uuid
}

/** A UI turn can contain invisible native chain entries (tool carriers,
 * attachments, compaction boundaries). Trim those with the selected turn,
 * while retaining settings/title records that may have been appended later. */
export function officialAgentSdkRewindFilter(
  entries: Array<{ type?: string; uuid?: string; [key: string]: unknown }>,
  startMessageId: string,
): (entry: { type?: string; uuid?: string; [key: string]: unknown }) => boolean {
  const boundary = entries.findIndex(entry => entry.uuid === startMessageId)
  if (boundary < 0) throw new Error('Official SDK rewind boundary is missing')
  const chainTypes = new Set(['user', 'assistant', 'system', 'attachment', 'progress'])
  const removed = new Set(entries.slice(boundary).filter(entry => chainTypes.has(entry.type ?? '')).map(entry => entry.uuid).filter(Boolean))
  let line = 0
  return entry => {
    const index = line++
    if (chainTypes.has(entry.type ?? '')) return index < boundary
    if (entry.type === 'file-history-snapshot') {
      const snapshot = entry.snapshot as { messageId?: string } | undefined
      return !removed.has(snapshot?.messageId ?? entry.messageId as string)
    }
    if (typeof entry.leafUuid === 'string') return !removed.has(entry.leafUuid)
    return true
  }
}

/** Let the official SDK remap native chain/compaction references, without its
 * process-global filesystem lookup or an API request. Desktop metadata is
 * outside the SDK's transcript schema and is carried over separately. */
export async function createOfficialAgentSdkBranch(options: {
  sourceSessionId: string
  launchInfo: SessionLaunchInfo
  targetMessageId: string
  title?: string
  importContext?: { providerId: string; modelId: string; legacy: boolean }
}): Promise<{ sessionId: string; title: string; workDir: string; forkPath: string }> {
  const { sourceSessionId, launchInfo, targetMessageId } = options
  let source: SessionStoreEntry[]
  try {
    const raw = await readFile(launchInfo.filePath, 'utf8')
    source = raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SessionBranchingError('SOURCE_NOT_FOUND', `Session not found: ${sourceSessionId}`)
    }
    throw error
  }
  if (!source.some(entry => entry.uuid === targetMessageId && !entry.isSidechain &&
    ['user', 'assistant', 'system', 'attachment'].includes(entry.type))) {
    throw new SessionBranchingError('INVALID_TARGET', 'targetMessageId must reference a main conversation message')
  }
  const titleBase = options.title || launchInfo.customTitle || 'Conversation'
  const title = await getUniqueForkName(options.importContext ? `${titleBase} (Agent SDK)` : titleBase, dirname(launchInfo.filePath))
  let entries: SessionStoreEntry[] = []
  const result = await forkSession(sourceSessionId, {
    dir: launchInfo.workDir,
    upToMessageId: targetMessageId,
    title,
    sessionStore: {
      async load(key) { return key.sessionId === sourceSessionId ? source : null },
      async append(_key, values) { entries.push(...values) },
    },
  })
  if (entries.length === 0) throw new Error('Official SDK produced an empty session branch')
  if (options.importContext?.legacy) entries = prepareLegacyAgentSdkImport(entries)
  // Native forkSession intentionally drops old file-history snapshots. They
  // refer to the parent's session directory and must never become child undo.
  const metadata: SessionStoreEntry[] = options.importContext ? [{
    type: 'session-meta', isMeta: true, workDir: launchInfo.workDir,
    ...(launchInfo.repository ? { repository: launchInfo.repository } : {}),
    runtimeProviderId: options.importContext.providerId, runtimeModelId: options.importContext.modelId,
    permissionMode: 'default',
    importedFrom: { sessionId: sourceSessionId, messageId: targetMessageId, runtime: options.importContext.legacy ? 'claude-code' : 'agent-sdk' },
  }] : source.filter(entry => entry.type === 'session-meta').map(entry => ({
    ...entry,
    ...(entry.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
  }))
  if (metadata.length === 0) metadata.push({ type: 'session-meta', isMeta: true, workDir: launchInfo.workDir })
  const worktree = source.findLast(entry => entry.type === 'worktree-state')
  if (worktree && worktree.worktreeSession && typeof worktree.worktreeSession === 'object') {
    metadata.push({ ...worktree, sessionId: result.sessionId, worktreeSession: { ...worktree.worktreeSession, sessionId: result.sessionId } })
  }
  entries = [...metadata, ...entries]
  const forkPath = join(dirname(launchInfo.filePath), `${result.sessionId}.jsonl`)
  const temporaryPath = `${forkPath}.${crypto.randomUUID()}.tmp`
  const configDir = getClaudeConfigHomeDir()
  // Publish only after the engine marker exists: a reader can never mistake
  // this native transcript for a legacy-runtime session, even during startup.
  let marked = false
  try {
    await writeFile(temporaryPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
    markAgentSdkSession(configDir, result.sessionId)
    marked = true
    await link(temporaryPath, forkPath)
  } catch (error) {
    if (marked) await rm(join(configDir, 'cc-haha', 'session-runtimes', `${result.sessionId}.json`), { force: true })
    throw error
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return { sessionId: result.sessionId, title, workDir: launchInfo.workDir, forkPath }
}
