import { expect, test } from 'bun:test'
import {
  H5_HOST_ID,
  H5_SERVER_URL_STORAGE_KEY,
  H5_TOKEN_STORAGE_KEY,
  h5CredentialValue,
  resolveH5Session,
  storedH5Token,
} from './h5Session'
import { buildSocketOptions, normalizeHostUrl } from './connection'
import { ApiClient } from './client'

const lan = { origin: 'http://192.168.1.8:3456', hostname: '192.168.1.8' }
const tunnel = { origin: 'https://quiet-lake.trycloudflare.com', hostname: 'quiet-lake.trycloudflare.com' }
const loopback = { origin: 'http://127.0.0.1:3456', hostname: '127.0.0.1' }

function storage(values: Record<string, string>) {
  return { getItem: (key: string) => values[key] ?? null }
}
function probe(status: number, body: unknown = {}) {
  const calls: { url: string; init: unknown }[] = []
  const fetch = async (url: string, init: unknown) => {
    calls.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { fetch, calls }
}
const desktopToken = (origin: string, token = 'h5_token_from_desktop') =>
  storage({ [H5_SERVER_URL_STORAGE_KEY]: origin, [H5_TOKEN_STORAGE_KEY]: token })

test('a LAN page uses the token the desktop entry verified for this address, without a request', async () => {
  const { fetch, calls } = probe(500)
  const result = await resolveH5Session({ location: lan, storage: desktopToken(`${lan.origin}/`), fetch })
  if (!('host' in result)) throw new Error('expected a connection')
  expect(result.host).toEqual({ id: H5_HOST_ID, name: '这台电脑', url: lan.origin, auth: 'lan', page: true })
  expect(h5CredentialValue(result.credential)).toBe('h5_token_from_desktop')
  expect(calls).toHaveLength(0)
})

test('a token paired with another server is never sent to this one', () => {
  expect(storedH5Token(lan, desktopToken('http://192.168.1.9:3456'))).toBeNull()
  expect(storedH5Token(lan, desktopToken(lan.origin, 'bad token'))).toBeNull()
  expect(storedH5Token(lan, null)).toBeNull()
  const throwing = { getItem: () => { throw new Error('denied') } }
  expect(storedH5Token(lan, throwing)).toBeNull()
})

test('a remote browser is authenticated by its device cookie on the gateway', async () => {
  const { fetch, calls } = probe(200, { authenticated: true, expiresAt: 1 })
  const result = await resolveH5Session({ location: tunnel, storage: storage({}), fetch })
  if (!('host' in result)) throw new Error('expected a connection')
  expect(result.host.auth).toBe('remote')
  expect(h5CredentialValue(result.credential)).toBe('')
  // Only a same-origin request carries the HttpOnly cookie.
  expect(calls[0]).toEqual({
    url: `${tunnel.origin}/api/public-access/session`,
    init: { credentials: 'same-origin', redirect: 'error', signal: undefined },
  })
  // The socket then goes out with no token: the cookie authenticates it.
  expect(buildSocketOptions(result.host, '', 'session-1', 'web').url).toBe(
    'wss://quiet-lake.trycloudflare.com/ws/session-1?media=ref'
  )
})

test('an unpaired remote browser goes back to remote pairing, a LAN page without a token to the token page', async () => {
  expect(await resolveH5Session({ location: tunnel, storage: storage({}), fetch: probe(200, { authenticated: false }).fetch }))
    .toEqual({ entry: `${tunnel.origin}/remote` })
  // The main server refuses the gateway's session route to browsers.
  expect(await resolveH5Session({ location: lan, storage: storage({}), fetch: probe(403).fetch }))
    .toEqual({ entry: `${lan.origin}/?reconnect=1` })
  expect(await resolveH5Session({
    location: lan,
    storage: storage({}),
    fetch: async () => { throw new TypeError('offline') },
  })).toEqual({ entry: `${lan.origin}/?reconnect=1` })
})

test('a LAN H5 reached over Tailscale or a bare host name still connects over plain http', async () => {
  // The native app refuses http to public-looking hosts; the page was loaded from this origin anyway.
  for (const location of [
    { origin: 'http://100.101.102.103:3456', hostname: '100.101.102.103' },
    { origin: 'http://nas:3456', hostname: 'nas' },
  ]) {
    expect(() => normalizeHostUrl(location.origin, 'lan')).toThrow('HTTPS')
    const result = await resolveH5Session({ location, storage: desktopToken(location.origin), fetch: probe(403).fetch })
    if (!('host' in result)) throw new Error('expected a connection')
    const client = new ApiClient(result.host, h5CredentialValue(result.credential), { fetch: async () => { throw new Error('unused') } })
    expect(client.host.url).toBe(location.origin)
    expect(buildSocketOptions(result.host, 'h5_token_from_desktop', 'session-1', 'web').url).toBe(
      `ws://${location.origin.slice('http://'.length)}/ws/session-1?media=ref&token=h5_token_from_desktop`
    )
  }
})

test('a page opened on the computer itself is trusted by its loopback address', async () => {
  const result = await resolveH5Session({ location: loopback, storage: storage({}), fetch: probe(403).fetch })
  if (!('host' in result)) throw new Error('expected a connection')
  expect(result.host).toMatchObject({ url: loopback.origin, auth: 'lan' })
  expect(h5CredentialValue(result.credential)).toBe('')
})
