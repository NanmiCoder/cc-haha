import type { WorkspaceDiffFile } from './workspaceDiffModel'
import type { WorkspaceDiffHighlightResult } from './workspaceDiffHighlighter'

const WORKSPACE_DIFF_HIGHLIGHT_CACHE_SIZE = 100
const WORKSPACE_DIFF_HIGHLIGHT_CACHE_WEIGHT = 100_000
const WORKSPACE_DIFF_HIGHLIGHT_MAX_ENTRY_WEIGHT = 20_000
const WORKSPACE_DIFF_HIGHLIGHT_TIMEOUT_MS = 15_000

interface HighlightRequest {
  cacheKey: string
  files: WorkspaceDiffFile[]
  path: string
}

interface PendingRequest {
  resolve: (result: WorkspaceDiffHighlightResult) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

interface CachedHighlight {
  result: WorkspaceDiffHighlightResult
  weight: number
}

const cache = new Map<string, CachedHighlight>()
const pendingByCacheKey = new Map<string, Promise<WorkspaceDiffHighlightResult>>()
const pendingById = new Map<number, PendingRequest>()
let worker: Worker | null = null
let requestId = 0
let cacheWeight = 0

function createPlainHighlightResult(): WorkspaceDiffHighlightResult {
  return {
    engine: 'plain',
    tokensByRowId: {},
    wordRangesByRowId: {},
  }
}

async function highlightOnMainThread(files: WorkspaceDiffFile[], path: string) {
  const { highlightWorkspaceDiff } = await import('./workspaceDiffHighlighter')
  return highlightWorkspaceDiff({ files, path })
}

function failHighlightWorker(activeWorker: Worker, message: string) {
  if (worker !== activeWorker) return false
  worker = null
  activeWorker.terminate()
  const error = new Error(message)
  pendingById.forEach((pending) => {
    clearTimeout(pending.timeoutId)
    pending.reject(error)
  })
  pendingById.clear()
  return true
}

function getResultWeight(cacheKey: string, result: WorkspaceDiffHighlightResult) {
  const tokenCount = Object.values(result.tokensByRowId)
    .reduce((total, tokens) => total + tokens.length, 0)
  const wordRangeCount = Object.values(result.wordRangesByRowId)
    .reduce((total, ranges) => total + ranges.length, 0)
  return Math.ceil(cacheKey.length / 80) + tokenCount + wordRangeCount
}

function setCached(cacheKey: string, result: WorkspaceDiffHighlightResult) {
  const weight = getResultWeight(cacheKey, result)
  if (weight > WORKSPACE_DIFF_HIGHLIGHT_MAX_ENTRY_WEIGHT) return

  const previous = cache.get(cacheKey)
  if (previous) cacheWeight -= previous.weight
  cache.delete(cacheKey)
  cache.set(cacheKey, { result, weight })
  cacheWeight += weight
  while (
    cache.size > WORKSPACE_DIFF_HIGHLIGHT_CACHE_SIZE
    || cacheWeight > WORKSPACE_DIFF_HIGHLIGHT_CACHE_WEIGHT
  ) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cacheWeight -= cache.get(oldestKey)?.weight ?? 0
    cache.delete(oldestKey)
  }
}

function getWorker() {
  if (worker) return worker
  if (typeof Worker === 'undefined') return null

  try {
    const nextWorker = new Worker(new URL('./workspaceDiffHighlight.worker.ts', import.meta.url), { type: 'module' })
    worker = nextWorker
    nextWorker.onmessage = (event: MessageEvent<{
      id: number
      result?: WorkspaceDiffHighlightResult
      error?: string
    }>) => {
      const pending = pendingById.get(event.data.id)
      if (!pending) return
      pendingById.delete(event.data.id)
      clearTimeout(pending.timeoutId)
      if (event.data.result) pending.resolve(event.data.result)
      else pending.reject(new Error(event.data.error || 'Diff highlighting failed'))
    }
    nextWorker.onerror = () => failHighlightWorker(nextWorker, 'Diff highlighting worker failed')
    nextWorker.onmessageerror = () => failHighlightWorker(nextWorker, 'Diff highlighting worker returned an unreadable result')
    return nextWorker
  } catch {
    return null
  }
}

function highlightInWorker(files: WorkspaceDiffFile[], path: string) {
  const activeWorker = getWorker()
  if (!activeWorker) return highlightOnMainThread(files, path)

  requestId += 1
  const id = requestId
  return new Promise<WorkspaceDiffHighlightResult>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const pending = pendingById.get(id)
      if (!pending) return
      if (!failHighlightWorker(activeWorker, 'Diff highlighting worker timed out')) {
        pendingById.delete(id)
        pending.reject(new Error('Diff highlighting worker timed out'))
      }
    }, WORKSPACE_DIFF_HIGHLIGHT_TIMEOUT_MS)
    pendingById.set(id, { resolve, reject, timeoutId })
    try {
      activeWorker.postMessage({ id, files, path })
    } catch (error) {
      if (!failHighlightWorker(activeWorker, 'Diff highlighting worker rejected the request')) {
        clearTimeout(timeoutId)
        pendingById.delete(id)
        reject(error instanceof Error ? error : new Error('Diff highlighting worker rejected the request'))
      }
    }
  }).catch(() => createPlainHighlightResult())
}

export function createWorkspaceDiffHighlightCacheKey(path: string, value: string) {
  return `${path}\0${value}`
}

export function requestWorkspaceDiffHighlight({ cacheKey, files, path }: HighlightRequest) {
  const cached = cache.get(cacheKey)
  if (cached) {
    setCached(cacheKey, cached.result)
    return Promise.resolve(cached.result)
  }

  const existing = pendingByCacheKey.get(cacheKey)
  if (existing) return existing

  const request = highlightInWorker(files, path)
    .then((result) => {
      setCached(cacheKey, result)
      return result
    })
    .finally(() => pendingByCacheKey.delete(cacheKey))
  pendingByCacheKey.set(cacheKey, request)
  return request
}
