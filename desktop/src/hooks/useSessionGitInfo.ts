import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionsApi, type SessionGitInfo } from '../api/sessions'

const RETURN_REFRESH_THROTTLE_MS = 1_000
const COALESCED_REFRESH_WINDOW_MS = 50

type GitInfoSubscriber = (info: SessionGitInfo) => void

type InFlightGitInfoRequest = {
  generation: number
  workDirKey: string
  startedAt: number
  promise: Promise<SessionGitInfo>
}

export type UseSessionGitInfoOptions = {
  sessionId: string | null | undefined
  enabled?: boolean
  visible?: boolean
  workDir?: string | null
  chatState?: string
  messageCount?: number
  secondaryRefreshKey?: number
}

const subscribersBySession = new Map<string, Set<GitInfoSubscriber>>()
const generationsBySession = new Map<string, number>()
const inFlightBySession = new Map<string, InFlightGitInfoRequest>()
const inFlightCountBySession = new Map<string, number>()
const lastReturnRefreshAtBySession = new Map<string, number>()
let notifyingApiInvalidate = false

function cleanupSessionGitInfoState(sessionId: string) {
  if (
    !subscribersBySession.has(sessionId) &&
    !inFlightBySession.has(sessionId) &&
    !inFlightCountBySession.has(sessionId)
  ) {
    generationsBySession.delete(sessionId)
    lastReturnRefreshAtBySession.delete(sessionId)
  }
}

function invalidateLocalSessionGitInfo(sessionId: string) {
  generationsBySession.set(sessionId, (generationsBySession.get(sessionId) ?? 0) + 1)
  inFlightBySession.delete(sessionId)
  cleanupSessionGitInfoState(sessionId)
}

function bumpGeneration(sessionId: string): number {
  const next = (generationsBySession.get(sessionId) ?? 0) + 1
  generationsBySession.set(sessionId, next)
  inFlightBySession.delete(sessionId)
  if (!notifyingApiInvalidate) {
    notifyingApiInvalidate = true
    try {
      sessionsApi.invalidateGitInfo?.(sessionId)
    } finally {
      notifyingApiInvalidate = false
    }
  }
  cleanupSessionGitInfoState(sessionId)
  return generationsBySession.get(sessionId) ?? next
}

function publishToSubscribers(sessionId: string, info: SessionGitInfo) {
  const subscribers = subscribersBySession.get(sessionId)
  if (!subscribers) return
  for (const subscriber of [...subscribers]) {
    subscriber(info)
  }
}

function subscribeToSessionGitInfo(sessionId: string, subscriber: GitInfoSubscriber): () => void {
  let subscribers = subscribersBySession.get(sessionId)
  if (!subscribers) {
    subscribers = new Set()
    subscribersBySession.set(sessionId, subscribers)
  }
  subscribers.add(subscriber)

  const unsubscribeApi = typeof sessionsApi.subscribeGitInfo === 'function'
    ? sessionsApi.subscribeGitInfo(sessionId, subscriber, {
        onInvalidate: () => {
          if (!notifyingApiInvalidate) {
            invalidateLocalSessionGitInfo(sessionId)
          }
        },
      })
    : null

  return () => {
    unsubscribeApi?.()
    const current = subscribersBySession.get(sessionId)
    if (!current) return
    current.delete(subscriber)
    if (current.size === 0) {
      subscribersBySession.delete(sessionId)
      inFlightBySession.delete(sessionId)
      lastReturnRefreshAtBySession.delete(sessionId)
      if (inFlightCountBySession.has(sessionId)) {
        generationsBySession.set(sessionId, (generationsBySession.get(sessionId) ?? 0) + 1)
      } else {
        cleanupSessionGitInfoState(sessionId)
      }
    }
  }
}

function requestSessionGitInfo(
  sessionId: string,
  options?: { workDir?: string | null; force?: boolean },
): Promise<SessionGitInfo | null> {
  const workDirKey = options?.workDir ?? ''
  const force = Boolean(options?.force)
  const existing = inFlightBySession.get(sessionId)
  const now = performance.now()

  if (existing && existing.workDirKey === workDirKey) {
    if (!force || (now >= existing.startedAt && now - existing.startedAt < COALESCED_REFRESH_WINDOW_MS)) {
      return existing.promise.catch(() => null)
    }
  }

  if (force || (existing && existing.workDirKey !== workDirKey)) {
    bumpGeneration(sessionId)
  }

  const generation = generationsBySession.get(sessionId) ?? 0
  inFlightCountBySession.set(sessionId, (inFlightCountBySession.get(sessionId) ?? 0) + 1)
  const promise = Promise.resolve()
    .then(() => sessionsApi.getGitInfo(sessionId))
    .then((info) => {
      if ((generationsBySession.get(sessionId) ?? 0) === generation && info) {
        publishToSubscribers(sessionId, info)
      }
      return info
    })
    .finally(() => {
      const remaining = (inFlightCountBySession.get(sessionId) ?? 1) - 1
      if (remaining <= 0) {
        inFlightCountBySession.delete(sessionId)
      } else {
        inFlightCountBySession.set(sessionId, remaining)
      }
      if (inFlightBySession.get(sessionId)?.promise === promise) {
        inFlightBySession.delete(sessionId)
      }
      cleanupSessionGitInfoState(sessionId)
    })

  inFlightBySession.set(sessionId, {
    generation,
    workDirKey,
    startedAt: now,
    promise,
  })

  return promise.catch(() => null)
}

