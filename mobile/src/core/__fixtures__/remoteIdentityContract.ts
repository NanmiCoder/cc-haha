import assert from 'node:assert/strict'
import { join } from 'node:path'
import { ApiClient } from '../client'
import { connectHost } from '../connectHost'
import { recoverRemoteConnection, remoteKeyAlias } from '../remoteIdentity'
import { fixtureIdentityKeys } from './remoteIdentityKeys'
import type { Host } from '../types'

// Only a disposable HOME provided by the parent test may own this service.
assert.equal(process.env.HOME, process.env.MOBILE_IDENTITY_SANDBOX)
process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-local-only'
// Dynamic test-only import keeps desktop runtime types out of the Expo compile graph.
const { PublicAccessServer } = await import(new URL('../../../../src/server/publicAccess.ts', import.meta.url).href)
const now = 1_000_000
let origin = 'https://first.fixture.invalid'
const directory = 'https://directory.fixture.invalid'
const keys = fixtureIdentityKeys()
const make = () => new PublicAccessServer({
  storePath: join(process.env.HOME!, 'device-store.json'), now: () => now, serverPort: () => 3456,
  handleApiRequest: async () => Response.json({ ok: true }), handleStatic: async () => null,
  websocket: { message() {} },
})
let service = make()
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(url.hostname, '127.0.0.1', 'No public network in mobile identity contract')
  return realFetch(input, init)
}) as typeof fetch
const control = async (route: string, body?: unknown): Promise<Record<string, any>> => {
  const response = await service.control(new Request(`http://localhost/api/public-access/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer fixture-local-only' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  assert.equal(response.status, 200)
  return await response.json() as Record<string, any>
}
const trace: { origin: string; path: string; credential?: string; body?: any }[] = []
let announcement: Record<string, any>
let corruptProof = false
let corruptToken = false
const client = (host: Host, credential: string) => new ApiClient(host, credential, { fetch: async (input, init) => {
  const url = new URL(input)
  assert.equal(init.redirect, 'error')
  assert.equal(init.credentials, 'omit')
  trace.push({ origin: url.origin, path: url.pathname, credential: init.headers.Authorization,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
  if (url.origin === directory) {
    assert.equal(init.headers.Authorization, undefined)
    return { ok: true, status: 200, url: input, redirected: false, text: async () => JSON.stringify(announcement) }
  }
  if (url.origin !== origin) throw new Error('Fixture endpoint offline')
  const response = await fetch(`http://127.0.0.1:${service.status().port}${url.pathname}`, init)
  const value = await response.json() as Record<string, any>
  if (url.pathname.endsWith('/native/challenge') && corruptProof) value.signature = 'A'.repeat(342)
  if (url.pathname.endsWith('/native/session')) {
    assert.equal(response.headers.get('set-cookie'), null)
    if (corruptToken && value.token) value.token = `native_${'A'.repeat(43)}`
  }
  return { ok: response.ok, status: response.status, url: input, redirected: false, text: async () => JSON.stringify(value) }
} })
const signal = new AbortController().signal
try {
  service.enable(origin)
  await control('native/configure', { directoryUrl: directory })
  const pair = await control('pairing', {})
  const value = `${origin}/remote#${new URLSearchParams({ pair: pair.secret, v: '2', hostKey: pair.nativeBinding.publicKey, directory })}`
  const input = { value, token: '', name: 'Fixture', id: 'fixture-phone', platform: 'android', signal, onStatus() {} }
  corruptProof = true
  await assert.rejects(connectHost(input, { client, identityKeys: keys, now: () => now }), error => (error as any).code === 'IDENTITY_FAILED')
  assert.equal(trace.some(item => item.path.endsWith('/pair')), false, 'No pairing secret before host proof')
  corruptProof = false
  const connected = await connectHost(input, { client, identityKeys: keys, now: () => now, wait: async () => {
    const pending = service.status().pending[0]
    assert.ok(pending)
    await control('approve', { id: pending.id })
  } })
  assert.ok(connected.host.remoteIdentity)
  assert.ok(connected.credential.startsWith('native_'))
  assert.equal(JSON.stringify(connected.host).includes(pair.secret), false)
  const stable = await recoverRemoteConnection(connected.host, connected.credential, { client, keys, signal, now: () => now })
  assert.equal(stable.credential, connected.credential, 'Healthy sessions must not rotate on every screen refresh')
  const oldAnnouncement = await control('native/announcement', {})
  service.disable()
  service = make()
  origin = 'https://second.fixture.invalid'
  service.enable(origin)
  announcement = await control('native/announcement', {})
  const changedAt = trace.length
  const renewed = await recoverRemoteConnection(connected.host, connected.credential, { client, keys, signal, now: () => now })
  assert.equal(renewed.host.url, origin)
  assert.equal(renewed.host.remoteIdentity!.sequence, announcement.sequence)
  assert.notEqual(renewed.credential, connected.credential)
  assert.equal(trace.slice(changedAt).some(item => item.origin !== connected.host.url && item.credential?.includes(connected.credential)), false)
  await client(renewed.host, renewed.credential).verify()
  service.setOrigin('https://third.fixture.invalid')
  origin = 'https://third.fixture.invalid'
  announcement = { ...oldAnnouncement }
  await assert.rejects(recoverRemoteConnection(renewed.host, renewed.credential, { client, keys, signal, now: () => now }), error => (error as any).code === 'IDENTITY_FAILED')
  announcement = await control('native/announcement', {})
  const correctAnnouncement = { ...announcement }
  announcement = { ...announcement, origin: 'https://attacker.fixture.invalid' }
  await assert.rejects(recoverRemoteConnection(renewed.host, renewed.credential, { client, keys, signal, now: () => now }), error => (error as any).code === 'IDENTITY_FAILED')
  assert.equal(trace.some(item => item.origin === announcement.origin), false)
  announcement = correctAnnouncement
  corruptToken = true
  await assert.rejects(recoverRemoteConnection(renewed.host, renewed.credential, { client, keys, signal, now: () => now }), error => (error as any).code === 'IDENTITY_FAILED')
  corruptToken = false
  const final = await recoverRemoteConnection(renewed.host, renewed.credential, { client, keys, signal, now: () => now })
  await control('revoke', { id: final.host.remoteIdentity!.deviceId })
  await assert.rejects(recoverRemoteConnection(final.host, final.credential, { client, keys, signal, now: () => now }), error => (error as any).code === 'PAIRING_REQUIRED')
  await keys.remove(remoteKeyAlias(final.host.id))
  await assert.rejects(recoverRemoteConnection(final.host, final.credential, { client, keys, signal, now: () => now }), error => (error as any).code === 'PAIRING_REQUIRED')
  process.stdout.write('mobile identity production contract passed\n')
} finally {
  service.disable()
}
