import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../../scripts/pr/test-environment'

const cases = {
  controlled: `
    const h = await mount()
    try {
      await h.action(() => h.optimize.optimize())
      assert.equal(h.writes.length, 1)
      assert.equal(h.writes[0], '优化后的提示词')
      assert.equal(h.frame.draft, '旧草稿', 'controlled parent has not rendered the new draft yet')
      assert.deepEqual(h.optimize.restoreSnapshot, { id: 1, text: '旧草稿' }, 'restore bar must survive until controlled draft lands')
      assert.equal(h.focuses, 1)

      await h.acceptDraft()
      assert.equal(h.frame.draft, '优化后的提示词')
      assert.deepEqual(h.optimize.restoreSnapshot, { id: 1, text: '旧草稿' }, 'accepting our own write must keep the restore snapshot')

      await h.action(() => h.optimize.restore())
      assert.equal(h.writes.at(-1), '旧草稿')
      assert.equal(h.optimize.restoreSnapshot, null)
      await h.acceptDraft()
      assert.equal(h.frame.draft, '旧草稿')
    } finally { await h.dispose() }
  `,
  externalEdit: `
    const h = await mount()
    try {
      h.fixture.pending = deferred()
      await h.action(() => h.optimize.optimize())
      assert.equal(h.optimize.optimizing, true)
      assert.equal(h.fixture.optimizeCalls.length, 1)

      // External draft change (e.g. BringSheet / CandidateCard / withdrawQueued)
      // commits without calling edited(); useLayoutEffect must synchronously abort.
      await h.update({ draft: '外部插入的草稿' })
      assert.equal(h.optimize.optimizing, false)
      assert.equal(h.fixture.optimizeCalls[0].signal.aborted, true)
      assert.equal(h.fixture.cancelCalls.length, 1)

      h.fixture.pending.resolve({ requestId: 'req-1', optimizedPrompt: '过期的优化结果' })
      await h.action(() => {})
      assert.deepEqual(h.writes, [], 'late response must never overwrite an externally updated draft')
      assert.equal(h.optimize.restoreSnapshot, null)
      assert.equal(h.focuses, 0)
    } finally { await h.dispose() }

    // Blocking the composer mid-flight also rejects a late response.
    const b = await mount()
    try {
      b.fixture.pending = deferred()
      await b.action(() => b.optimize.optimize())
      await b.update({ blocked: true })
      b.fixture.pending.resolve({ requestId: 'req-1', optimizedPrompt: '阻塞期间的结果' })
      await b.action(() => {})
      assert.deepEqual(b.writes, [])
      assert.equal(b.optimize.restoreSnapshot, null)
    } finally { await b.dispose() }
  `,
  blur: `
    const h = await mount()
    try {
      h.fixture.pending = deferred()
      await h.action(() => h.optimize.optimize())
      assert.equal(h.optimize.optimizing, true)

      await h.action(() => blur())
      assert.equal(h.optimize.optimizing, false)
      assert.equal(h.fixture.optimizeCalls[0].signal.aborted, true)
      assert.equal(h.fixture.cancelCalls.length, 1)

      h.fixture.pending.resolve({ requestId: 'req-1', optimizedPrompt: '后台返回的结果' })
      await h.action(() => {})
      assert.deepEqual(h.writes, [], 'blurred screen must not mutate draft offscreen')
      assert.equal(h.focuses, 0, 'blurred screen must not focus offscreen TextInput')
      assert.equal(h.optimize.restoreSnapshot, null)
    } finally { await h.dispose() }
  `,
  destination: `
    for (const change of ['context', 'client', 'clientNull', 'unmount']) {
      const h = await mount()
      let disposed = false
      const originalClient = h.frame.client
      try {
        h.fixture.pending = deferred()
        await h.action(() => h.optimize.optimize())
        assert.equal(h.optimize.optimizing, true)

        if (change === 'unmount') { await h.dispose(); disposed = true }
        else if (change === 'context') await h.update({ contextKey: 'host:other', sessionId: 'other', draft: '另一个会话' })
        else if (change === 'client') await h.update({ client: { host: { id: 'other-host' } } })
        else await h.update({ client: null })

        assert.equal(h.fixture.optimizeCalls[0].signal.aborted, true)
        assert.equal(h.fixture.cancelCalls.length, 1, 'cancel must fire on ' + change)
        assert.equal(h.fixture.cancelCalls[0].client, originalClient, 'cancel must target the originating client on ' + change)

        h.fixture.pending.resolve({ requestId: 'req-1', optimizedPrompt: '切换后的过期结果' })
        await h.action(() => {})
        assert.deepEqual(h.writes, [], 'late response must not write after ' + change)
      } finally { if (!disposed) await h.dispose() }
    }
  `,
} as const

