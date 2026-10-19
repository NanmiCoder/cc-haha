import { describe, expect, test } from 'bun:test'
import { openaiChatStreamToAnthropic } from '../streaming/openaiChatStreamToAnthropic.js'
import { openaiChatToAnthropic } from './openaiChatToAnthropic.js'
import type { OpenAIChatResponse } from './types.js'
import { openaiUsageToAnthropic } from './usage.js'

// Issue #1516: an openai_chat relay returns OpenAI-shaped usage
// (prompt_tokens includes cache hits) and additionally copies the hit count
// into an Anthropic-style top-level `cache_read_input_tokens`. The mapper must
// not treat that extra field as proof that prompt_tokens excludes the hit.
const ISSUE_1516_USAGE = {
  prompt_tokens: 38800,
  completion_tokens: 445,
  total_tokens: 39245,
  cache_read_input_tokens: 32512,
}

describe('OpenAI-shaped usage with a redundant direct cache_read_input_tokens (#1516)', () => {
  test('prompt_tokens stays inclusive: input = prompt - cache_read, cache_read preserved', () => {
    expect(openaiUsageToAnthropic(ISSUE_1516_USAGE)).toEqual({
      input_tokens: 38800 - 32512,
      output_tokens: 445,
      cache_read_input_tokens: 32512,
    })
  })

  test('the Anthropic invariant input + cache_read equals the upstream prompt_tokens', () => {
    const usage = openaiUsageToAnthropic(ISSUE_1516_USAGE)
    expect(usage.input_tokens + (usage.cache_read_input_tokens ?? 0)).toBe(38800)
  })

  test('non-streaming Chat response applies the same mapping', () => {
    const upstream: OpenAIChatResponse = {
      id: 'fixture',
      object: 'chat.completion',
      created: 0,
      model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: ISSUE_1516_USAGE,
    }
    expect(openaiChatToAnthropic(upstream, 'fixture').usage).toEqual({
      input_tokens: 6288,
      output_tokens: 445,
      cache_read_input_tokens: 32512,
    })
  })

  test('streaming Chat usage tail applies the same mapping', async () => {
    const frames = [
      { id: 'fixture', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
      { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'fixture', choices: [], usage: ISSUE_1516_USAGE },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames))
        controller.close()
      },
    })
    const text = await new Response(openaiChatStreamToAnthropic(source, 'fixture')).text()
    const events = text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]))
    expect(events.find(event => event.type === 'message_delta').usage).toMatchObject({
      input_tokens: 6288,
      output_tokens: 445,
      cache_read_input_tokens: 32512,
    })
  })
})

// Guards for the opposite reading. These inputs are unambiguous Anthropic
// exclusive semantics and must keep working whichever way #1516 is fixed.
describe('Anthropic exclusive semantics that must stay exclusive', () => {
  test('Anthropic-named input_tokens + cache_read_input_tokens keeps input untouched', () => {
    expect(openaiUsageToAnthropic({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    })).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    })
  })

  test('cache_read larger than prompt_tokens can only be exclusive', () => {
    expect(openaiUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 605,
      cache_read_input_tokens: 500,
    })).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 500,
    })
  })

  test('cache_read larger than prompt_tokens stays exclusive even when total_tokens omits the cache', () => {
    expect(openaiUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      cache_read_input_tokens: 500,
    })).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 500,
    })
  })

  test('total_tokens that already counts cache_read on top of prompt+completion is exclusive', () => {
    expect(openaiUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105 + 60,
      cache_read_input_tokens: 60,
    })).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 60,
    })
  })
})

describe('adjacent behaviour that the #1516 fix must not regress', () => {
  test('#1327: nested cached_tokens beside zero direct placeholders stays inclusive', () => {
    expect(openaiUsageToAnthropic({
      prompt_tokens: 149293,
      completion_tokens: 551,
      cache_creation_input_tokens: 0,
      prompt_tokens_details: { cached_tokens: 147840 },
    })).toEqual({ input_tokens: 1453, output_tokens: 551, cache_read_input_tokens: 147840 })
  })

  test('direct and nested cache counts that agree are inclusive and not subtracted twice', () => {
    expect(openaiUsageToAnthropic({
      prompt_tokens: 38800,
      completion_tokens: 445,
      total_tokens: 39245,
      prompt_tokens_details: { cached_tokens: 32512 },
      cache_read_input_tokens: 32512,
    })).toEqual({ input_tokens: 6288, output_tokens: 445, cache_read_input_tokens: 32512 })
  })
})
