import { expect, test } from 'bun:test'
import { ApiClient, ApiError, type FetchAdapter } from '../core/client'
import { HostRepository, type Storage } from './storage'
import {
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
    const body = JSON.parse(options.body ?? '{}')
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

test('offline unregister preserves host credential and proof across restart, then retry succeeds', async () => {
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
  api.before(async (method) => {
    if (method === 'DELETE') throw new Error('offline')
  })
  await expect(
    restarted.removeHost('a', api.client('a'), () => hosts.remove('a'))
  ).rejects.toThrow('电脑和凭据已保留')
  expect((await hosts.load()).hosts).toHaveLength(1)
  expect(await hosts.credential('a')).toBe('fake-host-secret')
  expect(
    migratePushProofs(await store.getItem(pushProofKey('a'))).tokens
  ).toEqual([token])
  api.before()
  await restarted.removeHost('a', api.client('a'), () => hosts.remove('a'))
  expect((await hosts.load()).hosts).toHaveLength(0)
  expect(api.records.size).toBe(0)
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

test('a host with no remote registration can be removed offline, but missing credentials cannot discard known registration', async () => {
  const store = memory(),
    coordinator = new PushRegistrationCoordinator(store)
  expect(await coordinator.removeHost('new', null, async () => 'done')).toBe(
    'done'
  )
  store.values.set(
    pushProofKey('old'),
    JSON.stringify({ version: 1, tokens: [token] })
  )
  let removed = false
  await expect(
    coordinator.removeHost('old', null, async () => {
      removed = true
    })
  ).rejects.toThrow('连接已保留')
  expect(removed).toBe(false)
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
