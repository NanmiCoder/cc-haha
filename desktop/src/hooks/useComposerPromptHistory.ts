import { useCallback, useEffect, useRef } from 'react'
import { promptHistoryApi, type PromptHistoryItem } from '@/api/promptHistory'
import { createUserMessageEditDraft } from '@/components/chat/userMessageEdit'
import type { ComposerMention } from '@/lib/composerMentions'
import type { UIMessage } from '@/types/chat'

export const MAX_PROMPT_HISTORY_ITEMS = 100

export type PromptHistoryEntry = {
  text: string
  mentions?: ComposerMention[]
}

export type RecordPromptSubmissionOptions = {
  sessionId?: string | null
  projectPath?: string | null
  projectRoot?: string | null
}

const localSessionHistory = new Map<string, PromptHistoryEntry[]>()
const localProjectHistory = new Map<string, PromptHistoryEntry[]>()

function normalizeProjectKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '').normalize('NFC')
  return normalized || '/'
}

/**
 * Canonical comparison key for matching prompts across display text (`@App.tsx`)
 * and serialized model/transcript text (`@"/repo/src/App.tsx"`).
 */
function promptDedupKey(text: string): string {
  return text
    .trim()
    .replace(/@"([^"]+)"/g, (_match, rawPath: string) => {
      const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '')
      const base = normalized.split('/').pop() || normalized
      return `@${base}`
    })
}

/**
 * Checks whether `candidate` is the display form of a transcript prompt whose
 * leading `@mention` tokens were stripped into attachments on reload (e.g.
 * `@App.tsx explain this` vs `explain this`).
 */
function matchesWithStrippedLeadingMentions(candidate: string, strippedText: string): boolean {
  const trimmedCandidate = candidate.trim()
  const trimmedStripped = strippedText.trim()
  if (!trimmedCandidate.startsWith('@') || !trimmedStripped) return false
  const withoutLeading = trimmedCandidate.replace(/^(?:@\S+\s+)+/, '').trim()
  return withoutLeading.length > 0 && promptDedupKey(withoutLeading) === promptDedupKey(trimmedStripped)
}

function collapseConsecutive<T>(
  items: readonly T[],
  getKey: (item: T) => string,
): T[] {
  const collapsed: T[] = []
  let previousKey: string | null = null
  for (const item of items) {
    const key = getKey(item)
    if (!key || key === previousKey) continue
    collapsed.push(item)
    previousKey = key
  }
  return collapsed
}

function prependBoundedEntry(
  store: Map<string, PromptHistoryEntry[]>,
  key: string,
  entry: PromptHistoryEntry,
): void {
  const existing = store.get(key) ?? []
  const entryKey = promptDedupKey(entry.text)
  if (existing[0] && promptDedupKey(existing[0].text) === entryKey) {
    store.set(key, [entry, ...existing.slice(1)])
    return
  }
  store.set(key, [entry, ...existing].slice(0, MAX_PROMPT_HISTORY_ITEMS))
}

function cloneEntry(entry: PromptHistoryEntry): PromptHistoryEntry {
  return {
    text: entry.text,
    ...(entry.mentions?.length ? { mentions: entry.mentions.map((mention) => ({ ...mention })) } : {}),
  }
}

export function clearComposerPromptHistoryCacheForTesting(): void {
  localSessionHistory.clear()
  localProjectHistory.clear()
}

/**
 * Extracts human-authored prompt entries from a session's UI message list in
 * newest-first order, skipping teammate/scheduled/collaboration messages and
 * attachment-only turns with no user-typed text.
 */
