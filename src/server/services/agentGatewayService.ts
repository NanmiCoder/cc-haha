import { ApiError } from '../middleware/errorHandler.js'
import { conversationService } from './conversationService.js'
import { sessionService } from './sessionService.js'
import type { ServerMessage } from '../ws/events.js'

export type AgentGatewayClientType = 'rest' | 'websocket' | 'adapter'

export type AgentGatewayClient = {
  id: string
  type: AgentGatewayClientType
  displayName: string
  metadata?: Record<string, unknown>
  registeredAt: string
  updatedAt: string
}

export type AgentGatewaySnapshot = {
  status: 'running'
  controlPlane: {
    mode: 'gateway-like-server'
    transports: Array<'rest' | 'websocket'>
    endpoints: string[]
  }
  clients: {
    total: number
    byType: Record<AgentGatewayClientType, number>
  }
  sessions: {
    activeCliSessions: number
  }
}

export type GatewayMessageInput = {
  clientId?: string
  clientType?: AgentGatewayClientType
  sessionId?: string
  workDir?: string
  content: string
  mode?: 'live' | 'transport-test'
}

export type GatewayMessageResult = {
  sessionId: string
  clientId: string
  transport: 'rest'
  status: 'queued' | 'completed'
  responseText?: string
  events?: ServerMessage[]
}

const clients = new Map<string, AgentGatewayClient>()

export class AgentGatewayService {
  getSnapshot(): AgentGatewaySnapshot {
    return {
      status: 'running',
      controlPlane: {
        mode: 'gateway-like-server',
        transports: ['rest', 'websocket'],
        endpoints: [
          '/api/agent-runtime/gateway',
          '/api/agent-runtime/gateway/clients',
          '/api/agent-runtime/gateway/messages',
          '/ws/:sessionId',
        ],
      },
      clients: {
        total: clients.size,
        byType: countClientsByType([...clients.values()]),
      },
      sessions: {
        activeCliSessions: conversationService.getActiveSessions().length,
      },
    }
  }

  listClients(): AgentGatewayClient[] {
    return [...clients.values()].map(cloneClient)
  }

  registerClient(input: unknown): { client: AgentGatewayClient; created: boolean } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw ApiError.badRequest('Invalid gateway client body')
    }

    const body = input as Record<string, unknown>
    const id = readId(body.clientId ?? body.id, 'clientId')
    const type = parseClientType(body.clientType ?? body.type)
    const displayName = readOptionalString(body.displayName, 'displayName', 120) ?? id
    const metadata = readOptionalMetadata(body.metadata)
    const existing = clients.get(id)
    const now = new Date().toISOString()
    const client: AgentGatewayClient = {
      id,
      type,
      displayName,
      ...(metadata !== undefined && { metadata }),
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    }

    clients.set(id, client)
    return { client: cloneClient(client), created: !existing }
  }

  async sendRestMessage(input: unknown): Promise<GatewayMessageResult> {
    const message = validateGatewayMessage(input)
    const client = this.ensureClient(message.clientId, message.clientType)
    const sessionId = message.sessionId ?? (await sessionService.createSession(message.workDir)).sessionId

    if (message.mode === 'transport-test' || process.env.YUANCLAW_GATEWAY_TRANSPORT_HARNESS === '1') {
      const responseText = `transport harness response for ${message.content}`
      const events: ServerMessage[] = [
        { type: 'status', state: 'streaming', verb: 'Gateway transport harness' },
        { type: 'content_start', blockType: 'text' },
        { type: 'content_delta', text: responseText },
        { type: 'message_complete', usage: { input_tokens: 0, output_tokens: 0 } },
      ]
      return {
        sessionId,
        clientId: client.id,
        transport: 'rest',
        status: 'completed',
        responseText,
        events,
      }
    }

    if (!conversationService.hasSession(sessionId)) {
      throw ApiError.conflict(
        'REST live gateway chat requires an active WebSocket/CLI session. Connect /ws/:sessionId first or use mode=transport-test for transport verification.',
      )
    }

    const sent = conversationService.sendMessage(sessionId, message.content)
    if (!sent) {
      throw ApiError.conflict('CLI session is not running for gateway message')
    }

    return {
      sessionId,
      clientId: client.id,
      transport: 'rest',
      status: 'queued',
    }
  }

  private ensureClient(
    clientId: string | undefined,
    clientType: AgentGatewayClientType | undefined,
  ): AgentGatewayClient {
    const id = clientId ?? `rest-${crypto.randomUUID()}`
    const existing = clients.get(id)
    if (existing) return cloneClient(existing)

    const now = new Date().toISOString()
    const client: AgentGatewayClient = {
      id,
      type: clientType ?? 'rest',
      displayName: id,
      registeredAt: now,
      updatedAt: now,
    }
    clients.set(id, client)
    return cloneClient(client)
  }
}

function validateGatewayMessage(input: unknown): GatewayMessageInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw ApiError.badRequest('Invalid gateway message body')
  }

  const body = input as Record<string, unknown>
  const content = readRequiredString(body.content, 'content', 100_000)
  const clientId = body.clientId === undefined ? undefined : readId(body.clientId, 'clientId')
  const clientType = body.clientType === undefined ? undefined : parseClientType(body.clientType)
  const sessionId = body.sessionId === undefined ? undefined : readId(body.sessionId, 'sessionId')
  const workDir = readOptionalString(body.workDir, 'workDir', 2000)
  const mode = parseMode(body.mode)

  return {
    ...(clientId !== undefined && { clientId }),
    ...(clientType !== undefined && { clientType }),
    ...(sessionId !== undefined && { sessionId }),
    ...(workDir !== undefined && { workDir }),
    content,
    ...(mode !== undefined && { mode }),
  }
}

function countClientsByType(clientsToCount: AgentGatewayClient[]): Record<AgentGatewayClientType, number> {
  return clientsToCount.reduce<Record<AgentGatewayClientType, number>>(
    (counts, client) => {
      counts[client.type] += 1
      return counts
    },
    { rest: 0, websocket: 0, adapter: 0 },
  )
}

function cloneClient(client: AgentGatewayClient): AgentGatewayClient {
  return {
    ...client,
    ...(client.metadata !== undefined && { metadata: { ...client.metadata } }),
  }
}

function parseClientType(value: unknown): AgentGatewayClientType {
  if (value === 'rest' || value === 'websocket' || value === 'adapter') return value
  throw ApiError.badRequest('Invalid "clientType". Expected one of: rest, websocket, adapter')
}

function parseMode(value: unknown): 'live' | 'transport-test' | undefined {
  if (value === undefined) return undefined
  if (value === 'live' || value === 'transport-test') return value
  throw ApiError.badRequest('Invalid "mode". Expected one of: live, transport-test')
}

function readId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`Invalid "${fieldName}". Expected a string`)
  }
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id)) {
    throw ApiError.badRequest(
      `Invalid "${fieldName}". Use 1-80 letters, numbers, dots, underscores, colons, or hyphens`,
    )
  }
  return id
}

function readRequiredString(value: unknown, fieldName: string, maxLength: number): string {
  const result = readOptionalString(value, fieldName, maxLength)
  if (result === undefined) {
    throw ApiError.badRequest(`"${fieldName}" is required`)
  }
  return result
}

function readOptionalString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`Invalid "${fieldName}". Expected a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw ApiError.badRequest(
      `Invalid "${fieldName}". Expected 1-${maxLength} characters`,
    )
  }
  return trimmed
}

function readOptionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('Invalid "metadata". Expected an object')
  }
  return value as Record<string, unknown>
}
