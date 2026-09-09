import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { ensureInstalledHelper } from './cuHelperInstall.js'
import { attestDaemonSocketPeer } from './cuHelperPeerAttestation.js'
import { getRuntimePaths } from './pythonBridge.js'

/**
 * Long-lived `cu-helper daemon` client (macOS only).
 *
 * The daemon owns the main run loop that the animated virtual cursor and the
 * animated virtual cursor needs, and holds the virtual cursor's position +
 * held-input state across commands. We spawn ONE daemon per CLI process, keep
 * an AF_UNIX socket open to it, and speak a versioned NDJSON protocol:
 *
 *   readiness : {"ready":true,"pid":N,"protocolVersion":"..."}\n
 *   request   : {"id":"<n>","requestId":"<n>","cmd":"<verb>",...}\n
 *   response  : {"id":"<n>","ok":true,"result":...}\n | {"id":"<n>","ok":false,"error":{...}}\n
 *
 * Routing through the daemon (instead of one-shot CLI) is what makes execution
 * VISIBLE — the user sees the AI cursor glide over the target window while
 * their real mouse stays free.
 *
 * Resilience: pre-dispatch launch/connect failures are typed so helperBridge can
 * use CLI for stateless commands. Once a request is written, timeout/socket loss
 * is result-unknown and never replayed. The failed daemon is retired so a later
 * call can start a fresh process.
 */

const REQUEST_TIMEOUT_MS = 20_000
const READINESS_TIMEOUT_MS = 8_000
const SHUTDOWN_GRACE_MS = 1_000
export const CU_HELPER_PROTOCOL_VERSION = 'CCHahaComputerUseIPC-2'
const CONNECTION_SCOPED_COMMANDS = new Set([
  'ping',
  'check_permissions',
  'list_installed_apps',
  'shutdown',
])

/**
 * Thrown ONLY for daemon INFRASTRUCTURE failures known to happen before the
 * command was dispatched — the daemon couldn't install/start/connect, or the
 * socket rejected the write synchronously.
 * A command that the daemon ran and rejected (e.g. `not_trusted`, `unknown_key`)
 * rejects with a plain `Error` instead. The bridge uses this distinction to fall
 * back to the one-shot CLI ONLY on infra failure — never silently swallowing a
 * real command error (which would just fail the same way on the CLI, minus the
 * overlay). See helperBridge.ts.
 */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonUnavailableError'
  }
}

/**
 * A dispatched command lost its authoritative response. The command may have
 * executed, so callers must surface the ambiguity instead of replaying it
 * through another transport.
 */
export class DaemonCommandResultUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonCommandResultUnknownError'
  }
}

/** A result-unknown error specifically caused by the response deadline. */
export class DaemonCommandTimeoutError extends DaemonCommandResultUnknownError {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonCommandTimeoutError'
  }
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type DaemonState = {
  generation: number
  /** The short-lived `open` process (LaunchServices launcher) — NOT the daemon.
   *  It exits ~immediately after reparenting the daemon to launchd. */
  proc: ChildProcess
  socket: net.Socket
  pending: Map<string, Pending>
  nextId: number
  buf: string
  /** Daemon pid read from its pidfile, for force-termination (the daemon is
   *  reparented to launchd, so `proc.kill` can't reach it). */
  daemonPid?: number
  /** Pidfile path to clean up on teardown. */
  pidfile: string
  /** Focused test seams; production uses the verified `ps` probe + SIGTERM. */
  verifyDaemonPid?: (pid: number) => boolean
  killDaemonPid?: (pid: number) => void
}

let statePromise: Promise<DaemonState> | undefined
let daemonGeneration = 0
let activeDaemonGeneration: number | undefined
let daemonStartCount = 0

let overlayDesiredVisible = false
let overlayActualVisible = false
let overlayCleanupRequested = false
let overlayDesiredPayload: Record<string, unknown> = {}
let overlayDesiredKey = '{}'
let overlayActualKey: string | undefined
let overlayRevision = 0
let overlayReconcilePromise: Promise<void> | undefined
let requestTimeoutMs = REQUEST_TIMEOUT_MS
let shutdownGraceMs = SHUTDOWN_GRACE_MS
let activeTurnId: string | undefined
let unregisterDaemonCleanup: (() => void) | undefined

