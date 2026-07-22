import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiListMock = vi.hoisted(() => vi.fn())
const apiCreateMock = vi.hoisted(() => vi.fn())
const apiUpdateMock = vi.hoisted(() => vi.fn())
const apiDeleteMock = vi.hoisted(() => vi.fn())
const apiReloadMock = vi.hoisted(() => vi.fn())

vi.mock('../api/agents', () => ({
  agentsApi: {
    list: apiListMock,
    create: apiCreateMock,
    update: apiUpdateMock,
    delete: apiDeleteMock,
    reload: apiReloadMock,
  },
}))

import type { AgentDefinition, AgentMutationInput } from '../api/agents'
import { useAgentStore } from './agentStore'

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType: 'reviewer',
    description: 'Review code',
    source: 'userSettings',
    isActive: true,
    editable: true,
    ...overrides,
  }
}

function makeInput(overrides: Partial<AgentMutationInput> = {}): AgentMutationInput {
  return {
    scope: 'user',
    cwd: '/workspace/current',
    name: 'reviewer',
    description: 'Review code',
    systemPrompt: 'Review carefully.',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('agentStore', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    apiReloadMock.mockResolvedValue({
      ok: true,
      session: {
        applied: true,
        commands: 0,
        agents: 1,
        plugins: 0,
        mcpServers: 0,
        errors: 0,
      },
    })
    useAgentStore.setState({
      activeAgents: [],
      allAgents: [],
      availableTools: [],
      isLoading: false,
      isMutating: false,
      error: null,
      mutationError: null,
      mutationWarning: null,
      selectedAgent: null,
      selectedAgentReturnTab: 'agents',
    })
  })

  it('rebinds the selected agent to the refreshed definition', async () => {
    const target = 'nested/custom-agent-file.md'
    const staleAgent = makeAgent({ description: 'Old description', target })
    const sameNameOtherFile = makeAgent({ description: 'Other file', target: 'reviewer.md' })
    const refreshedAgent = makeAgent({ description: 'New description', target })
    useAgentStore.setState({ selectedAgent: staleAgent, selectedAgentReturnTab: 'plugins' })
    apiListMock.mockResolvedValue({
      activeAgents: [sameNameOtherFile, refreshedAgent],
      allAgents: [sameNameOtherFile, refreshedAgent],
    })

    await useAgentStore.getState().fetchAgents('/workspace/current')

    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: refreshedAgent,
      selectedAgentReturnTab: 'plugins',
      isLoading: false,
      error: null,
    })
  })

  it('clears a selected project agent that is absent after switching projects', async () => {
    useAgentStore.setState({
      selectedAgent: makeAgent({ source: 'projectSettings' }),
      selectedAgentReturnTab: 'plugins',
    })
    apiListMock.mockResolvedValue({ activeAgents: [], allAgents: [] })

    await useAgentStore.getState().fetchAgents('/workspace/new-project')

    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: null,
      selectedAgentReturnTab: 'agents',
    })
  })

  it('ignores a slower response from the previously selected project', async () => {
    const oldRequest = deferred<{ activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }>()
    const newRequest = deferred<{ activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }>()
    const oldAgent = makeAgent({ agentType: 'old-project', source: 'projectSettings' })
    const newAgent = makeAgent({ agentType: 'new-project', source: 'projectSettings' })
    apiListMock.mockImplementation((cwd: string) => cwd.endsWith('old') ? oldRequest.promise : newRequest.promise)

    const oldFetch = useAgentStore.getState().fetchAgents('/workspace/old')
    const newFetch = useAgentStore.getState().fetchAgents('/workspace/new')
    newRequest.resolve({ activeAgents: [newAgent], allAgents: [newAgent] })
    await newFetch
    oldRequest.resolve({ activeAgents: [oldAgent], allAgents: [oldAgent] })
    await oldFetch

    expect(useAgentStore.getState()).toMatchObject({
      activeAgents: [newAgent],
      allAgents: [newAgent],
      isLoading: false,
      error: null,
    })
  })

  it('ignores a stale request failure after the current project succeeds', async () => {
    const oldRequest = deferred<{ activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }>()
    const currentAgent = makeAgent()
    apiListMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({ activeAgents: [currentAgent], allAgents: [currentAgent] })

    const oldFetch = useAgentStore.getState().fetchAgents('/workspace/old')
    await useAgentStore.getState().fetchAgents('/workspace/current')
    oldRequest.reject(new Error('Old project failed'))
    await oldFetch

    expect(useAgentStore.getState()).toMatchObject({ allAgents: [currentAgent], error: null })
  })

  it.each([
    [new Error('Network unavailable'), 'Network unavailable'],
    ['unexpected rejection', 'Failed to load agents'],
  ])('records the current fetch failure without throwing', async (failure, expectedMessage) => {
    apiListMock.mockRejectedValue(failure)

    await expect(useAgentStore.getState().fetchAgents()).resolves.toBeUndefined()

    expect(useAgentStore.getState()).toMatchObject({ isLoading: false, error: expectedMessage })
  })

  it('creates a user agent, refreshes the lists, and selects it', async () => {
    const createdAgent = makeAgent({ target: 'reviewer.md' })
    const sameNameNestedAgent = makeAgent({ target: 'nested/custom-agent-file.md' })
    const input = makeInput()
    apiCreateMock.mockResolvedValue({ agent: createdAgent })
    apiListMock.mockResolvedValue({
      activeAgents: [sameNameNestedAgent, createdAgent],
      allAgents: [sameNameNestedAgent, createdAgent],
    })

    await expect(
      useAgentStore.getState().createAgent(input, 'session-1'),
    ).resolves.toBe(createdAgent)

    expect(apiCreateMock).toHaveBeenCalledWith(input)
    expect(apiReloadMock).toHaveBeenCalledWith('session-1')
    expect(apiListMock).toHaveBeenCalledWith('/workspace/current')
    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: createdAgent,
      selectedAgentReturnTab: 'agents',
      isMutating: false,
      mutationError: null,
    })
  })

  it('finishes a create while the active session reload is still pending', async () => {
    const reload = deferred<never>()
    const createdAgent = makeAgent({ target: 'reviewer.md' })
    apiCreateMock.mockResolvedValue({ agent: createdAgent })
    apiListMock.mockResolvedValue({
      activeAgents: [createdAgent],
      allAgents: [createdAgent],
    })
    apiReloadMock.mockReturnValue(reload.promise)

    await expect(
      useAgentStore.getState().createAgent(makeInput(), 'session-1'),
    ).resolves.toBe(createdAgent)

    expect(apiReloadMock).toHaveBeenCalledWith('session-1')
    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: createdAgent,
      isMutating: false,
      mutationWarning: null,
    })

    reload.reject(new Error('Session reload unavailable'))
    await vi.waitFor(() => expect(useAgentStore.getState().mutationWarning).toBe(
      'Session reload unavailable',
    ))
  })

  it('ignores a late reload warning after switching projects', async () => {
    const reload = deferred<never>()
    const createdAgent = makeAgent({ target: 'reviewer.md' })
    const currentAgent = makeAgent({ agentType: 'current-project', source: 'projectSettings' })
    apiCreateMock.mockResolvedValue({ agent: createdAgent })
    apiListMock
      .mockResolvedValueOnce({ activeAgents: [createdAgent], allAgents: [createdAgent] })
      .mockResolvedValueOnce({ activeAgents: [currentAgent], allAgents: [currentAgent] })
    apiReloadMock.mockReturnValue(reload.promise)

    await useAgentStore.getState().createAgent(makeInput(), 'session-1')
    await useAgentStore.getState().fetchAgents('/workspace/current-project')
    reload.reject(new Error('Old session reload failed'))
    await Promise.resolve()
    await Promise.resolve()

    expect(useAgentStore.getState()).toMatchObject({
      allAgents: [currentAgent],
      mutationWarning: null,
    })
  })

  it('does not let a mutation refresh overwrite a later project switch', async () => {
    const mutationRefresh = deferred<{ activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }>()
    const currentRefresh = deferred<{ activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }>()
    const oldAgent = makeAgent({ source: 'projectSettings' })
    const currentAgent = makeAgent({ agentType: 'current-project', source: 'projectSettings' })
    apiCreateMock.mockResolvedValue({ agent: oldAgent })
    apiListMock
      .mockReturnValueOnce(mutationRefresh.promise)
      .mockReturnValueOnce(currentRefresh.promise)

    const mutation = useAgentStore.getState().createAgent(makeInput({ scope: 'project' }))
    await vi.waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    const currentFetch = useAgentStore.getState().fetchAgents('/workspace/current-project')
    currentRefresh.resolve({ activeAgents: [currentAgent], allAgents: [currentAgent] })
    await currentFetch
    mutationRefresh.resolve({ activeAgents: [oldAgent], allAgents: [oldAgent] })
    await expect(mutation).resolves.toBe(oldAgent)

    expect(useAgentStore.getState()).toMatchObject({
      activeAgents: [currentAgent],
      allAgents: [currentAgent],
      selectedAgent: null,
      isMutating: false,
    })
  })

  it('falls back to the successful create response when it is missing from the refreshed list', async () => {
    const createdAgent = makeAgent({ target: 'reviewer.md' })
    apiCreateMock.mockResolvedValue({ agent: createdAgent })
    apiListMock.mockResolvedValue({ activeAgents: [], allAgents: [] })

    await expect(useAgentStore.getState().createAgent(makeInput())).resolves.toBe(createdAgent)

    expect(useAgentStore.getState()).toMatchObject({
      activeAgents: [createdAgent],
      allAgents: [createdAgent],
      selectedAgent: createdAgent,
      isMutating: false,
      mutationError: null,
      mutationWarning: 'Created agent was not returned by the refreshed list',
    })
  })

  it('keeps a successful create and inserts only its exact target when refresh fails', async () => {
    const existingAgent = makeAgent({ target: 'nested/custom-agent-file.md' })
    const createdAgent = makeAgent({ target: 'reviewer.md' })
    useAgentStore.setState({
      activeAgents: [existingAgent],
      allAgents: [existingAgent],
    })
    apiCreateMock.mockResolvedValue({ agent: createdAgent })
    apiListMock.mockRejectedValue(new Error('Refresh unavailable'))

    await expect(useAgentStore.getState().createAgent(makeInput())).resolves.toBe(createdAgent)

    expect(useAgentStore.getState()).toMatchObject({
      activeAgents: [createdAgent],
      allAgents: [existingAgent, createdAgent],
      selectedAgent: createdAgent,
      isMutating: false,
      mutationError: null,
      mutationWarning: 'Refresh unavailable',
    })
  })

  it('replaces a lower-priority active definition in the create fallback', async () => {
    const builtInAgent = makeAgent({
      source: 'built-in',
      editable: false,
      target: undefined,
    })
    const createdAgent = makeAgent({
      source: 'userSettings',
      target: 'reviewer.md',
      isActive: true,
    })
    useAgentStore.setState({
      activeAgents: [builtInAgent],
      allAgents: [builtInAgent],
    })
    apiCreateMock.mockResolvedValue({ agent: createdAgent })
    apiListMock.mockRejectedValue(new Error('Refresh unavailable'))

    await useAgentStore.getState().createAgent(makeInput())

    expect(useAgentStore.getState()).toMatchObject({
      activeAgents: [createdAgent],
      allAgents: [builtInAgent, createdAgent],
      selectedAgent: createdAgent,
      mutationWarning: 'Refresh unavailable',
    })
  })

  it('uses a fallback mutation error for non-Error create failures', async () => {
    apiCreateMock.mockRejectedValue('unexpected rejection')

    await expect(useAgentStore.getState().createAgent(makeInput())).rejects.toBe('unexpected rejection')
    expect(useAgentStore.getState().mutationError).toBe('Failed to create agent')
  })

  it('updates and selects the refreshed project-scoped definition', async () => {
    const target = 'nested/custom-agent-file.md'
    const updatedAgent = makeAgent({ source: 'projectSettings', description: 'Updated', target })
    const sameNameOtherFile = makeAgent({
      source: 'projectSettings',
      description: 'Wrong file',
      target: 'reviewer.md',
    })
    const input = makeInput({ scope: 'project', description: 'Updated', target })
    apiUpdateMock.mockResolvedValue({ agent: updatedAgent })
    apiListMock.mockResolvedValue({
      activeAgents: [sameNameOtherFile, updatedAgent],
      allAgents: [sameNameOtherFile, updatedAgent],
    })

    await expect(
      useAgentStore.getState().updateAgent('reviewer', input, 'session-1'),
    ).resolves.toBe(updatedAgent)

    expect(apiUpdateMock).toHaveBeenCalledWith('reviewer', input)
    expect(apiReloadMock).toHaveBeenCalledWith('session-1')
    expect(useAgentStore.getState().selectedAgent).toBe(updatedAgent)
  })

  it('finishes an update while the active session reload is still pending', async () => {
    const reload = deferred<never>()
    const updatedAgent = makeAgent({ description: 'Updated', target: 'reviewer.md' })
    apiUpdateMock.mockResolvedValue({ agent: updatedAgent })
    apiListMock.mockResolvedValue({
      activeAgents: [updatedAgent],
      allAgents: [updatedAgent],
    })
    apiReloadMock.mockReturnValue(reload.promise)

    await expect(useAgentStore.getState().updateAgent(
      'reviewer',
      makeInput({ description: 'Updated' }),
      'session-1',
    )).resolves.toBe(updatedAgent)

    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: updatedAgent,
      isMutating: false,
      mutationWarning: null,
    })

    reload.reject(new Error('Session reload unavailable'))
    await vi.waitFor(() => expect(useAgentStore.getState().mutationWarning).toBe(
      'Session reload unavailable',
    ))
  })

  it('does not expose an old mutation failure after a new project fetch succeeds', async () => {
    const mutationRequest = deferred<void>()
    const currentAgent = makeAgent({ agentType: 'current-project', source: 'projectSettings' })
    apiUpdateMock.mockReturnValue(mutationRequest.promise)
    apiListMock.mockResolvedValue({ activeAgents: [currentAgent], allAgents: [currentAgent] })

    const mutation = useAgentStore.getState().updateAgent(
      'reviewer',
      makeInput({ scope: 'project', target: 'nested/custom-agent-file.md' }),
    )
    await vi.waitFor(() => expect(apiUpdateMock).toHaveBeenCalledTimes(1))
    await useAgentStore.getState().fetchAgents('/workspace/current-project')
    mutationRequest.reject(new Error('Old project update failed'))
    await expect(mutation).rejects.toThrow('Old project update failed')

    expect(useAgentStore.getState()).toMatchObject({
      allAgents: [currentAgent],
      selectedAgent: null,
      isLoading: false,
      isMutating: false,
      error: null,
      mutationError: null,
    })
  })

  it('does not let an update refresh overwrite a later project switch', async () => {
    const mutationRefresh = deferred<{ activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }>()
    const currentAgent = makeAgent({ agentType: 'current-project', source: 'projectSettings' })
    const updatedAgent = makeAgent({ source: 'projectSettings', description: 'Updated' })
    apiUpdateMock.mockResolvedValue({ agent: updatedAgent })
    apiListMock
      .mockReturnValueOnce(mutationRefresh.promise)
      .mockResolvedValueOnce({ activeAgents: [currentAgent], allAgents: [currentAgent] })

    const mutation = useAgentStore.getState().updateAgent(
      'reviewer',
      makeInput({ scope: 'project', description: 'Updated' }),
    )
    await vi.waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    await useAgentStore.getState().fetchAgents('/workspace/current-project')
    mutationRefresh.resolve({ activeAgents: [updatedAgent], allAgents: [updatedAgent] })
    await expect(mutation).resolves.toBe(updatedAgent)

    expect(useAgentStore.getState()).toMatchObject({
      allAgents: [currentAgent],
      selectedAgent: null,
      isMutating: false,
    })
  })

  it('falls back to the successful update response when it is missing from the refreshed list', async () => {
    const updatedAgent = makeAgent({ description: 'Updated', target: 'reviewer.md' })
    apiUpdateMock.mockResolvedValue({ agent: updatedAgent })
    apiListMock.mockResolvedValue({ activeAgents: [], allAgents: [] })

    await expect(useAgentStore.getState().updateAgent('reviewer', makeInput())).resolves.toBe(updatedAgent)
    expect(useAgentStore.getState()).toMatchObject({
      activeAgents: [updatedAgent],
      allAgents: [updatedAgent],
      selectedAgent: updatedAgent,
      mutationError: null,
      mutationWarning: 'Updated agent was not returned by the refreshed list',
    })
  })

  it('keeps a successful update and replaces only its exact target when refresh fails', async () => {
    const target = 'nested/custom-agent-file.md'
    const originalAgent = makeAgent({ description: 'Original', target })
    const sameNameOtherFile = makeAgent({ description: 'Other file', target: 'reviewer.md' })
    const updatedAgent = makeAgent({ description: 'Updated', target })
    useAgentStore.setState({
      activeAgents: [sameNameOtherFile, originalAgent],
      allAgents: [sameNameOtherFile, originalAgent],
      selectedAgent: originalAgent,
    })
    apiUpdateMock.mockResolvedValue({ agent: updatedAgent })
    apiListMock.mockRejectedValue(new Error('Refresh unavailable'))

    await expect(useAgentStore.getState().updateAgent(
      'reviewer',
      makeInput({ description: 'Updated', target }),
    )).resolves.toBe(updatedAgent)

    expect(useAgentStore.getState()).toMatchObject({
      activeAgents: [updatedAgent],
      allAgents: [sameNameOtherFile, updatedAgent],
      selectedAgent: updatedAgent,
      mutationError: null,
      mutationWarning: 'Refresh unavailable',
    })
  })

  it('deletes an agent and clears the detail selection after refreshing', async () => {
    const target = 'nested/custom-agent-file.md'
    useAgentStore.setState({ selectedAgent: makeAgent({ target }), selectedAgentReturnTab: 'plugins' })
    apiDeleteMock.mockResolvedValue(undefined)
    apiListMock.mockResolvedValue({ activeAgents: [], allAgents: [] })

    await useAgentStore.getState().deleteAgent(
      'reviewer',
      'user',
      '/workspace/current',
      target,
      'session-1',
    )

    expect(apiDeleteMock).toHaveBeenCalledWith('reviewer', 'user', '/workspace/current', target)
    expect(apiReloadMock).toHaveBeenCalledWith('session-1')
    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: null,
      selectedAgentReturnTab: 'agents',
      isMutating: false,
      mutationError: null,
    })
  })

  it('finishes a delete while the active session reload is still pending', async () => {
    const reload = deferred<never>()
    apiDeleteMock.mockResolvedValue(undefined)
    apiListMock.mockResolvedValue({ activeAgents: [], allAgents: [] })
    apiReloadMock.mockReturnValue(reload.promise)

    await expect(useAgentStore.getState().deleteAgent(
      'reviewer',
      'project',
      '/workspace/current',
      'reviewer.md',
      'session-1',
    )).resolves.toBeUndefined()

    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: null,
      isMutating: false,
      mutationWarning: null,
    })

    reload.reject(new Error('Session reload unavailable'))
    await vi.waitFor(() => expect(useAgentStore.getState().mutationWarning).toBe(
      'Session reload unavailable',
    ))
  })

  it('does not let a delete refresh clear the selection from a later project switch', async () => {
    const mutationRefresh = deferred<{ activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }>()
    const currentAgent = makeAgent({ agentType: 'current-project', source: 'projectSettings' })
    apiDeleteMock.mockResolvedValue(undefined)
    apiListMock
      .mockReturnValueOnce(mutationRefresh.promise)
      .mockResolvedValueOnce({ activeAgents: [currentAgent], allAgents: [currentAgent] })

    const mutation = useAgentStore.getState().deleteAgent('reviewer', 'project', '/workspace/old-project')
    await vi.waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    await useAgentStore.getState().fetchAgents('/workspace/current-project')
    useAgentStore.setState({ selectedAgent: currentAgent })
    mutationRefresh.resolve({ activeAgents: [], allAgents: [] })
    await mutation

    expect(useAgentStore.getState()).toMatchObject({
      allAgents: [currentAgent],
      selectedAgent: currentAgent,
      isMutating: false,
    })
  })

  it('keeps a successful delete and removes only its exact target when refresh fails', async () => {
    const target = 'nested/custom-agent-file.md'
    const deletedAgent = makeAgent({ target })
    const sameNameOtherFile = makeAgent({ target: 'reviewer.md' })
    useAgentStore.setState({
      activeAgents: [sameNameOtherFile, deletedAgent],
      allAgents: [sameNameOtherFile, deletedAgent],
      selectedAgent: deletedAgent,
      selectedAgentReturnTab: 'plugins',
    })
    apiDeleteMock.mockResolvedValue(undefined)
    apiListMock.mockRejectedValue(new Error('Refresh unavailable'))

    await expect(useAgentStore.getState().deleteAgent(
      'reviewer',
      'user',
      '/workspace/current',
      target,
    )).resolves.toBeUndefined()

    expect(useAgentStore.getState()).toMatchObject({
      activeAgents: [sameNameOtherFile],
      allAgents: [sameNameOtherFile],
      selectedAgent: null,
      selectedAgentReturnTab: 'agents',
      mutationError: null,
      mutationWarning: 'Refresh unavailable',
    })
  })

  it('keeps a successful mutation when the active session reload fails', async () => {
    const createdAgent = makeAgent({ target: 'reviewer.md' })
    apiCreateMock.mockResolvedValue({ agent: createdAgent })
    apiListMock.mockResolvedValue({
      activeAgents: [createdAgent],
      allAgents: [createdAgent],
    })
    apiReloadMock.mockRejectedValue(new Error('Session reload unavailable'))

    await expect(
      useAgentStore.getState().createAgent(makeInput(), 'session-1'),
    ).resolves.toBe(createdAgent)

    expect(apiCreateMock).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: createdAgent,
      isMutating: false,
      mutationError: null,
      mutationWarning: 'Session reload unavailable',
    })
  })

  it('warns when the active session is no longer running and retries both refreshes', async () => {
    const agent = makeAgent()
    apiCreateMock.mockResolvedValue({ agent })
    apiListMock.mockResolvedValue({ activeAgents: [agent], allAgents: [agent] })
    apiReloadMock.mockResolvedValueOnce({
      ok: true,
      session: {
        applied: false,
        reason: 'not_running',
        commands: 0,
        agents: 0,
        plugins: 0,
        mcpServers: 0,
        errors: 0,
      },
    }).mockResolvedValueOnce({
      ok: true,
      session: {
        applied: true,
        commands: 0,
        agents: 1,
        plugins: 0,
        mcpServers: 0,
        errors: 0,
      },
    })

    await useAgentStore.getState().createAgent(makeInput(), 'session-1')
    expect(useAgentStore.getState().mutationWarning).toContain(
      'active CLI session is not running',
    )

    await useAgentStore.getState().retryMutationRefresh(
      '/workspace/current',
      'session-1',
    )
    expect(apiListMock).toHaveBeenCalledTimes(2)
    expect(apiReloadMock).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().mutationWarning).toBeNull()
  })

  it('reports reload error counts without turning a saved update into a failure', async () => {
    const updatedAgent = makeAgent({ description: 'Updated' })
    apiUpdateMock.mockResolvedValue({ agent: updatedAgent })
    apiListMock.mockResolvedValue({
      activeAgents: [updatedAgent],
      allAgents: [updatedAgent],
    })
    apiReloadMock.mockResolvedValue({
      ok: true,
      session: {
        applied: true,
        commands: 0,
        agents: 1,
        plugins: 0,
        mcpServers: 0,
        errors: 2,
      },
    })

    await expect(
      useAgentStore.getState().updateAgent(
        'reviewer',
        makeInput({ description: 'Updated' }),
        'session-1',
      ),
    ).resolves.toBe(updatedAgent)
    expect(useAgentStore.getState().mutationWarning).toBe(
      'The active CLI session reloaded with 2 agent loading errors.',
    )
  })

  it('keeps the selection and exposes a delete failure', async () => {
    const selectedAgent = makeAgent()
    useAgentStore.setState({ selectedAgent })
    apiDeleteMock.mockRejectedValue(new Error('Delete denied'))

    await expect(useAgentStore.getState().deleteAgent('reviewer', 'user')).rejects.toThrow('Delete denied')

    expect(useAgentStore.getState()).toMatchObject({
      selectedAgent,
      isMutating: false,
      mutationError: 'Delete denied',
    })
  })

  it('resets the return destination when clearing a selection', () => {
    const agent = makeAgent()

    useAgentStore.getState().selectAgent(agent, 'plugins')
    expect(useAgentStore.getState()).toMatchObject({ selectedAgent: agent, selectedAgentReturnTab: 'plugins' })

    useAgentStore.getState().selectAgent(null, 'plugins')
    expect(useAgentStore.getState()).toMatchObject({ selectedAgent: null, selectedAgentReturnTab: 'agents' })
  })
})
