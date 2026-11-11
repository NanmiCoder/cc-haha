import { expect, test } from 'bun:test'
import { ApiClient, ApiError, type FetchAdapter } from '../core/client'
import { HostRepository, type Storage } from './storage'
import {
  buildDelivery,
  migratePushProofs,
  PushRegistrationCoordinator,
  pushProofKey,
  type PushRegistrationInput,
} from './pushRegistrations'

function memory(): Storage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value)
    },
    removeItem: async (key) => {
      values.delete(key)
    },
  }
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const token = 'a'.repeat(64)
const input = (
  hostId: string,
  overrides: Partial<PushRegistrationInput> = {}
): PushRegistrationInput => ({
  platform: 'ios',
  token,
  hostId,
  preferences: { decisions: true, completed: true, errors: true },
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  timeZone: 'Asia/Shanghai',
  ...overrides,
})
function server() {
  const records = new Map<string, PushRegistrationInput>()
  const log: string[] = []
  let before:
    | ((
        method: string,
        body: PushRegistrationInput,
        path: string
      ) => Promise<void>)
    | undefined
  const fetch: FetchAdapter = async (url, options) => {
    const path = new URL(url).pathname
    const body = JSON.parse(typeof options.body === 'string' ? options.body : '{}')
    await before?.(options.method, body, path)
    log.push(`${options.method}:${body.hostId ?? 'single'}:${path}`)
    let status = 200
    let response: unknown = {}
    if (options.method === 'PUT') {
      const id = `${body.hostId}-${body.kind ?? 'notification'}-${body.token}`
      records.set(id, body)
      response = { registered: true, status: 'registered', id }
    } else if (path === '/api/sessions/mobile-push') {
      let removed = 0
      for (const [id, value] of records)
        if (
          value.hostId === body.hostId &&
          (value.deviceToken ?? value.token) === body.token
        ) {
          records.delete(id)
          removed++
        }
      response = { removed }
    } else {
      const id = decodeURIComponent(path.split('/').at(-1)!)
      const record = records.get(id)
      if (record?.token === body.token) {
        records.delete(id)
        response = { removed: true }
      } else {
        status = 404
        response = { message: 'Not found' }
      }
    }
    return {
      ok: status < 400,
      status,
      url,
      redirected: false,
      text: async () => JSON.stringify(response),
    }
  }
  const client = (id: string) =>
    new ApiClient(
      { id, name: id, url: 'http://127.0.0.1:9000', auth: 'lan' },
      `fake-${id}`,
      { fetch }
    )
  return {
    records,
    log,
    client,
    before: (value?: typeof before) => {
      before = value
    },
  }
}

test('unversioned and v0 proofs migrate, strip unknown fields, and deduplicate only within a host', () => {
  for (const version of [undefined, 0])
    expect(
      migratePushProofs(
        JSON.stringify({
          version,
          tokens: [token, token],
          secret: 'do-not-copy',
        })
      )
    ).toEqual({ version: 1, tokens: [token] })
  expect(migratePushProofs(null)).toEqual({ version: 1, tokens: [] })
})

test('future or corrupt proof records fail closed and are never overwritten or sent', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const raw = JSON.stringify({ version: 2, tokens: [token] })
  store.values.set(pushProofKey('a'), raw)
  await expect(
    coordinator.register(api.client('a'), input('a'))
  ).rejects.toThrow('更新版本')
  await expect(
    coordinator.removeHost('a', api.client('a'), async () => 'removed')
  ).rejects.toThrow('已保留')
  expect(store.values.get(pushProofKey('a'))).toBe(raw)
  expect(api.log).toHaveLength(0)
  expect(() => migratePushProofs('{"version":1,"tokens":[false]}')).toThrow(
    '无法读取'
  )
})

test('registering an old fixture saves the forward migration without leaking extra fields', async () => {
  const store = memory(),
    api = server()
  store.values.set(
    pushProofKey('a'),
    JSON.stringify({ version: 0, tokens: [token], unrelated: 'old field' })
  )
  await new PushRegistrationCoordinator(store).register(
    api.client('a'),
    input('a')
  )
  expect(JSON.parse((await store.getItem(pushProofKey('a'))) ?? '')).toEqual({
    version: 1,
    tokens: [token],
  })
})

