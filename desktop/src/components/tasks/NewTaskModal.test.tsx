import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { NewTaskModal } from './NewTaskModal'
import { useAdapterStore } from '../../stores/adapterStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import { invalidateRecentProjectsCache, setCachedRecentProjects } from '../../lib/recentProjectsCache'

afterEach(() => {
  cleanup()
  invalidateRecentProjectsCache()
  useAdapterStore.setState(useAdapterStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

describe('NewTaskModal', () => {
  it('saves the displayed default provider and current model without requiring a selector click', async () => {
    useSessionStore.setState({ activeSessionId: 'project-session', sessions: [{ id: 'project-session', title: 'Project', createdAt: '', modifiedAt: '', messageCount: 0, projectPath: '/workspace/project', projectRoot: '/workspace/project', workDir: '/workspace/project', workDirExists: true }] })
    const createTask = vi.fn(async () => {})
    useTaskStore.setState({ createTask })
    useAdapterStore.setState({ fetchConfig: vi.fn(async () => {}), config: {} })
    useSettingsStore.setState({
      locale: 'en', currentModel: { id: 'provider-fast', name: 'provider-fast', description: '', context: '' },
      activeProviderName: 'Provider A',
    })
    useProviderStore.setState({
      providers: [{ id: 'provider-a', presetId: 'custom', name: 'Provider A', apiKey: 'fixture', baseUrl: 'https://api.example.com', apiFormat: 'anthropic', models: { main: 'provider-main', haiku: 'provider-fast', sonnet: 'provider-main', opus: '' } }],
      activeId: 'provider-a', hasLoadedProviders: true, isLoading: true,
    })
    render(<NewTaskModal open onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: /provider-fast/i })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Use visible model' } })
    fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), { target: { value: 'Check the fixture.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(createTask).toHaveBeenCalledOnce())
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'provider-a', model: 'provider-fast' }))
  })

  it('creates scheduled tasks with a provider-scoped model selection', async () => {
    useSessionStore.setState({ activeSessionId: 'project-session', sessions: [{ id: 'project-session', title: 'Project', createdAt: '', modifiedAt: '', messageCount: 0, projectPath: '/workspace/project', projectRoot: '/workspace/project', workDir: '/workspace/project', workDirExists: true }] })
    const createTask = vi.fn(async () => {})
    useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
    useAdapterStore.setState({
      fetchConfig: vi.fn(async () => {}),
      config: {},
    } as Partial<ReturnType<typeof useAdapterStore.getState>>)
    useSettingsStore.setState({
      locale: 'en',
      currentModel: {
        id: 'provider-main',
        name: 'provider-main',
        description: '',
        context: '',
      },
      availableModels: [
        { id: 'claude-sonnet-4-6', name: 'Sonnet', description: '', context: '' },
      ],
      activeProviderName: 'Provider A',
    })
    useProviderStore.setState({
      providers: [{
        id: 'provider-a',
        presetId: 'custom',
        name: 'Provider A',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: 'provider-fast',
          sonnet: 'provider-main',
          opus: '',
        },
      }],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })

    render(<NewTaskModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'provider cron' },
    })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'exercise provider selection' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
      target: { value: 'Say hello from the scheduled task.' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /provider-main/i }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /provider-fast/i }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      model: 'provider-fast',
      providerId: 'provider-a',
      permissionMode: 'bypassPermissions',
      enabled: true,
      recurring: true,
    }))
  })

  it('defaults the folder to the project root when the active session ran in an isolated worktree', async () => {
    const createTask = vi.fn(async () => {})
    useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
    useAdapterStore.setState({
      fetchConfig: vi.fn(async () => {}),
      config: {},
    } as Partial<ReturnType<typeof useAdapterStore.getState>>)
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      sessions: [{
        id: 'wt-1',
        title: 'Worktree Session',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 3,
        projectPath: '/workspace/repo',
        projectRoot: '/workspace/repo',
        workDir: '/workspace/repo/.claude/worktrees/desktop-main-12345678',
        workDirExists: true,
      }],
      activeSessionId: 'wt-1',
    })

    render(<NewTaskModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'worktree cron' },
    })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'exercise worktree folder default' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
      target: { value: 'Say hello from the scheduled task.' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      folderPath: '/workspace/repo',
    }))
  })

  describe('schedule controls', () => {
    function renderModal() {
      useSettingsStore.setState({ locale: 'en' })
      useAdapterStore.setState({
        fetchConfig: vi.fn(async () => {}),
        config: {},
      } as Partial<ReturnType<typeof useAdapterStore.getState>>)
      return render(<NewTaskModal open onClose={vi.fn()} />)
    }

    it('gives the frequency select a name', () => {
      // All seven native selects in the app shipped without a label or an
      // `aria-label`, leaving them nameless in the accessibility tree.
      renderModal()
      expect(screen.getByLabelText('Frequency')).toHaveValue('daily')
    })

    it('names the time field even though it shares the frequency caption', () => {
      // One「频率」heading covers both controls, so the time input carries its
      // name on `aria-label` rather than a second visible label.
      renderModal()
      expect(screen.getByLabelText('Run time')).toHaveValue('09:00')
    })

    it('announces an invalid custom cron instead of only printing it', () => {
      renderModal()
      fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'customCron' } })

      const cronField = screen.getByLabelText('Custom cron expression')
      fireEvent.change(cronField, { target: { value: 'not a cron' } })

      expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('Invalid cron expression'))).toBe(true)
      expect(cronField).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
    })
  })
})

