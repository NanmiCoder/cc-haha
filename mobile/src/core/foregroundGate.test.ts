import { expect, test } from 'bun:test'
import { ForegroundGate, type GateTimers } from './foregroundGate'

function timers() {
  const jobs = new Map<number, () => void>()
  let id = 0
  const fake: GateTimers & { fire(): void; size(): number } = {
    set: (callback) => {
      jobs.set(++id, callback)
      return id
    },
    clear: (handle) => {
      jobs.delete(handle as number)
    },
    fire: () => {
      for (const [key, run] of [...jobs]) {
        jobs.delete(key)
        run()
      }
    },
    size: () => jobs.size,
  }
  return fake
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('an idle gate lets work through at once', async () => {
  const gate = new ForegroundGate(timers())
  let done = false
  void gate.whenIdle(1000).then(() => (done = true))
  await flush()
  expect(done).toBe(true)
})

test('waiters wake when the last hold is released, and their timers are cleared', async () => {
  const clock = timers()
  const gate = new ForegroundGate(clock)
  const first = gate.hold()
  const second = gate.hold()
  let done = false
  void gate.whenIdle(1000).then(() => (done = true))
  first()
  first()
  await flush()
  expect(done).toBe(false)
  second()
  await flush()
  expect(done).toBe(true)
  expect(gate.busy).toBe(false)
  expect(clock.size()).toBe(0)
})

test('a hold that never ends cannot block waiters past their cap', async () => {
  const clock = timers()
  const gate = new ForegroundGate(clock)
  gate.hold()
  let done = false
  void gate.whenIdle(1000).then(() => (done = true))
  await flush()
  expect(done).toBe(false)
  clock.fire()
  await flush()
  expect(done).toBe(true)
})
