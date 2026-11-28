import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('useBrowserUse reuses consent when enabled, activates with consent when off, handles 403/404 and rolls back target save failures', () => {
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
    let remote = { enabled: true, preferredTarget: 'workspace' }, writes = 0, failEnable = false, failTarget = false, loadError = null, blocked
    mock.module(${JSON.stringify(import.meta.resolve('./browserUse'))}, () => ({
      loadComposerBrowserUse: async () => {
        if (loadError) throw loadError
        return { ...remote }
      },
      enableComposerBrowserUse: async () => {
        writes++
        if (failEnable) throw Error('fixture enable failed')
        if (blocked) await blocked
        remote = { ...remote, enabled: true }
        return { ...remote }
      },
      setComposerBrowserUseTarget: async (_client, preferredTarget) => {
        writes++
        if (failTarget) throw Error('fixture target failed')
        remote = { ...remote, preferredTarget }
        return { ...remote }
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../ui/theme'))}, () => ({ errorText: error => error.message }))
    const { useBrowserUse } = require(${JSON.stringify(import.meta.resolve('./useBrowserUse'))})
    const clientA = {}
    const clientB = {}
    let currentClient = clientA
    let browser, selections = 0
    async function settle() {
      for (let round = 0; round < 12; round++) {
        cursor = 0; dirty = false
        browser = useBrowserUse(currentClient)
        const pending = effects; effects = []; pending.forEach(fn => fn())
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
        if (!dirty && !effects.length) return
      }
      assert.fail('hook did not settle')
    }
    await settle()
    assert.equal(browser.available, true)
    assert.equal(browser.enabled, true)
    assert.equal(browser.preferredTarget, 'workspace')

    // Already-enabled host selects immediately without writing global config
    browser.selectForMessage(() => selections++)
    assert.equal(selections, 1)
    assert.equal(writes, 0)
    assert.equal(browser.consentOpen, false)

    // Target change persists and rolls back on failure
    browser.setTarget('chrome'); await settle()
    assert.equal(browser.preferredTarget, 'chrome')
    assert.equal(writes, 1)
    failTarget = true
    browser.setTarget('auto'); await settle()
    assert.equal(browser.preferredTarget, 'chrome', 'failed target update must roll back')
    assert.equal(browser.error, 'fixture target failed')
    failTarget = false

    // Disabled host opens consent dialog and waits for confirmation
    remote.enabled = false
    browser.refresh(); await settle()
    browser.selectForMessage(() => selections++)
    await settle()
    assert.equal(browser.consentOpen, true)
    assert.equal(selections, 1)
    browser.cancelConsent(); await settle()
    assert.equal(browser.consentOpen, false)

    browser.selectForMessage(() => selections++)
    await settle()
    failEnable = true
    browser.confirmConsent(); await settle()
    assert.equal(selections, 1, 'failed activation must not arm the message')
    assert.equal(browser.consentOpen, true)
    assert.equal(browser.error, 'fixture enable failed')

    // Cancelling after an enable failure clears the error instead of leaking it inline
    browser.cancelConsent(); await settle()
    assert.equal(browser.consentOpen, false)
    assert.equal(browser.error, '')

    // Changing client while consent is open closes consent and clears pendingSelection
    browser.selectForMessage(() => selections++)
    await settle()
    assert.equal(browser.consentOpen, true)
    currentClient = clientB
    await settle()
    assert.equal(browser.consentOpen, false)
    assert.equal(selections, 1)

    browser.selectForMessage(() => selections++)
    await settle()
    failEnable = false
    browser.confirmConsent(); await settle()
    assert.equal(selections, 2)
    assert.equal(browser.enabled, true)
    assert.equal(browser.consentOpen, false)

    // 403/404 from an older desktop host marks available=false without error noise
    loadError = Object.assign(new Error('Desktop-only capability'), { status: 403 })
    browser.refresh(); await settle()
    assert.equal(browser.available, false)
    assert.equal(browser.error, '')
    loadError = null

    // Unmount cancels deferred selection
    remote.enabled = false
    browser.refresh(); await settle()
    let unblock
    blocked = new Promise(resolve => { unblock = resolve })
    browser.selectForMessage(() => selections++)
    await settle()
    browser.confirmConsent(); await settle()
    slots.forEach(slot => slot?.cleanup?.())
    unblock()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(selections, 2, 'unmounting must cancel pending per-message selection')
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
