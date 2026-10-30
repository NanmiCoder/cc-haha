import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('image probes ignore stale callbacks, do not loop and can retry a timeout or load failure', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let state = [], effects = [], queued = [], cursor = 0, updates = 0
    const loads = [], timers = new Map()
    let timerId = 0
    globalThis.setTimeout = fn => { timers.set(++timerId, fn); return timerId }
    globalThis.clearTimeout = id => timers.delete(id)
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState: initial => {
        const slot = cursor++
        if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
        return [state[slot], value => { updates++; state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
      },
      useEffect: (fn, deps) => {
        const slot = cursor++
        const previous = effects[slot]
        if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
          previous?.cleanup?.()
          queued.push(() => { effects[slot] = { deps, cleanup: fn() } })
        }
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: { getSize: (uri, ok, failed) => { if (uri === 'throws') throw Error('unreadable'); loads.push({ uri, ok, failed }) } },
    }))
    const { useImagePreviewStatus } = require(${JSON.stringify(import.meta.resolve('./imagePreviewStatus'))})
    const render = uri => {
      cursor = 0
      const value = useImagePreviewStatus(uri)
      const pending = queued; queued = []; pending.forEach(fn => fn())
      return value
    }
    let result = render('first')
    assert.equal(result.failed, false)
    render('first')
    assert.equal(loads.length, 1, 'a state update must not trigger another load')
    loads[0].failed()
    result = render('first')
    assert.equal(result.failed, true)
    result.retry()
    result = render('first')
    assert.equal(result.failed, false)
    assert.equal(loads.length, 2)
    loads[0].failed()
    assert.equal(render('first').failed, false, 'the previous attempt is no longer current')
    loads[1].ok(1280, 960)
    assert.equal(render('first').failed, false)
    assert.equal(timers.size, 0)
    render('second')
    loads[1].failed()
    assert.equal(render('second').failed, false, 'old image callback must not fail a newly selected image')
    ;[...timers.values()][0]()
    result = render('second')
    assert.equal(result.failed, true, 'no callback must produce a recoverable timeout')
    result.retry()
    render('second')
    loads.at(-1).ok(0, 0)
    assert.equal(render('second').failed, true, 'zero dimensions are a failed image')
    render('throws')
    assert.equal(render('throws').failed, true)
    effects.forEach(effect => effect?.cleanup?.())
    const before = updates
    loads.at(-1).ok(100, 100)
    assert.equal(updates, before, 'unmounted preview must not update state')
    assert.equal(timers.size, 0)
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
