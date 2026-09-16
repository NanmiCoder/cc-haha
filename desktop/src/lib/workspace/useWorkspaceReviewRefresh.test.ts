import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ getRevision: vi.fn(), getStatus: vi.fn() }))
vi.mock('@/api/review', () => ({ reviewApi: api }))
import { useWorkspaceReviewRefresh } from './useWorkspaceReviewRefresh'
import { useWorkspaceReviewStore } from '@/stores/workspaceReviewStore'
import type { ReviewStatusResult } from '@/api/review'
const source = { kind: 'unstaged' as const }
const status = (snapshot: string): ReviewStatusResult => ({ state: 'ok', source, snapshot, files: [], untracked: [], totals: { additions: 0, deletions: 0, files: 0 } })
beforeEach(async () => {
  vi.useFakeTimers()
  api.getRevision.mockReset().mockResolvedValue(status('old'))
  api.getStatus.mockReset().mockResolvedValue(status('old'))
  useWorkspaceReviewStore.setState({ byKey: {}, revisionBySession: {} })
  await useWorkspaceReviewStore.getState().load('a', source)
  api.getStatus.mockClear()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('visible review revalidation', () => {
  it('does not download status/diffs for unchanged probes and refreshes after an external index revision', async () => {
    const hook = renderHook(() => useWorkspaceReviewRefresh('a', source, true))
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(api.getStatus).not.toHaveBeenCalled()
    api.getRevision.mockResolvedValue(status('new'))
    api.getStatus.mockResolvedValue(status('new'))
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(api.getStatus).toHaveBeenCalledTimes(1)
    expect(useWorkspaceReviewStore.getState().getEntry('a', source).status?.snapshot).toBe('new')
    hook.unmount()
  })
  it('responds to file invalidation and ignores a late probe after changing sessions', async () => {
    let resolve!: (value: ReviewStatusResult) => void
    api.getRevision.mockImplementationOnce(() => new Promise<ReviewStatusResult>(done => { resolve = done }))
    const hook = renderHook(({ session }) => useWorkspaceReviewRefresh(session, source, true), { initialProps: { session: 'a' } })
    const signal = api.getRevision.mock.calls[0]![2].signal as AbortSignal
    hook.rerender({ session: 'b' })
    expect(signal.aborted).toBe(true)
    await act(async () => { resolve(status('late')); await Promise.resolve() })
    expect(api.getStatus.mock.calls.some(([session]) => session === 'a')).toBe(false)
    api.getRevision.mockClear()
    act(() => useWorkspaceReviewStore.getState().invalidateSession('b'))
    await act(async () => { await Promise.resolve() })
    expect(api.getRevision).toHaveBeenCalledTimes(1)
    hook.unmount()
  })
  it('cancels a changed-revision status read when its panel closes without replacing old content', async () => {
    let resolve!: (value: ReviewStatusResult) => void
    api.getRevision.mockResolvedValue(status('new'))
    api.getStatus.mockImplementationOnce(() => new Promise<ReviewStatusResult>(done => { resolve = done }))
    const hook = renderHook(({ active }) => useWorkspaceReviewRefresh('a', source, active), { initialProps: { active: true } })
    await act(async () => { await Promise.resolve() })
    expect(api.getStatus).toHaveBeenCalledTimes(1)
    const signal = api.getStatus.mock.calls[0]![2].signal as AbortSignal
    hook.rerender({ active: false })
    expect(signal.aborted).toBe(true)
    await act(async () => { resolve(status('late')); await Promise.resolve() })
    expect(useWorkspaceReviewStore.getState().getEntry('a', source).status?.snapshot).toBe('old')
    expect(useWorkspaceReviewStore.getState().getEntry('a', source).loading).toBe(false)
    hook.unmount()
  })
  it('serializes probes, keeps old contents after errors and retries on focus', async () => {
    let reject!: (error: Error) => void
    api.getRevision.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail }))
    const hook = renderHook(() => useWorkspaceReviewRefresh('a', source, true))
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(api.getRevision).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('offline')); await Promise.resolve() })
    expect(useWorkspaceReviewStore.getState().getEntry('a', source).status?.snapshot).toBe('old')
    act(() => window.dispatchEvent(new Event('focus')))
    expect(api.getRevision).toHaveBeenCalledTimes(2)
    hook.unmount()
  })
  it('does not probe hidden panels, historical sources, or hidden documents', async () => {
    const panel = renderHook(() => useWorkspaceReviewRefresh('a', source, false))
    const historical = renderHook(() => useWorkspaceReviewRefresh('a', { kind: 'commit', commit: 'abc' }, true))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const background = renderHook(() => useWorkspaceReviewRefresh('a', source, true))
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(api.getRevision).not.toHaveBeenCalled()
    panel.unmount()
    historical.unmount()
    background.unmount()
  })
})
