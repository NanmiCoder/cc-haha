import { expect, test } from 'bun:test'
import { NETWORK_SETTLE_MS, watchNetwork, type NetworkSnapshot } from './networkWatcher'

function fixture(current?: () => Promise<NetworkSnapshot>) {
  let emit!: (state: NetworkSnapshot) => void
  let removed = false
  const jobs = new Map<number, () => void>()
  let id = 0
  const timers = {
    set: (callback: () => void, delay: number) => {
      expect(delay).toBe(NETWORK_SETTLE_MS)
      jobs.set(++id, callback)
      return id
    },
    clear: (handle: unknown) => {
      jobs.delete(handle as number)
    },
  }
  let changes = 0
  const stop = watchNetwork(
    (listener) => {
      emit = listener
      return { remove: () => { removed = true } }
    },
    () => changes++,
    timers,
    current
  )
  return {
    emit: (state: NetworkSnapshot) => emit(state),
    settle: () => {
      for (const [key, run] of [...jobs]) {
        jobs.delete(key)
        run()
      }
    },
    changes: () => changes,
    pending: () => jobs.size,
    stop,
    removed: () => removed,
  }
}

test('switching from Wi-Fi to cellular asks the session to check its connection once things settle', () => {
  const f = fixture()
  f.emit({ type: 'WIFI', isConnected: true })
  expect(f.pending()).toBe(0)
  f.emit({ type: 'CELLULAR', isConnected: true })
  f.emit({ type: 'CELLULAR', isConnected: true })
  expect(f.changes()).toBe(0)
  f.settle()
  expect(f.changes()).toBe(1)
})

test('losing the network waits; getting it back checks at once', () => {
  const f = fixture()
  f.emit({ type: 'WIFI', isConnected: true })
  f.emit({ type: 'NONE', isConnected: false })
  expect(f.pending()).toBe(0)
  f.emit({ type: 'WIFI', isConnected: true })
  f.settle()
  expect(f.changes()).toBe(1)
})

const settleReads = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('the first real change is noticed even though this listener never gets an initial report', async () => {
  // Another part of the app subscribed first: the native observer is already running and
  // does not repeat the current state, so the only event this listener sees is the change.
  const f = fixture(async () => ({ type: 'WIFI', isConnected: true }))
  await settleReads()
  f.emit({ type: 'CELLULAR', isConnected: true })
  f.settle()
  expect(f.changes()).toBe(1)
})

test('an initial report that only repeats the current state is not a change', async () => {
  let read!: (state: NetworkSnapshot) => void
  const f = fixture(() => new Promise((resolve) => { read = resolve }))
  f.emit({ type: 'WIFI', isConnected: true })
  read({ type: 'WIFI', isConnected: true })
  await settleReads()
  f.settle()
  expect(f.changes()).toBe(0)
  f.emit({ type: 'CELLULAR', isConnected: true })
  f.settle()
  expect(f.changes()).toBe(1)
})

test('a change reported before the current state could be read still counts', async () => {
  let read!: (state: NetworkSnapshot) => void
  const f = fixture(() => new Promise((resolve) => { read = resolve }))
  f.emit({ type: 'CELLULAR', isConnected: true })
  read({ type: 'WIFI', isConnected: true })
  await settleReads()
  f.settle()
  expect(f.changes()).toBe(1)
})

test('a burst of reports collapses into one check, and stopping cancels it', () => {
  const f = fixture()
  f.emit({ type: 'WIFI', isConnected: true })
  f.emit({ type: 'CELLULAR', isConnected: true })
  f.emit({ type: 'WIFI', isConnected: true })
  expect(f.pending()).toBe(1)
  f.stop()
  expect(f.pending()).toBe(0)
  expect(f.removed()).toBe(true)
  expect(f.changes()).toBe(0)
})