export function extractSessionPromptHistory(
  messages: readonly UIMessage[] | undefined,
  limit = MAX_PROMPT_HISTORY_ITEMS,
): PromptHistoryEntry[] {
  if (!messages || messages.length === 0) return []
  const result: PromptHistoryEntry[] = []

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (
      message.type !== 'user_text' ||
      message.teammateFrom ||
      message.scheduledTask ||
      message.collaboration
    ) {
      continue
    }

    const draft = createUserMessageEditDraft(message)
    const draftText = draft.text.trim()
    // Skip attachment-only turns (e.g. "Please analyze the attached files.")
    // that have no user-typed text.
    if (!draftText) continue

    // Prefer projected capability pills when present; otherwise prefer
    // `message.content` (which preserves `@label` display text for live sends
    // without leaking serialized `@"/abs/path"` paths or stripping leading
    // inline file mentions).
    const text = draft.mentions?.length
      ? draftText
      : (message.content.trim() || draftText)
    if (!text) continue
    if (result[result.length - 1] && promptDedupKey(result[result.length - 1]!.text) === promptDedupKey(text)) {
      continue
    }

    result.push({
      text,
      ...(draft.mentions?.length ? { mentions: draft.mentions } : {}),
    })
    if (result.length >= limit) break
  }

  return result
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function consumeCount(map: Map<string, number>, key: string): boolean {
  const remaining = map.get(key) ?? 0
  if (remaining <= 0) return false
  if (remaining === 1) map.delete(key)
  else map.set(key, remaining - 1)
  return true
}

/**
 * Merges current-session entries (local + transcript + persisted same-session)
 * ahead of other sessions in the same project (local + persisted), matching the
 * TUI's `getHistory()` ordering while avoiding cross-source duplicates and
 * consecutive identical entries.
 */
export function mergePromptHistoryEntries(params: {
  sessionId?: string | null
  localSessionEntries: readonly PromptHistoryEntry[]
  transcriptEntries: readonly PromptHistoryEntry[]
  localProjectEntries: readonly PromptHistoryEntry[]
  serverEntries: readonly PromptHistoryItem[]
  includeProjectHistory: boolean
  limit?: number
}): PromptHistoryEntry[] {
  const limit = params.limit ?? MAX_PROMPT_HISTORY_ITEMS
  const sessionId = params.sessionId?.trim() || null
  const result: PromptHistoryEntry[] = []

  const pushEntry = (entry: PromptHistoryEntry): boolean => {
    if (result.length >= limit) return false
    const text = entry.text.trim()
    if (!text) return false
    const key = promptDedupKey(text)
    if (result[result.length - 1] && promptDedupKey(result[result.length - 1]!.text) === key) {
      return false
    }
    result.push(entry.text === text ? entry : { ...entry, text })
    return true
  }

  // Collapse consecutive duplicates within each source first so multiset
  // accounting stays symmetric between local/transcript and raw history.jsonl.
  const localSessionCollapsed = collapseConsecutive(params.localSessionEntries, (e) => promptDedupKey(e.text))
  const transcriptCollapsed = collapseConsecutive(params.transcriptEntries, (e) => promptDedupKey(e.text))
  const sameSessionServerCollapsed = sessionId
    ? collapseConsecutive(
      params.serverEntries.filter((item) => item.sessionId === sessionId),
      (item) => promptDedupKey(item.display),
    )
    : []
  const otherSessionServerCollapsed = collapseConsecutive(
    params.serverEntries.filter((item) => !sessionId || item.sessionId !== sessionId),
    (item) => promptDedupKey(item.display),
  )
  const localProjectCollapsed = collapseConsecutive(params.localProjectEntries, (e) => promptDedupKey(e.text))

  // Phase 1: Current session entries (in-memory submissions + loaded transcript)
  const localSessionCounts = new Map<string, number>()
  const currentSessionCounts = new Map<string, number>()
  // Indices in `result` contributed by `transcriptEntries` (candidates to be
  // upgraded in-place when `history.jsonl` has a cleaner display form for the
  // same reloaded turn, e.g. `@App.tsx` instead of `@"/abs/App.tsx"`).
  const transcriptResultIndices: number[] = []

  for (const entry of localSessionCollapsed) {
    const key = promptDedupKey(entry.text)
    if (pushEntry(entry)) {
      incrementCount(localSessionCounts, key)
      incrementCount(currentSessionCounts, key)
    }
  }

  for (const entry of transcriptCollapsed) {
    const key = promptDedupKey(entry.text)
    if (consumeCount(localSessionCounts, key)) continue
    if (pushEntry(entry)) {
      transcriptResultIndices.push(result.length - 1)
      incrementCount(currentSessionCounts, key)
    }
  }

  // Phase 2: Persisted entries from the same session not covered by Phase 1
  // (e.g. older turns beyond a windowed transcript or local slash commands).
  if (sessionId) {
    const remainingSessionCounts = new Map(currentSessionCounts)
    const upgradedTranscriptIndices = new Set<number>()

    for (const item of sameSessionServerCollapsed) {
      const text = item.display.trim()
      if (!text) continue
      const key = promptDedupKey(text)

      if (consumeCount(remainingSessionCounts, key)) {
        // If the matched Phase 1 entry came from a reloaded transcript with a
        // raw `@"/abs/path"` serialization, upgrade it to the cleaner display
        // text recorded in `history.jsonl`.
        const matchingTranscriptIdx = transcriptResultIndices.find(
          (idx) => !upgradedTranscriptIndices.has(idx) && promptDedupKey(result[idx]!.text) === key,
        )
        if (matchingTranscriptIdx !== undefined && result[matchingTranscriptIdx]!.text !== text && !result[matchingTranscriptIdx]!.mentions?.length) {
          result[matchingTranscriptIdx] = { text }
          upgradedTranscriptIndices.add(matchingTranscriptIdx)
        }
        continue
      }

      // Match a reloaded transcript turn whose leading `@file` token was
      // stripped into an attachment chip on reload.
      const strippedTranscriptIdx = transcriptResultIndices.find(
        (idx) => !upgradedTranscriptIndices.has(idx) && matchesWithStrippedLeadingMentions(text, result[idx]!.text),
      )
      if (strippedTranscriptIdx !== undefined) {
        const oldKey = promptDedupKey(result[strippedTranscriptIdx]!.text)
        consumeCount(remainingSessionCounts, oldKey)
        result[strippedTranscriptIdx] = { text }
        upgradedTranscriptIndices.add(strippedTranscriptIdx)
        incrementCount(currentSessionCounts, key)
        continue
      }

      pushEntry({ text })
      incrementCount(currentSessionCounts, key)
    }
  }

  // Phase 3: Other sessions in the same project
  if (params.includeProjectHistory) {
    const skipForLocalProject = new Map(currentSessionCounts)
    const emittedLocalProjectCounts = new Map<string, number>()

    for (const entry of localProjectCollapsed) {
      const key = promptDedupKey(entry.text)
      if (consumeCount(skipForLocalProject, key)) continue
      if (pushEntry(entry)) {
        incrementCount(emittedLocalProjectCounts, key)
      }
    }

    for (const item of otherSessionServerCollapsed) {
      const text = item.display.trim()
      if (!text) continue
      const key = promptDedupKey(text)
      if (consumeCount(emittedLocalProjectCounts, key)) continue
      pushEntry({ text })
    }
  }

  return result
}

