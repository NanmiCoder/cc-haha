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
 * 检查点列表只给文件名和总数；逐文件的增删和 M/A/D 来自每个文件自己的差异。
 * 每次进入页面最多预取前 12 个、并发 3 个（服务端每次比较都会重读会话记录，长会话不能一口气全取），取到的差异缓存给差异页直接用。
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
            // 临时的 error 不缓存，下次进页面再试；missing / not_git_repo 是确定结果，照常缓存。
            if (response.state === 'error') continue
            checkpointDiffs.set(
              checkpointDiffKey(hostId, sessionId, checkpoint, path),
              response
            )
            bump()
          } catch {
            // 这一行只是不显示统计；打开差异页时会给出具体错误。
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
 * 这一轮开头那条用户消息的文字。先读最新一页历史，找不到再往前翻，最多 3 页；
 * 翻到的每条用户消息都缓存起来，换一轮时多半不用再请求。
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
        // 引用只是辅助信息：取不到时只显示轮次和时间。
      })
      return () => controller.abort()
    }, [client, key, scope, sessionId])
  )
  return key ? turnPrompts.get(key) : undefined
}
