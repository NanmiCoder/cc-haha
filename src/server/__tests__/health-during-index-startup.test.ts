import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, stopServerRuntimeForShutdown } from '../index.js'
import { localIndexCoordinator } from '../services/localIndex/coordinator.js'

let configDir = ''
let originalConfigDir: string | undefined
let server: ReturnType<typeof startServer> | undefined

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-health-startup-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  server?.stop(true)
  server = undefined
  await stopServerRuntimeForShutdown({ waitForCli: false })
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

/**
 * The probe runs in a child process because the parent's event loop is what the
 * startup work blocks: an in-process fetch could only be answered after the
 * block either way, while a kernel-level connect to a listening socket succeeds
 * immediately. That difference is exactly what told #1746's reporter that the
 * sidecar "never started": before the fix, `Bun.serve` ran *after* the index
 * startup pass, so nothing was listening at all.
 */
const PROBE_SCRIPT = `
const net = require('node:net')
const started = Date.now()
const port = Number(process.argv[2])
const deadline = started + 10_000
function attempt() {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.once('connect', () => {
    console.log(Date.now() - started)
    socket.destroy()
    process.exit(0)
  })
  socket.once('error', () => {
    socket.destroy()
    if (Date.now() > deadline) {
      console.log(-1)
      process.exit(0)
    }
    setTimeout(attempt, 20)
  })
}
attempt()
`

test('binds the port before the synchronous part of index startup', async () => {
  const busyMs = 1_500
  const startSpy = spyOn(localIndexCoordinator, 'start').mockImplementation(() => {
    // Mirrors openLocalIndexDatabase + listSources: work that happens before the
    // first await and therefore cannot yield to the event loop.
    const until = Date.now() + busyMs
    while (Date.now() < until) { /* synchronously initializing the index */ }
    return Promise.resolve()
  })
  // Reserve a concrete port so the probe can start before the server exists.
  const probePort = await reservePort()
  try {
    const probe = Bun.spawn([process.execPath, '-e', PROBE_SCRIPT, String(probePort)], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    await Bun.sleep(150)
    expect(startSpy).not.toHaveBeenCalled()

    server = startServer(probePort, '127.0.0.1')
    const [output] = await Promise.all([new Response(probe.stdout).text(), probe.exited])
    // The listener accepts connections while the startup pass still owns the
    // event loop, so the probe succeeds well inside the busy window.
    const connectedAt = Number(output.trim())
    expect(connectedAt).toBeGreaterThanOrEqual(0)
    expect(connectedAt).toBeLessThan(busyMs)
    expect(startSpy).toHaveBeenCalled()
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200)
  } finally {
    startSpy.mockRestore()
  }
})

test('answers /health while an asynchronous index startup is still running', async () => {
  let releaseStart!: () => void
  const startSpy = spyOn(localIndexCoordinator, 'start').mockImplementation(() =>
    new Promise<void>((resolve) => { releaseStart = resolve }))
  try {
    server = startServer(0, '127.0.0.1')
    const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
      signal: AbortSignal.timeout(1_000),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  } finally {
    releaseStart?.()
    startSpy.mockRestore()
  }
})

async function reservePort(): Promise<number> {
  const listener = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = listener.port
  listener.stop(true)
  return port
}