function getLocalProjectEntries(
  projectPath: string | null | undefined,
  projectRoot: string | null | undefined,
): PromptHistoryEntry[] {
  const primaryKey = normalizeProjectKey(projectPath)
  const rootKey = normalizeProjectKey(projectRoot)
  if (!primaryKey && !rootKey) return []
  if (primaryKey && (!rootKey || primaryKey === rootKey)) {
    return localProjectHistory.get(primaryKey) ?? []
  }
  if (!primaryKey && rootKey) {
    return localProjectHistory.get(rootKey) ?? []
  }

  const combined: PromptHistoryEntry[] = []
  const seen = new Map<string, number>()
  for (const entry of localProjectHistory.get(primaryKey!) ?? []) {
    combined.push(entry)
    incrementCount(seen, promptDedupKey(entry.text))
  }
  for (const entry of localProjectHistory.get(rootKey!) ?? []) {
    if (consumeCount(seen, promptDedupKey(entry.text))) continue
    combined.push(entry)
  }
  return combined.slice(0, MAX_PROMPT_HISTORY_ITEMS)
}

export type UseComposerPromptHistoryOptions = {
  sessionId?: string | null
  projectPath?: string | null
  projectRoot?: string | null
  sessionEntries?: readonly PromptHistoryEntry[]
  includeProjectHistory?: boolean
  getCurrentDraft: () => PromptHistoryEntry
  applyEntry: (entry: PromptHistoryEntry, cursor: 'start' | 'end') => void
}

