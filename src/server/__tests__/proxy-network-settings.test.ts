import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleProxyRequest, withStreamIdleTimeout } from '../proxy/handler.js'
import { ProviderService } from '../services/providerService.js'
import {
  clearTraceCaptureStateForTests,
  drainTraceCaptureForTests,
  traceCaptureService,
} from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-network-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
  clearTraceCaptureStateForTests()
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  resetSettingsCache()
  await drainTraceCaptureForTests()
  clearTraceCaptureStateForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

async function waitForTraceCall(sessionId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const trace = await traceCaptureService.getSessionTrace(sessionId)
    if (trace.calls.length > 0 && trace.calls[0]?.response) return trace
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return traceCaptureService.getSessionTrace(sessionId)
}

describe('proxy network settings', () => {
  beforeEach(setup)
  afterEach(teardown)

  for (const apiFormat of ['openai_chat', 'openai_responses'] as const) {
    for (const upstreamStatus of [503, 200, 'thrown'] as const) {
      test(`${apiFormat} preserves policy refusal despite upstream ${upstreamStatus}`, async () => {
        const provider = await new ProviderService().addProvider({
          presetId: 'custom', name: 'Policy fixture', baseUrl: 'https://api.example.com',
          apiKey: 'sk-test', apiFormat,
          models: { main: 'test-model', haiku: 'test-model', sonnet: 'test-model', opus: 'test-model' },
        })
        const originalFetch = globalThis.fetch
        const upstreamFetch = mock(async () => {
          if (upstreamStatus === 'thrown') {
            throw Object.assign(new Error('Request denied'), { code: 'cyber_policy' })
          }
          return Response.json({
            error: { code: 'cyber_policy', message: 'Request denied' },
          }, { status: upstreamStatus })
        })
        globalThis.fetch = upstreamFetch as unknown as typeof fetch
        try {
          const req = new Request(`http://localhost:3456/proxy/providers/${provider.id}/v1/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'test-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }),
          })
          const res = await handleProxyRequest(req, new URL(req.url))
          expect(res.status).toBe(403)
          expect(await res.json()).toMatchObject({ error: { type: 'permission_error', code: 'cyber_policy' } })
          expect(upstreamFetch).toHaveBeenCalledTimes(1)
        } finally {
          globalThis.fetch = originalFetch
        }
      })
    }
  }

  test('uses configured AI request timeout for non-stream upstream requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 45_000,
          proxy: { mode: 'system', url: '' },
        },
      }),
      'utf-8',
    )

    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'OpenAI Proxy',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'openai_chat',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    const timeoutCalls: number[] = []
    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-network-timeout',
        object: 'chat.completion',
        created: 0,
        model: 'model-main',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    AbortSignal.timeout = ((ms: number) => {
      timeoutCalls.push(ms)
      return originalTimeout(ms)
    }) as typeof AbortSignal.timeout

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))

      expect(res.status).toBe(200)
      expect(timeoutCalls).toEqual([45_000])
    } finally {
      AbortSignal.timeout = originalTimeout
      globalThis.fetch = originalFetch
    }
  })

  test('uses configured AI request timeout for non-stream Responses upstream requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 45_000,
          proxy: { mode: 'system', url: '' },
        },
      }),
      'utf-8',
    )

    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'OpenAI Responses Proxy',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'openai_responses',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    const timeoutCalls: number[] = []
    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: 'resp-network-timeout',
        status: 'completed',
        model: 'model-main',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    AbortSignal.timeout = ((ms: number) => {
      timeoutCalls.push(ms)
      return originalTimeout(ms)
    }) as typeof AbortSignal.timeout

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))

      expect(res.status).toBe(200)
      expect(timeoutCalls).toEqual([45_000])
    } finally {
      AbortSignal.timeout = originalTimeout
      globalThis.fetch = originalFetch
    }
  })

  test('bypasses inherited system proxy for direct OpenAI-compatible upstream requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          proxy: { mode: 'direct', url: '' },
        },
      }),
      'utf-8',
    )

    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Direct OpenAI Proxy',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'openai_chat',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const originalHttpProxy = process.env.HTTP_PROXY
    const originalHttpsProxy = process.env.HTTPS_PROXY
    const originalLowerHttpProxy = process.env.http_proxy
    const originalLowerHttpsProxy = process.env.https_proxy
    const calls: Array<{ url: string; proxy?: string }> = []
    process.env.HTTP_PROXY = 'http://127.0.0.1:1181'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1181'
    delete process.env.http_proxy
    delete process.env.https_proxy
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        proxy: (init as RequestInit & { proxy?: string } | undefined)?.proxy,
      })
      return new Response(JSON.stringify({
        id: 'chatcmpl-direct-runtime',
        object: 'chat.completion',
        created: 0,
        model: 'model-main',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))

      expect(res.status).toBe(200)
      expect(calls.map((call) => call.url)).toEqual(['https://api.example.com/v1/chat/completions'])
      expect(calls.map((call) => call.proxy)).toEqual([undefined])
    } finally {
      globalThis.fetch = originalFetch
      if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = originalHttpProxy
      if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = originalHttpsProxy
      if (originalLowerHttpProxy === undefined) delete process.env.http_proxy
      else process.env.http_proxy = originalLowerHttpProxy
      if (originalLowerHttpsProxy === undefined) delete process.env.https_proxy
      else process.env.https_proxy = originalLowerHttpsProxy
    }
  })

  test('bypasses manual proxy for loopback OpenAI-compatible upstream requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          proxy: { mode: 'manual', url: 'http://127.0.0.1:1181' },
        },
      }),
      'utf-8',
    )

    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'Local OpenAI Proxy',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: 'sk-test',
      apiFormat: 'openai_chat',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; proxy?: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        proxy: (init as RequestInit & { proxy?: string } | undefined)?.proxy,
      })
      return new Response(JSON.stringify({
        id: 'chatcmpl-local-runtime',
        object: 'chat.completion',
        created: 0,
        model: 'model-main',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))

      expect(res.status).toBe(200)
      expect(calls.map((call) => call.url)).toEqual(['http://127.0.0.1:11434/v1/chat/completions'])
      expect(calls.map((call) => call.proxy)).toEqual([undefined])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('records redacted OpenAI proxy request headers in trace capture', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'OpenAI Trace Proxy',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-trace-secret',
      apiFormat: 'openai_chat',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-trace-headers',
        object: 'chat.completion',
        created: 0,
        model: 'model-main',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': 'session-proxy-trace-headers',
          },
          body: JSON.stringify({
            model: 'model-main',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hello' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)

      const trace = await waitForTraceCall('session-proxy-trace-headers')
      expect(trace.calls).toHaveLength(1)
      expect(trace.calls[0].request.headers.Authorization).toBe('[redacted]')
      expect(trace.calls[0].request.headers['Content-Type']).toBe('application/json')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('uses configured AI request timeout while opening and reading streaming upstream requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 180_000,
          proxy: { mode: 'system', url: '' },
        },
      }),
      'utf-8',
    )

    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'OpenAI Proxy',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'openai_chat',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const timeoutCalls: number[] = []
    const timers: Array<{ ms: number | undefined; cleared: boolean }> = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as typeof fetch
    AbortSignal.timeout = ((ms: number) => {
      timeoutCalls.push(ms)
      return originalTimeout(ms)
    }) as typeof AbortSignal.timeout
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      const timer = { ms, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
      const found = timers.find((entry) => entry === timer)
      if (found) found.cleared = true
    }) as typeof clearTimeout

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))
      await res.text()

      expect(res.status).toBe(200)
      expect(timeoutCalls).toEqual([])
      expect(timers).toEqual([
        { ms: 180_000, cleared: true },
        { ms: 180_000, cleared: true },
        { ms: 180_000, cleared: true },
      ])
    } finally {
      globalThis.clearTimeout = originalClearTimeout
      globalThis.setTimeout = originalSetTimeout
      AbortSignal.timeout = originalTimeout
      globalThis.fetch = originalFetch
    }
  })

  test('fails a streaming upstream body that stops producing chunks', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"id\":\"chunk-1\",\"choices\":[]}\n\n'))
      },
    })

    await expect(new Response(withStreamIdleTimeout(stalled, 20)).text())
      .rejects
      .toThrow('Upstream stream idle timeout after 20ms')
  })

  test('propagates streaming upstream body errors before the idle timeout fires', async () => {
    let pulls = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('data: {\"id\":\"chunk-1\",\"choices\":[]}\n\n'))
          return
        }
        controller.error(new Error('upstream body failed'))
      },
    })
    const reader = withStreamIdleTimeout(upstream, 1_000).getReader()

    expect(await reader.read()).toEqual({
      done: false,
      value: new TextEncoder().encode('data: {\"id\":\"chunk-1\",\"choices\":[]}\n\n'),
    })
    await expect(reader.read()).rejects.toThrow('upstream body failed')
  })

  test('cancels the upstream body when the downstream stream is canceled', async () => {
    let cancelReason: unknown = null
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"id\":\"chunk-1\",\"choices\":[]}\n\n'))
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const reader = withStreamIdleTimeout(upstream, 1_000).getReader()

    expect((await reader.read()).done).toBe(false)
    await reader.cancel('downstream closed')

    expect(cancelReason).toBe('downstream closed')
  })
})
