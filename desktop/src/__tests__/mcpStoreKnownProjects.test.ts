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
      toggle: vi.fn(),
    },
  }
})

import { mcpApi } from '../api/mcp'
import { sessionsApi } from '../api/sessions'
import { useMcpStore } from '../stores/mcpStore'
import type { McpServerRecord } from '../types/mcp'

const record = (name: string, scope: McpServerRecord['scope']): McpServerRecord => ({
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
})

describe('fetchServersForKnownProjects', () => {
  beforeEach(() => {
    useMcpStore.setState({ servers: [], selectedServer: null, isLoading: false, error: null })
    vi.mocked(sessionsApi.getRecentProjects).mockReset()
    vi.mocked(mcpApi.projectPaths).mockReset()
    vi.mocked(mcpApi.list).mockReset()
    vi.mocked(mcpApi.toggle).mockReset()
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

  it('deduplicates Windows separator variants while preserving the first path', async () => {
    const sessionPath = 'C:\\UE\\StrangeAutumn'
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({
      projects: [{ realPath: sessionPath }],
    } as Awaited<ReturnType<typeof sessionsApi.getRecentProjects>>)
    vi.mocked(mcpApi.projectPaths).mockResolvedValue({
      projectPaths: ['C:/UE/StrangeAutumn'],
    })
    vi.mocked(mcpApi.list).mockResolvedValue({
      servers: [record('shared-tools', 'project')],
    })

    await useMcpStore.getState().fetchServersForKnownProjects(sessionPath)

    expect(vi.mocked(mcpApi.list).mock.calls.map(([cwd]) => cwd)).toEqual([sessionPath])
    expect(useMcpStore.getState().servers).toEqual([
      expect.objectContaining({
        name: 'shared-tools',
        projectPath: sessionPath,
      }),
    ])
  })

  it('replaces a server when an action uses the other Windows separator style', async () => {
    const existing = {
      ...record('shared-tools', 'project'),
      projectPath: 'C:\\UE\\StrangeAutumn',
    }
    const equivalent = {
      ...existing,
      projectPath: 'C:/UE/StrangeAutumn',
    }
    useMcpStore.setState({ servers: [existing], selectedServer: existing })
    vi.mocked(mcpApi.toggle).mockResolvedValue({
      server: { ...record('shared-tools', 'project'), enabled: false },
    })

    await useMcpStore.getState().toggleServer(equivalent, equivalent.projectPath)

    expect(useMcpStore.getState().servers).toEqual([
      expect.objectContaining({
        name: 'shared-tools',
        enabled: false,
        projectPath: equivalent.projectPath,
      }),
    ])
    expect(useMcpStore.getState().selectedServer).toEqual(
      expect.objectContaining({
        enabled: false,
        projectPath: equivalent.projectPath,
      }),
    )
  })

  it('keeps same-named servers from different projects separate', async () => {
    vi.mocked(mcpApi.list).mockResolvedValue({
      servers: [record('shared-tools', 'project')],
    })

    await useMcpStore.getState().fetchServers(['C:/project-a', 'C:/project-b'])

    expect(useMcpStore.getState().servers.map((server) => server.projectPath)).toEqual([
      'C:/project-a',
      'C:/project-b',
    ])
  })

  it('does not treat a backslash in a POSIX filename as a path separator', async () => {
    const projectPaths = ['/tmp/project\\name', '/tmp/project/name']
    vi.mocked(mcpApi.list).mockResolvedValue({
      servers: [record('shared-tools', 'project')],
    })

    await useMcpStore.getState().fetchServers(projectPaths)

    expect(vi.mocked(mcpApi.list).mock.calls.map(([cwd]) => cwd)).toEqual(projectPaths)
    expect(useMcpStore.getState().servers.map((server) => server.projectPath)).toEqual(projectPaths)
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
})