test('revoke proof is durable before PUT and prevents a write if SecureStore fails', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  api.before(async (method) => {
    if (method === 'PUT')
      expect(
        migratePushProofs(await store.getItem(pushProofKey('a'))).tokens
      ).toEqual([token])
  })
  await coordinator.register(api.client('a'), input('a'))
  store.setItem = async () => {
    throw new Error('secure write failed')
  }
  await expect(
    coordinator.register(api.client('b'), input('b'))
  ).rejects.toThrow('secure write failed')
  expect(api.records.size).toBe(1)
})

test('process restart revokes ordinary and Live Activity registrations using the parent device token', async () => {
  const store = memory(),
    api = server(),
    first = new PushRegistrationCoordinator(store)
  await first.register(api.client('a'), input('a'))
  await first.register(
    api.client('a'),
    input('a', {
      kind: 'liveActivity',
      token: 'b'.repeat(64),
      deviceToken: token,
      activityId: 'activity',
      sessionId: 'session',
      name: 'CCHahaTaskActivity',
    })
  )
  const restarted = new PushRegistrationCoordinator(store)
  let removed = false
  await restarted.removeHost('a', api.client('a'), async () => {
    removed = true
  })
  expect(removed).toBe(true)
  expect(api.records.size).toBe(0)
  expect(await store.getItem(pushProofKey('a'))).toBeNull()
  expect(api.log.filter((value) => value.startsWith('DELETE'))).toEqual([
    'DELETE:a:/api/sessions/mobile-push',
  ])
})

test('a computer that cannot be told is still removed, however it fails', async () => {
  // 想移除一台电脑，多半正因为连不上它：拒绝凭据、服务出错、网络不通，一律不拦移除。
  // 每种失败用一台全新登记过的电脑。
  for (const failure of [
    new ApiError('不被接受', 401),
    new ApiError('不被接受', 403),
    new ApiError('服务出错', 500),
    new ApiError('无法连接服务器，请检查地址与网络', 0, 'NETWORK_ERROR'),
  ]) {
    const store = memory(),
      hosts = new HostRepository(memory(), store),
      api = server(),
      coordinator = new PushRegistrationCoordinator(store)
    await hosts.add(api.client('a').host, 'credential-a')
    await coordinator.register(api.client('a'), input('a'))
    expect(migratePushProofs(await store.getItem(pushProofKey('a'))).tokens).toEqual([token])
    const failing = {
      host: api.client('a').host,
      request: (async () => {
        throw failure
      }) as ApiClient['request'],
    }
    await coordinator.removeHost('a', failing, () => hosts.remove('a'))
    expect((await hosts.load()).hosts).toEqual([])
    expect(await hosts.credential('a')).toBeNull()
    expect(await store.getItem(pushProofKey('a'))).toBeNull()
  }
})

test('a computer whose address cannot be reached is removed over the real fetch', async () => {
  // 用户现场的失败：旧的局域网地址、已失效的隧道，请求真的发不到电脑，不是手写的错误。
  // 连接被拒还是被本机代理回 502 取决于环境，这里只要求「发出过、没成功」。
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  const store = memory(),
    api = server()
  await new PushRegistrationCoordinator(store).register(api.client('a'), input('a'))
  const outcomes: number[] = []
  const dead = new ApiClient(
    { id: 'a', name: 'a', url: `http://127.0.0.1:${port}`, auth: 'lan' },
    'fake-a',
    {
      fetch: async (url, init) => {
        try {
          const response = await fetch(url, init)
          outcomes.push(response.status)
          return response
        } catch (error) {
          outcomes.push(0)
          throw error
        }
      },
    }
  )
  let removed = false
  await new PushRegistrationCoordinator(store, { revokeBudgetMs: 1000 }).removeHost(
    'a',
    dead,
    async () => {
      removed = true
    }
  )
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]).not.toBe(200)
  expect(removed).toBe(true)
  expect(await store.getItem(pushProofKey('a'))).toBeNull()
})

test('a computer that never answers holds removal up for the revoke budget at most', async () => {
  const store = memory(),
    api = server()
  await new PushRegistrationCoordinator(store).register(api.client('a'), input('a'))
  let aborted = false
  // 请求一直挂着直到被取消，像局域网里被丢包的旧地址。没有预算，这个用例会卡满请求自己的 6 秒。
  const hanging = new ApiClient(
    { id: 'a', name: 'a', url: 'http://127.0.0.1:9000', auth: 'lan' },
    'fake-a',
    {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
    }
  )
  let removed = false
  await new PushRegistrationCoordinator(store, { revokeBudgetMs: 20 }).removeHost(
    'a',
    hanging,
    async () => {
      removed = true
    }
  )
  expect(aborted).toBe(true)
  expect(removed).toBe(true)
  expect(await store.getItem(pushProofKey('a'))).toBeNull()
})

