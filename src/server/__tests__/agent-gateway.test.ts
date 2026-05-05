import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'
import { handleWebSocket, sendToSession } from '../ws/handler.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalHarness: string | undefined

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return {
    req: new Request(url.toString(), init),
    url,
  }
}

function makeWs(sessionId: string) {
  const sent: unknown[] = []
  return {
    sent,
    ws: {
      data: {
        sessionId,
        connectedAt: Date.now(),
        channel: 'client',
        sdkToken: null,
        serverPort: 3456,
        serverHost: '127.0.0.1',
      },
      send(data: string) {
        sent.push(JSON.parse(data))
      },
      close() {},
    } as any,
  }
}

describe('Agent Runtime Gateway', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-gateway-api-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHarness = process.env.YUANCLAW_GATEWAY_TRANSPORT_HARNESS
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.YUANCLAW_GATEWAY_TRANSPORT_HARNESS = '1'
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalHarness === undefined) {
      delete process.env.YUANCLAW_GATEWAY_TRANSPORT_HARNESS
    } else {
      process.env.YUANCLAW_GATEWAY_TRANSPORT_HARNESS = originalHarness
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('exposes a startable gateway surface on the existing agent runtime control plane', async () => {
    const { req, url } = makeRequest('GET', '/api/agent-runtime/gateway')

    const res = await handleApiRequest(req, url)
    const body = await res.json() as {
      gateway: {
        status: string
        controlPlane: {
          mode: string
          transports: string[]
          endpoints: string[]
        }
        clients: { total: number }
      }
    }

    expect(res.status).toBe(200)
    expect(body.gateway.status).toBe('running')
    expect(body.gateway.controlPlane).toMatchObject({
      mode: 'gateway-like-server',
      transports: expect.arrayContaining(['rest', 'websocket']),
    })
    expect(body.gateway.controlPlane.endpoints).toEqual(
      expect.arrayContaining([
        '/api/agent-runtime/gateway',
        '/api/agent-runtime/gateway/clients',
        '/api/agent-runtime/gateway/messages',
        '/ws/:sessionId',
      ]),
    )
    expect(body.gateway.clients.total).toBe(0)
  })

  it('registers gateway clients independently of the removed desktop app', async () => {
    const create = makeRequest('POST', '/api/agent-runtime/gateway/clients', {
      clientId: 'rest-client',
      clientType: 'rest',
      displayName: 'REST Client',
      metadata: { source: 'test' },
    })

    const createRes = await handleApiRequest(create.req, create.url)
    const createBody = await createRes.json() as {
      client: { id: string; type: string; displayName: string }
    }

    expect(createRes.status).toBe(201)
    expect(createBody.client).toMatchObject({
      id: 'rest-client',
      type: 'rest',
      displayName: 'REST Client',
    })

    const list = makeRequest('GET', '/api/agent-runtime/gateway/clients')
    const listRes = await handleApiRequest(list.req, list.url)
    const listBody = await listRes.json() as {
      clients: Array<{ id: string; type: string }>
    }

    expect(listRes.status).toBe(200)
    expect(listBody.clients).toContainEqual(
      expect.objectContaining({ id: 'rest-client', type: 'rest' }),
    )
  })

  it('accepts REST client chat through the gateway transport harness', async () => {
    const send = makeRequest('POST', '/api/agent-runtime/gateway/messages', {
      clientId: 'rest-client',
      clientType: 'rest',
      content: 'hello from rest',
      workDir: tmpDir,
      mode: 'transport-test',
    })

    const res = await handleApiRequest(send.req, send.url)
    const body = await res.json() as {
      message: {
        sessionId: string
        clientId: string
        transport: string
        status: string
        responseText: string
        events: Array<{ type: string; text?: string }>
      }
    }

    expect(res.status).toBe(202)
    expect(body.message.clientId).toBe('rest-client')
    expect(body.message.transport).toBe('rest')
    expect(body.message.status).toBe('completed')
    expect(body.message.sessionId).toBeTruthy()
    expect(body.message.responseText).toContain('hello from rest')
    expect(body.message.events).toContainEqual(
      expect.objectContaining({ type: 'message_complete' }),
    )
  })

  it('broadcasts WebSocket session events to every connected client', () => {
    const sessionId = `gateway-ws-${crypto.randomUUID()}`
    const first = makeWs(sessionId)
    const second = makeWs(sessionId)

    handleWebSocket.open(first.ws)
    handleWebSocket.open(second.ws)

    const sent = sendToSession(sessionId, {
      type: 'status',
      state: 'streaming',
      verb: 'Testing fan-out',
    })

    expect(sent).toBe(true)
    expect(first.sent).toContainEqual(
      expect.objectContaining({ type: 'status', state: 'streaming' }),
    )
    expect(second.sent).toContainEqual(
      expect.objectContaining({ type: 'status', state: 'streaming' }),
    )
  })
})
