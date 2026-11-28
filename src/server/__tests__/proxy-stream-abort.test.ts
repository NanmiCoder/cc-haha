import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleProxyRequest } from '../proxy/handler.js'
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-stream-abort-test-'))
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

describe('downstream request abort propagation (#1917)', () => {
  beforeEach(setup)
  afterEach(teardown)

  test.each([true, false])('aborts upstream DeepSeek fetch immediately on downstream TTFT abort (stream=%p)', async (stream) => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 60_000,
          proxy: { mode: 'direct', url: '' },
        },
      }),
      'utf-8',
    )

    const provider = await new ProviderService().addProvider({
      presetId: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek-test',
      apiFormat: 'openai_chat',
      models: {
        main: 'deepseek-reasoner',
        haiku: 'deepseek-chat',
        sonnet: 'deepseek-reasoner',
        opus: 'deepseek-reasoner',
      },
    })

    const originalFetch = globalThis.fetch
    let upstreamSignal: AbortSignal | undefined
    let resolveUpstreamAborted!: () => void
    const upstreamAborted = new Promise<void>((resolve) => {
      resolveUpstreamAborted = resolve
    })

    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          resolveUpstreamAborted()
          reject(upstreamSignal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        if (upstreamSignal?.aborted) {
          onAbort()
          return
        }
        upstreamSignal?.addEventListener('abort', onAbort, { once: true })
      })
    }) as typeof fetch

    try {
      const downstreamController = new AbortController()
      const sessionId = `session-ttft-abort-${stream ? 'stream' : 'json'}`
      const req = new Request(`http://localhost:3456/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-code-session-id': sessionId,
        },
        body: JSON.stringify({
          model: 'deepseek-reasoner',
          max_tokens: 1024,
          stream,
          messages: [{ role: 'user', content: 'prove Riemann hypothesis' }],
        }),
        signal: downstreamController.signal,
      })

      const proxyPromise = handleProxyRequest(req, new URL(req.url))
      for (let i = 0; i < 20 && !upstreamSignal; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(upstreamSignal).toBeDefined()
      expect(upstreamSignal?.aborted).toBe(false)

      downstreamController.abort(new DOMException('User interrupted turn', 'AbortError'))

      await Promise.race([
        upstreamAborted,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Upstream signal was not aborted')), 500)),
      ])
      expect(upstreamSignal?.aborted).toBe(true)

      const res = await proxyPromise
      expect(res.status).toBe(499)

      const trace = await waitForTraceCall(sessionId)
      expect(trace.calls).toHaveLength(1)
      expect(trace.calls[0]?.status).toBe('error')
      expect(trace.calls[0]?.metadata).toMatchObject({ aborted: true })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('aborts upstream DeepSeek HTTP connection mid-stream during reasoning and SSE keep-alive comments', async () => {
    let upstreamRequestAborted = false
    let upstreamStreamCancelled = false
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null
    let resolveUpstreamClosed!: () => void
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamClosed = resolve
    })

    const upstreamServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(upstreamReq) {
        upstreamReq.signal.addEventListener('abort', () => {
          upstreamRequestAborted = true
          if (keepAliveTimer) {
            clearInterval(keepAliveTimer)
            keepAliveTimer = null
          }
          resolveUpstreamClosed()
        }, { once: true })

        const encoder = new TextEncoder()
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(
              'data: {"id":"ds-1","object":"chat.completion.chunk","created":0,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"First thought..."},"finish_reason":null}]}\n\n',
            ))
            keepAliveTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keep-alive\n\n'))
              } catch {
                if (keepAliveTimer) {
                  clearInterval(keepAliveTimer)
                  keepAliveTimer = null
                }
              }
            }, 15)
          },
          cancel() {
            upstreamStreamCancelled = true
            if (keepAliveTimer) {
              clearInterval(keepAliveTimer)
              keepAliveTimer = null
            }
            resolveUpstreamClosed()
          },
        }), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        })
      },
    })

    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 60_000,
          proxy: { mode: 'direct', url: '' },
        },
      }),
      'utf-8',
    )

    const provider = await new ProviderService().addProvider({
      presetId: 'deepseek',
      name: 'DeepSeek Loopback',
      baseUrl: `http://127.0.0.1:${upstreamServer.port}/v1`,
      apiKey: 'sk-deepseek-loopback',
      apiFormat: 'openai_chat',
      models: {
        main: 'deepseek-reasoner',
        haiku: 'deepseek-chat',
        sonnet: 'deepseek-reasoner',
        opus: 'deepseek-reasoner',
      },
    })

    const proxyServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        return handleProxyRequest(req, new URL(req.url))
      },
    })

    try {
      const sessionId = 'session-deepseek-stream-abort'
      const clientAbort = new AbortController()
      const response = await fetch(
        `http://127.0.0.1:${proxyServer.port}/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': sessionId,
          },
          body: JSON.stringify({
            model: 'deepseek-reasoner',
            max_tokens: 4096,
            stream: true,
            messages: [{ role: 'user', content: 'think deeply' }],
          }),
          signal: clientAbort.signal,
        },
      )
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let received = ''
      while (!received.includes('First thought...')) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += decoder.decode(chunk.value, { stream: true })
      }
      expect(received).toContain('thinking_delta')

      await new Promise((resolve) => setTimeout(resolve, 35))
      clientAbort.abort()
      await reader.cancel().catch(() => undefined)

      await Promise.race([
        upstreamClosed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Upstream DeepSeek connection stayed open after client abort')), 500)),
      ])
      expect(upstreamRequestAborted || upstreamStreamCancelled).toBe(true)
      expect(upstreamRequestAborted).toBe(true)

      const trace = await waitForTraceCall(sessionId)
      expect(trace.calls).toHaveLength(1)
      expect(trace.calls[0]?.status).toBe('error')
      expect(trace.calls[0]?.metadata).toMatchObject({
        aborted: true,
        protocolTrace: {
          transport: 'cancelled',
          delivery: 'cancelled',
        },
      })
    } finally {
      if (keepAliveTimer) clearInterval(keepAliveTimer)
      proxyServer.stop(true)
      upstreamServer.stop(true)
    }
  })

  test('handleProxyRequest errors traced Response.body promptly on downstream abort without reader.cancel() and records cancelled protocolTrace (#1917)', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 60_000,
          proxy: { mode: 'direct', url: '' },
        },
      }),
      'utf-8',
    )

    const provider = await new ProviderService().addProvider({
      presetId: 'deepseek',
      name: 'DeepSeek Direct Handler',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek-direct',
      apiFormat: 'openai_chat',
      models: {
        main: 'deepseek-reasoner',
        haiku: 'deepseek-chat',
        sonnet: 'deepseek-reasoner',
        opus: 'deepseek-reasoner',
      },
    })

    const originalFetch = globalThis.fetch
    let upstreamSignal: AbortSignal | undefined
    let upstreamCancelled = false

    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"id":"ds-direct-1","object":"chat.completion.chunk","created":0,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"Streaming thought..."},"finish_reason":null}]}\n\n',
          ))
        },
        cancel() {
          upstreamCancelled = true
        },
      })
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
    }) as typeof fetch

    try {
      const sessionId = 'session-direct-stream-abort-no-cancel'
      const downstreamController = new AbortController()
      const req = new Request(`http://localhost:3456/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-code-session-id': sessionId,
        },
        body: JSON.stringify({
          model: 'deepseek-reasoner',
          max_tokens: 2048,
          stream: true,
          messages: [{ role: 'user', content: 'reason step by step' }],
        }),
        signal: downstreamController.signal,
      })

      const response = await handleProxyRequest(req, new URL(req.url))
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let received = ''
      while (!received.includes('Streaming thought...')) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += decoder.decode(chunk.value, { stream: true })
      }
      expect(received).toContain('thinking_delta')

      // Start the next read so it blocks on the open traced stream, then abort
      // the Request signal WITHOUT calling reader.cancel().
      const pendingRead = reader.read()
      downstreamController.abort(new DOMException('Downstream socket closed', 'AbortError'))

      let readError: unknown
      try {
        await Promise.race([
          pendingRead,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reader.read() hung after downstream abort')), 500)),
        ])
      } catch (err) {
        readError = err
      }
      expect(readError).toBeDefined()
      expect((readError as Error).name).toBe('AbortError')
      expect(upstreamSignal?.aborted).toBe(true)
      expect(upstreamCancelled).toBe(true)

      const trace = await waitForTraceCall(sessionId)
      expect(trace.calls).toHaveLength(1)
      expect(trace.calls[0]?.status).toBe('error')
      expect(trace.calls[0]?.metadata).toMatchObject({
        aborted: true,
        protocolTrace: {
          protocol: 'openai_chat',
          transport: 'cancelled',
          delivery: 'cancelled',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
