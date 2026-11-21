import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../../scripts/pr/test-environment.js'

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 10_000
  let value: T
  do {
    value = await read()
    if (ready(value)) return value
    await Bun.sleep(20)
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(value!)}`)
}

test('prompt optimize HTTP controls work on empty, running, and idle sessions without mutating transcript', async () => {
  const home = await mkdtemp(join(tmpdir(), 'prompt-optimize-e2e-'))
  const original = { ...process.env }
  const env = createSandboxedTestEnvironment(home, {
    CLAUDE_CLI_PATH: fileURLToPath(
      new URL('../fixtures/mock-sdk-cli.ts', import.meta.url),
    ),
    CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
    MOCK_SDK_STREAM_DELAY_MS: '1200',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  let server: ReturnType<typeof Bun.serve> | undefined
  let socket: WebSocket | undefined
  let shutdown: (() => Promise<void>) | undefined
  try {
    const workDir = join(home, 'project')
    await mkdir(workDir)
    const runtime = await import('../../index.js')
    shutdown = runtime.stopServerRuntimeForShutdown
    server = runtime.startServer(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`

    async function api(path: string, body?: unknown) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`)
      }
      return data as any
    }

    const root = await api('/api/sessions', { workDir })
    const endpoint = `/api/sessions/${root.sessionId}/optimize-prompt`

    // Works on a brand-new empty session before any user turn is sent.
    const emptyReqId = crypto.randomUUID()
    const emptyResult = await api(endpoint, {
      requestId: emptyReqId,
      prompt: 'optimize on empty session',
    })
    expect(emptyResult).toEqual({
      requestId: emptyReqId,
      optimizedPrompt: 'Optimized: optimize on empty session (main idle)',
    })

    const events: any[] = []
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${root.sessionId}`)
    socket.addEventListener('message', event =>
      events.push(JSON.parse(String(event.data))),
    )
    await eventually(
      async () => events,
      values => values.some(value => value.type === 'connected'),
      'root websocket',
    )

    // Works mid-turn without interrupting the main stream or leaking into WS events.
    socket.send(JSON.stringify({ type: 'user_message', content: 'Main fixture task' }))
    await eventually(
      async () => events,
      values => values.some(value => value.type === 'thinking' || value.type === 'content_start'),
      'main turn started',
    )
    const midTurnId = crypto.randomUUID()
    const midTurn = await api(endpoint, {
      requestId: midTurnId,
      prompt: 'refine next draft',
    })
    expect(midTurn.requestId).toBe(midTurnId)
    expect(midTurn.optimizedPrompt).toBe('Optimized: refine next draft (main running)')

    // Duplicate requestId is rejected.
    const duplicate = await fetch(base + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: midTurnId, prompt: 'duplicate' }),
    })
    expect(duplicate.status).toBe(409)

    // Cancellation via DELETE aborts only the optimization.
    const cancelId = crypto.randomUUID()
    const pending = fetch(base + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: cancelId,
        prompt: 'MOCK_SLOW cancelled prompt',
      }),
    })
    await Bun.sleep(100)
    const cancelled = await fetch(`${base}${endpoint}/${cancelId}`, {
      method: 'DELETE',
    })
    expect(await cancelled.json()).toEqual({
      requestId: cancelId,
      cancelled: true,
    })
    expect((await pending).status).toBe(499)

    // Main turn completes uninterrupted.
    await eventually(
      async () => events,
      values => values.some(value => value.type === 'message_complete'),
      'main turn completes',
    )
    expect(events.some(event => event.type === 'error')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('Optimized:')
    expect(JSON.stringify(events)).not.toContain('refine next draft')

    // Idle optimization after a turn.
    const idleResult = await api(endpoint, {
      requestId: crypto.randomUUID(),
      prompt: 'after turn draft',
    })
    expect(idleResult.optimizedPrompt).toBe('Optimized: after turn draft (main idle)')

    // Validation & error boundaries.
    const invalid = await fetch(base + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), prompt: '   ' }),
    })
    expect(invalid.status).toBe(400)

    const oversized = await fetch(base + endpoint, {
      method: 'POST',
      body: 'a'.repeat(256 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)

    const missing = await fetch(
      `${base}/api/sessions/${crypto.randomUUID()}/optimize-prompt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), prompt: 'hello' }),
      },
    )
    expect(missing.status).toBe(404)

    // Transcript never contains ephemeral prompt optimization traffic.
    const transcript = await api(`/api/sessions/${root.sessionId}/messages`)
    expect(JSON.stringify(transcript)).not.toContain('Optimized:')
    expect(JSON.stringify(transcript)).not.toContain('refine next draft')
  } finally {
    socket?.close()
    await shutdown?.()
    server?.stop(true)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
