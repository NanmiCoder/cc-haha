import { describe, expect, spyOn, test } from 'bun:test'
import * as rateLimits from '../rateLimitMocking.js'
import { APIError } from '@anthropic-ai/sdk'
import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import { classifyAPIError, getAssistantMessageFromError } from './errors.js'
import { StreamEndedEarlyError } from './streamFallback.js'

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
  test('classifies an OpenCode monthly quota response wrapped by the local proxy as billing', () => {
    const upstream = { type: 'error', error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' }, metadata: { workspace: 'fixture', limitName: 'monthly' } }
    const detail = `Upstream returned HTTP 429: ${JSON.stringify(upstream)}`
    const error = APIError.generate(429, { type: 'error', error: { type: 'api_error', message: detail } }, undefined, new Headers())
    const result = getAssistantMessageFromError(error, 'deepseek-flash')
    expect(result.error).toBe('billing_error')
    expect(classifyAPIError(error)).toBe('provider_usage_limit')
    expect(displayed(error)).toContain('Go usage limit exceeded')
    expect(displayed(error)).toContain('monthly')
    expect(displayed(error)).toMatch(/reset|billing/i)
    expect(displayed(error)).toMatch(/switch.*provider/i)
    expect(displayed(error)).not.toMatch(/\/login|Failed to authenticate/i)
  })

  test.each([
    { type: 'rate_limit_error', message: 'Rate limit exceeded. Retry in 30 seconds.' },
    { type: 'rate_limit_error', message: 'Usage limit exceeded for requests per minute.' },
    { type: 'api_error', message: 'quota exceeded' },
    { type: 'rate_limit_error', message: 'Monthly plan request quota exceeded per minute.' },
    { type: 'rate_limit_error', message: 'Insufficient quota for requests per minute; retry in 30 seconds.' },
    { code: 'insufficient_quota', message: 'Insufficient quota for requests per minute; retry in 30 seconds.' },
    { type: 'rate_limit_error', message: 'Request quota exceeded (5 requests/minute). Check your plan limits; retry in 30 seconds.' },
    { type: 'rate_limit_error', message: 'Quota exceeded (100 RPM) for this plan. Retry in 30 seconds.' },
  ])('keeps an ambiguous or temporary 429 as a rate limit: $message', detail => {
    const error = APIError.generate(429, { type: 'error', error: detail }, undefined, new Headers())
    expect(getAssistantMessageFromError(error, 'fixture').error).not.toBe('billing_error')
    expect(classifyAPIError(error)).toBe('rate_limit')
  })

  test('honors an explicit invalid-key code even when the message mentions an exhausted quota', () => {
    const message = 'The API key you provided has expired. Your quota was exhausted.'
    const error = APIError.generate(401, { error: { type: 'authentication_error', code: 'invalid_api_key', message } }, undefined, new Headers())
    expect(getAssistantMessageFromError(error, 'fixture').error).toBe('authentication_failed')
    expect(classifyAPIError(error)).not.toBe('provider_usage_limit')
  })

  test.each([
    { code: 'insufficient_quota', message: 'Check your plan.' },
    { message: 'Your monthly quota has been exhausted.' },
    { message: 'Insufficient balance, please recharge.' },
    { message: 'Insufficient quota. Please recharge your account to continue.' },
    { message: 'Insufficient quota. Please top up your account.' },
  ])('recognizes an explicit 429 plan or balance limit: $message', detail => {
    const error = APIError.generate(429, { error: detail }, undefined, new Headers())
    expect(getAssistantMessageFromError(error, 'fixture').error).toBe('billing_error')
    expect(classifyAPIError(error)).toBe('provider_usage_limit')
  })

  test('keeps an invalid API key as authentication even when it mentions quota settings', () => {
    const previous = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'fixture-key'
    try {
      for (const message of ['Invalid API key. Check your quota settings.', 'Invalid API key. Your monthly quota was exceeded.', 'Your API key has expired. Your monthly quota was exceeded.', 'Invalid x-api-key. Your quota was exceeded.']) {
        const error = APIError.generate(401, { error: { type: 'authentication_error', message } }, undefined, new Headers())
        expect(getAssistantMessageFromError(error, 'fixture').error).toBe('authentication_failed')
        expect(classifyAPIError(error)).not.toBe('provider_usage_limit')
      }
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previous
    }
  })

  test('preserves a used-up billing cycle even if the provider mentions x-api-key', () => {
    const message = 'The usage limit has been exceeded for this x-api-key during the billing cycle.'
    const error = APIError.generate(403, { error: { type: 'permission_error', message } }, undefined, new Headers())
    expect(getAssistantMessageFromError(error, 'fixture').error).toBe('billing_error')
    expect(displayed(error)).toContain(message)
    expect(displayed(error)).not.toMatch(/login|authenticate|fix external API key/i)
  })

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

describe('early stream end presentation', () => {
  test('names the upstream provider, keeps the evidence and tags the business code', () => {
    const error = new StreamEndedEarlyError('incomplete', {
      eventCount: 412, lastEventType: 'content_block_delta', stopReason: null,
      messageStopReceived: false, openBlockCount: 1, elapsedMs: 263_400,
    })
    const result = getAssistantMessageFromError(error, 'claude-opus-5-5', { streamRetries: 10 })
    const text = result.message.content.map(block => block.type === 'text' ? block.text : '').join('')

    expect(text.startsWith('API Error: Provider stream ended before completing the response. The upstream model provider')).toBe(true)
    expect(text).toContain('retried 10 times')
    expect(text).toContain('1 block open')
    expect(result.isApiErrorMessage).toBe(true)
    expect(result.error).toBe('unknown')
    expect(result.businessErrorCode).toBe(BUSINESS_ERROR_CODES.UPSTREAM_STREAM_INTERRUPTED)
    expect(JSON.parse(result.errorDetails!)).toEqual({
      reason: 'incomplete', retries: 10, eventCount: 412, lastEventType: 'content_block_delta',
      stopReason: null, messageStopReceived: false, openBlockCount: 1, elapsedMs: 263_400,
    })
  })

  test('an empty stream without evidence is tagged the same way', () => {
    const result = getAssistantMessageFromError(new StreamEndedEarlyError('no_events'), 'claude-opus-5-5')
    expect(result.businessErrorCode).toBe(BUSINESS_ERROR_CODES.UPSTREAM_STREAM_INTERRUPTED)
    expect(JSON.parse(result.errorDetails!)).toEqual({ reason: 'no_events', retries: 0 })
  })
})
