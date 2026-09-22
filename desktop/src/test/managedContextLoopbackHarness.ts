import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { transferableAbortController } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createQualityGateSandbox } from '../../../scripts/quality-gate/sandbox'
import { createContextTicketClient } from '../../electron/services/managedResources/contextTicketClient'

export type LoopFrame = Record<string, unknown>
// A native Node WebSocket avoids jsdom injecting a foreign page Origin into the
// real loopback handshake. Authenticate with the same localToken as the desktop.
const NodeWebSocket = createRequire(import.meta.url)('ws') as typeof WebSocket
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// jsdom's AbortSignal is a different realm from Node fetch's signal. Forward
// cancellation into a native Node signal; the HTTP request is still real.
const loopbackFetch: typeof fetch = async (input, options) => {
  const native = transferableAbortController()
  const signal = options?.signal
  const abort = () => native.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try { return await fetch(input, { ...options, signal: native.signal }) }
  finally { signal?.removeEventListener('abort', abort) }
}

/** Real repository server and mock SDK CLI. Nothing contacts a saved Provider. */
export async function startManagedContextLoopback() {
  const root = path.resolve(process.cwd(), '..')
  const workDir = await mkdtemp(path.join(tmpdir(), 'context-dom-sdk-'))
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const token = 'context-dom-sdk-fixture-token'
  const sandbox = createQualityGateSandbox({ label: 'context-dom-sdk', seedProviders: false, sourceConfigDir: path.join(workDir, 'nonexistent-source'), envOverrides: {
    CLAUDE_CLI_PATH: path.join(root, 'src/server/__tests__/fixtures/mock-sdk-cli.ts'),
    CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1', CC_HAHA_LOCAL_ACCESS_TOKEN: token,
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*',
  } })
  const bun = process.env.BUN_EXECUTABLE ?? 'bun'
  const server = spawn(bun, ['--no-env-file', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root, env: { ...sandbox.env, SERVER_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  server.stdout.on('data', data => { log = (log + String(data)).slice(-5000) })
  server.stderr.on('data', data => { log = (log + String(data)).slice(-5000) })
  let spawnError: Error | null = null
  server.on('error', error => { spawnError = error })
  const exit = new Promise<void>(resolve => server.once('close', () => resolve()))
  const sessions = new Set<string>()
  const sockets = new Map<string, { ws: WebSocket; frames: LoopFrame[]; listener: ((frame: LoopFrame) => void) | null }>()
  const close = async () => {
    for (const sessionId of sessions) await loopbackFetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) }).catch(() => undefined)
    for (const socket of sockets.values()) { socket.listener = null; socket.ws.close() }
    server.kill()
    await exit
    sandbox.cleanup()
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  try {
    const deadline = Date.now() + 60000
    let lastHealth = 'not attempted'
    for (;;) {
      if (spawnError) throw spawnError
      if (server.exitCode !== null) throw new Error(`Mock server exited: ${log}`)
      const healthy = await loopbackFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }).then(r => { lastHealth = `HTTP ${r.status}`; return r.ok }).catch(error => { lastHealth = `${String(error)}; cause=${String(error?.cause)}`; return false })
      if (healthy) break
      if (Date.now() > deadline || (log.includes('server running at') && !lastHealth.includes('ECONNREFUSED'))) throw new Error(`Mock server health failed (${lastHealth}): ${log}`)
      await sleep(100)
    }
  } catch (error) { await close(); throw error }
  return {
    baseUrl, workDir,
    diagnostics() { return { log, sessions: [...sessions], frames: [...sockets.entries()].map(([id, value]) => ({ id, readyState: value.ws.readyState, frames: value.frames })) } },
    stageClient: createContextTicketClient({ getServerUrl: async () => baseUrl, getLocalAccessToken: () => token, fetchImpl: loopbackFetch }),
    async createSession() {
      const response = await loopbackFetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workDir }) })
      if (!response.ok) throw new Error(`Fixture session creation failed: ${response.status}`)
      const created = await response.json() as { sessionId: string }
      sessions.add(created.sessionId)
      const entry = { ws: new NodeWebSocket(`${baseUrl.replace('http:', 'ws:')}/ws/${created.sessionId}?localToken=${encodeURIComponent(token)}`), frames: [] as LoopFrame[], listener: null as ((frame: LoopFrame) => void) | null }
      sockets.set(created.sessionId, entry)
      entry.ws.onmessage = event => {
        const frame = JSON.parse(String(event.data)) as LoopFrame
        entry.frames.push(frame)
        entry.listener?.(frame)
      }
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Fixture WebSocket timeout')), 15000)
        entry.ws.onopen = () => { clearTimeout(deadline); resolve() }
        entry.ws.onerror = () => { clearTimeout(deadline); reject(new Error('Fixture WebSocket failed')) }
      })
      const until = Date.now() + 15000
      while (!entry.frames.some(frame => frame.type === 'connected')) {
        if (Date.now() > until) throw new Error('Missing fixture runtime handshake')
        await sleep(25)
      }
      return { sessionId: created.sessionId, workDir }
    },
    subscribe(sessionId: string, listener: (frame: LoopFrame) => void) {
      const entry = sockets.get(sessionId)
      if (!entry) throw new Error('Unknown loopback session')
      entry.listener = listener
      for (const frame of entry.frames) listener(frame)
      return () => { entry.listener = null }
    },
    send(sessionId: string, frame: unknown) {
      const entry = sockets.get(sessionId)
      if (!entry) throw new Error('Unknown loopback session')
      entry.ws.send(JSON.stringify(frame))
    },
    frames(sessionId: string) { return sockets.get(sessionId)?.frames ?? [] },
    close,
  }
}
