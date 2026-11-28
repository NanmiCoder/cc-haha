import { afterEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({
  api: {
    get: apiGetMock,
  },
}))

import { isAgentIdRef, subagentsApi } from './subagents'

describe('subagentsApi', () => {
  afterEach(() => {
    apiGetMock.mockReset()
  })

  it('URL-encodes session and tool ids when fetching a run', () => {
    apiGetMock.mockResolvedValue({ ok: true })

    subagentsApi.getRunByTool('session/one two?x=1', 'tool/alpha beta?y=2')

    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/sessions/session%2Fone%20two%3Fx%3D1/subagents/by-tool/tool%2Falpha%20beta%3Fy%3D2',
    )
  })

  it('includes the live task id when fetching a running SubAgent', () => {
    apiGetMock.mockResolvedValue({ ok: true })

    subagentsApi.getRunByTool('session-1', 'tool-1', 'agent-one_2')

    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/sessions/session-1/subagents/by-tool/tool-1?taskId=agent-one_2',
    )
  })

  it('does not mistake a nested canonical tool ref for a workflow agent id', () => {
    expect(isAgentIdRef('agent:wf')).toBe(true)
    expect(isAgentIdRef('agent:')).toBe(false)
    expect(isAgentIdRef('agent:wf/wf/B')).toBe(false)
    expect(isAgentIdRef('tool-1')).toBe(false)
  })

  it('forwards request options such as AbortSignal to api.get', () => {
    apiGetMock.mockResolvedValue({ ok: true })
    const controller = new AbortController()

    subagentsApi.getRunByTool('session-1', 'tool-1', undefined, { signal: controller.signal })
    subagentsApi.getRunByAgent('session-1', 'agent-1', { signal: controller.signal })

    expect(apiGetMock).toHaveBeenNthCalledWith(
      1,
      '/api/sessions/session-1/subagents/by-tool/tool-1',
      { signal: controller.signal },
    )
    expect(apiGetMock).toHaveBeenNthCalledWith(
      2,
      '/api/sessions/session-1/subagents/by-agent/agent-1',
      { signal: controller.signal },
    )
  })
})
