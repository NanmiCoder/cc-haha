import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSessionCollaborationApi } from '../api/sessionCollaboration.js'
import type { SessionCollaborationService } from './sessionCollaborationService.js'
import { authenticateCollaborationCaller, collaborationToolAction } from '../sessionCollaborationAuth.js'
import { conversationService } from './conversationService.js'
import { markAgentSdkSession } from './officialAgentSdkRuntime.js'
import { ProviderService } from './providerService.js'
import { sessionService } from './sessionService.js'
import { teamService } from './teamService.js'

let directory: string
let caller: string
let previousHome: string | undefined
let previousConfig: string | undefined
beforeEach(async () => {
  previousHome = process.env.HOME
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  directory = await mkdtemp(join(tmpdir(), 'sdk-host-actions-'))
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = directory
  caller = crypto.randomUUID()
  markAgentSdkSession(directory, caller)
  spyOn(conversationService, 'isTeamWorkerSession').mockReturnValue(false)
  spyOn(conversationService, 'getSessionRuntimeSelection').mockReturnValue({ providerId: 'current-provider', modelId: 'claude-haiku-5-5' })
  spyOn(conversationService, 'getSessionWorkDir').mockReturnValue(join(directory, 'current-project'))
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
    filePath: '', projectDir: '', workDir: join(directory, 'old-project'), transcriptMessageCount: 1,
    customTitle: null, runtimeProviderId: 'old-provider', runtimeModelId: 'old-model',
  })
  spyOn(ProviderService.prototype, 'getProvider').mockImplementation(async id => id === 'current-provider'
    ? { id, runtime: 'agent-sdk', apiKey: 'private-provider-key' } as any : null)
})
afterEach(async () => {
  mock.restore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await rm(directory, { recursive: true, force: true })
})

function call(action: string, body: unknown, sessionId = caller): Promise<Response> {
  return handleSessionCollaborationApi(new Request(`http://127.0.0.1/api/session-collaboration/${action}`, {
    method: 'POST', body: JSON.stringify(body),
  }), action, sessionId, {} as SessionCollaborationService)
}

test('authenticated SDK cron CRUD uses acknowledged model/provider/cwd and persists into the desktop scheduler', async () => {
  const created = await call('cron-create', { name: 'Fixture reminder', prompt: 'Read the fixture', cron: '0 9 * * *', recurring: false })
  expect(created.status).toBe(200)
  const { task } = await created.json() as any
  expect(task).toMatchObject({ name: 'Fixture reminder', model: 'claude-haiku-5-5', providerId: 'current-provider', folderPath: join(directory, 'current-project'), recurring: false, enabled: true })
  expect(JSON.stringify(task)).not.toContain('private-provider-key')
  const updated = await call('cron-update', { taskId: task.id, prompt: 'Updated reminder', enabled: false, cron: '15 10 * * *' })
  expect(updated.status).toBe(200)
  expect((await updated.json() as any).task).toMatchObject({ id: task.id, prompt: 'Updated reminder', enabled: false, providerId: 'current-provider', model: 'claude-haiku-5-5' })
  const listed = await call('cron-list', {})
  expect((await listed.json() as any).tasks).toHaveLength(1)
  expect(JSON.parse(await readFile(join(directory, 'scheduled_tasks.json'), 'utf8')).tasks[0].enabled).toBe(false)
  expect((await call('cron-delete', { taskId: task.id })).status).toBe(200)
  expect((await (await call('cron-list', {})).json() as any).tasks).toEqual([])
})

test('SDK cron IPC rejects spoofed sources, credentials, provider overrides and invalid schedules before writes', async () => {
  for (const override of [{ providerId: 'other' }, { model: 'other' }, { folderPath: '/outside' }, { apiKey: 'secret' }, { baseUrl: 'https://example.com' }, { sourceSessionId: 'other' }, { cron: '* * * * * *' }, { cron: '0 0 31 2 *' }]) {
    expect((await call('cron-create', { prompt: 'fixture', cron: '0 9 * * *', ...override })).status).toBe(400)
  }
  expect((await call('cron-update', { taskId: 'x', providerId: 'other' })).status).toBe(400)
  expect((await call('cron-update', { taskId: 'x' })).status).toBe(400)
  expect((await call('cron-list', { endpoint: 'https://example.com' })).status).toBe(400)
  await expect(readFile(join(directory, 'scheduled_tasks.json'), 'utf8')).rejects.toThrow()
})

