import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseWorkspaceDiff } from './workspaceDiffModel'
import {
  createWorkspaceDiffHighlightCacheKey,
  requestWorkspaceDiffHighlight,
} from './workspaceDiffHighlightRuntime'

const highlightWorkspaceDiffSpy = vi.hoisted(() => vi.fn())

vi.mock('./workspaceDiffHighlighter', () => ({
  highlightWorkspaceDiff: highlightWorkspaceDiffSpy,
}))

const files = parseWorkspaceDiff([
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-const before = true',
  '+const after = true',
].join('\n'))

const highlighted = {
  engine: 'shiki' as const,
  tokensByRowId: {},
  wordRangesByRowId: {},
}

const plain = {
  engine: 'plain' as const,
  tokensByRowId: {},
  wordRangesByRowId: {},
}

describe.sequential('workspaceDiffHighlightRuntime', () => {
  beforeEach(() => {
    highlightWorkspaceDiffSpy.mockReset()
    highlightWorkspaceDiffSpy.mockResolvedValue(highlighted)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds stable content-aware cache keys', () => {
    expect(createWorkspaceDiffHighlightCacheKey('src/a.ts', 'one'))
      .toBe(createWorkspaceDiffHighlightCacheKey('src/a.ts', 'one'))
    expect(createWorkspaceDiffHighlightCacheKey('src/a.ts', 'one'))
      .not.toBe(createWorkspaceDiffHighlightCacheKey('src/a.ts', 'two'))
    expect(createWorkspaceDiffHighlightCacheKey('src/a.ts', 'one'))
      .not.toBe(createWorkspaceDiffHighlightCacheKey('src/b.ts', 'one'))
    expect(createWorkspaceDiffHighlightCacheKey('src/a.ts', '10fv6kn0uwrauy0osy0nl0b9tpfg'))
      .not.toBe(createWorkspaceDiffHighlightCacheKey('src/a.ts', '03rslpn0g53pe61v1qjpx1d4vzcg'))
  })

  it('does not retain an oversized token result in the LRU cache', async () => {
    const originalWorker = globalThis.Worker
    vi.stubGlobal('Worker', undefined)
    const oversized = {
      ...highlighted,
      tokensByRowId: {
        row: Array.from({ length: 20_001 }, () => ({ content: 'x' })),
      },
    }
    highlightWorkspaceDiffSpy.mockResolvedValue(oversized)
    const request = { cacheKey: 'runtime-oversized', files, path: 'src/a.ts' }

    await requestWorkspaceDiffHighlight(request)
    await requestWorkspaceDiffHighlight(request)

    expect(highlightWorkspaceDiffSpy).toHaveBeenCalledTimes(2)
    vi.stubGlobal('Worker', originalWorker)
  })

  it('deduplicates pending work and reuses its cached result without a Worker', async () => {
    const originalWorker = globalThis.Worker
    vi.stubGlobal('Worker', undefined)
    let resolveHighlight: ((value: typeof highlighted) => void) | undefined
    highlightWorkspaceDiffSpy.mockReturnValue(new Promise((resolve) => {
      resolveHighlight = resolve
    }))
    const request = { cacheKey: 'runtime-fallback', files, path: 'src/a.ts' }

    const first = requestWorkspaceDiffHighlight(request)
    const second = requestWorkspaceDiffHighlight(request)
    expect(first).toBe(second)
    await vi.waitFor(() => expect(highlightWorkspaceDiffSpy).toHaveBeenCalledOnce())

    resolveHighlight?.(highlighted)
    await expect(first).resolves.toBe(highlighted)
    await expect(requestWorkspaceDiffHighlight(request)).resolves.toBe(highlighted)
    expect(highlightWorkspaceDiffSpy).toHaveBeenCalledOnce()
    vi.stubGlobal('Worker', originalWorker)
  })

  it('accepts highlighted results from the worker boundary', async () => {
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onmessageerror: (() => void) | null = null

      postMessage(message: { id: number }) {
        queueMicrotask(() => {
          this.onmessage?.({
            data: { id: message.id, result: highlighted },
          } as MessageEvent)
          this.onerror?.()
        })
      }

      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker)

    await expect(requestWorkspaceDiffHighlight({
      cacheKey: 'runtime-worker',
      files,
      path: 'src/a.ts',
    })).resolves.toBe(highlighted)
    expect(highlightWorkspaceDiffSpy).not.toHaveBeenCalled()
  })

  it('falls back to plain text without replaying Shiki when the worker crashes', async () => {
    class FailingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onmessageerror: (() => void) | null = null

      postMessage() {
        queueMicrotask(() => this.onerror?.())
      }

      terminate() {}
    }
    vi.stubGlobal('Worker', FailingWorker)

    await expect(requestWorkspaceDiffHighlight({
      cacheKey: 'runtime-worker-error',
      files,
      path: 'src/a.ts',
    })).resolves.toEqual(plain)
    expect(highlightWorkspaceDiffSpy).not.toHaveBeenCalled()
  })

  it('cleans up unreadable worker messages without replaying Shiki', async () => {
    class UnreadableWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onmessageerror: (() => void) | null = null

      postMessage() {
        queueMicrotask(() => this.onmessageerror?.())
      }

      terminate() {}
    }
    vi.stubGlobal('Worker', UnreadableWorker)

    await expect(requestWorkspaceDiffHighlight({
      cacheKey: 'runtime-worker-message-error',
      files,
      path: 'src/a.ts',
    })).resolves.toEqual(plain)
    expect(highlightWorkspaceDiffSpy).not.toHaveBeenCalled()
  })

  it('cleans up a synchronous postMessage failure without replaying Shiki', async () => {
    class ThrowingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onmessageerror: (() => void) | null = null

      postMessage() {
        throw new Error('clone failed')
      }

      terminate() {}
    }
    vi.stubGlobal('Worker', ThrowingWorker)

    await expect(requestWorkspaceDiffHighlight({
      cacheKey: 'runtime-worker-post-error',
      files,
      path: 'src/a.ts',
    })).resolves.toEqual(plain)
    expect(highlightWorkspaceDiffSpy).not.toHaveBeenCalled()
  })

  it('times out an unresponsive worker and clears its pending request', async () => {
    vi.useFakeTimers()
    class SilentWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onmessageerror: (() => void) | null = null

      postMessage() {}

      terminate() {}
    }
    vi.stubGlobal('Worker', SilentWorker)

    const request = requestWorkspaceDiffHighlight({
      cacheKey: 'runtime-worker-timeout',
      files,
      path: 'src/a.ts',
    })
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(request).resolves.toEqual(plain)
    expect(highlightWorkspaceDiffSpy).not.toHaveBeenCalled()
  })
})
