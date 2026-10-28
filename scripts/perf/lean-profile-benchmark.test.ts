import { describe, expect, test } from 'bun:test'
import { sumUsage, usageOf } from './lean-profile-benchmark.js'
import type { RawInteraction } from '../quality-gate/replay/recorder.js'

const interaction = (events: unknown[], json?: unknown): RawInteraction => ({
  seq: 0, path: '/v1/messages', body: {},
  response: { status: 200, contentType: 'text/event-stream', events: events.map(data => ({ data, dt: 0 })), ...(json ? { json } : {}) },
})

describe('live benchmark usage accounting', () => {
  test('counts a streamed cumulative counter once and includes all cache input', () => {
    const usage = usageOf(interaction([
      { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 1 } } },
      { type: 'message_delta', usage: { output_tokens: 20 } },
      { type: 'message_delta', usage: { output_tokens: 35 } },
    ]))
    expect(usage).toEqual({ inputUncached: 100, inputCacheRead: 900, inputCacheWrite: 50, inputTotal: 1050, output: 35 })
  })

  test('includes usage arriving in a later delta without erasing earlier values', () => {
    expect(usageOf(interaction([
      { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'message_delta', usage: { input_tokens: 12, cache_read_input_tokens: 128, output_tokens: 7 } },
    ]))).toEqual({ inputUncached: 12, inputCacheRead: 128, inputCacheWrite: 0, inputTotal: 140, output: 7 })
  })

  test('marks absent provider usage unknown and handles non-streaming usage', () => {
    expect(usageOf(interaction([]))).toBeNull()
    expect(usageOf(interaction([], { usage: { input_tokens: 8, output_tokens: 2 } }))).toEqual({ inputUncached: 8, inputCacheRead: 0, inputCacheWrite: 0, inputTotal: 8, output: 2 })
  })

  test('sums independent responses, including subagent calls, without estimates', () => {
    const main = usageOf(interaction([], { usage: { input_tokens: 40, output_tokens: 10 } }))
    const child = usageOf(interaction([], { usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 30 } }))
    expect(sumUsage([main, null, child])).toEqual({ inputUncached: 60, inputCacheRead: 100, inputCacheWrite: 0, inputTotal: 160, output: 40 })
  })
})
