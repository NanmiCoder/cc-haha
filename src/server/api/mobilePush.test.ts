import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { handleMobilePushApi } from './mobilePush.js'
import { MobilePushService, type PushInput } from '../services/mobilePushService.js'
import { PublicAccessServer } from '../publicAccess.js'
import type { ApiRequestContext } from '../remoteBrowserPolicy.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const body: PushInput = { platform: 'ios', token: 'b'.repeat(64), hostId: 'phone-host', preferences: { decisions: true, completed: true, errors: true }, quietHours: { enabled: false, start: '22:00', end: '08:00' }, timeZone: 'UTC' }
function service() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mobile-push-api-'))
  const push = new MobilePushService({ directory, transport: { configured: () => true, send: async () => 'sent' }, activities: () => [], summary: async () => null })
  cleanups.push(() => { void push.stop(); rmSync(directory, { recursive: true, force: true }) })
  return { push, directory }
}

test('registration endpoints never list tokens, reject client ownership and protect unregister', async () => {
  const { push } = service()
  const call = (method: string, data?: unknown, id?: string, context: ApiRequestContext = {}) => handleMobilePushApi(new Request('http://localhost/api/sessions/mobile-push', { method, ...(data ? { body: JSON.stringify(data) } : {}) }), ['api', 'sessions', 'mobile-push', ...(id ? [id] : [])], context, push)
  const response = await call('PUT', body, undefined, { remoteDeviceId: 'verified-a' })
  const registered = await response.json() as { id: string }
  expect(response.status).toBe(200)
  expect(await (await call('GET')).text()).not.toContain(body.token)
  expect((await call('PUT', { ...body, owner: 'verified-b' })).status).toBe(400)
  expect((await call('DELETE', { token: body.token }, registered.id, { remoteDeviceId: 'verified-b' })).status).toBe(404)
  expect((await call('DELETE', { token: body.token }, registered.id, { remoteDeviceId: 'verified-a' })).status).toBe(200)
  expect((await call('POST', body)).status).toBe(405)
})

test('public listener derives push owner from the authenticated pairing rather than headers or body', async () => {
  const { push, directory } = service()
  const old = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-only'
  let seen: ApiRequestContext | undefined
  const remote = new PublicAccessServer({ storePath: path.join(directory, 'devices.json'), serverPort: () => 3456, websocket: { message() {} }, handleStatic: async () => null, handleApiRequest: async (req, url, context) => { seen = context; return handleMobilePushApi(req, url.pathname.split('/').filter(Boolean), context!, push) } })
  remote.enable('https://push.example.test')
  cleanups.push(() => { remote.disable(); if (old === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN; else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = old })
  const control = (route: string, data: unknown = {}) => remote.control(new Request(`http://localhost/api/public-access/${route}`, { method: 'POST', headers: { Authorization: 'Bearer fixture-only' }, body: JSON.stringify(data) }))
  const base = `http://127.0.0.1:${remote.status().port}`
  const send = (route: string, data: unknown) => fetch(base + route, { method: 'POST', headers: { Origin: 'https://push.example.test' }, body: JSON.stringify(data) })
  const pairing = await (await control('pairing')).json()
  const pending = await (await send('/api/public-access/pair', { secret: pairing.secret, clientType: 'native' })).json()
  await control('approve', { id: pending.id })
  const claimed = await (await send('/api/public-access/claim', pending)).json()
  const response = await fetch(base + '/api/sessions/mobile-push', { method: 'PUT', headers: { Origin: 'https://push.example.test', Authorization: `Bearer ${claimed.token}`, 'X-Device-Id': 'attacker-selected' }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
  expect(seen).toEqual({ remoteBrowser: true, remoteDeviceId: claimed.deviceId, remoteDeviceExpiresAt: claimed.expiresAt })
  expect(remote.isDeviceActive(claimed.deviceId)).toBe(true)
  await control('revoke', { id: claimed.deviceId })
  expect(remote.isDeviceActive(claimed.deviceId)).toBe(false)
})
