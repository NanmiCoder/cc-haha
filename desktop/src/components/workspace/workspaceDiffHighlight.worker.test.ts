import { beforeAll, describe, expect, it, vi } from 'vitest'

const highlightWorkspaceDiffSpy = vi.hoisted(() => vi.fn())

vi.mock('./workspaceDiffHighlighter', () => ({
  highlightWorkspaceDiff: highlightWorkspaceDiffSpy,
}))

describe('workspaceDiffHighlight worker', () => {
  const postMessage = vi.fn()
  let workerScope: {
    onmessage?: (event: MessageEvent) => Promise<void>
    postMessage: typeof postMessage
  }

  beforeAll(async () => {
    workerScope = { postMessage }
    vi.stubGlobal('self', workerScope)
    await import('./workspaceDiffHighlight.worker')
  })

  it('posts successful and failed highlight responses with the request id', async () => {
    const result = { engine: 'shiki', tokensByRowId: {}, wordRangesByRowId: {} }
    highlightWorkspaceDiffSpy.mockResolvedValueOnce(result)
    await workerScope.onmessage?.({
      data: { id: 7, files: [], path: 'src/a.ts' },
    } as MessageEvent)
    expect(postMessage).toHaveBeenLastCalledWith({ id: 7, result })

    highlightWorkspaceDiffSpy.mockRejectedValueOnce(new Error('grammar failed'))
    await workerScope.onmessage?.({
      data: { id: 8, files: [], path: 'src/b.ts' },
    } as MessageEvent)
    expect(postMessage).toHaveBeenLastCalledWith({ id: 8, error: 'grammar failed' })
  })
})
