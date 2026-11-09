import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { ApiError } from './client'
import {
  HINTS_MAX_AGE_MS,
  HINTS_RETRY_MS,
  HostRelocator,
  LOCATE_COOLDOWN_MS,
  applyHostUrlUpdate,
  isUnreachable,
  type LocatorRecord,
} from './hostRelocator'
import type { Host } from './types'

const OLD = 'https://old-tunnel.trycloudflare.com'
const NEW = 'https://new-tunnel.trycloudflare.com'
const remote: Host = { id: 'desk', name: 'Desk', url: OLD, auth: 'remote' }
const lan: Host = { id: 'lan', name: 'LAN', url: 'http://192.168.1.8:3456', auth: 'lan' }
const credential = 'native_fixture-credential'
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function setup(options: { hints?: Record<string, LocatorRecord>; found?: string | null } = {}) {
  let now = 1_000_000
  const hints = new Map(Object.entries(options.hints ?? { desk: { port: 3456, addresses: ['192.168.1.8'], updatedAt: now } }))
  const hosts = new Map<string, Host>([[remote.id, remote], [lan.id, lan]])
  const located: [LocatorRecord, string][] = []
  const relocated: [string, string][] = []
  let found = options.found === undefined ? NEW : options.found
  const relocator = new HostRelocator({
    hints: {
      get: async (id) => hints.get(id) ?? null,
      set: async (id, record) => { hints.set(id, record) },
      retain: async (ids) => { for (const id of [...hints.keys()]) if (!ids.includes(id)) hints.delete(id) },
    },
    locate: async (record, value) => {
      located.push([record as LocatorRecord, value])
      return found
    },
    now: () => now,
  })
  relocator.attach({
    host: (id) => hosts.get(id),
    credential: async (id) => (id === remote.id ? credential : 'lan-token'),
    relocate: async (id, url) => {
      relocated.push([id, url])
      hosts.set(id, { ...hosts.get(id)!, url })
    },
  })
  const locatorCalls: string[] = []
  let locatorAnswer: () => Promise<unknown> = async () => ({ port: 4567, addresses: ['10.0.0.9', 'fe80::1'] })
  const client = (host: Host = remote) => ({
    host,
    get: async <T,>(path: string) => {
      locatorCalls.push(path)
      return (await locatorAnswer()) as T
    },
  })
  return {
    relocator, hints, hosts, located, relocated, locatorCalls, client,
    advance: (ms: number) => { now += ms },
    get now() { return now },
    setFound: (value: string | null) => { found = value },
    answer: (value: () => Promise<unknown>) => { locatorAnswer = value },
  }
}

test('only network failures count as unreachable, never authorization or pairing errors', () => {
  for (const error of [
    new ApiError('x', 0, 'NETWORK_ERROR'),
    new ApiError('x', 0, 'TIMEOUT'),
    new ApiError('x', 502), new ApiError('x', 503), new ApiError('x', 504),
    new ApiError('x', 530, 'INVALID_RESPONSE'),
  ]) expect(isUnreachable(error)).toBe(true)
  for (const error of [
    new ApiError('x', 401), new ApiError('x', 403), new ApiError('x', 401, 'PAIRING_REQUIRED'),
    new ApiError('x', 404), new ApiError('x', 500), new ApiError('x', 0, 'ABORTED'),
    new Error('plain'), null,
  ]) expect(isUnreachable(error)).toBe(false)
})

describe('when a remote computer cannot be reached', () => {
  test('a verified new address from the local network replaces the stored one', async () => {
    const t = setup()
    expect(await t.relocator.unreachable(remote)).toBe(true)
    expect(t.located).toEqual([[{ port: 3456, addresses: ['192.168.1.8'], updatedAt: t.now }, credential]])
    expect(t.relocated).toEqual([['desk', NEW]])
  })

  test('the same address, no answer or no hints leave the registry alone', async () => {
    for (const [found, hints] of [[OLD, undefined], [null, undefined], [NEW, {}]] as const) {
      const t = setup({ found, hints })
      expect(await t.relocator.unreachable(remote)).toBe(false)
      expect(t.relocated).toEqual([])
    }
  })

  test('at most one search per computer every 30 seconds, however many requests fail', async () => {
    const t = setup({ found: null })
    const network = new ApiError('offline', 0, 'NETWORK_ERROR')
    for (let i = 0; i < 5; i++) t.relocator.settled(t.client(), network)
    await flush()
    expect(t.located).toHaveLength(1)
    t.advance(LOCATE_COOLDOWN_MS - 1)
    t.relocator.settled(t.client(), new ApiError('gone', 530, 'INVALID_RESPONSE'))
    await flush()
    expect(t.located).toHaveLength(1)
    t.advance(1)
    t.relocator.settled(t.client(), new ApiError('slow', 0, 'TIMEOUT'))
    await flush()
    expect(t.located).toHaveLength(2)
  })

  test('authorization failures, LAN computers and stale clients never trigger a search', async () => {
    const t = setup()
    t.relocator.settled(t.client(), new ApiError('denied', 401))
    t.relocator.settled(t.client(), new ApiError('re-pair', 401, 'PAIRING_REQUIRED'))
    t.relocator.settled(t.client(lan), new ApiError('offline', 0, 'NETWORK_ERROR'))
    // A request from before the address changed reports the old address.
    t.hosts.set('desk', { ...remote, url: NEW })
    t.relocator.settled(t.client(remote), new ApiError('offline', 0, 'NETWORK_ERROR'))
    t.relocator.settled(t.client({ ...remote, id: 'unknown' }), new ApiError('offline', 0, 'NETWORK_ERROR'))
    await flush()
    expect(t.located).toEqual([])
  })

  test('nothing happens before the registry is attached or after it is detached', async () => {
    const t = setup()
    const detached = new HostRelocator({ hints: { get: async () => null, set: async () => {}, retain: async () => {} }, locate: async () => NEW })
    expect(await detached.unreachable(remote)).toBe(false)
    const detach = t.relocator.attach({ host: () => remote, credential: async () => credential, relocate: async () => {} })
    detach()
    expect(await t.relocator.unreachable(remote)).toBe(false)
    expect(t.located).toEqual([])
  })
})

