import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionCollaborationApi, type SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import { useSessionDelegationStore } from '@/stores/sessionDelegationStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { SessionDelegationDialog } from './SessionDelegationDialog'
import type { RuntimeSelection } from '@/types/runtime'

vi.mock('@/api/sessionCollaboration', () => ({ sessionCollaborationApi: { get: vi.fn(), update: vi.fn(), act: vi.fn(), change: vi.fn(), cancelChange: vi.fn() } }))
vi.mock('@/components/controls/ModelSelector', () => ({ ModelSelector: (props: { ariaLabel: string; runtimeSelection: RuntimeSelection; runtimeChoices: unknown[]; onRuntimeSelectionChange: (selection: RuntimeSelection) => void; disabled?: boolean }) => <button aria-label={props.ariaLabel} disabled={props.disabled} data-catalog={JSON.stringify(props.runtimeChoices)} onClick={() => props.onRuntimeSelectionChange({ providerId: 'economy', modelId: 'same' })}>{props.runtimeSelection?.providerId} / {props.runtimeSelection?.modelId}</button> }))

function fixture(): SessionDelegationSnapshot {
  return {
    batches: [{ id: 'batch', requestId: 'request', callerSessionId: 'parent', revision: 1, state: 'review', sessions: [
      { id: 'build', title: 'Builder', prompt: 'Build the feature', runtime: { providerId: 'premium', modelId: 'same' } },
      { id: 'review', title: 'Reviewer', prompt: 'Review the change', runtime: { providerId: 'premium', modelId: 'same' } },
    ] }],
    models: ['premium', 'economy'].map(providerId => ({ providerId, providerName: providerId, modelId: 'same', modelName: 'Same', supportedEfforts: [], isDefault: providerId === 'premium' })),
    changes: [],
  }
}

function launchedFixture(): SessionDelegationSnapshot {
  const data = fixture()
  data.batches[0]!.state = 'launched'
  data.batches[0]!.sessions.forEach(entry => { entry.sessionId = entry.id; entry.launched = true })
  return data
}

// One caller, two CreateSessions calls: the first batch runs, the second waits for review.
function mixedFixture(): SessionDelegationSnapshot {
  const data = launchedFixture()
  data.sessions = data.batches[0]!.sessions.map(entry => ({ sessionId: entry.sessionId!, runtime: { providerId: 'premium', modelId: 'same' }, state: 'running', paused: false }))
  data.batches.push({ id: 'next', requestId: 'later', callerSessionId: 'parent', revision: 1, state: 'review', sessions: [
    { id: 'docs', title: 'Writer', prompt: 'Write the docs', runtime: { providerId: 'premium', modelId: 'same' } },
  ] })
  return data
}

function openDialog(snapshot: SessionDelegationSnapshot) {
  vi.mocked(sessionCollaborationApi.get).mockResolvedValue(snapshot)
  act(() => {
    useSessionDelegationStore.getState().setSnapshot('parent', snapshot)
    useSessionDelegationStore.getState().setManageOpen('parent', true)
  })
  return render(<SessionDelegationDialog sessionId="parent" />)
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useSessionDelegationStore.setState({ bySession: {} })
})
afterEach(cleanup)

