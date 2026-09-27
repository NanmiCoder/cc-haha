import { expect, spyOn, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import type Anthropic from '@anthropic-ai/sdk'
import { clearFastModeCooldown } from '../../utils/fastMode.js'
import { classifyAPIError, getAssistantMessageFromError } from './errors.js'
import { BASE_DELAY_MS, CannotRetryError, getRetryDelay, withRetry } from './withRetry.js'

function display(error: APIError) {
  const result = getAssistantMessageFromError(error, 'claude-opus-5-5')
  return { result, text: result.message.content.map(block => block.type === 'text' ? block.text : '').join('') }
}

test('nested envelopes and SDK subclasses preserve status, escapes and source diagnostics', () => {
  for (const status of [400, 409, 422, 500, 503]) {
    const body = { error: { error: { message: 'Bad "field"\nnext line\n\n' } }, request_id: 'fixture' }
    const error = APIError.generate(status, body, undefined, new Headers({ 'request-id': 'fixture' }))
    const before = { message: error.message, classification: classifyAPIError(error) }
    expect(display(error).text).toBe(`API Error: ${status} Bad "field"\nnext line`)
    expect(error.error).toBe(body)
    expect(error.requestID).toBe('fixture')
    expect(error.message).toBe(before.message)
    expect(classifyAPIError(error)).toBe(before.classification)
  }
})

test('HTML suppression handles structured bodies without suppressing embedded markup', () => {
  const error = new APIError(502, { error: { message: ' \n<html lang="en"><body>secret dump</body></html>' } }, undefined, undefined)
  expect(display(error).text).toBe('API Error: 502 Received an HTML error response from the server.')
  const prose = new APIError(400, { error: { message: 'Template needs <html> and </html>.' } }, undefined, undefined)
  expect(display(prose).text).toBe('API Error: 400 Template needs <html> and </html>.')
})

test('specialized billing, revoked-token, model and context errors retain their dispatch', () => {
  for (const [status, message, kind] of [
    [400, 'Your credit balance is too low', 'billing_error'],
    [403, 'OAuth token has been revoked', 'authentication_failed'],
    [404, 'model missing', 'invalid_request'],
    [400, 'prompt is too long: 200000 tokens > 100000 maximum', 'invalid_request'],
  ] as const) {
    const error = new APIError(status, { error: { message } }, undefined, undefined)
    const { result, text } = display(error)
    expect(result.error).toBe(kind)
    expect(text).not.toContain('Request failed')
    expect(error.message).toContain(message)
  }
})

test('retry floor applies across attempts while explicit long server hints retain their precedence', () => {
  for (const attempt of [1, 2, 20]) {
    expect(getRetryDelay(attempt, '0')).toBe(BASE_DELAY_MS)
    expect(getRetryDelay(attempt, '-123')).toBe(BASE_DELAY_MS)
    expect(getRetryDelay(attempt, '3600', 32000)).toBe(3_600_000)
  }
})

test('final nonretryable errors ignore a zero retry hint in ordinary and fast mode', async () => {
  for (const fastMode of [false, true]) {
    clearFastModeCooldown()
    let attempts = 0
    const error = new APIError(400, { error: { message: 'invalid field' } }, undefined, new Headers({ 'retry-after': '0' }))
    const generator = withRetry(async () => ({} as Anthropic), async () => {
      attempts++
      throw error
    }, { model: 'claude-opus-5-5', thinkingConfig: { type: 'disabled' }, fastMode, maxRetries: 2 })
    let caught: unknown
    try { while (!(await generator.next()).done) {} } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(CannotRetryError)
    expect((caught as CannotRetryError).originalError).toBe(error)
    expect(attempts).toBe(1)
  }
  clearFastModeCooldown()
})

test('fast retry threshold keeps 19 seconds fast and switches 20 seconds to standard', async () => {
  const previous = process.env.CLAUDE_CODE_DISABLE_FAST_MODE
  delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
  const nativeTimeout = globalThis.setTimeout
  const delays: number[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    if (ms === 19000) {
      delays.push(ms)
      queueMicrotask(() => callback(...args))
      return 0
    }
    return nativeTimeout(callback, ms, ...args)
  }) as typeof setTimeout)
  try {
    for (const seconds of ['19', '20']) {
      clearFastModeCooldown()
      const fast: Array<boolean | undefined> = []
      const generator = withRetry(async () => ({} as Anthropic), async (_client, attempt, context) => {
        fast.push(context.fastMode)
        if (attempt === 1) throw new APIError(529, {}, 'capacity', new Headers({ 'retry-after': seconds }))
        return 'ok'
      }, { model: 'claude-opus-5-5', thinkingConfig: { type: 'disabled' }, fastMode: true, maxRetries: 1 })
      expect(await generator.next()).toEqual({ done: true, value: 'ok' })
      expect(fast).toEqual([true, seconds === '19'])
    }
    expect(delays).toEqual([19000])
  } finally {
    timer.mockRestore()
    clearFastModeCooldown()
    if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    else process.env.CLAUDE_CODE_DISABLE_FAST_MODE = previous
  }
})