describe('conversation schedules', () => {
  function inheritedNewChatTask() {
    useSettingsStore.setState({ locale: 'en' })
    useAdapterStore.setState({ fetchConfig: vi.fn(async () => {}), config: {} })
    useSessionStore.setState({
      activeSessionId: 'other',
      sessions: ['source', 'other'].map(id => ({
        id, title: id, createdAt: '', modifiedAt: '', messageCount: 0,
        projectPath: `/workspace/${id}`, projectRoot: `/workspace/${id}`, workDir: `/workspace/${id}`, workDirExists: true,
      })),
    })
    return {
      id: 'task', name: 'Check', prompt: 'Check source repo', cron: '0 9 * * *',
      enabled: true, createdAt: 1, revision: 1, sourceSessionId: 'source',
      execution: { kind: 'new-session' as const },
      schedule: { kind: 'cron' as const, expression: '0 9 * * *', timeZone: 'UTC' },
    }
  }

  it.each([true, false])('keeps workspace and model inheritance when renamed from another chat (source loaded: %s)', async sourceLoaded => {
    const task = inheritedNewChatTask()
    if (!sourceLoaded) useSessionStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== 'source') }))
    const updateTask = vi.fn(async (_id: string, _updates: unknown) => {})
    useTaskStore.setState({ updateTask })
    render(<NewTaskModal open onClose={vi.fn()} editTask={task} />)
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Rename only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    expect(updateTask.mock.calls[0]![1]).toMatchObject({ name: 'Rename only', revision: 1 })
    for (const field of ['folderPath', 'model', 'providerId']) expect(updateTask.mock.calls[0]![1]).not.toHaveProperty(field)
  })

  it('snapshots the visible runtime when converting a source-less session task to a new chat', async () => {
    const inherited = inheritedNewChatTask()
    const { sourceSessionId: _sourceSessionId, ...task } = inherited
    useSettingsStore.setState({ currentModel: { id: 'visible-model', name: 'visible-model', description: '', context: '' }, activeProviderName: 'Provider A' })
    useProviderStore.setState({ providers: [{ id: 'provider-a', presetId: 'custom', name: 'Provider A', apiKey: 'fixture', baseUrl: 'https://api.example.com', apiFormat: 'anthropic', models: { main: 'visible-model', haiku: '', sonnet: '', opus: '' } }], activeId: 'provider-a', hasLoadedProviders: true, isLoading: true })
    const updateTask = vi.fn(async (_id: string, _updates: unknown) => {})
    useTaskStore.setState({ updateTask })
    render(<NewTaskModal open onClose={vi.fn()} editTask={{ ...task, execution: { kind: 'session', targetSessionId: 'source' } }} />)
    fireEvent.change(screen.getByLabelText('Execution'), { target: { value: 'new-session' } })
    expect(screen.getByRole('button', { name: /visible-model/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    expect(updateTask.mock.calls[0]![1]).toMatchObject({
      execution: { kind: 'new-session' }, folderPath: '/workspace/other', model: 'visible-model', providerId: 'provider-a',
    })
  })

  it('saves an explicit workspace override while leaving an inherited model unchanged', async () => {
    const task = inheritedNewChatTask()
    const updateTask = vi.fn(async (_id: string, _updates: unknown) => {})
    useTaskStore.setState({ updateTask })
    setCachedRecentProjects([{
      projectPath: '/workspace/selected', realPath: '/workspace/selected', projectName: 'Selected project',
      isGit: false, repoName: null, branch: null, modifiedAt: '', sessionCount: 0,
    }])
    render(<NewTaskModal open onClose={vi.fn()} editTask={task} />)
    fireEvent.click(screen.getByRole('button', { name: 'source' }))
    fireEvent.click(await screen.findByRole('option', { name: /Selected project/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    expect(updateTask.mock.calls[0]![1]).toMatchObject({ folderPath: '/workspace/selected' })
    for (const field of ['model', 'providerId']) expect(updateTask.mock.calls[0]![1]).not.toHaveProperty(field)
  })

  it('saves a one-shot in the selected zone without overriding the target chat runtime', async () => {
    useSettingsStore.setState({ locale: 'en' })
    useAdapterStore.setState({ fetchConfig: vi.fn(async () => {}), config: {} })
    const updateTask = vi.fn(async (_id: string, _updates: unknown) => {})
    useTaskStore.setState({ updateTask })
    render(<NewTaskModal open onClose={vi.fn()} editTask={{
      id: 'task', name: 'Check build', prompt: 'Check build', description: '', cron: '0 9 * * *',
      enabled: true, createdAt: 1, revision: 7,
      execution: { kind: 'session', targetSessionId: 'chat' },
      schedule: { kind: 'once', runAt: '2035-10-26T01:00:00.000Z', timeZone: 'Asia/Shanghai' },
      model: 'legacy-model', providerId: 'legacy-provider', permissionMode: 'bypassPermissions',
    }} />)
    expect(screen.getByLabelText('Date and time')).toHaveValue('2035-10-26T09:00')
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2035-10-26T10:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    const payload = updateTask.mock.calls[0]![1]
    expect(payload).toMatchObject({ revision: 7, recurring: false, execution: { kind: 'session', targetSessionId: 'chat' }, schedule: { kind: 'once', runAt: '2035-10-26T02:00:00.000Z', timeZone: 'Asia/Shanghai' } })
    for (const key of ['model', 'providerId', 'permissionMode', 'folderPath']) expect(payload).not.toHaveProperty(key)
  })

  it.each(['once', 'cron'] as const)('does not reschedule an unchanged %s schedule when editing its name', async kind => {
    useSettingsStore.setState({ locale: 'en' })
    useAdapterStore.setState({ fetchConfig: vi.fn(async () => {}), config: {} })
    const updateTask = vi.fn(async (_id: string, _updates: unknown) => {})
    useTaskStore.setState({ updateTask })
    render(<NewTaskModal open onClose={vi.fn()} editTask={{
      id: 'task', name: 'Check', prompt: 'Check', cron: '0 9 * * *', enabled: false, createdAt: 1, revision: 3,
      scheduleState: 'completed', execution: { kind: 'session', targetSessionId: 'chat' },
      schedule: kind === 'once' ? { kind, runAt: '2020-01-01T01:00:23Z', timeZone: 'Asia/Shanghai' } : { kind, expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
    }} />)
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    expect(updateTask.mock.calls[0]![1]).toMatchObject({ name: 'Renamed', revision: 3 })
    for (const field of ['schedule', 'recurring', 'cron']) expect(updateTask.mock.calls[0]![1]).not.toHaveProperty(field)
  })

  it('requires a workspace before creating a new-chat task without a source chat', () => {
    useSettingsStore.setState({ locale: 'en' })
    useAdapterStore.setState({ fetchConfig: vi.fn(async () => {}), config: {} })
    render(<NewTaskModal open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Check' } })
    fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), { target: { value: 'Check build' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a workspace folder')
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
  })

  it('retains the independent execution mode of a legacy task and displays save errors', async () => {
    useSettingsStore.setState({ locale: 'en' })
    useAdapterStore.setState({ fetchConfig: vi.fn(async () => {}), config: {} })
    const updateTask = vi.fn(async (_id: string, _updates: unknown) => { throw new Error('Task changed in another window') })
    useTaskStore.setState({ updateTask })
    render(<NewTaskModal open onClose={vi.fn()} editTask={{ id: 'legacy', name: 'Check', prompt: 'Check', cron: '0 9 * * *', enabled: true, createdAt: 1 }} />)
    expect(screen.getByLabelText('Execution')).toHaveValue('legacy')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Task changed in another window'))
    expect(updateTask.mock.calls[0]![1]).not.toHaveProperty('execution')
  })
})
