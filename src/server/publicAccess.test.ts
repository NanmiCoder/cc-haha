import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PublicAccessServer, isPublicBusinessPathAllowed, migratePublicAccessStore } from './publicAccess.js'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

function fixture(
  handleApiRequest: (request: Request, url: URL) => Promise<Response> =
    async () => Response.json({ ok: true, env: { API_KEY: 'fake-provider-secret' }, language: 'en' }),
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-access-test-'))
  const oldToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-process-credential'
  let clock = 1000
  const messages: unknown[] = []
  const storePath = path.join(dir, 'devices.json')
  const service = new PublicAccessServer({
    storePath, now: () => clock, serverPort: () => 3456,
    handleApiRequest,
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
  const pairNative = async () => {
    const code = await (await control('pairing')).json() as { secret: string }
    const pending = await (await remote('/api/public-access/pair', { secret: code.secret, name: 'Fixture native phone', clientType: 'native' })).json() as { id: string, claimSecret: string }
    await control('approve', { id: pending.id })
    const response = await remote('/api/public-access/claim', pending)
    const claim = await response.json() as { status: string, token: string, tokenType: string, deviceId: string, expiresAt: number }
    return { claim, response, pending, code }
  }
  const native = (route: string, token: string, init: RequestInit = {}) => fetch(`${base}${route}`, {
    ...init, headers: { Origin: 'https://fixture.ngrok-free.app', Authorization: `Bearer ${token}`, ...init.headers }, redirect: 'manual',
  })
  return { service, storePath, base, control, remote, pair, pairNative, native, messages, advance: (ms: number) => { clock += ms } }
}

describe('public transport boundary', () => {
  test('custom tunnels use the requested fixed port across restarts without changing device credentials', async () => {
    const f = fixture()
    const { claim } = await f.pairNative()
    const port = f.service.status().port!
    f.service.disable()
    const enabled = await f.control('enable', { port, publicUrl: 'https://fixture.ngrok-free.app' })
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toMatchObject({ enabled: true, port, publicUrl: 'https://fixture.ngrok-free.app' })
    expect((await f.native('/api/sessions', claim.token)).status).toBe(200)
    f.service.disable()
    expect((await f.control('enable', { port, publicUrl: 'https://fixture.ngrok-free.app' })).status).toBe(200)
    expect((await f.native('/api/sessions', claim.token)).status).toBe(200)
  })

  test.each([null, '17463', 0, 1023, 65536, 17463.5, true, {}, []].map(port => [port]))('rejects invalid explicit custom port %j without changing the running gateway', async port => {
    const f = fixture()
    const before = f.service.status()
    const response = await f.control('enable', { port, publicUrl: 'https://other.example' })
    expect(response.status).toBe(400)
    expect(f.service.status()).toEqual(before)
  })

  test('a running gateway refuses a different port before changing its origin', async () => {
    const f = fixture()
    const before = f.service.status()
    const port = before.port === 17463 ? 17464 : 17463
    expect((await f.control('enable', { port, publicUrl: 'https://other.example' })).status).toBe(400)
    expect(f.service.status()).toEqual(before)
  })

  test('an occupied fixed port fails closed instead of silently picking another port', async () => {
    const f = fixture()
    f.service.disable()
    const occupied = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('other service') })
    cleanups.push(() => { occupied.stop(true) })
    const response = await f.control('enable', { port: occupied.port, publicUrl: 'https://fixture.ngrok-free.app' })
    expect(response.status).toBe(400)
    expect(f.service.status()).toMatchObject({ enabled: false, port: null })
    expect(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe('other service')
  })

  test('custom tunnel setup never accepts a non-HTTPS origin or a path prefix', async () => {
    const f = fixture()
    f.service.disable()
    for (const publicUrl of ['http://example.test', 'https://example.test/desktop/a', 'https://example.test?token=secret', 42, null]) {
      expect((await f.control('enable', { publicUrl })).status).toBe(400)
      expect(f.service.status().enabled).toBe(false)
    }
  })

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

  test('a provider-scoped auth-status passes the policy with its query and returns only status fields', async () => {
    const requested: string[] = []
    const f = fixture(async (_request, url) => {
      requested.push(`${url.pathname}${url.search}`)
      return Response.json({
        hasAuth: true, source: 'cc-haha-provider', activeProvider: 'Fixture provider',
        apiKey: 'fake-provider-secret', env: { ANTHROPIC_API_KEY: 'fake-provider-secret' },
      })
    })
    const { cookie } = await f.pair()
    const response = await f.remote('/api/providers/auth-status?providerId=fixture-provider', undefined, cookie)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ hasAuth: true, source: 'cc-haha-provider', activeProvider: 'Fixture provider' })
    expect(text).not.toContain('fake-provider-secret')
    expect(requested).toEqual(['/api/providers/auth-status?providerId=fixture-provider'])
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
    expect(await restored.json()).toEqual({ authenticated: true, expiresAt: 1000 + 30 * 24 * 60 * 60_000 })
    f.advance(30 * 24 * 60 * 60_000 + 1)
    expect(f.service.status().devices).toHaveLength(0)
  })

  test('pairing attempts are bounded', async () => {
    const f = fixture()
    let status = 0
    for (let i = 0; i < 21; i++) status = (await f.remote('/api/public-access/pair', { secret: 'invalid' })).status
    expect(status).toBe(429)
  })

  test('native pairing requires approval and issues a one-time bearer claim without a browser cookie', async () => {
    const f = fixture()
    const code = await (await f.control('pairing')).json()
    const pending = await (await f.remote('/api/public-access/pair', { secret: code.secret, name: 'Native phone', clientType: 'native' })).json()
    expect((await f.remote('/api/public-access/pair', { secret: code.secret, clientType: 'native' })).status).toBe(401)
    expect(await (await f.remote('/api/public-access/claim', pending)).json()).toEqual({ status: 'pending' })
    expect((await f.remote('/api/public-access/claim', { ...pending, claimSecret: 'incorrect' })).status).toBe(401)
    await f.control('approve', { id: pending.id })
    const response = await f.remote('/api/public-access/claim', pending)
    const claim = await response.json()
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(claim).toEqual({ status: 'approved', token: expect.stringMatching(/^native_[A-Za-z0-9_-]{43}$/), tokenType: 'Bearer', deviceId: pending.id, expiresAt: 1000 + 30 * 24 * 60 * 60_000 })
    expect(readFileSync(f.storePath, 'utf8')).not.toContain(claim.token)
    expect(JSON.stringify(f.service.status())).not.toContain(claim.token)
    expect((await f.remote('/api/public-access/claim', pending)).status).toBe(401)
    expect(await (await f.native('/api/public-access/session', claim.token)).json()).toEqual({ authenticated: true, expiresAt: 1000 + 30 * 24 * 60 * 60_000 })
    expect((await f.native('/api/sessions', claim.token)).status).toBe(200)
    expect((await f.native('/api/sessions', claim.token, { method: 'POST', body: '{}' })).status).toBe(200)
    expect(await (await f.native('/api/settings/user', claim.token)).json()).toEqual({ language: 'en' })
  })

  test('pairing fixes the credential kind and rejects unsupported kinds without consuming the pairing secret', async () => {
    const f = fixture()
    const code = await (await f.control('pairing')).json()
    expect((await f.remote('/api/public-access/pair', { secret: code.secret, clientType: 'unknown' })).status).toBe(400)
    const pending = await (await f.remote('/api/public-access/pair', { secret: code.secret })).json()
    await f.control('approve', { id: pending.id })
    const response = await f.remote('/api/public-access/claim', { ...pending, clientType: 'native' })
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Strict')
    expect(await response.json()).toEqual({ status: 'approved' })
  })

  test('native and cookie credentials do not substitute for each other or for local credentials', async () => {
    const f = fixture()
    const { claim } = await f.pairNative()
    const { cookie } = await f.pair()
    const cookieToken = cookie.slice(cookie.indexOf('=') + 1)
    for (const token of [cookieToken, 'fixture-process-credential', 'fake-lan-token', 'native_wrong', claim.token + 'extra']) {
      expect((await f.native('/api/sessions', token)).status).toBe(401)
      const socketResponse = await f.service.fetch(new Request(`${f.base}/ws/fixture`, { headers: { Origin: 'https://fixture.ngrok-free.app', Authorization: `Bearer ${token}` } }), { upgrade: () => { throw new Error('Must not upgrade') } } as never)
      expect(socketResponse?.status).toBe(401)
    }
    expect((await f.remote('/api/sessions', undefined, `__Host-haha-remote=${claim.token}`)).status).toBe(401)
    expect((await f.remote(`/api/sessions?token=${encodeURIComponent(claim.token)}`)).status).toBe(401)
    expect((await f.native('/api/sessions', 'invalid', { headers: { Cookie: cookie } })).status).toBe(401)
    expect((await f.remote('/api/sessions', undefined, cookie)).status).toBe(200)
  })

  test('native bearer preserves origin checks and the remote business allowlist', async () => {
    const f = fixture()
    const { claim } = await f.pairNative()
    expect((await f.native('/api/sessions', claim.token, { headers: { Origin: 'https://attacker.example' } })).status).toBe(403)
    expect((await f.native('/api/sessions', claim.token, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
    expect((await f.native('/api/sessions', claim.token, { headers: { 'Sec-Fetch-Site': 'same-site' } })).status).toBe(403)
    expect((await f.native('/api/sessions', claim.token, { method: 'POST', headers: { Origin: '' }, body: '{}' })).status).toBe(403)
    for (const route of ['/sdk/session', '/proxy/v1/messages', '/api/providers/settings', '/api/settings', '/api/diagnostics', '/api/h5-access', '/local-file/private', '/preview-fs/private']) {
      expect((await f.native(route, claim.token)).status).toBe(403)
    }
    expect((await f.native('/api/permissions/mode', claim.token, { method: 'PUT', body: '{}' })).status).toBe(403)
    expect((await f.native('/api/public-access/approve', claim.token, { method: 'POST', body: '{}' })).status).toBe(404)
    // A valid token must not reach the upgrade function without a valid origin.
    for (const origin of ['', 'https://attacker.example']) {
      const response = await f.service.fetch(new Request(`${f.base}/ws/fixture`, { headers: { Origin: origin, Authorization: `Bearer ${claim.token}` } }), { upgrade: () => { throw new Error('Must not upgrade') } } as never)
      expect(response?.status).toBe(403)
    }
  })

  test('rejected or expired native pairings never issue a bearer token', async () => {
    const f = fixture()
    const code = await (await f.control('pairing')).json()
    const pending = await (await f.remote('/api/public-access/pair', { secret: code.secret, clientType: 'native' })).json()
    await f.control('reject', { id: pending.id })
    expect(await (await f.remote('/api/public-access/claim', pending)).json()).toEqual({ status: 'rejected' })
    const nextCode = await (await f.control('pairing')).json()
    const next = await (await f.remote('/api/public-access/pair', { secret: nextCode.secret, clientType: 'native' })).json()
    await f.control('approve', { id: next.id })
    f.advance(300_001)
    expect((await f.remote('/api/public-access/claim', next)).status).toBe(401)
    expect(f.service.status().devices).toHaveLength(0)
  })

  test.each(['revoke', 'expire', 'disable'] as const)('native WebSocket authentication and %s stop access', async (action) => {
    const f = fixture()
    const { claim, pending } = await f.pairNative()
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws/fixture', { headers: { Origin: 'https://fixture.ngrok-free.app', Authorization: `Bearer ${claim.token}` } })
    cleanups.push(() => ws.close())
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject })
    ws.send('native-message')
    await Bun.sleep(10)
    expect(f.messages).toEqual(['native-message'])
    const closed = new Promise<number>(resolve => { ws.onclose = event => resolve(event.code) })
    if (action === 'revoke') await f.control('revoke', { id: pending.id })
    if (action === 'expire') {
      f.advance(30 * 24 * 60 * 60_000 + 1)
      ws.send('must-not-reach-agent')
    }
    if (action === 'disable') f.service.disable()
    expect(await closed).toBe(action === 'disable' ? 1012 : 1008)
    expect(f.messages).toEqual(['native-message'])
    const response = await f.service.fetch(new Request(`${f.base}/api/sessions`, { headers: { Origin: 'https://fixture.ngrok-free.app', Authorization: `Bearer ${claim.token}` } }), {} as never)
    expect(response?.status).toBe(action === 'disable' ? 503 : 401)
  })

  test('native credentials reload from the existing hash-only device store and expire normally', async () => {
    const f = fixture()
    const { claim } = await f.pairNative()
    f.service.disable()
    let clock = 1000
    const restored = new PublicAccessServer({
      storePath: f.storePath, now: () => clock, serverPort: () => 3456,
      handleApiRequest: async () => Response.json({ ok: true }), handleStatic: async () => null, websocket: { message() {} },
    })
    cleanups.push(() => restored.disable())
    restored.enable('https://fixture.ngrok-free.app')
    const request = () => restored.fetch(new Request('https://fixture.ngrok-free.app/api/sessions', { headers: { Origin: 'https://fixture.ngrok-free.app', Authorization: `Bearer ${claim.token}` } }), {} as never)
    expect((await request())?.status).toBe(200)
    clock = claim.expiresAt
    expect((await request())?.status).toBe(401)
    const stored = JSON.parse(readFileSync(f.storePath, 'utf8'))
    expect(stored.version).toBe(1)
    expect(Object.keys(stored.devices[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'name', 'tokenHash'])
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


test('remote scheduled task routes stay restricted to the scheduler contract', () => {
  const allowed = (path: string, method: string) => isPublicBusinessPathAllowed(new URL(path, 'https://fixture.test'), method)
  for (const [path, method] of [['/api/scheduled-tasks', 'GET'], ['/api/scheduled-tasks', 'POST'], ['/api/scheduled-tasks/id', 'PUT'], ['/api/scheduled-tasks/id', 'DELETE'], ['/api/scheduled-tasks/id/run', 'POST'], ['/api/scheduled-tasks/id/runs', 'GET'], ['/api/scheduled-tasks/runs', 'GET'], ['/api/scheduled-tasks/runs/run-id', 'GET']]) expect(allowed(path!, method!)).toBe(true)
  for (const [path, method] of [['/api/scheduled-tasks', 'DELETE'], ['/api/scheduled-tasks/runs', 'POST'], ['/api/scheduled-tasks/id/run', 'PUT'], ['/api/scheduled-tasks/id/runs/extra', 'GET'], ['/api/scheduled-tasks/id/unknown', 'POST']]) expect(allowed(path!, method!)).toBe(false)
})

test('session status exposes only the authenticated device expiry', async () => {
  const f = fixture()
  const { claim } = await f.pairNative()
  expect(await (await f.remote('/api/public-access/session')).json()).toEqual({ authenticated: false })
  expect(await (await f.native('/api/public-access/session', claim.token)).json()).toEqual({ authenticated: true, expiresAt: claim.expiresAt })
  f.advance(30 * 24 * 60 * 60_000 + 1)
  expect(await (await f.native('/api/public-access/session', claim.token)).json()).toEqual({ authenticated: false })
})

test('remote settings retain normalized auto-question settings through the second projection', async () => {
  const f = fixture(async () => Response.json({ autoQuestion: { enabled: true, timeoutMinutes: 5, secret: 'never' }, env: { SECRET: 'never' } }))
  const { claim } = await f.pairNative()
  expect(await (await f.native('/api/settings/user', claim.token)).json()).toEqual({ autoQuestion: { enabled: true, timeoutMinutes: 5 } })
})

test('push route allowlist refuses extra segments and unsupported methods', () => {
  const allowed = (path: string, method: string) => isPublicBusinessPathAllowed(new URL(path, 'https://fixture.test'), method)
  expect(allowed('/api/sessions/mobile-push', 'GET')).toBe(true)
  expect(allowed('/api/sessions/mobile-push', 'PUT')).toBe(true)
  expect(allowed('/api/sessions/mobile-push/id', 'DELETE')).toBe(true)
  expect(allowed('/api/sessions/mobile-push/id', 'GET')).toBe(false)
  expect(allowed('/api/sessions/mobile-push/id/extra', 'DELETE')).toBe(false)
  expect(allowed('/api/sessions/mobile-push', 'POST')).toBe(false)
})

test('paired phones can browse directories without gaining file/search/write routes', async () => {
  const calls: string[] = []
  const f = fixture(async (_request, url) => {
    calls.push(url.pathname + url.search)
    return Response.json({ currentPath: '/fixture/project', parentPath: '/fixture', entries: [] })
  })
  const route = '/api/filesystem/browse?path=%2Ffixture%2F%E9%A1%B9%E7%9B%AE%20%26%20app'
  expect((await f.remote(route)).status).toBe(401)
  const { claim } = await f.pairNative()
  expect((await f.native(route, claim.token)).status).toBe(200)
  expect(calls).toEqual([route])
  for (const route of [
    '/api/filesystem/file?path=/fixture/secret',
    '/api/filesystem/browse/extra',
    '/api//filesystem/browse',
    '/api/filesystem/browse?includeFiles=true',
    '/api/filesystem/browse?includeFiles=false&includeFiles=true',
    '/api/filesystem/browse?search=secret',
  ]) expect((await f.native(route, claim.token)).status).toBe(403)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    expect((await f.native('/api/filesystem/browse', claim.token, { method })).status).toBe(403)
  }
  expect(calls).toHaveLength(1)
})

test('paired phones can configure global computer-use consent and read composer mentions only', async () => {
  const calls: { path: string, method: string, body?: unknown }[] = []
  const f = fixture(async (request, url) => {
    calls.push({ path: url.pathname + url.search, method: request.method,
      ...(request.method === 'PUT' ? { body: await request.json() } : {}) })
    return Response.json({ ok: true })
  })
  const allowed = [
    ['/api/skills/mentions?cwd=%2Ffixture&providerId=fixture&agentProfile=lean', 'GET'],
    ['/api/skills/commands?cwd=%2Ffixture&agentProfile=lean', 'GET'],
    ['/api/computer-use/status', 'GET'],
    ['/api/computer-use/authorized-apps', 'GET'],
    ['/api/computer-use/authorized-apps', 'PUT'],
    ['/api/computer-use/open-permission-card', 'POST'],
  ] as const
  const consent = { enabled: true, grantFlags: { clipboardRead: true, clipboardWrite: true, systemKeyCombos: true } }
  for (const [route] of allowed) expect((await f.remote(route)).status).toBe(401)
  const { claim } = await f.pairNative()
  for (const [route, method] of allowed) {
    expect((await f.native(route, claim.token, { method,
      ...(method === 'PUT' ? { body: JSON.stringify(consent), headers: { 'Content-Type': 'application/json' } } : {}),
    })).status).toBe(200)
  }
  expect(calls.find(call => call.method === 'PUT')?.body).toEqual(consent)
  for (const body of [{ pythonPath: '/fixture/python' }, { enabled: true, authorizedApps: [] }, { grantFlags: { unknown: true } }]) {
    expect((await f.native('/api/computer-use/authorized-apps', claim.token, {
      method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    })).status).toBe(403)
  }
  for (const [route, method] of [
    ['/api/skills', 'GET'], ['/api/skills/detail', 'GET'], ['/api/skills/mentions', 'POST'],
    ['/api/skills/mentions/extra', 'GET'], ['/api/computer-use/status', 'POST'],
    ['/api/skills/commands', 'POST'], ['/api/skills/commands/extra', 'GET'],
    ['/api/computer-use/authorized-apps', 'DELETE'], ['/api/computer-use/authorized-apps/extra', 'PUT'],
    ['/api/computer-use/setup', 'POST'], ['/api/computer-use/apps', 'GET'],
    ['/api/computer-use/open-settings', 'POST'], ['/api/computer-use/open-permission-card', 'GET'],
    ['/api/computer-use/execute', 'POST'],
  ]) expect((await f.native(route!, claim.token, { method })).status).toBe(403)
  expect(calls).toHaveLength(allowed.length)
})

const fixtureConnector = {
  id: 'feishu', displayName: 'Feishu', description: 'Docs and calendar', category: 'office', transport: 'cli',
  collection: 'services', pluginId: 'office-feishu@haha-connectors', supported: true, installed: true, enabled: true,
  connection: 'needs-auth', status: 'needs-auth', accountLabel: 'fixture-user',
  packageName: '@larksuite/cli', version: '1.0.95', homepage: 'https://example.test/feishu', credentialMode: 'shared', platforms: ['darwin-arm64'],
  setupFields: [{ key: 'appSecret', label: 'Secret', secret: true }], runtime: 'ready',
  error: 'spawn /Users/fixture/.claude/connectors/feishu/bin failed: EACCES', failedPhase: 'authenticate',
  operation: { id: 'op-1', kind: 'authenticate', phase: 'waiting-for-browser', startedAt: '2026-01-01T00:00:00Z', authUrl: 'https://accounts.example.test/oauth?state=fixture-secret' },
}

test('remote phones read the connector and workflow lists only', () => {
  const allowed = (path: string, method: string) => isPublicBusinessPathAllowed(new URL(path, 'https://fixture.test'), method)
  expect(allowed('/api/connectors', 'GET')).toBe(true)
  expect(allowed('/api//connectors/', 'GET')).toBe(true)
  expect(allowed('/api/workflows?cwd=%2Ffixture', 'GET')).toBe(true)
  expect(allowed('/api/agents', 'GET')).toBe(true)
  expect(allowed('/api/agents/reviewer', 'GET')).toBe(true)
  for (const [path, method] of [
    ['/api/connectors/feishu', 'GET'], ['/api/connectors', 'POST'], ['/api/connectors', 'DELETE'],
    ['/api/connectors/feishu/authenticate', 'POST'], ['/api/connectors/feishu/prepare', 'POST'], ['/api/connectors/feishu/remove', 'POST'],
    ['/api/workflows', 'PUT'], ['/api/workflows', 'POST'], ['/api/workflows/save', 'POST'], ['/api/workflows/validate', 'POST'],
    ['/api/workflows/runs', 'GET'], ['/api/workflows/session-runs/s1', 'GET'], ['/api/workflows/my-flow', 'GET'], ['/api/workflows/my-flow', 'DELETE'],
    ['/api/mcp', 'GET'], ['/api/mcp/servers', 'POST'], ['/api/plugins', 'GET'],
    // 路由器会忽略单项 Agent 名字后面多出来的段，放行它们等于绕过对手机的裁剪。
    ['/api/agents/reviewer/override', 'GET'], ['/api/agents/reviewer/zzz', 'GET'], ['/api/agents/reviewer', 'DELETE'],
  ]) expect(allowed(path!, method!)).toBe(false)
})

test('paired phones get connector, workflow and agent lists without credentials, errors or local paths', async () => {
  const f = fixture(async (_request, url) => {
    if (url.pathname === '/api/connectors') return Response.json({ items: [fixtureConnector] })
    if (url.pathname === '/api/workflows') return Response.json({ workflows: [
      { name: 'ship', description: 'Ship it', whenToUse: 'release', source: 'user', phases: [{ title: 'Build' }], filePath: '/Users/fixture/.claude/workflows/ship.js' },
    ] })
    const agent = { agentType: 'reviewer', description: 'Reviews code', model: 'sonnet', modelDisplay: 'Sonnet', tools: ['Bash'], systemPrompt: 'fixture-secret-prompt', color: 'blue', source: 'userSettings', baseDir: '/Users/fixture/.claude', target: '/Users/fixture/.claude/agents/reviewer.md', isActive: true, editable: true }
    if (url.pathname === '/api/agents/reviewer') return Response.json({ agent })
    return Response.json({ availableTools: ['Bash'], activeAgents: [agent], allAgents: [{ ...agent, overriddenBy: 'projectSettings' }] })
  })
  const { claim } = await f.pairNative()
  const read = async (route: string) => (await f.native(route, claim.token)).json()
  expect(await read('/api/connectors')).toEqual({ items: [{
    id: 'feishu', displayName: 'Feishu', description: 'Docs and calendar', category: 'office', transport: 'cli',
    collection: 'services', pluginId: 'office-feishu@haha-connectors', supported: true, installed: true, enabled: true,
    connection: 'needs-auth', status: 'needs-auth', accountLabel: 'fixture-user',
    operation: { kind: 'authenticate', phase: 'waiting-for-browser' },
  }] })
  expect(await read('/api/workflows')).toEqual({ workflows: [{ name: 'ship', description: 'Ship it', whenToUse: 'release', source: 'user' }] })
  const agents = await read('/api/agents?cwd=%2Ffixture')
  expect(agents).toEqual({
    activeAgents: [{ agentType: 'reviewer', description: 'Reviews code', modelDisplay: 'Sonnet', color: 'blue', source: 'userSettings', isActive: true }],
    allAgents: [{ agentType: 'reviewer', description: 'Reviews code', modelDisplay: 'Sonnet', color: 'blue', source: 'userSettings', isActive: true, overriddenBy: 'projectSettings' }],
  })
  expect(await read('/api/agents/reviewer')).toEqual({ agent: { agentType: 'reviewer', description: 'Reviews code', modelDisplay: 'Sonnet', color: 'blue', source: 'userSettings', isActive: true } })
  const text = JSON.stringify([await read('/api/connectors'), await read('/api/workflows'), agents])
  for (const secret of ['authUrl', 'fixture-secret', 'EACCES', '/Users/fixture', 'setupFields', 'homepage', 'packageName', 'systemPrompt', 'filePath', 'availableTools']) expect(text).not.toContain(secret)
})

test('connector actions and details never reach the desktop handler from a phone', async () => {
  const calls: string[] = []
  const f = fixture(async (request, url) => { calls.push(`${request.method} ${url.pathname}`); return Response.json({ items: [] }) })
  const { claim } = await f.pairNative()
  for (const [route, method] of [
    ['/api/connectors/feishu', 'GET'], ['/api/connectors/feishu/authenticate', 'POST'],
    ['/api/workflows/runs', 'GET'], ['/api/workflows/save', 'POST'], ['/api/workflows', 'PUT'], ['/api/mcp', 'GET'],
    ['/api/agents/reviewer/zzz', 'GET'],
  ]) expect((await f.native(route!, claim.token, { method })).status).toBe(403)
  expect((await f.remote('/api/connectors')).status).toBe(401)
  expect(calls).toEqual([])
})

test('paired browsers keep the full agent view while connectors stay projected', async () => {
  const full = { agentType: 'reviewer', systemPrompt: 'visible-to-browser', isActive: true }
  const f = fixture(async (_request, url) => url.pathname === '/api/connectors'
    ? Response.json({ items: [fixtureConnector] })
    : Response.json({ activeAgents: [full], allAgents: [full] }))
  const { cookie } = await f.pair()
  expect(await (await f.remote('/api/agents', undefined, cookie)).json()).toEqual({ activeAgents: [full], allAgents: [full] })
  expect(JSON.stringify(await (await f.remote('/api/connectors', undefined, cookie)).json())).not.toContain('authUrl')
})
