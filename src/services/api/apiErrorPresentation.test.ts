import { describe, expect, spyOn, test } from 'bun:test'
import * as rateLimits from '../rateLimitMocking.js'
import { APIError } from '@anthropic-ai/sdk'
import { classifyAPIError, getAssistantMessageFromError } from './errors.js'

function displayed(error: Error): string {
  const result = getAssistantMessageFromError(error, 'claude-opus-5-5')
  return result.message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('API error presentation', () => {
  test.each([429, 502])('summarizes HTML HTTP %s without losing its status', status => {
    const error = new APIError(status, undefined, '<!DOCTYPE HTML><HTML><BODY>proxy diagnostic dump</BODY></HTML>\n', new Headers())
    const before = error.message
    const classification = classifyAPIError(error)
    const text = displayed(error)
    expect(text).toContain(String(status))
    expect(text).toContain('HTML error response')
    expect(text).not.toContain('proxy diagnostic dump')
    expect(text).not.toContain('<HTML>')
    expect(error.message).toBe(before)
    expect(classifyAPIError(error)).toBe(classification)
  })

  test('extracts the version rejection with escaped quotes and trims trailing newlines', () => {
    const message = 'Claude Code 2.1.220 does not support this model; run "claude update".\n\n'
    const body = { type: 'error', error: { type: 'invalid_request_error', message, details: { error_code: 'claude_code_version_too_old' } }, request_id: 'req_fixture' }
    const error = new APIError(400, body, undefined, new Headers({ 'request-id': 'req_fixture' }))
    expect(displayed(error)).toBe(`API Error: 400 ${message.trimEnd()}`)
    expect(error.error).toBe(body)
    expect(error.requestID).toBe('req_fixture')
    expect(classifyAPIError(error)).toBe('client_error')
  })

  test('preserves benign embedded markup, plain text, malformed body and missing body', () => {
    for (const message of ['123', 'true', 'Bad input\n\n', 'Expected <html> in the submitted template', '{broken JSON', 'Use <code>x</code> here']) {
      expect(displayed(new APIError(400, undefined, message, undefined))).toBe(`API Error: 400 ${message.trimEnd()}`)
    }
    expect(displayed(new APIError(502, undefined, undefined, undefined))).toBe('API Error: 502 status code (no body)')
    const ordinary = new Error('<html> is the literal code input\n')
    expect(displayed(ordinary)).toBe(`API Error: ${ordinary.message}`)
  })
})


describe('specialized API error paths', () => {
  test('subscriber headerless 429 uses structured messages rather than truncating quotes', () => {
    const enabled = spyOn(rateLimits, 'shouldProcessRateLimits').mockReturnValue(true)
    try {
      const message = 'Try "again" later.\n'
      const error = new APIError(429, { error: { message } }, undefined, new Headers())
      expect(displayed(error)).toBe('API Error: Request rejected (429) · Try "again" later.')
      const html = new APIError(429, undefined, '<html><body>proxy dump</body></html>', new Headers())
      expect(displayed(html)).toBe('API Error: Request rejected (429) · Received an HTML error response from the server.')
      const quota = new APIError(429, { error: { message: 'quota exceeded' } }, undefined, new Headers({ 'anthropic-ratelimit-unified-representative-claim': 'five_hour' }))
      const result = getAssistantMessageFromError(quota, 'claude-opus-5-5')
      expect(result.error).toBe('rate_limit')
      expect(displayed(quota)).not.toContain('Request rejected')
    } finally {
      enabled.mockRestore()
    }
  })

  test('generic authentication keeps login guidance and classification', () => {
    const error = new APIError(401, { error: { message: 'Session expired\n' } }, undefined, undefined)
    const result = getAssistantMessageFromError(error, 'claude-opus-5-5')
    expect(displayed(error)).toContain('API Error: 401 Session expired')
    expect(displayed(error)).not.toContain('{')
    expect(result.error).toBe('authentication_failed')
    expect(classifyAPIError(error)).toBe('auth_error')
  })

  test('parses serialized envelopes, tolerates missing messages, and keeps unavailable status absent', () => {
    expect(displayed(new APIError(400, undefined, '{"error":{"message":"Bad input"}}', undefined))).toBe('API Error: 400 Bad input')
    expect(displayed(new APIError(500, { error: { code: 'upstream_failure' } }, undefined, undefined))).toBe('API Error: 500 Request failed')
    expect(displayed(new APIError(undefined, { error: { message: 'Failed' } }, undefined, undefined))).toBe('API Error: Failed')
    expect(displayed(new APIError(400, { message: 'Bad field' }, undefined, undefined))).toBe('API Error: 400 Bad field')
  })
})