test('clearing registrations keeps the proof while the computer is unreachable and drops it once the computer rejects our credential', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  await coordinator.register(api.client('a'), input('a'))
  const failing = (error: Error) => ({
    host: api.client('a').host,
    request: (async () => {
      throw error
    }) as ApiClient['request'],
  })
  await expect(
    coordinator.clearRegistrations(failing(new ApiError('offline', 0, 'NETWORK_ERROR')))
  ).rejects.toThrow('offline')
  expect(migratePushProofs(await store.getItem(pushProofKey('a'))).tokens).toEqual([token])
  await coordinator.clearRegistrations(failing(new ApiError('不被接受', 401)))
  expect(await store.getItem(pushProofKey('a'))).toBeNull()
})

test('removing host A never removes host B proofs, registrations, or metadata', async () => {
  const store = memory(),
    metadata = memory(),
    hosts = new HostRepository(metadata, store),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  for (const id of ['a', 'b']) {
    await hosts.add(api.client(id).host, `credential-${id}`)
    await coordinator.register(api.client(id), input(id))
  }
  await coordinator.removeHost('a', api.client('a'), () => hosts.remove('a'))
  expect((await hosts.load()).hosts.map((host) => host.id)).toEqual(['b'])
  expect(await hosts.credential('a')).toBeNull()
  expect(await hosts.credential('b')).toBe('credential-b')
  expect([...api.records.values()].map((value) => value.hostId)).toEqual(['b'])
  expect(
    migratePushProofs(await store.getItem(pushProofKey('b'))).tokens
  ).toEqual([token])
  expect([...metadata.values.values()].join('')).not.toContain(token)
})

test('late accepted old preference PUT is compensated before the current preference PUT', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const started = deferred(),
    release = deferred(),
    cancellation = new AbortController()
  let first = true
  api.before(async (method) => {
    if (method === 'PUT' && first) {
      first = false
      started.resolve()
      await release.promise
    }
  })
  const old = coordinator
    .register(api.client('a'), input('a'), cancellation.signal)
    .catch((error) => error)
  await started.promise
  cancellation.abort()
  const current = coordinator.register(
    api.client('a'),
    input('a', {
      preferences: { decisions: false, completed: false, errors: true },
    })
  )
  release.resolve()
  expect((await old).code).toBe('ABORTED')
  await current
  expect(api.log.map((value) => value.split(':')[0])).toEqual([
    'PUT',
    'DELETE',
    'PUT',
  ])
  expect([...api.records.values()][0]?.preferences).toEqual({
    decisions: false,
    completed: false,
    errors: true,
  })
})

test('removal drains a delayed accepted PUT, blocks queued writes, then ends native activity and removes local host', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const started = deferred(),
    release = deferred()
  api.before(async (method) => {
    if (method === 'PUT') {
      started.resolve()
      await release.promise
    }
  })
  const active = coordinator
    .register(api.client('a'), input('a'))
    .catch((error) => error)
  await started.promise
  const queued = coordinator
    .register(api.client('a'), input('a', { token: 'c'.repeat(64) }))
    .catch((error) => error)
  coordinator.onRemoveHost('a', async () => {
    api.log.push('native-ended')
  })
  const removing = coordinator.removeHost('a', api.client('a'), async () => {
    api.log.push('host-removed')
  })
  await expect(
    coordinator.register(api.client('a'), input('a'))
  ).rejects.toMatchObject({ code: 'ABORTED' })
  expect(api.log).toEqual([])
  release.resolve()
  expect((await active).code).toBe('ABORTED')
  expect((await queued).code).toBe('ABORTED')
  await removing
  expect(api.records.size).toBe(0)
  expect(api.log.map((value) => value.split(':')[0])).toEqual([
    'PUT',
    'DELETE',
    'DELETE',
    'native-ended',
    'host-removed',
  ])
  await expect(
    coordinator.register(api.client('a'), input('a'))
  ).rejects.toMatchObject({ code: 'ABORTED' })
})

