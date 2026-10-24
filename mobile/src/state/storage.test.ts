import { describe, expect, test } from 'bun:test'
import type { Host } from '../core/types'
import {
  HostRepository,
  migrateRegistry,
  type Registry,
  type Storage,
} from './storage'

const registryKey = 'cc-haha.hosts'
const credentialKey = (id: string) => `cc-haha.host.${id}`
const hostA: Host = {
  id: 'host-a',
  name: '电脑 A',
  url: 'http://192.168.1.10:3456',
  auth: 'lan',
}
const hostB: Host = {
  id: 'host-b',
  name: '电脑 B',
  url: 'https://b.fixture.invalid',
  auth: 'remote',
}
const tokenA = 'fake-token-a'
const tokenB = 'fake-token-b'

type Operation = 'getItem' | 'setItem' | 'removeItem'
type Call = { operation: Operation; key: string; value?: string }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Every test gets isolated in-memory stores. No platform storage modules are imported. */
class MemoryStorage implements Storage {
  readonly values = new Map<string, string>()
  readonly calls: Call[] = []
  private failures: Partial<Record<Operation, Error>> = {}
  private pauses: Partial<
    Record<Operation, { entered: () => void; released: Promise<void> }>
  > = {}

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial))
      this.values.set(key, value)
  }

  failNext(operation: Operation, message: string) {
    this.failures[operation] = new Error(message)
  }

  /** Suspend after the underlying data changed, before its asynchronous call resolves. */
  pauseAfterNext(operation: Operation) {
    const entered = deferred()
    const released = deferred()
    this.pauses[operation] = {
      entered: entered.resolve,
      released: released.promise,
    }
    return { reached: entered.promise, release: released.resolve }
  }

  private async checkpoint(operation: Operation) {
    const pause = this.pauses[operation]
    if (!pause) return
    delete this.pauses[operation]
    pause.entered()
    await pause.released
  }

  private record(call: Call) {
    this.calls.push(call)
    const failure = this.failures[call.operation]
    delete this.failures[call.operation]
    if (failure) throw failure
  }

  async getItem(key: string) {
    this.record({ operation: 'getItem', key })
    await this.checkpoint('getItem')
    return this.values.get(key) ?? null
  }

  async setItem(key: string, value: string) {
    this.record({ operation: 'setItem', key, value })
    this.values.set(key, value)
    await this.checkpoint('setItem')
  }

  async removeItem(key: string) {
    this.record({ operation: 'removeItem', key })
    this.values.delete(key)
    await this.checkpoint('removeItem')
  }
}

function setup(raw?: string) {
  const metadata = new MemoryStorage(
    raw === undefined ? {} : { [registryKey]: raw }
  )
  const secrets = new MemoryStorage()
  return {
    metadata,
    secrets,
    repository: new HostRepository(metadata, secrets),
  }
}

const persisted = (metadata: MemoryStorage): Registry =>
  JSON.parse(metadata.values.get(registryKey)!)