/**
 * Shared live Git metadata for the session header and composer.
 *
 * Both surfaces subscribe to the same per-session updates, coalesce concurrent
 * refreshes on window/tab return and turn boundaries, and accept explicit
 * refreshes when focus moves back into the composer from an in-app panel.
 */
export function useSessionGitInfo({
  sessionId,
  enabled = true,
  visible = true,
  workDir,
  chatState = 'idle',
  messageCount = 0,
  secondaryRefreshKey = 0,
}: UseSessionGitInfoOptions): {
  gitInfo: SessionGitInfo | null
  refreshGitInfo: () => Promise<SessionGitInfo | null>
} {
  const [entry, setEntry] = useState<{
    sessionId: string
    info: SessionGitInfo
  } | null>(null)

  useEffect(() => {
    if (!enabled || !sessionId) {
      setEntry(null)
      return
    }

    let cancelled = false
    setEntry((current) => (current?.sessionId === sessionId ? null : current))

    const unsubscribe = subscribeToSessionGitInfo(sessionId, (info) => {
      if (cancelled) return
      setEntry((current) => (
        current?.sessionId === sessionId && current.info === info
          ? current
          : { sessionId, info }
      ))
    })

    void requestSessionGitInfo(sessionId, { workDir, force: false })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [enabled, sessionId, workDir])

  const turnRefreshBaselineRef = useRef<{
    targetKey: string
    chatState: string
    messageCount: number
    secondaryRefreshKey: number
  } | null>(null)

  useEffect(() => {
    if (!enabled || !sessionId) {
      turnRefreshBaselineRef.current = null
      return
    }

    const targetKey = `${sessionId}\0${workDir ?? ''}`
    const previous = turnRefreshBaselineRef.current
    turnRefreshBaselineRef.current = {
      targetKey,
      chatState,
      messageCount,
      secondaryRefreshKey,
    }

    if (!previous || previous.targetKey !== targetKey) {
      return
    }

    const changed =
      previous.chatState !== chatState ||
      previous.messageCount !== messageCount ||
      previous.secondaryRefreshKey !== secondaryRefreshKey
    if (!changed || messageCount === 0) return

    const timeout = setTimeout(() => {
      void requestSessionGitInfo(sessionId, { workDir, force: true })
    }, chatState === 'idle' ? 0 : 500)

    return () => {
      clearTimeout(timeout)
    }
  }, [chatState, enabled, messageCount, secondaryRefreshKey, sessionId, workDir])

  const wasVisibleRef = useRef(visible)
  useEffect(() => {
    const cameBack = visible && !wasVisibleRef.current
    wasVisibleRef.current = visible
    if (!cameBack || !enabled || !sessionId) return
    void requestSessionGitInfo(sessionId, { workDir, force: true })
  }, [enabled, sessionId, visible, workDir])

  useEffect(() => {
    if (!enabled || !visible || !sessionId) return

    const refreshOnReturn = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const now = Date.now()
      const last = lastReturnRefreshAtBySession.get(sessionId)
      if (last !== undefined && now >= last && now - last < RETURN_REFRESH_THROTTLE_MS) return
      lastReturnRefreshAtBySession.set(sessionId, now)
      void requestSessionGitInfo(sessionId, { workDir, force: true })
    }

    window.addEventListener('focus', refreshOnReturn)
    document.addEventListener('visibilitychange', refreshOnReturn)
    return () => {
      window.removeEventListener('focus', refreshOnReturn)
      document.removeEventListener('visibilitychange', refreshOnReturn)
    }
  }, [enabled, sessionId, visible, workDir])

  const refreshGitInfo = useCallback(() => {
    if (!enabled || !sessionId) return Promise.resolve(null)
    return requestSessionGitInfo(sessionId, { workDir, force: true })
  }, [enabled, sessionId, workDir])

  const gitInfo = enabled && sessionId && entry?.sessionId === sessionId ? entry.info : null
  return { gitInfo, refreshGitInfo }
}
