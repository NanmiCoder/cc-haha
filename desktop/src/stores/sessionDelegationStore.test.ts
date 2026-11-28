import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { sessionCollaborationApi, type SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import { EMPTY_DELEGATED_SESSION_ROWS, useSessionDelegationStore, useSessionDelegationSync } from './sessionDelegationStore'

vi.mock('@/api/sessionCollaboration', () => ({ sessionCollaborationApi: { get: vi.fn() } }))

function snapshot(state: string): SessionDelegationSnapshot {
  return {
    batches: [{ id: 'batch', requestId: 'r', callerSessionId: 'parent', revision: 1, state: 'launched', sessions: [
      { id: 'a', title: 'A', prompt: 'a', runtime: { providerId: 'p', modelId: 'm' }, sessionId: 'child-a', launched: true },
    ] }],
    models: [{ providerId: 'p', providerName: 'P', modelId: 'm', modelName: 'M', supportedEfforts: [], isDefault: true }],
    sessions: [{ sessionId: 'child-a', runtime: { providerId: 'p', modelId: 'm' }, state, paused: false }],
    changes: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionDelegationStore.setState({ bySession: {} })
})

it('keeps the rows array while a poll returns the same state, so the Activity model cache holds', async () => {
  vi.mocked(sessionCollaborationApi.get).mockResolvedValue(snapshot('running'))
  const { refresh } = useSessionDelegationStore.getState()
  await refresh('parent')
  const first = useSessionDelegationStore.getState().bySession.parent!.rows
  expect(first.map(row => row.status)).toEqual(['running'])

  vi.mocked(sessionCollaborationApi.get).mockResolvedValue(snapshot('running'))
  await refresh('parent')
  expect(useSessionDelegationStore.getState().bySession.parent!.rows).toBe(first)

  vi.mocked(sessionCollaborationApi.get).mockResolvedValue(snapshot('completed'))
  await refresh('parent')
  const changed = useSessionDelegationStore.getState().bySession.parent!.rows
  expect(changed).not.toBe(first)
  expect(changed.map(row => row.status)).toEqual(['completed'])
})

it('reads again after a mutation instead of reusing a poll that started before it', async () => {
  // A poll in flight when Apply returns answers with the state before the
  // switch; reusing it put the old models back on the rail until the next poll.
  let answerPoll!: (value: SessionDelegationSnapshot) => void
  vi.mocked(sessionCollaborationApi.get)
    .mockImplementationOnce(() => new Promise(resolve => { answerPoll = resolve }))
    .mockResolvedValueOnce(snapshot('completed'))
  const { refresh } = useSessionDelegationStore.getState()
  const poll = refresh('parent')
  expect(refresh('parent')).toBe(poll)

  const afterMutation = refresh('parent', { fresh: true })
  answerPoll(snapshot('running'))
  await afterMutation
  expect(sessionCollaborationApi.get).toHaveBeenCalledTimes(2)
  expect(useSessionDelegationStore.getState().bySession.parent!.rows.map(row => row.status)).toEqual(['completed'])

  // Polls after it start a new read again.
  vi.mocked(sessionCollaborationApi.get).mockResolvedValueOnce(snapshot('failed'))
  await refresh('parent')
  expect(useSessionDelegationStore.getState().bySession.parent!.rows.map(row => row.status)).toEqual(['failed'])
})

it('keeps the last snapshot when a poll fails and shares one empty array for sessions without delegation', async () => {
  vi.mocked(sessionCollaborationApi.get).mockResolvedValueOnce({ ...snapshot('running'), batches: [], sessions: [] })
  await useSessionDelegationStore.getState().refresh('quiet')
  expect(useSessionDelegationStore.getState().bySession.quiet!.rows).toBe(EMPTY_DELEGATED_SESSION_ROWS)

  vi.mocked(sessionCollaborationApi.get).mockResolvedValueOnce(snapshot('running'))
  await useSessionDelegationStore.getState().refresh('parent')
  vi.mocked(sessionCollaborationApi.get).mockRejectedValueOnce(new Error('offline'))
  await useSessionDelegationStore.getState().refresh('parent')
  const entry = useSessionDelegationStore.getState().bySession.parent!
  expect(entry.error).toBe('offline')
  expect(entry.rows.map(row => row.title)).toEqual(['A'])
})

afterEach(() => {
  vi.useRealTimers()
})

it('backs off delegation polling on consecutive failures and skips ticks while hidden', async () => {
  vi.useFakeTimers()
  vi.mocked(sessionCollaborationApi.get).mockRejectedValue(new Error('offline'))
  const { unmount } = renderHook(() => useSessionDelegationSync('backoff-session'))

  // Initial tick runs immediately -> 1st failure schedules next poll at 4s (2s * 2^1).
  await act(async () => { await Promise.resolve() })
  expect(sessionCollaborationApi.get).toHaveBeenCalledTimes(1)

  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(sessionCollaborationApi.get).toHaveBeenCalledTimes(1)

  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(sessionCollaborationApi.get).toHaveBeenCalledTimes(2)

  // 2nd failure backs off to 8s.
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
  expect(sessionCollaborationApi.get).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
  expect(sessionCollaborationApi.get).toHaveBeenCalledTimes(3)

  unmount()
})
