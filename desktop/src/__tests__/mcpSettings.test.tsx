import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { McpSettings } from '../pages/McpSettings'
import { useMcpStore } from '../stores/mcpStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'

describe('McpSettings', () => {
  beforeEach(() => {
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
      fetchServers: vi.fn(),
      createServer: vi.fn(),
      updateServer: vi.fn(),
      deleteServer: vi.fn(),
      toggleServer: vi.fn(),
      reconnectServer: vi.fn(),
      refreshServerStatus: vi.fn(),
      selectServer: vi.fn(),
    })
  })

  it('loads only global MCP servers on mount', () => {
    const fetchServers = vi.fn()
    useMcpStore.setState({ fetchServers })

    render(<McpSettings />)

    expect(fetchServers).toHaveBeenCalledWith(undefined, '/workspace/project')
  })

  it('renders the empty state and add button', () => {
    render(<McpSettings />)

    expect(screen.getByText('MCP servers')).toBeInTheDocument()
    expect(screen.getByText('No MCP servers configured yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add server/i })).toBeInTheDocument()
  })

  it('shows plugin and user MCP servers in grouped sections', () => {
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

    render(<McpSettings />)

    expect(screen.getAllByText('Plugin').length).toBeGreaterThan(0)
    expect(screen.getAllByText('User').length).toBeGreaterThan(0)
    expect(screen.getByText('plugin:telegram:telegram')).toBeInTheDocument()
    expect(screen.getByText('global-user')).toBeInTheDocument()
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

    render(<McpSettings />)

    expect(screen.getByText('Checking')).toBeInTheDocument()

    await waitFor(() => {
      expect(refreshServerStatus).toHaveBeenCalledWith(server, '/workspace/project')
    })
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

    render(<McpSettings />)

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

  it('uses the active cwd when toggling a server', async () => {
    const toggleServer = vi.fn().mockResolvedValue(undefined)
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
      toggleServer,
    })

    render(<McpSettings />)

    await act(async () => {
      fireEvent.click(screen.getByRole('switch'))
    })

    expect(toggleServer).toHaveBeenCalledWith(server, '/workspace/project')
  })

  it('shows reconnecting status immediately in the detail view', async () => {
    let resolveReconnect: ((value: typeof server) => void) | null = null
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
    const reconnectServer = vi.fn().mockImplementation(() => new Promise<typeof server>((resolve) => {
      resolveReconnect = resolve
    }))

    useMcpStore.setState({
      servers: [server],
      reconnectServer,
    })

    render(<McpSettings />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open plugin:telegram:telegram' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reconnect/i }))
    })

    expect(screen.getAllByText('Reconnecting...').length).toBeGreaterThan(0)
    expect(reconnectServer).toHaveBeenCalledWith(server, '/workspace/project')

    await act(async () => {
      resolveReconnect?.({
        ...server,
        status: 'connected',
        statusLabel: 'Connected',
        statusDetail: undefined,
      })
    })
  })
})