const harness = `
  import assert from 'node:assert/strict'
  import { mock } from 'bun:test'
  const React = require(${JSON.stringify(import.meta.resolve('react'))})
  mock.module(${JSON.stringify(fileURLToPath(new URL('../../../node_modules/react/index.js', import.meta.url)))}, () => React)
  const createReconciler = require(${JSON.stringify(fileURLToPath(new URL('../../../node_modules/react-reconciler/index.js', import.meta.url)))})
  const { ConcurrentRoot, DefaultEventPriority } = require(${JSON.stringify(fileURLToPath(new URL('../../../node_modules/react-reconciler/constants.js', import.meta.url)))})
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = () => { throw new Error('Network is forbidden in the prompt optimize hook test') }
  const noop = () => {}
  let priority = 0
  const renderer = createReconciler({
    supportsMutation: true, supportsPersistence: false, supportsHydration: false, isPrimaryRenderer: true,
    getRootHostContext: () => ({}), getChildHostContext: () => ({}), getPublicInstance: value => value,
    prepareForCommit: () => null, resetAfterCommit: noop, preparePortalMount: noop, clearContainer: noop,
    shouldSetTextContent: () => false, createInstance: () => ({}), createTextInstance: () => ({}),
    appendInitialChild: noop, finalizeInitialChildren: () => false, appendChild: noop,
    appendChildToContainer: noop, removeChild: noop, removeChildFromContainer: noop,
    insertBefore: noop, insertInContainerBefore: noop, commitUpdate: noop, commitTextUpdate: noop,
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
    supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
    getCurrentUpdatePriority: () => priority, setCurrentUpdatePriority: value => { priority = value },
    resolveUpdatePriority: () => priority || DefaultEventPriority,
    maySuspendCommit: () => false, preloadInstance: () => true, startSuspendingCommit: noop,
    suspendInstance: noop, waitForCommitToBeReady: () => null,
    NotPendingTransition: null, HostTransitionContext: React.createContext(null),
    resetFormInstance: noop, requestPostPaintCallback: noop, shouldAttemptEagerTransition: () => false,
    trackSchedulerEvent: noop, resolveEventType: () => null, resolveEventTimeStamp: () => -1.1,
    detachDeletedInstance: noop,
  })
  const focusListeners = new Set()
  mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({
    useFocusEffect(effect) {
      React.useEffect(() => {
        const entry = { cleanup: effect() }
        focusListeners.add(entry)
        return () => { focusListeners.delete(entry); entry.cleanup?.() }
      }, [effect])
    },
  }))
  const blur = () => {
    for (const entry of focusListeners) {
      entry.cleanup?.()
      entry.cleanup = undefined
    }
  }
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  let activeFixture
  mock.module(${JSON.stringify(import.meta.resolve('./promptOptimizeApi'))}, () => ({
    optimizePrompt: async (client, sessionId, body, signal) => {
      const fixture = activeFixture
      fixture.optimizeCalls.push({ client, sessionId, body, signal })
      return fixture.pending ? fixture.pending.promise : { requestId: body.requestId, optimizedPrompt: '优化后的提示词' }
    },
    cancelOptimizePrompt: async (client, sessionId, requestId) => {
      const fixture = activeFixture
      fixture.cancelCalls.push({ client, sessionId, requestId })
      return { requestId, cancelled: true }
    },
  }))
  const { usePromptOptimize } = await import(${JSON.stringify(import.meta.resolve('./usePromptOptimize'))})
  async function mount(overrides = {}) {
    const fixture = { optimizeCalls: [], cancelCalls: [], pending: null }
    activeFixture = fixture
    const writes = []
    let focuses = 0
    let optimize, frame, setFrame
    function Parent() {
      const [current, update] = React.useState({
        client: { host: { id: 'fixture-host' } },
        sessionId: 'chat-1',
        contextKey: 'host:chat-1',
        draft: '旧草稿',
        blocked: false,
        ...overrides,
      })
      frame = current
      setFrame = update
      optimize = usePromptOptimize({
        ...current,
        onDraft: text => writes.push(text),
        focus: () => { focuses++ },
        newRequestId: () => '00000000-0000-4000-8000-000000000001',
      })
      return null
    }
    const reportError = error => { throw error }
    const root = renderer.createContainer({}, ConcurrentRoot, null, false, null, 'prompt-optimize-hook', reportError, reportError, reportError, noop)
    await React.act(async () => { renderer.updateContainer(React.createElement(Parent), root, null, noop) })
    const action = async fn => {
      await React.act(async () => {
        await fn()
        for (let index = 0; index < 8; index++) await Promise.resolve()
      })
    }
    return {
      fixture, writes,
      get focuses() { return focuses },
      get optimize() { return optimize },
      get frame() { return frame },
      action,
      update: patch => action(() => setFrame(previous => ({ ...previous, ...patch }))),
      acceptDraft: () => action(() => {
        const written = writes.at(-1)
        assert.ok(written !== undefined)
        setFrame(previous => ({ ...previous, draft: written }))
      }),
      dispose: async () => {
        await action(() => renderer.updateContainer(null, root, null, noop))
        assert.equal(focusListeners.size, 0, 'unmount must remove the focus listener')
      },
    }
  }
`

test.each(Object.keys(cases) as (keyof typeof cases)[])('real prompt optimize hook boundary: %s', scenario => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'mobile-prompt-optimize-hook-'))
  try {
    const result = spawnSync(process.execPath, ['--no-env-file', '-e', harness + cases[scenario]], {
      cwd: sandboxHome,
      env: { ...createSandboxedTestEnvironment(sandboxHome), NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 10000,
    })
    if (result.status !== 0) {
      throw new Error(`PromptOptimize hook ${scenario} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
    }
    expect(result.status).toBe(0)
  } finally {
    removeTestSandbox(sandboxHome, 'prompt optimize hook')
  }
}, 15000)
