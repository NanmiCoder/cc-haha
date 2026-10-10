import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConversationService } from '../services/conversationService.js'

const SDK_URL = 'ws://127.0.0.1:1/sdk/process-lifecycle?token=test-token'

type FakeProc = {
  pid: number
  exitCode: number | null
  /** 'default' marks kill() without a signal (Bun sends SIGTERM / TerminateProcess). */
  signals: Array<NodeJS.Signals | number | 'default'>
  exited: Promise<number>
  stdout: null
  stderr: null
  stdin: { write(): void; flush(): void; end(): void }
  kill(signal?: NodeJS.Signals | number): void
  exit(code: number): void
}

/** A CLI stand-in: records every direct kill and exits on it unless told to hang. */
function createFakeProc(pid: number, options: { exitOnKill?: boolean } = {}): FakeProc {
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  const proc: FakeProc = {
    pid,
    exitCode: null,
    signals: [],
    exited,
    stdout: null,
    stderr: null,
    stdin: { write() {}, flush() {}, end() {} },
    kill(signal) {
      proc.signals.push(signal ?? 'default')
      if (options.exitOnKill !== false) proc.exit(signal === 'SIGKILL' ? 137 : 143)
    },
    exit(code) {
      if (proc.exitCode !== null) return
      proc.exitCode = code
      resolveExit(code)
    },
  }
  return proc
}

function createSession(proc: FakeProc, workDir: string, extra: Record<string, unknown> = {}) {
  return {
    proc,
    outputCallbacks: [],
    workDir,
    permissionMode: 'default',
    sdkToken: 'test-token',
    sdkSocket: null,
    pendingOutbound: [],
    startupPending: false,
    startupExitCode: null,
    stdoutLines: [],
    stderrLines: [],
    outputDrain: Promise.resolve(),
    sdkMessages: [],
    initMessage: null,
    pendingPermissionRequests: new Map(),
    pendingControlRequests: new Map(),
    ...extra,
  }
}

type TaskkillCall = { cmd: string[]; options: unknown }

