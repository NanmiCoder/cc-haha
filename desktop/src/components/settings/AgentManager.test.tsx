import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiListMock = vi.hoisted(() => vi.fn())
const apiCreateMock = vi.hoisted(() => vi.fn())
const apiUpdateMock = vi.hoisted(() => vi.fn())
const apiDeleteMock = vi.hoisted(() => vi.fn())
const apiReloadMock = vi.hoisted(() => vi.fn())
const apiSetOverrideMock = vi.hoisted(() => vi.fn())
const apiClearOverrideMock = vi.hoisted(() => vi.fn())
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
      setOverride: apiSetOverrideMock,
      clearOverride: apiClearOverrideMock,
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

function makeBuiltInAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType: 'Explore',
    description: 'Explore the codebase',
    source: 'built-in',
    baseDir: 'built-in',
    isActive: true,
    // Built-ins are never file-editable; only model and effort can change.
    editable: false,
    overridable: true,
    defaults: { model: 'haiku' },
    model: 'haiku',
    modelDisplay: 'haiku',
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
  const select = screen.getByRole('combobox', { name: label })
  const selectedOption = within(select).getByRole('option', { name: option }) as HTMLOptionElement
  fireEvent.change(select, { target: { value: selectedOption.value } })
}

function chooseAgentModel(option: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  const picker = screen.getByTestId('model-selector-dropdown')
  fireEvent.click(within(picker).getByRole('button', { name: option }))
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
    useSettingsStore.setState({
      locale: 'en',
      availableModels: [
        {
          id: 'provider/custom-model',
          name: 'Provider Custom',
          description: 'Current provider model',
          context: '200k',
        },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          description: 'Current provider model',
          context: '200k',
        },
      ],
    })
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
    expect(screen.getByRole('button', { name: 'Select a project...' }).tagName).toBe('BUTTON')
    fireEvent.click(screen.getByRole('button', { name: 'Select a project...' }))
    fireEvent.click(await screen.findByRole('option', { name: /Selected Project/ }))
    expect(screen.getByText('Target project: /workspace/selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const modelPicker = screen.getByTestId('model-selector-dropdown')
    const modelMenuOption = within(modelPicker).getByRole('button', { name: /fable/i })
    expect(modelMenuOption).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Create Agent' })).not.toContainElement(modelPicker)
    expect(modelPicker).toHaveClass('fixed', 'z-[var(--z-dropdown)]')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('heading', { name: 'Create Agent' })).toBeInTheDocument()
    expect(screen.queryByTestId('model-selector-dropdown')).not.toBeInTheDocument()
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
    fireEvent.click(await screen.findByRole('option', { name: /Project B/ }))
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

  it('creates an underscore slug with a configured provider model and effort, then selects the refreshed agent', async () => {
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
    chooseAgentModel(/Provider Custom/)
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
    chooseAgentModel(/Inherit from parent/)
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

  it('preserves a saved model ID that the current provider no longer lists', async () => {
    const agent = makeAgent({ model: 'legacy/provider-model' })
    apiListMock.mockResolvedValue({ activeAgents: [agent], allAgents: [agent] })
    apiUpdateMock.mockResolvedValue({ agent })
    useAgentStore.setState({ selectedAgent: agent, activeAgents: [agent], allAgents: [agent] })

    render(<AgentManager />)
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const picker = screen.getByTestId('model-selector-dropdown')
    expect(within(picker).getByRole('button', { name: /legacy\/provider-model.*not listed by the current provider/i })).toBeInTheDocument()
    fireEvent.click(within(picker).getByRole('button', { name: /legacy\/provider-model/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiUpdateMock).toHaveBeenCalledWith(
      'code_reviewer',
      expect.objectContaining({ model: 'legacy/provider-model' }),
    ))
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
    expect(screen.getByRole('combobox', { name: 'Tools' })).toHaveValue('none')
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
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('7')
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

  it('offers edit and delete on the row itself without nesting buttons', async () => {
    const agent = makeAgent()
    await renderManager({ activeAgents: [agent], allAgents: [agent] })

    const editButton = screen.getByRole('button', { name: 'Edit code_reviewer' })
    expect(editButton).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete code_reviewer' })).toBeInTheDocument()

    // The structural assertion is the one that matters: nested buttons still
    // render and still fire in jsdom, so behaviour alone cannot catch them.
    const row = editButton.closest('div.group')
    expect(row).not.toBeNull()
    expect(row!.querySelector('button button')).toBeNull()
  })

  it('keeps the row body clickable now that it is no longer the outer element', async () => {
    const agent = makeAgent()
    await renderManager({ activeAgents: [agent], allAgents: [agent] })

    fireEvent.click(screen.getByText('code_reviewer'))

    expect(await screen.findByRole('button', { name: 'Back to list' })).toBeInTheDocument()
    expect(useAgentStore.getState().selectedAgent?.agentType).toBe('code_reviewer')
  })

  it('deletes straight from the row with that row exact target', async () => {
    const agent = makeAgent({ source: 'projectSettings' })
    apiListMock
      .mockResolvedValueOnce({ activeAgents: [agent], allAgents: [agent] })
      .mockResolvedValueOnce(EMPTY_RESPONSE)
    apiDeleteMock.mockResolvedValue(undefined)

    render(<AgentManager />)
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Delete code_reviewer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Agent' }))

    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledWith(
      'code_reviewer',
      'project',
      '/workspace/project',
      'nested/custom-agent-file.md',
    ))
  })

  it('offers no row actions on sources that can be neither edited nor overridden', async () => {
    const plugin = makeAgent({
      agentType: 'plugin_agent',
      source: 'plugin',
      editable: false,
      target: undefined,
    })
    await renderManager({ activeAgents: [plugin], allAgents: [plugin] })

    expect(screen.queryByRole('button', { name: 'Edit plugin_agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete plugin_agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Adjust the model/ })).toBeNull()
  })

  it('offers a built-in row model adjustment but never a delete', async () => {
    const builtIn = makeBuiltInAgent()
    await renderManager({ activeAgents: [builtIn], allAgents: [builtIn] })

    expect(
      screen.getByRole('button', { name: 'Adjust the model and effort for Explore' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Explore' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Explore' })).toBeNull()
  })

  it('saves and resets an override through the active same-project session without a warning', async () => {
    const shipped = makeBuiltInAgent()
    const overridden = makeBuiltInAgent({
      model: 'deepseek-v4-pro',
      modelDisplay: 'deepseek-v4-pro',
      override: { model: 'deepseek-v4-pro', source: 'userSettings' },
    })
    let listedAgent = shipped
    apiListMock.mockImplementation(async () => ({
      activeAgents: [listedAgent],
      allAgents: [listedAgent],
    }))
    apiSetOverrideMock.mockImplementation(async () => {
      listedAgent = overridden
      return { agent: overridden }
    })
    apiClearOverrideMock.mockImplementation(async () => {
      listedAgent = shipped
      return { agent: shipped }
    })
    apiReloadMock.mockImplementation(async (sessionId: string) => ({
      ok: true,
      session: sessionId === 'running-session'
        ? {
            applied: true,
            commands: 0,
            agents: 1,
            plugins: 0,
            mcpServers: 0,
            // These are shared plugin/hook errors, not an Agent apply result.
            errors: 2,
          }
        : {
            applied: false,
            reason: 'not_running' as const,
            commands: 0,
            agents: 0,
            plugins: 0,
            mcpServers: 0,
            errors: 0,
          },
    }))
    useSessionStore.setState({
      sessions: [
        {
          id: 'stale-session',
          title: 'Older project session',
          createdAt: '',
          modifiedAt: '',
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
        {
          id: 'running-session',
          title: 'Running project session',
          createdAt: '',
          modifiedAt: '',
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
      activeSessionId: 'running-session',
    })

    render(<AgentManager />)
    await waitFor(() => expect(apiListMock).toHaveBeenCalledTimes(1))
    fireEvent.click(
      screen.getByRole('button', { name: 'Adjust the model and effort for Explore' }),
    )
    chooseAgentModel(/DeepSeek V4 Pro/)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiReloadMock).toHaveBeenCalledWith('running-session'))
    expect(apiReloadMock).not.toHaveBeenCalledWith('stale-session')
    await waitFor(() => expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: overridden,
      mutationWarning: null,
    }))
    expect(screen.queryByText(
      'The change was saved, but the latest agent configuration could not be fully applied.',
    )).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Adjust model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset to built-in default' }))

    await waitFor(() => expect(apiReloadMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useAgentStore.getState()).toMatchObject({
      selectedAgent: shipped,
      mutationWarning: null,
    }))
    expect(screen.queryByText(
      'The change was saved, but the latest agent configuration could not be fully applied.',
    )).toBeNull()
  })

  it('separates the built-in default from inherit and sends null for the default', async () => {
    const builtIn = makeBuiltInAgent()
    await renderManager({ activeAgents: [builtIn], allAgents: [builtIn] })
    apiSetOverrideMock.mockResolvedValue({ agent: builtIn })
    apiListMock.mockResolvedValue({ activeAgents: [builtIn], allAgents: [builtIn] })

    fireEvent.click(
      screen.getByRole('button', { name: 'Adjust the model and effort for Explore' }),
    )

    // Both entries must exist. For Explore the shipped default is haiku while
    // inherit means "follow the main session" — collapsing them would make
    // inherit unreachable, and the default label is read from the server.
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const modelPicker = screen.getByTestId('model-selector-dropdown')
    expect(within(modelPicker).getByRole('button', { name: /Built-in default \(haiku\)/ })).toBeInTheDocument()
    expect(within(modelPicker).getByRole('button', { name: /Inherit from parent/ })).toBeInTheDocument()
    fireEvent.click(within(modelPicker).getByRole('button', { name: /Built-in default \(haiku\)/ }))

    chooseAgentSelect('Reasoning effort', 'high')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // `null`, never the literal 'haiku': writing today's default into
    // settings.json would freeze it there forever.
    await waitFor(() => expect(apiSetOverrideMock).toHaveBeenCalledWith('Explore', {
      cwd: '/workspace/project',
      model: null,
      effort: 'high',
    }))
  })

  it('sends inherit as a real value when the user picks it', async () => {
    const builtIn = makeBuiltInAgent()
    await renderManager({ activeAgents: [builtIn], allAgents: [builtIn] })
    apiSetOverrideMock.mockResolvedValue({ agent: builtIn })
    apiListMock.mockResolvedValue({ activeAgents: [builtIn], allAgents: [builtIn] })

    fireEvent.click(
      screen.getByRole('button', { name: 'Adjust the model and effort for Explore' }),
    )
    chooseAgentModel(/Inherit from parent/)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiSetOverrideMock).toHaveBeenCalledWith('Explore', {
      cwd: '/workspace/project',
      model: 'inherit',
      effort: null,
    }))
  })

  it('resets a built-in through the server instead of writing the default back', async () => {
    const overridden = makeBuiltInAgent({
      model: 'sonnet',
      modelDisplay: 'sonnet',
      override: { model: 'sonnet', source: 'userSettings' },
    })
    await renderManager({ activeAgents: [overridden], allAgents: [overridden] })
    apiClearOverrideMock.mockResolvedValue({ agent: makeBuiltInAgent() })
    apiListMock.mockResolvedValue({ activeAgents: [overridden], allAgents: [overridden] })

    fireEvent.click(
      screen.getByRole('button', { name: 'Adjust the model and effort for Explore' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset to built-in default' }))

    await waitFor(() => expect(apiClearOverrideMock).toHaveBeenCalledWith(
      'Explore',
      '/workspace/project',
    ))
    // Reset must clear the setting, not write the current default back as a
    // value — that would pin today's default into settings.json permanently.
    expect(apiSetOverrideMock).not.toHaveBeenCalled()
    // A running session caches agent definitions, so the write alone is not
    // enough for the change to take effect.
    expect(apiReloadMock).toHaveBeenCalledWith('session-1')
  })

  it('locks the controls when the override comes from managed settings', async () => {
    const managed = makeBuiltInAgent({
      model: 'opus',
      override: { model: 'opus', source: 'policySettings' },
    })
    await renderManager({ activeAgents: [managed], allAgents: [managed] })

    fireEvent.click(
      screen.getByRole('button', { name: 'Adjust the model and effort for Explore' }),
    )

    expect(screen.getByRole('button', { name: 'Model' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    // Resetting would write to the user file, which cannot win over a policy.
    expect(screen.queryByRole('button', { name: 'Reset to built-in default' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Set by Managed settings and not editable here.',
    )
  })

  it('warns that a shadowed built-in will not take effect yet', async () => {
    // Editing a built-in that a same-named user agent shadows would look like
    // it worked and change nothing at spawn time.
    const shadowed = makeBuiltInAgent({ overriddenBy: 'userSettings', isActive: false })
    await renderManager({ activeAgents: [], allAgents: [shadowed] })

    fireEvent.click(
      screen.getByRole('button', { name: 'Adjust the model and effort for Explore' }),
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'An agent of the same name from User is active',
    )
  })

  it('keeps the override modal open when saving fails', async () => {
    const builtIn = makeBuiltInAgent()
    await renderManager({ activeAgents: [builtIn], allAgents: [builtIn] })
    apiSetOverrideMock.mockRejectedValue(new Error('AGENT_CUSTOMIZATION_LOCKED'))

    fireEvent.click(
      screen.getByRole('button', { name: 'Adjust the model and effort for Explore' }),
    )
    chooseAgentModel(/^sonnet/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save the override')
    expect(screen.getByRole('alert')).not.toHaveTextContent('AGENT_CUSTOMIZATION_LOCKED')
    expect(screen.getByRole('dialog', { name: 'Adjust built-in agent' })).toBeInTheDocument()
  })

  it('localizes load failures without exposing raw server errors', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    apiListMock.mockRejectedValue(new Error('HTTP 500: internal agent path leaked'))

    render(<AgentManager />)

    expect(await screen.findByText('加载 Agent 失败')).toBeInTheDocument()
    expect(screen.queryByText(/internal agent path leaked/)).not.toBeInTheDocument()
  })
})
