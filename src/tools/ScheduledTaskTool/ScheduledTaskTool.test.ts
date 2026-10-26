import { afterEach, expect, test } from 'bun:test'
import { ScheduledTaskTool } from './ScheduledTaskTool.js'
import { callScheduledTaskBridge } from './bridge.js'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'

const names = ['CC_HAHA_DESKTOP_SERVER_URL', 'CC_HAHA_SESSION_COLLABORATION_TOKEN', 'CC_HAHA_SESSION_ID'] as const
const original = names.map(name => process.env[name])
const profile = getAgentProfile()
afterEach(() => {
  names.forEach((name, i) => { if (original[i] === undefined) delete process.env[name]; else process.env[name] = original[i] })
  setAgentProfile(profile)
})
function configure(url: string) {
  process.env.CC_HAHA_DESKTOP_SERVER_URL = url
  process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'fixture-token'
  process.env.CC_HAHA_SESSION_ID = 'fixture-session'
}

test('desktop scheduling is available without a cron feature flag but respects bridge and lean profile', () => {
  names.forEach(name => delete process.env[name])
  expect(ScheduledTaskTool.isEnabled()).toBe(false)
  configure('http://127.0.0.1:12345')
  setAgentProfile('standard')
  expect(ScheduledTaskTool.isEnabled()).toBe(true)
  setAgentProfile('lean')
  expect(ScheduledTaskTool.isEnabled()).toBe(false)
  setAgentProfile('standard')
  configure('https://example.com')
  expect(ScheduledTaskTool.isEnabled()).toBe(false)
})

test('bounds result reads and rejects caller spoofing and unknown mutations', () => {
  expect(ScheduledTaskTool.isReadOnly({ action: 'run', runId: 'r' })).toBe(true)
  expect(ScheduledTaskTool.isReadOnly({ action: 'delete', id: 't' })).toBe(false)
  expect(ScheduledTaskTool.isReadOnly({ action: 'report', runId: 'r', decision: 'silent' })).toBe(false)
  expect(ScheduledTaskTool.inputSchema.safeParse({ action: 'runs', limit: 51 }).success).toBe(false)
  expect(ScheduledTaskTool.inputSchema.safeParse({ action: 'run', runId: 'r', maxChars: 16001 }).success).toBe(false)
  expect(ScheduledTaskTool.inputSchema.safeParse({ action: 'list', sourceSessionId: 'spoofed' }).success).toBe(false)
  expect(ScheduledTaskTool.inputSchema.safeParse({ action: 'update', id: 't', changes: { permissionMode: 'bypassPermissions' } }).success).toBe(false)
})

test('sends authenticated creation with a stable tool call id and serializes the snapshot into transcript content', async () => {
  const snapshot = { schemaVersion: 1, kind: 'scheduled_task', operation: 'created', taskId: 't', task: { id: 't', name: 'Reminder' } }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe('/api/scheduled-task-tools')
    expect(req.headers.get('authorization')).toBe('Bearer fixture-token')
    expect(req.headers.get('x-session-id')).toBe('fixture-session')
    const input = await req.json() as Record<string, unknown>
    expect(input.requestId).toBe('call-fixture')
    expect(input).not.toHaveProperty('sourceSessionId')
    return Response.json(snapshot)
  } })
  try {
    configure(server.url.origin)
    const result = await ScheduledTaskTool.call({ action: 'create', name: 'Reminder', prompt: 'Continue', schedule: { kind: 'once', runAt: '2099-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' } }, { toolUseId: 'call-fixture', abortController: new AbortController() } as never)
    expect(result.data).toEqual(snapshot)
    const block = ScheduledTaskTool.mapToolResultToToolResultBlockParam(result.data, 'call-fixture')
    expect(JSON.parse(block.content as string)).toEqual(snapshot)
  } finally { server.stop(true) }
})

test('bridge does not expose arbitrary error bodies or follow redirects', async () => {
  let redirect = true
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return redirect ? Response.redirect('https://example.com') : new Response('private diagnostics', { status: 500 })
  } })
  try {
    configure(server.url.origin)
    await expect(callScheduledTaskBridge({ action: 'list' })).rejects.toThrow()
    redirect = false
    await expect(callScheduledTaskBridge({ action: 'list' })).rejects.toThrow('ScheduledTask failed (500)')
  } finally { server.stop(true) }
})
