import { getCwd } from '../../utils/cwd.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { AgentGatewayService } from '../services/agentGatewayService.js'
import { AgentRuntimeService } from '../services/agentRuntimeService.js'

const agentRuntimeService = new AgentRuntimeService()
const agentGatewayService = new AgentGatewayService()

export async function handleAgentRuntimeApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const cwd = url.searchParams.get('cwd') || getCwd()
    const sub = segments[2]

    if (!sub) {
      if (req.method !== 'GET') {
        throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
      }
      return Response.json({
        runtime: agentRuntimeService.getRuntimeProfile(cwd),
      })
    }

    if (sub === 'registry') {
      return await handleRegistry(req, cwd, segments.slice(3))
    }

    if (sub === 'gateway') {
      return await handleGateway(req, segments.slice(3))
    }

    throw ApiError.notFound(`Unknown agent-runtime endpoint: ${sub}`)
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleGateway(
  req: Request,
  tail: string[],
): Promise<Response> {
  if (tail.length === 0) {
    if (req.method !== 'GET') {
      throw new ApiError(
        405,
        `Method ${req.method} not allowed on /api/agent-runtime/gateway`,
        'METHOD_NOT_ALLOWED',
      )
    }
    return Response.json({ gateway: agentGatewayService.getSnapshot() })
  }

  const resource = tail[0]
  if (resource === 'clients' && tail.length === 1) {
    if (req.method === 'GET') {
      return Response.json({ clients: agentGatewayService.listClients() })
    }
    if (req.method === 'POST') {
      const body = await parseJsonBody(req)
      const result = agentGatewayService.registerClient(body)
      return Response.json(
        { client: result.client, created: result.created },
        { status: result.created ? 201 : 200 },
      )
    }
    throw new ApiError(
      405,
      `Method ${req.method} not allowed on /api/agent-runtime/gateway/clients`,
      'METHOD_NOT_ALLOWED',
    )
  }

  if (resource === 'messages' && tail.length === 1) {
    if (req.method !== 'POST') {
      throw new ApiError(
        405,
        `Method ${req.method} not allowed on /api/agent-runtime/gateway/messages`,
        'METHOD_NOT_ALLOWED',
      )
    }
    const body = await parseJsonBody(req)
    const result = await agentGatewayService.sendRestMessage(body)
    return Response.json({ message: result }, { status: 202 })
  }

  throw ApiError.notFound(`Unknown agent-runtime gateway endpoint: ${tail.join('/')}`)
}

async function handleRegistry(
  req: Request,
  cwd: string,
  tail: string[],
): Promise<Response> {
  if (tail.length === 0) {
    if (req.method === 'GET') {
      return Response.json({
        registry: await agentRuntimeService.getRuntimeRegistry(cwd),
      })
    }
    if (req.method === 'POST') {
      const body = await parseJsonBody(req)
      const result = await agentRuntimeService.registerRuntimeEntry(body)
      return Response.json(
        {
          entry: result.entry,
          created: result.created,
        },
        { status: result.created ? 201 : 200 },
      )
    }
    throw new ApiError(
      405,
      `Method ${req.method} not allowed on /api/agent-runtime/registry`,
      'METHOD_NOT_ALLOWED',
    )
  }

  if (tail.length !== 2) {
    throw ApiError.notFound(`Unknown agent-runtime registry endpoint: ${tail.join('/')}`)
  }

  const [kind, id] = tail.map((segment) => decodeURIComponent(segment)) as [string, string]

  if (req.method === 'GET') {
    const registry = await agentRuntimeService.getRuntimeRegistry(cwd)
    const entry = registry.entries.find(
      (candidate) => candidate.kind === kind && candidate.id === id,
    )
    if (!entry) {
      throw ApiError.notFound(`Runtime entry not found: ${kind}/${id}`)
    }
    return Response.json({ entry })
  }

  if (req.method !== 'DELETE') {
    throw new ApiError(
      405,
      `Method ${req.method} not allowed on /api/agent-runtime/registry/${kind}/${id}`,
      'METHOD_NOT_ALLOWED',
    )
  }

  const deleted = await agentRuntimeService.deleteRuntimeEntry(kind, id)
  return Response.json({ ok: true, deleted })
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}
