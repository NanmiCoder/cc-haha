import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { McpSettings } from '../pages/McpSettings'
import { sessionsApi } from '../api/sessions'
import { mcpApi } from '../api/mcp'
import { useUIStore } from '../stores/uiStore'
import { useMcpStore } from '../stores/mcpStore'
import { useSessionStore } from '../stores/sessionStore'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useSettingsStore } from '../stores/settingsStore'
import { invalidateRecentProjectsCache } from '../lib/recentProjectsCache'
import type { McpReconnectResult, McpSessionSync } from '../types/mcp'

vi.mock('../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getRecentProjects: vi.fn(),
    },
  }
})

vi.mock('../api/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/mcp')>()
  return {
    ...actual,
    mcpApi: {
      ...actual.mcpApi,
      projectPaths: vi.fn(),
      projectSharing: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  }
})

const originalAddToast = useUIStore.getState().addToast

async function renderLoadedMcpSettings() {
  const result = render(<McpSettings />)
  await waitFor(() => {
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  return result
}

function makeSharedServer(projectPath: string) {
  return {
    name: 'shared-tools',
    scope: 'project',
    transport: 'stdio',
    enabled: true,
    status: 'connected' as const,
    statusLabel: 'Connected',
    configLocation: `${projectPath}/.mcp.json`,
    summary: 'npx shared-tools',
    canEdit: true,
    canRemove: true,
    canReconnect: true,
    canToggle: true,
    projectPath,
    config: { type: 'stdio' as const, command: 'npx', args: ['shared-tools'], env: {} },
  }
}

describe('McpSettings', () => {
  beforeEach(() => {
    useUIStore.setState({ addToast: originalAddToast, toasts: [] })
    invalidateRecentProjectsCache()
    useTabStore.setState({ tabs: [], activeTabId: null, lastSessionTabId: null })
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{
        projectPath: '/workspace/selected-project',
        realPath: '/workspace/selected-project',
        projectName: 'selected-project',
        repoName: 'org/selected-project',
        branch: 'main',
        isGit: true,
        modifiedAt: '2026-05-25T00:00:00.000Z',
        sessionCount: 1,
      }],
    })
    vi.mocked(mcpApi.projectPaths).mockResolvedValue({
      projectPaths: ['/workspace/config-project'],
    })
    vi.mocked(mcpApi.projectSharing).mockImplementation(async (_name, paths, sourceCwd) => ({
      projects: paths.map(projectPath => ({ projectPath, revision: null, selected: projectPath === sourceCwd })),
    }))
    vi.mocked(mcpApi.create).mockReset()
    vi.mocked(mcpApi.update).mockReset()
    vi.mocked(mcpApi.remove).mockReset()
    vi.mocked(mcpApi.remove).mockResolvedValue({ ok: true })
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Test Session',
          createdAt: '',
          modifiedAt: '',
          messageCount: 0,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
      activeSessionId: 'session-1',
      isLoading: false,
      error: null,
      fetchSessions: vi.fn(),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      updateSessionTitle: vi.fn(),
      setActiveSession: vi.fn(),
    })
    useMcpStore.setState({
      servers: [],
      selectedServer: null,
      isLoading: false,
      error: null,
      fetchServers: vi.fn().mockResolvedValue(undefined),
      createServer: vi.fn(),
      updateServer: vi.fn(),
      deleteServer: vi.fn(),
      toggleServer: vi.fn(),
      reconnectServer: vi.fn(),
      refreshServerStatus: vi.fn(),
      selectServer: vi.fn(),
    })
  })

  it('loads MCP servers for the active and recent projects on mount', async () => {
    const fetchServers = vi.fn().mockResolvedValue(undefined)
    useMcpStore.setState({ fetchServers })

    render(<McpSettings />)

    await waitFor(() => {
      expect(fetchServers).toHaveBeenCalledWith(
        ['/workspace/project', '/workspace/selected-project', '/workspace/config-project'],
        '/workspace/project',
      )
    })
  })

  it('shows a loading state before project MCP paths and servers finish loading', async () => {
    let resolveRecentProjects!: (value: Awaited<ReturnType<typeof sessionsApi.getRecentProjects>>) => void
    const fetchServers = vi.fn().mockResolvedValue(undefined)
    vi.mocked(sessionsApi.getRecentProjects).mockImplementation(() => new Promise((resolve) => {
      resolveRecentProjects = resolve
    }))
    useMcpStore.setState({ fetchServers })

    render(<McpSettings />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading...')
    expect(screen.queryByText('No MCP servers configured yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Total servers')).not.toBeInTheDocument()

    await act(async () => {
      resolveRecentProjects({ projects: [] })
    })

    await waitFor(() => {
      expect(fetchServers).toHaveBeenCalledWith(['/workspace/project', '/workspace/config-project'], '/workspace/project')
    })
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })

  it('keeps cached MCP servers visible while a remount refresh is pending', async () => {
    vi.mocked(sessionsApi.getRecentProjects).mockImplementation(() => new Promise(() => {}))
    useMcpStore.setState({
      servers: [{
        name: 'cached-user',
        scope: 'user',
        transport: 'http',
        enabled: true,
        status: 'connected',
        statusLabel: 'Connected',
        configLocation: '/tmp/config',
        summary: 'https://example.com/mcp',
        canEdit: true,
        canRemove: true,
        canReconnect: true,
        canToggle: true,
        config: { type: 'http', url: 'https://example.com/mcp', headers: {} },
      }],
    })

    render(<McpSettings />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('cached-user')).toBeInTheDocument()
  })

  it('renders the empty state and add button', async () => {
    await renderLoadedMcpSettings()

    expect(screen.getByText('MCP servers')).toBeInTheDocument()
    expect(screen.getByText('No MCP servers configured yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add server/i })).toBeInTheDocument()
  })

  it('shows plugin and user MCP servers in grouped sections', async () => {
    useMcpStore.setState({
      servers: [
        {
          name: 'plugin:telegram:telegram',
          scope: 'dynamic',
          transport: 'stdio',
          enabled: true,
          status: 'connected',
          statusLabel: 'Connected',
          configLocation: '/tmp/config',
          summary: 'npx @telegram/mcp',
          canEdit: false,
          canRemove: false,
          canReconnect: true,
          canToggle: true,
          config: { type: 'stdio', command: 'npx', args: ['@telegram/mcp'], env: {} },
        },
        {
          name: 'global-user',
          scope: 'user',
          transport: 'http',
          enabled: true,
          status: 'connected',
          statusLabel: 'Connected',
          configLocation: '/tmp/config',
          summary: 'https://example.com/mcp',
          canEdit: true,
          canRemove: true,
          canReconnect: true,
          canToggle: true,
          config: { type: 'http', url: 'https://example.com/mcp', headers: {} },
        },
      ],
    })

    await renderLoadedMcpSettings()

    expect(screen.getAllByText('Plugin').length).toBeGreaterThan(0)
    expect(screen.getAllByText('User').length).toBeGreaterThan(0)
    expect(screen.getByText('plugin:telegram:telegram')).toBeInTheDocument()
    expect(screen.getByText('global-user')).toBeInTheDocument()
  })

  it('redacts sensitive MCP command details from the list and details views', async () => {
    const server = {
      name: 'context7',
      scope: 'local',
      transport: 'stdio',
      enabled: true,
      status: 'connected',
      statusLabel: 'Connected',
      configLocation: '/workspace/project/.mcp.json',
      summary: 'npx context7 --api-key sk-summary-secret',
      canEdit: false,
      canRemove: false,
      canReconnect: true,
      canToggle: true,
      projectPath: '/workspace/project',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['context7', '--api-key', 'sk-argument-secret'],
        env: { CONTEXT7_API_KEY: 'sk-env-secret' },
      },
    } as const

    useMcpStore.setState({ servers: [server] })

    await renderLoadedMcpSettings()

    expect(document.body.textContent).not.toContain('sk-summary-secret')
    expect(document.body.textContent).not.toContain('sk-argument-secret')
    expect(document.body.textContent).not.toContain('sk-env-secret')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open context7' }))
    })

    expect(document.body.textContent).not.toContain('sk-summary-secret')
    expect(document.body.textContent).not.toContain('sk-argument-secret')
    expect(document.body.textContent).not.toContain('sk-env-secret')
  })

  it('redacts editable MCP secrets without replacing unchanged values on save', async () => {
    const server = {
      name: 'context7',
      scope: 'local',
      transport: 'stdio',
      enabled: true,
      status: 'connected',
      statusLabel: 'Connected',
      configLocation: '/workspace/project/.mcp.json',
      summary: 'npx context7 --api-key sk-summary-edit-secret',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      projectPath: '/workspace/project',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['context7', '--api-key', 'sk-argument-edit-secret'],
        env: {
          CONTEXT7_API_KEY: 'sk-env-edit-secret',
          LOG_LEVEL: 'debug',
        },
      },
    } as const
    const updateServer = vi.fn().mockResolvedValue(server)

    useMcpStore.setState({ servers: [server], updateServer })

    await renderLoadedMcpSettings()

    expect(document.body.textContent).not.toContain('sk-summary-edit-secret')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open context7' }))
    })

    expect(document.body.textContent).not.toContain('sk-summary-edit-secret')
    expect(document.body.textContent).not.toContain('sk-argument-edit-secret')
    expect(document.body.textContent).not.toContain('sk-env-edit-secret')
    expect(screen.queryByDisplayValue('sk-argument-edit-secret')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('sk-env-edit-secret')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('debug')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(updateServer).toHaveBeenCalledWith(
      server,
      {
        scope: 'local',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['context7', '--api-key', 'sk-argument-edit-secret'],
          env: {
            CONTEXT7_API_KEY: 'sk-env-edit-secret',
            LOG_LEVEL: 'debug',
          },
        },
      },
      '/workspace/project',
    )
  })

  it('uses the server MCP name rules before enabling Save', async () => {
    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^User/i }))
    })

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'bad name' } })
    fireEvent.change(screen.getByLabelText(/Command to launch/), { target: { value: 'echo' } })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'bad/name' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'bad.name' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: '某某服务器' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('switches transport from the segmented control on create and locks it while editing', async () => {
    const server = {
      name: 'global-user',
      scope: 'user',
      transport: 'http',
      enabled: true,
      status: 'connected',
      statusLabel: 'Connected',
      configLocation: '/tmp/config',
      summary: 'https://example.com/mcp',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      config: { type: 'http', url: 'https://example.com/mcp', headers: {} },
    } as const
    useMcpStore.setState({ servers: [server] })

    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    })

    const transport = screen.getByRole('radiogroup', { name: 'Transport' })
    expect(screen.getByRole('radio', { name: 'STDIO' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText(/Command to launch/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Streamable HTTP' }))
    expect(screen.getByRole('radio', { name: 'Streamable HTTP' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByLabelText(/Command to launch/)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^URL/)).toBeInTheDocument()
    expect(transport).not.toHaveTextContent(/expand_more|check/)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /back/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open global-user' }))
    })

    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Streamable HTTP' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('If you would like to switch MCP server type, uninstall first.')).toBeInTheDocument()
  })

  it('keeps same-name project MCP servers distinct by project path', async () => {
    useMcpStore.setState({
      servers: [
        {
          name: 'context7',
          scope: 'local',
          transport: 'stdio',
          enabled: true,
          status: 'connected',
          statusLabel: 'Connected',
          configLocation: '/workspace/project-a/.claude.json',
          summary: 'npx @upstash/context7-mcp',
          canEdit: true,
          canRemove: true,
          canReconnect: true,
          canToggle: true,
          projectPath: '/workspace/project-a',
          config: { type: 'stdio', command: 'npx', args: ['@upstash/context7-mcp'], env: {} },
        },
        {
          name: 'context7',
          scope: 'local',
          transport: 'stdio',
          enabled: true,
          status: 'connected',
          statusLabel: 'Connected',
          configLocation: '/workspace/project-b/.claude.json',
          summary: 'npx @upstash/context7-mcp',
          canEdit: true,
          canRemove: true,
          canReconnect: true,
          canToggle: true,
          projectPath: '/workspace/project-b',
          config: { type: 'stdio', command: 'npx', args: ['@upstash/context7-mcp'], env: {} },
        },
      ],
    })

    await renderLoadedMcpSettings()

    expect(screen.getAllByText('context7')).toHaveLength(2)
    expect(screen.getByText('/workspace/project-a')).toBeInTheDocument()
    expect(screen.getByText('/workspace/project-b')).toBeInTheDocument()
  })

  it('starts background status refresh after the fast list render', async () => {
    const server = {
      name: 'deepwiki',
      scope: 'user',
      transport: 'http',
      enabled: true,
      status: 'checking' as const,
      statusLabel: 'Checking',
      configLocation: '/tmp/config',
      summary: 'https://example.com/mcp',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      config: { type: 'http' as const, url: 'https://example.com/mcp', headers: {} },
    }
    const refreshServerStatus = vi.fn().mockResolvedValue({
      ...server,
      status: 'connected' as const,
      statusLabel: 'Connected',
    })

    useMcpStore.setState({
      servers: [server],
      refreshServerStatus,
    })

    await renderLoadedMcpSettings()

    expect(screen.getByText('Checking')).toBeInTheDocument()

    await waitFor(() => {
      expect(refreshServerStatus).toHaveBeenCalledWith(server, '/workspace/project')
    })
  })

  it('shows another project server as configured without probing or counting it as connected', async () => {
    const refreshServerStatus = vi.fn()
    useMcpStore.setState({
      servers: [{
        name: 'maya',
        scope: 'project',
        transport: 'stdio',
        enabled: true,
        status: 'connected',
        statusLabel: 'Connected',
        configLocation: '/workspace/maya/.mcp.json',
        summary: 'python maya_server.py',
        canEdit: true,
        canRemove: true,
        canReconnect: true,
        canToggle: true,
        projectPath: '/workspace/maya',
        activeInCurrentContext: false,
        config: { type: 'stdio', command: 'python', args: ['maya_server.py'], env: {} },
      }],
      refreshServerStatus,
    })

    await renderLoadedMcpSettings()

    expect(screen.getByText('maya')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show projects' })).not.toBeInTheDocument()
    expect(screen.queryByText('1 projects')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open maya' })).toBeInTheDocument()
    expect(screen.getByText('Configured')).toBeInTheDocument()
    expect(screen.getByText('Not loaded in the current chat. Open a chat in this project to use it.')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.getByText('Connection checks for current project').parentElement?.parentElement).toHaveTextContent('0')
    expect(refreshServerStatus).not.toHaveBeenCalled()
  })

  it('renders a single project copy without expansion controls', async () => {
    useMcpStore.setState({ servers: [makeSharedServer('/workspace/project-a')] })

    await renderLoadedMcpSettings()

    expect(screen.queryByRole('button', { name: 'Show projects' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide projects' })).not.toBeInTheDocument()
    expect(screen.queryByText('1 projects')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open shared-tools' })).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeInTheDocument()
    expect(screen.getByText('/workspace/project-a')).toBeInTheDocument()
  })

  it('shows a disabled project copy as disabled rather than configured', async () => {
    useMcpStore.setState({
      servers: [{ ...makeSharedServer('/workspace/project-a'), enabled: false }],
    })

    await renderLoadedMcpSettings()

    expect(screen.getByText('Disabled')).toBeInTheDocument()
    expect(screen.queryByText('Configured')).not.toBeInTheDocument()
    expect(screen.queryByText(
      'Not loaded in the current chat. Open a chat in this project to use it.',
    )).not.toBeInTheDocument()
    expect(screen.getByRole('switch')).not.toBeChecked()
  })

  it('shows the disabled count on a multi-project service group', async () => {
    useMcpStore.setState({
      servers: [
        makeSharedServer('/workspace/project-a'),
        { ...makeSharedServer('/workspace/project-b'), enabled: false },
      ],
    })

    await renderLoadedMcpSettings()

    expect(screen.getByText('1 disabled')).toBeInTheDocument()
  })

  it('opens the delete confirmation modal from the edit view and deletes with the active cwd', async () => {
    const deleteServer = vi.fn().mockResolvedValue(undefined)
    const server = {
      name: 'global-user',
      scope: 'user',
      transport: 'http',
      enabled: true,
      status: 'connected',
      statusLabel: 'Connected',
      configLocation: '/tmp/config',
      summary: 'https://example.com/mcp',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      config: { type: 'http', url: 'https://example.com/mcp', headers: {} },
    } as const

    useMcpStore.setState({
      servers: [server],
      deleteServer,
    })

    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open global-user' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /uninstall/i }))
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Delete MCP server')).toBeInTheDocument()
    expect(screen.getByText('Delete MCP server "global-user"? This action cannot be undone.')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    })

    expect(deleteServer).toHaveBeenCalledWith(server, '/workspace/project')
  })

  it('uses a neutral title when configuring an editable MCP server', async () => {
    const server = {
      name: 'filesystem',
      scope: 'user',
      transport: 'stdio',
      enabled: true,
      status: 'connected',
      statusLabel: 'Connected',
      configLocation: '/tmp/config',
      summary: 'npx @modelcontextprotocol/server-filesystem',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem'],
        env: {},
      },
    } as const

    useMcpStore.setState({ servers: [server] })

    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open filesystem' }))
    })

    expect(screen.getByRole('heading', { name: 'Configure filesystem MCP' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Update filesystem MCP' })).not.toBeInTheDocument()
  })

  it('uses the active cwd when toggling a server', async () => {
    const toggleServer = vi.fn()
    const server = {
      name: 'global-user',
      scope: 'user',
      transport: 'http',
      enabled: true,
      status: 'connected',
      statusLabel: 'Connected',
      configLocation: '/tmp/config',
      summary: 'https://example.com/mcp',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      config: { type: 'http', url: 'https://example.com/mcp', headers: {} },
    } as const

    toggleServer.mockResolvedValue({ server: { ...server, enabled: false }, sessionSync: { applied: true } })
    useMcpStore.setState({
      servers: [server],
      toggleServer,
    })

    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('switch'))
    })

    expect(toggleServer).toHaveBeenCalledWith(server, '/workspace/project', 'session-1')
  })

  it.each([
    [{ applied: false, reason: 'failed', error: 'Control timeout' }, 'warning', 'Control timeout'],
    [{ applied: false, reason: 'not_running' }, 'warning', 'chat is not running'],
    [{ applied: false, reason: 'different_project' }, 'warning', 'different project'],
    [{ applied: false, reason: 'no_session' }, 'warning', 'No chat was selected'],
    [{ applied: false, reason: 'lean_profile' }, 'warning', 'Lean mode, which does not use MCP servers'],
    [undefined, 'warning', 'not confirmed'],
    [{ applied: true }, 'success', 'Disabled MCP server'],
  ] as const)('reports the runtime receipt after a saved toggle: %j', async (sessionSync, type, message) => {
    const server = {
      name: 'echo', scope: 'project', transport: 'stdio', enabled: true,
      status: 'connected', statusLabel: 'Connected', configLocation: '/workspace/project/.mcp.json', summary: 'echo',
      canEdit: true, canRemove: true, canReconnect: true, canToggle: true,
      projectPath: '/workspace/project',
      config: { type: 'stdio', command: 'echo', args: [], env: {} },
    } as const
    const addToast = vi.fn()
    const toggleServer = vi.fn().mockResolvedValue({
      server: { ...server, enabled: false, status: 'disabled' }, sessionSync,
    })
    useUIStore.setState({ addToast })
    useMcpStore.setState({ servers: [server], toggleServer })
    await renderLoadedMcpSettings()
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(toggleServer).toHaveBeenCalledWith(server, '/workspace/project', 'session-1')
    expect(addToast).toHaveBeenCalledWith({ type, message: expect.stringContaining(message) })
    if (type === 'warning') {
      expect(addToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
    }
  })

  it('warns when enabling saved settings could not connect the server', async () => {
    const server = {
      name: 'echo', scope: 'project', transport: 'stdio', enabled: false,
      status: 'disabled', statusLabel: 'Disabled', configLocation: '/workspace/project/.mcp.json', summary: 'echo',
      canEdit: true, canRemove: true, canReconnect: true, canToggle: true,
      projectPath: '/workspace/project',
      config: { type: 'stdio', command: 'echo', args: [], env: {} },
    } as const
    const addToast = vi.fn()
    useUIStore.setState({ addToast })
    useMcpStore.setState({
      servers: [server],
      toggleServer: vi.fn().mockResolvedValue({
        server: { ...server, enabled: true, status: 'failed', statusDetail: 'Command is unavailable' },
        sessionSync: { applied: true },
      }),
    })
    await renderLoadedMcpSettings()
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(addToast).toHaveBeenCalledWith({ type: 'warning', message: 'Command is unavailable' })
  })

  it('sends toggle synchronization to the last active chat tab', async () => {
    const server = makeSharedServer('/workspace/project-b')
    const toggleServer = vi.fn().mockResolvedValue({
      server: { ...server, enabled: false },
      sessionSync: { applied: true },
    })
    const makeSession = (id: string, projectPath: string) => ({
      id,
      title: id,
      createdAt: '',
      modifiedAt: '',
      messageCount: 0,
      projectPath,
      workDir: projectPath,
      workDirExists: true,
    })
    useSessionStore.setState({
      sessions: [
        makeSession('session-a', '/workspace/project-a'),
        makeSession('session-b', '/workspace/project-b'),
      ],
      activeSessionId: 'session-a',
    })
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-a', title: 'A', type: 'session', status: 'idle' },
        { sessionId: 'session-b', title: 'B', type: 'session', status: 'idle' },
        { sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: SETTINGS_TAB_ID,
      lastSessionTabId: 'session-b',
    })
    useMcpStore.setState({ servers: [server], toggleServer })

    await renderLoadedMcpSettings()
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })

    expect(toggleServer).toHaveBeenCalledWith(
      server,
      '/workspace/project-b',
      'session-b',
    )
  })

  it('clears the selected MCP server when returning to the list', async () => {
    const selectServer = vi.fn()
    const server = {
      name: 'global-user',
      scope: 'user',
      transport: 'http',
      enabled: true,
      status: 'connected',
      statusLabel: 'Connected',
      configLocation: '/tmp/config',
      summary: 'https://example.com/mcp',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      config: { type: 'http', url: 'https://example.com/mcp', headers: {} },
    } as const

    useMcpStore.setState({
      servers: [server],
      selectServer,
    })

    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open global-user' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /back/i }))
    })

    expect(selectServer).toHaveBeenLastCalledWith(null)
  })

  it('requires an explicitly selected project before creating local MCP servers', async () => {
    const createdServer = {
      name: 'context7',
      scope: 'local',
      transport: 'stdio',
      enabled: true,
      status: 'checking' as const,
      statusLabel: 'Checking',
      configLocation: '/workspace/project/.claude.json',
      summary: 'npx @upstash/context7-mcp',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      projectPath: '/workspace/project',
      config: { type: 'stdio' as const, command: 'npx', args: ['@upstash/context7-mcp'], env: {} },
    }
    const createServer = vi.fn().mockResolvedValue(createdServer)

    useMcpStore.setState({ createServer })

    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    })

    expect(screen.getByText('Select a project...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'context7' } })
    fireEvent.change(screen.getByLabelText(/Command to launch/), { target: { value: 'npx' } })
    fireEvent.change(screen.getByPlaceholderText('chrome-devtools-mcp@latest'), {
      target: { value: '@upstash/context7-mcp' },
    })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Select a project/i }))
    })

    await act(async () => {
      fireEvent.click(await screen.findByText('org/selected-project'))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(createServer).toHaveBeenCalledWith(
      'context7',
      {
        scope: 'local',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['@upstash/context7-mcp'],
          env: {},
        },
      },
      '/workspace/selected-project',
    )
  })

  it('moves local MCP servers to the explicitly selected shared project', async () => {
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{
        projectPath: '/workspace/moved-project',
        realPath: '/workspace/moved-project',
        projectName: 'moved-project',
        repoName: 'org/moved-project',
        branch: 'main',
        isGit: true,
        modifiedAt: '2026-05-25T00:00:00.000Z',
        sessionCount: 1,
      }],
    })
    const updateServer = vi.fn().mockResolvedValue({
      name: 'shared-tools',
      scope: 'project',
      transport: 'stdio',
      enabled: true,
      status: 'checking' as const,
      statusLabel: 'Checking',
      configLocation: '/workspace/moved-project/.mcp.json',
      summary: 'npx shared-tools',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      projectPath: '/workspace/moved-project',
      config: { type: 'stdio' as const, command: 'npx', args: ['shared-tools'], env: {} },
    })
    const server = {
      name: 'shared-tools',
      scope: 'local',
      transport: 'stdio',
      enabled: true,
      status: 'connected',
      statusLabel: 'Connected',
      configLocation: '/workspace/project/.mcp.json',
      summary: 'npx shared-tools',
      canEdit: true,
      canRemove: true,
      canReconnect: true,
      canToggle: true,
      projectPath: '/workspace/project',
      config: { type: 'stdio' as const, command: 'npx', args: ['shared-tools'], env: {} },
    } as const

    useMcpStore.setState({
      servers: [server],
      updateServer,
    })

    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open shared-tools' }))
    })

    fireEvent.click(screen.getByRole('button', { name: /^Project Shared/ }))

    expect(screen.getByText('project')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTitle('/workspace/project'))
    })

    await act(async () => {
      fireEvent.click(await screen.findByText('org/moved-project'))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(updateServer).toHaveBeenCalledWith(
      server,
      {
        scope: 'project',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['shared-tools'],
          env: {},
        },
      },
      '/workspace/moved-project',
    )
  })

  it('keeps local scope single-select', async () => {
    const createServer = vi.fn()
    useMcpStore.setState({ createServer })

    await renderLoadedMcpSettings()
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'local-tools' } })
    fireEvent.change(screen.getByLabelText(/Command to launch/), { target: { value: 'npx' } })
    fireEvent.change(screen.getByPlaceholderText('chrome-devtools-mcp@latest'), {
      target: { value: 'local-tools' },
    })

    expect(screen.getByText('Select a project...')).toBeInTheDocument()
    expect(screen.queryByText('Select projects...')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Select a project/ }))
    })
    const listbox = await screen.findByRole('listbox')
    expect(listbox).not.toHaveAttribute('aria-multiselectable')

    fireEvent.click(await screen.findByRole('option', { name: /org\/selected-project/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(createServer).toHaveBeenCalledWith(
      'local-tools',
      {
        scope: 'local',
        config: { type: 'stdio', command: 'npx', args: ['local-tools'], env: {} },
      },
      '/workspace/selected-project',
    )
  })

  it('does not require a project for user scope', async () => {
    await renderLoadedMcpSettings()
    fireEvent.click(screen.getByRole('button', { name: /add server/i }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'global-tools' } })
    fireEvent.click(screen.getByRole('button', { name: /^User/ }))
    fireEvent.change(screen.getByLabelText(/Command to launch/), { target: { value: 'npx' } })
    fireEvent.change(screen.getByPlaceholderText('chrome-devtools-mcp@latest'), {
      target: { value: 'global-tools' },
    })

    expect(screen.queryByText('Select a project...')).not.toBeInTheDocument()
    expect(screen.queryByText('Select projects...')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('removes one project copy of a shared MCP server', async () => {
    const projectA = makeSharedServer('/workspace/project-a')
    const deleteServer = vi.fn().mockResolvedValue(undefined)
    useMcpStore.setState({
      servers: [projectA, makeSharedServer('/workspace/project-b')],
      deleteServer,
    })

    await renderLoadedMcpSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Show projects' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {
        name: 'Remove shared-tools from /workspace/project-a',
      }))
    })

    expect(screen.getByText(
      'Remove MCP server "shared-tools" from /workspace/project-a? This action cannot be undone.',
    )).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    })

    expect(deleteServer).toHaveBeenCalledWith(projectA, '/workspace/project-a')
  })

  it('marks config-diverged project copies and disables group edit', async () => {
    const projectA = makeSharedServer('/workspace/project-a')
    const projectB = {
      ...makeSharedServer('/workspace/project-b'),
      config: { type: 'stdio' as const, command: 'npx', args: ['other-tools'], env: {} },
    }
    useMcpStore.setState({
      servers: [projectA, projectB],
      selectServer: (server) => useMcpStore.setState({ selectedServer: server }),
    })

    await renderLoadedMcpSettings()

    expect(screen.getByText('Config mismatch')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit shared service shared-tools' }))
      .not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show projects' }))

    expect(screen.getByRole('button', {
      name: 'Edit shared-tools in /workspace/project-a',
    })).toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: 'Edit shared-tools in /workspace/project-b',
    })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {
        name: 'Edit shared-tools in /workspace/project-a',
      }))
    })

    expect(screen.queryByRole('heading', { name: 'Configure shared-tools MCP' }))
      .not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Name/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Project/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Target project')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Command to launch/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('puts the active project first and marks it in the expanded group', async () => {
    useMcpStore.setState({
      servers: [
        makeSharedServer('/workspace/other'),
        makeSharedServer('/workspace/project'),
      ],
    })

    await renderLoadedMcpSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Show projects' }))

    expect(screen.getByText('Current project')).toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: 'Edit shared-tools in /workspace/project',
    })).toBeInTheDocument()
    const paths = screen.getAllByText(/^\/workspace\//).map((element) => element.textContent)
    expect(paths[0]).toBe('/workspace/project')
  })

  it('rebinds the current project when the active session changes', async () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-a',
          title: 'Project A',
          createdAt: '',
          modifiedAt: '',
          messageCount: 0,
          projectPath: '/workspace/project-a',
          workDir: '/workspace/project-a',
          workDirExists: true,
        },
        {
          id: 'session-b',
          title: 'Project B',
          createdAt: '',
          modifiedAt: '',
          messageCount: 0,
          projectPath: '/workspace/project-b',
          workDir: '/workspace/project-b',
          workDirExists: true,
        },
      ],
      activeSessionId: 'session-a',
    })
    useMcpStore.setState({
      servers: [
        makeSharedServer('/workspace/project-a'),
        makeSharedServer('/workspace/project-b'),
      ],
    })

    await renderLoadedMcpSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Show projects' }))

    let paths = screen.getAllByText(/^\/workspace\//).map((element) => element.textContent)
    expect(paths[0]).toBe('/workspace/project-a')

    act(() => {
      useSessionStore.setState({ activeSessionId: 'session-b' })
    })

    await waitFor(() => {
      paths = screen.getAllByText(/^\/workspace\//).map((element) => element.textContent)
      expect(paths[0]).toBe('/workspace/project-b')
    })
  })

  it('prefers the last active chat tab over a stale active session', async () => {
    const makeSession = (id: string, projectPath: string) => ({
      id,
      title: id,
      createdAt: '',
      modifiedAt: '',
      messageCount: 0,
      projectPath,
      workDir: projectPath,
      workDirExists: true,
    })
    useSessionStore.setState({
      sessions: [
        makeSession('session-a', '/workspace/project-a'),
        makeSession('session-b', '/workspace/project-b'),
      ],
      activeSessionId: 'session-a',
    })
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-a', title: 'A', type: 'session', status: 'idle' },
        { sessionId: 'session-b', title: 'B', type: 'session', status: 'idle' },
        { sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: SETTINGS_TAB_ID,
      lastSessionTabId: 'session-b',
    })
    useMcpStore.setState({
      servers: [
        makeSharedServer('/workspace/project-a'),
        makeSharedServer('/workspace/project-b'),
      ],
    })

    await renderLoadedMcpSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Show projects' }))

    const paths = screen.getAllByText(/^\/workspace\//).map((element) => element.textContent)
    expect(paths[0]).toBe('/workspace/project-b')
  })

  it('keeps the expanded service group open when returning from a project edit', async () => {
    useMcpStore.setState({
      servers: [
        makeSharedServer('/workspace/project-a'),
        makeSharedServer('/workspace/project-b'),
      ],
    })

    await renderLoadedMcpSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Show projects' }))
    expect(screen.getByText('/workspace/project-a')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {
        name: 'Edit shared-tools in /workspace/project-a',
      }))
    })
    expect(screen.getByLabelText(/Command to launch/)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back to servers' }))
    })

    expect(screen.getByText('/workspace/project-a')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide projects' })).toBeInTheDocument()
  })


  it('shows reconnecting status immediately in the detail view', async () => {
    let resolveReconnect: ((value: McpReconnectResult) => void) | null = null
    const server = {
      name: 'plugin:telegram:telegram',
      scope: 'dynamic',
      transport: 'stdio',
      enabled: true,
      status: 'failed' as 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'checking',
      statusLabel: 'Unavailable',
      statusDetail: 'Timed out' as string | undefined,
      configLocation: '/tmp/config',
      summary: 'bun run start',
      canEdit: false,
      canRemove: false,
      canReconnect: true,
      canToggle: true,
      config: { type: 'stdio' as const, command: 'bun', args: ['run', 'start'], env: {} },
    }
    const reconnectServer = vi.fn().mockImplementation(() => new Promise<McpReconnectResult>((resolve) => {
      resolveReconnect = resolve
    }))

    useMcpStore.setState({
      servers: [server],
      reconnectServer,
    })

    await renderLoadedMcpSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open plugin:telegram:telegram' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reconnect/i }))
    })

    expect(screen.getAllByText('Reconnecting...').length).toBeGreaterThan(0)
    expect(reconnectServer).toHaveBeenCalledWith(server, '/workspace/project', 'session-1')

    await act(async () => {
      resolveReconnect?.({
        server: { ...server, status: 'connected', statusLabel: 'Connected', statusDetail: undefined },
        sessionSync: { applied: true },
      })
    })
  })
  it.each([
    [{ applied: true }, 'success', 'Reconnected MCP server "late-server"'],
    [{ applied: false, reason: 'failed', error: 'CLI reconnect failed' }, 'warning', 'Chat synchronization failed: CLI reconnect failed'],
    [{ applied: false, reason: 'different_project' }, 'warning', 'The current chat uses a different project'],
    [{ applied: false, reason: 'not_running' }, 'warning', 'The current chat is not running'],
    [{ applied: false, reason: 'no_session' }, 'warning', 'No chat was selected'],
    [{ applied: false, reason: 'lean_profile' }, 'warning', 'The current chat uses Lean mode'],
    [undefined, 'warning', 'The current chat update was not confirmed'],
  ] as Array<[McpSessionSync | undefined, string, string]>)('reports reconnect receipt %j without mistaking the settings probe for chat success', async (sessionSync, type, message) => {
    const addToast = vi.fn()
    useUIStore.setState({ addToast })
    const server = {
      name: 'late-server', scope: 'local', transport: 'http', enabled: true,
      status: 'connected' as const, statusLabel: 'Connected', configLocation: '/tmp/config',
      summary: 'http://127.0.0.1/mcp', canEdit: true, canRemove: true, canReconnect: true, canToggle: true,
      projectPath: '/workspace/project', config: { type: 'http' as const, url: 'http://127.0.0.1/mcp', headers: {} },
    }
    const reconnectServer = vi.fn().mockResolvedValue({ server, sessionSync })
    useMcpStore.setState({ servers: [server], reconnectServer })
    await renderLoadedMcpSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Open late-server' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /reconnect/i })) })
    expect(reconnectServer).toHaveBeenCalledWith(server, '/workspace/project', 'session-1')
    expect(addToast).toHaveBeenCalledWith({ type, message: expect.stringContaining(message) })
    expect(screen.queryByText('Reconnecting...')).not.toBeInTheDocument()
  })

})
