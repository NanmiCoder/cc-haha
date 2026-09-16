import { describe, expect, it, vi } from 'vitest'
import { createElectronHost } from './electronHost'
import { ELECTRON_IPC_CHANNELS } from '../../../electron/ipc/channels'

const selection = {
  schemaVersion: 2 as const,
  hostRefs: [], conceptRootRefs: [], dependencyRefs: [], databaseRefs: [], redisRefs: [], credentialRefs: [], sourceTags: [],
  directHostIds: [], directConceptIds: [], directDatabaseIds: [], directRedisIds: [], includePasswords: false,
}

const ticket = {
  ticketId: '33333333-3333-4333-8333-333333333333',
  sidecarInstanceId: '44444444-4444-4444-8444-444444444444',
  expiresAt: '2026-09-13T00:02:00.000Z',
}

describe('DesktopHost M7 prepare/stage', () => {
  it('returns only the opaque ticket received from main-process IPC', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === ELECTRON_IPC_CHANNELS.mrPrepareContext) return { ok: true, data: ticket }
      throw new Error(`unexpected ${channel}`)
    })
    const host = createElectronHost({ invoke: invoke as any, subscribe: async () => () => {} })
    const input = {
      sessionId: 'legacy-session-id',
      requestId: '22222222-2222-4222-8222-222222222222',
      runtimeRevision: 7,
      content: 'hello',
      selection,
    }

    await expect(host.conversationContext.prepareSubmission(input)).resolves.toEqual({ ok: true, data: ticket })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(ELECTRON_IPC_CHANNELS.mrPrepareContext, input)
  })
})
