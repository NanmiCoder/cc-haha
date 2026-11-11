import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { constants, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PublicAccessServer, migratePublicAccessStore } from './publicAccess.js'
import { validateRemoteAnnouncement, verifyRemoteSignature, remoteCanonical } from '../shared/remoteIdentityProtocol.js'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const keys = () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  return { ...pair, encoded: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
}
const phone = keys()
const otherPhone = keys()
const nonce = () => randomBytes(32).toString('base64url')
// Independent wire construction: catches delimiter, field order and RSA padding drift.
const bytes = (purpose: string, fields: unknown[]) => Buffer.from(['cc-haha-remote-v2', purpose, ...fields].join('\n'))
const signed = (purpose: string, fields: unknown[], key = phone) => sign('sha256', bytes(purpose, fields), { key: key.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url')

function fixture(old?: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-native-test-'))
  const storePath = path.join(dir, 'devices.json')
  if (old) writeFileSync(storePath, JSON.stringify(old))
  const oldToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-native-desktop-token'
  let now = 1000
  let origin = 'https://first.trycloudflare.com'
  const make = () => new PublicAccessServer({ storePath, now: () => now, serverPort: () => 3456,
    handleApiRequest: async () => Response.json({ ok: true }), handleStatic: async () => null, websocket: { message() {} },
  })
  let service = make()
  service.enable(origin)
  cleanups.push(() => {
    service.disable()
    if (oldToken === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = oldToken
    rmSync(dir, { recursive: true, force: true })
  })
  const control = (route: string, body?: unknown) => service.control(new Request(`http://localhost/api/public-access/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer fixture-native-desktop-token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const remote = (route: string, body?: unknown, cookie?: string, bearer?: string) => fetch(`http://127.0.0.1:${service.status().port}/api/public-access/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const identity = async () => {
    const response = await control('native/identity')
    expect(response.status).toBe(200)
    return response.json() as Promise<any>
  }
  const pair = async () => {
    const code = await (await control('pairing', {})).json() as any
    const pending = await (await remote('pair', { secret: code.secret, name: 'Native fixture' })).json() as any
    await control('approve', { id: pending.id })
    const claimed = await remote('claim', pending)
    return { deviceId: pending.id, cookie: claimed.headers.get('set-cookie')!.split(';')[0]! }
  }
  const pairNative = async () => {
    const code = await (await control('pairing', {})).json() as any
    const pending = await (await remote('pair', { secret: code.secret, name: 'Expo fixture', clientType: 'native' })).json() as any
    await control('approve', { id: pending.id })
    const response = await remote('claim', pending)
    expect(response.headers.get('set-cookie')).toBeNull()
    const claim = await response.json() as any
    expect(claim).toMatchObject({ tokenType: 'Bearer', deviceId: pending.id })
    expect(claim.token).toMatch(/^native_[A-Za-z0-9_-]{43}$/)
    return claim as { deviceId: string, token: string, expiresAt: number }
  }
  const enroll = async (cookie: string, key = phone, bearer?: string) => {
    const id = await identity()
    const value = nonce()
    return remote('native/enroll', { devicePublicKey: key.encoded, nonce: value,
      signature: signed('enroll', [id.hostId, origin, key.encoded, value], key) }, cookie, bearer)
  }
  const challenge = async () => {
    const id = await identity()
    const response = await remote('native/challenge', { hostId: id.hostId, nonce: nonce() })
    expect(response.status).toBe(200)
    return response.json() as Promise<any>
  }
  const resumeBody = (c: any, deviceId: string, key = phone) => ({ hostId: c.hostId, deviceId, nonce: c.nonce,
    challenge: c.challenge, expiresAt: c.expiresAt,
    signature: signed('resume', [c.hostId, origin, deviceId, c.nonce, c.challenge, String(c.expiresAt)], key),
  })
  return { dir, storePath, identity, control, remote, pair, pairNative, enroll, challenge, resumeBody,
    service: () => service, origin: () => origin, now: () => now, advance: (ms: number) => { now += ms },
    changeOrigin: (next: string) => { service.setOrigin(next); origin = next },
    restart: (next = origin) => { service.disable(); service = make(); origin = next; service.enable(next) },
  }
}

describe('persistent native remote binding', () => {
  test('frozen v2 cookie and persistent grants coexist with upstream native pairing without resetting the store', async () => {
    const origin = 'https://first.trycloudflare.com'
    const cookieToken = 'frozen-legacy-cookie'
    const cookieDevice = { id: 'legacy-cookie', name: 'Legacy browser', createdAt: 10, expiresAt: 1_000_000,
      tokenHash: createHash('sha256').update(cookieToken).digest('hex'), origin, futureDevice: { kept: true } }
    const grant = { id: 'legacy-persistent-phone', name: 'Legacy phone', createdAt: 20, expiresAt: 0,
      tokenHash: '', origin: null, nativePublicKey: phone.encoded, futureGrant: 'retained' }
    const frozen = { version: 2, origin, devices: [cookieDevice, grant], futureRoot: { kept: true } }
    expect(migratePublicAccessStore(frozen)).toEqual(frozen)
    const f = fixture(frozen)
    const cookie = `__Host-haha-remote=${cookieToken}`
    expect(await (await f.remote('session', undefined, cookie)).json()).toMatchObject({ authenticated: true })
    const native = await f.pairNative()
    expect(await (await f.remote('session', undefined, undefined, native.token)).json()).toMatchObject({ authenticated: true })
    const stored = JSON.parse(readFileSync(f.storePath, 'utf8'))
    expect(stored).toMatchObject({ version: 2, origin, futureRoot: frozen.futureRoot })
    expect(stored.devices.slice(0, 2)).toEqual(frozen.devices)
    expect(stored.devices).toHaveLength(3)
    expect(readFileSync(f.storePath, 'utf8')).not.toContain(native.token)
    f.restart()
    expect(await (await f.remote('session', undefined, cookie)).json()).toMatchObject({ authenticated: true })
    expect(await (await f.remote('session', undefined, undefined, native.token)).json()).toMatchObject({ authenticated: true })
    const proof = await f.challenge()
    const resumed = await f.remote('native/session', f.resumeBody(proof, grant.id))
    expect(resumed.status).toBe(200)
    expect(resumed.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Strict')
    expect(f.service().status().devices).toHaveLength(3)
    await f.control('revoke', { id: native.deviceId })
    expect(await (await f.remote('session', undefined, undefined, native.token)).json()).toEqual({ authenticated: false })
    expect(await (await f.remote('session', undefined, cookie)).json()).toMatchObject({ authenticated: true })
  })

  test('native bearer enrollment renews a signed bearer after tunnel rotation without a cookie fallback', async () => {
    const f = fixture()
    const browser = await f.pair()
    const native = await f.pairNative()
    expect((await f.enroll('', phone, native.token)).status).toBe(200)
    expect(f.service().isDeviceActive(native.deviceId)).toBe(true)
    f.restart('https://rotated.trycloudflare.com')
    expect(f.service().isDeviceActive(native.deviceId)).toBe(false)
    expect(await (await f.remote('session', undefined, browser.cookie)).json()).toEqual({ authenticated: false })
    expect(await (await f.remote('session', undefined, undefined, native.token)).json()).toEqual({ authenticated: false })
    const c = await f.challenge()
    const body = { ...f.resumeBody(c, native.deviceId), clientType: 'native' }
    const response = await f.remote('native/session', body)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    const renewed = await response.json() as any
    expect(renewed.token).toMatch(/^native_[A-Za-z0-9_-]{43}$/)
    expect(renewed.tokenType).toBe('Bearer')
    expect(renewed.tokenHash).toBe(createHash('sha256').update(renewed.token).digest('hex'))
    expect(await verifyRemoteSignature(c.publicKey, renewed.signature,
      bytes('session', [c.hostId, f.origin(), native.deviceId, c.nonce, renewed.tokenHash, String(renewed.expiresAt)]))).toBe(true)
    expect((await f.remote('native/session', body)).status).toBe(401)
    expect(await (await f.remote('session', undefined, `__Host-haha-remote=${renewed.token}`)).json()).toEqual({ authenticated: false })
    expect(f.service().isDeviceActive(native.deviceId)).toBe(true)
    f.restart()
    expect(await (await f.remote('session', undefined, undefined, renewed.token)).json()).toMatchObject({ authenticated: true })
    const ws = new WebSocket(`ws://127.0.0.1:${f.service().status().port}/ws/fixture`, { headers: { Origin: f.origin(), Authorization: `Bearer ${renewed.token}` } })
    cleanups.push(() => ws.close())
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject })
    const closed = new Promise<void>(resolve => { ws.onclose = () => resolve() })
    const revokeProof = await f.challenge()
    await f.control('revoke', { id: native.deviceId })
    await closed
    expect(f.service().isDeviceActive(native.deviceId)).toBe(false)
    expect((await f.remote('native/session', { ...f.resumeBody(revokeProof, native.deviceId), clientType: 'native' })).status).toBe(401)
    expect(await (await f.remote('session', undefined, undefined, renewed.token)).json()).toEqual({ authenticated: false })
  })

  test('identity and sequence persist across restarts, private file is protected and corruption fails closed', async () => {
    const f = fixture()
    const identity = await f.identity()
    expect(identity).toMatchObject({ version: 2, directoryUrl: '' })
    expect(identity.hostId).toBe(createHash('sha256').update(Buffer.from(identity.publicKey, 'base64url')).digest('hex'))
    expect(identity.publicKey).toHaveLength(392)
    expect((await f.control('native/announcement', {})).status).toBe(409)
    expect((await f.control('native/configure', { directoryUrl: 'https://directory.example.test' })).status).toBe(200)
    const announcement = await (await f.control('native/announcement', {})).json() as any
    expect(await validateRemoteAnnouncement(announcement, f.now())).toEqual(announcement)
    expect(announcement.sequence).toBe(1)
    expect(announcement.expiresAt).toBe(f.now() + 600_000)
    const pairing = await (await f.control('pairing', {})).json() as any
    expect(pairing.nativeBinding).toEqual({ version: 2, hostId: identity.hostId, publicKey: identity.publicKey, directoryUrl: 'https://directory.example.test' })
    f.restart()
    expect(await f.identity()).toMatchObject({ ...identity, directoryUrl: 'https://directory.example.test' })
    expect((await (await f.control('native/announcement', {})).json() as any).sequence).toBe(2)
    const file = path.join(f.dir, 'public-access-identity.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(announcement)).not.toContain('privateKey')
    writeFileSync(file, '{broken')
    f.restart()
    expect((await f.control('native/identity')).status).toBe(400)
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })

  test('disabling directory removes native QR metadata without rotating identity; invalid configure preserves state', async () => {
    const f = fixture()
    const first = await f.identity()
    for (const directoryUrl of ['http://directory.test', 'https://user:secret@directory.test', 'https://directory.test/path', 'https://directory.test?token=secret']) {
      expect((await f.control('native/configure', { directoryUrl })).status).toBe(400)
    }
    await f.control('native/configure', { directoryUrl: 'https://directory.test' })
    await f.control('native/configure', { directoryUrl: '' })
    expect(await f.identity()).toEqual(first)
    expect((await (await f.control('pairing', {})).json() as any).nativeBinding).toBeUndefined()
  })

  test('host challenge has a verifiable bounded proof and no caller-selected origin', async () => {
    const f = fixture()
    const c = await f.challenge()
    expect(c).toMatchObject({ version: 2, origin: f.origin(), expiresAt: f.now() + 60_000 })
    expect(c.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await verifyRemoteSignature(c.publicKey, c.signature, bytes('host-proof', [c.hostId, c.origin, c.nonce, c.challenge, String(c.expiresAt)]))).toBe(true)
    expect((await f.remote('native/challenge', { hostId: '0'.repeat(64), nonce: nonce() })).status).toBe(401)
    expect((await f.remote('native/challenge', { hostId: c.hostId, nonce: 'bad\nnonce' })).status).toBe(400)
    for (let i = 1; i < 128; i++) expect((await f.remote('native/challenge', { hostId: c.hostId, nonce: nonce() })).status).toBe(200)
    expect((await f.remote('native/challenge', { hostId: c.hostId, nonce: nonce() })).status).toBe(429)
    f.advance(60_001)
    expect((await f.remote('native/challenge', { hostId: c.hostId, nonce: nonce() })).status).toBe(200)
  })

  test('enrollment requires an approved cookie and key proof, is idempotent, and refuses replacing its key', async () => {
    const f = fixture()
    expect((await f.enroll('')).status).toBe(401)
    const pair = await f.pair()
    const id = await f.identity()
    expect((await f.remote('native/enroll', { devicePublicKey: phone.encoded, nonce: nonce(), signature: 'invalid' }, pair.cookie)).status).toBe(401)
    const response = await f.enroll(pair.cookie)
    expect(response.status).toBe(200)
    const grant = await response.json() as any
    expect(grant).toMatchObject({ version: 2, hostId: id.hostId, origin: f.origin(), deviceId: pair.deviceId, devicePublicKey: phone.encoded })
    expect(await verifyRemoteSignature(id.publicKey, grant.signature, remoteCanonical('enrolled', [id.hostId, f.origin(), pair.deviceId, phone.encoded, grant.nonce]))).toBe(true)
    expect((await f.enroll(pair.cookie)).status).toBe(200)
    expect((await f.enroll(pair.cookie, otherPhone)).status).toBe(409)
    expect(JSON.stringify(f.service().status())).not.toContain(phone.encoded)
  })

  test('a persistent grant renews after cookie expiry and signs the exact new cookie hash', async () => {
    const f = fixture()
    const pair = await f.pair()
    expect((await f.enroll(pair.cookie)).status).toBe(200)
    f.advance(31 * 24 * 60 * 60_000)
    expect(await (await f.remote('session', undefined, pair.cookie)).json()).toEqual({ authenticated: false })
    expect(f.service().status().devices).toHaveLength(1)
    const c = await f.challenge()
    const response = await f.remote('native/session', f.resumeBody(c, pair.deviceId))
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Strict; Max-Age=86400')
    const session = await response.json() as any
    expect(session.expiresAt).toBe(f.now() + 86_400_000)
    const token = cookie.split(';')[0]!.split('=')[1]!
    expect(session.tokenHash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(await verifyRemoteSignature(c.publicKey, session.signature, bytes('session', [c.hostId, f.origin(), pair.deviceId, c.nonce, session.tokenHash, String(session.expiresAt)]))).toBe(true)
    expect(await (await f.remote('session', undefined, cookie)).json()).toMatchObject({ authenticated: true })
    expect(readFileSync(f.storePath, 'utf8')).not.toContain(token)
  })

  test('expired, replayed, mismatched and wrongly signed challenges never issue a cookie', async () => {
    const f = fixture()
    const pair = await f.pair()
    await f.enroll(pair.cookie)
    const c = await f.challenge()
    const wrong = await f.remote('native/session', f.resumeBody(c, pair.deviceId, otherPhone))
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('set-cookie')).toBeNull()
    expect((await f.remote('native/session', f.resumeBody(c, pair.deviceId))).status).toBe(401)
    const expired = await f.challenge()
    f.advance(60_001)
    expect((await f.remote('native/session', f.resumeBody(expired, pair.deviceId))).status).toBe(401)
    const fresh = await f.challenge()
    const body = f.resumeBody(fresh, pair.deviceId)
    expect((await f.remote('native/session', body)).status).toBe(200)
    expect((await f.remote('native/session', body)).status).toBe(401)
    const mismatch = await f.challenge()
    expect((await f.remote('native/session', { ...f.resumeBody(mismatch, pair.deviceId), nonce: nonce() })).status).toBe(401)
  })

  test('origin changes and restarts invalidate old cookies while keeping native grants; revoke is final', async () => {
    const f = fixture()
    const pair = await f.pair()
    await f.enroll(pair.cookie)
    const oldChallenge = await f.challenge()
    const oldBody = f.resumeBody(oldChallenge, pair.deviceId)
    const ws = new WebSocket(`ws://127.0.0.1:${f.service().status().port}/ws/fixture`, { headers: { Origin: f.origin(), Cookie: pair.cookie } })
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject })
    const closed = new Promise<void>(resolve => { ws.onclose = () => resolve() })
    f.changeOrigin('https://second.trycloudflare.com')
    await closed
    expect(await (await f.remote('session', undefined, pair.cookie)).json()).toEqual({ authenticated: false })
    expect((await f.remote('native/session', oldBody)).status).toBe(401)
    f.restart('https://third.trycloudflare.com')
    expect(f.service().status().devices).toHaveLength(1)
    const c = await f.challenge()
    const response = await f.remote('native/session', f.resumeBody(c, pair.deviceId))
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!
    f.restart()
    expect(await (await f.remote('session', undefined, cookie)).json()).toMatchObject({ authenticated: true })
    const next = await f.challenge()
    await f.control('revoke', { id: pair.deviceId })
    expect((await f.remote('native/session', f.resumeBody(next, pair.deviceId))).status).toBe(401)
    expect(await (await f.remote('session', undefined, cookie)).json()).toEqual({ authenticated: false })
  })

  test('v1 device migration preserves browser and native records without adopting originless credentials', async () => {
    const oldDevice = { id: 'legacy-device', name: 'Legacy phone', createdAt: 10, expiresAt: 9_999_999,
      tokenHash: createHash('sha256').update('old-cookie').digest('hex'), futureDevice: true }
    const nativeToken = `native_${'a'.repeat(43)}`
    const oldNative = { id: 'upstream-native-device', name: 'Upstream phone', createdAt: 20, expiresAt: 9_999_999,
      tokenHash: createHash('sha256').update(nativeToken).digest('hex'), futureNative: { retained: true } }
    const old = { version: 1, devices: [oldDevice, oldNative], futureRoot: { preserved: true } }
    expect(migratePublicAccessStore(old)).toMatchObject({ version: 2, devices: old.devices, futureRoot: old.futureRoot })
    const f = fixture(old)
    expect(await (await f.remote('session', undefined, '__Host-haha-remote=old-cookie')).json()).toEqual({ authenticated: false })
    expect(await (await f.remote('session', undefined, undefined, nativeToken)).json()).toEqual({ authenticated: false })
    expect(JSON.parse(readFileSync(f.storePath, 'utf8'))).toMatchObject({ version: 2, devices: old.devices, futureRoot: old.futureRoot })
    expect(existsSync(path.join(f.dir, 'public-access-identity.json'))).toBe(false)
  })

  test('migrates a v1 device with a recorded origin without making cookies portable', async () => {
    const origin = 'https://first.trycloudflare.com'
    const nativeToken = `native_${'a'.repeat(43)}`
    const cookieToken = 'old-cookie'
    const device = (id: string, token: string) => ({
      id, name: id, createdAt: 10, expiresAt: 9_999_999, tokenHash: createHash('sha256').update(token).digest('hex'),
    })
    const f = fixture({
      version: 1, lastPublicUrl: origin,
      devices: [device('native', nativeToken), device('browser', cookieToken)],
    })
    const cookie = `__Host-haha-remote=${cookieToken}`
    expect(await (await f.remote('session', undefined, cookie)).json()).toMatchObject({ authenticated: true })
    f.changeOrigin('https://rotated.trycloudflare.com')
    expect(await (await f.remote('session', undefined, undefined, nativeToken)).json()).toMatchObject({ authenticated: true })
    expect(await (await f.remote('session', undefined, cookie)).json()).toEqual({ authenticated: false })
    f.changeOrigin(origin)
    expect(await (await f.remote('session', undefined, cookie)).json()).toEqual({ authenticated: false })
  })

  test('parallel proofs cannot replace a grant or redeem the same challenge twice', async () => {
    const f = fixture()
    const pair = await f.pair()
    const responses = await Promise.all([f.enroll(pair.cookie), f.enroll(pair.cookie, otherPhone)])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const selectedKey = responses[0]!.status === 200 ? phone : otherPhone
    const c = await f.challenge()
    const body = f.resumeBody(c, pair.deviceId, selectedKey)
    const sessions = await Promise.all([f.remote('native/session', body), f.remote('native/session', body)])
    expect(sessions.map(response => response.status).sort()).toEqual([200, 401])
  })

  test('failed persistence cannot issue a cookie or partially revoke an existing session', async () => {
    const f = fixture()
    const pair = await f.pair()
    await f.enroll(pair.cookie)
    const c = await f.challenge()
    renameSync(f.storePath, `${f.storePath}.backup`)
    mkdirSync(f.storePath)
    const failed = await f.remote('native/session', f.resumeBody(c, pair.deviceId))
    expect(failed.status).toBe(400)
    expect(failed.headers.get('set-cookie')).toBeNull()
    expect((await f.control('revoke', { id: pair.deviceId })).status).toBe(400)
    expect(await (await f.remote('session', undefined, pair.cookie)).json()).toMatchObject({ authenticated: true })
    expect(readdirSync(f.dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  test('native endpoints retain origin and desktop-control isolation', async () => {
    const f = fixture()
    const identity = await f.identity()
    const endpoint = `http://127.0.0.1:${f.service().status().port}/api/public-access/native/`
    for (const origin of ['', 'https://attacker.test']) {
      expect((await fetch(`${endpoint}challenge`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ hostId: identity.hostId, nonce: nonce() }) })).status).toBe(403)
    }
    for (const route of ['identity', 'configure', 'announcement']) expect((await f.remote(`native/${route}`, {})).status).toBe(404)
    expect((await f.service().control(new Request('http://localhost/api/public-access/native/identity'))).status).toBe(403)
  })

  test('an in-flight proof cannot outlive an origin transition even if the hostname returns', async () => {
    const f = fixture()
    const pair = await f.pair()
    await f.enroll(pair.cookie)
    const c = await f.challenge()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const verify = crypto.subtle.verify.bind(crypto.subtle)
    const mock = spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      entered()
      await gate
      return verify(...args)
    })
    try {
      const response = f.remote('native/session', f.resumeBody(c, pair.deviceId))
      await started
      const original = f.origin()
      f.changeOrigin('https://transient.trycloudflare.com')
      f.changeOrigin(original)
      release()
      const rejected = await response
      expect(rejected.status).toBe(401)
      expect(rejected.headers.get('set-cookie')).toBeNull()
    } finally { release(); mock.mockRestore() }
  })
})
