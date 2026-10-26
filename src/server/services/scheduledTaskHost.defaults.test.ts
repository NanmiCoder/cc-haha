import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from './providerService.js'
import { hahaOAuthService } from './hahaOAuthService.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import { hahaDeepSeekOAuthService } from './hahaDeepSeekOAuthService.js'
import { sessionService } from './sessionService.js'
import { emitSessionTurnEvent } from './sessionTurnEvents.js'
import { executeScheduledSessionTask } from './scheduledTaskHost.js'
import * as handler from '../ws/handler.js'
import type { ScheduledSessionTaskInput } from './scheduledTaskExecution.js'
import type { SavedProvider } from '../types/provider.js'

let directory: string
const provider = (id: string): SavedProvider => ({
  id, name: id, presetId: 'custom', apiFormat: 'anthropic', apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:1',
  models: { main: 'fixture-model', opus: 'fixture-model', sonnet: 'fixture-model', haiku: 'fixture-model' },
})
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scheduled-default-provider-'))
  spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live provider access is forbidden'))
  spyOn(ProviderService.prototype, 'listProviders').mockResolvedValue({ providers: [provider('active'), provider('other')], activeId: 'active', providerOrder: [] })
  spyOn(ProviderService.prototype, 'getOfficialProviderModels').mockResolvedValue({ main: 'official-fixture', opus: 'official-fixture', sonnet: 'official-fixture', haiku: 'official-fixture' })
  for (const service of [hahaOAuthService, hahaOpenAIOAuthService, hahaGrokOAuthService, hahaDeepSeekOAuthService]) spyOn(service, 'loadTokens').mockResolvedValue(null)
  spyOn(sessionService, 'createSession').mockResolvedValue({ sessionId: 'created', workDir: directory } as any)
  spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
  spyOn(handler, 'getSessionTurnState').mockReturnValue('idle')
  spyOn(handler, 'submitScheduledTaskTurn').mockImplementation(async () => {
    emitSessionTurnEvent({ type: 'output', sessionId: 'created', message: { type: 'system', subtype: 'session_message_receipt', message_id: 'occurrence', status: 'consumed' } })
    emitSessionTurnEvent({ type: 'output', sessionId: 'created', message: { type: 'result', is_error: false, result: 'Finished' } })
    return { status: 'queued' }
  })
})
afterEach(async () => {
  mock.restore()
  await rm(directory, { recursive: true, force: true })
})
function input(): ScheduledSessionTaskInput {
  return {
    task: { id: 'task', name: 'Default provider', prompt: 'Reply with Ready', cron: '* * * * *', createdAt: 1, execution: { kind: 'new-session' }, folderPath: directory, permissionMode: 'default' },
    runId: 'run', occurrenceId: 'occurrence', scheduledFor: '2026-10-26T00:00:00Z', signal: new AbortController().signal, canSend: async () => true,
  }
}
const endpoint = { serverHost: '127.0.0.1', serverPort: 1 }

// Use the actual model catalog and resolver: mocking resolveSessionRuntime hid
// the original null/default fallback in the task-page creation path.
test.each([false, true])('task-page omitted runtime uses the active provider (official account present: %s)', async officialAvailable => {
  if (officialAvailable) spyOn(hahaOAuthService, 'loadTokens').mockResolvedValue({ accessToken: 'fixture-token' } as any)
  expect(await executeScheduledSessionTask(input(), endpoint)).toMatchObject({ status: 'completed' })
  expect(sessionService.appendSessionMetadata).toHaveBeenCalledWith('created', expect.objectContaining({ runtimeProviderId: 'active', runtimeModelId: 'fixture-model' }))
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

test.each([null, 'other'])('an explicitly selected provider %s overrides the global default', async selected => {
  spyOn(hahaOAuthService, 'loadTokens').mockResolvedValue({ accessToken: 'fixture-token' } as any)
  const request = input()
  request.task.providerId = selected
  expect(await executeScheduledSessionTask(request, endpoint)).toMatchObject({ status: 'completed' })
  expect(sessionService.appendSessionMetadata).toHaveBeenCalledWith('created', expect.objectContaining({ runtimeProviderId: selected, runtimeModelId: selected === null ? 'official-fixture' : 'fixture-model' }))
})

test('a model without a provider resolves within the active provider, even if another has the same model', async () => {
  const request = input()
  request.task.model = 'fixture-model'
  expect(await executeScheduledSessionTask(request, endpoint)).toMatchObject({ status: 'completed' })
  expect(sessionService.appendSessionMetadata).toHaveBeenCalledWith('created', expect.objectContaining({ runtimeProviderId: 'active', runtimeModelId: 'fixture-model' }))
})

test('an unavailable explicit provider fails without silently switching to the active provider', async () => {
  const request = input()
  request.task.providerId = 'deleted-provider'
  expect(await executeScheduledSessionTask(request, endpoint)).toMatchObject({ status: 'failed', error: expect.stringContaining('unavailable') })
  expect(sessionService.createSession).not.toHaveBeenCalled()
})