function socketPath(generation: number): string {
  const { runtimeStateRoot } = getRuntimePaths()
  // A reset can race the old daemon's deferred disconnect cleanup. A unique
  // generation path prevents that old process from unlinking a replacement's
  // newly-bound socket when it finally exits.
  return path.join(
    runtimeStateRoot,
    `cu-helper.daemon.${process.pid}.${generation}.sock`,
  )
}

/**
 * The native path does not require the legacy Python setup, so a fresh install
 * may not have created `.runtime` yet. Create and lock down the socket parent
 * before LaunchServices starts the helper; otherwise bind(2) fails with ENOENT
 * and the settings page can only report unknown permissions.
 */
function prepareDaemonSocketDirectory(sock: string): void {
  const directory = path.dirname(sock)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const before = fs.lstatSync(directory)
  if (before.isSymbolicLink()) {
    throw new DaemonUnavailableError(
      `cu-helper runtime directory is a symbolic link: ${directory}`,
    )
  }
  if (!before.isDirectory()) {
    throw new DaemonUnavailableError(
      `cu-helper runtime path is not a directory: ${directory}`,
    )
  }
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new DaemonUnavailableError(
      `cu-helper runtime directory is not owned by the current user: ${directory}`,
    )
  }
  fs.chmodSync(directory, 0o700)
  const mode = fs.lstatSync(directory).mode & 0o777
  if (mode !== 0o700) {
    throw new DaemonUnavailableError(
      `cu-helper runtime directory is not private: ${directory}`,
    )
  }
}

export function __prepareDaemonSocketDirectoryForTests(sock: string): void {
  prepareDaemonSocketDirectory(sock)
}

/** The daemon writes its real pid here on readiness (see Daemon.swift). It is
 *  `<socket>.pid` so both sides derive it from the single `--socket` argument. */
function pidfilePath(sock: string): string {
  return `${sock}.pid`
}

/** `process.kill(pid, 0)` is a liveness probe: it signals nothing but throws if
 *  the pid is dead / not ours. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type ProcessCommand = {
  command: string
  args: string[]
}

function psProbeCommand(pids: number[]): ProcessCommand {
  return {
    command: '/bin/ps',
    args: ['-o', 'pid=,comm=', '-p', pids.join(',')],
  }
}

function daemonOpenCommand(appBundle: string, sock: string): ProcessCommand {
  return {
    command: '/usr/bin/open',
    args: ['-n', appBundle, '--args', 'daemon', '--socket', sock],
  }
}

/** Focused security seam: production and the regression test share these specs. */
export function __daemonProcessCommandsForTests(
  pids: number[],
  appBundle: string,
  sock: string,
): { ps: ProcessCommand; open: ProcessCommand } {
  return {
    ps: psProbeCommand(pids),
    open: daemonOpenCommand(appBundle, sock),
  }
}

/** Of `pids`, the subset whose process executable is actually the cu-helper, via
 *  one batched `ps`. Guards reaping against a recycled pid that now belongs to an
 *  innocent process — we must never SIGTERM something that isn't our daemon. */
function pidsRunningCuHelper(pids: number[]): Set<number> {
  const found = new Set<number>()
  if (pids.length === 0) return found
  try {
    const command = psProbeCommand(pids)
    const res = spawnSync(command.command, command.args, { encoding: 'utf8' })
    if (res.status !== 0 || !res.stdout) return found
    for (const line of res.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      if (m && m[2].includes('cc-haha-computer-use')) found.add(Number.parseInt(m[1], 10))
    }
  } catch {
    // ps unavailable → reap nothing (fail safe: never kill unverified pids).
  }
  return found
}

/**
 * Reap orphaned daemons from prior / crashed sessions.
 *
 * Current helpers self-exit on active-client disconnect. This reaper is still
 * needed for crash/power-loss leftovers and older builds that did not own that
 * lifecycle. A live owner process is never considered stale.
 */
type ReapStaleDaemonDeps = {
  readdir: (dir: string) => string[]
  readPidfile: (pidfile: string) => string
  remove: (target: string) => void
  isAlive: (pid: number) => boolean
  verifiedHelperPids: (pids: number[]) => Set<number>
  kill: (pid: number) => void
}

