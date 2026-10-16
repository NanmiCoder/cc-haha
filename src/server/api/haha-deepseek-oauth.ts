import {
  DEEPSEEK_OAUTH_SUCCESS_HTML,
  hahaDeepSeekOAuthService,
} from '../services/hahaDeepSeekOAuthService.js'
import { errorResponse } from '../middleware/errorHandler.js'

async function readStartBody(req: Request): Promise<{ locale?: string }> {
  try {
    const body: unknown = await req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const locale = (body as Record<string, unknown>).locale
      if (typeof locale === 'string' && locale.length > 0 && locale.length <= 32) {
        return { locale }
      }
    }
  } catch {
    // An empty or non-JSON body means "use the server's locale".
  }
  return {}
}

export async function handleHahaDeepSeekOAuthApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2]
    if (action === 'start' && req.method === 'POST') {
      const session = await hahaDeepSeekOAuthService.startSession(
        await readStartBody(req),
      )
      return Response.json({
        authorizeUrl: session.authorizeUrl,
        state: session.state,
      })
    }

    if (action === 'success' && req.method === 'GET') {
      return new Response(DEEPSEEK_OAUTH_SUCCESS_HTML, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/html; charset=utf-8',
        },
      })
    }

    if (action === undefined && req.method === 'GET') {
      return Response.json(await hahaDeepSeekOAuthService.getStatus())
    }

    if (action === undefined && req.method === 'DELETE') {
      await hahaDeepSeekOAuthService.logout()
      return Response.json({ ok: true })
    }

    return Response.json({ error: 'Not Found' }, { status: 404 })
  } catch (error) {
    return errorResponse(error)
  }
}
