import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiListMock = vi.hoisted(() => vi.fn())
const apiCreateMock = vi.hoisted(() => vi.fn())
const apiUpdateMock = vi.hoisted(() => vi.fn())
const apiDeleteMock = vi.hoisted(() => vi.fn())
const apiReloadMock = vi.hoisted(() => vi.fn())
const recentProjectsMock = vi.hoisted(() => vi.fn())

vi.mock('../../api/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/agents')>()
  return {
    ...actual,
    agentsApi: {
      list: apiListMock,
      create: apiCreateMock,
      update: apiUpdateMock,
      delete: apiDeleteMock,
      reload: apiReloadMock,
    },
  }
})

vi.mock('../../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getRecentProjects: recentProjectsMock,
    },
  }
})

vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))

import type { AgentDefinition, AgentListResponse } from '../../api/agents'
import { useAgentStore } from '../../stores/agentStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { AgentManager } from './AgentManager'

const EMPTY_RESPONSE = { activeAgents: [], allAgents: [] }

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType: 'code_reviewer',
    description: 'Review code',
    systemPrompt: 'Review carefully.',
    model: 'opus',
    modelDisplay: 'claude-opus-4-6',
    effort: 'xhigh',
    tools: ['Read'],
    color: 'blue',
    source: 'userSettings',
    baseDir: '/Users/test/.claude/agents',
    target: 'nested/custom-agent-file.md',
    isActive: true,
    editable: true,
    ...overrides,
  }
}

function setProjectSession(cwd?: string) {
  useSessionStore.setState({
    sessions: cwd ? [{
      id: 'session-1',
      title: 'Project',
      createdAt: '',
      modifiedAt: '',
      messageCount: 0,
      projectPath: cwd,
      workDir: cwd,
      workDirExists: true,
    }] : [],
    activeSessionId: cwd ? 'session-1' : null,
  })
}

async function renderManager(response: AgentListResponse = EMPTY_RESPONSE) {
  apiListMock.mockResolvedValue(response)
  render(<AgentManager />)
  await waitFor(() => expect(apiListMock).toHaveBeenCalled())
}

function chooseAgentSelect(label: string, option: string) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('button', { name: option }))
}