const realReapDeps: ReapStaleDaemonDeps = {
  readdir: dir => fs.readdirSync(dir),
  readPidfile: pidfile => fs.readFileSync(pidfile, 'utf8'),
  remove: target => fs.rmSync(target, { force: true }),
  isAlive: isProcessAlive,
  verifiedHelperPids: pidsRunningCuHelper,
  kill: pid => process.kill(pid, 'SIGTERM'),
}

function reapStaleDaemons(
  currentSock: string,
  deps: ReapStaleDaemonDeps = realReapDeps,
): void {
  let dir: string
  try {
    dir = path.dirname(currentSock)
  } catch {
    return
  }
  let entries: string[]
  try {
    entries = deps.readdir(dir)
  } catch {
    return
  }

  const candidates = entries
    .map(file => {
      const match = file.match(
        /^cu-helper\.daemon\.([1-9]\d*)(?:\.[1-9]\d*)?\.sock\.pid$/,
      )
      if (!match) return undefined
      const ownerPid = Number(match[1])
      const pidfile = path.join(dir, file)
      return {
        ownerPid,
        pidfile,
        sock: pidfile.slice(0, -'.pid'.length),
      }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .filter(c => c.sock !== currentSock)
  if (candidates.length === 0) return

  const alive = new Map<number, { pidfile: string; sock: string }>()
  for (const c of candidates) {
    // A live owner may be idle or between lock acquisitions while its helper is
    // still valid. Never reap or unlink another live process's endpoint. PID
    // reuse can conservatively leave an orphan behind, which is safer than
    // terminating an unrelated active session.
    if (deps.isAlive(c.ownerPid)) continue

    let pid = 0
    try {
      const raw = deps.readPidfile(c.pidfile).trim()
      if (/^[1-9]\d*$/.test(raw)) pid = Number(raw)
    } catch {}
    if (Number.isSafeInteger(pid) && pid > 0 && deps.isAlive(pid)) {
      alive.set(pid, c)
    } else {
      // Dead daemon (or unreadable pidfile): just clear the leftovers.
      try { deps.remove(c.sock) } catch {}
      try { deps.remove(c.pidfile) } catch {}
    }
  }

  if (alive.size === 0) return
  const verified = deps.verifiedHelperPids([...alive.keys()])
  let reaped = 0
  for (const [pid, c] of alive) {
    if (verified.has(pid)) {
      try { deps.kill(pid) } catch {}
      reaped++
      try { deps.remove(c.sock) } catch {}
      try { deps.remove(c.pidfile) } catch {}
    }
    // If process verification fails, preserve the endpoint. Unlinking it would
    // strand a process we deliberately refused to identify and terminate.
  }
  if (reaped > 0) {
    logForDebugging(`reaped ${reaped} stale cu-helper daemon(s)`, { level: 'debug' })
  }
}

/** Focused safety seam: production always uses the real filesystem/processes. */
export function __reapStaleDaemonsForTests(
  currentSock: string,
  deps: ReapStaleDaemonDeps,
): void {
  reapStaleDaemons(currentSock, deps)
}

/**
 * Repeatedly attempt to connect to the daemon's AF_UNIX socket until it is
 * listening or `timeoutMs` elapses. This REPLACES stdout "ready" sensing: a
 * LaunchServices-launched daemon is detached from us, so we can't read its
 * stdout — the socket coming up IS the readiness signal.
 */
async function connectWithRetry(
  sock: string,
  timeoutMs: number,
  getLaunchError: () => Error | undefined = () => undefined,
): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs
  let lastErr: Error | undefined
  while (Date.now() < deadline) {
    const launchError = getLaunchError()
    if (launchError) throw launchError
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(sock)
        s.once('connect', () => resolve(s))
        s.once('error', err => {
          s.destroy()
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      await new Promise(r => setTimeout(r, 100))
    }
  }
  throw new Error(
    `cu-helper daemon socket not ready within ${timeoutMs}ms: ${lastErr?.message ?? 'unknown'}`,
  )
}

/** Tear down current state (on death/error) so the next call respawns fresh. */
function resetState(reason: string, expectedGeneration?: number): void {
  if (
    expectedGeneration !== undefined
    && expectedGeneration !== activeDaemonGeneration
  ) return

  overlayDesiredVisible = false
  overlayActualVisible = false
  overlayCleanupRequested = false
  overlayActualKey = undefined
  overlayRevision++
  activeTurnId = undefined
  unregisterDaemonCleanup?.()
  unregisterDaemonCleanup = undefined
  const p = statePromise
  statePromise = undefined
  activeDaemonGeneration = undefined
  if (!p) return
  void p
    .then(s => {
      for (const pending of s.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new DaemonCommandResultUnknownError(
          `cu-helper daemon reset: ${reason}; execution result is unknown`,
        ))
      }
      s.pending.clear()
      try { s.socket.destroy() } catch {}
      // The daemon is reparented to launchd (LaunchServices launch), so `s.proc`
      // is the already-exited `open`, not the daemon — terminate the daemon by
      // the pid it wrote to its pidfile.
      if (s.daemonPid) {
        const stillOurDaemon = s.verifyDaemonPid
          ? s.verifyDaemonPid(s.daemonPid)
          : pidsRunningCuHelper([s.daemonPid]).has(s.daemonPid)
        if (stillOurDaemon) {
          try {
            if (s.killDaemonPid) s.killDaemonPid(s.daemonPid)
            else process.kill(s.daemonPid, 'SIGTERM')
          } catch {}
        }
      }
      try { s.proc.kill('SIGTERM') } catch {}
      try { fs.rmSync(s.pidfile, { force: true }) } catch {}
    })
    .catch(() => {})
}

async function startDaemon(generation: number): Promise<DaemonState> {
  daemonStartCount++
  // Launch the daemon from the STANDALONE-INSTALLED `.app` via LaunchServices
  // (`open -n`). This is load-bearing for Screen Recording: macOS resolves the
  // SR TCC *subject* to the OUTERMOST `.app` on the binary's path, so a helper
  // NESTED inside the host (app.asar.unpacked) is attributed to the HOST and
  // granting the helper does nothing. ensureInstalledHelper() relocates the
  // helper OUT to a stable host-independent path, where it is its OWN SR subject
  // — so the user's grant of the helper actually takes effect. (Dev/standalone
  // builds are used in place.) See cuHelperInstall.ts.
  const installed = ensureInstalledHelper()
  if (!installed) throw new Error('cu-helper .app bundle not found')
  const appBundle = installed.appBundle

  const sock = socketPath(generation)
  const pidfile = pidfilePath(sock)
  prepareDaemonSocketDirectory(sock)
  // Reap orphaned daemons + sockets from prior/crashed sessions (each app restart
  // strands a launchd-reparented daemon) BEFORE starting ours, so they can't
  // accumulate or mask this session's daemon during testing.
  reapStaleDaemons(sock)
  // Clear any stale socket / pidfile from a previous unclean exit so readiness +
  // pid sensing can't latch onto a dead daemon's leftovers.
  try { fs.rmSync(sock, { force: true }) } catch {}
  try { fs.rmSync(pidfile, { force: true }) } catch {}

  // `open -n <app> --args daemon --socket <sock>`: -n forces a fresh instance;
  // everything after --args becomes the app's argv. `open` exits ~immediately
  // after handing off to LaunchServices and the daemon is reparented to launchd,
  // so we do NOT read this process's stdout — readiness is the socket coming up.
  let stderr = ''
  const command = daemonOpenCommand(appBundle, sock)
  const proc = spawn(command.command, command.args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let launchError: Error | undefined
  // `spawn` reports a missing/unlaunchable `open` executable asynchronously.
  // Keep the error in-band so it becomes DaemonUnavailableError rather than an
  // unhandled EventEmitter error that terminates the host process.
  proc.once('error', err => {
    launchError = err instanceof Error ? err : new Error(String(err))
  })
  proc.once('exit', code => {
    if (code !== null && code !== 0) {
      launchError = new Error(`open exited with code ${code}`)
    }
  })
  proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

  let socket: net.Socket
  try {
    socket = await connectWithRetry(sock, READINESS_TIMEOUT_MS, () => launchError)
  } catch (err) {
    // Surface any `open` failure (Gatekeeper, missing bundle) alongside the
    // socket-timeout message so a launch problem isn't masked as a timeout.
    const hint = stderr.trim()
    throw new DaemonUnavailableError(
      `${err instanceof Error ? err.message : String(err)}${hint ? ` (open: ${hint})` : ''}`,
    )
  }

  const attestedPeer = await attestDaemonSocketPeer(socket, installed.binary)
  if (!attestedPeer) {
    socket.destroy()
    throw new DaemonUnavailableError(
      'cu-helper daemon socket peer failed reverse code-signature attestation',
    )
  }

  // Read the daemon's real pid (written to the pidfile on readiness) so we can
  // force-terminate it later — `proc` is the already-exited `open`.
  let pidfilePID: number
  try {
    const raw = fs.readFileSync(pidfile, 'utf8').trim()
    pidfilePID = Number.parseInt(raw, 10)
  } catch {
    socket.destroy()
    throw new DaemonUnavailableError('cu-helper daemon did not publish its authenticated pid')
  }
  if (!Number.isFinite(pidfilePID) || pidfilePID !== attestedPeer.pid) {
    socket.destroy()
    throw new DaemonUnavailableError(
      'cu-helper daemon pidfile does not match the authenticated socket peer',
    )
  }
  const daemonPid = attestedPeer.pid

  const state: DaemonState = {
    generation,
    proc,
    socket,
    pending: new Map(),
    nextId: 0,
    buf: '',
    daemonPid,
    pidfile,
  }

  attachSocketHandlers(state)

  await negotiateDaemonProtocol(state)

  return state
}

function attachSocketHandlers(state: DaemonState): void {
  state.socket.on('data', (d: Buffer) => {
    state.buf += d.toString()
    let nl: number
    while ((nl = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, nl)
      state.buf = state.buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(line) } catch { continue }
      const id = msg.id
      if (!id) continue
      const pending = state.pending.get(id)
      if (!pending) continue
      state.pending.delete(id)
      clearTimeout(pending.timer)
      if (msg.ok) pending.resolve(msg.result)
      else pending.reject(new Error(msg.error?.message || 'cu-helper daemon command failed'))
    }
  })
  // The daemon's death is observed via the socket closing — NOT via `proc`,
  // which is the `open` launcher and exits right after handing off.
  state.socket.on('close', () => resetState('socket closed', state.generation))
  state.socket.on('error', err => resetState(`socket error: ${String(err)}`, state.generation))
}

async function negotiateDaemonProtocol(state: DaemonState): Promise<void> {
  // Socket ownership + code-signature attestation identify the peer. The
  // versioned hello additionally proves that the installed helper understands
  // deadlines and explicit turn cleanup before we dispatch any real command.
  try {
    const hello = await dispatchDaemonCommand<{
      protocolVersion?: string
      supportsAbsoluteDeadlines?: boolean
      supportsTurnEnd?: boolean
    }>(state, 'ping', {})
    if (
      hello.protocolVersion !== CU_HELPER_PROTOCOL_VERSION
      || hello.supportsAbsoluteDeadlines !== true
      || hello.supportsTurnEnd !== true
    ) {
      throw new Error(`unexpected hello ${JSON.stringify(hello)}`)
    }
  } catch (err) {
    state.socket.destroy()
    throw new DaemonUnavailableError(
      `cu-helper protocol negotiation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function ensureDaemon(): Promise<DaemonState> {
  if (!statePromise) {
    const generation = ++daemonGeneration
    activeDaemonGeneration = generation
    const starting = startDaemon(generation).catch(err => {
      if (activeDaemonGeneration === generation) {
        statePromise = undefined
        activeDaemonGeneration = undefined
      }
      if (err instanceof DaemonUnavailableError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new DaemonUnavailableError(
        `cu-helper daemon failed to start: ${message}`,
      )
    })
    statePromise = starting
  }
  const state = await statePromise
  // LaunchServices reparents the helper to launchd, so CLI exit must retire it
  // explicitly; the sidecar process tree cannot own this descendant for us.
  unregisterDaemonCleanup ??= registerCleanup(shutdownDaemon)
  return state
}

function dispatchDaemonCommand<T>(
  state: DaemonState,
  command: string,
  payload: Record<string, unknown>,
): Promise<T> {
  if (state.socket.destroyed) {
    return Promise.reject(new DaemonUnavailableError(
      'cu-helper daemon socket closed before command dispatch',
    ))
  }
  const id = String(++state.nextId)
  const isTurnScoped = !CONNECTION_SCOPED_COMMANDS.has(command)
  const turnId = activeTurnId
    ?? (isTurnScoped ? (activeTurnId = randomUUID()) : `connection-${state.generation}`)
  const request = {
    id,
    requestId: id,
    cmd: command,
    payload,
    clientApiVersion: CU_HELPER_PROTOCOL_VERSION,
    deadlineUnixMilliseconds: Date.now() + requestTimeoutMs,
    sessionId: getSessionId(),
    turnId,
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      // The request was already written. The daemon may have performed the
      // mutation and only lost/delayed its response, so replaying it through the
      // CLI could double-click, double-type, or repeat another side effect.
      reject(new DaemonCommandTimeoutError(
        `cu-helper daemon command ${command} timed out; execution result is unknown`,
      ))
      // Retire a daemon that missed its response deadline. Other requests that
      // were already in flight are also result-unknown, never replayable infra.
      resetState(`command ${command} timed out`, state.generation)
    }, requestTimeoutMs)
    state.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    try {
      state.socket.write(`${JSON.stringify(request)}\n`)
    } catch (err) {
      clearTimeout(timer)
      state.pending.delete(id)
      // A synchronous write throw happens before the payload is accepted, so
      // this request alone is safe to classify as replayable infrastructure.
      reject(new DaemonUnavailableError(err instanceof Error ? err.message : String(err)))
      resetState(`socket write failed: ${String(err)}`, state.generation)
    }
  }).finally(() => {
    if ((command === 'turn_end' || command === 'overlay_hide') && activeTurnId === turnId) {
      activeTurnId = undefined
    }
  })
}

/** Send one command to the daemon and await its response. */
export async function callDaemon<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  return dispatchDaemonCommand<T>(await ensureDaemon(), command, payload)
}

/** Send only when this exact daemon is already owned. Never starts a helper. */
async function callExistingDaemon<T>(
  command: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const existing = statePromise
  const generation = activeDaemonGeneration
  if (!existing || generation === undefined) {
    throw new DaemonUnavailableError('cu-helper daemon is not running')
  }
  const state = await existing
  if (
    statePromise !== existing
    || activeDaemonGeneration !== generation
    || state.generation !== generation
  ) {
    throw new DaemonUnavailableError('cu-helper daemon changed before command dispatch')
  }
  return dispatchDaemonCommand<T>(state, command, payload)
}

function needsOverlayReconciliation(): boolean {
  // A turn may contain only get_app_state and therefore never show the overlay.
  // Its turn-owned native state (AX baseline, held-input guard and display
  // sleep assertion) still needs an explicit turn_end at host cleanup. The
  // keyed SCStream consumer deliberately survives that boundary and retires on
  // target/config changes or daemon teardown.
  // A failed visual-feedback request also leaves the overlay hidden, but must
  // not release the active turn's snapshots. Only explicit host cleanup owns
  // that lifetime boundary.
  if (!overlayDesiredVisible) {
    return overlayCleanupRequested && (overlayActualVisible || activeTurnId !== undefined)
  }
  return !overlayActualVisible || overlayActualKey !== overlayDesiredKey
}

async function reconcileOverlay(): Promise<void> {
  while (needsOverlayReconciliation()) {
    if (overlayDesiredVisible) {
      const revision = overlayRevision
      const payload = overlayDesiredPayload
      const key = overlayDesiredKey
      try {
        await callDaemon('overlay_show', payload)
        overlayActualVisible = true
        overlayActualKey = key
      } catch (err) {
        // Only cancel the request that actually failed. A newer show/hide may
        // have arrived while this command was in flight and remains authoritative.
        if (
          overlayRevision === revision
          && overlayDesiredVisible
          && overlayDesiredKey === key
        ) {
          overlayDesiredVisible = false
          overlayRevision++
        }
        overlayActualVisible = false
        overlayActualKey = undefined
        logForDebugging(`cu-helper overlay_show failed: ${String(err)}`, { level: 'debug' })
        continue
      }
      continue
    }

    // A turn-end cleanup must never launch a daemon just to hide it. When a
    // pending show completes this branch sees the already-owned daemon and
    // serially ends the turn. This also covers read-only turns whose overlay
    // was never visible.
    overlayCleanupRequested = false
    if (!statePromise || activeDaemonGeneration === undefined) {
      overlayActualVisible = false
      overlayActualKey = undefined
      return
    }
    try {
      await callExistingDaemon('turn_end', {})
    } catch (err) {
      logForDebugging(`cu-helper turn_end failed: ${String(err)}`, { level: 'debug' })
      // If the helper rejected/lost turn_end it may still own the old turn.
      // Retire it now so the next user turn cannot inherit stale native state
      // or fail forever with turn_mismatch.
      resetState('turn_end failed')
    }
    overlayActualVisible = false
    overlayActualKey = undefined
  }
}

function scheduleOverlayReconciliation(): Promise<void> {
  if (!overlayReconcilePromise) {
    overlayReconcilePromise = reconcileOverlay().finally(() => {
      overlayReconcilePromise = undefined
      // A desired-state update can land between the loop's final condition and
      // this finally callback. Re-arm once so no update is lost.
      if (needsOverlayReconciliation()) void scheduleOverlayReconciliation()
    })
  }
  return overlayReconcilePromise
}

/** Reveal/retarget the animated cursor to an explicit app selector. */
export function overlayShow(
  target: Record<string, unknown> = {},
): Promise<void> {
  overlayDesiredVisible = true
  overlayCleanupRequested = false
  overlayDesiredPayload = { ...target }
  overlayDesiredKey = JSON.stringify(overlayDesiredPayload)
  overlayRevision++
  return scheduleOverlayReconciliation()
}

/** Hide the overlay, serialized after any pending show (best-effort). */
export function overlayHide(): Promise<void> {
  overlayDesiredVisible = false
  overlayCleanupRequested = true
  overlayRevision++
  return scheduleOverlayReconciliation()
}

export function isOverlayShown(): boolean {
  // Callers use this as an idempotence hint. Desired visibility is the correct
  // answer while a fire-and-forget show is still on the wire; reporting only
  // confirmed visibility would enqueue the same show for every fast action.
  return overlayDesiredVisible
}

/** Stop the daemon at client/process teardown. Best-effort and bounded. */
export async function shutdownDaemon(): Promise<void> {
  if (!statePromise) return
  const generation = activeDaemonGeneration
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      callExistingDaemon('shutdown', {}),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, shutdownGraceMs)
      }),
    ])
  } catch {
    // Ignore — resetState below closes the socket and force-kills only a PID
    // that still passes the cu-helper executable identity check.
  } finally {
    if (timer) clearTimeout(timer)
    resetState('explicit shutdown', generation)
  }
}

/** Test hook. */
export function __resetDaemonClientForTests(): void {
  statePromise = undefined
  activeDaemonGeneration = undefined
  overlayDesiredVisible = false
  overlayActualVisible = false
  overlayCleanupRequested = false
  overlayDesiredPayload = {}
  overlayDesiredKey = '{}'
  overlayActualKey = undefined
  overlayRevision = 0
  overlayReconcilePromise = undefined
  daemonStartCount = 0
  requestTimeoutMs = REQUEST_TIMEOUT_MS
  shutdownGraceMs = SHUTDOWN_GRACE_MS
  activeTurnId = undefined
  unregisterDaemonCleanup?.()
  unregisterDaemonCleanup = undefined
}

/** Focused proof that a no-daemon cleanup did not enter the startup path. */
export function __daemonStartCountForTests(): number {
  return daemonStartCount
}

/** Install a fake connected socket for focused protocol tests. */
export function __setDaemonSocketForTests(
  socket: net.Socket,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  options: {
    daemonPid?: number
    verifyDaemonPid?: (pid: number) => boolean
    killDaemonPid?: (pid: number) => void
    shutdownGraceMs?: number
  } = {},
): void {
  requestTimeoutMs = timeoutMs
  shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS
  const generation = ++daemonGeneration
  activeDaemonGeneration = generation
  const state: DaemonState = {
    generation,
    proc: { kill: () => true } as unknown as ChildProcess,
    socket,
    pending: new Map(),
    nextId: 0,
    buf: '',
    daemonPid: options.daemonPid,
    pidfile: '/tmp/cu-helper-daemon-test.pid',
    verifyDaemonPid: options.verifyDaemonPid,
    killDaemonPid: options.killDaemonPid,
  }
  attachSocketHandlers(state)
  statePromise = Promise.resolve(state)
}

/** Drive the same hello negotiation used by production against an installed test socket. */
export async function __negotiateDaemonProtocolForTests(): Promise<void> {
  await negotiateDaemonProtocol(await ensureDaemon())
}
