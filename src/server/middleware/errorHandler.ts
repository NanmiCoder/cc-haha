/**
 * Unified error handling utilities
 */

import { diagnosticsService } from '../services/diagnosticsService.js'

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static badRequest(message: string) {
    return new ApiError(400, message, 'BAD_REQUEST')
  }

  static notFound(message: string) {
    return new ApiError(404, message, 'NOT_FOUND')
  }

  static conflict(message: string) {
    return new ApiError(409, message, 'CONFLICT')
  }

  static internal(message: string) {
    return new ApiError(500, message, 'INTERNAL_ERROR')
  }

  static badGateway(message: string) {
    return new ApiError(502, message, 'UPSTREAM_FAILED')
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(
      { error: error.code || 'ERROR', message: error.message },
      { status: error.statusCode }
    )
  }

  void diagnosticsService.recordEvent({
    type: 'api_unhandled_error',
    severity: 'error',
    summary: error instanceof Error ? error.message : String(error),
    details: error,
  })
  console.error('[Server] Unexpected error:', error)
  return Response.json(
    { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    { status: 500 }
  )
}
