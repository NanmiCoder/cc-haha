import { useCallback, useReducer } from 'react'
import { useFocusEffect } from 'expo-router'
import type { ApiClient } from '../../core/client'
import {
  checkpointDiff,
  parseDiff,
  type Checkpoint,
  type DiffResponse,
} from '../../core/operations'
import {
  checkpointPrompt,
  checkpointSignature,
  diffBadge,
  diffTotals,
  type BadgeStatus,
} from '../../core/changesView'
import { checkpointDiffs, sessionKey, turnPrompts } from './resultsCache'

export const checkpointDiffKey = (
  hostId: string,
  sessionId: string,
  checkpoint: Checkpoint,
  path: string
) => `${sessionKey(hostId, sessionId)}\u0000${checkpointSignature(checkpoint)}\u0000${path}`

/**
 * The checkpoint list only gives file names and totals; per-file additions/deletions and M/A/D come from each file's own diff.
 * Each page visit prefetches at most the first 12, 3 concurrently (the server rereads the transcript for every comparison, so long sessions cannot fetch all at once), and fetched diffs are cached for the diff page to use directly.
 */
const PREFETCH_LIMIT = 12
const CONCURRENCY = 3

export type FileSummary = { badge: BadgeStatus; added: number; removed: number }
const summaries = new WeakMap<DiffResponse, FileSummary>()
export function summarizeDiff(response: DiffResponse | undefined) {
  if (!response || response.state !== 'ok') return undefined
  let summary = summaries.get(response)
  if (!summary) {
    summary = {
      badge: diffBadge(response.diff),
      ...diffTotals(parseDiff(response.diff ?? '')),
    }
    summaries.set(response, summary)
  }
  return summary
}

export function useCheckpointFileSummaries(
  client: ApiClient | null,
  hostId: string,
  sessionId: string,
  checkpoint: Checkpoint | undefined
) {
  const [, bump] = useReducer((count: number) => count + 1, 0)
  useFocusEffect(
    useCallback(() => {
      if (!client || !checkpoint) return
      const controller = new AbortController()
      const queue = checkpoint.code.filesChanged
        .slice(0, PREFETCH_LIMIT)
        .filter(
          (path) =>
            !checkpointDiffs.has(checkpointDiffKey(hostId, sessionId, checkpoint, path))
        )
      const worker = async () => {
        for (
          let path = queue.shift();
          path !== undefined && !controller.signal.aborted;
          path = queue.shift()
        ) {
          try {
            const response = await checkpointDiff(
              client,
              sessionId,
              checkpoint.target,
              path,
              controller.signal
            )
            if (controller.signal.aborted) return
            // Temporary errors are not cached and retried on the next visit; missing / not_git_repo are definite results and cached as usual.
            if (response.state === 'error') continue
            checkpointDiffs.set(
              checkpointDiffKey(hostId, sessionId, checkpoint, path),
              response
            )
            bump()
          } catch {
            // This row only hides the stats; opening the diff page shows the specific error.
          }
        }
      }
      for (let index = 0; index < CONCURRENCY; index++) void worker()
      return () => controller.abort()
    }, [client, hostId, sessionId, checkpoint])
  )
  return (path: string) =>
    checkpoint
      ? summarizeDiff(
          checkpointDiffs.get(checkpointDiffKey(hostId, sessionId, checkpoint, path))
        )
      : undefined
}

/**
 * Text of the user message that starts this turn. Read the latest history page first, page back if not found, at most 3 pages; 
 * every user message paged through is cached, so switching turns usually needs no new request.
 */
const PROMPT_PAGES = 3
export function useTurnPrompt(
  client: ApiClient | null,
  hostId: string,
  sessionId: string,
  targetUserMessageId: string | undefined
) {
  const [, bump] = useReducer((count: number) => count + 1, 0)
  const scope = sessionKey(hostId, sessionId)
  const key = targetUserMessageId ? `${scope}\u0000${targetUserMessageId}` : ''
  useFocusEffect(
    useCallback(() => {
      if (!client || !key || turnPrompts.has(key)) return
      const controller = new AbortController()
      void (async () => {
        let cursor: string | undefined
        for (let page = 0; page < PROMPT_PAGES; page++) {
          const result = await client.history(sessionId, cursor, {
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          for (const entry of result.messages)
            if (entry.type === 'user') {
              const text = checkpointPrompt([entry], entry.id)
              if (text) turnPrompts.set(`${scope}\u0000${entry.id}`, text)
            }
          if (turnPrompts.has(key)) return bump()
          if (!result.page?.hasMore || !result.page.nextCursor) return
          cursor = result.page.nextCursor
        }
      })().catch(() => {
        // The quote is only auxiliary info: when unavailable only the turn number and time are shown.
      })
      return () => controller.abort()
    }, [client, key, scope, sessionId])
  )
  return key ? turnPrompts.get(key) : undefined
}
