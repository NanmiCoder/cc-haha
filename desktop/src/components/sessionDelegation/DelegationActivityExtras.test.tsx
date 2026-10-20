import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionCollaborationApi, type SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import { useSessionDelegationStore } from '@/stores/sessionDelegationStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { DelegatedSessionsManageButton, DelegationSyncNotice } from './DelegationActivityExtras'

vi.mock('@/api/sessionCollaboration', () => ({ sessionCollaborationApi: { get: vi.fn() } }))

const snapshot: SessionDelegationSnapshot = {
  batches: [{ id: 'batch', requestId: 'r', callerSessionId: 'parent', revision: 1, state: 'launched', sessions: [
    { id: 'a', title: 'A', prompt: 'a', runtime: { providerId: 'p', modelId: 'm' }, sessionId: 'child-a', launched: true },
  ] }],
  models: [{ providerId: 'p', providerName: 'P', modelId: 'm', modelName: 'M', supportedEfforts: [], isDefault: true }],
  sessions: [{ sessionId: 'child-a', runtime: { providerId: 'p', modelId: 'm' }, state: 'running', paused: false }],
  changes: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useSessionDelegationStore.setState({ bySession: {} })
})
afterEach(cleanup)

it('lets the host clear the way before the model dialog opens', () => {
  const order: string[] = []
  const onOpen = vi.fn(() => order.push(`host:${useSessionDelegationStore.getState().bySession.parent?.manageOpen ?? false}`))
  render(<DelegatedSessionsManageButton sessionId="parent" onOpen={onOpen} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change models' }))
  expect(order).toEqual(['host:false'])
  expect(useSessionDelegationStore.getState().bySession.parent!.manageOpen).toBe(true)
})

it('says the rows may be stale while polls fail, and clears once one succeeds', async () => {
  render(<DelegationSyncNotice sessionId="parent" />)
  // Nothing to be stale about before the first snapshot arrives.
  vi.mocked(sessionCollaborationApi.get).mockRejectedValueOnce(new Error('not a collaboration'))
  await act(() => useSessionDelegationStore.getState().refresh('parent'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()

  vi.mocked(sessionCollaborationApi.get).mockResolvedValueOnce(snapshot)
  await act(() => useSessionDelegationStore.getState().refresh('parent'))
  vi.mocked(sessionCollaborationApi.get).mockRejectedValueOnce(new Error('Server unreachable'))
  await act(() => useSessionDelegationStore.getState().refresh('parent'))
  expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh assignments; showing the last known state · Server unreachable')

  vi.mocked(sessionCollaborationApi.get).mockResolvedValueOnce(snapshot)
  await act(() => useSessionDelegationStore.getState().refresh('parent'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