test('SDK cron never falls back to an unrelated provider when the active provider is missing or changes engine', async () => {
  const lookup = spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue(null)
  expect((await call('cron-create', { prompt: 'fixture', cron: '* * * * *' })).status).toBe(409)
  lookup.mockResolvedValue({ runtime: 'claude-code' } as any)
  expect((await call('cron-create', { prompt: 'fixture', cron: '* * * * *' })).status).toBe(409)
  lookup.mockResolvedValue({ runtime: 'agent-sdk' } as any)
  spyOn(conversationService, 'getSessionRuntimeSelection').mockReturnValue({ providerId: null, modelId: 'claude-haiku-5-5' })
  expect((await call('cron-create', { prompt: 'fixture', cron: '* * * * *' })).status).toBe(409)
  await expect(readFile(join(directory, 'scheduled_tasks.json'), 'utf8')).rejects.toThrow()
})

test('ephemeral side chats, team workers and legacy callers cannot manage host schedules', async () => {
  expect((await call('cron-list', {}, `side-${crypto.randomUUID()}`)).status).toBe(409)
  spyOn(conversationService, 'isTeamWorkerSession').mockReturnValue(true)
  expect((await call('cron-list', {})).status).toBe(409)
  spyOn(conversationService, 'isTeamWorkerSession').mockReturnValue(false)
  expect((await call('cron-list', {}, crypto.randomUUID())).status).toBe(409)
})

test('listing and updating a legacy schedule preserves but never discloses unrecognized stored fields', async () => {
  await writeFile(join(directory, 'scheduled_tasks.json'), JSON.stringify({ tasks: [{ id: 'legacy', createdAt: 1, cron: '* * * * *', prompt: 'fixture', extension: { preserve: true }, apiKey: 'never-expose-this' }] }))
  const listed = await (await call('cron-list', {})).text()
  expect(listed).not.toContain('never-expose-this')
  expect(listed).not.toContain('extension')
  expect((await call('cron-update', { taskId: 'legacy', enabled: false })).status).toBe(200)
  expect(JSON.parse(await readFile(join(directory, 'scheduled_tasks.json'), 'utf8')).tasks[0]).toMatchObject({ extension: { preserve: true }, apiKey: 'never-expose-this', enabled: false })
})

test('team cleanup forwards only the authenticated caller and validated team name to the lifecycle service', async () => {
  const deletion = spyOn(teamService, 'deleteTeam').mockResolvedValue()
  expect((await call('team-delete', { teamName: 'fixture-team' })).status).toBe(200)
  expect(deletion).toHaveBeenCalledWith('fixture-team', caller)
  for (const body of [{ teamName: '../other' }, { teamName: 'fixture-team', callerSessionId: 'spoofed' }]) {
    expect((await call('team-delete', body)).status).toBe(400)
  }
  expect(deletion).toHaveBeenCalledTimes(1)
})

test('host action routes require a nonbrowser session-scoped token rather than a supplied body identity', () => {
  for (const action of ['cron-create', 'cron-list', 'cron-update', 'cron-delete', 'team-delete']) {
    const path = `/api/session-collaboration/${action}`
    expect(collaborationToolAction(path)).toBe(action)
    const valid = new Request(`http://127.0.0.1${path}`, { method: 'POST', headers: { 'x-session-id': caller, authorization: 'Bearer fixture-token' } })
    const authorize = (id: string, token: string) => id === caller && token === 'fixture-token'
    expect(authenticateCollaborationCaller(valid, authorize)).toBe(caller)
    expect(authenticateCollaborationCaller(new Request(valid, { headers: { ...Object.fromEntries(valid.headers), origin: 'https://example.com' } }), authorize)).toBeNull()
    expect(authenticateCollaborationCaller(new Request(valid, { headers: { 'x-session-id': 'spoofed', authorization: 'Bearer fixture-token' } }), authorize)).toBeNull()
  }
})
