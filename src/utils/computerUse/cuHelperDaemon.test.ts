import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  __prepareDaemonSocketDirectoryForTests,
  __resetDaemonClientForTests,
  __daemonStartCountForTests,
  __negotiateDaemonProtocolForTests,
  __reapStaleDaemonsForTests,
  __setDaemonSocketForTests,
  CU_HELPER_PROTOCOL_VERSION,
  callDaemon,
  DaemonCommandTimeoutError,
  DaemonCommandResultUnknownError,
  DaemonUnavailableError,
  isOverlayShown,
  overlayHide,
  overlayShow,
} from './cuHelperDaemon.js'
import { __resetCuHelperCache } from './cuHelperBridge.js'
import { __resetInstalledHelperCache } from './cuHelperInstall.js'
import { runCleanupFunctions } from '../cleanupRegistry.js'

class FakeSocket extends EventEmitter {
  writes: string[] = []
  destroyed = false

  write(data: string): boolean {
    this.writes.push(data)
    return true
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

async function waitForWrite(socket: FakeSocket): Promise<void> {
  for (let i = 0; i < 10 && socket.writes.length === 0; i++) {
    await Promise.resolve()
  }
  expect(socket.writes).toHaveLength(1)
}

async function waitForWriteCount(socket: FakeSocket, count: number): Promise<void> {
  for (let i = 0; i < 20 && socket.writes.length < count; i++) {
    await Promise.resolve()
  }
  expect(socket.writes).toHaveLength(count)
}

function reply(
  socket: FakeSocket,
  writeIndex: number,
  response: { ok: boolean; result?: unknown; error?: { message: string } },
): void {
  const id = JSON.parse(socket.writes[writeIndex]!).id
  socket.emit('data', Buffer.from(`${JSON.stringify({ id, ...response })}\n`))
}

afterEach(() => {
  __resetDaemonClientForTests()
  __resetCuHelperCache()
  __resetInstalledHelperCache()
  delete process.env.CC_HAHA_CU_HELPER_PATH
})

describe('cu-helper daemon system commands', () => {
  test('uses trusted absolute binaries for process probing and LaunchServices', async () => {
    const { __daemonProcessCommandsForTests } = await import('./cuHelperDaemon.js')
    expect(
      __daemonProcessCommandsForTests(
        [101, 202],
        '/Applications/cc-haha-computer-use.app',
        '/tmp/cu-helper.sock',
      ),
    ).toEqual({
      ps: {
        command: '/bin/ps',
        args: ['-o', 'pid=,comm=', '-p', '101,202'],
      },
      open: {
        command: '/usr/bin/open',
        args: [
          '-n',
          '/Applications/cc-haha-computer-use.app',
          '--args',
          'daemon',
          '--socket',
          '/tmp/cu-helper.sock',
        ],
      },
    })
  })

  test('creates a private runtime directory before the native daemon binds', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-cu-runtime-test-'))
    try {
      const runtimeDir = path.join(root, '.runtime')
      __prepareDaemonSocketDirectoryForTests(
        path.join(runtimeDir, 'cu-helper.sock'),
      )

      const stat = lstatSync(runtimeDir)
      expect(stat.isDirectory()).toBe(true)
      expect(stat.mode & 0o777).toBe(0o700)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a symlinked runtime directory for the owner-only socket', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-cu-runtime-test-'))
    try {
      const actual = path.join(root, 'actual')
      const runtimeDir = path.join(root, '.runtime')
      mkdirSync(actual)
      symlinkSync(actual, runtimeDir)

      expect(() => __prepareDaemonSocketDirectoryForTests(
        path.join(runtimeDir, 'cu-helper.sock'),
      )).toThrow(/symbolic link/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('cu-helper daemon failure classification', () => {
  test('helper installation/start resolution failure is daemon infrastructure failure', async () => {
    // A bare executable can satisfy the availability probe but cannot be
    // launched as the helper .app daemon. The bridge must be allowed to use the
    // native one-shot CLI for this pre-dispatch failure.
    process.env.CC_HAHA_CU_HELPER_PATH = '/bin/echo'
    __resetCuHelperCache()
    __resetInstalledHelperCache()

    const error = await callDaemon('list_displays', {}).catch(err => err)
    expect(error).toBeInstanceOf(DaemonUnavailableError)
    expect(error.message).toMatch(/app bundle not found/)
  })

  test('socket close after dispatch rejects pending requests as non-replayable result-unknown errors', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never, 100)

    const request = callDaemon('list_displays', {}).catch(err => err)
    await waitForWrite(socket)
    socket.emit('close')

    const error = await request
    expect(error).toBeInstanceOf(DaemonCommandResultUnknownError)
    expect(error).not.toBeInstanceOf(DaemonUnavailableError)
    expect(error.message).toMatch(/socket closed/)
  })

  test('socket error after dispatch rejects pending requests as non-replayable result-unknown errors', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never, 100)

    const request = callDaemon('list_displays', {}).catch(err => err)
    await waitForWrite(socket)
    socket.emit('error', new Error('broken pipe'))

    const error = await request
    expect(error).toBeInstanceOf(DaemonCommandResultUnknownError)
    expect(error).not.toBeInstanceOf(DaemonUnavailableError)
    expect(error.message).toMatch(/broken pipe/)
  })

  test('daemon command rejection remains a command error, not infrastructure failure', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never, 100)

    const request = callDaemon('press_key', { keys: ['cmd+q'] }).catch(err => err)
    await waitForWrite(socket)
    const id = JSON.parse(socket.writes[0]!).id
    socket.emit('data', Buffer.from(
      `${JSON.stringify({ id, ok: false, error: { message: 'grant_flag_required' } })}\n`,
    ))

    const error = await request
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DaemonUnavailableError)
    expect(error.message).toBe('grant_flag_required')
  })

