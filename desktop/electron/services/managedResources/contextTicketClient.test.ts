import { describe, expect, it, vi } from 'vitest'
import { createContextTicketClient } from './contextTicketClient.js'
import type { ManagedContextStageRequest } from '../../../src/features/managed-resources/api/hostManagementApi.js'

const request: ManagedContextStageRequest = {
  schemaVersion: 1,
  sessionId: 'legacy-session-id',
  requestId: '22222222-2222-4222-8222-222222222222',
  runtimeRevision: 1,
  contentBinding: 'a'.repeat(64),
  contextBinding: 'b'.repeat(64),
  publicManifest: {
    schemaVersion: 2,
    requestId: '22222222-2222-4222-8222-222222222222',
    selection: {
      schemaVersion: 2,
      hostRefs: [], conceptRootRefs: [], dependencyRefs: [], databaseRefs: [], redisRefs: [], credentialRefs: [], sourceTags: [],
      directHostIds: [], directConceptIds: [], directDatabaseIds: [], directRedisIds: [], includePasswords: false,
    },
    hosts: [], concepts: [], databases: [], redisConnections: [],
    resolvedAt: '2026-09-13T00:00:00.000Z',
    containsSecrets: false,
    secretFieldCount: 0,
    estimatedTokens: 0,
  },
  modelContext: '{"safe":true}',
}

describe('M7 main-process context ticket client', () => {
  it('stages only to the injected loopback server with the local bearer', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:4666/api/context-tickets')
      expect(init?.redirect).toBe('error')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer local-token' })
      expect(JSON.parse(String(init?.body))).toEqual(request)
      return Response.json({
        ticketId: 'ticket-1',
        sidecarInstanceId: 'sidecar-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        publicManifest: request.publicManifest,
      }, { status: 201 })
    })
    const client = createContextTicketClient({
      getServerUrl: async () => 'http://127.0.0.1:4666/',
      getLocalAccessToken: () => 'local-token',
      fetchImpl: fetchImpl as typeof fetch,
    })
    await expect(client.stage(request)).resolves.toEqual({
      ok: true,
      data: { ticketId: 'ticket-1', sidecarInstanceId: 'sidecar-1', expiresAt: '2099-01-01T00:00:00.000Z' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fails closed before fetch for a non-loopback server URL', async () => {
    const fetchImpl = vi.fn()
    const client = createContextTicketClient({
      getServerUrl: async () => 'https://example.invalid',
      getLocalAccessToken: () => 'local-token',
      fetchImpl: fetchImpl as typeof fetch,
    })
    const result = await client.stage(request)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CONTEXT_STAGE_UNAVAILABLE')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed before fetch when the local bearer is unavailable', async () => {
    const fetchImpl = vi.fn()
    const client = createContextTicketClient({
      getServerUrl: async () => 'http://127.0.0.1:4666',
      getLocalAccessToken: () => null,
      fetchImpl: fetchImpl as typeof fetch,
    })
    const result = await client.stage(request)
    expect(result.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