test('an offline computer is asked once and removal goes ahead without it', async () => {
  const store = memory(),
    metadata = memory(),
    hosts = new HostRepository(metadata, store),
    api = server()
  await hosts.add(api.client('a').host, 'fake-host-secret')
  await new PushRegistrationCoordinator(store).register(
    api.client('a'),
    input('a')
  )
  const restarted = new PushRegistrationCoordinator(store)
  let asked = 0
  api.before(async (method) => {
    if (method === 'DELETE') {
      asked++
      throw new Error('offline')
    }
  })
  await restarted.removeHost('a', api.client('a'), () => hosts.remove('a'))
  expect(asked).toBe(1)
  expect((await hosts.load()).hosts).toHaveLength(0)
  expect(await hosts.credential('a')).toBeNull()
  expect(await store.getItem(pushProofKey('a'))).toBeNull()
  // 电脑没收到注销：登记留在它那边，等它过期或撤销配对后清掉。
  expect(api.records.size).toBe(1)
})

test('rotated device tokens remain revocable after a lost PUT response and a process restart', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  await coordinator.register(api.client('a'), input('a'))
  const rotated = 'c'.repeat(64)
  api.before(async (method, body) => {
    if (method === 'PUT') {
      api.records.set('lost-response', body)
      throw new Error('connection dropped after acceptance')
    }
  })
  await expect(
    coordinator.register(api.client('a'), input('a', { token: rotated }))
  ).rejects.toThrow()
  expect(
    migratePushProofs(await store.getItem(pushProofKey('a'))).tokens
  ).toEqual([token, rotated])
  api.before()
  await new PushRegistrationCoordinator(store).removeHost(
    'a',
    api.client('a'),
    async () => {}
  )
  expect(api.records.size).toBe(0)
})

test('cancel during secret write restores its previous state and never dispatches PUT', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const cancellation = new AbortController(),
    entered = deferred(),
    release = deferred(),
    save = store.setItem
  store.setItem = async (key, value) => {
    await save(key, value)
    entered.resolve()
    await release.promise
  }
  const registration = coordinator
    .register(api.client('a'), input('a'), cancellation.signal)
    .catch((error) => error)
  await entered.promise
  cancellation.abort()
  release.resolve()
  expect((await registration).code).toBe('ABORTED')
  expect(await store.getItem(pushProofKey('a'))).toBeNull()
  expect(api.log).toHaveLength(0)
})

test('cancel while queued does not register the superseded token', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const entered = deferred(),
    release = deferred(),
    cancellation = new AbortController()
  api.before(async (method) => {
    if (method === 'PUT') {
      entered.resolve()
      await release.promise
    }
  })
  const first = coordinator.register(api.client('a'), input('a'))
  await entered.promise
  const queued = coordinator
    .register(
      api.client('a'),
      input('a', { token: 'c'.repeat(64) }),
      cancellation.signal
    )
    .catch((error) => error)
  cancellation.abort()
  release.resolve()
  await first
  expect((await queued).code).toBe('ABORTED')
  expect(api.records.size).toBe(1)
  expect(
    migratePushProofs(await store.getItem(pushProofKey('a'))).tokens
  ).toEqual([token])
})

test('native cleanup can finish a previously queued single revoke without deadlocking host removal', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const result = await coordinator.register(api.client('a'), input('a'))
  coordinator.onRemoveHost('a', () =>
    coordinator.unregister(api.client('a'), result.id!, token)
  )
  await coordinator.removeHost('a', api.client('a'), async () => {})
  expect(api.records.size).toBe(0)
})

test('a host whose connection credential is gone is still removed, without contacting anything', async () => {
  const store = memory(),
    coordinator = new PushRegistrationCoordinator(store)
  expect(await coordinator.removeHost('new', null, async () => 'done')).toBe(
    'done'
  )
  store.values.set(
    pushProofKey('old'),
    JSON.stringify({ version: 1, tokens: [token] })
  )
  expect(await coordinator.removeHost('old', null, async () => 'removed')).toBe(
    'removed'
  )
  expect(await store.getItem(pushProofKey('old'))).toBeNull()
})

test('duplicate remove calls share one transaction and local cleanup failures retain a retryable host', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  await coordinator.register(api.client('a'), input('a'))
  let fail = true,
    removes = 0
  coordinator.onRemoveHost('a', async () => {
    if (fail) throw new Error('native end failed')
  })
  const first = coordinator.removeHost('a', api.client('a'), async () => {
    removes++
  })
  const same = coordinator.removeHost('a', api.client('a'), async () => {
    removes++
  })
  expect(first).toBe(same)
  await expect(first).rejects.toThrow('native end failed')
  expect(removes).toBe(0)
  expect(await store.getItem(pushProofKey('a'))).not.toBeNull()
  fail = false
  await coordinator.removeHost('a', api.client('a'), async () => {
    removes++
  })
  expect(removes).toBe(1)
})

