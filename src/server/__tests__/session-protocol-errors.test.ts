import { expect, test } from 'bun:test'
import { errorResponse } from '../middleware/errorHandler.js'
import { SessionProtocolError } from '../services/sessionProtocolHistory.js'

test.each(['anthropic', 'mixed', 'unknown'] as const)('API reports protocol conflict for %s without a generic server failure', async current => {
  const error = new SessionProtocolError(current, 'openai_responses')
  const response = errorResponse(error)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: error.code, message: error.message })
})
