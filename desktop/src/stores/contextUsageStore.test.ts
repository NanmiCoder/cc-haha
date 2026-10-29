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

const refresh = (nextRevision = revision, mode: 'restore' | 'auto' | 'manual' | 'force' = 'restore', visible = true) =>
  useContextUsageStore.getState().refresh('session', nextRevision, mode, visible)

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
    vi.advanceTimersByTime(29_999)
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
    vi.advanceTimersByTime(10_000)
    await refresh(revision, 'auto')
    expect(sessionsApi.getInspection).toHaveBeenCalledTimes(3)
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
