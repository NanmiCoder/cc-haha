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
    // #1816: gateways that version their own root serve OpenAI routes directly under it
    // (Volcengine Ark /api/v3 and /api/coding/v3, Zhipu /api/paas/v4).
    for (const base of [
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://ark.cn-beijing.volces.com/api/coding/v3',
      'https://open.bigmodel.cn/api/paas/v4',
    ]) {
      test(`${endpoint} uses ${base} as-is because it already ends in a version segment`, () => {
        expect(buildOpenaiEndpoint(base, endpoint)).toBe(`${base}/${endpoint}`)
        expect(buildOpenaiEndpoint(`${base}//`, endpoint)).toBe(`${base}/${endpoint}`)
      })
    }
    test(`${endpoint} still adds /v1 to bare gateway roots`, () => {
      expect(buildOpenaiEndpoint('https://api.atlascloud.ai', endpoint))
        .toBe(`https://api.atlascloud.ai/v1/${endpoint}`)
      expect(buildOpenaiEndpoint('http://localhost:11434/', endpoint))
        .toBe(`http://localhost:11434/v1/${endpoint}`)
    })
    test(`${endpoint} only treats a plain numeric last segment as a version`, () => {
      expect(buildOpenaiEndpoint('https://example.com/v1beta', endpoint))
        .toBe(`https://example.com/v1beta/v1/${endpoint}`)
      expect(buildOpenaiEndpoint('https://example.com/api/v3/tenant', endpoint))
        .toBe(`https://example.com/api/v3/tenant/v1/${endpoint}`)
    })
  }
})