  test('every request carries negotiated protocol, deadline, and stable turn identity', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never, 100)

    const first = callDaemon('get_app_state', { app: 'TextEdit' })
    await waitForWriteCount(socket, 1)
    const firstEnvelope = JSON.parse(socket.writes[0]!)
    const firstTurnId = firstEnvelope.turnId
    expect(firstEnvelope).toMatchObject({
      clientApiVersion: CU_HELPER_PROTOCOL_VERSION,
      requestId: firstEnvelope.id,
      sessionId: expect.any(String),
      turnId: expect.any(String),
    })
    expect(firstEnvelope.deadlineUnixMilliseconds).toBeGreaterThan(Date.now())
    reply(socket, 0, { ok: true, result: {} })
    await first

    const second = callDaemon('click', { app: 'TextEdit', x: 1, y: 1 })
    await waitForWriteCount(socket, 2)
    const secondEnvelope = JSON.parse(socket.writes[1]!)
    expect(secondEnvelope.turnId).toBe(firstTurnId)
    reply(socket, 1, { ok: true, result: true })
    await second
  })

  test('accepts only a daemon hello with the complete negotiated capability set', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never, 100)

    const negotiation = __negotiateDaemonProtocolForTests()
    await waitForWrite(socket)
    expect(JSON.parse(socket.writes[0]!)).toMatchObject({
      cmd: 'ping',
      clientApiVersion: CU_HELPER_PROTOCOL_VERSION,
    })
    reply(socket, 0, {
      ok: true,
      result: {
        protocolVersion: CU_HELPER_PROTOCOL_VERSION,
        supportsAbsoluteDeadlines: true,
        supportsTurnEnd: true,
      },
    })

    await expect(negotiation).resolves.toBeUndefined()
    expect(socket.destroyed).toBe(false)
  })

  test('rejects and retires a daemon that reports an incomplete hello', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never, 100)

    const negotiation = __negotiateDaemonProtocolForTests().catch(err => err)
    await waitForWrite(socket)
    reply(socket, 0, {
      ok: true,
      result: {
        protocolVersion: CU_HELPER_PROTOCOL_VERSION,
        supportsAbsoluteDeadlines: true,
        supportsTurnEnd: false,
      },
    })

    const error = await negotiation
    expect(error).toBeInstanceOf(DaemonUnavailableError)
    expect(error.message).toMatch(/protocol negotiation failed.*unexpected hello/i)
    expect(socket.destroyed).toBe(true)
  })

  test('post-dispatch timeout is ambiguous and must not be classified as replayable infrastructure', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never, 5)

    const error = await callDaemon('click', { x: 10, y: 20 }).catch(err => err)

    expect(socket.writes).toHaveLength(1)
    expect(error).toBeInstanceOf(DaemonCommandTimeoutError)
    expect(error).toBeInstanceOf(DaemonCommandResultUnknownError)
    expect(error).not.toBeInstanceOf(DaemonUnavailableError)
    expect(error.message).toMatch(/execution result is unknown/i)
    expect(socket.destroyed).toBe(true)
  })

  test('a socket already closed before dispatch is replayable infrastructure', async () => {
    const socket = new FakeSocket()
    socket.destroyed = true
    __setDaemonSocketForTests(socket as never, 5)

    const error = await callDaemon('type_text', { text: 'safe' }).catch(err => err)

    expect(socket.writes).toHaveLength(0)
    expect(error).toBeInstanceOf(DaemonUnavailableError)
    expect(error.message).toMatch(/closed before command dispatch/)
  })

  test('reset never SIGTERMs a daemon pid unless it still belongs to cu-helper', async () => {
    const unverifiedSocket = new FakeSocket()
    const killed: number[] = []
    __setDaemonSocketForTests(unverifiedSocket as never, 100, {
      daemonPid: 4242,
      verifyDaemonPid: () => false,
      killDaemonPid: pid => { killed.push(pid) },
    })
    unverifiedSocket.emit('close')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(killed).toEqual([])

    const verifiedSocket = new FakeSocket()
    __setDaemonSocketForTests(verifiedSocket as never, 100, {
      daemonPid: 4242,
      verifyDaemonPid: () => true,
      killDaemonPid: pid => { killed.push(pid) },
    })
    verifiedSocket.emit('close')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(killed).toEqual([4242])
  })

  test('a stale socket close cannot reset a replacement daemon', async () => {
    const oldSocket = new FakeSocket()
    const replacement = new FakeSocket()
    __setDaemonSocketForTests(oldSocket as never)
    __setDaemonSocketForTests(replacement as never)

    oldSocket.emit('close')
    const ping = callDaemon<string>('ping', {})
    await waitForWriteCount(replacement, 1)
    reply(replacement, 0, { ok: true, result: 'pong' })

    expect(await ping).toBe('pong')
    expect(replacement.destroyed).toBe(false)
  })
})