export type ComposerPromptHistoryController = {
  isNavigating: () => boolean
  onHistoryUp: () => boolean
  onHistoryDown: () => boolean
  resetHistory: () => void
  recordSubmission: (entry: PromptHistoryEntry, overrides?: RecordPromptSubmissionOptions) => void
}

/**
 * Arrow-key prompt history navigation for desktop composers, mirroring the TUI's
 * `useArrowKeyHistory` behavior:
 * - Preserves the user's live draft (including @-mention pills) on first ArrowUp
 *   and restores it when pressing ArrowDown past the newest entry.
 * - Places the caret at the start on ArrowUp and at the end on ArrowDown so
 *   repeated presses step smoothly through multiline prompts.
 * - Combines current-session turns with shared project history from
 *   `<CLAUDE_CONFIG_DIR>/history.jsonl` loaded lazily on first ArrowUp.
 */
export function useComposerPromptHistory({
  sessionId,
  projectPath,
  projectRoot,
  sessionEntries = [],
  includeProjectHistory = true,
  getCurrentDraft,
  applyEntry,
}: UseComposerPromptHistoryOptions): ComposerPromptHistoryController {
  const normalizedSessionId = sessionId?.trim() || null
  const normalizedProjectPath = normalizeProjectKey(projectPath)
  const normalizedProjectRoot = normalizeProjectKey(projectRoot)
  const contextKey = `${normalizedSessionId ?? ''}\0${normalizedProjectPath ?? ''}\0${normalizedProjectRoot ?? ''}\0${includeProjectHistory ? '1' : '0'}`

  const historyIndexRef = useRef(0)
  const draftRef = useRef<PromptHistoryEntry | null>(null)
  const snapshotEntriesRef = useRef<PromptHistoryEntry[] | null>(null)
  const navigationGenerationRef = useRef(0)

  const serverLoadedKeyRef = useRef<string | null>(null)
  const serverEntriesRef = useRef<PromptHistoryItem[]>([])
  const serverLoadPromiseRef = useRef<{ key: string; promise: Promise<PromptHistoryItem[]> } | null>(null)

  // Keep latest props accessible from stable callbacks without stale closures.
  const latestRef = useRef({
    sessionId: normalizedSessionId,
    projectPath: projectPath?.trim() || null,
    projectRoot: projectRoot?.trim() || null,
    sessionEntries,
    includeProjectHistory,
    contextKey,
    getCurrentDraft,
    applyEntry,
  })
  latestRef.current = {
    sessionId: normalizedSessionId,
    projectPath: projectPath?.trim() || null,
    projectRoot: projectRoot?.trim() || null,
    sessionEntries,
    includeProjectHistory,
    contextKey,
    getCurrentDraft,
    applyEntry,
  }

  const resetHistory = useCallback(() => {
    navigationGenerationRef.current += 1
    historyIndexRef.current = 0
    draftRef.current = null
    snapshotEntriesRef.current = null
  }, [])

  // Reset navigation and invalidate per-context server cache when switching
  // sessions or changing the target project directory.
  useEffect(() => {
    resetHistory()
    if (serverLoadedKeyRef.current !== contextKey) {
      serverLoadedKeyRef.current = null
      serverEntriesRef.current = []
      serverLoadPromiseRef.current = null
    }
  }, [contextKey, resetHistory])

  const buildMergedEntries = useCallback((serverEntries: readonly PromptHistoryItem[]) => {
    const current = latestRef.current
    const localSessionEntries = current.sessionId
      ? (localSessionHistory.get(current.sessionId) ?? [])
      : []
    const localProjectEntries = current.includeProjectHistory
      ? getLocalProjectEntries(current.projectPath, current.projectRoot)
      : []
    return mergePromptHistoryEntries({
      sessionId: current.sessionId,
      localSessionEntries,
      transcriptEntries: current.sessionEntries,
      localProjectEntries,
      serverEntries,
      includeProjectHistory: current.includeProjectHistory,
    })
  }, [])

  const shouldFetchServerHistory = useCallback(() => {
    const current = latestRef.current
    if (!current.includeProjectHistory && !current.sessionId) return false
    // Do not issue an unscoped request when neither a session nor a project is known.
    if (!current.sessionId && !current.projectPath && !current.projectRoot) return false
    return serverLoadedKeyRef.current !== current.contextKey
  }, [])

  const ensureServerHistoryLoaded = useCallback(async (): Promise<PromptHistoryItem[]> => {
    const current = latestRef.current
    const requestKey = current.contextKey

    if (serverLoadedKeyRef.current === requestKey) {
      return serverEntriesRef.current
    }
    if (serverLoadPromiseRef.current?.key === requestKey) {
      return serverLoadPromiseRef.current.promise
    }

    const promise = (async () => {
      try {
        const response = await promptHistoryApi.list({
          project: current.projectPath ?? undefined,
          projectRoot: current.projectRoot ?? undefined,
          sessionId: current.sessionId ?? undefined,
          limit: MAX_PROMPT_HISTORY_ITEMS,
          sessionOnly: !current.includeProjectHistory,
        })
        const entries = Array.isArray(response?.entries) ? response.entries : []
        if (latestRef.current.contextKey === requestKey) {
          serverEntriesRef.current = entries
          serverLoadedKeyRef.current = requestKey
        }
        return entries
      } catch {
        // Keep local history working on transient errors without permanently
        // negative-caching the failed context key.
        return []
      } finally {
        if (serverLoadPromiseRef.current?.key === requestKey) {
          serverLoadPromiseRef.current = null
        }
      }
    })()

    serverLoadPromiseRef.current = { key: requestKey, promise }
    return promise
  }, [])

  const extendActiveSnapshot = useCallback((loadedServerEntries: readonly PromptHistoryItem[]) => {
    const activeSnapshot = snapshotEntriesRef.current
    if (!activeSnapshot || historyIndexRef.current <= 0) return
    const merged = buildMergedEntries(loadedServerEntries)
    const visitedCount = Math.min(historyIndexRef.current, activeSnapshot.length)
    let prefixMatches = merged.length >= visitedCount
    for (let i = 0; i < visitedCount && prefixMatches; i += 1) {
      if (promptDedupKey(merged[i]!.text) !== promptDedupKey(activeSnapshot[i]!.text)) {
        prefixMatches = false
      }
    }
    if (prefixMatches) {
      snapshotEntriesRef.current = merged
      return
    }
    // Preserve already-visited indices and append any newly discovered tail entries.
    const existingCounts = new Map<string, number>()
    for (const entry of activeSnapshot) incrementCount(existingCounts, promptDedupKey(entry.text))
    const extended = [...activeSnapshot]
    for (const entry of merged) {
      if (extended.length >= MAX_PROMPT_HISTORY_ITEMS) break
      const key = promptDedupKey(entry.text)
      if (consumeCount(existingCounts, key)) continue
      if (extended[extended.length - 1] && promptDedupKey(extended[extended.length - 1]!.text) === key) continue
      extended.push(entry)
    }
    snapshotEntriesRef.current = extended
  }, [buildMergedEntries])

  const isNavigating = useCallback(() => historyIndexRef.current > 0, [])

  const onHistoryUp = useCallback((): boolean => {
    const currentIndex = historyIndexRef.current
    const targetIndex = currentIndex

    if (currentIndex === 0) {
      draftRef.current = cloneEntry(latestRef.current.getCurrentDraft())
      snapshotEntriesRef.current = buildMergedEntries(serverEntriesRef.current)
    }

    const entries = snapshotEntriesRef.current ?? []

    // Fast path: target entry is already available synchronously.
    if (targetIndex < entries.length) {
      historyIndexRef.current = targetIndex + 1
      latestRef.current.applyEntry(cloneEntry(entries[targetIndex]!), 'start')

      // Warm persisted history in the background so continuing ArrowUp past
      // local entries reaches older sessions seamlessly.
      if (shouldFetchServerHistory()) {
        const requestKey = latestRef.current.contextKey
        void ensureServerHistoryLoaded().then((loaded) => {
          if (latestRef.current.contextKey !== requestKey || historyIndexRef.current <= 0) return
          extendActiveSnapshot(loaded)
        })
      }
      return true
    }

    // Slow path: need server history before we know whether an older entry exists.
    if (shouldFetchServerHistory()) {
      const gen = navigationGenerationRef.current
      historyIndexRef.current = targetIndex + 1
      void ensureServerHistoryLoaded().then((loaded) => {
        if (gen !== navigationGenerationRef.current) return
        const merged = buildMergedEntries(loaded)
        snapshotEntriesRef.current = merged
        const clampedIndex = Math.min(historyIndexRef.current, merged.length)
        historyIndexRef.current = clampedIndex
        if (clampedIndex <= 0) {
          draftRef.current = null
          snapshotEntriesRef.current = null
          return
        }
        latestRef.current.applyEntry(cloneEntry(merged[clampedIndex - 1]!), 'start')
      })
      return true
    }

    if (currentIndex === 0) {
      draftRef.current = null
      snapshotEntriesRef.current = null
      return false
    }

    // Already at the oldest history entry.
    return true
  }, [buildMergedEntries, ensureServerHistoryLoaded, extendActiveSnapshot, shouldFetchServerHistory])

  const onHistoryDown = useCallback((): boolean => {
    const currentIndex = historyIndexRef.current
    if (currentIndex <= 0) return false

    // Cancel any in-flight slow-path ArrowUp so it cannot overwrite this step down.
    navigationGenerationRef.current += 1

    const entries = snapshotEntriesRef.current ?? []
    const effectiveIndex = Math.min(currentIndex, entries.length)
    if (effectiveIndex > 1) {
      const nextIndex = effectiveIndex - 1
      historyIndexRef.current = nextIndex
      const entry = entries[nextIndex - 1]
      if (entry) {
        latestRef.current.applyEntry(cloneEntry(entry), 'end')
        return true
      }
    }

    // Returning to index 0 restores the saved live draft.
    const draft = draftRef.current ?? { text: '', mentions: [] }
    historyIndexRef.current = 0
    draftRef.current = null
    snapshotEntriesRef.current = null
    latestRef.current.applyEntry(cloneEntry(draft), 'end')
    return true
  }, [])

  const recordSubmission = useCallback((
    entry: PromptHistoryEntry,
    overrides?: RecordPromptSubmissionOptions,
  ) => {
    const text = entry.text.trim()
    resetHistory()
    if (!text) return

    const current = latestRef.current
    const effectiveSessionId = (overrides?.sessionId !== undefined ? overrides.sessionId : current.sessionId)?.trim() || null
    const effectiveProjectPath = (overrides?.projectPath !== undefined ? overrides.projectPath : current.projectPath)?.trim() || null
    const effectiveProjectRoot = (overrides?.projectRoot !== undefined ? overrides.projectRoot : current.projectRoot)?.trim() || null

    const storedEntry = cloneEntry({ text, mentions: entry.mentions })
    if (effectiveSessionId) {
      prependBoundedEntry(localSessionHistory, effectiveSessionId, storedEntry)
    }

    // Member / subagent sessions keep their prompt history isolated from
    // project-wide and global CLI history.jsonl.
    if (!current.includeProjectHistory) return

    const projectKey = normalizeProjectKey(effectiveProjectPath)
    const rootKey = normalizeProjectKey(effectiveProjectRoot)
    if (projectKey) {
      prependBoundedEntry(localProjectHistory, projectKey, storedEntry)
    }
    if (rootKey && rootKey !== projectKey) {
      prependBoundedEntry(localProjectHistory, rootKey, storedEntry)
    }

    const persistProject = effectiveProjectPath || effectiveProjectRoot || undefined
    void promptHistoryApi.append({
      display: text,
      ...(persistProject ? { project: persistProject } : {}),
      ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
    }).catch(() => {})
  }, [resetHistory])

  return {
    isNavigating,
    onHistoryUp,
    onHistoryDown,
    resetHistory,
    recordSubmission,
  }
}
