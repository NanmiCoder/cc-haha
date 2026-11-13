import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionsApi, type SessionInspectionResponse } from '@/api/sessions'
import { useContextUsageStore, type ContextUsageRevision } from './contextUsageStore'

vi.mock('@/api/sessions', () => ({ sessionsApi: { getInspection: vi.fn() } }))

const revision: ContextUsageRevision = {
  runtimeSelectionKey: 'provider:model',
  refreshNonce: 0,
  messageCount: 2,
  contentRevision: 0,
  chatState: 'idle',
}

const inspection: SessionInspectionResponse = {
  active: true,
  status: { sessionId: 'session', workDir: '/fixture', permissionMode: 'default', model: 'model' },
  context: {
    categories: [], totalTokens: 20_000, maxTokens: 100_000, rawMaxTokens: 100_000,
    percentage: 20, gridRows: [], model: 'model', memoryFiles: [], mcpTools: [], agents: [],
  },
}

const refresh = (nextRevision = revision, mode: 'restore' | 'auto' | 'manual' | 'force' = 'restore', visible = true, includeDetails = mode === 'manual') =>
  useContextUsageStore.getState().refresh('session', nextRevision, mode, visible, includeDetails)

describe('context usage session cache', () => {
  beforeEach(() => {
    useContextUsageStore.setState({ bySession: {} })
    vi.mocked(sessionsApi.getInspection).mockReset().mockResolvedValue(inspection)
  })

  afterEach(() => vi.useRealTimers())

  it('restores an unchanged idle reading even after a long time away', async () => {
    vi.useFakeTimers()
    await refresh()
    vi.advanceTimersByTime(60 * 60_000)
    await refresh()
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(1)
    expect(useContextUsageStore.getState().bySession.session?.context?.percentage).toBe(20)
  })

  it('refreshes an active reading when returning after the polling interval', async () => {
    vi.useFakeTimers()
    const running = { ...revision, chatState: 'thinking' as const }
    await refresh(running)
    vi.advanceTimersByTime(2_999)
    await refresh(running)
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await refresh(running)
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(2)
  })

  it('throttles automatic refreshes while allowing a manual reading', async () => {
    vi.useFakeTimers()
    await refresh()
    await refresh(revision, 'auto')
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(1)
    await refresh(revision, 'manual')
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1_000)
    await refresh(revision, 'auto')
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(3)
  })

  it('requests a cheap summary until the caller asks for the breakdown', async () => {
    await refresh()
    expect(sessionsApi.getInspection).toHaveBeenLastCalledWith('session', expect.objectContaining({ summaryOnly: true }))
    await refresh(revision, 'manual')
    expect(sessionsApi.getInspection).toHaveBeenLastCalledWith('session', expect.objectContaining({ summaryOnly: false }))
  })

  it.each([
    ['summary', 'first request first'],
    ['summary', 'newer request first'],
    ['details', 'first request first'],
    ['details', 'newer request first'],
  ] as const)('keeps the newest headline when %s starts first and %s settles', async (firstKind, completion) => {
    const resolvers: Array<(value: SessionInspectionResponse) => void> = []
    vi.mocked(sessionsApi.getInspection).mockImplementation(() => new Promise((done) => { resolvers.push(done) }))
    const firstDetails = firstKind === 'details'
    const first = refresh(revision, firstDetails ? 'manual' : 'restore', true, firstDetails)
    const newer = refresh(revision, firstDetails ? 'auto' : 'manual', true, !firstDetails)
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sessionsApi.getInspection).mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    const newerInspection = { ...inspection, context: { ...inspection.context!, totalTokens: 30_000, percentage: 30 } }
    if (completion === 'first request first') {
      resolvers[0]!(inspection)
      expect(await first).toBe(true)
      expect(useContextUsageStore.getState().bySession.session?.context?.totalTokens).toBe(20_000)
      resolvers[1]!(newerInspection)
      expect(await newer).toBe(true)
    } else {
      resolvers[1]!(newerInspection)
      expect(await newer).toBe(true)
      expect(useContextUsageStore.getState().bySession.session?.context?.totalTokens).toBe(30_000)
      resolvers[0]!(inspection)
      expect(await first).toBe(true)
    }
    const cached = useContextUsageStore.getState().bySession.session
    expect(cached?.context?.totalTokens).toBe(30_000)
    expect(cached?.context?.percentage).toBe(30)
    expect(cached?.detailContext?.totalTokens).toBe(firstDetails ? 20_000 : 30_000)
  })

  it('accepts a newer lower reading while an older full reply can still supply details', async () => {
    let resolve!: (value: SessionInspectionResponse) => void
    vi.mocked(sessionsApi.getInspection)
      .mockReturnValueOnce(new Promise((done) => { resolve = done }))
      .mockResolvedValueOnce({ ...inspection, context: { ...inspection.context!, totalTokens: 10_000, percentage: 10 } })
    const oldDetails = refresh(revision, 'manual')
    await refresh(revision, 'auto')
    resolve(inspection)
    await oldDetails
    expect(useContextUsageStore.getState().bySession.session).toMatchObject({
      context: { totalTokens: 10_000, percentage: 10 },
      detailContext: { totalTokens: 20_000, percentage: 20 },
    })
  })

  it.each(['missing context', 'rejection'] as const)('does not let an older summary %s replace the status of a newer full reading', async (failure) => {
    let resolve!: (value: SessionInspectionResponse) => void
    let reject!: (error: Error) => void
    vi.mocked(sessionsApi.getInspection)
      .mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail }))
      .mockResolvedValueOnce({ ...inspection, context: { ...inspection.context!, totalTokens: 30_000, percentage: 30 } })
    const oldSummary = refresh()
    await refresh(revision, 'manual')
    if (failure === 'rejection') reject(new Error('Old summary timed out'))
    else resolve({ ...inspection, context: undefined, errors: { context: 'Old summary unavailable' } })
    expect(await oldSummary).toBe(false)
    expect(useContextUsageStore.getState().bySession.session).toMatchObject({
      context: { totalTokens: 30_000, percentage: 30 }, error: null,
    })
  })

  it.each(['runtime', 'compact', 'completed turn'] as const)('cancels pending details across a %s boundary', async (boundary) => {
    const resolvers: Array<(value: SessionInspectionResponse) => void> = []
    vi.mocked(sessionsApi.getInspection)
      .mockImplementationOnce(() => new Promise((done) => { resolvers.push(done) }))
      .mockImplementationOnce(() => new Promise((done) => { resolvers.push(done) }))
    const running = { ...revision, chatState: 'thinking' as const }
    const summary = refresh(running)
    const pending = refresh(running, 'manual')
    const signal = vi.mocked(sessionsApi.getInspection).mock.calls[0]?.[1]?.signal
    const next = {
      ...running,
      runtimeSelectionKey: boundary === 'runtime' ? 'replacement:model' : running.runtimeSelectionKey,
      refreshNonce: boundary === 'compact' ? 1 : 0,
      chatState: boundary === 'completed turn' ? 'idle' as const : running.chatState,
    }
    await refresh(next, 'force')
    resolvers.forEach(resolve => resolve({ ...inspection, context: { ...inspection.context!, totalTokens: 90_000 } }))
    expect(await pending).toBe(false)
    expect(await summary).toBe(false)
    expect(signal?.aborted).toBe(true)
    expect(useContextUsageStore.getState().bySession.session?.detailContext).toBeNull()
    expect(useContextUsageStore.getState().bySession.session?.context?.totalTokens).toBe(20_000)
  })

  it('does not revive either request after clearing and recreating a session cache', async () => {
    const resolvers: Array<(value: SessionInspectionResponse) => void> = []
    vi.mocked(sessionsApi.getInspection)
      .mockImplementationOnce(() => new Promise((done) => { resolvers.push(done) }))
      .mockImplementationOnce(() => new Promise((done) => { resolvers.push(done) }))
    const oldSummary = refresh()
    const oldDetails = refresh(revision, 'manual')
    useContextUsageStore.getState().clearSession('session')
    await refresh()
    resolvers.forEach(resolve => resolve({ ...inspection, context: { ...inspection.context!, totalTokens: 90_000 } }))
    expect(await oldSummary).toBe(false)
    expect(await oldDetails).toBe(false)
    expect(useContextUsageStore.getState().bySession.session?.context?.totalTokens).toBe(20_000)
    expect(useContextUsageStore.getState().bySession.session?.detailContext).toBeNull()
  })

  it('shares slow summary polls instead of stacking requests every second', async () => {
    vi.useFakeTimers()
    let resolve!: (value: SessionInspectionResponse) => void
    vi.mocked(sessionsApi.getInspection).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const running = { ...revision, chatState: 'thinking' as const }
    const first = refresh(running)
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(3_000)
      expect(refresh(running, 'auto')).toBe(first)
    }
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(1)
    resolve(inspection)
    await first
  })

  it('keeps the last confirmed model with an estimate and retries a failed replacement', async () => {
    vi.mocked(sessionsApi.getInspection).mockResolvedValueOnce({
      ...inspection, context: undefined, contextEstimate: inspection.context,
    })
    await refresh()
    const next = { ...revision, runtimeSelectionKey: 'provider:replacement' }
    vi.mocked(sessionsApi.getInspection).mockRejectedValueOnce(new Error('CLI restarting'))
    expect(await refresh(next)).toBe(false)
    expect(useContextUsageStore.getState().bySession.session).toMatchObject({
      context: { percentage: 20 }, source: 'estimate', model: 'model', error: 'CLI restarting', inFlight: null,
    })
    await refresh(next)
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(3)
    expect(useContextUsageStore.getState().bySession.session?.error).toBeNull()
  })

  it('discards an obsolete process response when the model changes while hidden', async () => {
    let resolve!: (value: SessionInspectionResponse) => void
    vi.mocked(sessionsApi.getInspection).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const pending = refresh()
    await refresh({ ...revision, runtimeSelectionKey: 'provider:replacement' }, 'restore', false)
    resolve(inspection)
    expect(await pending).toBe(false)
    expect(useContextUsageStore.getState().bySession.session?.context).toBeNull()
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(1)
  })

  it('does not restore a result from before a session was cleared', async () => {
    let resolve!: (value: SessionInspectionResponse) => void
    vi.mocked(sessionsApi.getInspection).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const pending = refresh()
    useContextUsageStore.getState().clearSession('session')
    resolve(inspection)
    expect(await pending).toBe(false)
    expect(useContextUsageStore.getState().bySession.session).toBeUndefined()
    await refresh()
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(2)
  })

  it.each(['settled', 'pending'] as const)(
    'refreshes a %s reading when content changes without changing the displayed message count',
    async (state) => {
      let resolve!: (value: SessionInspectionResponse) => void
      vi.mocked(sessionsApi.getInspection)
        .mockReturnValueOnce(new Promise((done) => { resolve = done }))
        .mockResolvedValueOnce({ ...inspection, context: { ...inspection.context!, percentage: 30 } })
      const first = refresh()
      if (state === 'settled') {
        resolve(inspection)
        await first
      }
      const next = { ...revision, contentRevision: 1 }
      const replacement = refresh(next)
      expect(sessionsApi.getInspection).toHaveBeenCalledTimes(2)
      resolve(inspection)
      await first
      await replacement
      expect(useContextUsageStore.getState().bySession.session?.context?.percentage).toBe(30)
      await refresh(next)
      expect(sessionsApi.getInspection).toHaveBeenCalledTimes(2)
    },
  )
})