/** Stands in for spawning taskkill.exe; `exitCodes` are consumed per call. */
function createTaskkillSpawn(exitCodes: Array<number | Error>) {
  const calls: TaskkillCall[] = []
  const spawn = (cmd: string[], options: unknown) => {
    calls.push({ cmd, options })
    const outcome = exitCodes.length > 0 ? exitCodes.shift()! : 0
    if (outcome instanceof Error) throw outcome
    return { exited: Promise.resolve(outcome) }
  }
  return { calls, spawn }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await Bun.sleep(5)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows' }
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'
const HIDDEN_IGNORED_STDIO = { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true }

describe('ConversationService process lifecycle', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalHome: string | undefined
  let originalDisableTerminalShellEnv: string | undefined
  const services: any[] = []

  const track = <T>(service: T): T => {
    services.push(service)
    return service
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-conversation-process-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    originalDisableTerminalShellEnv = process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, '.claude')
    process.env.HOME = tmpDir
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  })

  afterEach(async () => {
    for (const service of services.splice(0)) {
      await service.stopAllSessionsAndWait(200)
    }
    mock.restore()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalDisableTerminalShellEnv === undefined) delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    else process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('stopping a CLI on Windows', () => {
    test('stops the whole process tree with System32 taskkill while the CLI is still alive', async () => {
      const taskkill = createTaskkillSpawn([0])
      const service = track(new ConversationService({
        platform: 'win32',
        env: WINDOWS_ENV,
        spawnTaskkill: taskkill.spawn,
      }) as any)
      const proc = createFakeProc(4321)
      service.sessions.set('tree-stop', createSession(proc, tmpDir))

      service.stopSession('tree-stop')

      await waitUntil(() => taskkill.calls.length === 1)
      await Bun.sleep(10)
      expect(taskkill.calls).toEqual([{
        cmd: [TASKKILL, '/PID', '4321', '/T', '/F'],
        options: HIDDEN_IGNORED_STDIO,
      }])
      // TerminateProcess on the CLI first would orphan its MCP servers and
      // shells before taskkill could walk them, so the CLI is not killed directly.
      expect(proc.signals).toEqual([])
      expect(service.hasSession('tree-stop')).toBe(false)
    })

    test('falls back to killing the CLI directly when taskkill fails', async () => {
      const taskkill = createTaskkillSpawn([128])
      const service = track(new ConversationService({
        platform: 'win32',
        env: WINDOWS_ENV,
        spawnTaskkill: taskkill.spawn,
      }) as any)
      const proc = createFakeProc(4322)
      service.sessions.set('tree-fail', createSession(proc, tmpDir))

      service.stopSession('tree-fail')

      await waitUntil(() => proc.signals.length === 1)
      expect(taskkill.calls).toHaveLength(1)
      expect(proc.signals).toEqual(['default'])
    })

    test('falls back to killing the CLI directly when taskkill cannot start', async () => {
      const taskkill = createTaskkillSpawn([Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })])
      const service = track(new ConversationService({
        platform: 'win32',
        env: WINDOWS_ENV,
        spawnTaskkill: taskkill.spawn,
      }) as any)
      const proc = createFakeProc(4323)
      service.sessions.set('tree-missing', createSession(proc, tmpDir))

      service.stopSession('tree-missing')

      await waitUntil(() => proc.signals.length === 1)
      expect(taskkill.calls).toHaveLength(1)
      expect(proc.signals).toEqual(['default'])
    })

    test('stopProcessAndWait still escalates when the tree stop did not end the CLI', async () => {
      // First taskkill "succeeds" but the CLI keeps running; the escalation
      // runs a second tree stop, which fails, so the direct SIGKILL lands.
      const taskkill = createTaskkillSpawn([0, 1])
      const service = track(new ConversationService({
        platform: 'win32',
        env: WINDOWS_ENV,
        spawnTaskkill: taskkill.spawn,
      }) as any)
      const proc = createFakeProc(4324)
      const session = createSession(proc, tmpDir)
      service.sessions.set('tree-escalate', session)

      await service.stopSessionAndWait('tree-escalate', 50)

      expect(taskkill.calls.map((call) => call.cmd)).toEqual([
        [TASKKILL, '/PID', '4324', '/T', '/F'],
        [TASKKILL, '/PID', '4324', '/T', '/F'],
      ])
      expect(proc.signals).toEqual(['SIGKILL'])
      expect(proc.exitCode).toBe(137)
    })

    test('stopAllSessionsAndWait waits for every tree stop before returning', async () => {
      const taskkill = createTaskkillSpawn([])
      const service = track(new ConversationService({
        platform: 'win32',
        env: WINDOWS_ENV,
        spawnTaskkill: (cmd: string[], options: unknown) => {
          const result = taskkill.spawn(cmd, options)
          // taskkill ends the CLI it was pointed at.
          const pid = Number(cmd[2])
          for (const proc of procs) if (proc.pid === pid) proc.exit(1)
          return result
        },
      }) as any)
      const procs = [createFakeProc(5001), createFakeProc(5002)]
      service.sessions.set('all-a', createSession(procs[0]!, tmpDir))
      service.sessions.set('all-b', createSession(procs[1]!, tmpDir))

      await service.stopAllSessionsAndWait(500)

      expect(taskkill.calls.map((call) => call.cmd[2]).sort()).toEqual(['5001', '5002'])
      expect(procs.map((proc) => proc.exitCode)).toEqual([1, 1])
      expect(procs.map((proc) => proc.signals)).toEqual([[], []])
      expect(service.getActiveSessions()).toEqual([])
    })

    test('does not run taskkill for a CLI that already exited', async () => {
      const taskkill = createTaskkillSpawn([0])
      const service = track(new ConversationService({
        platform: 'win32',
        env: WINDOWS_ENV,
        spawnTaskkill: taskkill.spawn,
      }) as any)
      const proc = createFakeProc(4325)
      proc.exit(0)
      service.sessions.set('tree-exited', createSession(proc, tmpDir))

      service.stopSession('tree-exited')
      await Bun.sleep(10)

      expect(taskkill.calls).toEqual([])
      expect(proc.signals).toEqual(['default'])
    })
  })

  describe('stopping a CLI on POSIX', () => {
    test('keeps signalling only the CLI pid and never runs taskkill', async () => {
      const taskkill = createTaskkillSpawn([0])
      const service = track(new ConversationService({
        platform: 'darwin',
        env: WINDOWS_ENV,
        spawnTaskkill: taskkill.spawn,
      }) as any)
      const stopped = createFakeProc(6001)
      service.sessions.set('posix-stop', createSession(stopped, tmpDir))
      const stubborn = createFakeProc(6002, { exitOnKill: false })
      service.sessions.set('posix-escalate', createSession(stubborn, tmpDir))

      service.stopSession('posix-stop')
      const waiting = service.stopSessionAndWait('posix-escalate', 30)
      await Bun.sleep(80)
      stubborn.exit(137)
      await waiting

      expect(stopped.signals).toEqual(['default'])
      expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(taskkill.calls).toEqual([])
    })
  })

  describe('startSession races', () => {
    function stubSpawn(): FakeProc[] {
      const spawned: FakeProc[] = []
      let nextPid = 7000
      spyOn(Bun, 'spawn').mockImplementation(((..._args: unknown[]) => {
        const proc = createFakeProc(nextPid++)
        spawned.push(proc)
        return proc
      }) as unknown as typeof Bun.spawn)
      return spawned
    }

    test('does not spawn a CLI for a session deleted while startup was awaiting (F4)', async () => {
      const service = track(new ConversationService({ platform: 'darwin' }) as any)
      const sessionId = `f4-${crypto.randomUUID()}`
      const spawned = stubSpawn()
      service.buildChildEnv = async () => {
        // The delete lands while startSession is suspended in a late await,
        // after its early deleted-session checks already passed.
        service.markSessionDeleted(sessionId)
        return {}
      }

      const startup = service.startSession(sessionId, tmpDir, SDK_URL)

      await expect(startup).rejects.toMatchObject({ code: 'SESSION_DELETED' })
      expect(spawned).toHaveLength(0)
      expect(service.hasSession(sessionId)).toBe(false)
    }, 10_000)

    test('a newer start retires the CLI another start registered meanwhile instead of orphaning it (F6)', async () => {
      const service = track(new ConversationService({ platform: 'darwin' }) as any)
      const sessionId = `f6-${crypto.randomUUID()}`
      const spawned = stubSpawn()
      const releaseSecond = deferred()
      let buildCalls = 0
      service.buildChildEnv = async () => {
        buildCalls += 1
        if (buildCalls === 2) await releaseSecond.promise
        return {}
      }

      // Both starts pass the "already running" check before either spawns.
      const first = service.startSession(sessionId, tmpDir, SDK_URL)
      const second = service.startSession(sessionId, tmpDir, SDK_URL)
      await waitUntil(() => spawned.length === 1 && service.sessions.get(sessionId)?.proc === spawned[0])

      const older = service.sessions.get(sessionId)
      const cancelControl = mock((_reason: Error) => {})
      older.pendingControlRequests.set('control-1', cancelControl)
      const autoAnswer = new AbortController()
      older.pendingPermissionRequests.set('question-1', {
        toolName: 'AskUserQuestion',
        input: {},
        autoAnswerAbortController: autoAnswer,
      })
      const workerProc = createFakeProc(7900)
      const worker = createSession(workerProc, tmpDir, {
        teamWorker: { parentSessionId: sessionId, name: 'member', teamName: 'team' },
      })
      service.sessions.set(`${sessionId}-worker`, worker)

      releaseSecond.resolve()
      await waitUntil(() => spawned.length === 2 && service.sessions.get(sessionId)?.proc === spawned[1])
      service.sessions.get(sessionId).resolveSdkAttached?.()

      const results = await Promise.allSettled([first, second])

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      // The older CLI was retired like a runtime restart, not left running unowned.
      expect(spawned[0]!.signals).toEqual(['default'])
      expect(cancelControl).toHaveBeenCalledTimes(1)
      expect(autoAnswer.signal.aborted).toBe(true)
      // Its late startup exit must not unregister the newer CLI or retry a spawn.
      expect(service.sessions.get(sessionId)?.proc).toBe(spawned[1])
      expect(spawned[1]!.signals).toEqual([])
      expect(spawned).toHaveLength(2)
      // Approved team members keep running across the lead replacement.
      expect(service.sessions.get(`${sessionId}-worker`)).toBe(worker)
      expect(workerProc.signals).toEqual([])
    }, 15_000)
  })
})
