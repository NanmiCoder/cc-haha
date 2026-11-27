/**
 * Unified Subscription & Rolling 5h Usage REST API
 *
 * GET /api/usage-summary           — cached official quotas + local 5h token burn
 * GET /api/usage-summary?force=1   — manual refresh (respects 15s cooldown & HTTP 429 backoff)
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { officialUsageService } from '../services/officialUsageService.js'

export async function handleUsageSummaryApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (segments.length !== 2) {
      throw ApiError.notFound(`Unknown usage-summary path: ${url.pathname}`)
    }
    if (req.method !== 'GET') {
      throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
    }
    const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
    const summary = await officialUsageService.getSummary({ force })
    return Response.json(summary, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
