import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { sessionService } from '../services/sessionService.js'
import {
  readTraceCaptureSettings,
  traceCaptureService,
  updateTraceCaptureSettings,
  type TraceSessionFileItem,
  type TraceSessionListItem,
} from '../services/traceCaptureService.js'

export type TraceSessionListApiItem = TraceSessionListItem & {
  session: {
    id: string
    title: string
    projectPath: string
    workDir: string
  } | null
}

function methodNotAllowed(method: string, route: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed on ${route}`, 'METHOD_NOT_ALLOWED')
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw ApiError.badRequest('Invalid JSON body')
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('Invalid JSON body')
  }
}

export async function handleTracesApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    switch (sub) {
      case undefined:
        if (req.method !== 'GET') throw methodNotAllowed(req.method, '/api/traces')
        return await listTraces(url)

      case 'settings':
        if (req.method === 'GET') {
          return Response.json(await readTraceCaptureSettings())
        }
        if (req.method === 'PUT') {
          const body = await parseJsonBody(req)
          const input: { enabled?: boolean } = {}
          if (typeof body.enabled === 'boolean') input.enabled = body.enabled
          return Response.json(await updateTraceCaptureSettings(input))
        }
        throw methodNotAllowed(req.method, '/api/traces/settings')

      default:
        throw ApiError.notFound(`Unknown traces endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

async function listTraces(url: URL): Promise<Response> {
  const limit = parseTraceListLimit(url.searchParams.get('limit'))
  const offset = parseTraceListOffset(url.searchParams.get('offset'))
  const query = url.searchParams.get('q')?.trim() || ''

  if (query) {
    return listSearchedTraces(query, limit, offset)
  }

  const result = await traceCaptureService.listSessionTraces({ limit, offset })
  const decorated = await Promise.all(result.traces.map(decorateTraceListItem))

  return Response.json({
    ...result,
    traces: decorated,
  })
}

async function listSearchedTraces(query: string, limit: number, offset: number): Promise<Response> {
  const fileResult = await traceCaptureService.listSessionTraceFiles()
  const candidates = await Promise.all(fileResult.files.map(decorateTraceFileCandidate))
  const filtered = candidates.filter((item) => traceListItemMatchesQuery(item, query))
  const pageCandidates = filtered.slice(offset, offset + limit)
  const pageSessionIds = pageCandidates.map((item) => item.sessionId)
  if (pageSessionIds.length === 0) {
    return Response.json({
      traces: [],
      total: filtered.length,
      storageDir: fileResult.storageDir,
      settings: fileResult.settings,
    })
  }

  const pageResult = await traceCaptureService.listSessionTraces({
    sessionIds: pageSessionIds,
    limit: pageSessionIds.length,
    offset: 0,
  })
  const itemsBySessionId = new Map(pageResult.traces.map((item) => [item.sessionId, item]))
  const traces = pageCandidates.flatMap((candidate) => {
    const trace = itemsBySessionId.get(candidate.sessionId)
    if (!trace) return []
    return [{
      ...trace,
      session: candidate.session,
    }]
  })

  return Response.json({
    ...pageResult,
    total: filtered.length,
    storageDir: fileResult.storageDir,
    settings: fileResult.settings,
    traces,
  })
}

async function decorateTraceListItem(item: TraceSessionListItem): Promise<TraceSessionListApiItem> {
  const session = await sessionService.getSession(item.sessionId).catch(() => null)
  return {
    ...item,
    session: session
      ? {
          id: session.id,
          title: session.title,
          projectPath: session.projectPath,
          workDir: session.workDir,
        }
      : null,
  }
}

async function decorateTraceFileCandidate(item: TraceSessionFileItem): Promise<Pick<TraceSessionListApiItem, 'sessionId' | 'session'>> {
  const session = await sessionService.getSession(item.sessionId).catch(() => null)
  return {
    sessionId: item.sessionId,
    session: session
      ? {
          id: session.id,
          title: session.title,
          projectPath: session.projectPath,
          workDir: session.workDir,
        }
      : null,
  }
}

function traceListItemMatchesQuery(item: Pick<TraceSessionListApiItem, 'sessionId' | 'session'>, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = [
    item.sessionId,
    item.session?.title,
    item.session?.projectPath,
    item.session?.workDir,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

function parseTraceListLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '50', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 50
  return Math.min(Math.max(Math.round(parsed), 1), 200)
}

function parseTraceListOffset(value: string | null): number {
  const parsed = Number.parseInt(value || '0', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed
}