describe('local-network hints', () => {
  test('fetched after a successful contact when missing, then at most every 6 hours', async () => {
    const t = setup({ hints: {} })
    t.relocator.settled(t.client(), null)
    await flush()
    expect(t.locatorCalls).toEqual(['/api/public-access/locator'])
    expect(t.hints.get('desk')).toEqual({ port: 4567, addresses: ['10.0.0.9'], updatedAt: t.now })
    t.advance(HINTS_MAX_AGE_MS - 1)
    t.relocator.settled(t.client(), null)
    await flush()
    expect(t.locatorCalls).toHaveLength(1)
    t.advance(1)
    t.relocator.settled(t.client(), null)
    await flush()
    expect(t.locatorCalls).toHaveLength(2)
  })

  test('fresh stored hints are not refetched after a restart; old ones are', async () => {
    const fresh = setup()
    fresh.advance(HINTS_MAX_AGE_MS - 1)
    fresh.relocator.settled(fresh.client(), null)
    await flush()
    expect(fresh.locatorCalls).toEqual([])
    const old = setup()
    old.advance(HINTS_MAX_AGE_MS)
    old.relocator.settled(old.client(), null)
    await flush()
    expect(old.locatorCalls).toHaveLength(1)
  })

  test('an older computer without the endpoint is not asked again; other failures retry later', async () => {
    const t = setup({ hints: {} })
    t.answer(async () => { throw new ApiError('Not found', 404) })
    t.relocator.settled(t.client(), null)
    await flush()
    t.advance(HINTS_MAX_AGE_MS * 10)
    t.relocator.settled(t.client(), null)
    await flush()
    expect(t.locatorCalls).toHaveLength(1)
    const other = setup({ hints: {} })
    other.answer(async () => { throw new ApiError('denied', 401) })
    other.relocator.settled(other.client(), null)
    await flush()
    other.advance(HINTS_RETRY_MS)
    other.relocator.settled(other.client(), null)
    await flush()
    expect(other.locatorCalls).toHaveLength(2)
    expect(other.hints.size).toBe(0)
  })

  test('concurrent successes ask once, and a removed computer drops its hints', async () => {
    const t = setup({ hints: {} })
    for (let i = 0; i < 4; i++) t.relocator.settled(t.client(), null)
    await flush()
    expect(t.locatorCalls).toHaveLength(1)
    await t.relocator.retain(['lan'])
    expect(t.hints.has('desk')).toBe(false)
  })
})

describe('pushed addresses', () => {
  const sign = (url: string, value = credential) =>
    createHmac('sha256', createHash('sha256').update(value, 'utf8').digest('hex')).update(`cc-haha-host-url\n${url}`).digest('base64url')
  const target = (hosts: Host[] = [remote, lan]) => {
    const relocated: [string, string][] = []
    return {
      relocated,
      hosts,
      credential: async (id: string) => (id === remote.id ? credential : id === lan.id ? 'lan-token' : null),
      relocate: async (id: string, url: string) => { relocated.push([id, url]) },
    }
  }

  test('verified with this computer\'s credential: the address is replaced', async () => {
    const t = target()
    expect(await applyHostUrlUpdate({ hostId: 'desk', url: NEW, mac: sign(NEW) }, t)).toBe('relocated')
    expect(t.relocated).toEqual([['desk', NEW]])
  })

  test('unverified, unknown, LAN or credential-less computers are ignored; the current address is a no-op', async () => {
    const t = target()
    expect(await applyHostUrlUpdate({ hostId: 'desk', url: NEW, mac: sign(NEW, 'native_other') }, t)).toBe('ignored')
    expect(await applyHostUrlUpdate({ hostId: 'desk', url: 'https://evil.example', mac: sign(NEW) }, t)).toBe('ignored')
    expect(await applyHostUrlUpdate({ hostId: 'desk', url: 'http://plain.example', mac: sign('http://plain.example') }, t)).toBe('ignored')
    expect(await applyHostUrlUpdate({ hostId: 'ghost', url: NEW, mac: sign(NEW) }, t)).toBe('ignored')
    expect(await applyHostUrlUpdate({ hostId: 'lan', url: NEW, mac: sign(NEW, 'lan-token') }, t)).toBe('ignored')
    expect(await applyHostUrlUpdate({ hostId: 'desk', url: NEW, mac: sign(NEW) }, { ...t, credential: async () => null })).toBe('ignored')
    expect(await applyHostUrlUpdate({ hostId: 'desk', url: NEW, mac: sign(NEW) }, { ...t, credential: async () => { throw new Error('locked') } })).toBe('ignored')
    expect(await applyHostUrlUpdate({ hostId: 'desk', url: OLD, mac: sign(OLD) }, t)).toBe('current')
    expect(t.relocated).toEqual([])
  })
})
