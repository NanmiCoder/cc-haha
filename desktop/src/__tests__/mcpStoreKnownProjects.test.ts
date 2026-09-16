import { beforeEach, describe, expect, it, vi } from 'vitest'

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
      list: vi.fn(),
      update: vi.fn(),
      toggle: vi.fn(),
      reconnect: vi.fn(),
      status: vi.fn(),
    },
  }
})

import { mcpApi } from '../api/mcp'
import { sessionsApi } from '../api/sessions'
import { useMcpStore } from '../stores/mcpStore'
import type { McpServerRecord } from '../types/mcp'

const record = (
  name: string,
  scope: McpServerRecord['scope'],
  overrides: Partial<McpServerRecord> = {},
): McpServerRecord => ({
  name,
  scope,
  transport: 'stdio',
  enabled: true,
  status: 'checking',
  statusLabel: 'Checking',
  configLocation: '',
  summary: 'echo hi',
  canEdit: true,
  canRemove: true,
  canReconnect: true,
  canToggle: true,
  config: { type: 'stdio', command: 'echo', args: ['hi'], env: {} },
  ...overrides,
})

describe('fetchServersForKnownProjects', () => {
  beforeEach(() => {
    useMcpStore.setState({ servers: [], selectedServer: null, isLoading: false, error: null })
    vi.mocked(sessionsApi.getRecentProjects).mockReset()
    vi.mocked(mcpApi.projectPaths).mockReset()
    vi.mocked(mcpApi.list).mockReset()
    vi.mocked(mcpApi.update).mockReset()
    vi.mocked(mcpApi.toggle).mockReset()
    vi.mocked(mcpApi.reconnect).mockReset()
    vi.mocked(mcpApi.status).mockReset()
  })

  it('queries the union of current cwd, recent projects, and configured MCP paths', async () => {
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{ realPath: '/proj/recent' }],
    } as Awaited<ReturnType<typeof sessionsApi.getRecentProjects>>)
    vi.mocked(mcpApi.projectPaths).mockResolvedValue({ projectPaths: ['/proj/with-mcp'] })
    vi.mocked(mcpApi.list).mockImplementation(async (cwd?: string) => ({
      servers: cwd === '/proj/with-mcp' ? [record('shared-tools', 'project')] : [],
    }))

    await useMcpStore.getState().fetchServersForKnownProjects('/proj/current')

    const queried = vi.mocked(mcpApi.list).mock.calls.map(([cwd]) => cwd)
    expect(queried).toEqual(['/proj/current', '/proj/recent', '/proj/with-mcp'])
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(['shared-tools'])
  })

  it('does not collapse the list to a single-project view when discovery sources fail (GH #1126)', async () => {
    // Both discovery calls fail — the refresh must still include the current
    // cwd rather than silently fetching nothing.
    vi.mocked(sessionsApi.getRecentProjects).mockRejectedValue(new Error('boom'))
    vi.mocked(mcpApi.projectPaths).mockRejectedValue(new Error('boom'))
    vi.mocked(mcpApi.list).mockResolvedValue({ servers: [record('only-local', 'local')] })

    await useMcpStore.getState().fetchServersForKnownProjects('/proj/current')

    expect(vi.mocked(mcpApi.list).mock.calls.map(([cwd]) => cwd)).toEqual(['/proj/current'])
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(['only-local'])
  })

  it('collapses Windows slash variants to one active project server (GH #1165)', async () => {
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{ realPath: 'C:\\UE\\StrangeAutumn' }],
    } as Awaited<ReturnType<typeof sessionsApi.getRecentProjects>>)
    vi.mocked(mcpApi.projectPaths).mockResolvedValue({
      projectPaths: ['C:/UE/StrangeAutumn'],
    })
    vi.mocked(mcpApi.list).mockResolvedValue({
      servers: [record('StrangeAutumn', 'project', {
        projectPath: 'C:/UE/StrangeAutumn',
      })],
    })

    await useMcpStore.getState().fetchServersForKnownProjects('C:\\UE\\StrangeAutumn')

    expect(vi.mocked(mcpApi.list).mock.calls.map(([cwd]) => cwd)).toEqual([
      'C:\\UE\\StrangeAutumn',
    ])
    expect(useMcpStore.getState().servers).toEqual([
      expect.objectContaining({
        name: 'StrangeAutumn',
        projectPath: 'C:/UE/StrangeAutumn',
        activeInCurrentContext: true,
      }),
    ])
  })

  it('keeps one row and one toggle state across refresh for Windows path variants', async () => {
    let enabled = true
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{ realPath: 'C:\\UE\\StrangeAutumn' }],
    } as Awaited<ReturnType<typeof sessionsApi.getRecentProjects>>)
    vi.mocked(mcpApi.projectPaths).mockResolvedValue({
      projectPaths: ['C:/UE/StrangeAutumn'],
    })
    vi.mocked(mcpApi.list).mockImplementation(async () => ({
      servers: [record('StrangeAutumn', 'project', {
        enabled,
        status: enabled ? 'connected' : 'disabled',
        projectPath: 'C:/UE/StrangeAutumn',
      })],
    }))
    vi.mocked(mcpApi.toggle).mockImplementation(async () => {
      enabled = !enabled
      return {
        server: record('StrangeAutumn', 'project', {
          enabled,
          status: enabled ? 'connected' : 'disabled',
          projectPath: 'C:/UE/StrangeAutumn',
        }),
      }
    })

    const store = useMcpStore.getState()
    await store.fetchServersForKnownProjects('C:\\UE\\StrangeAutumn')
    const server = useMcpStore.getState().servers[0]!
    const toggled = await useMcpStore.getState().toggleServer(server, server.projectPath)

    expect(toggled.server.activeInCurrentContext).toBe(true)
    expect(useMcpStore.getState().servers).toHaveLength(1)
    expect(useMcpStore.getState().servers[0]).toMatchObject({
      enabled: false,
      activeInCurrentContext: true,
    })

    await useMcpStore.getState().fetchServersForKnownProjects('C:\\UE\\StrangeAutumn')
    expect(useMcpStore.getState().servers).toHaveLength(1)
    expect(useMcpStore.getState().servers[0]?.enabled).toBe(false)
  })

  it('preserves the saved state and failed runtime receipt after toggling', async () => {
    const server = record('echo', 'project', { projectPath: '/tmp/qa-005-project' })
    const disabled = { ...server, enabled: false, status: 'disabled' as const }
    const sessionSync = { applied: false, reason: 'failed' as const, error: 'Control timeout' }
    vi.mocked(mcpApi.toggle).mockResolvedValue({ server: disabled, sessionSync })
    useMcpStore.setState({ servers: [server], selectedServer: server })

    const result = await useMcpStore.getState().toggleServer(server, server.projectPath, 'session-1')

    expect(result).toEqual({ server: disabled, sessionSync })
    expect(useMcpStore.getState().servers).toEqual([disabled])
    expect(useMcpStore.getState().selectedServer).toEqual(disabled)
    expect(mcpApi.toggle).toHaveBeenCalledWith('echo', server.projectPath, 'session-1')
  })

  it('does not let an older connection check overwrite a completed disable', async () => {
    const server = record('echo', 'project', { projectPath: '/tmp/qa-005-project' })
    let finishCheck!: (response: { server: McpServerRecord }) => void
    vi.mocked(mcpApi.status).mockReturnValue(new Promise((resolve) => { finishCheck = resolve }))
    const disabled = { ...server, enabled: false, status: 'disabled' as const }
    vi.mocked(mcpApi.toggle).mockResolvedValue({ server: disabled, sessionSync: { applied: true } })
    useMcpStore.setState({ servers: [server], selectedServer: server })

    const checking = useMcpStore.getState().refreshServerStatus(server, server.projectPath)
    await useMcpStore.getState().toggleServer(server, server.projectPath, 'session-1')
    finishCheck({ server: { ...server, status: 'connected' } })

    expect(await checking).toMatchObject({ enabled: false, status: 'disabled' })
    expect(useMcpStore.getState().servers).toEqual([disabled])
    expect(useMcpStore.getState().selectedServer).toEqual(disabled)
  })

  it('keeps an inherited project server active when a later context finds the same declaration', async () => {
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{ realPath: '/repo/root/packages/desktop' }],
    } as Awaited<ReturnType<typeof sessionsApi.getRecentProjects>>)
    vi.mocked(mcpApi.projectPaths).mockResolvedValue({ projectPaths: [] })
    vi.mocked(mcpApi.list).mockResolvedValue({
      servers: [record('shared-tools', 'project', {
        projectPath: '/repo/root',
      })],
    })

    await useMcpStore.getState().fetchServersForKnownProjects('/repo/root')

    expect(vi.mocked(mcpApi.list).mock.calls.map(([cwd]) => cwd)).toEqual([
      '/repo/root',
      '/repo/root/packages/desktop',
    ])
    expect(useMcpStore.getState().servers).toEqual([
      expect.objectContaining({
        name: 'shared-tools',
        projectPath: '/repo/root',
        activeInCurrentContext: true,
      }),
    ])
  })

  it('preserves an inactive project marker through edit, reconnect, and status responses', async () => {
    const inactive = record('maya', 'project', {
      projectPath: '/workspace/maya',
      activeInCurrentContext: false,
    })
    const response = {
      server: record('maya', 'project', {
        projectPath: '/workspace/maya',
      }),
    }
    vi.mocked(mcpApi.update).mockResolvedValue(response)
    vi.mocked(mcpApi.reconnect).mockResolvedValue(response)
    vi.mocked(mcpApi.status).mockResolvedValue(response)
    useMcpStore.setState({ servers: [inactive], selectedServer: inactive })

    const updated = await useMcpStore.getState().updateServer(inactive, {
      scope: 'project',
      config: inactive.config,
    }, inactive.projectPath)
    const reconnected = await useMcpStore.getState().reconnectServer(updated, inactive.projectPath)
    const refreshed = await useMcpStore.getState().refreshServerStatus(reconnected, inactive.projectPath)

    expect(updated.activeInCurrentContext).toBe(false)
    expect(reconnected.activeInCurrentContext).toBe(false)
    expect(refreshed.activeInCurrentContext).toBe(false)
    expect(useMcpStore.getState().selectedServer?.activeInCurrentContext).toBe(false)
  })
})
