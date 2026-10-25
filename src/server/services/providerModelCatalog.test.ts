/**
 * Unit tests for the provider model catalog (Base URL → model list).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildModelsUrlCandidates, fetchProviderModels } from './providerModelCatalog.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit | undefined }

let tmpDir: string
let originalFetch: typeof globalThis.fetch
let originalEnv: Record<string, string | undefined>
let calls: FetchCall[]

const SANDBOXED_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'CC_HAHA_SYSTEM_PROXY_URL',
  'CC_HAHA_SYSTEM_PROXY_ERROR',
] as const

/** Install a stub `fetch` that records every call it receives. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    return await handler(url, init)
  }) as typeof globalThis.fetch
}

/** Reply with a fixed sequence, one entry per candidate that gets probed. */
function stubFetchSequence(responses: Array<() => Response>) {
  let index = 0
  stubFetch(() => {
    const next = responses[index]
    index += 1
    if (!next) throw new Error('unexpected extra fetch call')
    return next()
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } })
}

function authHeaderOf(call: FetchCall): string | null {
  return new Headers(call.init?.headers).get('authorization')
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'provider-model-catalog-test-'))
  originalEnv = Object.fromEntries(
    SANDBOXED_ENV_KEYS.map(key => [key, process.env[key]]),
  )
  // The service reads user settings for proxy/timeout config; keep it pointed at
  // an empty sandbox so a developer's real settings cannot steer the tests.
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.HOME = tmpDir
  delete process.env.CC_HAHA_SYSTEM_PROXY_URL
  delete process.env.CC_HAHA_SYSTEM_PROXY_ERROR
  originalFetch = globalThis.fetch
  calls = []
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const key of SANDBOXED_ENV_KEYS) {
    const value = originalEnv[key]
    if (value !== undefined) {
      process.env[key] = value
    } else {
      delete process.env[key]
    }
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ─── URL candidate building ───────────────────────────────────────────────────

describe('buildModelsUrlCandidates', () => {
  const cases: Array<{
    name: string
    baseUrl: string
    isFullUrl?: boolean
    expected: string[]
  }> = [
    {
      name: 'a bare host gets the OpenAI-style /v1/models',
      baseUrl: 'https://api.siliconflow.cn',
      expected: ['https://api.siliconflow.cn/v1/models'],
    },
    {
      name: 'a trailing slash is stripped',
      baseUrl: 'https://api.example.com/',
      expected: ['https://api.example.com/v1/models'],
    },
    {
      name: 'an existing /v1 is never doubled',
      baseUrl: 'https://api.example.com/v1',
      expected: ['https://api.example.com/v1/models'],
    },
    {
      name: 'a non-v1 version segment keeps a /v1 fallback (Zhipu)',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      expected: [
        'https://open.bigmodel.cn/api/coding/paas/v4/models',
        'https://open.bigmodel.cn/api/coding/paas/v4/v1/models',
      ],
    },
    {
      name: 'the /anthropic compat suffix is stripped (DeepSeek)',
      baseUrl: 'https://api.deepseek.com/anthropic',
      expected: [
        'https://api.deepseek.com/anthropic/v1/models',
        'https://api.deepseek.com/v1/models',
        'https://api.deepseek.com/models',
      ],
    },
    {
      name: 'the /anthropic compat suffix is stripped (Moonshot)',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      expected: [
        'https://api.moonshot.cn/anthropic/v1/models',
        'https://api.moonshot.cn/v1/models',
        'https://api.moonshot.cn/models',
      ],
    },
    {
      name: '/api/anthropic is not shadowed by /anthropic (Z.ai)',
      baseUrl: 'https://api.z.ai/api/anthropic',
      expected: [
        'https://api.z.ai/api/anthropic/v1/models',
        'https://api.z.ai/v1/models',
        'https://api.z.ai/models',
      ],
    },
    {
      name: '/api is not a compat suffix (OpenRouter preset)',
      // Read from the shipped preset: a baseUrl edit must not silently strand
      // model discovery on a path OpenRouter does not serve.
      baseUrl: PROVIDER_PRESETS.find((preset) => preset.id === 'openrouter')!.baseUrl,
      expected: ['https://openrouter.ai/api/v1/models'],
    },
    {
      name: 'a full endpoint URL is cut at its /v1/ prefix',
      baseUrl: 'https://proxy.example.com/v1/chat/completions',
      isFullUrl: true,
      expected: ['https://proxy.example.com/v1/models'],
    },
    {
      name: 'a full endpoint URL without /v1/ falls back to its parent path',
      baseUrl: 'https://proxy.example.com/openai/chat/completions',
      isFullUrl: true,
      expected: ['https://proxy.example.com/openai/chat/v1/models'],
    },
    {
      name: 'the /api/claudecode compat suffix is stripped',
      baseUrl: 'https://gateway.example.com/api/claudecode',
      expected: [
        'https://gateway.example.com/api/claudecode/v1/models',
        'https://gateway.example.com/v1/models',
        'https://gateway.example.com/models',
      ],
    },
  ]

  for (const testCase of cases) {
    test(testCase.name, () => {
      expect(
        buildModelsUrlCandidates(testCase.baseUrl, { isFullUrl: testCase.isFullUrl }),
      ).toEqual(testCase.expected)
    })
  }

  test('an explicit modelsUrl override wins outright', () => {
    expect(
      buildModelsUrlCandidates('https://api.deepseek.com/anthropic', {
        modelsUrl: '  https://custom.example.com/list  ',
        isFullUrl: true,
      }),
    ).toEqual(['https://custom.example.com/list'])
  })

  test('a blank modelsUrl override is ignored', () => {
    expect(
      buildModelsUrlCandidates('https://api.example.com', { modelsUrl: '   ' }),
    ).toEqual(['https://api.example.com/v1/models'])
  })

  test('throws on an empty base URL', () => {
    expect(() => buildModelsUrlCandidates('')).toThrow(/Base URL is required/)
    expect(() => buildModelsUrlCandidates('   ')).toThrow(/Base URL is required/)
    expect(() => buildModelsUrlCandidates('///')).toThrow(/Base URL is required/)
  })

  test('throws when a full URL carries no usable root', () => {
    expect(() => buildModelsUrlCandidates('completions', { isFullUrl: true }))
      .toThrow(/Cannot derive models endpoint from full URL/)
    expect(() => buildModelsUrlCandidates('https://', { isFullUrl: true }))
      .toThrow(/Cannot derive models endpoint from full URL/)
  })
})

// ─── Fetching ─────────────────────────────────────────────────────────────────

describe('endpoint scheme safety', () => {
  // `fetch` here also honours file:, so an unvalidated endpoint would turn the
  // route into an arbitrary local-file reader — the body is echoed back in
  // `message`, and a JSON file would even parse as a model list.
  for (const scheme of ['file:///etc/hosts', 'ftp://example.com/models', 'data:application/json,{}']) {
    test(`rejects ${scheme.split(':')[0]}: as a modelsUrl override`, () => {
      expect(() => buildModelsUrlCandidates('https://api.example.com', { modelsUrl: scheme }))
        .toThrow(/Unsupported URL scheme|Not a valid URL/)
    })
  }

  test('rejects a non-http Base URL', () => {
    expect(() => buildModelsUrlCandidates('file:///Users/someone/.claude'))
      .toThrow(/Unsupported URL scheme/)
  })

  test('a rejected scheme surfaces as missing-config and never reaches the network', async () => {
    stubFetch(() => { throw new Error('fetch must not be called') })

    const result = await fetchProviderModels({
      baseUrl: 'file:///etc/hosts',
      apiKey: 'sk-test-key-123456',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('missing-config')
  })
})

describe('fetchProviderModels', () => {
  test('reports missing config without any network I/O', async () => {
    stubFetch(() => { throw new Error('fetch must not be called') })

    const noKey = await fetchProviderModels({ baseUrl: 'https://api.example.com', apiKey: '  ' })
    const noBase = await fetchProviderModels({ baseUrl: '   ', apiKey: 'sk-test-key-123456' })

    expect(noKey).toEqual({
      ok: false,
      errorCode: 'missing-config',
      message: 'Base URL and API key are both required to fetch models',
      endpointsTried: [],
    })
    expect(noBase.ok).toBe(false)
    expect(noBase).toMatchObject({ errorCode: 'missing-config', endpointsTried: [] })
    expect(calls.length).toBe(0)
  })

  test('reports an underivable endpoint as missing config', async () => {
    stubFetch(() => { throw new Error('fetch must not be called') })

    const result = await fetchProviderModels({
      baseUrl: 'completions',
      apiKey: 'sk-test-key-123456',
      isFullUrl: true,
    })

    expect(result).toMatchObject({ ok: false, errorCode: 'missing-config', endpointsTried: [] })
    expect(calls.length).toBe(0)
  })

  test('sends a GET with a bearer token and an abort signal', async () => {
    stubFetchSequence([() => jsonResponse({ data: [{ id: 'gpt-4o' }] })])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'gpt-4o' }],
      endpoint: 'https://api.example.com/v1/models',
    })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://api.example.com/v1/models')
    expect(calls[0].init?.method).toBe('GET')
    expect(authHeaderOf(calls[0])).toBe('Bearer sk-test-key-123456')
    expect(calls[0].init?.signal).toBeDefined()
  })

  test('sorts by id, dedupes, and maps owned_by', async () => {
    stubFetchSequence([() => jsonResponse({
      object: 'list',
      data: [
        { id: 'zeta', owned_by: 'acme' },
        { id: 'alpha', owned_by: 'acme' },
        { id: 'zeta', owned_by: 'other' },
        { id: 'beta' },
      ],
    })])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'alpha', ownedBy: 'acme' },
        { id: 'beta' },
        { id: 'zeta', ownedBy: 'acme' },
      ],
      endpoint: 'https://api.example.com/v1/models',
    })
  })

  test('keeps the author/slug namespace of OpenRouter model ids', async () => {
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === 'openrouter')!
    stubFetchSequence([() => jsonResponse({
      object: 'list',
      data: [
        { id: 'z-ai/glm-5.3', owned_by: 'z-ai' },
        { id: 'anthropic/claude-sonnet-5.5', owned_by: 'anthropic' },
      ],
    })])

    const result = await fetchProviderModels({ baseUrl: preset.baseUrl, apiKey: 'sk-or-offline-fixture' })

    expect(result).toEqual({
      ok: true,
      // Sorting and namespaces both survive: the id the user picks here is the id
      // the request must carry, so a stripped author prefix would 404 upstream.
      models: [
        { id: 'anthropic/claude-sonnet-5.5', ownedBy: 'anthropic' },
        { id: 'z-ai/glm-5.3', ownedBy: 'z-ai' },
      ],
      endpoint: 'https://openrouter.ai/api/v1/models',
    })
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models')
    expect(authHeaderOf(calls[0])).toBe('Bearer sk-or-offline-fixture')
  })

  test('accepts models[]/items[]/bare arrays and string entries', async () => {
    const payloads: unknown[] = [
      { models: ['b-model', 'a-model'] },
      { items: [{ slug: 'b-model' }, { model: 'a-model' }] },
      ['b-model', { name: 'a-model' }],
    ]

    for (const payload of payloads) {
      calls = []
      stubFetchSequence([() => jsonResponse(payload)])
      const result = await fetchProviderModels({
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-key-123456',
      })
      expect(result).toMatchObject({ ok: true, models: [{ id: 'a-model' }, { id: 'b-model' }] })
    }
  })

  test('reads the owner from any of the known owner keys', async () => {
    stubFetchSequence([() => jsonResponse({
      data: [
        { id: 'a', ownedBy: 'one' },
        { id: 'b', provider: 'two' },
        { id: 'c', vendor: 'three' },
        { id: 'd', owner: 'four' },
        { id: 'e', owned_by: 42 },
      ],
    })])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toMatchObject({
      ok: true,
      models: [
        { id: 'a', ownedBy: 'one' },
        { id: 'b', ownedBy: 'two' },
        { id: 'c', ownedBy: 'three' },
        { id: 'd', ownedBy: 'four' },
        { id: 'e' },
      ],
    })
  })

  test('an explicitly empty array is a successful empty catalog', async () => {
    stubFetchSequence([() => jsonResponse({ object: 'list', data: [] })])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toEqual({
      ok: true,
      models: [],
      endpoint: 'https://api.example.com/v1/models',
    })
  })

  test('a 200 error envelope is a failure, not an empty catalog', async () => {
    // open.bigmodel.cn answers 200 for a rejected key.
    stubFetchSequence([() => jsonResponse({ code: 1000, msg: '身份验证失败。', success: false })])

    const result = await fetchProviderModels({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toEqual({
      ok: false,
      errorCode: 'not-supported',
      message: '身份验证失败。',
      httpStatus: 200,
      endpointsTried: ['https://open.bigmodel.cn/api/anthropic/v1/models'],
    })
  })

  test('a 200 envelope with a structural auth signal maps to auth-failed', async () => {
    const authEnvelopes: unknown[] = [
      { code: 401, message: 'token expired' },
      { error: { type: 'authentication_error', message: 'invalid token' } },
      { error: { code: 'invalid_api_key', message: 'invalid token' } },
    ]

    for (const envelope of authEnvelopes) {
      calls = []
      stubFetchSequence([() => jsonResponse(envelope)])
      const result = await fetchProviderModels({
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-key-123456',
      })
      expect(result).toMatchObject({ ok: false, errorCode: 'auth-failed', httpStatus: 200 })
      expect(result.ok === false && result.message.length > 0).toBe(true)
    }
  })

  test('falls through a 404 on the first candidate (Moonshot / DeepSeek)', async () => {
    stubFetchSequence([
      () => textResponse('not found', 404),
      () => jsonResponse({ data: [{ id: 'kimi-k2', owned_by: 'moonshot' }] }),
    ])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'kimi-k2', ownedBy: 'moonshot' }],
      endpoint: 'https://api.moonshot.cn/v1/models',
    })
    expect(calls.map(call => call.url)).toEqual([
      'https://api.moonshot.cn/anthropic/v1/models',
      'https://api.moonshot.cn/v1/models',
    ])
  })

  test('falls through a 405 as well', async () => {
    stubFetchSequence([
      () => textResponse('method not allowed', 405),
      () => jsonResponse({ data: [{ id: 'deepseek-chat' }] }),
    ])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toMatchObject({ ok: true, endpoint: 'https://api.deepseek.com/v1/models' })
    expect(calls.length).toBe(2)
  })

  test('reports endpoint-not-found once every candidate 404s', async () => {
    stubFetchSequence([
      () => textResponse('nope 1', 404),
      () => textResponse('nope 2', 404),
      () => textResponse('nope 3', 404),
    ])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'endpoint-not-found',
      httpStatus: 404,
      endpointsTried: [
        'https://api.deepseek.com/anthropic/v1/models',
        'https://api.deepseek.com/v1/models',
        'https://api.deepseek.com/models',
      ],
    })
    expect(result.ok === false && result.message).toContain('nope 3')
    expect(calls.length).toBe(3)
  })

  test('stops at a 401 without probing the remaining candidates', async () => {
    stubFetchSequence([() => textResponse('{"error":"unauthorized"}', 401)])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'auth-failed',
      httpStatus: 401,
      endpointsTried: ['https://api.deepseek.com/anthropic/v1/models'],
    })
    expect(result.ok === false && result.message).toContain('HTTP 401')
    expect(calls.length).toBe(1)
  })

  test('maps other upstream statuses to unknown', async () => {
    for (const status of [502, 525]) {
      calls = []
      stubFetchSequence([() => textResponse(`gateway said ${status}`, status)])
      const result = await fetchProviderModels({
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test-key-123456',
      })
      expect(result).toMatchObject({ ok: false, errorCode: 'unknown', httpStatus: status })
      expect(result.ok === false && result.message).toContain(`HTTP ${status}`)
    }
  })

  test('redacts the key before truncating, not after', async () => {
    // Order matters: truncating first would cut a key straddling the 512-char
    // boundary and leak the surviving prefix.
    const apiKey = 'sk-secret-0123456789abcdef'
    const body = `${'A'.repeat(500)}${apiKey}${'B'.repeat(200)}`
    stubFetch(() => new Response(body, { status: 500 }))

    const result = await fetchProviderModels({ baseUrl: 'https://api.example.com', apiKey })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).not.toContain(apiKey)
      expect(result.message).not.toContain('sk-secret-0123')
    }
  })

  test('truncates the upstream error body to 512 characters', async () => {
    const body = `${'A'.repeat(512)}${'Z'.repeat(64)}`
    stubFetchSequence([() => textResponse(body, 500)])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key-123456',
    })

    expect(result.ok).toBe(false)
    const message = result.ok === false ? result.message : ''
    expect(message).toBe(`HTTP 500: ${'A'.repeat(512)}…`)
    expect(message).not.toContain('Z')
  })

  test('never echoes the api key back inside an error body', async () => {
    const apiKey = 'sk-secret-key-abcdef'
    stubFetchSequence([() => textResponse(`rejected token ${apiKey}`, 403)])

    const result = await fetchProviderModels({ baseUrl: 'https://api.example.com', apiKey })

    expect(result).toMatchObject({ ok: false, errorCode: 'auth-failed', httpStatus: 403 })
    const message = result.ok === false ? result.message : ''
    expect(message).not.toContain(apiKey)
    expect(message).toContain('***')
  })

  test('treats a non-JSON 200 as an unsupported endpoint', async () => {
    stubFetchSequence([() => new Response('<html>login</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toMatchObject({ ok: false, errorCode: 'not-supported', httpStatus: 200 })
    expect(result.ok === false && result.message).toContain('<html>login</html>')
  })

  test('maps an aborted request to a timeout and stops probing', async () => {
    stubFetch(() => { throw new DOMException('The operation timed out.', 'TimeoutError') })

    const result = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'timeout',
      endpointsTried: ['https://api.deepseek.com/anthropic/v1/models'],
    })
    expect(result.ok === false && result.message).toContain('15s')
    expect(calls.length).toBe(1)
  })

  test('maps a transport failure to a network error and stops probing', async () => {
    stubFetch(() => { throw new Error('getaddrinfo ENOTFOUND api.deepseek.com') })

    const result = await fetchProviderModels({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-key-123456',
    })

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'network',
      message: 'getaddrinfo ENOTFOUND api.deepseek.com',
      endpointsTried: ['https://api.deepseek.com/anthropic/v1/models'],
    })
    expect(calls.length).toBe(1)
  })

  test('probes the modelsUrl override verbatim', async () => {
    stubFetchSequence([() => jsonResponse({ data: [{ id: 'custom-model' }] })])

    const result = await fetchProviderModels({
      baseUrl: 'https://api.example.com/anthropic',
      apiKey: 'sk-test-key-123456',
      modelsUrl: 'https://custom.example.com/catalog',
    })

    expect(result).toMatchObject({ ok: true, endpoint: 'https://custom.example.com/catalog' })
    expect(calls.map(call => call.url)).toEqual(['https://custom.example.com/catalog'])
  })
})