describe('SessionDelegationDialog', () => {
  it('stays closed until the rail or the decision bar opens it', () => {
    act(() => useSessionDelegationStore.getState().setSnapshot('parent', fixture()))
    render(<SessionDelegationDialog sessionId="parent" />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => useSessionDelegationStore.getState().setManageOpen('parent', true))
    expect(screen.getByRole('dialog', { name: 'Session assignments' })).toBeInTheDocument()
  })

  it('does not launch before confirmation, edits all selected members and confirms the saved revision', async () => {
    vi.mocked(sessionCollaborationApi.update).mockResolvedValue({ ...fixture().batches[0]!, revision: 2 })
    openDialog(fixture())
    expect(sessionCollaborationApi.act).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Select all'))
    fireEvent.click(screen.getByRole('button', { name: 'Model for selected sessions' }))
    const catalog = JSON.parse(screen.getByRole('button', { name: 'Builder · Provider and model' }).getAttribute('data-catalog')!) as Array<{ isDefault: boolean }>
    expect(catalog).toHaveLength(2)
    // Only the globally active provider receives the default marker.
    expect(catalog.map(choice => choice.isDefault)).toEqual([true, false])
    fireEvent.click(screen.getByRole('button', { name: 'Start sessions' }))
    await waitFor(() => expect(sessionCollaborationApi.act).toHaveBeenCalledWith('parent', expect.objectContaining({ revision: 2 }), 'confirm'))
    expect(sessionCollaborationApi.update).toHaveBeenCalledWith('parent', expect.objectContaining({ revision: 1 }), [
      { id: 'build', runtime: { providerId: 'economy', modelId: 'same' } },
      { id: 'review', runtime: { providerId: 'economy', modelId: 'same' } },
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes while a confirmation is still in flight and stays closed when it answers', async () => {
    let answer!: (batch: SessionDelegationSnapshot['batches'][number]) => void
    vi.mocked(sessionCollaborationApi.act).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    openDialog(fixture())
    fireEvent.click(screen.getByRole('button', { name: 'Start sessions' }))
    await waitFor(() => expect(sessionCollaborationApi.act).toHaveBeenCalledWith('parent', expect.objectContaining({ id: 'batch' }), 'confirm'))
    expect(screen.getByRole('button', { name: 'Start sessions' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useSessionDelegationStore.getState().bySession.parent?.manageOpen).toBe(false)
    await act(async () => { answer({ ...fixture().batches[0]!, state: 'launching', revision: 2 }) })
    await waitFor(() => expect(sessionCollaborationApi.get).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes with Escape while a model change is still in flight', async () => {
    vi.mocked(sessionCollaborationApi.change).mockReturnValueOnce(new Promise(() => {}))
    openDialog(launchedFixture())
    fireEvent.click(screen.getByLabelText('Builder'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 session' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply to 1 session' })).toBeDisabled())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('blocks unresolved models and can cancel without starting', async () => {
    const data = fixture()
    data.batches[0]!.sessions[0]!.runtime = { providerId: 'deleted', modelId: 'same' }
    openDialog(data)
    expect(screen.getByRole('button', { name: 'Start sessions' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel assignment' }))
    await waitFor(() => expect(sessionCollaborationApi.act).toHaveBeenCalledWith('parent', data.batches[0], 'cancel'))
  })

  it('uses actual runtime after reload and sends immediate pause-only changes without altering main runtime', async () => {
    const data = launchedFixture()
    data.sessions = [{ sessionId: 'build', runtime: { providerId: 'economy', modelId: 'same' }, state: 'running', paused: false }]
    openDialog(data)
    expect(screen.getByRole('button', { name: 'Builder · Provider and model' })).toHaveTextContent('economy / same')
    fireEvent.click(screen.getByLabelText('Builder'))
    fireEvent.change(screen.getByLabelText('When to change'), { target: { value: 'immediate' } })
    fireEvent.click(screen.getByLabelText('Continue after changing (uncheck to keep paused)'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 session' }))
    await waitFor(() => expect(sessionCollaborationApi.change).toHaveBeenCalledWith('parent', { requestId: expect.any(String), mode: 'immediate', resume: false, selections: [{ sessionId: 'build', runtime: { providerId: 'economy', modelId: 'same' } }] }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('retains a stable request ID after an uncertain change response', async () => {
    const data = fixture()
    data.batches[0]!.state = 'launched'
    data.batches[0]!.sessions[0]!.sessionId = 'child'
    vi.mocked(sessionCollaborationApi.change).mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce({} as never)
    openDialog(data)
    fireEvent.click(screen.getByLabelText('Builder'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 session' }))
    await screen.findByText('Connection interrupted')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply to 1 session' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 session' }))
    await waitFor(() => expect(sessionCollaborationApi.change).toHaveBeenCalledTimes(2))
    expect(vi.mocked(sessionCollaborationApi.change).mock.calls[0]![1].requestId).toEqual(vi.mocked(sessionCollaborationApi.change).mock.calls[1]![1].requestId)
  })

  it('shows a pending switch as the model each session will run, locks those rows and cancels with its revision', async () => {
    const data = launchedFixture()
    data.sessions = data.batches[0]!.sessions.map(entry => ({ sessionId: entry.sessionId!, runtime: { providerId: 'premium', modelId: 'same' }, state: 'running', paused: false }))
    data.changes = [{ id: 'change', revision: 5, callerSessionId: 'parent', requestId: 'r', state: 'pending', mode: 'after_turn', resume: true, selections: [{ sessionId: 'build', runtime: { providerId: 'economy', modelId: 'same' } }] }]
    openDialog(data)
    const builder = screen.getByRole('button', { name: 'Builder · Provider and model' })
    expect(builder).toHaveTextContent('economy / same')
    expect(builder).toBeDisabled()
    expect(screen.getByLabelText('Builder')).toBeDisabled()
    expect(screen.getByText('Switches after this turn · now Same')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reviewer · Provider and model' })).toHaveTextContent('premium / same')
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for current turns · 1 session')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel pending change' }))
    await waitFor(() => expect(sessionCollaborationApi.cancelChange).toHaveBeenCalledWith('parent', 'change', 5))
  })

  it('keeps started sessions manageable when the remaining assignment is cancelled', () => {
    const data = fixture()
    data.batches[0]!.state = 'cancelled'
    data.batches[0]!.sessions[0]!.sessionId = 'child'
    data.batches[0]!.sessions[0]!.launched = true
    openDialog(data)
    expect(screen.getByLabelText('Builder')).toBeInTheDocument()
    expect(screen.queryByLabelText('Reviewer')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Builder · Provider and model' }))
    expect(screen.getByRole('button', { name: 'Apply to 1 session' })).toBeEnabled()
  })

  it('uses container layout and reports partially selected rows', () => {
    openDialog(fixture())
    for (const row of screen.getAllByTestId('delegation-task-row')) {
      expect(row).toHaveClass('@min-[560px]:grid-cols-[minmax(0,1fr)_260px]')
    }
    fireEvent.click(screen.getByRole('checkbox', { name: 'Builder' }))
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBePartiallyChecked()
  })
})

describe('a selection that mixes started and waiting sessions', () => {
  // Apply changes started sessions; waiting ones take their model on Start.
  // Both buttons used to close the dialog, dropping the other half's choice.
  it('applies to the started ones and keeps the waiting one for Start', async () => {
    vi.mocked(sessionCollaborationApi.change).mockResolvedValue({} as never)
    vi.mocked(sessionCollaborationApi.update).mockResolvedValue({ ...mixedFixture().batches[1]!, revision: 2 })
    openDialog(mixedFixture())
    fireEvent.click(screen.getByLabelText('Select all'))
    fireEvent.click(screen.getByRole('button', { name: 'Model for selected sessions' }))
    const apply = screen.getByRole('button', { name: 'Apply to 2 sessions' })
    expect(apply).toHaveAccessibleDescription('Sessions that have not started take their model when you start them.')

    fireEvent.click(apply)
    await waitFor(() => expect(sessionCollaborationApi.change).toHaveBeenCalledTimes(1))
    expect(vi.mocked(sessionCollaborationApi.change).mock.calls[0]![1].selections.map(item => item.sessionId)).toEqual(['build', 'review'])
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Apply to/ })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Writer · Provider and model' })).toHaveTextContent('economy / same')

    fireEvent.click(screen.getByRole('button', { name: 'Start sessions' }))
    await waitFor(() => expect(sessionCollaborationApi.act).toHaveBeenCalledWith('parent', expect.objectContaining({ id: 'next', revision: 2 }), 'confirm'))
    expect(sessionCollaborationApi.update).toHaveBeenCalledWith('parent', expect.objectContaining({ id: 'next' }), [{ id: 'docs', runtime: { providerId: 'economy', modelId: 'same' } }])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('starts the waiting one and keeps the started ones for Apply', async () => {
    vi.mocked(sessionCollaborationApi.change).mockResolvedValue({} as never)
    vi.mocked(sessionCollaborationApi.update).mockResolvedValue({ ...mixedFixture().batches[1]!, revision: 2 })
    openDialog(mixedFixture())
    fireEvent.click(screen.getByLabelText('Select all'))
    fireEvent.click(screen.getByRole('button', { name: 'Model for selected sessions' }))

    fireEvent.click(screen.getByRole('button', { name: 'Start sessions' }))
    await waitFor(() => expect(sessionCollaborationApi.act).toHaveBeenCalledWith('parent', expect.objectContaining({ id: 'next' }), 'confirm'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply to 2 sessions' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Builder · Provider and model' })).toHaveTextContent('economy / same')
    expect(screen.queryByText('Sessions that have not started take their model when you start them.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 sessions' }))
    await waitFor(() => expect(sessionCollaborationApi.change).toHaveBeenCalledWith('parent', expect.objectContaining({
      selections: [
        { sessionId: 'build', runtime: { providerId: 'economy', modelId: 'same' } },
        { sessionId: 'review', runtime: { providerId: 'economy', modelId: 'same' } },
      ],
    })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

it('does not silently overwrite newer server choices while a draft is open', () => {
  openDialog(fixture())
  fireEvent.click(screen.getByRole('button', { name: 'Builder · Provider and model' }))
  const changed = fixture()
  changed.batches[0]!.revision = 3
  act(() => useSessionDelegationStore.getState().setSnapshot('parent', changed))
  expect(screen.getByText('This assignment changed in another window. Reload before confirming.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start sessions' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload assignment' }))
  expect(screen.getByRole('button', { name: 'Builder · Provider and model' })).toHaveTextContent('premium / same')
  expect(screen.getByRole('button', { name: 'Start sessions' })).toBeEnabled()
})

it('requires reducing a cross-batch selection to eight before applying runtime changes', async () => {
  const data = fixture()
  const template = data.batches[0]!
  data.batches = [5, 4].map((count, batchIndex) => ({
    ...template,
    id: `batch-${batchIndex}`,
    state: 'launched',
    sessions: Array.from({ length: count }, (_, index) => ({
      ...template.sessions[0]!,
      id: `${batchIndex}-${index}`,
      title: `Task ${batchIndex}-${index}`,
      sessionId: `child-${batchIndex}-${index}`,
      launched: true,
    })),
  }))
  vi.mocked(sessionCollaborationApi.change).mockResolvedValue({} as never)
  openDialog(data)
  fireEvent.click(screen.getByLabelText('Select all'))
  const apply = screen.getByRole('button', { name: 'Apply to 9 sessions' })
  expect(apply).toBeDisabled()
  expect(apply).toHaveAccessibleDescription('Select at most 8 started sessions per change. Deselect a session to continue.')
  expect(sessionCollaborationApi.change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('Task 1-3'))
  const reduced = screen.getByRole('button', { name: 'Apply to 8 sessions' })
  expect(reduced).toBeEnabled()
  expect(screen.queryByText('Select at most 8 started sessions per change. Deselect a session to continue.')).not.toBeInTheDocument()
  fireEvent.click(reduced)
  await waitFor(() => expect(sessionCollaborationApi.change).toHaveBeenCalledTimes(1))
  const submitted = vi.mocked(sessionCollaborationApi.change).mock.calls[0]![1].selections
  expect(submitted).toHaveLength(8)
  expect(submitted.some(item => item.sessionId === 'child-1-3')).toBe(false)
})
