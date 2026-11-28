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

  test('supports classic Azure OpenAI deployment URLs and preserves api-version query params', () => {
    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-10-21', 'chat/completions'),
    ).toBe('https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com/openai/deployments/gpt-4o', 'chat/completions'),
    ).toBe('https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com?api-version=2024-10-21', 'chat/completions', { modelId: 'gpt-4o-prod' }),
    ).toBe('https://my-res.openai.azure.com/openai/deployments/gpt-4o-prod/chat/completions?api-version=2024-10-21')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com?api-version=2025-04-01-preview', 'responses', { modelId: 'gpt-5' }),
    ).toBe('https://my-res.openai.azure.com/openai/responses?api-version=2025-04-01-preview')

    // Azure Responses API does not live under /deployments/{deployment}; strip the deployment segment.
    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com/openai/deployments/gpt-5?api-version=2025-04-01-preview', 'responses'),
    ).toBe('https://my-res.openai.azure.com/openai/responses?api-version=2025-04-01-preview')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com/openai/deployments/gpt-5', 'responses'),
    ).toBe('https://my-res.openai.azure.com/openai/responses?api-version=2024-10-21')
  })

  test('supports modern Azure OpenAI / Azure AI Foundry v1 endpoints', () => {
    expect(
      buildOpenaiEndpoint('https://my-res.services.ai.azure.com/openai/v1', 'chat/completions'),
    ).toBe('https://my-res.services.ai.azure.com/openai/v1/chat/completions')

    expect(
      buildOpenaiEndpoint('https://my-res.services.ai.azure.com/openai/v1', 'responses'),
    ).toBe('https://my-res.services.ai.azure.com/openai/v1/responses')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com', 'chat/completions'),
    ).toBe('https://my-res.openai.azure.com/openai/v1/chat/completions')

    expect(
      buildOpenaiEndpoint('http://127.0.0.1:4000', 'chat/completions', { forceAzure: true }),
    ).toBe('http://127.0.0.1:4000/openai/v1/chat/completions')
  })
})
