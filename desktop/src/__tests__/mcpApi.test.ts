import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpApi } from '../api/mcp'

const fetchMock = vi.fn()

afterEach(() => vi.unstubAllGlobals())

describe('MCP toggle transport receipt', () => {
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
})
