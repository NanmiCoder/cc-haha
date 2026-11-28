import { afterEach, describe, expect, test } from 'bun:test'
import { __resetNativeCardState, maybeShowNativePermissionCard } from './nativePermissionCard.js'

afterEach(() => __resetNativeCardState())

type Handlers = Record<string, (...a: unknown[]) => void>

function fakeChild() {
  const handlers: Handlers = {}
  return {
    on(ev: string, cb: (...a: unknown[]) => void) {
      handlers[ev] = cb
    },
    unref() {},
    handlers,
  }
}

describe('maybeShowNativePermissionCard', () => {
  test('is a no-op off macOS', () => {
    let spawned = 0
    maybeShowNativePermissionCard(undefined, {
      platform: 'win32',
      resolveBin: () => '/x/cu-helper',
      spawnFn: (() => { spawned++; return fakeChild() }) as never,
    })
    expect(spawned).toBe(0)
  })

  test('is a no-op when the binary is missing', () => {
    let spawned = 0
    maybeShowNativePermissionCard(undefined, {
      platform: 'darwin',
      resolveBin: () => null,
      spawnFn: (() => { spawned++; return fakeChild() }) as never,
    })
    expect(spawned).toBe(0)
  })

  test('spawns `cu-helper request-access` on macOS when available', () => {
    let captured: { bin: string; args: string[] } | undefined
    maybeShowNativePermissionCard(undefined, {
      platform: 'darwin',
      resolveBin: () => '/x/cu-helper',
      now: () => 1000,
      spawnFn: ((bin: string, args: string[]) => {
        captured = { bin, args }
        return fakeChild()
      }) as never,
    })
    expect(captured?.bin).toBe('/x/cu-helper')
    expect(captured?.args).toEqual(['request-access'])
  })

  test('debounces while a card is already in flight', () => {
    let spawned = 0
    const deps = {
      platform: 'darwin' as const,
      resolveBin: () => '/x/cu-helper',
      now: () => 1000,
      spawnFn: (() => { spawned++; return fakeChild() }) as never,
    }
    maybeShowNativePermissionCard(undefined, deps)
    maybeShowNativePermissionCard(undefined, deps) // still in flight → skipped
    expect(spawned).toBe(1)
  })

  test('cooldown blocks re-show until it elapses', () => {
    let spawned = 0
    let lastChild = fakeChild()
    const spawnFn = (() => { spawned++; lastChild = fakeChild(); return lastChild }) as never
    const base = { platform: 'darwin' as const, resolveBin: () => '/x/cu-helper', spawnFn }

    maybeShowNativePermissionCard(undefined, { ...base, now: () => 1000 })
    expect(spawned).toBe(1)

    lastChild.handlers.exit?.() // user closed the card → no longer in flight

    maybeShowNativePermissionCard(undefined, { ...base, now: () => 1000 + 5_000 }) // within cooldown
    expect(spawned).toBe(1)

    maybeShowNativePermissionCard(undefined, { ...base, now: () => 1000 + 20_000 }) // after cooldown
    expect(spawned).toBe(2)
  })

  test('supports async binary resolution and debounces concurrent triggers while resolving', async () => {
    let spawned = 0
    let resolveBinPromise!: (value: string | null) => void
    const binPromise = new Promise<string | null>(resolve => { resolveBinPromise = resolve })
    const deps = {
      platform: 'darwin' as const,
      resolveBin: () => binPromise,
      now: () => 1000,
      spawnFn: (() => { spawned++; return fakeChild() }) as never,
    }
    maybeShowNativePermissionCard(undefined, deps)
    maybeShowNativePermissionCard(undefined, deps)
    expect(spawned).toBe(0)
    resolveBinPromise('/x/cu-helper')
    await binPromise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(spawned).toBe(1)
  })
})
