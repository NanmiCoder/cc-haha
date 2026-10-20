import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionCollaborationApi, type SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import { useSessionDelegationStore } from '@/stores/sessionDelegationStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { SessionDelegationReviewBar } from './SessionDelegationReviewBar'

vi.mock('@/api/sessionCollaboration', () => ({ sessionCollaborationApi: { get: vi.fn(), act: vi.fn() } }))

function fixture(state: 'review' | 'launched' = 'review'): SessionDelegationSnapshot {
  return {
    batches: [{ id: 'batch', requestId: 'request', callerSessionId: 'parent', revision: 1, state, sessions: [
      { id: 'build', title: 'Builder', prompt: 'Build', runtime: { providerId: 'premium', modelId: 'same' }, ...(state === 'launched' ? { sessionId: 'child-build', launched: true } : {}) },
      { id: 'review', title: 'Reviewer', prompt: 'Review', runtime: { providerId: 'premium', modelId: 'same' }, ...(state === 'launched' ? { sessionId: 'child-review', launched: true } : {}) },
    ] }],
    models: [{ providerId: 'premium', providerName: 'Premium', modelId: 'same', modelName: 'Same', supportedEfforts: [], isDefault: true }],
    sessions: state === 'launched' ? [{ sessionId: 'child-build', runtime: { providerId: 'premium', modelId: 'same' }, state: 'running', paused: false }] : [],
    changes: [],
  }
}

function show(snapshot: SessionDelegationSnapshot) {
  vi.mocked(sessionCollaborationApi.get).mockResolvedValue(snapshot)
  act(() => useSessionDelegationStore.getState().setSnapshot('parent', snapshot))
  return render(<SessionDelegationReviewBar sessionId="parent" />)
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useSessionDelegationStore.setState({ bySession: {} })
})
afterEach(cleanup)

it('leaves the composer dock empty once the sessions run', () => {
  // Running sessions live in the Activity rail. A full card here pushed the
  // conversation up and, clipped by the dock, looked like it covered the
  // expanded tool call above it.
  const { container } = show(fixture('launched'))
  expect(container).toBeEmptyDOMElement()
})

it('asks for one decision before the sessions start and hands detail to the dialog', async () => {
  show(fixture())
  const bar = screen.getByRole('region', { name: 'Session assignments' })
  expect(bar).toHaveTextContent('2 sessions start once you confirm their models')
  expect(screen.queryByText('Builder')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Change models' }))
  expect(useSessionDelegationStore.getState().bySession.parent?.manageOpen).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'Start sessions' }))
  await waitFor(() => expect(sessionCollaborationApi.act).toHaveBeenCalledWith('parent', expect.objectContaining({ id: 'batch', revision: 1 }), 'confirm'))
  await waitFor(() => expect(sessionCollaborationApi.get).toHaveBeenCalledWith('parent'))
})

it('will not start a session whose model is no longer available', async () => {
  const data = fixture()
  data.batches[0]!.sessions[1]!.runtime = { providerId: 'deleted', modelId: 'same' }
  show(data)
  expect(screen.getByRole('button', { name: 'Start sessions' })).toBeDisabled()
  expect(screen.getByText('Select an available provider and model')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel assignment' }))
  await waitFor(() => expect(sessionCollaborationApi.act).toHaveBeenCalledWith('parent', data.batches[0], 'cancel'))
})
