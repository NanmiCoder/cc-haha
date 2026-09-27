import { describe, expect, it, spyOn } from 'bun:test'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { diagnosticsService } from '../services/diagnosticsService.js'

describe('errorResponse', () => {
  it('returns the original ApiError payload', async () => {
    const response = errorResponse(ApiError.notFound('missing'))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'NOT_FOUND', message: 'missing' })
  })

  it('does not record client disconnects as unhandled server errors', async () => {
    const record = spyOn(diagnosticsService, 'recordEvent')
    try {
      const aborted = new DOMException('The operation was aborted', 'AbortError')
      const closed = Object.assign(new Error('The connection was closed.'), { name: 'AbortError' })

      expect(errorResponse(aborted).status).toBe(499)
      expect(errorResponse(closed).status).toBe(499)
      expect(record).not.toHaveBeenCalled()
    } finally {
      record.mockRestore()
    }
  })
})
