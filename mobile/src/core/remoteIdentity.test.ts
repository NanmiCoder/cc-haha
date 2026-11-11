import { expect, test } from 'bun:test'
import { parseConnectionInput } from './connection'
import { connectHost } from './connectHost'
import { ApiClient } from './client'
import { fixtureIdentityKeys } from './__fixtures__/remoteIdentityKeys'
import type { Host } from './types'

test('v2 QR accepts only complete, unique HTTPS trust anchors and keeps the ordinary QR contract', async () => {
  const keys = fixtureIdentityKeys()
  const hostKey = await keys.ensurePublicKey('fixture')
  const fields = new URLSearchParams({ pair: 'fixture-pair-value', v: '2', hostKey, directory: 'https://directory.fixture.invalid' })
  const address = `https://computer.fixture.invalid/remote/#${fields}`
  expect(parseConnectionInput(address)).toEqual({ url: 'https://computer.fixture.invalid', auth: 'remote', pairSecret: 'fixture-pair-value',
    remoteBinding: { hostKey, directory: 'https://directory.fixture.invalid' } })
  for (const invalid of [`${address}&v=2`, `${address}&unknown=x`, address.replace('v=2', 'v=3'), address.replace('https%3A%2F%2Fdirectory', 'http%3A%2F%2Fdirectory'), address.replace(/&hostKey=[^&]+/, '')]) {
    expect(() => parseConnectionInput(invalid)).toThrow()
  }
  expect(parseConnectionInput('https://computer.fixture.invalid/remote#pair=fixture-pair-value').remoteBinding).toBeUndefined()
})

test('iOS and missing native modules fail before sending a v2 pairing secret; ordinary paths remain available', async () => {
  const keys = fixtureIdentityKeys()
  const hostKey = await keys.ensurePublicKey('fixture')
  let requests = 0
  const client = (host: Host, credential: string) => new ApiClient(host, credential, {
    fetch: async () => { requests++; throw new Error('Unexpected request') },
  })
  const value = `https://computer.fixture.invalid/remote#${new URLSearchParams({ pair: 'fixture-pair-value', v: '2', hostKey, directory: 'https://directory.fixture.invalid' })}`
  const input = { value, token: '', name: 'Fixture', id: 'fixture', platform: 'ios', signal: new AbortController().signal, onStatus() {} }
  await expect(connectHost(input, { client, identityKeys: keys })).rejects.toThrow('Android')
  await expect(connectHost({ ...input, platform: 'android' }, { client })).rejects.toThrow('Android')
  expect(requests).toBe(0)
})
