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
 * immediately. Before the fix `Bun.serve` ran *after* the index startup pass,
 * so nothing was listening at all and #1746 looked like a dead sidecar. HTTP
 * `/health` is still answered only once that pass returns; the desktop host
 * uses this TCP difference to report "listening but busy" instead.
 */
const PROBE_SCRIPT = `
const net = require('node:net')
// \`bun -e <script> <port>\` passes [bun, port]: the port is the last argument.
const port = Number(process.argv[process.argv.length - 1])
if (!Number.isInteger(port) || port <= 0) {
  console.log('bad-port')
  process.exit(0)
}
const deadline = Date.now() + 15_000
let announced = false
function attempt() {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.once('connect', () => {
    console.log('connected ' + Date.now())
    socket.destroy()
    process.exit(0)
  })
  socket.once('error', () => {
    socket.destroy()
    // Tell the parent the probe is live and polling before it boots the server.
    if (!announced) {
      announced = true
      console.log('ready')
    }
    if (Date.now() > deadline) {
      console.log('timeout')
      process.exit(0)
    }
    setTimeout(attempt, 20)
  })
}
attempt()
`

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  while (!predicate(text)) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

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
    const reader = probe.stdout.getReader()
    expect(await readUntil(reader, text => text.includes('\n'))).toBe('ready\n')
    expect(startSpy).not.toHaveBeenCalled()

    const startedAt = Date.now()
    server = startServer(probePort, '127.0.0.1')
    const output = (await readUntil(reader, () => false)).trim()
    await probe.exited
    // The listener accepts connections while the startup pass still owns the
    // event loop. Measured from the startServer() call, a bind that waited for
    // that pass lands at or after busyMs; a probe that crashed or timed out
    // fails the format check instead of reading as a fast connect.
    expect(output).toMatch(/^connected \d+$/)
    const connectedAfter = Number(output.slice('connected '.length)) - startedAt
    expect(connectedAfter).toBeLessThan(busyMs)
    expect(startSpy).toHaveBeenCalled()
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200)
  } finally {
    startSpy.mockRestore()
  }
})

test('logs module load time before it binds, so a silent pre-bind phase is attributable', async () => {
  const startSpy = spyOn(localIndexCoordinator, 'start').mockImplementation(() => Promise.resolve())
  const logSpy = spyOn(console, 'log')
  try {
    server = startServer(0, '127.0.0.1')
    const lines = logSpy.mock.calls.map(call => String(call[0]))
    const loaded = lines.findIndex(line =>
      /^\[Server\] modules loaded \d+ ms after process start; binding 127\.0\.0\.1:0$/.test(line))
    const running = lines.findIndex(line => line.startsWith('[Server] Claude Code API server running'))
    expect(loaded).toBeGreaterThanOrEqual(0)
    expect(running).toBeGreaterThan(loaded)
  } finally {
    logSpy.mockRestore()
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