describe('host registry migration', () => {
  test('missing metadata produces an empty version 1 registry', async () => {
    expect(migrateRegistry(null)).toEqual({
      version: 1,
      hosts: [],
      selectedId: null,
    })
    const { repository, metadata, secrets } = setup()
    expect(await repository.load()).toEqual({
      version: 1,
      hosts: [],
      selectedId: null,
    })
    expect(metadata.values.size).toBe(0)
    expect(secrets.calls).toEqual([])
  })

  for (const version of [undefined, 0]) {
    test(`migrates ${version === undefined ? 'unversioned' : 'version 0'} metadata without changing host identity`, async () => {
      const raw = JSON.stringify({
        ...(version === undefined ? {} : { version }),
        hosts: [{ ...hostA, url: `${hostA.url}/` }, hostB],
        selectedId: hostB.id,
      })
      const { repository, metadata, secrets } = setup(raw)
      const expected: Registry = {
        version: 1,
        hosts: [hostA, hostB],
        selectedId: hostB.id,
      }

      expect(migrateRegistry(raw)).toEqual(expected)
      expect(await repository.load()).toEqual(expected)
      expect(persisted(metadata)).toEqual(expected)
      expect(secrets.calls).toEqual([])

      metadata.calls.length = 0
      expect(await repository.load()).toEqual(expected)
      expect(
        metadata.calls.filter((call) => call.operation !== 'getItem')
      ).toEqual([])
    })
  }

  test('strips unknown metadata fields and never rewrites legacy credentials into JSON', async () => {
    const raw = JSON.stringify({
      version: 0,
      hosts: [
        {
          ...hostA,
          token: 'legacy-host-token',
          credential: 'legacy-credential',
          extra: { apiKey: 'legacy-api-key' },
        },
      ],
      selectedId: hostA.id,
      token: 'legacy-root-token',
      futureField: true,
    })
    const { repository, metadata, secrets } = setup(raw)
    expect(await repository.load()).toEqual({
      version: 1,
      hosts: [hostA],
      selectedId: hostA.id,
    })
    const writes = metadata.calls.filter((call) => call.operation === 'setItem')
    expect(writes).toHaveLength(1)
    expect(writes[0].value).toBe(
      JSON.stringify({ version: 1, hosts: [hostA], selectedId: hostA.id })
    )
    expect(writes[0].value).not.toContain('legacy-')
    expect(secrets.calls).toEqual([])
    expect(await repository.credential(hostA.id)).toBeNull()
  })

  test('an invalid selected ID falls back to the first retained host or null', () => {
    expect(
      migrateRegistry(
        JSON.stringify({ hosts: [hostA, hostB], selectedId: 'missing' })
      ).selectedId
    ).toBe(hostA.id)
    expect(
      migrateRegistry(JSON.stringify({ hosts: [], selectedId: hostA.id }))
        .selectedId
    ).toBeNull()
  })

  test('rejects future versions and preserves the complete original data', async () => {
    const raw = JSON.stringify({
      version: 2,
      hosts: [hostA],
      selectedId: hostA.id,
      future: { encrypted: 'fake-opaque-value' },
    })
    const { repository, metadata, secrets } = setup(raw)
    secrets.values.set(credentialKey(hostA.id), tokenA)
    expect(() => migrateRegistry(raw)).toThrow('更新的 App 版本')
    await expect(repository.load()).rejects.toThrow('更新的 App 版本')
    await expect(repository.add(hostB, tokenB)).rejects.toThrow(
      '更新的 App 版本'
    )
    await expect(repository.select(hostA.id)).rejects.toThrow('更新的 App 版本')
    await expect(repository.remove(hostA.id)).rejects.toThrow('更新的 App 版本')
    expect(metadata.values.get(registryKey)).toBe(raw)
    expect(
      metadata.calls.filter((call) => call.operation !== 'getItem')
    ).toEqual([])
    expect(secrets.calls).toEqual([])
    expect(secrets.values.get(credentialKey(hostA.id))).toBe(tokenA)
  })

  test('rejects duplicate or malformed hosts without overwriting their source', async () => {
    for (const hosts of [
      [hostA, hostA],
      [{ ...hostA, id: '../invalid' }],
      [{ ...hostB, url: 'http://public.fixture.invalid' }],
    ]) {
      const raw = JSON.stringify({ version: 0, hosts, selectedId: hostA.id })
      const { repository, metadata, secrets } = setup(raw)
      await expect(repository.load()).rejects.toThrow()
      expect(metadata.values.get(registryKey)).toBe(raw)
      expect(
        metadata.calls.filter((call) => call.operation !== 'getItem')
      ).toEqual([])
      expect(secrets.calls).toEqual([])
    }
  })

  test('a failed migration write leaves legacy bytes intact and can be retried', async () => {
    const raw = JSON.stringify({ hosts: [hostA], selectedId: hostA.id })
    const { repository, metadata, secrets } = setup(raw)
    metadata.failNext('setItem', 'metadata unavailable')
    await expect(repository.load()).rejects.toThrow('metadata unavailable')
    expect(metadata.values.get(registryKey)).toBe(raw)
    expect(secrets.calls).toEqual([])
    expect(await repository.load()).toEqual({
      version: 1,
      hosts: [hostA],
      selectedId: hostA.id,
    })
    expect(persisted(metadata).version).toBe(1)
  })
})

