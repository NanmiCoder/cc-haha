import { describe, expect, it } from 'bun:test'
import { restoreStoredSessionBinding } from '../session-recovery.js'
import type { SessionEntry } from '../session-store.js'

function makeStore(initial: SessionEntry | null) {
  let entry = initial
  return {
    get() {
      return entry
    },
    delete() {
      entry = null
    },
    current() {
      return entry
    },
  }
}

function makeBridge(options?: { currentSessionId?: string | null; open?: boolean; hasSession?: boolean }) {
  const calls: string[] = []
  const bridge = {
    calls,
    connectSession(_chatId: string, sessionId: string) {
      calls.push(`connect:${sessionId}`)
      return true
    },
    getSessionId() {
      return options?.currentSessionId ?? null
    },
    hasSession() {
      return options?.hasSession ?? Boolean(options?.currentSessionId)
    },
    isSessionOpen(_chatId: string, sessionId?: string) {
      return Boolean(options?.open && (!sessionId || sessionId === options?.currentSessionId))
    },
    onServerMessage() {
      calls.push('handler')
    },
    resetSession() {
      calls.push('reset')
    },
    waitForOpen() {
      calls.push('wait')
      return Promise.resolve(true)
    },
  }
  return bridge
}

describe('restoreStoredSessionBinding', () => {
  it.each(['timeout', 'connect error', 'wait error'])('preserves the binding and transient state after a %s', async (failure) => {
    const entry = { sessionId: 'stored-session', workDir: '/original-project', updatedAt: 1 }
    const store = makeStore(entry)
    const bridge = makeBridge()
    const connect = bridge.connectSession
    const wait = bridge.waitForOpen
    if (failure === 'connect error') bridge.connectSession = () => { throw new Error('connect failed') }
    else bridge.waitForOpen = async () => {
      if (failure === 'wait error') throw new Error('wait failed')
      return false
    }
    let cleared = 0
    const options = {
      chatId: 'chat-1',
      bridge,
      sessionStore: store,
      httpClient: { sessionExists: async () => true },
      onServerMessage: () => {},
      logPrefix: '[Test]',
      clearTransientState: () => { cleared += 1 },
    }

    expect(await restoreStoredSessionBinding(options)).toEqual({ status: 'unavailable', session: entry })
    expect(store.current()).toEqual(entry)
    expect(cleared).toBe(0)
    expect(bridge.calls).not.toContain('reset')

    bridge.connectSession = connect
    bridge.waitForOpen = wait
    expect(await restoreStoredSessionBinding(options)).toEqual({ status: 'restored', session: entry })
    expect(store.current()).toEqual(entry)
  })

  it.each([false, true])('keeps the binding when verification fails and reconnect returns %s', async (opened) => {
    const entry = { sessionId: 'stored-session', workDir: '/original-project', updatedAt: 1 }
    const store = makeStore(entry)
    const bridge = makeBridge()
    bridge.waitForOpen = async () => opened

    const result = await restoreStoredSessionBinding({
      chatId: 'chat-1',
      bridge,
      sessionStore: store,
      httpClient: { sessionExists: async () => { throw new Error('HTTP timeout') } },
      onServerMessage: () => {},
      logPrefix: '[Test]',
    })

    expect(result).toEqual({ status: opened ? 'restored' : 'unavailable', session: entry })
    expect(store.current()).toEqual(entry)
    expect(bridge.calls).toEqual(['connect:stored-session', 'handler'])
  })

  it('resets stale bridge memory when server-side delete removed the stored mapping', async () => {
    const store = makeStore(null)
    const bridge = makeBridge({ currentSessionId: 'deleted-session', hasSession: true })
    let cleared = 0

    const restored = await restoreStoredSessionBinding({
      chatId: 'chat-1',
      bridge,
      sessionStore: store,
      httpClient: { sessionExists: async () => true },
      onServerMessage: () => {},
      logPrefix: '[Test]',
      clearTransientState: () => {
        cleared += 1
      },
    })

    expect(restored).toEqual({ status: 'missing' })
    expect(bridge.calls).toEqual(['reset'])
    expect(cleared).toBe(1)
  })

  it('drops a persisted mapping when the server no longer has that session', async () => {
    const entry = { sessionId: 'deleted-session', workDir: '/repo', updatedAt: 1 }
    const store = makeStore(entry)
    const bridge = makeBridge()
    let cleared = 0

    const restored = await restoreStoredSessionBinding({
      chatId: 'chat-1',
      bridge,
      sessionStore: store,
      httpClient: { sessionExists: async () => false },
      onServerMessage: () => {},
      logPrefix: '[Test]',
      clearTransientState: () => {
        cleared += 1
      },
    })

    expect(restored).toEqual({ status: 'missing' })
    expect(store.current()).toBeNull()
    expect(bridge.calls).toEqual([])
    expect(cleared).toBe(1)
  })

  it('resets bridge memory when it points at a different session than the store', async () => {
    const entry = { sessionId: 'stored-session', workDir: '/repo', updatedAt: 1 }
    const store = makeStore(entry)
    const bridge = makeBridge({ currentSessionId: 'stale-session', hasSession: true })
    let cleared = 0

    const restored = await restoreStoredSessionBinding({
      chatId: 'chat-1',
      bridge,
      sessionStore: store,
      httpClient: { sessionExists: async () => true },
      onServerMessage: () => {},
      logPrefix: '[Test]',
      clearTransientState: () => {
        cleared += 1
      },
    })

    expect(restored).toEqual({ status: 'restored', session: entry })
    expect(bridge.calls).toEqual(['reset', 'connect:stored-session', 'handler', 'wait'])
    expect(cleared).toBe(1)
  })

  it('reuses an already-open bridge for the stored session', async () => {
    const entry = { sessionId: 'live-session', workDir: '/repo', updatedAt: 1 }
    const store = makeStore(entry)
    const bridge = makeBridge({ currentSessionId: 'live-session', open: true })
    let checked = 0

    const restored = await restoreStoredSessionBinding({
      chatId: 'chat-1',
      bridge,
      sessionStore: store,
      httpClient: {
        sessionExists: async () => {
          checked += 1
          return true
        },
      },
      onServerMessage: () => {},
      logPrefix: '[Test]',
    })

    expect(restored).toEqual({ status: 'restored', session: entry })
    expect(checked).toBe(0)
    expect(bridge.calls).toEqual([])
  })

  it('connects to an existing stored session after validating it still exists', async () => {
    const entry = { sessionId: 'stored-session', workDir: '/repo', updatedAt: 1 }
    const store = makeStore(entry)
    const bridge = makeBridge()

    const restored = await restoreStoredSessionBinding({
      chatId: 'chat-1',
      bridge,
      sessionStore: store,
      httpClient: { sessionExists: async () => true },
      onServerMessage: () => {},
      logPrefix: '[Test]',
    })

    expect(restored).toEqual({ status: 'restored', session: entry })
    expect(bridge.calls).toEqual(['connect:stored-session', 'handler', 'wait'])
  })
})
