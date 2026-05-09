import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { DoctorService } from '../services/doctorService.js'

export async function handleDoctorApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    if ((req.method === 'GET' && !sub) || (req.method === 'GET' && sub === 'report')) {
      const cwd = url.searchParams.get('cwd') || undefined
      const service = new DoctorService({ projectRoot: cwd })
      return Response.json({ report: await service.getReport() })
    }

    if (req.method === 'POST' && sub === 'repair') {
      const body = await parseJsonBody(req)
      const cwd = typeof body.cwd === 'string' ? body.cwd : url.searchParams.get('cwd') || undefined
      const targetIds = Array.isArray(body.targetIds)
        ? body.targetIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : undefined
      const service = new DoctorService({ projectRoot: cwd })
      return Response.json({ result: await service.repair(targetIds) })
    }

    if (!sub) {
      throw methodNotAllowed(req.method, '/api/doctor')
    }

    throw ApiError.notFound(`Unknown doctor endpoint: ${sub}`)
  } catch (error) {
    return errorResponse(error)
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  if (
    !req.headers.get('content-length') &&
    !req.headers.get('transfer-encoding') &&
    !req.headers.get('content-type')
  ) {
    return {}
  }

  try {
    const body = await req.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string, route: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed on ${route}`, 'METHOD_NOT_ALLOWED')
}
