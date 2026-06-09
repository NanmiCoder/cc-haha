/**
 * /api/projects/* — read-only endpoints derived from the on-disk projects
 * directory (`~/.claude/projects/<sanitized-workDir>/...`) plus git state.
 *
 * Currently exposes:
 *   GET /api/projects/recent-activity?workDir=<absolute-path>
 *
 * which returns a "what was the user just doing in this project" snapshot
 * for the desktop welcome screen. Pure derivation — never invokes a model.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getRecentActivity } from '../services/projectActivityService.js'

export async function handleProjectsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]
    if (sub === 'recent-activity') {
      if (req.method !== 'GET') {
        throw new ApiError(
          405,
          `Method ${req.method} not allowed on /api/projects/recent-activity`,
          'METHOD_NOT_ALLOWED',
        )
      }
      const workDir = url.searchParams.get('workDir')
      if (!workDir || !workDir.trim()) {
        throw ApiError.badRequest('Missing required query parameter: workDir')
      }
      const excludeSessionId = url.searchParams.get('excludeSessionId') || undefined
      const result = await getRecentActivity(workDir, {
        ...(excludeSessionId ? { excludeSessionId } : {}),
      })
      return Response.json(result)
    }

    throw ApiError.notFound(`Unknown projects endpoint: ${sub ?? '(root)'}`)
  } catch (error) {
    return errorResponse(error)
  }
}
