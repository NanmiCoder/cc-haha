import {
  aggregateClaudeCodeStatsForRange,
  type StatsDateRange,
} from '../../utils/stats.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const VALID_RANGES = new Set<StatsDateRange>(['7d', '30d', 'all'])

export async function handleActivityStatsApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (req.method !== 'GET') {
      throw methodNotAllowed(req.method)
    }

    const requestedRange = segments[2]
    const range: StatsDateRange = requestedRange === undefined ? 'all' : parseRange(requestedRange)
    const stats = await aggregateClaudeCodeStatsForRange(range)

    return Response.json({
      stats,
      range,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

function parseRange(range: string): StatsDateRange {
  if (VALID_RANGES.has(range as StatsDateRange)) {
    return range as StatsDateRange
  }

  throw ApiError.badRequest(`Unknown activity stats range: ${range}`)
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
