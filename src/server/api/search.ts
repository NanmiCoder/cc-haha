/**
 * Search REST API
 *
 * POST /api/search          — 全局工作区搜索
 * POST /api/search/sessions — 搜索会话历史
 */

import { SearchService } from '../services/searchService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const searchService = new SearchService()

export async function handleSearchApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const sub = segments[2] // 'sessions' | undefined

    if (method !== 'POST') {
      throw new ApiError(
        405,
        `Method ${method} not allowed. Use POST.`,
        'METHOD_NOT_ALLOWED',
      )
    }

    const body = await parseJsonBody(req)
    const query = body.query as string
    if (!query || typeof query !== 'string') {
      throw ApiError.badRequest('Missing or invalid "query" in request body')
    }

    // ── POST /api/search/sessions ──────────────────────────────────────────
    if (sub === 'sessions') {
      const results = await searchService.searchSessions(query)
      return Response.json({ results })
    }

    // ── POST /api/search ───────────────────────────────────────────────────
    if (!sub) {
      const results = await searchService.searchWorkspace(query, {
        cwd: body.cwd as string | undefined,
        maxResults: body.maxResults as number | undefined,
        glob: body.glob as string | undefined,
        caseSensitive: body.caseSensitive as boolean | undefined,
      })
      return Response.json({ results, total: results.length })
    }

    throw ApiError.notFound(`Unknown search endpoint: ${sub}`)
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}
