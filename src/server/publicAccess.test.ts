import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PublicAccessServer, isPublicBusinessPathAllowed, migratePublicAccessStore } from './publicAccess.js'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-access-test-'))
  const oldToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-process-credential'
  let clock = 1000
  const messages: unknown[] = []
  const storePath = path.join(dir, 'devices.json')
  const service = new PublicAccessServer({
    storePath, now: () => clock, serverPort: () => 3456,
    handleApiRequest: async () => Response.json({ ok: true, env: { API_KEY: 'fake-provider-secret' }, language: 'en' }),
    handleStatic: async () => new Response('<html>fixture</html>'),
    websocket: { message: (_ws, payload) => { messages.push(payload) } },
  })
  service.enable('https://fixture.ngrok-free.app')
  const base = `http://127.0.0.1:${service.status().port}`
  cleanups.push(() => {
    service.disable()
    if (oldToken === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = oldToken
    rmSync(dir, { recursive: true, force: true })
  })
  const control = async (route: string, body: unknown = {}, method = 'POST', authorized = true) => service.control(new Request(`http://localhost/api/public-access/${route}`, {
    method, headers: authorized ? { Authorization: 'Bearer fixture-process-credential' } : {}, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  }))
  const remote = (route: string, body?: unknown, cookie?: string, origin = 'https://fixture.ngrok-free.app') => fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
  })
  const pair = async () => {
    const code = await (await control('pairing')).json() as { secret: string }
    const pending = await (await remote('/api/public-access/pair', { secret: code.secret, name: 'Fixture phone' })).json() as { id: string, claimSecret: string }
    await control('approve', { id: pending.id })
    const response = await remote('/api/public-access/claim', pending)
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, response, pending, code }
  }
  return { service, storePath, base, control, remote, pair, messages, advance: (ms: number) => { clock += ms } }
}

