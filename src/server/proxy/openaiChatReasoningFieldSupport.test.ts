import { afterEach, describe, expect, test } from 'bun:test'
import {
  findOpenAIChatReasoningFieldRejection,
  getOpenAIChatUnsupportedReasoningFields,
  rememberOpenAIChatUnsupportedReasoningField,
  resetOpenAIChatReasoningFieldSupportForTests,
} from './openaiChatReasoningFieldSupport.js'
import type { OpenAIChatRequest } from './transform/types.js'

const withToggle: OpenAIChatRequest = {
  model: 'cat-jam-free',
  messages: [{ role: 'user', content: 'hello' }],
  thinking: { type: 'enabled' },
  reasoning_effort: 'medium',
}
const withoutReasoning: OpenAIChatRequest = {
  model: 'cat-jam-free',
  messages: [{ role: 'user', content: 'hello' }],
}

afterEach(resetOpenAIChatReasoningFieldSupportForTests)

describe('findOpenAIChatReasoningFieldRejection', () => {
  test('recognises the OpenCode Go refusal of the thinking toggle', () => {
    const refusal = JSON.stringify({
      error: {
        param: 'thinking',
        type: 'invalid_request_error',
        message: 'Upstream request failed: [unsupported_parameter] Unrecognized request argument supplied: thinking.',
      },
    })

    expect(findOpenAIChatReasoningFieldRejection(400, refusal, withToggle)).toBe('thinking')
    expect(findOpenAIChatReasoningFieldRejection(422, refusal, withToggle)).toBe('thinking')
  })

  test('recognises the effort field the same way', () => {
    const refusal = JSON.stringify({ error: { param: 'reasoning_effort', message: 'Unrecognized request argument supplied: reasoning_effort.' } })
    expect(findOpenAIChatReasoningFieldRejection(400, refusal, withToggle)).toBe('reasoning_effort')
  })

  test('ignores failures that do not name a carried field, and non-validation statuses', () => {
    const named = (param: string) => JSON.stringify({ error: { param, message: 'Unrecognized request argument' } })
    expect(findOpenAIChatReasoningFieldRejection(400, named('top_k'), withToggle)).toBeUndefined()
    expect(findOpenAIChatReasoningFieldRejection(400, 'Unrecognized request argument supplied: thinking', withToggle)).toBeUndefined()
    expect(findOpenAIChatReasoningFieldRejection(400, JSON.stringify({ error: { message: 'Unknown error: thinking tokens' } }), withToggle)).toBeUndefined()
    expect(findOpenAIChatReasoningFieldRejection(500, named('thinking'), withToggle)).toBeUndefined()
    expect(findOpenAIChatReasoningFieldRejection(429, named('thinking'), withToggle)).toBeUndefined()
  })

  test('ignores a refusal of a field the request did not carry', () => {
    const refusal = JSON.stringify({ error: { param: 'thinking' } })
    expect(findOpenAIChatReasoningFieldRejection(400, refusal, withoutReasoning)).toBeUndefined()
    expect(findOpenAIChatReasoningFieldRejection(400, refusal, { ...withToggle, thinking: undefined })).toBeUndefined()
  })
})

describe('learned unsupported reasoning fields', () => {
  const endpoint = 'https://opencode.ai/zen/go/v1/chat/completions'

  test('are scoped to one endpoint and model, ignoring case and trailing slashes', () => {
    rememberOpenAIChatUnsupportedReasoningField(`${endpoint}/`, 'Cat-Jam-Free', 'thinking')

    expect([...getOpenAIChatUnsupportedReasoningFields(endpoint, 'cat-jam-free')]).toEqual(['thinking'])
    expect(getOpenAIChatUnsupportedReasoningFields(endpoint, 'deepseek-flash').size).toBe(0)
    expect(getOpenAIChatUnsupportedReasoningFields('https://api.deepseek.com/chat/completions', 'cat-jam-free').size).toBe(0)
  })

  test('accumulate per field and expire after 30 minutes', () => {
    const learnedAt = 1_000_000
    rememberOpenAIChatUnsupportedReasoningField(endpoint, 'cat-jam-free', 'thinking', learnedAt)
    rememberOpenAIChatUnsupportedReasoningField(endpoint, 'cat-jam-free', 'reasoning_effort', learnedAt + 10 * 60_000)

    expect([...getOpenAIChatUnsupportedReasoningFields(endpoint, 'cat-jam-free', learnedAt + 20 * 60_000)].sort())
      .toEqual(['reasoning_effort', 'thinking'])
    expect([...getOpenAIChatUnsupportedReasoningFields(endpoint, 'cat-jam-free', learnedAt + 35 * 60_000)])
      .toEqual(['reasoning_effort'])
    expect(getOpenAIChatUnsupportedReasoningFields(endpoint, 'cat-jam-free', learnedAt + 45 * 60_000).size).toBe(0)
  })
})
