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

  test('can propagate a forced refresh failure', async () => {
    const cache = makeCache()

    await expect(cache.resolve({
      accountKey: 'a',
      fetchCatalog: async () => {
        throw new Error('upstream unreachable')
      },
      fallback: FALLBACK,
      forceRefresh: true,
      throwOnForceRefreshError: true,
    })).rejects.toThrow('upstream unreachable')
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

  test('an account switch starts a fresh request even when the old account is still loading', async () => {
    const cache = makeCache()
    let finishOld!: (models: string[]) => void
    await cache.resolve({
      accountKey: 'a',
      fetchCatalog: () => new Promise(resolve => { finishOld = resolve }),
      fallback: FALLBACK,
    })
    let calls = 0
    const fetchCurrent = async () => {
      calls += 1
      return ['account-b']
    }
    await cache.resolve({ accountKey: 'b', fetchCatalog: fetchCurrent, fallback: FALLBACK })
    await sleep(5)
    finishOld(['account-a'])
    await sleep(5)
    expect(await cache.resolve({ accountKey: 'b', fetchCatalog: fetchCurrent, fallback: FALLBACK }))
      .toEqual(['account-b'])
    expect(calls).toBe(1)
  })

  test('does not carry a failed account request backoff into a different account', async () => {
    const cache = makeCache()
    await cache.resolve({
      accountKey: 'a',
      fetchCatalog: async () => { throw new Error('account-a unavailable') },
      fallback: FALLBACK,
      forceRefresh: true,
    })
    const fetchCatalog = async () => ['account-b']
    await cache.resolve({ accountKey: 'b', fetchCatalog, fallback: FALLBACK })
    await sleep(5)
    expect(await cache.resolve({ accountKey: 'b', fetchCatalog, fallback: FALLBACK }))
      .toEqual(['account-b'])
  })

  test('clear() prevents an in-flight refresh from restoring a stale entry', async () => {
    const cache = makeCache()
    let resolveRefresh: ((models: string[]) => void) | undefined
    const fetchCatalog = () => new Promise<string[]>((resolve) => {
      resolveRefresh = resolve
    })

    expect(await cache.resolve({ accountKey: 'a', fetchCatalog, fallback: FALLBACK })).toEqual(FALLBACK)
    cache.clear()
    resolveRefresh?.(REMOTE)
    await sleep(5)

    const models = await cache.resolve({
      accountKey: 'a',
      fetchCatalog: () => new Promise<string[]>(() => {}),
      fallback: FALLBACK,
    })
    expect(models).toEqual(FALLBACK)
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
