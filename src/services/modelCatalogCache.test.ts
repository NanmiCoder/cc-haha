import { describe, expect, test } from 'bun:test'
import { createModelCatalogCache } from './modelCatalogCache.js'

const FALLBACK = ['fallback']
const REMOTE = ['remote']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const makeCache = (overrides?: { ttlMs?: number; failureBackoffMs?: number }) =>
  createModelCatalogCache<string[]>({
    ttlMs: overrides?.ttlMs ?? 10_000,
    failureBackoffMs: overrides?.failureBackoffMs ?? 10_000,
  })

describe('model catalog cache', () => {
  test('reports an explicit refresh failure while retaining the last successful listing', async () => {
    const cache = makeCache()
    await cache.resolve({ accountKey: 'a', fetchCatalog: async () => REMOTE, fallback: FALLBACK, forceRefresh: true })
    await expect(cache.resolve({
      accountKey: 'a', fallback: FALLBACK, forceRefresh: true, throwOnError: true,
      fetchCatalog: async () => { throw new Error('upstream unavailable') },
    })).rejects.toThrow('upstream unavailable')
    expect(await cache.resolve({ accountKey: 'a', fetchCatalog: async () => [], fallback: FALLBACK })).toEqual(REMOTE)
  })

  test('a late background response cannot overwrite an explicit refresh', async () => {
    const cache = makeCache()
    let complete!: (models: string[]) => void
    await cache.resolve({ accountKey: 'a', fallback: FALLBACK,
      fetchCatalog: () => new Promise<string[]>(resolve => { complete = resolve }) })
    await cache.resolve({ accountKey: 'a', fallback: FALLBACK, forceRefresh: true, fetchCatalog: async () => REMOTE })
    complete(['outdated'])
    await sleep(5)
    expect(await cache.resolve({ accountKey: 'a', fallback: FALLBACK, fetchCatalog: async () => [] })).toEqual(REMOTE)
  })

  test('ordinary reads during a forced refresh cannot launch a competing background refresh', async () => {
    const cache = makeCache()
    let complete!: (models: string[]) => void
    const refresh = cache.resolve({ accountKey: 'a', fallback: FALLBACK, forceRefresh: true,
      fetchCatalog: () => new Promise<string[]>(resolve => { complete = resolve }) })
    let backgroundCalls = 0
    expect(await cache.resolve({ accountKey: 'a', fallback: FALLBACK,
      fetchCatalog: async () => { backgroundCalls += 1; return ['outdated'] } })).toEqual(FALLBACK)
    complete(REMOTE)
    expect(await refresh).toEqual(REMOTE)
    expect(backgroundCalls).toBe(0)
    expect(await cache.resolve({ accountKey: 'a', fallback: FALLBACK, fetchCatalog: async () => [] })).toEqual(REMOTE)
  })

  test('switching accounts starts a separate refresh and ignores the previous response', async () => {
    const cache = makeCache()
    let complete!: (models: string[]) => void
    await cache.resolve({ accountKey: 'a', fallback: FALLBACK,
      fetchCatalog: () => new Promise<string[]>(resolve => { complete = resolve }) })
    await cache.resolve({ accountKey: 'b', fallback: FALLBACK, fetchCatalog: async () => ['b'] })
    await sleep(5)
    complete(['a'])
    await sleep(5)
    expect(await cache.resolve({ accountKey: 'b', fallback: FALLBACK, fetchCatalog: async () => [] })).toEqual(['b'])
  })

  test('clear invalidates pending responses as well as cached entries', async () => {
    const cache = makeCache()
    let complete!: (models: string[]) => void
    await cache.resolve({ accountKey: 'a', fallback: FALLBACK,
      fetchCatalog: () => new Promise<string[]>(resolve => { complete = resolve }) })
    cache.clear()
    complete(REMOTE)
    await sleep(5)
    expect(await cache.resolve({ accountKey: 'a', fallback: FALLBACK,
      fetchCatalog: () => new Promise<string[]>(() => {}) })).toEqual(FALLBACK)
  })

  test('answers from the fallback without waiting on the upstream request', async () => {
    const cache = makeCache()
    let settled = false
    // An upstream that never settles stands in for the unreachable endpoint
    // that used to hold the first paint hostage for a full timeout.
    const fetchCatalog = () => new Promise<string[]>(() => {})

    const models = await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    settled = true

    expect(models).toEqual(FALLBACK)
    expect(settled).toBe(true)
  })

  test('serves the refreshed catalog once the background request lands', async () => {
    const cache = makeCache()
    const fetchCatalog = async () => REMOTE

    expect(await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })).toEqual(FALLBACK)
    await sleep(5)
    expect(await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })).toEqual(REMOTE)
  })

  test('stops retrying for the backoff window after a failure', async () => {
    const cache = makeCache({ failureBackoffMs: 10_000 })
    let calls = 0
    const fetchCatalog = async () => {
      calls += 1
      throw new Error('upstream unreachable')
    }

    await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    await sleep(5)
    await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    await sleep(5)

    expect(calls).toBe(1)
  })

  test('retries again once the backoff window elapses', async () => {
    const cache = makeCache({ failureBackoffMs: 20 })
    let calls = 0
    const fetchCatalog = async () => {
      calls += 1
      throw new Error('upstream unreachable')
    }

    await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    await sleep(40)
    await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    await sleep(5)

    expect(calls).toBe(2)
  })

  test('collapses a burst of callers into one upstream request', async () => {
    const cache = makeCache()
    let calls = 0
    const fetchCatalog = async () => {
      calls += 1
      await sleep(10)
      return REMOTE
    }

    // `/api/models` and `/api/models/current` are requested in the same tick.
    await Promise.all([
      cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK }),
      cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK }),
      cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK }),
    ])
    await sleep(20)

    expect(calls).toBe(1)
  })

  test('keeps blocking semantics for forceRefresh', async () => {
    const cache = makeCache()
    const models = await cache.resolve({
      accountKey: 'a',
      fetchCatalog: async () => {
        await sleep(5)
        return REMOTE
      },
      fallback: FALLBACK,
      forceRefresh: true,
    })

    expect(models).toEqual(REMOTE)
  })

  test('falls back when a forced refresh fails', async () => {
    const cache = makeCache()
    const models = await cache.resolve({
      accountKey: 'a',
      fetchCatalog: async () => {
        throw new Error('upstream unreachable')
      },
      fallback: FALLBACK,
      forceRefresh: true,
    })

    expect(models).toEqual(FALLBACK)
  })

  test('keeps the account\'s last listing when a forced refresh fails', async () => {
    const cache = makeCache()
    await cache.resolve({ accountKey: 'a', fetchCatalog: async () => REMOTE, fallback: FALLBACK, forceRefresh: true })
    const failing = async (): Promise<typeof REMOTE> => {
      throw new Error('upstream unreachable')
    }

    expect(await cache.resolve({ accountKey: 'a', fetchCatalog: failing, fallback: FALLBACK, forceRefresh: true }))
      .toEqual(REMOTE)
    // Another account never sees it.
    expect(await cache.resolve({ accountKey: 'b', fetchCatalog: failing, fallback: FALLBACK, forceRefresh: true }))
      .toEqual(FALLBACK)
  })

  test('prefers a stale entry over the fallback while revalidating', async () => {
    const cache = makeCache({ ttlMs: 20 })
    const fetchCatalog = async () => REMOTE

    await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    await sleep(5)
    expect(await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })).toEqual(REMOTE)

    await sleep(30) // entry is now stale
    const stale = await cache.resolve({
      accountKey: 'a',
      fetchCatalog: () => new Promise<string[]>(() => {}),
      fallback: FALLBACK,
    })

    expect(stale).toEqual(REMOTE)
  })

  test('does not reuse another account\'s entry', async () => {
    const cache = makeCache()

    await cache.resolve({ accountKey: 'a', fetchCatalog: async () => REMOTE, fallback: FALLBACK })
    await sleep(5)

    const other = await cache.resolve({
      accountKey: 'b',
      fetchCatalog: () => new Promise<string[]>(() => {}),
      fallback: FALLBACK,
    })

    expect(other).toEqual(FALLBACK)
  })

  test('clear() drops the entry and the failure backoff', async () => {
    const cache = makeCache()
    let calls = 0
    const fetchCatalog = async () => {
      calls += 1
      throw new Error('upstream unreachable')
    }

    await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    await sleep(5)
    cache.clear()
    await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })
    await sleep(5)

    expect(calls).toBe(2)
  })
})
