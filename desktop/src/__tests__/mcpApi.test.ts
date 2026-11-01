import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpApi } from '../api/mcp'

const fetchMock = vi.fn()

afterEach(() => vi.unstubAllGlobals())

describe('MCP toggle transport receipt', () => {
  it('reads exact sharing targets and preserves per-project save results', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ projects: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await mcpApi.projectSharing('shared-tools', ['C:\\work\\a', '/tmp/project b'], '/tmp/source', ['original-hash', 'saved-hash'])
    const url = new URL(fetchMock.mock.lastCall![0])
    expect(url.pathname).toBe('/api/mcp/shared-tools/projects')
    expect(url.searchParams.getAll('projectPath')).toEqual(['C:\\work\\a', '/tmp/project b'])
    expect(url.searchParams.get('sourceCwd')).toBe('/tmp/source')
    expect(url.searchParams.getAll('configHash')).toEqual(['original-hash', 'saved-hash'])
    const result = { results: [{ projectPath: '/tmp/a', selected: true, success: false, error: 'Target changed' }] }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }))
    const payload = { config: { type: 'stdio', command: 'echo', args: [], env: {} }, targets: [
      { projectPath: '/tmp/a', selected: true, expectedRevision: 'old-revision' },
    ], sourceCwd: '/tmp/source', sourceConfig: { type: 'stdio', command: 'echo', futureField: { keep: true } } }
    expect(await mcpApi.saveProjectSharing('shared-tools', payload)).toEqual(result)
    expect(fetchMock.mock.lastCall![1].method).toBe('PUT')
    expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toEqual(payload)
  })
  it('sends the selected project/session and preserves a failed runtime receipt', async () => {
    const response = {
      server: { name: 'project/echo', enabled: false, status: 'disabled' },
      sessionSync: { applied: false, reason: 'failed', error: 'control timed out' },
    }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await mcpApi.toggle('project/echo', '/tmp/qa005-project', 'chat-1')).toEqual(response)
    const [url, options] = fetchMock.mock.lastCall!
    expect(url).toContain('/api/mcp/project%2Fecho/toggle')
    expect(JSON.parse(options.body)).toEqual({ cwd: '/tmp/qa005-project', sessionId: 'chat-1' })
  })

  it('keeps no-session acknowledgement distinct from an applied control', async () => {
    const response = {
      server: { name: 'echo', enabled: true, status: 'connected' },
      sessionSync: { applied: false, reason: 'no_session' },
    }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await mcpApi.toggle('echo')).toEqual(response)
    expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toEqual({})
  })
  it('sends reconnect to the selected session and preserves a failed CLI receipt', async () => {
    const response = {
      server: { name: 'late/server', enabled: true, status: 'connected' },
      sessionSync: { applied: false, reason: 'failed', error: 'CLI reconnect failed' },
    }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await mcpApi.reconnect('late/server', '/tmp/project', 'chat-1')).toEqual(response)
    const [url, options] = fetchMock.mock.lastCall!
    expect(url).toContain('/api/mcp/late%2Fserver/reconnect')
    expect(JSON.parse(options.body)).toEqual({ cwd: '/tmp/project', sessionId: 'chat-1' })
  })

})