test('single revoke accepts already-removed registrations but propagates other errors', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  await coordinator.unregister(api.client('a'), 'missing', token)
  api.before(async () => {
    throw new ApiError('offline', 0, 'NETWORK_ERROR')
  })
  await expect(
    coordinator.unregister(api.client('a'), 'missing', token)
  ).rejects.toThrow('offline')
})

const iosOptions = {
  timeSensitive: true,
  liveActivity: 'running' as const,
  liveActivityShowCommand: true,
}

test('delivery payload: Android declares split channels only once they exist, iOS reports its three settings', () => {
  expect(
    buildDelivery('android', { ...iosOptions, channelsReady: true })
  ).toEqual({ channels: 'split' })
  // 渠道没建成功就不声明，服务端继续用 legacy 渠道。
  expect(buildDelivery('android', { ...iosOptions })).toBeUndefined()
  expect(
    buildDelivery('ios', {
      timeSensitive: false,
      liveActivity: 'decisions',
      liveActivityShowCommand: false,
    })
  ).toEqual({
    timeSensitive: false,
    liveActivity: 'decisions',
    showCommand: false,
  })
  // iOS 没有 Android 渠道概念，即使误传 channelsReady 也不带 channels。
  expect(
    buildDelivery('ios', { ...iosOptions, channelsReady: true })
  ).not.toHaveProperty('channels')
})

test('delivery is sent as a top-level field and old fixtures without it still register unchanged', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const delivery = buildDelivery('ios', iosOptions)
  await coordinator.register(api.client('a'), input('a', { delivery }))
  expect(api.records.get(`a-notification-${token}`)?.delivery).toEqual(
    delivery
  )
  // 旧数据形状（无 delivery）不被改写。
  const legacy = input('b')
  await coordinator.register(api.client('b'), legacy)
  const stored = api.records.get(`b-notification-${token}`)
  expect(stored).toEqual(legacy)
  expect(stored).not.toHaveProperty('delivery')
})

test('an older desktop that rejects delivery with 400 gets one retry without it, for notification and live activity registrations', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const puts: PushRegistrationInput[] = []
  api.before(async (method, body) => {
    if (method !== 'PUT') return
    puts.push(body)
    if ('delivery' in body) throw new ApiError('Invalid push registration', 400)
  })
  const delivery = buildDelivery('ios', iosOptions)
  const result = await coordinator.register(
    api.client('a'),
    input('a', { delivery })
  )
  expect(result.registered).toBe(true)
  expect(puts).toHaveLength(2)
  expect(puts[0]!.delivery).toEqual(delivery)
  expect(puts[1]).not.toHaveProperty('delivery')
  expect(puts[1]).toEqual(input('a'))
  const activity = await coordinator.register(
    api.client('a'),
    input('a', {
      kind: 'liveActivity',
      token: 'b'.repeat(64),
      deviceToken: token,
      sessionId: 's',
      activityId: 'act',
      name: 'CCHahaTaskActivity',
      delivery,
    })
  )
  expect(activity.registered).toBe(true)
  expect(puts.at(-1)).not.toHaveProperty('delivery')
  expect(puts.at(-1)?.kind).toBe('liveActivity')
})

test('only a 400 triggers the delivery retry: other failures and a still-rejected retry propagate', async () => {
  const store = memory(),
    api = server(),
    coordinator = new PushRegistrationCoordinator(store)
  const delivery = buildDelivery('ios', iosOptions)
  let puts = 0
  api.before(async (method) => {
    if (method !== 'PUT') return
    puts++
    throw new ApiError('offline', 0, 'NETWORK_ERROR')
  })
  await expect(
    coordinator.register(api.client('a'), input('a', { delivery }))
  ).rejects.toThrow('offline')
  expect(puts).toBe(1)
  puts = 0
  api.before(async (method) => {
    if (method !== 'PUT') return
    puts++
    throw new ApiError('Invalid push registration', 400)
  })
  await expect(
    coordinator.register(api.client('a'), input('a', { delivery }))
  ).rejects.toThrow('Invalid push registration')
  expect(puts).toBe(2)
  // 本来就没带 delivery 的请求被拒绝时不重试。
  puts = 0
  await expect(
    coordinator.register(api.client('a'), input('a'))
  ).rejects.toThrow()
  expect(puts).toBe(1)
})