describe('AgentManager', () => {
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
    recentProjectsMock.mockResolvedValue({ projects: [] })
    useSettingsStore.setState({ locale: 'en' })
    setProjectSession('/workspace/project')
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

  it('uses the shared project picker even when there is no active project', async () => {
    setProjectSession()
    recentProjectsMock.mockResolvedValue({
      projects: [{
        projectPath: '/workspace/selected',
        realPath: '/workspace/selected',
        projectName: 'Selected Project',
        repoName: 'Selected Project',
        isGit: true,
        sessionCount: 1,
        lastModified: '',
      }],
    })
    await renderManager()

    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    expect(screen.getByRole('button', { name: 'Select a project...' })).toBeInTheDocument()
    expect(document.querySelector('select')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select a project...' }))
    fireEvent.click(await screen.findByRole('button', { name: /Selected Project/ }))
    expect(screen.getByText('Target project: /workspace/selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const modelMenuOption = screen.getByRole('button', { name: 'fable' })
    expect(modelMenuOption).toBeInTheDocument()
    expect(modelMenuOption.parentElement).toHaveClass('bottom-full')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('heading', { name: 'Create Agent' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'fable' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('System prompt').parentElement).toHaveTextContent('System prompt*')
  })

  it('keeps the selected project context when creating and editing across projects', async () => {
    const created = makeAgent({
      source: 'projectSettings',
      baseDir: '/workspace/b/.claude/agents',
      target: '/workspace/b/.claude/agents/code_reviewer.md',
    })
    apiListMock
      .mockResolvedValueOnce({ ...EMPTY_RESPONSE, availableTools: ['Read', 'Grep', 'Bash'] })
      .mockResolvedValueOnce({ activeAgents: [created], allAgents: [created], availableTools: ['Read', 'Grep', 'Bash'] })
      .mockResolvedValueOnce({ activeAgents: [created], allAgents: [created] })
    apiCreateMock.mockResolvedValue({ agent: created })
    apiUpdateMock.mockResolvedValue({ agent: created })
    recentProjectsMock.mockResolvedValue({
      projects: [{
        projectPath: '/workspace/b',
        realPath: '/workspace/b',
        projectName: 'Project B',
        repoName: 'Project B',
        isGit: true,
        sessionCount: 1,
        lastModified: '',
      }],
    })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-a',
          title: 'Project A',
          createdAt: '',
          modifiedAt: '',
          messageCount: 0,
          projectPath: '/workspace/a',
          workDir: '/workspace/a',
          workDirExists: true,
        },
        {
          id: 'session-b',
          title: 'Project B',
          createdAt: '',
          modifiedAt: '',
          messageCount: 0,
          projectPath: '/workspace/b',
          workDir: '/workspace/b',
          workDirExists: true,
        },
      ],
      activeSessionId: 'session-a',
    })

    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    fireEvent.click(screen.getByTitle('/workspace/a'))
    fireEvent.click(await screen.findByRole('button', { name: /Project B/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'code_reviewer' } })
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Review code' } })
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Review carefully.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Agent Profile')).toBeInTheDocument()
    expect(apiListMock).toHaveBeenNthCalledWith(2, '/workspace/b')
    expect(apiReloadMock).toHaveBeenCalledWith('session-b')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Target project: /workspace/b')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiUpdateMock).toHaveBeenCalledWith(
      'code_reviewer',
      expect.objectContaining({ cwd: '/workspace/b' }),
    ))
    expect(apiListMock).toHaveBeenNthCalledWith(3, '/workspace/b')
  })

  it('creates an underscore slug with custom model and effort, then selects the refreshed agent', async () => {
    const created = makeAgent({
      source: 'projectSettings',
      model: 'provider/custom-model',
      modelDisplay: 'provider/custom-model',
      tools: ['Read', 'Agent(worker, researcher)'],
      color: 'purple',
    })
    apiListMock
      .mockResolvedValueOnce({ ...EMPTY_RESPONSE, availableTools: ['Read', 'Grep', 'Bash'] })
      .mockResolvedValueOnce({
        activeAgents: [created],
        allAgents: [created],
        availableTools: ['Read', 'Grep', 'Bash'],
      })
    apiCreateMock.mockResolvedValue({ agent: created })

    render(<AgentManager />)
    await waitFor(() => expect(useAgentStore.getState().availableTools).toContain('Read'))
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    expect(screen.getByText('Target project: /workspace/project')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'code_reviewer' } })
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Review code' } })
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Review carefully.' } })
    chooseAgentSelect('Model', 'Custom model ID')
    fireEvent.change(screen.getByLabelText(/^Custom model ID/), { target: { value: 'provider/custom-model' } })
    chooseAgentSelect('Reasoning effort', 'xhigh')
    chooseAgentSelect('Tools', 'Custom list')
    fireEvent.click(screen.getByRole('checkbox', { name: /Read/ }))
    fireEvent.change(screen.getByLabelText('Other tool names or permission patterns'), {
      target: { value: 'Agent(worker, researcher), Agent(worker, researcher)' },
    })
    chooseAgentSelect('Color', 'purple')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiCreateMock).toHaveBeenCalledWith({
      scope: 'project',
      cwd: '/workspace/project',
      name: 'code_reviewer',
      description: 'Review code',
      systemPrompt: 'Review carefully.',
      model: 'provider/custom-model',
      effort: 'xhigh',
      tools: ['Read', 'Agent(worker, researcher)'],
      color: 'purple',
    }))
    expect(apiReloadMock).toHaveBeenCalledWith('session-1')
    expect(await screen.findByText('Agent Profile')).toBeInTheDocument()
    expect(useAgentStore.getState().selectedAgent).toEqual(created)
  })

  it('lets users discover and select built-in tools without memorizing their names', async () => {
    const created = makeAgent({
      tools: ['Read', 'Grep', 'mcp__docs__search', 'Bash(git:*)'],
    })
    apiListMock
      .mockResolvedValueOnce({
        ...EMPTY_RESPONSE,
        availableTools: ['Read', 'Grep', 'Bash', 'Edit'],
      })
      .mockResolvedValueOnce({
        activeAgents: [created],
        allAgents: [created],
        availableTools: ['Read', 'Grep', 'Bash', 'Edit'],
      })
    apiCreateMock.mockResolvedValue({ agent: created })

    render(<AgentManager />)
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'code_reviewer' } })
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Review code' } })
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Review carefully.' } })
    chooseAgentSelect('Tools', 'Custom list')

    expect(screen.getByText('Built-in tools')).toBeInTheDocument()
    expect(screen.getByText('Read files and directories')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search tools'), { target: { value: 'search files' } })
    expect(screen.getByRole('checkbox', { name: /Grep/ })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Edit/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search tools'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Read/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Grep/ }))
    fireEvent.change(screen.getByLabelText('Other tool names or permission patterns'), {
      target: { value: 'mcp__docs__search, Bash(git:*)' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['Read', 'Grep', 'mcp__docs__search', 'Bash(git:*)'],
      }),
    ))
  })

  it('uses the source project when the active worktree is no longer available', async () => {
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        title: 'Removed worktree',
        createdAt: '',
        modifiedAt: '',
        messageCount: 0,
        projectPath: '/workspace/removed-worktree',
        projectRoot: '/workspace/source-project',
        workDir: '/workspace/removed-worktree',
        workDirExists: false,
        workspaceState: 'worktree_removed',
      }],
      activeSessionId: 'session-1',
    })
    await renderManager()

    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project' }))

    expect(screen.getByText('Target project: /workspace/source-project')).toBeInTheDocument()
  })

  it('rejects names longer than 64 characters before calling the API', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: `a${'b'.repeat(64)}` } })
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Review code' } })
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Review carefully.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText(/1–64 lowercase letters/)).toBeInTheDocument()
    expect(apiCreateMock).not.toHaveBeenCalled()
  })

  it('keeps same-name definitions with different targets independently selectable', async () => {
    const rootAgent = makeAgent({ description: 'Root definition', target: 'code-reviewer.md' })
    const nestedAgent = makeAgent({ description: 'Nested definition', target: 'nested/custom-agent-file.md' })
    await renderManager({
      activeAgents: [rootAgent, nestedAgent],
      allAgents: [rootAgent, nestedAgent],
    })

    expect(screen.getAllByText('code_reviewer')).toHaveLength(2)
    fireEvent.click(screen.getByText('Nested definition').closest('button')!)

    expect(useAgentStore.getState().selectedAgent).toBe(nestedAgent)
    expect(screen.getByText('nested/custom-agent-file.md')).toBeInTheDocument()
  })

  it('distinguishes inherited, disabled, and custom tool access', async () => {
    const inherited = makeAgent({
      agentType: 'all_tools',
      description: 'All tools',
      target: '/agents/all-tools.md',
      tools: undefined,
    })
    const disabled = makeAgent({
      agentType: 'no_tools',
      description: 'No tools',
      target: '/agents/no-tools.md',
      tools: [],
    })
    const custom = makeAgent({
      agentType: 'custom_tools',
      description: 'Custom tools',
      target: '/agents/custom-tools.md',
      tools: ['Read', 'Grep'],
    })
    await renderManager({
      activeAgents: [inherited, disabled, custom],
      allAgents: [inherited, disabled, custom],
    })

    expect(screen.getByText('No tool restriction')).toBeInTheDocument()
    expect(screen.getByText('No tools allowed')).toBeInTheDocument()
    expect(screen.getByText('2 tools')).toBeInTheDocument()

    fireEvent.click(screen.getByText('No tools').closest('button')!)
    expect(screen.getByText('/agents/no-tools.md')).toBeInTheDocument()
    expect(screen.getByText('No tools allowed')).toBeInTheDocument()
  })

  it('sends explicit nulls when an editable agent returns to inherited defaults', async () => {
    const agent = makeAgent()
    const updated = makeAgent({ model: undefined, effort: undefined, tools: undefined, color: undefined })
    apiListMock
      .mockResolvedValueOnce({ activeAgents: [agent], allAgents: [agent] })
      .mockResolvedValueOnce({ activeAgents: [updated], allAgents: [updated] })
    apiUpdateMock.mockResolvedValue({ agent: updated })
    useAgentStore.setState({ selectedAgent: agent, activeAgents: [agent], allAgents: [agent] })

    render(<AgentManager />)
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    chooseAgentSelect('Model', 'Inherit from parent')
    chooseAgentSelect('Reasoning effort', 'Inherit from parent')
    chooseAgentSelect('Tools', 'All tools')
    chooseAgentSelect('Color', 'Default')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiUpdateMock).toHaveBeenCalledWith('code_reviewer', {
      scope: 'user',
      cwd: '/workspace/project',
      target: 'nested/custom-agent-file.md',
      name: 'code_reviewer',
      description: 'Review code',
      systemPrompt: 'Review carefully.',
      model: null,
      effort: null,
      tools: null,
      color: null,
    }))
    expect(screen.getAllByText('Inherit').length).toBeGreaterThanOrEqual(2)
  })

  it('preserves an explicit empty tools list when editing only the description', async () => {
    const agent = makeAgent({ tools: [] })
    const updated = makeAgent({ tools: [], description: 'Updated review' })
    apiListMock.mockResolvedValue({
      activeAgents: [updated],
      allAgents: [updated],
      availableTools: ['Read'],
    })
    apiUpdateMock.mockResolvedValue({ agent: updated })
    useAgentStore.setState({ selectedAgent: agent, activeAgents: [agent], allAgents: [agent] })

    render(<AgentManager />)
    await waitFor(() => expect(useAgentStore.getState().availableTools).toContain('Read'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveTextContent('No tools')
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Updated review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiUpdateMock).toHaveBeenCalled())
    expect(apiUpdateMock.mock.calls[0]?.[1]).toMatchObject({
      description: 'Updated review',
      tools: [],
    })
  })

  it('preserves parenthesized tool names with commas when editing only the description', async () => {
    const originalTools = ['Agent(worker, researcher)', 'Read']
    const agent = makeAgent({ tools: originalTools })
    const updated = makeAgent({ tools: originalTools, description: 'Updated review' })
    apiListMock.mockResolvedValue({
      activeAgents: [updated],
      allAgents: [updated],
      availableTools: ['Read'],
    })
    apiUpdateMock.mockResolvedValue({ agent: updated })
    useAgentStore.setState({ selectedAgent: agent, activeAgents: [agent], allAgents: [agent] })

    render(<AgentManager />)
    await waitFor(() => expect(useAgentStore.getState().availableTools).toContain('Read'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('checkbox', { name: /Read/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Other tool names or permission patterns')).toHaveValue(
      'Agent(worker, researcher)',
    )
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Updated review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiUpdateMock).toHaveBeenCalled())
    expect(apiUpdateMock.mock.calls[0]?.[1]).toMatchObject({
      description: 'Updated review',
      tools: originalTools,
    })
  })

  it('preserves a legacy numeric effort when editing another field', async () => {
    const agent = makeAgent({ effort: 7 })
    apiListMock.mockResolvedValue({ activeAgents: [agent], allAgents: [agent] })
    apiUpdateMock.mockResolvedValue({ agent })
    useAgentStore.setState({ selectedAgent: agent, activeAgents: [agent], allAgents: [agent] })

    render(<AgentManager />)
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Reasoning effort' })).toHaveTextContent('7')
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Updated review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiUpdateMock).toHaveBeenCalled())
    expect(apiUpdateMock.mock.calls[0]?.[1]).toMatchObject({ effort: 7, description: 'Updated review' })
  })

  it('allows a metadata-only edit when the existing system prompt body is empty', async () => {
    const agent = makeAgent({ systemPrompt: '', effort: 'medium' })
    const updated = makeAgent({ systemPrompt: '', effort: 'high' })
    apiListMock.mockResolvedValue({ activeAgents: [updated], allAgents: [updated] })
    apiUpdateMock.mockResolvedValue({ agent: updated })
    useAgentStore.setState({ selectedAgent: agent, activeAgents: [agent], allAgents: [agent] })

    render(<AgentManager />)
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const prompt = screen.getByLabelText('System prompt')
    expect(prompt).toHaveValue('')
    expect(prompt.parentElement).not.toHaveTextContent('System prompt*')
    chooseAgentSelect('Reasoning effort', 'high')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiUpdateMock).toHaveBeenCalled())
    expect(apiUpdateMock.mock.calls[0]?.[1]).toMatchObject({
      systemPrompt: '',
      effort: 'high',
    })
  })

  it('deletes an editable project agent and returns to the refreshed list', async () => {
    const agent = makeAgent({ source: 'projectSettings' })
    apiListMock
      .mockResolvedValueOnce({ activeAgents: [agent], allAgents: [agent] })
      .mockResolvedValueOnce(EMPTY_RESPONSE)
    apiDeleteMock.mockResolvedValue(undefined)
    useAgentStore.setState({ selectedAgent: agent, activeAgents: [agent], allAgents: [agent] })

    render(<AgentManager />)
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('File: nested/custom-agent-file.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Agent' }))

    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledWith(
      'code_reviewer',
      'project',
      '/workspace/project',
      'nested/custom-agent-file.md',
    ))
    expect(apiReloadMock).toHaveBeenCalledWith('session-1')
    expect(await screen.findByText('No agents available yet.')).toBeInTheDocument()
    expect(useAgentStore.getState().selectedAgent).toBeNull()
  })

  it('keeps non-user and non-project agents read-only even if the API marks them editable', async () => {
    const agent = makeAgent({ source: 'built-in', editable: true })
    apiListMock.mockResolvedValue({ activeAgents: [agent], allAgents: [agent] })
    useAgentStore.setState({ selectedAgent: agent, activeAgents: [agent], allAgents: [agent] })

    await act(async () => render(<AgentManager />))

    expect(screen.getByText('Read only')).toBeInTheDocument()
    expect(screen.getByText('Configured model')).toBeInTheDocument()
    expect(screen.getByText('Configured effort')).toBeInTheDocument()
    expect(screen.getByText('Runtime may lower or omit this value when the selected model does not support it.')).toBeInTheDocument()
    expect(screen.getByText('opus')).toBeInTheDocument()
    expect(screen.queryByText('Resolved model')).not.toBeInTheDocument()
    expect(screen.queryByText('claude-opus-4-6')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('shows a non-blocking refresh warning with a retry action', async () => {
    const agent = makeAgent()
    await renderManager({ activeAgents: [agent], allAgents: [agent] })

    act(() => useAgentStore.setState({ mutationWarning: 'Refresh unavailable' }))

    expect(screen.getByRole('status')).toHaveTextContent(
      'The change was saved, but the latest agent configuration could not be fully applied.',
    )
    expect(screen.getByRole('status')).not.toHaveTextContent('Refresh unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(2))
    expect(apiReloadMock).toHaveBeenCalledWith('session-1')
  })

  it('keeps the form open and shows a mutation error', async () => {
    apiCreateMock.mockRejectedValue(new Error('Agent already exists'))
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'reviewer' } })
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Review code' } })
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Review carefully.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save agent')
    expect(screen.getByRole('alert')).not.toHaveTextContent('Agent already exists')
    expect(apiCreateMock.mock.calls[0]?.[0]).not.toHaveProperty('tools')
    expect(screen.getByRole('dialog', { name: 'Create Agent' })).toBeInTheDocument()
  })

  it('localizes load failures without exposing raw server errors', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    apiListMock.mockRejectedValue(new Error('HTTP 500: internal agent path leaked'))

    render(<AgentManager />)

    expect(await screen.findByText('加载 Agent 失败')).toBeInTheDocument()
    expect(screen.queryByText(/internal agent path leaked/)).not.toBeInTheDocument()
  })
})