describe('public transport boundary', () => {
  test('loopback Host and local bearer cannot bypass cookie authentication on remote listener', async () => {
    const f = fixture()
    const response = await f.service.fetch(new Request('http://localhost/api/sessions', { headers: { Host: 'localhost', Authorization: 'Bearer fixture-process-credential' } }), {} as never)
    expect(response?.status).toBe(401)
    expect((await f.control('status', {}, 'GET', false)).status).toBe(403)
    expect((await f.remote('/api/public-access/enable', {})).status).toBe(404)
  })

  test('pairing is single use, requires approval, stores hash, and issues protected host-only cookie', async () => {
    const f = fixture()
    const code = await (await f.control('pairing')).json()
    const pending = await (await f.remote('/api/public-access/pair', { secret: code.secret, name: 'Phone' })).json()
    expect((await f.remote('/api/public-access/pair', { secret: code.secret })).status).toBe(401)
    expect(await (await f.remote('/api/public-access/claim', pending)).json()).toEqual({ status: 'pending' })
    await f.control('approve', { id: pending.id })
    const claimed = await f.remote('/api/public-access/claim', pending)
    const cookie = claimed.headers.get('set-cookie')!
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Strict')
    expect(cookie).not.toContain('Domain=')
    expect(cookie).toContain('Max-Age=2592000')
    expect(readFileSync(f.storePath, 'utf8')).not.toContain(cookie.split(';')[0]!.split('=')[1]!)
    expect(JSON.stringify(f.service.status())).not.toContain('tokenHash')
    expect((await f.remote('/api/public-access/claim', pending)).status).toBe(401)
    expect((await f.remote('/api/sessions', undefined, cookie)).status).toBe(200)
    expect((await f.remote('/api/settings/user', undefined, cookie)).status).toBe(200)
    expect(await (await f.remote('/api/settings/user', undefined, cookie)).json()).toEqual({ language: 'en' })
    expect(await (await f.remote('/api/providers/auth-status', undefined, cookie)).json()).toEqual({ hasAuth: false, source: 'none' })
  })

  test('expired and rejected pairings cannot become a device', async () => {
    const f = fixture()
    const code = await (await f.control('pairing')).json()
    f.advance(300_001)
    expect((await f.remote('/api/public-access/pair', { secret: code.secret })).status).toBe(401)
    const next = await (await f.control('pairing')).json()
    const pending = await (await f.remote('/api/public-access/pair', { secret: next.secret })).json()
    await f.control('reject', { id: pending.id })
    expect(await (await f.remote('/api/public-access/claim', pending)).json()).toEqual({ status: 'rejected' })
    expect(f.service.status().devices).toHaveLength(0)
  })

  test('cross-site requests and privileged routes remain forbidden after pairing', async () => {
    const f = fixture()
    const { cookie } = await f.pair()
    expect((await f.remote('/api/sessions', {}, cookie, 'https://attacker.example')).status).toBe(403)
    expect((await f.remote('/api/sessions', {}, cookie, '')).status).toBe(403)
    for (const route of ['/api/providers/auth-status/extra', '/sdk/session', '/proxy/v1/messages', '/api/providers/settings', '/api/settings', '/api//settings/session-cleanup/', '/api/diagnostics', '/api/h5-access']) {
      expect((await f.remote(route, undefined, cookie)).status).toBe(403)
    }
    expect((await f.remote('/')).headers.get('location')).toBe('/remote')
  })

  test('revocation rejects subsequent requests and closes an existing WebSocket', async () => {
    const f = fixture()
    const { cookie, pending } = await f.pair()
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws/fixture', { headers: { Origin: 'https://fixture.ngrok-free.app', Cookie: cookie } })
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject })
    ws.send('fixture-message')
    await Bun.sleep(10)
    expect(f.messages).toEqual(['fixture-message'])
    const closed = new Promise<void>(resolve => { ws.onclose = () => resolve() })
    await f.control('revoke', { id: pending.id })
    await closed
    expect((await f.remote('/api/sessions', undefined, cookie)).status).toBe(401)
  })

  test('every WebSocket message rechecks expiry without waiting for the cleanup timer', async () => {
    const f = fixture()
    const { cookie } = await f.pair()
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws/fixture', { headers: { Origin: 'https://fixture.ngrok-free.app', Cookie: cookie } })
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject })
    f.advance(30 * 24 * 60 * 60_000 + 1)
    const closed = new Promise<void>(resolve => { ws.onclose = () => resolve() })
    ws.send('must-not-reach-agent')
    await closed
    expect(f.messages).toEqual([])
  })

  test('session expiry, disable, and restart preserve only valid device hashes', async () => {
    const f = fixture()
    const { cookie } = await f.pair()
    const firstPort = f.service.status().port
    expect(f.service.enable().port).toBe(firstPort)
    f.service.disable()
    expect(f.service.status().enabled).toBe(false)
    f.service.enable('https://fixture.ngrok-free.app')
    const restored = await fetch(`http://127.0.0.1:${f.service.status().port}/api/public-access/session`, { headers: { Cookie: cookie } })
    expect(await restored.json()).toEqual({ authenticated: true })
    f.advance(30 * 24 * 60 * 60_000 + 1)
    expect(f.service.status().devices).toHaveLength(0)
  })

  test('pairing attempts are bounded', async () => {
    const f = fixture()
    let status = 0
    for (let i = 0; i < 21; i++) status = (await f.remote('/api/public-access/pair', { secret: 'invalid' })).status
    expect(status).toBe(429)
  })

  test('old store migration preserves unknown fields and never upgrades LAN token to remote access', () => {
    expect(migratePublicAccessStore({ version: 0, legacyToken: 'fake-lan-token', futureField: 42 })).toEqual({ version: 1, devices: [], legacyToken: 'fake-lan-token', futureField: 42 })
    expect(() => migratePublicAccessStore({ version: 2 })).toThrow('Unsupported')
    const f = fixture()
    f.service.disable()
    writeFileSync(f.storePath, JSON.stringify({ version: 0, futureField: { kept: true } }))
    const next = new PublicAccessServer({ storePath: f.storePath, handleApiRequest: async () => new Response(), handleStatic: async () => null, websocket: { message() {} }, serverPort: () => 3456 })
    try {
      next.enable()
      expect(JSON.parse(readFileSync(f.storePath, 'utf8'))).toEqual({ version: 1, devices: [], futureField: { kept: true } })
    } finally { next.disable() }
  })

  test('business allowlist normalizes routes like the router', () => {
    expect(isPublicBusinessPathAllowed(new URL('https://example.test/api//settings/user/'), 'GET')).toBe(true)
    expect(isPublicBusinessPathAllowed(new URL('https://example.test/api//settings/user/'), 'PUT')).toBe(true)
    expect(isPublicBusinessPathAllowed(new URL('https://example.test/api/permissions/mode'), 'PUT')).toBe(false)
    expect(isPublicBusinessPathAllowed(new URL('https://example.test/api/models/current'), 'PUT')).toBe(true)
    expect(isPublicBusinessPathAllowed(new URL('https://example.test/api/effort'), 'PUT')).toBe(true)
  })
})
