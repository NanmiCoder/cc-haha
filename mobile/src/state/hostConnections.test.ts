import { expect, test } from 'bun:test'
import { HostConnections } from './hostConnections'
import { HostRepository, type Storage } from './storage'
import { ApiClient } from '../core/client'
import { fixtureIdentityKeys } from '../core/__fixtures__/remoteIdentityKeys'
import { remoteKeyAlias } from '../core/remoteIdentity'
import type { Host } from '../core/types'

const memory = (): Storage => {
  const values = new Map<string, string>()
  return { getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value) }, removeItem: async key => { values.delete(key) } }
}
async function fixture() {
  const keys = fixtureIdentityKeys()
  const hostKey = await keys.ensurePublicKey('server-fixture')
  const hostId = await keys.hostId(hostKey)
  const host: Host = { id: 'phone', name: 'Fixture', url: 'https://computer.fixture.invalid', auth: 'remote',
    remoteIdentity: { hostId, hostKey, directory: 'https://directory.fixture.invalid', sequence: 0, deviceId: 'device-fixture' } }
  await keys.ensurePublicKey(remoteKeyAlias(host.id))
  const repository = new HostRepository(memory(), memory())
  await repository.add(host, 'expired-fixture-token')
  let renewals = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const client = (value: Host, credential: string) => new ApiClient(value, credential, { fetch: async (input, init) => {
    const path = new URL(input).pathname
    const request = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    let body: Record<string, unknown>
    if (path.endsWith('/native/challenge')) {
      const challenge = await keys.nonce()
      const expiresAt = 61_000
      body = { version: 2, hostId, publicKey: hostKey, origin: host.url, nonce: request.nonce, challenge, expiresAt,
        signature: await keys.sign('server-fixture', 'host-proof', [hostId, host.url, request.nonce, challenge, String(expiresAt)]) }
    } else if (path.endsWith('/native/session')) {
      renewals++
      await barrier
      const token = `native_${'a'.repeat(43)}`
      const tokenHash = await keys.hashText(token)
      body = { version: 2, hostId, origin: host.url, deviceId: 'device-fixture', nonce: request.nonce, token, tokenHash,
        tokenType: 'Bearer', expiresAt: 200_000, signature: await keys.sign('server-fixture', 'session', [hostId, host.url, 'device-fixture', request.nonce, tokenHash, '200000']) }
    } else body = { authenticated: false }
    return { ok: true, status: 200, url: input, redirected: false, text: async () => JSON.stringify(body) }
  } })
  return { host, repository, manager: new HostConnections(repository, client, keys, () => 1000), release, renewals: () => renewals }
}
test('simultaneous screens share one token renewal and subsequent reads retain the same native session', async () => {
  const f = await fixture()
  const first = f.manager.resolve(f.host.id)
  const second = f.manager.resolve(f.host.id)
  expect(first).toBe(second)
  f.release()
  const a = await first
  expect((await second).credential).toBe(a.credential)
  expect(await f.repository.credential(f.host.id)).toBe(a.credential)
  expect((await f.manager.resolve(f.host.id)).credential).toBe(a.credential)
  expect(f.renewals()).toBe(1)
})
test('removing a host while renewal is pending cancels recovery without recreating its credentials', async () => {
  const f = await fixture()
  const pending = f.manager.resolve(f.host.id)
  f.manager.forget(f.host.id)
  await f.repository.remove(f.host.id)
  f.release()
  await expect(pending).rejects.toThrow()
  expect((await f.repository.load()).hosts).toEqual([])
  expect(await f.repository.credential(f.host.id)).toBeNull()
  await expect(f.manager.resolve(f.host.id)).rejects.toThrow('主机已移除')
})