describe('cu-helper daemon process lifecycle', () => {
  test('graceful process cleanup shuts down an active turn before app restart', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never, 100)

    const state = callDaemon('get_app_state', { app: 'TextEdit' })
    await waitForWriteCount(socket, 1)
    reply(socket, 0, { ok: true, result: {} })
    await state

    const cleanup = runCleanupFunctions()
    await waitForWriteCount(socket, 2)
    expect(JSON.parse(socket.writes[1]!)).toMatchObject({ cmd: 'shutdown' })
    reply(socket, 1, { ok: true, result: true })
    await cleanup

    expect(socket.destroyed).toBe(true)
  })

  test('process cleanup force-retires only a verified helper when shutdown does not answer', async () => {
    const socket = new FakeSocket()
    const killed: number[] = []
    __setDaemonSocketForTests(socket as never, 100, {
      daemonPid: 4242,
      verifyDaemonPid: () => true,
      killDaemonPid: pid => { killed.push(pid) },
      shutdownGraceMs: 5,
    })

    const state = callDaemon('get_app_state', { app: 'TextEdit' })
    await waitForWriteCount(socket, 1)
    reply(socket, 0, { ok: true, result: {} })
    await state

    const cleanup = runCleanupFunctions()
    await waitForWriteCount(socket, 2)
    expect(JSON.parse(socket.writes[1]!)).toMatchObject({ cmd: 'shutdown' })
    await cleanup
    for (let i = 0; i < 5 && killed.length === 0; i++) await Promise.resolve()

    expect(socket.destroyed).toBe(true)
    expect(killed).toEqual([4242])
  })
})

