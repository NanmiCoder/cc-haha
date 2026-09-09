import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { getOpenAIPolicyError, isOpenAIPolicyError } from './policyError.js'

describe('isOpenAIPolicyError', () => {
  test.each(['cyber_policy', 'content_policy', 'content_policy_violation'])('recognizes structured %s across response and SDK wrappers', code => {
    const body = { response: { error: { code, message: 'Rejected' } } }
    expect(isOpenAIPolicyError(body)).toBe(true)
    expect(isOpenAIPolicyError(new APIError(503, body, undefined, undefined))).toBe(true)
    expect(isOpenAIPolicyError({ originalError: new Error(`503 ${JSON.stringify(body)}`) })).toBe(true)
    expect(isOpenAIPolicyError(new Error('failed', { cause: body }))).toBe(true)
  })

  test('preserves upstream code and message for the caller', () => {
    expect(getOpenAIPolicyError({ error: { code: 'cyber_policy', message: 'Request blocked' } })).toEqual({
      code: 'cyber_policy',
      message: 'Request blocked',
    })
    expect(getOpenAIPolicyError({ code: 'content_policy' })).toEqual({
      code: 'content_policy',
      message: 'Request rejected by the upstream safety policy.',
    })
  })

  test('does not infer policy from prose, status, or unrelated payload fields', () => {
    for (const input of [
      new Error('cyber_policy: overloaded'),
      { error: { message: 'content_policy_violation', type: 'api_error' } },
      { status: 403 },
      { data: { code: 'cyber_policy' } },
      { code: 'invalid_prompt' },
      { message: 'prefix {"code":"cyber_policy"}' },
      null,
    ]) expect(isOpenAIPolicyError(input)).toBe(false)
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(isOpenAIPolicyError(cyclic)).toBe(false)
  })
})