describe('host repository isolation and transactions', () => {
  test('A and B credentials stay separate and are absent from every metadata write', async () => {
    const { repository, metadata, secrets } = setup()
    const taintedHost = {
      ...hostA,
      credential: 'injected-secret',
      token: 'injected-token',
    }
    await repository.add(taintedHost, tokenA)
    await repository.add(hostB, tokenB)
    await repository.select(hostA.id)

    expect(await repository.credential(hostA.id)).toBe(tokenA)
    expect(await repository.credential(hostB.id)).toBe(tokenB)
    expect(await repository.credential('unknown')).toBeNull()
    expect(await repository.load()).toEqual({
      version: 1,
      hosts: [hostA, hostB],
      selectedId: hostA.id,
    })
    expect([...secrets.values.keys()].sort()).toEqual([
      credentialKey(hostA.id),
      credentialKey(hostB.id),
    ])
    for (const call of metadata.calls.filter(
      (item) => item.operation === 'setItem'
    )) {
      expect(call.value).not.toContain('fake-token-')
      expect(call.value).not.toContain('injected-')
      expect(
        JSON.parse(call.value!).hosts.every(
          (host: Record<string, unknown>) =>
            Object.keys(host).sort().join(',') === 'auth,id,name,url'
        )
      ).toBe(true)
    }
  })

  test('concurrent adds and selection do not lose a host or select before its addition', async () => {
    const { repository, metadata } = setup()
    const [first, second, selected] = await Promise.all([
      repository.add(hostA, tokenA),
      repository.add(hostB, tokenB),
      repository.select(hostA.id),
    ])
    expect(first.hosts).toEqual([hostA])
    expect(second.hosts).toEqual([hostA, hostB])
    expect(selected).toEqual({
      version: 1,
      hosts: [hostA, hostB],
      selectedId: hostA.id,
    })
    expect(persisted(metadata)).toEqual(selected)
    expect(await repository.credential(hostA.id)).toBe(tokenA)
    expect(await repository.credential(hostB.id)).toBe(tokenB)
  })

  test('rejects a duplicate host without replacing its original credential', async () => {
    const { repository, metadata, secrets } = setup()
    await repository.add(hostA, tokenA)
    const before = metadata.values.get(registryKey)
    secrets.calls.length = 0
    await expect(
      repository.add({ ...hostA, name: '重复主机' }, 'replacement-token')
    ).rejects.toThrow('主机标识已存在')
    expect(metadata.values.get(registryKey)).toBe(before)
    expect(secrets.calls).toEqual([])
    expect(await repository.credential(hostA.id)).toBe(tokenA)
  })

  test('a failed credential write does not add metadata and the queue remains usable', async () => {
    const { repository, metadata, secrets } = setup()
    secrets.failNext('setItem', 'secret storage unavailable')
    await expect(repository.add(hostA, tokenA)).rejects.toThrow(
      'secret storage unavailable'
    )
    expect(metadata.values.size).toBe(0)
    expect(secrets.values.size).toBe(0)
    expect((await repository.add(hostB, tokenB)).hosts).toEqual([hostB])
  })

  test('a failed metadata add rolls back only the new credential and permits retry', async () => {
    const { repository, metadata, secrets } = setup()
    await repository.add(hostA, tokenA)
    const before = metadata.values.get(registryKey)
    metadata.failNext('setItem', 'metadata write failed')
    await expect(repository.add(hostB, tokenB)).rejects.toThrow(
      'metadata write failed'
    )
    expect(metadata.values.get(registryKey)).toBe(before)
    expect(secrets.values.get(credentialKey(hostA.id))).toBe(tokenA)
    expect(secrets.values.has(credentialKey(hostB.id))).toBe(false)
    expect((await repository.add(hostB, tokenB)).hosts).toEqual([hostA, hostB])
  })

  test('a failed selection leaves the selected host and both credentials intact', async () => {
    const { repository, metadata, secrets } = setup()
    await repository.add(hostA, tokenA)
    await repository.add(hostB, tokenB)
    metadata.failNext('setItem', 'selection write failed')
    await expect(repository.select(hostA.id)).rejects.toThrow(
      'selection write failed'
    )
    expect(persisted(metadata).selectedId).toBe(hostB.id)
    expect(secrets.values.get(credentialKey(hostA.id))).toBe(tokenA)
    expect(secrets.values.get(credentialKey(hostB.id))).toBe(tokenB)
    expect((await repository.select(hostA.id)).selectedId).toBe(hostA.id)
  })

  test('removal deletes only its target and preserves the other selected host', async () => {
    const { repository, metadata, secrets } = setup()
    await repository.add(hostA, tokenA)
    await repository.add(hostB, tokenB)
    secrets.values.set('unrelated-secret', 'unrelated-value')
    expect(await repository.remove(hostA.id)).toEqual({
      version: 1,
      hosts: [hostB],
      selectedId: hostB.id,
    })
    expect(persisted(metadata)).toEqual({
      version: 1,
      hosts: [hostB],
      selectedId: hostB.id,
    })
    expect(await repository.credential(hostA.id)).toBeNull()
    expect(await repository.credential(hostB.id)).toBe(tokenB)
    expect(secrets.values.get('unrelated-secret')).toBe('unrelated-value')
  })

  test('removing the selected host chooses the remaining host, then clears the last selection', async () => {
    const { repository, secrets } = setup()
    await repository.add(hostA, tokenA)
    await repository.add(hostB, tokenB)
    expect(await repository.remove(hostB.id)).toEqual({
      version: 1,
      hosts: [hostA],
      selectedId: hostA.id,
    })
    expect(await repository.credential(hostA.id)).toBe(tokenA)
    expect(await repository.remove(hostA.id)).toEqual({
      version: 1,
      hosts: [],
      selectedId: null,
    })
    expect(secrets.values.size).toBe(0)
  })

  test('failed credential removal preserves metadata and permits retry', async () => {
    const { repository, metadata, secrets } = setup()
    await repository.add(hostA, tokenA)
    const before = metadata.values.get(registryKey)
    secrets.failNext('removeItem', 'secret delete failed')
    await expect(repository.remove(hostA.id)).rejects.toThrow(
      'secret delete failed'
    )
    expect(metadata.values.get(registryKey)).toBe(before)
    expect(await repository.credential(hostA.id)).toBe(tokenA)
    expect((await repository.remove(hostA.id)).hosts).toEqual([])
  })

  test('failed metadata removal restores the target credential and preserves other hosts', async () => {
    const { repository, metadata } = setup()
    await repository.add(hostA, tokenA)
    await repository.add(hostB, tokenB)
    const before = metadata.values.get(registryKey)
    metadata.failNext('setItem', 'metadata delete failed')
    await expect(repository.remove(hostB.id)).rejects.toThrow(
      'metadata delete failed'
    )
    expect(metadata.values.get(registryKey)).toBe(before)
    expect(await repository.credential(hostB.id)).toBe(tokenB)
    expect(await repository.credential(hostA.id)).toBe(tokenA)
    expect((await repository.remove(hostB.id)).hosts).toEqual([hostA])
  })

  test('cancelling an add while queued never writes that host or its credential', async () => {
    const { repository, metadata, secrets } = setup()
    const pause = secrets.pauseAfterNext('setItem')
    const first = repository.add(hostA, tokenA)
    await pause.reached
    const controller = new AbortController()
    const cancelled = repository.add(hostB, tokenB, controller.signal).then(
      () => null,
      (error: unknown) => error
    )
    controller.abort()
    pause.release()
    await first
    expect(await cancelled).toBeInstanceOf(Error)

    expect(persisted(metadata)).toEqual({
      version: 1,
      hosts: [hostA],
      selectedId: hostA.id,
    })
    expect(await repository.credential(hostA.id)).toBe(tokenA)
    expect(await repository.credential(hostB.id)).toBeNull()
    expect(
      secrets.calls.filter(
        (call) =>
          call.operation === 'setItem' && call.key === credentialKey(hostB.id)
      )
    ).toEqual([])
    expect(
      metadata.calls
        .filter((call) => call.operation === 'setItem')
        .every((call) => !call.value!.includes(hostB.id))
    ).toBe(true)
    expect((await repository.add(hostB, tokenB)).hosts).toEqual([hostA, hostB])
  })

  test('cancelling during a credential write rolls it back without altering existing metadata', async () => {
    const { repository, metadata, secrets } = setup()
    await repository.add(hostA, tokenA)
    const before = metadata.values.get(registryKey)
    const pause = secrets.pauseAfterNext('setItem')
    const controller = new AbortController()
    const cancelled = repository.add(hostB, tokenB, controller.signal).then(
      () => null,
      (error: unknown) => error
    )
    await pause.reached
    const credentialWasWritten = secrets.values.get(credentialKey(hostB.id))
    controller.abort()
    pause.release()
    expect(await cancelled).toBeInstanceOf(Error)

    expect(credentialWasWritten).toBe(tokenB)
    expect(metadata.values.get(registryKey)).toBe(before)
    expect(await repository.credential(hostB.id)).toBeNull()
    expect(await repository.credential(hostA.id)).toBe(tokenA)
    expect((await repository.load()).hosts).toEqual([hostA])
    expect((await repository.add(hostB, tokenB)).hosts).toEqual([hostA, hostB])
  })

  test('cancelling during a metadata write restores both stores to their previous state', async () => {
    const { repository, metadata, secrets } = setup()
    await repository.add(hostA, tokenA)
    const before = metadata.values.get(registryKey)
    const pause = metadata.pauseAfterNext('setItem')
    const controller = new AbortController()
    const cancelled = repository.add(hostB, tokenB, controller.signal).then(
      () => null,
      (error: unknown) => error
    )
    await pause.reached
    const inFlight = persisted(metadata)
    const credentialWasWritten = secrets.values.get(credentialKey(hostB.id))
    controller.abort()
    pause.release()
    expect(await cancelled).toBeInstanceOf(Error)

    expect(inFlight).toEqual({
      version: 1,
      hosts: [hostA, hostB],
      selectedId: hostB.id,
    })
    expect(credentialWasWritten).toBe(tokenB)
    expect(metadata.values.get(registryKey)).toBe(before)
    expect(await repository.credential(hostB.id)).toBeNull()
    expect(await repository.credential(hostA.id)).toBe(tokenA)
    expect((await repository.load()).selectedId).toBe(hostA.id)
    expect((await repository.add(hostB, tokenB)).hosts).toEqual([hostA, hostB])
  })
})
