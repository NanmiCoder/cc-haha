import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { H5AccessService } from '../services/h5AccessService.js'

const h5AccessService = new H5AccessService()

function methodNotAllowed(method: string, route: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed on ${route}`, 'METHOD_NOT_ALLOWED')
}

function getBearerToken(req: Request): string | null {
  const authorization = req.headers.get('authorization')
  if (!authorization) {
    return null
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw ApiError.badRequest('Invalid JSON body')
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) {
      throw error
    }
    throw ApiError.badRequest('Invalid JSON body')
  }
}

export async function handleH5AccessApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    switch (sub) {
      case undefined:
        if (req.method === 'GET') {
          return Response.json({ settings: await h5AccessService.getSettings() })
        }
        if (req.method === 'PUT') {
          const body = await parseJsonBody(req)
          const settings = await h5AccessService.updateSettings({
            allowedOrigins: body.allowedOrigins as string[] | undefined,
            publicBaseUrl: body.publicBaseUrl as string | null | undefined,
          })
          return Response.json({ settings })
        }
        throw methodNotAllowed(req.method, '/api/h5-access')

      case 'enable':
        if (req.method !== 'POST') {
          throw methodNotAllowed(req.method, '/api/h5-access/enable')
        }
        return Response.json(await h5AccessService.enable())

      case 'disable':
        if (req.method !== 'POST') {
          throw methodNotAllowed(req.method, '/api/h5-access/disable')
        }
        return Response.json({ settings: await h5AccessService.disable() })

      case 'regenerate':
        if (req.method !== 'POST') {
          throw methodNotAllowed(req.method, '/api/h5-access/regenerate')
        }
        return Response.json(await h5AccessService.regenerateToken())

      case 'verify': {
        if (req.method !== 'POST') {
          throw methodNotAllowed(req.method, '/api/h5-access/verify')
        }

        const token = getBearerToken(req)
        const isValid = await h5AccessService.validateToken(token)
        if (!isValid) {
          throw new ApiError(401, 'Invalid or missing H5 access token', 'UNAUTHORIZED')
        }

        return Response.json({ ok: true })
      }

      default:
        throw ApiError.notFound(`Unknown h5-access endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}
