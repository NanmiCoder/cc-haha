import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  getRuntimeTunnelState,
  H5AccessService,
  setRuntimeTunnelState,
  type H5TunnelMode,
} from '../services/h5AccessService.js'
import { refreshDisconnectGraceMs } from '../ws/disconnectGraceConfig.js'

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
          const [settings, diagnostics] = await Promise.all([
            h5AccessService.getSettings(),
            h5AccessService.getDiagnostics(),
          ])
          return Response.json({ settings, diagnostics })
        }
        if (req.method === 'PUT') {
          const body = await parseJsonBody(req)
          const settings = await h5AccessService.updateSettings({
            allowedOrigins: body.allowedOrigins as string[] | undefined,
            publicBaseUrl: body.publicBaseUrl as string | null | undefined,
            fixedPort: body.fixedPort as number | null | undefined,
            disconnectGraceSeconds: body.disconnectGraceSeconds as number | null | undefined,
            tunnelToken: body.tunnelToken as string | null | undefined,
            tunnelMode: body.tunnelMode as H5TunnelMode | null | undefined,
          })
          // Keep the synchronous disconnect-cleanup cache in step with the new value.
          await refreshDisconnectGraceMs()
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

      case 'tunnel': {
        // The desktop main process owns the cloudflared lifecycle; these
        // endpoints only mirror the resulting state into the server process so
        // the effective publicBaseUrl / diagnostics reflect the live tunnel.
        // The whole /api/h5-access surface (except verify) is already gated to
        // local-trusted callers upstream, so remote browsers get 403 here.
        const action = segments[3]

        if (action === undefined) {
          if (req.method !== 'GET') {
            throw methodNotAllowed(req.method, '/api/h5-access/tunnel')
          }
          return Response.json({ tunnel: getRuntimeTunnelState() })
        }

        if (action === 'report') {
          if (req.method !== 'POST') {
            throw methodNotAllowed(req.method, '/api/h5-access/tunnel/report')
          }
          const body = await parseJsonBody(req)
          // Only treat url as present when it is actually a string. A missing
          // url (e.g. a status-only heartbeat) leaves the runtime URL untouched
          // rather than clearing it — clearing is done via tunnel/clear.
          const url = typeof body.url === 'string' ? body.url : undefined
          const status = body.status === 'starting' || body.status === 'running'
            || body.status === 'error' || body.status === 'idle'
            ? body.status
            : undefined
          const mode = body.mode === 'quick' || body.mode === 'named'
            ? (body.mode as H5TunnelMode)
            : undefined
          const error = typeof body.error === 'string' ? body.error : null
          setRuntimeTunnelState({ url, status, mode, error })
          const settings = await h5AccessService.getSettings()
          return Response.json({ settings, tunnel: getRuntimeTunnelState() })
        }

        if (action === 'clear') {
          if (req.method !== 'POST') {
            throw methodNotAllowed(req.method, '/api/h5-access/tunnel/clear')
          }
          setRuntimeTunnelState({ status: 'idle', url: null, error: null })
          const settings = await h5AccessService.getSettings()
          return Response.json({ settings, tunnel: getRuntimeTunnelState() })
        }

        throw ApiError.notFound(`Unknown h5-access tunnel endpoint: ${action}`)
      }

      default:
        throw ApiError.notFound(`Unknown h5-access endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}
