import { afterEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.hoisted(() => vi.fn())
const apiPostMock = vi.hoisted(() => vi.fn())
const apiPutMock = vi.hoisted(() => vi.fn())
const apiDeleteMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    put: apiPutMock,
    delete: apiDeleteMock,
  },
}))

import { agentsApi, type AgentMutationInput } from './agents'

const input: AgentMutationInput = {
  scope: 'project',
  cwd: '/workspace/project one',
  name: 'code_reviewer',
  description: 'Review code',
  systemPrompt: 'Review carefully.',
  model: null,
  effort: null,
  tools: null,
  color: null,
}

describe('agentsApi', () => {
  it('fetches the read-only provider catalog for the selected built-in and workspace', () => {
    agentsApi.providerModels('Explore', '/workspace/project one')
    expect(apiGetMock).toHaveBeenCalledWith('/api/agents/Explore/provider-models?cwd=%2Fworkspace%2Fproject%20one')
    agentsApi.providerModels('general-purpose')
    expect(apiGetMock).toHaveBeenCalledWith('/api/agents/general-purpose/provider-models')
  })

  it('preserves an explicit provider reset on the wire', () => {
    agentsApi.setOverride('Explore', { providerId: null })
    expect(apiPutMock).toHaveBeenCalledWith('/api/agents/Explore/override', { providerId: null })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('passes the create payload through unchanged', () => {
    agentsApi.create(input)

    expect(apiPostMock).toHaveBeenCalledWith('/api/agents', input)
  })

  it('preserves an exact nested file target when updating', () => {
    const updateInput = { ...input, target: 'nested/custom-agent-file.md' }
    agentsApi.update('reviewer/name?', updateInput)

    expect(apiPutMock).toHaveBeenCalledWith('/api/agents/reviewer%2Fname%3F', updateInput)
  })

  it('URL-encodes delete path, cwd, and exact nested file target', () => {
    agentsApi.delete(
      'reviewer/name?',
      'project',
      '/workspace/project one',
      'nested/custom agent file.md',
    )

    expect(apiDeleteMock).toHaveBeenCalledWith(
      '/api/agents/reviewer%2Fname%3F?scope=project&cwd=%2Fworkspace%2Fproject+one&target=nested%2Fcustom+agent+file.md',
    )
  })

  it('omits an empty cwd from list and delete requests', () => {
    agentsApi.list()
    agentsApi.delete('reviewer', 'user')

    expect(apiGetMock).toHaveBeenCalledWith('/api/agents')
    expect(apiDeleteMock).toHaveBeenCalledWith('/api/agents/reviewer?scope=user')
  })

  it('sends an override to the sub-resource, keeping explicit nulls', () => {
    // `null` is the wire form of "clear this field"; dropping it would silently
    // turn a reset into a no-op.
    agentsApi.setOverride('Explore', { cwd: '/workspace/one', model: null, effort: 'low' })

    expect(apiPutMock).toHaveBeenCalledWith('/api/agents/Explore/override', {
      cwd: '/workspace/one',
      model: null,
      effort: 'low',
    })
  })

  it('URL-encodes the override clear path and cwd', () => {
    agentsApi.clearOverride('reviewer/name?', '/workspace/project one')

    expect(apiDeleteMock).toHaveBeenCalledWith(
      '/api/agents/reviewer%2Fname%3F/override?cwd=%2Fworkspace%2Fproject+one',
    )
  })

  it('omits an empty cwd from an override clear', () => {
    agentsApi.clearOverride('Explore')

    expect(apiDeleteMock).toHaveBeenCalledWith('/api/agents/Explore/override')
  })

  it('reloads the exact active session with the control timeout', () => {
    agentsApi.reload('session/one?')

    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/agents/reload?sessionId=session%2Fone%3F',
      undefined,
      { timeout: 120_000 },
    )
  })
})
