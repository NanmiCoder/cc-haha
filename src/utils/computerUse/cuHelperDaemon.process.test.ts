import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSessionId, switchSession } from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import { runCleanupFunctions } from '../cleanupRegistry.js'
import {
  __resetDaemonClientForTests,
  __setDaemonSocketForTests,
  callDaemon,
} from './cuHelperDaemon.js'

type EchoedRequest = {
  cmd: string
  sessionId: string
  turnId: string
}

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'test-fixtures',
  'launchdDaemon.mjs',
)

const spawnedPids = new Set<number>()
const sockets = new Set<net.Socket>()
let runtimeRoot: string | undefined
const originalSessionId = getSessionId()

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    // A Linux container's init may defer reaping an exited orphan. A zombie
    // cannot hold the socket open and is no longer a running daemon.
    if (process.platform === 'linux') {
      return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
    }
    return true
  } catch {
    return false
  }
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function launchDetachedDaemon(socketPath: string): Promise<number> {
  const result = spawnSync(process.execPath, [fixture, 'launch', socketPath], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || `launcher exited ${result.status}`)
  }
  const pid = Number.parseInt(result.stdout.trim(), 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`invalid detached daemon pid: ${result.stdout}`)
  }
  spawnedPids.add(pid)
  await waitUntil(
    () => fs.existsSync(socketPath) && fs.existsSync(`${socketPath}.pid`),
    'detached daemon endpoints',
  )

  const parent = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], {
    encoding: 'utf8',
  })
  expect(parent.status).toBe(0)
  const parentPid = Number.parseInt(parent.stdout.trim(), 10)
  if (process.platform === 'darwin') {
    expect(parentPid).toBe(1)
  } else {
    // Linux can reparent to a container subreaper rather than PID 1.
    expect(parentPid).toBeGreaterThan(0)
    expect(parentPid).not.toBe(result.pid)
  }
  return pid
}

async function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath)
  sockets.add(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function driveResumeBoundary(
  socketPath: string,
  bootstrapSession: string,
  resumedSession: string,
): Promise<void> {
  const daemonPid = await launchDetachedDaemon(socketPath)
  const socket = await connect(socketPath)
  __setDaemonSocketForTests(socket, 2_000)

  switchSession(asSessionId(bootstrapSession))
  const enumeration = await callDaemon<EchoedRequest>('list_installed_apps')
  expect(enumeration).toMatchObject({
    cmd: 'list_installed_apps',
    sessionId: bootstrapSession,
  })
  expect(enumeration.turnId).toMatch(/^connection-/)

  switchSession(asSessionId(resumedSession))
  const firstState = await callDaemon<EchoedRequest>('get_app_state', {
    app: 'TextEdit',
  })
  expect(firstState).toMatchObject({
    cmd: 'get_app_state',
    sessionId: resumedSession,
  })
  expect(firstState.turnId).not.toBe(enumeration.turnId)

  await runCleanupFunctions()
  await waitUntil(
    () => !isAlive(daemonPid)
      && !fs.existsSync(socketPath)
      && !fs.existsSync(`${socketPath}.pid`),
    'socket-owned daemon shutdown',
  )
  spawnedPids.delete(daemonPid)
  sockets.delete(socket)
}

afterEach(async () => {
  try { await runCleanupFunctions() } catch {}
  __resetDaemonClientForTests()
  switchSession(originalSessionId)
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  for (const pid of spawnedPids) {
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
  }
  spawnedPids.clear()
  if (runtimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true })
  runtimeRoot = undefined
})

// The fixture models launchd ownership with a detached POSIX process; it does
// not invoke launchctl or native Computer Use, so Linux exercises it too.
describe.skipIf(process.platform === 'win32')(
  'cu-helper detached daemon lifecycle',
  () => {
    test('startup enumeration cannot poison the first resumed turn across shutdown and restart', async () => {
      runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-cu-process-'))
      const socketPath = path.join(runtimeRoot, 'cu-helper.sock')
      const resumedSession = 'resumed-session'

      await driveResumeBoundary(socketPath, 'bootstrap-before-quit', resumedSession)
      await driveResumeBoundary(socketPath, 'bootstrap-after-restart', resumedSession)
    })
  },
)
