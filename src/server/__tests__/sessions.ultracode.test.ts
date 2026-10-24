import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { sessionService } from '../services/sessionService.js'
import { conversationService } from '../services/conversationService.js'
import { markAgentSdkSession } from '../services/officialAgentSdkRuntime.js'

let directory: string
let oldConfig: string | undefined
const id = '783f9bd3-0062-447f-b519-5616362e0ab2'
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sdk-mode-api-'))
  oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  markAgentSdkSession(directory, id)
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({ workDir: directory } as never)
})
afterEach(async () => {
  mock.restore()
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  await rm(directory, { recursive: true, force: true })
})
function request(method = 'GET', body?: unknown) {
  const url = new URL(`http://localhost/api/sessions/${id}/ultracode`)
  return handleSessionsApi(new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), url, ['api', 'sessions', id, 'ultracode'])
}

test('dormant and resumed histories read as off without starting a process or touching history', async () => {
  spyOn(conversationService, 'hasSession').mockReturnValue(false)
  const control = spyOn(conversationService, 'requestControl').mockResolvedValue({})
  const start = spyOn(conversationService, 'startSession').mockRejectedValue(new Error('should not start'))
  expect(await (await request()).json()).toMatchObject({ enabled: false, active: false, running: false })
  expect(await (await request('PUT', { enabled: false })).json()).toMatchObject({ enabled: false, running: false })
  expect(control).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})

test('mode controls only acknowledge native responses, keep session history and selected runtime untouched', async () => {
  spyOn(conversationService, 'hasSession').mockReturnValue(true)
  const control = spyOn(conversationService, 'requestControl').mockResolvedValue({ enabled: true, active: true, available: true, effort: 'low', model: 'claude-haiku-5-5' })
  const write = spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
  const result = await request('PUT', { enabled: true })
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ enabled: true, running: true, effort: 'low', model: 'claude-haiku-5-5' })
  expect(control).toHaveBeenCalledWith(id, { subtype: 'set_ultracode', enabled: true }, 10_000, expect.any(AbortSignal))
  await request()
  expect(control).toHaveBeenLastCalledWith(id, { subtype: 'get_ultracode' }, 10_000, expect.any(AbortSignal))
  expect(write).not.toHaveBeenCalled()
})

test('invalid enable bodies are rejected before startup or controls', async () => {
  spyOn(conversationService, 'hasSession').mockReturnValue(false)
  const control = spyOn(conversationService, 'requestControl').mockResolvedValue({})
  for (const body of [null, [], {}, { enabled: 'true' }, { enabled: true, model: 'claude-opus-5-5' }]) {
    expect((await request('PUT', body)).status).toBe(400)
  }
  expect(control).not.toHaveBeenCalled()
  expect((await request('DELETE')).status).toBe(405)
})

test('missing sessions and non SDK runtimes fail clearly rather than guessing mode success', async () => {
  spyOn(conversationService, 'hasSession').mockReturnValue(true)
  const control = spyOn(conversationService, 'requestControl').mockResolvedValue({})
  await rm(join(directory, 'cc-haha', 'session-runtimes', `${id}.json`))
  expect((await request()).status).toBe(400)
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue(null)
  expect((await request()).status).toBe(404)
  expect(control).not.toHaveBeenCalled()
})
