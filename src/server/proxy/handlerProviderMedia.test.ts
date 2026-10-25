import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { ProviderService } from '../services/providerService.js'
import { SettingsService } from '../services/settingsService.js'
import { traceCaptureService, type RecordTraceCallInput } from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleProxyRequest } from './handler.js'

describe('provider image files reach the actual proxy upstream', () => {
  let fixture: string
  let previousEnv: NodeJS.ProcessEnv
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'proxy-provider-media-'))
    previousEnv = { ...process.env }
    const environment = createSandboxedTestEnvironment(fixture)
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, environment)
    resetSettingsCache()
    await new SettingsService().updateUserSettings({
      network: { aiRequestTimeoutMs: 30_000, proxy: { mode: 'manual', url: 'http://127.0.0.1:9876' } },
    })
  })
  afterEach(async () => {
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, previousEnv)
    resetSettingsCache()
    await rm(fixture, { recursive: true, force: true })
  })

  for (const apiFormat of ['anthropic', 'openai_chat', 'openai_responses'] as const) {
    for (const mode of ['large', 'recover'] as const) {
      test(`${apiFormat} ${mode} preserves tool images and records the actual outbound request`, async () => {
        const key = `fake-proxy-media-${apiFormat}-${mode}`
        const provider = await new ProviderService().addProvider({
          presetId: 'custom', name: 'DeepSeek fixture',
          baseUrl: apiFormat === 'anthropic' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com',
          apiKey: key, apiFormat, authStrategy: 'api_key', supportsNestedToolResultMedia: false,
          models: { main: 'deepseek-flash', haiku: '', sonnet: '', opus: '' },
        })
        const fileId = `file-proxy-${apiFormat}-${mode}`
        const traceCalls: RecordTraceCallInput[] = []
        const callMock = spyOn(traceCaptureService, 'recordCall').mockImplementation(async input => { traceCalls.push(input); return null })
        const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
        const paths: string[] = []
        const wire: Array<{ body: Record<string, unknown>; headers: Headers }> = []
        let sharedSignal: AbortSignal | null | undefined
        const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          expect(url.origin).toBe('https://api.deepseek.com')
          paths.push(url.pathname)
          expect((init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:9876')
          expect(init?.signal).toBeDefined()
          if (sharedSignal) expect(init?.signal).toBe(sharedSignal)
          else sharedSignal = init?.signal
          const headers = new Headers(init?.headers)
          if (url.pathname === '/files') {
            expect(headers.get('authorization')).toBe(`Bearer ${key}`)
            expect(headers.has('content-type')).toBe(false)
            expect(headers.has('content-length')).toBe(false)
            expect(init?.redirect).toBe('error')
            expect(init?.body instanceof FormData).toBe(true)
            return Response.json({ id: fileId })
          }
          expect(headers.get(apiFormat === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(apiFormat === 'anthropic' ? key : `Bearer ${key}`)
          wire.push({ body: JSON.parse(String(init?.body)), headers })
          if (mode === 'recover' && wire.length === 1) return Response.json({ error: { message: 'Request body too large' } }, { status: 413 })
          const body = apiFormat === 'anthropic'
            ? { id: 'msg-media', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [{ type: 'text', text: 'Image received' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }
            : apiFormat === 'openai_chat'
              ? { id: 'chat-media', choices: [{ index: 0, message: { content: 'Image received' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
              : { id: 'resp-media', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Image received' }] }], usage: { input_tokens: 10, output_tokens: 2 } }
          if (mode === 'large') return Response.json(body)
          const sse = apiFormat === 'anthropic'
            ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
            : apiFormat === 'openai_chat'
              ? 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Image received"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
              : `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: body })}\n\n`
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
        })
        const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(mode === 'large' ? 41 * 1024 * 1024 : 400) } }
        const requestBody = {
          model: 'deepseek-flash', max_tokens: 64, stream: mode === 'recover',
          messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'read-image', name: 'Read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-image', content: [image] }] },
          ],
        }
        try {
          const req = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-beta': 'existing-beta', 'x-claude-code-session-id': 'media-trace' },
            body: JSON.stringify(requestBody),
          })
          const response = await handleProxyRequest(req, new URL(req.url))
          expect(response.status).toBe(200)
          const responseText = await response.text()
          expect(responseText).toContain(mode === 'recover' ? 'message_stop' : 'Image received')
          expect(paths.filter(path => path === '/files')).toHaveLength(1)
          expect(wire).toHaveLength(mode === 'large' ? 1 : 2)
          const sent = wire.at(-1)!
          const serialized = JSON.stringify(sent.body)
          expect(serialized).toContain(`"file_id":"${fileId}"`)
          expect(serialized).not.toContain('base64')
          expect(serialized).not.toContain('omitted')
          if (apiFormat === 'anthropic') {
            expect(sent.headers.get('anthropic-beta')).toContain('files-api-2025-04-14')
            expect(serialized).toContain('"source":{"type":"file"')
          } else if (apiFormat === 'openai_chat') {
            expect(serialized).toContain(`"type":"file","file_id":"${fileId}"`)
          } else {
            expect(serialized).toContain(`"type":"input_image","file_id":"${fileId}"`)
          }
          for (let attempt = 0; attempt < 50 && !traceCalls.some(call => call.completedAt); attempt++) await Bun.sleep(1)
          expect(traceCalls.filter(call => call.status === 'pending')).toHaveLength(1)
          const completed = traceCalls.find(call => call.completedAt)
          expect(completed?.request.body).toMatchObject({ upstream: sent.body })
          expect(JSON.stringify((completed?.request.body as { upstream: unknown }).upstream)).toBe(serialized)
          expect(image.source.type).toBe('base64')
        } finally {
          fetchMock.mockRestore()
          callMock.mockRestore()
          eventMock.mockRestore()
        }
      })
    }

    for (const originalBeta of apiFormat === 'anthropic' ? [undefined, 'existing-beta'] : [undefined]) {
      test(`${apiFormat} traces the original image request after an expired file cannot be reuploaded (${originalBeta ?? 'no beta'})`, async () => {
        const key = `fake-proxy-inline-recovery-${apiFormat}-${originalBeta ?? 'none'}`
        const fileId = `file-expired-${apiFormat}-${originalBeta ?? 'none'}`
        const provider = await new ProviderService().addProvider({
          presetId: 'custom', name: 'DeepSeek recovery fixture',
          baseUrl: apiFormat === 'anthropic' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com',
          apiKey: key, apiFormat, authStrategy: 'api_key', supportsNestedToolResultMedia: false,
          models: { main: 'deepseek-flash', haiku: '', sonnet: '', opus: '' },
        })
        const traceCalls: RecordTraceCallInput[] = []
        const callMock = spyOn(traceCaptureService, 'recordCall').mockImplementation(async input => { traceCalls.push(input); return null })
        const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
        const wire: Array<{ body: Record<string, unknown>; headers: Headers }> = []
        let expired = false
        let uploads = 0
        const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          expect(url.origin).toBe('https://api.deepseek.com')
          if (url.pathname === '/files') {
            uploads++
            return expired ? new Response('rate limited', { status: 429 }) : Response.json({ id: fileId })
          }
          wire.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })
          if (wire.length === 1) {
            return expired
              ? Response.json({ error: { message: `${fileId} not found` } }, { status: 404 })
              : new Response('request too large', { status: 413 })
          }
          return Response.json(apiFormat === 'anthropic'
            ? { id: 'msg-recovered', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [{ type: 'text', text: 'Image received' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }
            : apiFormat === 'openai_chat'
              ? { id: 'chat-recovered', choices: [{ index: 0, message: { content: 'Image received' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
              : { id: 'resp-recovered', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Image received' }] }], usage: { input_tokens: 10, output_tokens: 2 } })
        })
        const requestBody = {
          model: 'deepseek-flash', max_tokens: 64,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1200) } }] }],
        }
        const sendRequest = async () => {
          const headers = new Headers({ 'content-type': 'application/json', 'x-claude-code-session-id': 'inline-recovery-trace' })
          if (originalBeta) headers.set('anthropic-beta', originalBeta)
          const req = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
            method: 'POST', headers, body: JSON.stringify(requestBody),
          })
          const response = await handleProxyRequest(req, new URL(req.url))
          expect(response.status).toBe(200)
          expect(await response.text()).toContain('Image received')
          for (let attempt = 0; attempt < 50 && !traceCalls.some(call => call.completedAt); attempt++) await Bun.sleep(1)
          expect(traceCalls.filter(call => call.completedAt)).toHaveLength(1)
        }
        try {
          // Populate the real shared cache through the proxy's 413 recovery.
          await sendRequest()
          expect(uploads).toBe(1)
          expect(JSON.stringify(wire.at(-1)!.body)).toContain(fileId)
          const originalWireBody = wire[0]!.body
          expired = true
          uploads = 0
          wire.length = 0
          traceCalls.length = 0

          await sendRequest()
          expect(uploads).toBe(1)
          expect(wire).toHaveLength(2)
          expect(JSON.stringify(wire[0]!.body)).toContain(fileId)
          const sent = wire.at(-1)!
          expect(sent.body).toEqual(originalWireBody)
          expect(JSON.stringify(sent.body)).toContain('base64')
          expect(JSON.stringify(sent.body)).not.toContain(fileId)
          expect(traceCalls.filter(call => call.status === 'pending')).toHaveLength(1)
          const completed = traceCalls.find(call => call.completedAt)!
          const tracedBeta = new Headers(completed.request.headers).get('anthropic-beta')
          expect(tracedBeta).toBe(sent.headers.get('anthropic-beta'))
          if (apiFormat === 'anthropic') expect(tracedBeta).toBe(originalBeta ?? null)
          expect((completed.request.body as { upstream: unknown }).upstream).toEqual(sent.body)
        } finally {
          fetchMock.mockRestore()
          callMock.mockRestore()
          eventMock.mockRestore()
        }
      })
    }
  }
})
