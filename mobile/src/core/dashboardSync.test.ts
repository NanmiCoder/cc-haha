import { expect, test } from 'bun:test'
import { ApiClient, ApiError } from './client'
import {
  DashboardPoller,
  classifyDashboardError,
  loadDashboardSnapshot,
  type DashboardSnapshot,
} from './dashboardSync'
import { groupDashboard } from './dashboard'
import type { Session } from './types'

const session = (id: string): Session => ({
  id,
  title: id,
  createdAt: '2026-10-24T00:00:00Z',
  modifiedAt: '2026-10-24T00:00:00Z',
  messageCount: 2,
  projectPath: '/tmp/fake',
  workDir: '/tmp/fake',
  workDirExists: true,
})
function client(
  handle: (path: string, signal: AbortSignal) => unknown | Promise<unknown>,
  hostId = 'a'
) {
  return new ApiClient(
    { id: hostId, name: hostId, url: 'http://127.0.0.1:9000', auth: 'lan' },
    'fake-only',
    {
      fetch: async (url, options) => {
        const value = await handle(
          new URL(url).pathname + new URL(url).search,
          options.signal
        )
        return {
          ok: true,
          status: 200,
          url,
          redirected: false,
          text: async () => JSON.stringify(value),
        }
      },
    }
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const snapshot = (hostId = 'a', checkedAt = 0): DashboardSnapshot => ({
  hostId,
  checkedAt,
  sessions: [session(hostId)],
  activity: [],
  total: 1,
})
function clock() {
  let now = 0,
    id = 0
  const tasks = new Map<number, { at: number; run(): void }>()
  return {
    now: () => now,
    set: (run: () => void, delay: number) => {
      const key = ++id
      tasks.set(key, { at: now + delay, run })
      return key
    },
    clear: (key: unknown) => {
      tasks.delete(key as number)
    },
    advance: (duration: number) => {
      const target = now + duration
      for (;;) {
        const next = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        tasks.delete(next[0])
        next[1].run()
      }
      now = target
    },
  }
}
function observer() {
  const state = {
    fresh: false,
    loading: false,
    error: '',
    snapshots: [] as DashboardSnapshot[],
  }
  return {
    state,
    callbacks: {
      fresh: (value: boolean) => {
        state.fresh = value
      },
      loading: (value: boolean) => {
        state.loading = value
      },
      error: (value: string) => {
        state.error = value
      },
      snapshot: (value: DashboardSnapshot) => {
        state.snapshots.push(value)
      },
    },
  }
}

test('dashboard reads every limit/offset page and includes old running and waiting tasks beyond 500', async () => {
  const rows = Array.from({ length: 1203 }, (_, i) => session(String(i)))
  const paths: string[] = []
  const api = client((path) => {
    paths.push(path)
    if (path === '/api/sessions/mobile-status')
      return {
        sessions: [
          { id: '1001', activityState: 'running' },
          { id: '1202', activityState: 'waiting' },
        ],
      }
    const url = new URL(path, 'http://fixture'),
      offset = Number(url.searchParams.get('offset'))
    return { sessions: rows.slice(offset, offset + 500), total: rows.length }
  })
  const result = await loadDashboardSnapshot(
    api,
    new AbortController().signal,
    () => 100
  )
  expect(result.sessions).toHaveLength(1203)
  expect(result.checkedAt).toBe(100)
  expect(paths).toEqual([
    '/api/sessions?limit=500&offset=0',
    '/api/sessions?limit=500&offset=500',
    '/api/sessions?limit=500&offset=1000',
    '/api/sessions/mobile-status',
  ])
  const grouped = groupDashboard(result.sessions, result.activity)
  expect(grouped.running[0]?.session.id).toBe('1001')
  expect(grouped.waiting[0]?.session.id).toBe('1202')
})

test('short or empty index pages continue by requested offset until the reported total', async () => {
  const paths: string[] = []
  const result = await loadDashboardSnapshot(
    client((path) => {
      paths.push(path)
      if (path === '/api/sessions/mobile-status') return { sessions: [] }
      return {
        sessions: path.endsWith('offset=0')
          ? [session('first')]
          : path.endsWith('offset=500')
            ? []
            : [session('last')],
        total: 1001,
      }
    }),
    new AbortController().signal
  )
  expect(result.sessions.map((row) => row.id)).toEqual(['first', 'last'])
  expect(paths).toContain('/api/sessions?limit=500&offset=1000')
})

test('moving offset rows are deduplicated and missing active IDs use metadata-only summaries', async () => {
  const paths: string[] = []
  const result = await loadDashboardSnapshot(
    client((path) => {
      paths.push(path)
      if (path === '/api/sessions/mobile-status')
        return {
          sessions: [
            { id: 'older/active', activityState: 'waiting' },
            { id: 'moved', activityState: 'running' },
          ],
        }
      if (path === '/api/sessions/older%2Factive/summary')
        return session('older/active')
      return { sessions: [session('moved')], total: 501 }
    }),
    new AbortController().signal
  )
  expect(result.sessions.map((row) => row.id)).toEqual([
    'moved',
    'older/active',
  ])
  expect(paths).toContain('/api/sessions/older%2Factive/summary')
  expect(paths.some((path) => path.includes('/messages'))).toBe(false)
})

test('failed active-summary reads reject the snapshot instead of presenting a complete fresh dashboard', async () => {
  await expect(
    loadDashboardSnapshot(
      client((path) => {
        if (path === '/api/sessions/mobile-status')
          return { sessions: [{ id: 'missing', activityState: 'running' }] }
        if (path.endsWith('/summary'))
          throw new ApiError('Task unavailable', 404)
        return { sessions: [], total: 0 }
      }),
      new AbortController().signal
    )
  ).rejects.toThrow('Task unavailable')
})

test('all page requests carry cancellation and an invalid total cannot create an unbounded scan', async () => {
  const cancellation = new AbortController()
  let calls = 0
  const api = client(() => {
    calls++
    cancellation.abort()
    return { sessions: [session('one')], total: 900 }
  })
  await expect(
    loadDashboardSnapshot(api, cancellation.signal)
  ).rejects.toMatchObject({ code: 'ABORTED' })
  expect(calls).toBe(1)
  await expect(
    loadDashboardSnapshot(
      client(() => ({ sessions: [], total: -1 })),
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

test('freshness expires while a refresh is stalled and a late old snapshot is never promoted to fresh', async () => {
  const time = clock(),
    observed = observer(),
    delayed = deferred<DashboardSnapshot>()
  let calls = 0
  const poller = new DashboardPoller(
    client(() => ({})),
    observed.callbacks,
    time,
    async () => (++calls === 1 ? snapshot('a', time.now()) : delayed.promise)
  )
  poller.start()
  await flush()
  expect(observed.state.fresh).toBe(true)
  time.advance(15000)
  expect(observed.state.fresh).toBe(false)
  delayed.resolve(snapshot('a', 3000))
  await flush()
  expect(observed.state.fresh).toBe(false)
  expect(observed.state.error).toContain('耗时较长')
  poller.stop()
})

test('foreground resume waits for a new response; an aborted background request cannot revive freshness', async () => {
  const time = clock(),
    observed = observer(),
    old = deferred<DashboardSnapshot>(),
    next = deferred<DashboardSnapshot>()
  let calls = 0,
    firstSignal: AbortSignal | undefined
  const poller = new DashboardPoller(
    client(() => ({})),
    observed.callbacks,
    time,
    async (_client, signal) => {
      calls++
      if (calls === 1) {
        firstSignal = signal
        return old.promise
      }
      return next.promise
    }
  )
  poller.start()
  await flush()
  poller.setActive(false)
  expect(firstSignal?.aborted).toBe(true)
  expect(observed.state.fresh).toBe(false)
  poller.setActive(true)
  old.resolve(snapshot())
  await flush()
  expect(observed.state.snapshots).toHaveLength(0)
  expect(calls).toBe(2)
  next.resolve(snapshot())
  await flush()
  expect(observed.state.snapshots).toHaveLength(1)
  expect(observed.state.fresh).toBe(true)
  poller.stop()
})

test('a network failure retains the last snapshot for viewing but clears its freshness', async () => {
  const time = clock(),
    observed = observer()
  let calls = 0
  const poller = new DashboardPoller(
    client(() => ({})),
    observed.callbacks,
    time,
    async () => {
      if (++calls > 1) throw new Error('offline')
      return snapshot()
    }
  )
  poller.start()
  await flush()
  time.advance(3000)
  await flush()
  expect(observed.state.snapshots).toHaveLength(1)
  expect(observed.state.fresh).toBe(false)
  expect(observed.state.error).toBe('offline')
  poller.stop()
})

test('one network blip after a good snapshot is a retry, not offline; two in a row are offline', async () => {
  const time = clock()
  const kinds: (string | undefined)[] = []
  const outcomes = ['ok', 'down', 'ok', 'down', 'down', 'auth']
  let calls = 0
  const poller = new DashboardPoller(
    client(() => ({})),
    {
      snapshot: () => {},
      fresh: () => {},
      loading: () => {},
      error: (message, kind) => {
        kinds.push(message ? kind : 'clear')
      },
    },
    time,
    async () => {
      const outcome = outcomes[calls++] ?? 'ok'
      if (outcome === 'down') throw new ApiError('无法连接服务器', 0, 'NETWORK_ERROR')
      if (outcome === 'auth') throw new ApiError('Unauthorized', 401)
      return snapshot('a', time.now())
    }
  )
  poller.start()
  for (let index = 0; index < outcomes.length; index++) {
    await flush()
    time.advance(3000)
  }
  await flush()
  expect(kinds.slice(0, 6)).toEqual(['clear', 'slow', 'clear', 'slow', 'offline', 'unauthorized'])
  poller.stop()
})

test('stopping a host poller prevents its delayed response from replacing a newly selected host', async () => {
  const time = clock(),
    observed = observer(),
    old = deferred<DashboardSnapshot>()
  const first = new DashboardPoller(
    client(() => ({}), 'a'),
    observed.callbacks,
    time,
    async () => old.promise
  )
  first.start()
  first.stop()
  const second = new DashboardPoller(
    client(() => ({}), 'b'),
    observed.callbacks,
    time,
    async () => snapshot('b')
  )
  second.start()
  await flush()
  old.resolve(snapshot('a'))
  await flush()
  expect(observed.state.snapshots.map((value) => value.hostId)).toEqual(['b'])
  expect(observed.state.fresh).toBe(true)
  second.stop()
})

test('failures are classified so the home can tell offline from revoked access and bad responses', () => {
  expect(
    classifyDashboardError(new ApiError('无法连接服务器', 0, 'NETWORK_ERROR'))
  ).toBe('offline')
  expect(
    classifyDashboardError(new ApiError('连接超时', 0, 'TIMEOUT'))
  ).toBe('offline')
  expect(classifyDashboardError(new ApiError('Bad gateway', 502))).toBe(
    'offline'
  )
  expect(classifyDashboardError(new ApiError('Unauthorized', 401))).toBe(
    'unauthorized'
  )
  expect(classifyDashboardError(new ApiError('Forbidden', 403))).toBe(
    'unauthorized'
  )
  expect(
    classifyDashboardError(
      new ApiError('需要重新配对这台电脑', 401, 'PAIRING_REQUIRED')
    )
  ).toBe('unauthorized')
  expect(
    classifyDashboardError(
      new ApiError('电脑返回的会话分页无效', 0, 'INVALID_RESPONSE')
    )
  ).toBe('failed')
  expect(classifyDashboardError(new ApiError('Server error', 500))).toBe(
    'failed'
  )
  expect(classifyDashboardError(new TypeError('boom'))).toBe('failed')
})

test('the poller reports the failure kind with the message and clears it on recovery', async () => {
  const time = clock()
  const kinds: (string | undefined)[] = []
  let calls = 0
  const poller = new DashboardPoller(
    client(() => ({})),
    {
      snapshot: () => {},
      fresh: () => {},
      loading: () => {},
      error: (message, kind) => {
        kinds.push(message ? kind : 'clear')
      },
    },
    time,
    async () => {
      calls++
      if (calls === 1)
        throw new ApiError('无法连接服务器', 0, 'NETWORK_ERROR')
      if (calls === 2) throw new ApiError('Unauthorized', 401)
      if (calls === 3) return snapshot('a', time.now() - 20000)
      return snapshot('a', time.now())
    }
  )
  poller.start()
  await flush()
  time.advance(3000)
  await flush()
  time.advance(3000)
  await flush()
  time.advance(3000)
  await flush()
  expect(kinds).toEqual(['offline', 'unauthorized', 'slow', 'clear'])
  poller.stop()
})
