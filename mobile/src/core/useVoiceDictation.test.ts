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
      await h.start()
      await h.action(() => h.voice.stopAndSend())
      assert.equal(h.writes.length, 1)
      assert.equal(h.writes[0].text, '旧新内容草稿')
      assert.equal(h.frame.draft, '旧草稿', 'onDraft is a controlled parent update, not an immediate mutation')
      assert.deepEqual(h.sends, [], 'submitting before the parent render would send the old draft')
      await h.acceptDraft()
      assert.deepEqual(h.sends, [{ text: '旧新内容草稿', key: 'host:chat', delivery: 'sent' }])
      await h.update({ busy: true })
      assert.equal(h.sends.length, 1, 'an unrelated render must not submit a completed voice turn twice')
    } finally { await h.dispose() }
  `,
  lifecycle: `
    for (const event of ['blur', 'background']) {
      const h = await mount()
      try {
        h.fixture.recognition = deferred()
        await h.start()
        await h.action(() => h.voice.stopAndSend())
        assert.equal(h.voice.phase, 'transcribing')
        assert.equal(h.fixture.transcribeCalls.length, 1)
        await h.action(() => event === 'blur' ? blur() : appState('background'))
        assert.equal(h.fixture.transcribeCalls[0].signal.aborted, true)
        assert.equal(h.voice.phase, 'idle')
        h.fixture.recognition.resolve(transcript())
        await h.action(() => {})
        assert.deepEqual(h.writes, [], 'a late result cannot restore a composer after ' + event)
        assert.deepEqual(h.sends, [])
        assert.equal(h.voice.pendingText, null)
      } finally { await h.dispose() }
    }
  `,
  permission: `
    const h = await mount()
    try {
      h.fixture.permission = deferred()
      let started
      await h.action(() => { started = h.voice.start() })
      assert.equal(h.voice.phase, 'starting')
      assert.equal(h.fixture.recordCalls.length, 1)
      await h.action(() => appState('inactive'))
      assert.equal(h.fixture.recordCalls[0].signal.aborted, false, 'iOS permission UI must not cancel the request')
      assert.equal(h.fixture.cancelCalls, 0)
      h.fixture.permission.resolve(h.fixture.recording)
      await h.action(async () => { await started })
      assert.equal(h.voice.phase, 'recording')
      assert.equal(h.voice.getLevel(), 0.65)
      await h.action(() => appState('background'))
      assert.equal(h.fixture.recordCalls[0].signal.aborted, true)
      assert.equal(h.fixture.cancelCalls, 1)
      assert.equal(h.voice.phase, 'idle')
    } finally { await h.dispose() }

    const late = await mount()
    try {
      late.fixture.permission = deferred()
      let started
      await late.action(() => { started = late.voice.start() })
      await late.action(() => blur())
      late.fixture.permission.resolve(late.fixture.recording)
      await late.action(async () => { await started })
      assert.equal(late.fixture.cancelCalls, 1, 'a microphone acquired after leaving must be immediately released')
      assert.equal(late.fixture.transcribeCalls.length, 0)
      assert.equal(late.voice.phase, 'idle')
    } finally { await late.dispose() }
  `,
  androidPermission: `
    for (const granted of [true, false]) {
      const h = await mount()
      try {
        h.fixture.permission = deferred()
        let started
        await h.action(() => { started = h.voice.start() })
        await h.action(() => {
          h.fixture.recordCalls[0].onPermissionRequest?.(true)
          appState('background')
        })
        assert.equal(h.fixture.recordCalls[0].signal.aborted, false, 'the Android permission Activity must not cancel the pending request')
        assert.equal(h.voice.phase, 'starting')
        await h.action(async () => {
          appState('active')
          h.fixture.recordCalls[0].onPermissionRequest?.(false)
          if (granted) h.fixture.permission.resolve(h.fixture.recording)
          else h.fixture.permission.reject(Object.assign(new Error('denied'), { code: 'permission' }))
          await started
        })
        assert.equal(h.voice.phase, granted ? 'recording' : 'idle')
        assert.equal(h.voice.issue?.code, granted ? undefined : 'permission', 'denial must keep the settings feedback')
        if (granted) {
          await h.action(() => appState('background'))
          assert.equal(h.fixture.recordCalls[0].signal.aborted, true, 'leaving after the permission prompt still cancels recording')
        }
        assert.deepEqual(h.writes, [])
        assert.deepEqual(h.sends, [])
      } finally { await h.dispose() }
    }

    for (const event of ['cancel', 'blur', 'context']) {
      const h = await mount()
      try {
        h.fixture.permission = deferred()
        let started
        await h.action(() => { started = h.voice.start() })
        await h.action(() => {
          h.fixture.recordCalls[0].onPermissionRequest?.(true)
          appState('background')
        })
        if (event === 'context') await h.update({ contextKey: 'host:other' })
        else await h.action(() => event === 'cancel' ? h.voice.cancel() : blur())
        await h.action(async () => {
          appState('active')
          h.fixture.recordCalls[0].onPermissionRequest?.(false)
          h.fixture.permission.resolve(h.fixture.recording)
          await started
        })
        assert.equal(h.voice.phase, 'idle')
        assert.equal(h.fixture.recordCalls[0].signal.aborted, true, event + ' must still cancel the permission request')
        assert.equal(h.fixture.cancelCalls, 1)
        assert.deepEqual(h.sends, [])
      } finally { await h.dispose() }
    }

    const h = await mount()
    try {
      const first = deferred()
      h.fixture.permission = first
      let firstStart
      await h.action(() => { firstStart = h.voice.start() })
      const firstOptions = h.fixture.recordCalls[0]
      await h.action(() => { firstOptions.onPermissionRequest(true); h.voice.cancel() })
      h.fixture.permission = deferred()
      let secondStart
      await h.action(() => { secondStart = h.voice.start() })
      const secondOptions = h.fixture.recordCalls[1]
      await h.action(async () => {
        secondOptions.onPermissionRequest(true)
        firstOptions.onPermissionRequest(false)
        first.resolve(h.fixture.recording)
        await firstStart
        appState('background')
      })
      assert.equal(secondOptions.signal.aborted, false, 'a stale permission callback cannot clear the current request exemption')
      await h.action(async () => {
        appState('active')
        secondOptions.onPermissionRequest(false)
        h.fixture.permission.resolve(h.fixture.recording)
        await secondStart
      })
      assert.equal(h.voice.phase, 'recording')
      await h.action(() => appState('background'))
      assert.equal(secondOptions.signal.aborted, true)
    } finally { await h.dispose() }
  `,
  pendingSend: `
    for (const change of ['context', 'edit']) {
      const h = await mount()
      try {
        await h.start()
        await h.action(() => h.voice.stopAndSend())
        const written = h.writes[0].text
        assert.deepEqual(h.sends, [])
        if (change === 'context') await h.update({ contextKey: 'host:other', draft: '另一个会话' })
        else await h.action(() => { h.voice.edited(); h.setFrame(previous => ({ ...previous, draft: '手动修改' })) })
        await h.update({ draft: written })
        assert.deepEqual(h.sends, [], 'a pending send must not survive a ' + change + ' even if the text later matches')
      } finally { await h.dispose() }
    }

    const h = await mount()
    try {
      h.fixture.recognition = deferred()
      await h.start()
      await h.action(() => h.voice.stopAndSend())
      await h.action(() => h.voice.edited())
      h.fixture.recognition.resolve(transcript())
      await h.action(() => {})
      assert.deepEqual(h.writes, [], 'even a type-and-delete invalidates the captured caret')
      assert.equal(h.voice.pendingText, '新内容')
      await h.action(() => h.voice.insertPending())
      await h.acceptDraft()
      assert.deepEqual(h.sends, [], 'explicit insertion recovers text without resuming an old send request')
    } finally { await h.dispose() }
  `,
  busy: `
    const h = await mount({ busy: true, canSend: true, blocked: false })
    try {
      await h.start()
      assert.equal(h.voice.phase, 'recording')
      await h.action(() => h.voice.stopAndSend())
      assert.deepEqual(h.sends, [])
      await h.acceptDraft()
      assert.deepEqual(h.sends, [{ text: '旧新内容草稿', key: 'host:chat', delivery: 'queued' }])
      assert.equal(h.fixture.catalogCalls, 1)
      assert.equal(h.fixture.transcribeCalls.length, 1)
    } finally { await h.dispose() }
  `,
  destination: `
    for (const change of ['context', 'client', 'unmount']) {
      const h = await mount()
      let disposed = false
      try {
        h.fixture.recognition = deferred()
        await h.start()
        await h.action(() => h.voice.stopAndSend())
        if (change === 'unmount') { await h.dispose(); disposed = true }
        else if (change === 'context') await h.update({ contextKey: 'host:other', draft: '另一条草稿' })
        else await h.update({ client: { host: { id: 'other-host' } } })
        assert.equal(h.fixture.transcribeCalls[0].signal.aborted, true)
        h.fixture.recognition.resolve(transcript())
        await h.action(() => {})
        assert.deepEqual(h.writes, [], 'late transcription must not write after ' + change)
        assert.deepEqual(h.sends, [])
      } finally { if (!disposed) await h.dispose() }
    }
  `,
} as const

const harness = `
  import assert from 'node:assert/strict'
  import { mock } from 'bun:test'
  const React = require(${JSON.stringify(import.meta.resolve('react'))})
  // The root already depends on react-reconciler. Share the actual mobile React
  // instance with that renderer rather than replacing any React hook behavior.
  mock.module(${JSON.stringify(fileURLToPath(new URL('../../../node_modules/react/index.js', import.meta.url)))}, () => React)
  const createReconciler = require(${JSON.stringify(fileURLToPath(new URL('../../../node_modules/react-reconciler/index.js', import.meta.url)))})
  const { ConcurrentRoot, DefaultEventPriority } = require(${JSON.stringify(fileURLToPath(new URL('../../../node_modules/react-reconciler/constants.js', import.meta.url)))})
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = () => { throw new Error('Network is forbidden in the dictation hook test') }
  const noop = () => {}
  let priority = 0
  // Parent returns null: the renderer runs real state, layout, passive effects,
  // callbacks and unmounts, without a DOM or React Native implementation.
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
  const appListeners = new Set()
  const focusListeners = new Set()
  mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
    AppState: {
      addEventListener(kind, listener) {
        assert.equal(kind, 'change')
        appListeners.add(listener)
        return { remove: () => appListeners.delete(listener) }
      },
    },
  }))
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
  const appState = state => { for (const listener of appListeners) listener(state) }
  const transcript = () => ({ text: '新内容', audioSeconds: 0.5, inferenceSeconds: 0.1 })
  const catalog = {
    supported: true,
    preferences: { enabled: true, providerId: 'fixture-local', language: 'zh', downloadSource: 'auto' },
    providers: [{ info: { id: 'fixture-local', name: 'Fixture', location: 'local', languages: ['zh'] }, preparation: { phase: 'ready' } }],
    limits: { maxAudioSeconds: 120, maxAudioBytes: 4194304 },
  }
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  let activeFixture
  mock.module(${JSON.stringify(import.meta.resolve('./voiceApi'))}, () => ({
    loadVoiceCatalog: async (_client, signal) => {
      activeFixture.catalogCalls++
      assert.equal(signal.aborted, false)
      return catalog
    },
    transcribeVoice: async (client, bytes, options) => {
      const fixture = activeFixture
      fixture.transcribeCalls.push({ client, bytes, ...options })
      assert.equal(options.providerId, 'fixture-local')
      assert.equal(options.language, 'zh')
      assert.equal(bytes.length, 16044)
      return fixture.recognition ? fixture.recognition.promise : transcript()
    },
  }))
  mock.module(${JSON.stringify(import.meta.resolve('./voiceRecorder'))}, () => ({
    startVoiceRecording: async options => {
      const fixture = activeFixture
      fixture.recordCalls.push(options)
      return fixture.permission ? fixture.permission.promise : fixture.recording
    },
  }))
  const { useVoiceDictation } = await import(${JSON.stringify(import.meta.resolve('./useVoiceDictation'))})
  async function mount(overrides = {}) {
    const fixture = {
      catalogCalls: 0, recordCalls: [], transcribeCalls: [], cancelCalls: 0,
      permission: null, recognition: null,
    }
    fixture.recording = {
      getLevel: () => 0.65,
      stop: async () => ({ wav: new Uint8Array(16044), seconds: 0.5 }),
      cancel: () => { fixture.cancelCalls++ },
    }
    activeFixture = fixture
    const writes = [], sends = []
    let voice, frame, setFrame
    function Parent() {
      const [current, update] = React.useState({
        client: { host: { id: 'fixture-host' } }, contextKey: 'host:chat', draft: '旧草稿',
        selection: { start: 1, end: 1 }, blocked: false, canSend: true, busy: false, ...overrides,
      })
      frame = current
      setFrame = update
      voice = useVoiceDictation({
        ...current,
        onDraft: (text, cursor) => writes.push({ text, cursor }),
        onSubmit: () => sends.push({ text: current.draft, key: current.contextKey, delivery: current.busy ? 'queued' : 'sent' }),
        focus: noop,
      })
      return null
    }
    const reportError = error => { throw error }
    const root = renderer.createContainer({}, ConcurrentRoot, null, false, null, 'voice-hook', reportError, reportError, reportError, noop)
    await React.act(async () => { renderer.updateContainer(React.createElement(Parent), root, null, noop) })
    const action = async fn => {
      await React.act(async () => {
        await fn()
        for (let index = 0; index < 8; index++) await Promise.resolve()
      })
    }
    return {
      fixture, writes, sends,
      get voice() { return voice },
      get frame() { return frame },
      setFrame: value => setFrame(value),
      action,
      start: () => action(() => voice.start()),
      update: patch => action(() => setFrame(previous => ({ ...previous, ...patch }))),
      acceptDraft: () => action(() => {
        const written = writes.at(-1)
        assert.ok(written, 'a transcription must request a new draft')
        setFrame(previous => ({ ...previous, draft: written.text, selection: { start: written.cursor, end: written.cursor } }))
      }),
      dispose: async () => {
        await action(() => renderer.updateContainer(null, root, null, noop))
        assert.equal(appListeners.size, 0, 'unmount must remove the AppState listener')
        assert.equal(focusListeners.size, 0, 'unmount must remove the focus listener')
      },
    }
  }
`

test.each(Object.keys(cases) as (keyof typeof cases)[])('real dictation hook boundary: %s', scenario => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'mobile-dictation-hook-'))
  try {
    const result = spawnSync(process.execPath, ['--no-env-file', '-e', harness + cases[scenario]], {
      cwd: sandboxHome,
      env: { ...createSandboxedTestEnvironment(sandboxHome), NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 10000,
    })
    if (result.status !== 0) throw new Error(`Dictation hook ${scenario} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
    expect(result.status).toBe(0)
  } finally { removeTestSandbox(sandboxHome, 'dictation hook') }
}, 15000)
