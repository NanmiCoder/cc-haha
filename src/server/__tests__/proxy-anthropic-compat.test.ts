import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleProxyRequest } from '../proxy/handler.js'
import { ProviderService } from '../services/providerService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { clearTraceCaptureStateForTests, drainTraceCaptureForTests, type TraceCallRecord } from '../../services/api/traceCapture.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-anthropic-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  resetSettingsCache()
  // Wait for in-flight appends/projections, then close cached trace index
  // handles so the temp dir is not locked on Windows.
  await drainTraceCaptureForTests()
  clearTraceCaptureStateForTests()
  // The background trace projection may still hold a handle briefly; retry
  // the removal instead of failing the test on Windows.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
      return
    } catch (err) {
      if ((err as { code?: string }).code !== 'EBUSY') throw err
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

describe('proxy anthropic-compatible path', () => {
  beforeEach(setup)
  afterEach(teardown)

  test.each([false, true])('forwards real HTTP requests to the upstream host (stream=%s)', async stream => {
    const received: Array<{ url: string; headers: Headers; body: unknown }> = []
    const responseBody = stream
      ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      : JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }] })
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        received.push({ url: request.url, headers: request.headers, body: await request.json() })
        return new Response(responseBody, {
          headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
        })
      },
    })
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => handleProxyRequest(request, new URL(request.url)),
    })

    try {
      const provider = await new ProviderService().addProvider({
        presetId: 'custom',
        name: 'Loopback Anthropic',
        baseUrl: upstream.url.origin,
        apiKey: 'test-upstream-key',
        apiFormat: 'anthropic',
        authStrategy: 'api_key',
        supportsNestedToolResultMedia: false,
        models: { main: 'fixture-model', haiku: '', sonnet: '', opus: '' },
      })
      const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }
      const response = await fetch(new URL(`/proxy/providers/${provider.id}/v1/messages`, proxy.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'fixture-beta',
          'x-api-key': 'test-client-key',
        },
        body: JSON.stringify({
          model: 'fixture-model',
          max_tokens: 64,
          stream,
          messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'call-image', name: 'Read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-image', content: [image] }] },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe(responseBody)
      expect(received).toHaveLength(1)
      expect(received[0]!.url).toBe(new URL('/v1/messages', upstream.url).href)
      expect(received[0]!.headers.get('host')).toBe(upstream.url.host)
      expect(received[0]!.headers.get('x-api-key')).toBe('test-upstream-key')
      expect(received[0]!.headers.get('anthropic-version')).toBe('2023-06-01')
      expect(received[0]!.headers.get('anthropic-beta')).toBe('fixture-beta')
      expect(received[0]!.body).toMatchObject({
        messages: [
          { role: 'assistant' },
          { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'call-image' },
            { type: 'text' },
            image,
          ] },
        ],
      })
    } finally {
      proxy.stop(true)
      upstream.stop(true)
    }
  })

  test('hoists nested media, sends auth headers, and forwards protocol headers', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      authStrategy: 'api_key',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const captured: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({
        id: 'msg_relay',
        type: 'message',
        role: 'assistant',
        model: 'model-main',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tc_1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
          }],
        }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'some-beta-header',
          },
          body: JSON.stringify(body),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)

      expect(captured).toHaveLength(1)
      const upstream = captured[0]!
      expect(upstream.url).toBe('https://relay.example.com/v1/messages')

      const headers = upstream.init.headers as Record<string, string>
      expect(headers['x-api-key']).toBe('sk-relay')
      expect(headers['anthropic-version']).toBe('2023-06-01')
      expect(headers['anthropic-beta']).toBe('some-beta-header')
      expect(headers.Authorization).toBeUndefined()

      const sentBody = JSON.parse(String(upstream.init.body)) as {
        messages: Array<{ content: Array<{ type: string }> }>
      }
      const types = sentBody.messages[0]!.content.map(block => block.type)
      expect(types).toEqual(['tool_result', 'text', 'image'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('forwards custom headers and drops empty-key auth headers', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: '',
      apiFormat: 'anthropic',
      authStrategy: 'api_key',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const captured: Array<{ init: RequestInit }> = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push({ init: init ?? {} })
      return new Response(JSON.stringify({
        id: 'msg_relay',
        type: 'message',
        role: 'assistant',
        model: 'model-main',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-gateway-token': 'gw-42',
            'x-tenant-id': 'tenant-a',
            'x-app': 'cli',
            'x-claude-code-session-id': 'session-secret',
            'x-claude-remote-container-id': 'container-secret',
            'x-claude-remote-session-id': 'remote-secret',
            'x-client-app': 'sdk-client',
            'User-Agent': 'claude-cli/2.1.220.693 (external, sdk, client-app/example/1.0)',
            connection: 'x-internal-hop',
            'x-internal-hop': 'secret',
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)

      const headers = captured[0]!.init.headers as Record<string, string>
      expect(headers['x-gateway-token']).toBe('gw-42')
      expect(headers['x-tenant-id']).toBe('tenant-a')
      expect(headers['x-app']).toBeUndefined()
      expect(headers['x-claude-code-session-id']).toBeUndefined()
      expect(headers['x-claude-remote-container-id']).toBeUndefined()
      expect(headers['x-claude-remote-session-id']).toBeUndefined()
      expect(headers['x-client-app']).toBeUndefined()
      expect(headers['user-agent']).toBeUndefined()
      // Empty key sends no auth header at all, and hop-by-hop headers — both
      // the fixed set and the ones named by `Connection` — do not leak to the
      // upstream.
      expect(headers['x-api-key']).toBeUndefined()
      expect(headers.Authorization).toBeUndefined()
      expect(headers.connection).toBeUndefined()
      expect(headers['x-internal-hop']).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('redacts forwarded custom header values in trace capture', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      authStrategy: 'api_key',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const captured: Headers[] = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push(new Headers(init?.headers))
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'model-main',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const sessionId = 'session-custom-header-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-claude-code-session-id': sessionId,
            'x-relay-credential': 'opaque-value-42',
            'anthropic-relay-credential': 'opaque-value-43',
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(captured[0]?.get('x-relay-credential')).toBe('opaque-value-42')
      expect(captured[0]?.get('anthropic-relay-credential')).toBe('opaque-value-43')

      await drainTraceCaptureForTests()
      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      const traceRaw = await fs.readFile(tracePath, 'utf-8')
      expect(traceRaw).toContain('x-relay-credential')
      expect(traceRaw).toContain('anthropic-relay-credential')
      expect(traceRaw).toContain('[redacted]')
      expect(traceRaw).not.toContain('opaque-value-42')
      expect(traceRaw).not.toContain('opaque-value-43')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('keeps a provider-specific user agent', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: '',
      apiFormat: 'anthropic',
      authStrategy: 'api_key',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const captured: Headers[] = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push(new Headers(init?.headers))
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'model-main',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'User-Agent': 'third-party-gateway/1.0',
            'x-app': 'provider-routing-client',
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(captured[0]?.get('user-agent')).toBe('third-party-gateway/1.0')
      expect(captured[0]?.get('x-app')).toBe('provider-routing-client')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('uses preset default Bearer auth for a saved no-key provider', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'lmstudio',
      name: 'LM Studio',
      baseUrl: 'http://localhost:1234',
      apiKey: '',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const captured: Array<{ init: RequestInit }> = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push({ init: init ?? {} })
      return new Response(JSON.stringify({
        id: 'msg_relay',
        type: 'message',
        role: 'assistant',
        model: 'model-main',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)

      const headers = captured[0]!.init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer lmstudio')
      expect(headers['x-api-key']).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('uses Bearer auth for auth_token strategy', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      authStrategy: 'auth_token',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const captured: Array<{ init: RequestInit }> = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push({ init: init ?? {} })
      return new Response(JSON.stringify({
        id: 'msg_relay',
        type: 'message',
        role: 'assistant',
        model: 'model-main',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)

      const headers = captured[0]!.init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer sk-relay')
      expect(headers['x-api-key']).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('uses both API key and Bearer auth for dual_same_token strategy', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Dual Auth',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-dual',
      apiFormat: 'anthropic',
      authStrategy: 'dual_same_token',
      supportsNestedToolResultMedia: false,
      models: { main: 'model-main', haiku: 'model-main', sonnet: 'model-main', opus: 'model-main' },
    })

    const originalFetch = globalThis.fetch
    let forwardedHeaders: Record<string, string> | undefined
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      forwardedHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify({
        id: 'msg_dual',
        type: 'message',
        role: 'assistant',
        model: 'model-main',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      expect((await handleProxyRequest(req, new URL(req.url))).status).toBe(200)
      expect(forwardedHeaders?.['x-api-key']).toBe('sk-dual')
      expect(forwardedHeaders?.Authorization).toBe('Bearer sk-dual')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('passes upstream error bodies and headers through unchanged', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'slow down' },
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'retry-after': '42' },
      })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBe('42')
      const body = await res.json() as { error: { type: string } }
      expect(body.error.type).toBe('rate_limit_error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('passes success bodies and entity headers through byte-for-byte', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const upstreamBody = JSON.stringify({
      id: 'msg_relay',
      type: 'message',
      role: 'assistant',
      model: 'model-main',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    globalThis.fetch = mock(async () => {
      return new Response(upstreamBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(upstreamBody.length),
          'x-request-id': 'req_abc',
          'etag': '"v1"',
        },
      })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBe(String(upstreamBody.length))
      expect(res.headers.get('x-request-id')).toBe('req_abc')
      expect(res.headers.get('etag')).toBe('"v1"')
      expect(await res.text()).toBe(upstreamBody)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('forwards compressed upstream bodies byte-for-byte with their encoding headers', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const upstreamBody = JSON.stringify({
      id: 'msg_relay',
      type: 'message',
      role: 'assistant',
      model: 'model-main',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const gzipBody = Bun.gzipSync(Buffer.from(upstreamBody))
    globalThis.fetch = mock(async () => {
      return new Response(gzipBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': String(gzipBody.length),
          'etag': '"gzip-v1"',
        },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-gzip-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBe('gzip')
      expect(res.headers.get('content-length')).toBe(String(gzipBody.length))
      expect(res.headers.get('etag')).toBe('"gzip-v1"')
      const forwarded = new Uint8Array(await res.arrayBuffer())
      expect(forwarded).toEqual(new Uint8Array(gzipBody))

      // The trace stores readable text: the captured gzip bytes are
      // decompressed for storage instead of being UTF-8-decoded as garbage.
      // (The body is JSON-stringified inside the trace record, so the marker
      // appears unescaped only in decompressed plain text.)
      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let traceRaw = ''
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          traceRaw = await fs.readFile(tracePath, 'utf-8')
          if (traceRaw.includes('upstream_fetch_completed')) break
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(traceRaw).toContain('msg_relay')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('forwards compressed SSE byte-for-byte while the trace stores plain text', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const sseText = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_relay_stream","type":"message","role":"assistant","content":[],"model":"model-main","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n')
    const gzipBody = Bun.gzipSync(Buffer.from(sseText))
    globalThis.fetch = mock(async () => {
      return new Response(gzipBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': 'gzip',
          'Content-Length': String(gzipBody.length),
        },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-gzip-stream-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBe('gzip')
      expect(res.headers.get('content-length')).toBe(String(gzipBody.length))
      // The client receives the raw compressed bytes unchanged (it decodes
      // them itself); only the trace snapshot is decompressed.
      const forwarded = new Uint8Array(await res.arrayBuffer())
      expect(forwarded).toEqual(new Uint8Array(gzipBody))

      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let traceRaw = ''
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          traceRaw = await fs.readFile(tracePath, 'utf-8')
          if (traceRaw.includes('upstream_fetch_completed')) break
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(traceRaw).toContain('msg_relay_stream')
      // The snapshot holds readable SSE text, not gzip bytes decoded as UTF-8.
      expect(traceRaw).not.toContain('\uFFFD')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('keeps compressed stream trace readable when the decoded size exceeds the capture cap', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    // A compact gzip body that decompresses well past the 1 MiB trace cap:
    // the cap applies to decoded output, so the trace still holds a readable
    // plain-text prefix instead of an unterminated gzip member.
    const chunk = 'x'.repeat(1024)
    const sseText = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_relay_big","type":"message","role":"assistant","content":[],"model":"model-main","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
      ...Array.from({ length: 1200 }, () => `data: ${chunk}`),
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n')
    expect(sseText.length).toBeGreaterThan(1024 * 1024)
    const gzipBody = Bun.gzipSync(Buffer.from(sseText))
    expect(gzipBody.length).toBeLessThan(1024 * 1024)
    globalThis.fetch = mock(async () => {
      return new Response(gzipBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': 'gzip',
          'Content-Length': String(gzipBody.length),
        },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-gzip-big-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      const forwarded = new Uint8Array(await res.arrayBuffer())
      expect(forwarded).toEqual(new Uint8Array(gzipBody))

      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let traceRaw = ''
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          traceRaw = await fs.readFile(tracePath, 'utf-8')
          if (traceRaw.includes('upstream_fetch_completed')) break
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(traceRaw).toContain('msg_relay_big')
      expect(traceRaw).not.toContain('\uFFFD')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('keeps the plain-text prefix when the client cancels a compressed stream mid-way', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    // A gzip member made of two deflate blocks (flush between parts), so a
    // mid-way cancel leaves a complete first block the trace can decode. The
    // first part carries high-entropy filler so its compressed size exceeds
    // the zlib writable high-water mark: writing it returns false, exercising
    // the backpressure wait path instead of the trivial 128-byte case.
    const { createGzip } = await import('node:zlib')
    const { randomBytes } = await import('node:crypto')
    const filler = randomBytes(48 * 1024).toString('base64')
    const gzip = createGzip()
    const gzipChunks: Buffer[] = []
    gzip.on('data', (chunk: Buffer) => gzipChunks.push(chunk))
    const part1 = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_relay_partial","type":"message","role":"assistant","content":[],"model":"model-main","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: ' + filler + '\n\n'
    const part2 = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
    gzip.write(Buffer.from(part1))
    await new Promise<void>(resolve => gzip.flush(() => resolve()))
    gzip.write(Buffer.from(part2))
    gzip.end()
    await new Promise<void>(resolve => gzip.on('end', () => resolve()))
    const gzipBody = Buffer.concat(gzipChunks)
    // The first chunk must exceed zlib's default writableHighWaterMark
    // (16 KiB) so decompressor.write() returns false.
    expect(gzipBody.length).toBeGreaterThan(32 * 1024)

    // The second chunk stays pending behind a gate until the client cancels:
    // the test must prove the trace wrapper stops reading mid-member, not
    // that both chunks happened to arrive before the cancel.
    let releasePart2: (() => void) | null = null
    let part2Released = false
    let upstreamCancelled = false
    let upstreamBody: ReadableStream<Uint8Array> | null = null
    globalThis.fetch = mock(async () => {
      // Chunked body so the client can stop reading mid-member.
      upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(gzipBody.subarray(0, 32 * 1024))
          void new Promise<void>(resolve => {
            releasePart2 = resolve
          }).then(() => {
            part2Released = true
            controller.enqueue(gzipBody.subarray(32 * 1024))
            controller.close()
          })
        },
        cancel() {
          upstreamCancelled = true
        },
      })
      return new Response(upstreamBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': 'gzip',
          'Content-Length': String(gzipBody.length),
        },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-gzip-cancel-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      // The client stops reading after the first chunk of the gzip member:
      // the trace copy must still hold the decoded SSE prefix already
      // received, not an unterminated gzip member decoded as garbage.
      const reader = res.body!.getReader()
      await reader.read()
      await reader.cancel('client stopped generation').catch(() => undefined)

      // The cancel must propagate upstream while part 2 is still pending:
      // the trace wrapper reads lazily, so it cannot have consumed part 2.
      expect(upstreamCancelled).toBe(true)
      expect(part2Released).toBe(false)
      // The read loop must finish and release the upstream reader even when
      // the cancel lands while the decompressor is backpressured (write()
      // returned false and the waiter is parked on drain/finish/close).
      for (let attempt = 0; attempt < 100 && upstreamBody?.locked; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(upstreamBody?.locked).toBe(false)

      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let traceRaw = ''
      let lastSize = 0
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          traceRaw = await fs.readFile(tracePath, 'utf-8')
          if (traceRaw.includes('cancelled') && traceRaw.length === lastSize) break
          lastSize = traceRaw.length
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(traceRaw).toContain('msg_relay_partial')
      expect(traceRaw).toContain('cancelled')
      expect(traceRaw).not.toContain('content_block_delta')
      expect(traceRaw).not.toContain('\uFFFD')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('marks the trace unavailable for stacked content encodings instead of storing garbage', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const sseText = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_relay_stacked","type":"message","role":"assistant","content":[],"model":"model-main","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n')
    // Stacked encodings: Content-Encoding lists codes in application order,
    // so 'gzip, deflate' means gzip was applied first, then deflate — the
    // wire bytes are deflate(gzip(body)). The streaming branch only checks
    // that more than one codec is present, so the exact stacking does not
    // change the assertion; the fixture stays semantically correct for any
    // future buffered decode test.
    const doubleEncoded = Bun.deflateSync(Bun.gzipSync(Buffer.from(sseText)))
    globalThis.fetch = mock(async () => {
      return new Response(new Uint8Array(doubleEncoded), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': 'gzip, deflate',
          'Content-Length': String(doubleEncoded.length),
        },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-gzip-stacked-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      // The client still receives the raw double-encoded bytes unchanged.
      const forwarded = new Uint8Array(await res.arrayBuffer())
      expect(forwarded).toEqual(new Uint8Array(doubleEncoded))

      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let traceRaw = ''
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          traceRaw = await fs.readFile(tracePath, 'utf-8')
          if (traceRaw.includes('upstream_fetch_completed')) break
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      // The streaming branch only unwinds a single known codec; the trace is
      // marked unavailable instead of storing compressed bytes as UTF-8.
      expect(traceRaw).toContain('trace body unavailable')
      expect(traceRaw).not.toContain('msg_relay_stacked')
      expect(traceRaw).not.toContain('\uFFFD')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('marks the buffered trace unavailable for unsupported content encodings', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const upstreamBody = JSON.stringify({
      id: 'msg_relay_br',
      type: 'message',
      role: 'assistant',
      model: 'model-main',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    // Brotli is advertised by Bun's default Accept-Encoding and reachable via
    // header passthrough, but the trace decoder has no brotli codec — the
    // buffered path must mark the trace unavailable instead of storing the
    // compressed bytes as UTF-8 garbage. The body bytes themselves are
    // irrelevant here: the header alone drives the unavailable marker.
    const brBody = Bun.gzipSync(Buffer.from(upstreamBody))
    globalThis.fetch = mock(async () => {
      return new Response(brBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'br',
          'Content-Length': String(brBody.length),
        },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-br-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)

      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let traceRaw = ''
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          traceRaw = await fs.readFile(tracePath, 'utf-8')
          if (traceRaw.includes('upstream_fetch_completed')) break
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(traceRaw).toContain('trace body unavailable')
      expect(traceRaw).not.toContain('\uFFFD')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('marks the buffered trace unavailable when a known codec fails to decompress', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    // A supported codec in the header, but the body is not a valid gzip
    // member: the buffered path must mark the trace unavailable instead of
    // falling back to decoding the compressed bytes as UTF-8 garbage.
    const corruptGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xde, 0xad, 0xbe, 0xef])
    globalThis.fetch = mock(async () => {
      return new Response(corruptGzip, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': String(corruptGzip.length),
        },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-gzip-corrupt-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      // The raw bytes still pass through unchanged; only the trace is marked.
      const forwarded = new Uint8Array(await res.arrayBuffer())
      expect(forwarded).toEqual(corruptGzip)

      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let traceRaw = ''
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          traceRaw = await fs.readFile(tracePath, 'utf-8')
          if (traceRaw.includes('upstream_fetch_completed')) break
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(traceRaw).toContain('trace body unavailable')
      expect(traceRaw).not.toContain('\uFFFD')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('marks the streaming trace unavailable when a known codec fails to decompress', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    // The header names a supported codec, but the streamed body is not a
    // valid gzip member: the streaming branch must record the failure instead
    // of storing a partial/empty decode as a successful trace.
    const corruptGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xde, 0xad, 0xbe, 0xef])
    globalThis.fetch = mock(async () => {
      return new Response(corruptGzip, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': 'gzip',
          'Content-Length': String(corruptGzip.length),
        },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-gzip-corrupt-stream-trace'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      // The client still receives the raw bytes unchanged.
      const forwarded = new Uint8Array(await res.arrayBuffer())
      expect(forwarded).toEqual(corruptGzip)

      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let traceRaw = ''
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          traceRaw = await fs.readFile(tracePath, 'utf-8')
          if (traceRaw.includes('upstream_fetch_completed')) break
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(traceRaw).toContain('trace body unavailable')
      expect(traceRaw).not.toContain('\uFFFD')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('strips hop-by-hop headers from upstream success responses', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        id: 'msg_relay',
        type: 'message',
        role: 'assistant',
        model: 'model-main',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          connection: 'x-internal-hop',
          'x-internal-hop': 'secret',
          'x-request-id': 'req_abc',
        },
      })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(res.headers.get('x-request-id')).toBe('req_abc')
      expect(res.headers.get('connection')).toBeNull()
      expect(res.headers.get('x-internal-hop')).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('returns a structured 502 when the upstream error body fails to read', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      // Status and headers arrive, then the body stream errors mid-read.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
          controller.error('connection reset')
        },
      })
      return new Response(stream, {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'retry-after': '42' },
      })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(502)
      const body = await res.json() as { error: { type: string } }
      expect(body.error.type).toBe('api_error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('closes the pending trace when the upstream error body fails to read', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
          controller.error('connection reset')
        },
      })
      return new Response(stream, {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const sessionId = 'session-trace-body-read-fail'
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(502)

      // Wait for the background trace write to land, then read the raw jsonl:
      // the call opened as `pending` must be closed with the same id as an
      // error, and no second call with a different id may appear.
      const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
      let lines: string[] = []
      let lastSize = -1
      let stableReads = 0
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const raw = await fs.readFile(tracePath, 'utf-8')
          lines = raw.trim().split('\n').filter(Boolean)
          // Wait for the failed call entry AND for the file to stop growing,
          // so the background trace write (including the sqlite projection)
          // has fully landed before the teardown removes the temp dir.
          if (lines.some(line => line.includes('upstream_fetch_failed')) && raw.length === lastSize) {
            stableReads += 1
            if (stableReads >= 3) break
          } else {
            stableReads = 0
          }
          lastSize = raw.length
        } catch {
          // not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }

      const calls = lines
        .map(line => JSON.parse(line) as { type: string; record?: { id: string; status: string } })
        .filter(entry => entry.type === 'call' && entry.record)
        .map(entry => entry.record!)
      expect(calls.length).toBeGreaterThan(0)
      const callIds = new Set(calls.map(call => call.id))
      expect(callIds.size).toBe(1)
      expect(calls[calls.length - 1]!.status).toBe('error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test.each([
    { name: 'connection exception', upstream: () => { throw new Error('gateway connection refused') }, message: 'gateway connection refused', stream: false },
    { name: 'non-Error rejection', upstream: () => Promise.reject('gateway connection reset'), message: 'gateway connection reset', stream: true },
    { name: 'successful SSE response without a body', upstream: () => new Response(null, { status: 200 }), message: 'Upstream returned no body for stream', stream: true },
  ])('finishes exactly one failed trace for $name', async ({ upstream, message, stream }) => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Anthropic failure fixture',
      baseUrl: 'https://relay.example.com',
      apiKey: 'fixture-api-key',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: { main: 'model-main', haiku: 'model-main', sonnet: 'model-main', opus: 'model-main' },
    })
    const sessionId = 'session-trace-upstream-failure'
    const originalFetch = globalThis.fetch
    const upstreamFetch = mock(async () => upstream())
    globalThis.fetch = upstreamFetch as typeof fetch
    try {
      const request = new Request(`http://localhost:3456/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': sessionId },
        body: JSON.stringify({
          model: 'model-main', max_tokens: 64, stream,
          messages: [{ role: 'user', content: 'fixture prompt' }],
        }),
      })
      const response = await handleProxyRequest(request, new URL(request.url))
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ type: 'error', error: { type: 'api_error', message } })
      expect(upstreamFetch).toHaveBeenCalledTimes(1)

      await drainTraceCaptureForTests()
      const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`), 'utf8')
      const calls = raw.trim().split('\n')
        .map(line => JSON.parse(line) as { type: string; record: TraceCallRecord })
        .filter(entry => entry.type === 'call')
        .map(entry => entry.record)
      expect(calls.map(call => call.status)).toEqual(['pending', 'error'])
      expect(new Set(calls.map(call => call.id)).size).toBe(1)
      expect(calls[1]!.error?.message).toBe(message)
      expect(calls[1]!.request.url).toBe('https://relay.example.com/v1/messages')
      expect(calls[1]!.completedAt).toBeTruthy()
      expect(raw).not.toContain('fixture-api-key')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('preserves a compressed rate-limit response while recording its readable failed trace', async () => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Anthropic rate-limit fixture',
      baseUrl: 'https://relay.example.com',
      apiKey: 'fixture-api-key',
      apiFormat: 'anthropic',
      supportsNestedToolResultMedia: false,
      models: { main: 'model-main', haiku: 'model-main', sonnet: 'model-main', opus: 'model-main' },
    })
    const sessionId = 'session-trace-compressed-rate-limit'
    const errorBody = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture upstream quota exhausted' } })
    const compressedBody = Bun.deflateSync(Buffer.from(errorBody))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(compressedBody, {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'deflate',
        'Content-Length': String(compressedBody.length),
        'retry-after': '42',
        'request-id': 'fixture-request-id',
      },
    })) as typeof fetch
    try {
      const request = new Request(`http://localhost:3456/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': sessionId },
        body: JSON.stringify({ model: 'model-main', max_tokens: 64, messages: [{ role: 'user', content: 'fixture prompt' }] }),
      })
      const response = await handleProxyRequest(request, new URL(request.url))
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('42')
      expect(response.headers.get('request-id')).toBe('fixture-request-id')
      expect(response.headers.get('content-encoding')).toBe('deflate')
      expect(response.headers.get('content-length')).toBe(String(compressedBody.length))
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(compressedBody))

      await drainTraceCaptureForTests()
      const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`), 'utf8')
      const calls = raw.trim().split('\n')
        .map(line => JSON.parse(line) as { type: string; record: TraceCallRecord })
        .filter(entry => entry.type === 'call')
        .map(entry => entry.record)
      expect(calls.map(call => call.status)).toEqual(['pending', 'error'])
      expect(new Set(calls.map(call => call.id)).size).toBe(1)
      expect(calls[1]!.response?.status).toBe(429)
      expect(JSON.stringify(calls[1]!.response?.body)).toContain('fixture upstream quota exhausted')
      expect(raw).not.toContain('trace body unavailable')
      expect(raw).not.toContain('fixture-api-key')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('returns 400 when anthropic provider supports nested media (proxy not needed)', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Anthropic Compat',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay',
      apiFormat: 'anthropic',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      throw new Error('fetch should not be called')
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(400)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
