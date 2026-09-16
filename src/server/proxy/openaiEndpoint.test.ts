import { describe, expect, test } from 'bun:test'
import { buildOpenaiEndpoint } from './openaiEndpoint.js'

describe('buildOpenaiEndpoint', () => {
  for (const endpoint of ['chat/completions', 'responses'] as const) {
    for (const suffix of ['', '/', '/v1', '/v1/']) {
      test(`${endpoint} accepts a gateway base ending in ${suffix || '(host)'}`, () => {
        expect(buildOpenaiEndpoint(`https://gw.apismart.ai${suffix}`, endpoint))
          .toBe(`https://gw.apismart.ai/v1/${endpoint}`)
      })
    }
    test(`${endpoint} preserves gateway path prefixes`, () => {
      expect(buildOpenaiEndpoint('https://example.com/api/v1/', endpoint))
        .toBe(`https://example.com/api/v1/${endpoint}`)
      expect(buildOpenaiEndpoint('https://example.com/api', endpoint))
        .toBe(`https://example.com/api/v1/${endpoint}`)
    })
  }
})
