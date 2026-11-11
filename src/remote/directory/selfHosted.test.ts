import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createPrivateKey, sign } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from '../../shared/__fixtures__/remote-identity-v2.json'
import { announcementBytes } from '../../shared/remoteIdentityProtocol'
import { createSelfHostedDirectory, parseSelfHostedConfig } from './selfHosted'

const privateKey = createPrivateKey({ key: Buffer.from(fixture.privateKeyPkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function signed(sequence = 1, overrides = {}) {
  const value = { version: 2, hostId: fixture.hostId, publicKey: fixture.publicKey, origin: 'https://computer.example', sequence, expiresAt: Date.now() + 600_000, ...overrides }
  return { ...value, signature: sign('sha256', announcementBytes(value), privateKey).toString('base64url') }
}

function request(body?: unknown, hostId = fixture.hostId, options: RequestInit = {}) {
  return new Request(`http://127.0.0.1:8788/v1/hosts/${hostId}`, body === undefined ? options : {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options,
  })
}

function setup(options: Partial<Parameters<typeof createSelfHostedDirectory>[0]> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cc-haha-self-hosted-test-'))
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
  const config = { stateDir, allowedHostIds: [fixture.hostId], ...options }
  let app = createSelfHostedDirectory(config)
  cleanups.push(() => app.close())
  return {
    stateDir,
    fetch: (value: Request) => app.fetch(value),
    restart: () => {
      app.close()
      app = createSelfHostedDirectory(config)
    },
  }
}

describe('private self-hosted remote discovery', () => {
  test('requires an explicit absolute state path and a valid nonempty identity allowlist', () => {
    const env = { CC_HAHA_DIRECTORY_STATE_DIR: '/tmp/directory', CC_HAHA_DIRECTORY_ALLOWED_HOST_IDS: fixture.hostId }
    expect(parseSelfHostedConfig(env)).toEqual({ stateDir: '/tmp/directory', allowedHostIds: [fixture.hostId], port: 8788 })
    expect(parseSelfHostedConfig({ ...env, CC_HAHA_DIRECTORY_PORT: '8800' }).port).toBe(8800)
    for (const bad of ['', ' ', '*', 'A'.repeat(64), `${fixture.hostId},invalid`]) {
      expect(() => parseSelfHostedConfig({ ...env, CC_HAHA_DIRECTORY_ALLOWED_HOST_IDS: bad })).toThrow('allowed')
    }
    expect(() => parseSelfHostedConfig({})).toThrow()
    expect(() => parseSelfHostedConfig({ ...env, CC_HAHA_DIRECTORY_STATE_DIR: './state' })).toThrow('absolute')
    for (const port of ['0', '65536', '8788oops', '1.5']) expect(() => parseSelfHostedConfig({ ...env, CC_HAHA_DIRECTORY_PORT: port })).toThrow('port')
    expect(() => createSelfHostedDirectory({ stateDir: '/tmp/not-created-directory', allowedHostIds: [] })).toThrow('allowed')
  })

  test('denies other identities for both reads and writes before reading their body', async () => {
    const app = setup()
    const other = 'a'.repeat(64)
    expect((await app.fetch(request(undefined, other))).status).toBe(403)
    expect((await app.fetch(request(signed(), other))).status).toBe(403)
    const blocked = await app.fetch(request(signed(), other))
    expect(await blocked.text()).not.toContain(fixture.hostId)
    expect((await app.fetch(request())).status).toBe(404)
  })

  test('persists only signed public metadata across a SQLite reopen', async () => {
    const app = setup()
    const record = signed()
    expect((await app.fetch(request({ ...record, token: 'never-store', transcript: 'never-store' }))).status).toBe(201)
    app.restart()
    const response = await app.fetch(request())
    expect(await response.json()).toEqual(record)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(statSync(join(app.stateDir, 'directory.sqlite')).mode & 0o777).toBe(0o600)
    expect(statSync(app.stateDir).mode & 0o777).toBe(0o700)
  })

  test('keeps the sequence tombstone across expiry and restart and permits identical retries', async () => {
    let now = Date.now()
    const app = setup({ now: () => now })
    const record = signed(20, { expiresAt: now + 1000 })
    expect((await app.fetch(request(record))).status).toBe(201)
    expect((await app.fetch(request(record))).status).toBe(200)
    expect((await app.fetch(request(signed(19)))).status).toBe(409)
    expect((await app.fetch(request(signed(20, { origin: 'https://other.example' })))).status).toBe(409)
    now += 1001
    app.restart()
    const expired = await app.fetch(request())
    expect(expired.status).toBe(410)
    expect(await expired.text()).not.toContain('computer.example')
    expect((await app.fetch(request(signed(1)))).status).toBe(409)
    expect((await app.fetch(request(signed(21)))).status).toBe(200)
  })

  test('serializes concurrent valid publications and does not lose the largest sequence', async () => {
    const app = setup()
    await Promise.all([3, 1, 4, 2, 5].map(sequence => app.fetch(request(signed(sequence)))))
    expect((await (await app.fetch(request())).json()).sequence).toBe(5)
  })

  test('verifies signatures and refuses malformed, expired, oversized and non-JSON bodies', async () => {
    const app = setup()
    const good = signed()
    for (const body of [{}, { ...good, origin: 'https://attacker.example' }, { ...good, publicKey: 'bad' }, { ...good, hostId: 'a'.repeat(64) }, signed(1, { expiresAt: 1 }), { ...good, padding: 'x'.repeat(4096) }]) {
      expect((await app.fetch(request(body))).status).toBe(400)
    }
    expect((await app.fetch(request(good, fixture.hostId, { headers: { 'content-type': 'text/plain' } }))).status).toBe(400)
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(4097))
      controller.close()
    } })
    expect((await app.fetch(request(undefined, fixture.hostId, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: stream }))).status).toBe(400)
    expect((await app.fetch(request())).status).toBe(404)
  })

  test('ends a stalled request body without hanging the service', async () => {
    const app = setup({ bodyTimeoutMs: 5 })
    let cancelled = false
    const stream = new ReadableStream({ cancel() { cancelled = true } })
    expect((await app.fetch(request(undefined, fixture.hostId, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: stream }))).status).toBe(400)
    expect(cancelled).toBe(true)
  })

  test('limits invalid uploads before verification and limits global request volume without IP headers', async () => {
    let now = Date.now()
    const app = setup({ now: () => now, requestLimit: 5, publishLimit: 2 })
    expect((await app.fetch(request({}))).status).toBe(400)
    expect((await app.fetch(request({}))).status).toBe(400)
    expect((await app.fetch(request(signed()))).status).toBe(429)
    expect((await app.fetch(request())).status).toBe(404)
    expect((await app.fetch(request())).status).toBe(404)
    const limited = await app.fetch(request(undefined, fixture.hostId, { headers: { 'x-forwarded-for': 'new-ip', 'cf-connecting-ip': 'new-ip' } }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    now += 60_001
    expect((await app.fetch(request(signed()))).status).toBe(201)
  })

  test('exposes strict API routes only and never redirects or accepts browser preflight', async () => {
    const app = setup()
    const health = await app.fetch(new Request('http://127.0.0.1/health'))
    expect(await health.json()).toEqual({ service: 'cc-haha-remote-directory', protocolVersion: 2, access: 'private' })
    for (const suffix of ['?token=secret', '/', '/../../anything']) expect((await app.fetch(new Request(`http://127.0.0.1/v1/hosts/${fixture.hostId}${suffix}`))).status).toBe(404)
    expect((await app.fetch(request(undefined, fixture.hostId, { method: 'OPTIONS' }))).status).toBe(405)
  })

  test('creates schema version one from an empty SQLite file without resetting future versions', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-haha-self-hosted-migration-'))
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
    const path = join(stateDir, 'directory.sqlite')
    new Database(path).close()
    createSelfHostedDirectory({ stateDir, allowedHostIds: [fixture.hostId] }).close()
    const db = new Database(path)
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    db.exec('PRAGMA user_version = 99')
    db.close()
    expect(() => createSelfHostedDirectory({ stateDir, allowedHostIds: [fixture.hostId] })).toThrow('schema')
    const preserved = new Database(path)
    expect(preserved.query('PRAGMA user_version').get()).toEqual({ user_version: 99 })
    preserved.close()
  })
})
