/**
 * M7-B loop contract — renderer-shaped selection through the real product.
 *
 * Boots the repository's own server against the mock SDK CLI (the
 * `check:agent-flow` harness: no provider, no credentials, no network) and runs
 * the §8.1–§8.3 loop end to end:
 *
 *   renderer frame (requestId + contextTicket) -> staging API -> WS frame ->
 *   ConversationService.buildUserContent -> mock SDK sees exactly ONE composed
 *   message, and its replay never reaches the SDK again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createServer } from 'node:net'
import { access, appendFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createQualityGateSandbox } from '../../../../../scripts/quality-gate/sandbox'
import { loadContractFixture, stageRequestBody } from './stagedFixture'
import { computeContentBinding } from '../wsBridge'
import { contextBindingOf } from '../../../../services/managedContext/canonicalSerializer'

const ROOT_DIR = resolve(import.meta.dir, '../../../../..')
const MOCK_CLI = 'src/server/__tests__/fixtures/mock-sdk-cli.ts'
const LOCAL_ACCESS_TOKEN = 'm7b-loop-token'

type Frame = Record<string, unknown>

async function getPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Server still booting.
    }
    await Bun.sleep(100)
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`)
}

async function findTranscriptPath(configDir: string, sessionId: string): Promise<string> {
  const projectsDir = join(configDir, 'projects')
  const dirs = await readdir(projectsDir, { withFileTypes: true })
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const candidate = join(projectsDir, dir.name, `${sessionId}.jsonl`)
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next project directory.
    }
  }
  throw new Error(`transcript not found for ${sessionId}`)
}

class Socket {
  readonly frames: Frame[] = []
  private ws: WebSocket | null = null

  constructor(private readonly baseUrl: string, private readonly sessionId: string) {}

  async open(): Promise<this> {
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws/${this.sessionId}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onmessage = (event) => {
      this.frames.push(JSON.parse(String(event.data)) as Frame)
    }
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 20_000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolveOpen()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('WebSocket failed to open'))
      }
    })
    await this.waitFor((frame) => frame.type === 'connected', 'connected')
    return this
  }

  send(frame: Frame): void {
    if (!this.ws) throw new Error('socket is not open')
    this.ws.send(JSON.stringify(frame))
  }

  async waitFor(
    predicate: (frame: Frame) => boolean,
    label: string,
    fromIndex = 0,
    timeoutMs = 30_000,
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs
    let cursor = fromIndex
    while (Date.now() < deadline) {
      while (cursor < this.frames.length) {
        const frame = this.frames[cursor]
        cursor += 1
        if (frame.type === 'error') {
          throw new Error(`server error while waiting for ${label}: ${JSON.stringify(frame)}`)
        }
        if (predicate(frame)) return frame
      }
      await Bun.sleep(25)
    }
    throw new Error(
      `timed out waiting for ${label}; saw ${this.frames.map((frame) => String(frame.type)).join(', ')}`,
    )
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}

describe('M7-B loop — one composed message and a replay that never reaches the SDK', () => {
  let sandboxHome = ''
  let workRoot = ''
  let server: ReturnType<typeof Bun.spawn> | null = null
  let baseUrl = ''
  const sockets: Socket[] = []

  beforeAll(async () => {
    const port = await getPort()
    baseUrl = `http://127.0.0.1:${port}`
    workRoot = await mkdtemp(join(tmpdir(), 'm7b-loop-work-'))
    const sandbox = createQualityGateSandbox({
      label: 'm7b-loop',
      seedProviders: false,
      envOverrides: {
        CLAUDE_CLI_PATH: resolve(ROOT_DIR, MOCK_CLI),
        CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
        CC_HAHA_LOCAL_ACCESS_TOKEN: LOCAL_ACCESS_TOKEN,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
      },
    })
    sandboxHome = sandbox.configDir
    server = Bun.spawn(
      [process.execPath, 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: ROOT_DIR,
        stdout: 'ignore',
        stderr: 'ignore',
        env: { ...sandbox.env, SERVER_PORT: String(port) },
      },
    )
    await waitForHealth(`${baseUrl}/health`, 60_000)
  }, 120_000)

  afterAll(async () => {
    for (const socket of sockets) socket.close()
    server?.kill()
    await server?.exited.catch(() => undefined)
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
    await rm(sandboxHome, { recursive: true, force: true }).catch(() => undefined)
  })

  it(
    'stages a renderer selection, composes once, and replays without a second turn',
    async () => {
      const fixture = loadContractFixture()
      const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: workRoot }),
      })
      expect(sessionResponse.ok).toBe(true)
      const { sessionId } = (await sessionResponse.json()) as { sessionId: string }

      const socket = await new Socket(baseUrl, sessionId).open()
      sockets.push(socket)

      // 1. Pin a runtime exactly like the desktop first-turn selector: this is
      //    what gives the session a runtime revision to stage against.
      socket.send({ type: 'set_runtime_config', providerId: null, modelId: 'current' })
      const applied = await socket.waitFor(
        (frame) => frame.type === 'runtime_config_applied',
        'runtime_config_applied',
      )
      const runtimeRevision = Number(applied.runtimeRevision)
      expect(Number.isInteger(runtimeRevision)).toBe(true)
      expect(runtimeRevision).toBeGreaterThan(0)

      const userText = 'hello from the managed-context loop'
      // 2. Stage the selection on the sidecar (loopback + bearer).
      const requestId = randomUUID()
      const staged = stageRequestBody(fixture)
      const body = {
        ...staged,
        sessionId,
        requestId,
        runtimeRevision,
        contentBinding: computeContentBinding(userText, []),
        publicManifest: {
          ...staged.publicManifest,
          requestId,
          ...('sessionId' in staged.publicManifest ? { sessionId } : {}),
          resolvedAt: new Date().toISOString(),
        },
      }
      const stageResponse = await fetch(`${baseUrl}/api/context-tickets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LOCAL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(body),
      })
      const stageBody = await stageResponse.text()
      expect(stageResponse.status, `staging failed: ${stageBody}`).toBe(201)
      const ticket = JSON.parse(stageBody) as {
        ticketId: string
        sidecarInstanceId: string
      }
      expect(ticket.ticketId).toHaveLength(43)

      // 3. The renderer-shaped frame: requestId + contextTicket + the original body.
      const frame = {
        type: 'user_message',
        content: userText,
        requestId: body.requestId,
        contextTicket: {
          ticketId: ticket.ticketId,
          sidecarInstanceId: ticket.sidecarInstanceId,
        },
        attachments: [],
      }
      const turnStart = socket.frames.length
      socket.send(frame)

      const accepted = await socket.waitFor(
        (message) => message.type === 'user_message_accepted',
        'user_message_accepted',
        turnStart,
      )
      expect(accepted.replayed).toBe(false)
      expect(accepted.status).toBe('accepted')
      expect(accepted.ticketId).toBe(ticket.ticketId)

      await socket.waitFor((message) => message.type === 'message_complete', 'message_complete', turnStart)
      const turn = socket.frames.slice(turnStart)
      const streamed = turn
        .filter((message) => message.type === 'content_delta' && typeof message.text === 'string')
        .map((message) => String(message.text))
        .join('')

      // The mock CLI echoes what the SDK received, so this is the SDK's view.
      expect(streamed.split('<cc-haha:managed-context>')).toHaveLength(2)
      expect(streamed.split('</cc-haha:managed-context>')).toHaveLength(2)
      expect(streamed.split(userText)).toHaveLength(2)
      // The staged model context and the original body, in one block, verbatim.
      expect(streamed).toContain(
        `<cc-haha:managed-context>\n${body.modelContext}\n</cc-haha:managed-context>\n\n${userText}`,
      )

      // 4. The frame is replayed: the original receipt comes back and the SDK is
      //    not called again.
      const replayStart = socket.frames.length
      socket.send(frame)
      const replayed = await socket.waitFor(
        (message) => message.type === 'user_message_accepted',
        'replayed user_message_accepted',
        replayStart,
      )
      expect(replayed.replayed).toBe(true)
      expect(replayed.requestId).toBe(body.requestId)

      await Bun.sleep(1500)
      const replayFrames = socket.frames.slice(replayStart)
      expect(replayFrames.some((message) => message.type === 'message_complete')).toBe(false)
      expect(
        replayFrames.filter((message) => message.type === 'content_delta'),
      ).toHaveLength(0)
    },
    120_000,
  )

  it(
    'delivers a disclosed credential only to the mock SDK and keeps every public surface clean',
    async () => {
      const secret = 'fake-host-password-123'
      const userText = 'secret context must stay private'
      const fixture = loadContractFixture()
      const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: workRoot }),
      })
      expect(sessionResponse.ok).toBe(true)
      const { sessionId } = (await sessionResponse.json()) as { sessionId: string }
      const socket = await new Socket(baseUrl, sessionId).open()
      sockets.push(socket)

      socket.send({ type: 'set_runtime_config', providerId: null, modelId: 'current' })
      const applied = await socket.waitFor(
        frame => frame.type === 'runtime_config_applied',
        'runtime_config_applied',
      )
      const runtimeRevision = Number(applied.runtimeRevision)
      const requestId = randomUUID()
      const staged = stageRequestBody(fixture)
      const selection = {
        ...staged.publicManifest.selection,
        includePasswords: true,
        credentialRefs: [{ id: '50000000-0000-4000-8000-000000000001', revision: 1 }],
      }
      const modelContext = JSON.stringify({
        managedResources: staged.modelContext,
        credentialSecrets: [{
          credentialId: '50000000-0000-4000-8000-000000000001',
          kind: 'ssh-password',
          label: 'selected host login',
          password: secret,
        }],
      })
      const publicManifest = {
        ...staged.publicManifest,
        requestId,
        selection,
        resolvedAt: new Date().toISOString(),
        containsSecrets: true,
        secretFieldCount: 1,
      }
      const body = {
        ...staged,
        sessionId,
        requestId,
        runtimeRevision,
        contentBinding: computeContentBinding(userText, []),
        contextBinding: contextBindingOf(selection),
        publicManifest,
        modelContext,
      }
      const stageResponse = await fetch(`${baseUrl}/api/context-tickets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LOCAL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(body),
      })
      const stageText = await stageResponse.text()
      expect(stageResponse.status, `secret staging failed: ${stageText}`).toBe(201)
      const ticket = JSON.parse(stageText) as { ticketId: string; sidecarInstanceId: string }
      expect(JSON.stringify(ticket)).not.toContain(secret)

      const start = socket.frames.length
      socket.send({
        type: 'user_message',
        content: userText,
        requestId,
        contextTicket: {
          ticketId: ticket.ticketId,
          sidecarInstanceId: ticket.sidecarInstanceId,
        },
        attachments: [],
      })
      const accepted = await socket.waitFor(
        frame => frame.type === 'user_message_accepted',
        'secret user_message_accepted',
        start,
      )
      expect(JSON.stringify(accepted)).not.toContain(secret)
      await socket.waitFor(frame => frame.type === 'message_complete', 'secret message_complete', start)
      const streamed = socket.frames.slice(start)
        .filter(frame => frame.type === 'content_delta' && typeof frame.text === 'string')
        .map(frame => String(frame.text))
        .join('')
      // The mock CLI echoes the exact SDK user text. This is the sole public test
      // assertion where the secret is expected to be observable.
      expect(streamed).toContain(secret)
      expect(streamed).toContain(userText)

      // The mock CLI does not persist normal turns. Append exactly what it saw to
      // the real Claude transcript file so the product history reader has a
      // secret-bearing raw record to project.
      const rawTranscriptUserContent = `<cc-haha:managed-context>\n${modelContext}\n</cc-haha:managed-context>\n\n${userText}`
      const transcriptPath = await findTranscriptPath(sandboxHome, sessionId)
      await appendFile(transcriptPath, `${JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: rawTranscriptUserContent },
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        userType: 'external',
        cwd: workRoot,
        sessionId,
      })}\n`, 'utf8')

      const messagesResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`)
      const messagesText = await messagesResponse.text()
      expect(messagesResponse.ok).toBe(true)
      expect(messagesText).not.toContain(secret)
      expect(messagesText).toContain(userText)

      const traceResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/trace`)
      const traceText = await traceResponse.text()
      expect(traceResponse.ok).toBe(true)
      expect(traceText).not.toContain(secret)

      const detailResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`)
      const detailText = await detailResponse.text()
      expect(detailResponse.ok).toBe(true)
      expect(detailText).not.toContain(secret)
      expect((JSON.parse(detailText) as { sensitiveContext?: boolean }).sensitiveContext).toBe(true)

      const listResponse = await fetch(`${baseUrl}/api/sessions?limit=100`)
      const listText = await listResponse.text()
      expect(listResponse.ok).toBe(true)
      expect(listText).not.toContain(secret)
      const listed = (JSON.parse(listText) as {
        sessions?: Array<{ id: string; sensitiveContext?: boolean }>
      }).sessions?.find(session => session.id === sessionId)
      expect(listed?.sensitiveContext).toBe(true)

      const searchResponse = await fetch(`${baseUrl}/api/search/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: secret }),
      })
      const searchText = await searchResponse.text()
      expect(searchResponse.ok).toBe(true)
      expect(searchText).not.toContain(secret)
      expect((JSON.parse(searchText) as { results?: unknown[] }).results ?? []).toEqual([])
    },
    120_000,
  )

  it(
    'refuses a stale ticket instead of sending it',
    async () => {
      const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: workRoot }),
      })
      const { sessionId } = (await sessionResponse.json()) as { sessionId: string }
      const socket = await new Socket(baseUrl, sessionId).open()
      sockets.push(socket)

      // A ticket-shaped frame for a request the sidecar never staged.
      const start = socket.frames.length
      socket.send({
        type: 'user_message',
        content: 'stale context must not be sent',
        requestId: randomUUID(),
        contextTicket: {
          ticketId: 'A'.repeat(43),
          sidecarInstanceId: randomUUID(),
        },
      })
      const rejected = await socket.waitFor(
        (message) => message.type === 'user_message_rejected',
        'user_message_rejected',
        start,
      )
      expect(rejected.code).toBe('SIDECAR_INSTANCE_CHANGED')
      expect(rejected.retryable).toBe(true)

      await Bun.sleep(500)
      const frames = socket.frames.slice(start)
      expect(frames.some((message) => message.type === 'message_complete')).toBe(false)
      expect(frames.some((message) => message.type === 'content_delta')).toBe(false)
    },
    60_000,
  )
})
