import { afterEach, beforeEach, expect, spyOn, test, mock } from 'bun:test'
import { applyCollaborationRuntime, stopCollaborationRuntime, __resetWebSocketHandlerStateForTests, __markActiveTurnForTests, getSessionTurnState } from '../ws/handler.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import * as catalog from '../services/sessionModelCatalog.js'

beforeEach(() => {
  __resetWebSocketHandlerStateForTests()
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  spyOn(conversationService, 'hasSession').mockReturnValue(false)
  spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/disposable-fixture')
  spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
  spyOn(conversationService, 'stopSessionAndWait').mockResolvedValue(undefined)
  spyOn(catalog, 'validateSessionRuntime').mockImplementation(async selection => selection)
  spyOn(catalog, 'resolveSessionRuntime').mockImplementation(async (input, parent) => input.runtime ?? parent)
})
afterEach(() => { __resetWebSocketHandlerStateForTests(); mock.restore() })

test('idle runtime applies a complete provider/model after stopping the old process, without starting a CLI', async () => {
  const start = spyOn(conversationService, 'startSession')
  await applyCollaborationRuntime('worker', { providerId: 'second', modelId: 'shared-model', effortLevel: 'high' })
  expect(conversationService.stopSessionAndWait).toHaveBeenCalledWith('worker', undefined, { keepTeamWorkers: true, requireExit: true })
  expect(sessionService.appendSessionMetadata).toHaveBeenCalledWith('worker', expect.objectContaining({ runtimeProviderId: 'second', runtimeModelId: 'shared-model', effortLevel: 'high' }))
  expect(start).not.toHaveBeenCalled()
})

test('active sessions reject model changes before validation or process mutation', async () => {
  __markActiveTurnForTests('busy')
  await expect(applyCollaborationRuntime('busy', { providerId: 'second', modelId: 'shared-model' })).rejects.toThrow('Wait for')
  expect(catalog.validateSessionRuntime).not.toHaveBeenCalled()
  expect(conversationService.stopSessionAndWait).not.toHaveBeenCalled()
  expect(sessionService.appendSessionMetadata).not.toHaveBeenCalled()
})

test('invalid or deleted provider cannot mutate the worker or silently fall back', async () => {
  spyOn(catalog, 'validateSessionRuntime').mockRejectedValue(new Error('provider unavailable'))
  await expect(applyCollaborationRuntime('worker', { providerId: 'deleted', modelId: 'shared-model' })).rejects.toThrow('unavailable')
  expect(conversationService.stopSessionAndWait).not.toHaveBeenCalled()
  expect(sessionService.appendSessionMetadata).not.toHaveBeenCalled()
})

test('Stop remains pending until the underlying process shutdown completes', async () => {
  let complete!: () => void
  spyOn(conversationService, 'stopSessionAndWait').mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  __markActiveTurnForTests('worker')
  let finished = false
  const stopped = stopCollaborationRuntime('worker').then(() => { finished = true })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(finished).toBe(false)
  complete()
  await stopped
  expect(finished).toBe(true)
  expect(getSessionTurnState('worker')).toBe('idle')
})

test('a failed process shutdown does not acknowledge or persist a model switch', async () => {
  spyOn(conversationService, 'stopSessionAndWait').mockRejectedValue(new Error('shutdown failed'))
  await expect(applyCollaborationRuntime('worker', { providerId: 'second', modelId: 'shared-model' })).rejects.toThrow('shutdown failed')
  expect(sessionService.appendSessionMetadata).not.toHaveBeenCalled()
})

test('reading a live selection uses the process snapshot, not a pending or global selection', async () => {
  const { getCollaborationRuntime } = await import('../ws/handler.js')
  const live = { providerId: 'actual', modelId: 'actual-model', effortLevel: 'high' }
  spyOn(conversationService, 'getSessionRuntimeSelection').mockReturnValue(live)
  const metadata = spyOn(sessionService, 'getSessionLaunchInfo')
  expect(await getCollaborationRuntime('worker')).toEqual(live)
  expect(metadata).not.toHaveBeenCalled()
})

test('an applied complete runtime without effort clears old effort when restored', async () => {
  const { resolveSessionEffortLevel } = await import('../services/localIndex/transcriptReducer.js')
  await applyCollaborationRuntime('worker', { providerId: 'second', modelId: 'small' })
  const metadata = (sessionService.appendSessionMetadata as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as Record<string, unknown>
  expect(resolveSessionEffortLevel(metadata, 'high')).toBeUndefined()
})

test('a provider deleted after the collaboration read fails at the launch boundary without fallback', async () => {
  const { getCollaborationRuntime, getRuntimeSettings } = await import('../ws/handler.js')
  spyOn(conversationService, 'getSessionRuntimeSelection').mockReturnValue({ providerId: 'first', modelId: 'shared-model' })
  await getCollaborationRuntime('worker')
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({ runtimeProviderId: 'first', runtimeModelId: 'shared-model' } as never)
  spyOn(catalog, 'resolveSessionRuntime').mockRejectedValue(new Error('provider was deleted'))
  await expect(getRuntimeSettings('worker')).rejects.toThrow('provider was deleted')
})
