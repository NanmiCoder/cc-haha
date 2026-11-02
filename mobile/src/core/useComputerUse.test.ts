import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('per-message selection reuses consent, waits for successful activation and ignores cancellation or unmount', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, dirty = false, slots = [], effects = []
    const same = (a, b) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const id = cursor++
        if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
        return [slots[id], next => { const value = typeof next === 'function' ? next(slots[id]) : next; if (!Object.is(value, slots[id])) { slots[id] = value; dirty = true } }]
      },
      useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial }; return slots[id] },
      useCallback(fn, deps) { const id = cursor++; if (!slots[id] || !same(slots[id].deps, deps)) slots[id] = { deps, value: fn }; return slots[id].value },
      useEffect(fn, deps) {
        const id = cursor++
        if (!slots[id] || !same(slots[id].deps, deps)) {
          const previous = slots[id]
          slots[id] = { deps }
          effects.push(() => { previous?.cleanup?.(); slots[id].cleanup = fn() })
        }
      },
    }))
    let remote = { supported: true, enabled: true }, writes = 0, fail = false, blocked
    mock.module(${JSON.stringify(import.meta.resolve('./computerUse'))}, () => ({
      loadComposerComputerUse: async () => ({ ...remote }), needsComputerPermission: () => false,
      setComposerComputerUse: async (_client, enabled) => {
        writes++
        if (fail) throw Error('fixture activation failed')
        if (blocked) await blocked
        remote = { ...remote, enabled }
      },
      openComputerPermissionCard: async () => ({ ...remote }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../ui/theme'))}, () => ({ errorText: error => error.message }))
    const { useComputerUse } = require(${JSON.stringify(import.meta.resolve('./useComputerUse'))})
    const client = {}
    let computer, selections = 0
    async function settle() {
      for (let round = 0; round < 12; round++) {
        cursor = 0; dirty = false
        computer = useComputerUse(client)
        const pending = effects; effects = []; pending.forEach(fn => fn())
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
        if (!dirty && !effects.length) return
      }
      assert.fail('hook did not settle')
    }
    await settle()
    computer.selectForMessage(() => selections++)
    assert.equal(selections, 1)
    assert.equal(writes, 0, 'already-consented selection must not write global configuration or open another consent')
    assert.equal(computer.consentOpen, false)
    remote.enabled = false
    computer.refresh(); await settle()
    computer.selectForMessage(() => selections++)
    await settle()
    assert.equal(computer.consentOpen, true)
    assert.equal(selections, 1)
    assert.equal(writes, 0)
    computer.cancelConsent(); await settle()
    assert.equal(computer.consentOpen, false)
    assert.equal(selections, 1)
    computer.selectForMessage(() => selections++)
    await settle()
    fail = true
    computer.confirmConsent(); await settle()
    assert.equal(selections, 1, 'failed activation must never arm the message')
    assert.equal(computer.enabled, false)
    assert.equal(computer.consentOpen, true)
    assert.equal(computer.error, 'fixture activation failed')
    fail = false
    computer.confirmConsent(); await settle()
    assert.equal(selections, 2)
    assert.equal(computer.enabled, true)
    assert.equal(computer.consentOpen, false)
    computer.selectForMessage(() => selections++)
    assert.equal(selections, 3)
    assert.equal(writes, 2)
    remote.enabled = false
    computer.refresh(); await settle()
    let unblock
    blocked = new Promise(resolve => { unblock = resolve })
    computer.selectForMessage(() => selections++)
    await settle()
    computer.confirmConsent(); await settle()
    slots.forEach(slot => slot?.cleanup?.())
    unblock()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(selections, 3, 'leaving the screen must cancel its deferred per-message selection')
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
