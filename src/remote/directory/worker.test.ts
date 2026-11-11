import { afterEach, describe, expect, test } from 'bun:test'
import { createPrivateKey, sign } from 'node:crypto'
import fixture from '../../shared/__fixtures__/remote-identity-v2.json'
import { announcementBytes } from '../../shared/remoteIdentityProtocol'
import worker, { MachineDirectory, type DirectoryEnvironment } from './worker'

const privateKey = createPrivateKey({ key: Buffer.from(fixture.privateKeyPkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
const realNow = Date.now
afterEach(() => { Date.now = realNow })
function signed(sequence = 1, overrides = {}) {
  const value = { version: 2, hostId: fixture.hostId, publicKey: fixture.publicKey, origin: 'https://computer.example', sequence, expiresAt: Date.now() + 600_000, ...overrides }
  return { ...value, signature: sign('sha256', announcementBytes(value), privateKey).toString('base64url') }
}
function request(body?: unknown, options: RequestInit = {}) {
  return new Request(`https://directory.example/v1/hosts/${fixture.hostId}`, body === undefined ? options : {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options,
  })
}
function setup() {
  const data = new Map<string, unknown>()
  let queue = Promise.resolve()
  const storage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)) },
    transaction: async <T>(callback: (store: typeof storage) => Promise<T>): Promise<T> => {
      const before = queue
      let release!: () => void
      queue = new Promise<void>(resolve => { release = resolve })
      await before
      try { return await callback(storage) } finally { release() }
    },
  }
  let instance = new MachineDirectory({ storage })
  let allocated = 0
  let allowRequests = true
  let allowPublish = true
  const env: DirectoryEnvironment = {
    HOSTS: { idFromName: id => id, get: () => {
      allocated++
      return { fetch: req => instance.fetch(req) }
    } },
    REQUEST_LIMIT: { limit: async () => ({ success: allowRequests }) },
    PUBLISH_LIMIT: { limit: async () => ({ success: allowPublish }) },
  }
  return { env, data, fetch: (req: Request) => worker.fetch(req, env), get allocated() { return allocated },
    restart: () => { instance = new MachineDirectory({ storage }) },
    blockRequests: () => { allowRequests = false }, blockPublish: () => { allowPublish = false },
  }
}

describe('signed remote directory', () => {
  test('publishes and returns only signed public metadata, surviving object restart', async () => {
    const app = setup()
    const value = signed()
    expect((await app.fetch(request({ ...value, cookie: 'secret', transcript: 'private' }))).status).toBe(201)
    app.restart()
    const response = await app.fetch(request())
    expect(await response.json()).toEqual(value)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(app.data.size).toBe(1)
  })

  test('allows identical retry and rejects sequence rollback, including after expiry', async () => {
    const app = setup()
    const now = Date.now()
    Date.now = () => now
    const old = signed(20)
    expect((await app.fetch(request(old))).status).toBe(201)
    expect((await app.fetch(request(old))).status).toBe(200)
    expect((await app.fetch(request(signed(19)))).status).toBe(409)
    expect((await app.fetch(request(signed(20, { origin: 'https://other.example' })))).status).toBe(409)
    Date.now = () => now + 600_001
    const offline = await app.fetch(request())
    expect(offline.status).toBe(410)
    expect(await offline.text()).not.toContain('computer.example')
    expect((await app.fetch(request(signed(1)))).status).toBe(409)
    expect((await app.fetch(request(signed(21, { origin: 'https://new.example' })))).status).toBe(200)
  })

  test('serializes simultaneous changes and retains the highest signed sequence', async () => {
    const app = setup()
    await Promise.all([3, 1, 4, 2, 5].map(n => app.fetch(request(signed(n)))))
    expect((await (await app.fetch(request())).json()).sequence).toBe(5)
  })

  test('rejects unsigned, forged, wrong-key and oversized requests before allocation', async () => {
    const app = setup()
    const good = signed()
    for (const value of [{}, { ...good, origin: 'https://attacker.example' }, { ...good, hostId: 'a'.repeat(64) }, { ...good, expiresAt: 1 }, { ...good, publicKey: 'bad' }, { ...good, padding: 'x'.repeat(4096) }]) {
      expect((await app.fetch(request(value))).status).toBe(400)
    }
    expect((await app.fetch(request(good, { headers: { 'content-type': 'text/plain' } }))).status).toBe(400)
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(4097)))
      controller.close()
    } })
    expect((await app.fetch(request(undefined, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: stream }))).status).toBe(400)
    expect(app.allocated).toBe(0)
  })

  test('enforces both rate limits and fails closed if a binding is absent', async () => {
    const app = setup()
    app.blockPublish()
    expect((await app.fetch(request(signed()))).status).toBe(429)
    app.blockRequests()
    expect((await app.fetch(request())).status).toBe(429)
    expect(app.allocated).toBe(0)
    expect((await worker.fetch(request(), {} as DirectoryEnvironment)).status).toBe(503)
  })

  test('exposes health and strict routes without fetching an announced endpoint', async () => {
    const app = setup()
    expect(await (await app.fetch(new Request('https://directory.example/health'))).json()).toEqual({ service: 'cc-haha-remote-directory', protocolVersion: 2 })
    expect((await app.fetch(request())).status).toBe(404)
    for (const path of ['/v1/hosts', `/v1/hosts/${fixture.hostId}?token=secret`, `/v1/hosts/${fixture.hostId}/`]) expect((await app.fetch(new Request(`https://directory.example${path}`))).status).toBe(404)
    expect((await app.fetch(request(undefined, { method: 'DELETE' }))).status).toBe(405)
    expect((await app.fetch(new Request(`http://directory.example/v1/hosts/${fixture.hostId}`))).status).toBe(400)
  })
})