describe('cu-helper overlay reconciliation', () => {
  test('overlay_show forwards the canonical explicit target payload', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never)

    const show = overlayShow({ pid: 4321 })
    await waitForWriteCount(socket, 1)
    expect(JSON.parse(socket.writes[0]!)).toMatchObject({
      cmd: 'overlay_show',
      payload: { pid: 4321 },
    })
    reply(socket, 0, { ok: true, result: true })
    await show

    expect(isOverlayShown()).toBe(true)
  })

  test('hide requested while show is pending always converges to hidden', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never)

    const show = overlayShow({ bundleId: 'com.apple.TextEdit' })
    await waitForWriteCount(socket, 1)
    const hide = overlayHide()
    expect(isOverlayShown()).toBe(false)

    reply(socket, 0, { ok: true, result: true })
    await waitForWriteCount(socket, 2)
    expect(JSON.parse(socket.writes[1]!)).toMatchObject({
      cmd: 'turn_end',
      payload: {},
    })
    reply(socket, 1, { ok: true, result: true })

    await Promise.all([show, hide])
    expect(isOverlayShown()).toBe(false)

    const next = callDaemon('get_app_state', { app: 'TextEdit' })
    await waitForWriteCount(socket, 3)
    expect(JSON.parse(socket.writes[2]!).turnId)
      .not.toBe(JSON.parse(socket.writes[0]!).turnId)
    reply(socket, 2, { ok: true, result: {} })
    await next
  })

  test('a target change while show is pending serially retargets to the latest app', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never)

    const first = overlayShow({ pid: 100 })
    await waitForWriteCount(socket, 1)
    const second = overlayShow({ pid: 200 })

    reply(socket, 0, { ok: true, result: true })
    await waitForWriteCount(socket, 2)
    expect(JSON.parse(socket.writes[1]!)).toMatchObject({
      cmd: 'overlay_show',
      payload: { pid: 200 },
    })
    reply(socket, 1, { ok: true, result: true })

    await Promise.all([first, second])
    expect(isOverlayShown()).toBe(true)
  })

  test('a failed show does not claim the overlay is visible or trigger a hide', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never)

    const show = overlayShow({ app: 'TextEdit' })
    await waitForWriteCount(socket, 1)
    reply(socket, 0, { ok: false, error: { message: 'target_not_running' } })
    await show

    expect(isOverlayShown()).toBe(false)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(socket.writes).toHaveLength(1)
    const hide = overlayHide()
    await waitForWriteCount(socket, 2)
    expect(JSON.parse(socket.writes[1]!)).toMatchObject({ cmd: 'turn_end' })
    reply(socket, 1, { ok: true, result: true })
    await hide
  })

  test('cleanup requested during a failed show waits until turn_end completes', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never)

    const show = overlayShow({ app: 'TextEdit' })
    await waitForWriteCount(socket, 1)
    let cleanupCompleted = false
    const hide = overlayHide().then(() => { cleanupCompleted = true })
    reply(socket, 0, { ok: false, error: { message: 'target_not_running' } })
    await waitForWriteCount(socket, 2)
    expect(JSON.parse(socket.writes[1]!)).toMatchObject({ cmd: 'turn_end' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(cleanupCompleted).toBe(false)

    reply(socket, 1, { ok: true, result: true })
    await Promise.all([show, hide])
    expect(cleanupCompleted).toBe(true)
    expect(isOverlayShown()).toBe(false)
    expect(socket.writes).toHaveLength(2)
  })

  test('cleanup ends a read-only turn even when no overlay was shown', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never)

    const state = callDaemon('get_app_state', { app: 'TextEdit' })
    await waitForWriteCount(socket, 1)
    const stateEnvelope = JSON.parse(socket.writes[0]!)
    reply(socket, 0, { ok: true, result: {} })
    await state

    const hide = overlayHide()
    await waitForWriteCount(socket, 2)
    const endEnvelope = JSON.parse(socket.writes[1]!)
    expect(endEnvelope).toMatchObject({ cmd: 'turn_end', turnId: stateEnvelope.turnId })
    reply(socket, 1, { ok: true, result: true })
    await hide

    const next = callDaemon('get_app_state', { app: 'TextEdit' })
    await waitForWriteCount(socket, 3)
    expect(JSON.parse(socket.writes[2]!).turnId).not.toBe(stateEnvelope.turnId)
    reply(socket, 2, { ok: true, result: {} })
    await next
  })

  test('connection-scoped permission checks do not manufacture a turn to clean up', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never)

    const check = callDaemon('check_permissions', {})
    await waitForWriteCount(socket, 1)
    expect(JSON.parse(socket.writes[0]!).turnId).toMatch(/^connection-/)
    reply(socket, 0, { ok: true, result: {} })
    await check

    await overlayHide()
    expect(socket.writes).toHaveLength(1)
  })

  test('a rejected turn_end retires the daemon instead of poisoning the next turn', async () => {
    const socket = new FakeSocket()
    __setDaemonSocketForTests(socket as never)

    const state = callDaemon('get_app_state', { app: 'TextEdit' })
    await waitForWriteCount(socket, 1)
    reply(socket, 0, { ok: true, result: {} })
    await state

    const hide = overlayHide()
    await waitForWriteCount(socket, 2)
    reply(socket, 1, { ok: false, error: { message: 'deadline_exceeded' } })
    await hide

    expect(socket.destroyed).toBe(true)
  })

  test('cleanup with no daemon does not start one', async () => {
    expect(__daemonStartCountForTests()).toBe(0)
    await overlayHide()
    expect(__daemonStartCountForTests()).toBe(0)
  })
})

