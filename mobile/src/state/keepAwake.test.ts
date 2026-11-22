import { describe, expect, test } from 'bun:test'
import {
  KEEP_AWAKE_TAG,
  KeepAwakeController,
  isKeepAwakeAvailable,
} from './keepAwake'

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('keep awake availability', () => {
  test('is always available on native platforms and gated by Wake Lock API on web', () => {
    expect(isKeepAwakeAvailable('android', undefined)).toBe(true)
    expect(isKeepAwakeAvailable('ios', undefined)).toBe(true)
    expect(isKeepAwakeAvailable('web', undefined)).toBe(false)
    expect(isKeepAwakeAvailable('web', {})).toBe(false)
    expect(isKeepAwakeAvailable('web', { wakeLock: { request() {} } })).toBe(true)
  })
})

describe('KeepAwakeController', () => {
  test('activates only when enabled and in the foreground, and releases on disable', async () => {
    const events: string[] = []
    const controller = new KeepAwakeController({
      activate: async (tag) => {
        events.push(`activate:${tag}`)
      },
      deactivate: async (tag) => {
        events.push(`deactivate:${tag}`)
      },
    })
    controller.setForeground(true)
    await flush()
    expect(events).toEqual([])
    expect(controller.active).toBe(false)

    controller.setEnabled(true)
    await flush()
    expect(events).toEqual([`activate:${KEEP_AWAKE_TAG}`])
    expect(controller.active).toBe(true)

    controller.setEnabled(false)
    await flush()
    expect(events).toEqual([`activate:${KEEP_AWAKE_TAG}`, `deactivate:${KEEP_AWAKE_TAG}`])
    expect(controller.active).toBe(false)
  })

  test('releases when backgrounded and re-acquires when returning to foreground', async () => {
    const events: string[] = []
    const controller = new KeepAwakeController({
      activate: async () => {
        events.push('activate')
      },
      deactivate: async () => {
        events.push('deactivate')
      },
    })
    controller.setEnabled(true)
    await flush()
    // Enabling while backgrounded does not acquire yet.
    expect(events).toEqual([])

    controller.setForeground(true)
    await flush()
    expect(events).toEqual(['activate'])
    expect(controller.active).toBe(true)

    controller.setForeground(false)
    await flush()
    expect(events).toEqual(['activate', 'deactivate'])
    expect(controller.active).toBe(false)

    controller.setForeground(true)
    await flush()
    expect(events).toEqual(['activate', 'deactivate', 'activate'])
    expect(controller.active).toBe(true)
  })

  test('cancels an in-flight activation without leaking the lock if disabled or backgrounded mid-flight', async () => {
    const pending = deferred()
    const events: string[] = []
    const controller = new KeepAwakeController({
      activate: async () => {
        events.push('activate:start')
        await pending.promise
        events.push('activate:done')
      },
      deactivate: async () => {
        events.push('deactivate')
      },
    })
    controller.setForeground(true)
    controller.setEnabled(true)
    await flush()
    expect(events).toEqual(['activate:start'])

    controller.setForeground(false)
    await flush()
    // Deactivate waits until the serialized activation finishes.
    expect(events).toEqual(['activate:start'])

    pending.resolve()
    await flush()
    expect(events).toEqual(['activate:start', 'activate:done', 'deactivate'])
    expect(controller.active).toBe(false)
  })

  test('absorbs platform failures without looping and retries on the next foreground return', async () => {
    let fail = true
    let attempts = 0
    const controller = new KeepAwakeController({
      activate: async () => {
        attempts++
        if (fail) throw new Error('Activity unavailable')
      },
      deactivate: async () => {
        throw new Error('Already released')
      },
    })
    controller.setForeground(true)
    controller.setEnabled(true)
    await flush()
    expect(attempts).toBe(1)
    expect(controller.active).toBe(false)

    fail = false
    controller.setForeground(false)
    controller.setForeground(true)
    await flush()
    expect(attempts).toBe(2)
    expect(controller.active).toBe(true)

    controller.dispose()
    await flush()
    expect(controller.active).toBe(false)
    controller.setEnabled(true)
    await flush()
    expect(attempts).toBe(2)
  })
})