describe('cu-helper stale daemon reaping', () => {
  const current = '/runtime/cu-helper.daemon.100.sock'

  function harness(options: {
    entries?: string[]
    live?: number[]
    pidfiles?: Record<string, string>
    verified?: number[]
  } = {}) {
    const removed: string[] = []
    const killed: number[] = []
    const live = new Set(options.live ?? [])
    const verified = new Set(options.verified ?? [])
    return {
      removed,
      killed,
      run: () => __reapStaleDaemonsForTests(current, {
        readdir: () => options.entries ?? ['cu-helper.daemon.200.sock.pid'],
        readPidfile: pidfile => options.pidfiles?.[pidfile] ?? '900',
        remove: target => { removed.push(target) },
        isAlive: pid => live.has(pid),
        verifiedHelperPids: () => verified,
        kill: pid => { killed.push(pid) },
      }),
    }
  }

  test('never kills or unlinks a daemon whose owner process is alive', () => {
    const h = harness({
      entries: ['cu-helper.daemon.200.7.sock.pid'],
      live: [200, 900],
      verified: [900],
    })
    h.run()
    expect(h.killed).toEqual([])
    expect(h.removed).toEqual([])
  })

  test('reaps a verified helper only after its owner process is dead', () => {
    const h = harness({
      entries: ['cu-helper.daemon.200.7.sock.pid'],
      live: [900],
      verified: [900],
    })
    h.run()
    expect(h.killed).toEqual([900])
    expect(h.removed).toEqual([
      '/runtime/cu-helper.daemon.200.7.sock',
      '/runtime/cu-helper.daemon.200.7.sock.pid',
    ])
  })

  test('preserves a live but unverified process and its endpoint', () => {
    const h = harness({ live: [900], verified: [] })
    h.run()
    expect(h.killed).toEqual([])
    expect(h.removed).toEqual([])
  })

  test('cleans endpoint leftovers when both owner and daemon are dead', () => {
    const h = harness({ live: [] })
    h.run()
    expect(h.killed).toEqual([])
    expect(h.removed).toEqual([
      '/runtime/cu-helper.daemon.200.sock',
      '/runtime/cu-helper.daemon.200.sock.pid',
    ])
  })

  test('ignores malformed owner names and malformed pidfile contents', () => {
    const h = harness({
      entries: [
        'cu-helper.daemon.not-a-pid.sock.pid',
        'cu-helper.daemon.200.sock.pid',
      ],
      pidfiles: { '/runtime/cu-helper.daemon.200.sock.pid': '900junk' },
    })
    h.run()
    expect(h.killed).toEqual([])
    expect(h.removed).toEqual([
      '/runtime/cu-helper.daemon.200.sock',
      '/runtime/cu-helper.daemon.200.sock.pid',
    ])
  })
})
