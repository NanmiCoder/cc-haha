/**
 * End-to-end integration tests for standard cloud-vendor protocols against
 * strict, official-documentation-faithful local mock cloud servers:
 *
 * 1. Google Vertex AI (GCP) — Gemini (`generateContent` / `streamGenerateContent?alt=sse`)
 *    + Express Mode + PayGo service-tier headers + OAuth2 Bearer
 * 2. Google Vertex AI (GCP) — Anthropic Claude (`rawPredict` / `streamRawPredict`)
 * 3. AWS Bedrock Runtime Converse (`converse` / `converse-stream`) — cryptographic
 *    AWS SigV4 signature verification + Bearer API key + real binary AWS EventStream
 *    (`application/vnd.amazon.eventstream`) + `foundation-models` discovery
 * 4. Microsoft Azure OpenAI / Azure AI Foundry — classic deployment URL + `?api-version=`
 *    + `api-key` header + modern `/openai/v1/responses` + Entra ID Bearer token
 *
 * Exercises multi-turn conversations, thinking/signature/redacted_thinking round-trips,
 * tool calls, user images + tool_result images, streaming & non-streaming,
 * `ProviderService.testProvider`, and `fetchProviderModels` in an isolated temp config dir.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { handleProxyRequest } from './handler.js'
import { encodeBedrockEventStreamFrame } from './streaming/bedrockConverseToAnthropic.js'
import { handleProvidersApi } from '../api/providers.js'
import { ProviderService } from '../services/providerService.js'
import { fetchProviderModels } from '../services/providerModelCatalog.js'
import { TestProviderSchema } from '../types/provider.js'
import { drainTraceCaptureForTests } from '../services/traceCaptureService.js'
import { traceCaptureService, updateTraceCaptureSettings } from '../../services/api/traceCapture.js'

const TINY_PNG_USER = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const TINY_PNG_TOOL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type ParsedSseEvent = { event: string; data: Record<string, unknown> }

async function parseAnthropicSse(response: Response): Promise<ParsedSseEvent[]> {
  const text = await response.text()
  const events: ParsedSseEvent[] = []
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue
    let event = ''
    let data = ''
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (event && data) {
      events.push({ event, data: JSON.parse(data) as Record<string, unknown> })
    }
  }
  return events
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Verify an incoming HTTP request's AWS SigV4 signature against the official
 * AWS Signature Version 4 specification (returns true iff signature & body hash match).
 */
function verifyAwsSigV4Request(input: {
  method: string
  url: URL
  headers: Headers
  rawBody: string
  expectedAccessKeyId: string
  secretAccessKey: string
  expectedService: string
}): { ok: true; region: string } | { ok: false; reason: string } {
  const auth = input.headers.get('authorization')
  if (!auth) return { ok: false, reason: 'Missing Authorization header' }
  const match = auth.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/,
  )
  if (!match) return { ok: false, reason: `Malformed SigV4 header: ${auth}` }
  const [, accessKeyId, dateStamp, region, service, signedHeadersRaw, signature] = match
  if (accessKeyId !== input.expectedAccessKeyId) return { ok: false, reason: 'AccessKeyId mismatch' }
  if (service !== input.expectedService) return { ok: false, reason: `Service mismatch: ${service}` }

  const amzDate = input.headers.get('x-amz-date')
  if (!amzDate || !amzDate.startsWith(dateStamp!)) return { ok: false, reason: 'Invalid x-amz-date' }

  const payloadHash = sha256Hex(input.rawBody)
  const headerPayloadHash = input.headers.get('x-amz-content-sha256')
  if (headerPayloadHash && headerPayloadHash !== payloadHash) {
    return { ok: false, reason: 'x-amz-content-sha256 mismatch' }
  }

  const signedHeaderNames = signedHeadersRaw!.split(';')
  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      const value = name === 'host' ? input.url.host : (input.headers.get(name) ?? '')
      return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`
    })
    .join('')

  // Non-S3 AWS services double-encode URI segments in canonical requests
  const canonicalUri = input.url.pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')

  const canonicalQuery = [...input.url.searchParams.entries()]
    .sort(([aKey, aVal], [bKey, bVal]) => (aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey)))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeadersRaw,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp!)
  const kRegion = hmacSha256(kDate, region!)
  const kService = hmacSha256(kRegion, service!)
  const kSigning = hmacSha256(kService, 'aws4_request')
  const expectedSig = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  if (signature !== expectedSig) {
    return { ok: false, reason: 'Signature cryptographic verification failed' }
  }
  return { ok: true, region: region! }
}

function concatBytes(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, frame) => sum + frame.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.byteLength
  }
  return out
}

describe('Official-spec mock cloud servers E2E (Vertex AI, AWS Bedrock, Azure OpenAI)', () => {
  let tempConfigDir: string
  let previousConfigDir: string | undefined
  let providerService: ProviderService

  beforeAll(async () => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-cloud-e2e-'))
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    providerService = new ProviderService()
  })

  afterAll(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await fs.rm(tempConfigDir, { recursive: true, force: true })
  })

  test('Google Vertex AI (GCP) — Gemini multi-turn thinking + thoughtSignature + images + priority PayGo + Express Mode + Vertex Claude rawPredict', async () => {
    const receivedCalls: Array<{ path: string; query: string; auth: string | null; apiKeyHeader: string | null; requestType: string | null; sharedType: string | null; body: Record<string, unknown> }> = []

    const vertexServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        const auth = req.headers.get('authorization')
        const apiKeyHeader = req.headers.get('x-goog-api-key')

        // Model catalog discovery
        if (req.method === 'GET' && url.pathname === '/v1/projects/demo-proj/locations/us-central1/publishers/google/models') {
          if (auth !== 'Bearer ya29.mock-vertex-oauth') {
            return Response.json({ error: { code: 401, message: 'Unauthorized', status: 'UNAUTHENTICATED' } }, { status: 401 })
          }
          return Response.json({
            models: [
              { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
              { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
            ],
          })
        }

        const body = await req.json() as Record<string, unknown>
        receivedCalls.push({
          path: url.pathname,
          query: url.search,
          auth,
          apiKeyHeader,
          requestType: req.headers.get('x-vertex-ai-llm-request-type'),
          sharedType: req.headers.get('x-vertex-ai-llm-shared-request-type'),
          body,
        })

        // 1) Vertex Express Mode (`x-goog-api-key`)
        if (url.pathname === '/v1/publishers/google/models/gemini-3-flash:generateContent') {
          if (apiKeyHeader !== 'AQ.mock-vertex-express-key' || auth !== null) {
            return Response.json({ error: { code: 401, message: 'Expected Express Mode x-goog-api-key' } }, { status: 401 })
          }
          return Response.json({
            modelVersion: 'gemini-3-flash',
            candidates: [{ content: { role: 'model', parts: [{ text: 'express-ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
          })
        }

        // 2) Vertex Standard GCP Gemini (`Authorization: Bearer`, `X-Vertex-AI-LLM-*` headers, no body.serviceTier)
        if (url.pathname.startsWith('/v1/projects/demo-proj/locations/us-central1/publishers/google/models/gemini-3-pro:')) {
          if (auth !== 'Bearer ya29.mock-vertex-oauth') {
            return Response.json({ error: { code: 401, message: 'Expected OAuth2 Bearer token' } }, { status: 401 })
          }
          if ('serviceTier' in body) {
            return Response.json({ error: { code: 400, message: 'Vertex AI rejects body.serviceTier; use headers' } }, { status: 400 })
          }
          // Official Vertex AI v1 proto rejects `id` on functionCall / functionResponse
          const contentsCheck = Array.isArray(body.contents) ? body.contents as Array<{ parts?: Array<Record<string, unknown>> }> : []
          for (const turn of contentsCheck) {
            for (const part of turn.parts ?? []) {
              const fnCall = part.functionCall as Record<string, unknown> | undefined
              const fnResp = part.functionResponse as Record<string, unknown> | undefined
              if (fnCall && 'id' in fnCall) {
                return Response.json({ error: { code: 400, message: 'Invalid JSON payload: Unknown name "id" at functionCall' } }, { status: 400 })
              }
              if (fnResp && 'id' in fnResp) {
                return Response.json({ error: { code: 400, message: 'Invalid JSON payload: Unknown name "id" at functionResponse' } }, { status: 400 })
              }
            }
          }

          if (url.pathname.endsWith(':generateContent')) {
            return Response.json({
              modelVersion: 'gemini-3-pro',
              candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
            })
          }

          if (url.search !== '?alt=sse') {
            return Response.json({ error: { code: 400, message: 'Missing alt=sse' } }, { status: 400 })
          }

          const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
          const hasFunctionResponse = contents.some((turn) => turn.parts.some((p) => 'functionResponse' in p))

          const chunks = hasFunctionResponse
            ? [
                {
                  responseId: 'vtx-turn-2',
                  candidates: [{
                    content: {
                      role: 'model',
                      parts: [
                        { thought: true, text: 'Both user and tool images received cleanly.' },
                        { text: 'Verified Vertex multi-turn image + signature flow.' },
                      ],
                    },
                    finishReason: 'STOP',
                  }],
                  usageMetadata: {
                    promptTokenCount: 220,
                    cachedContentTokenCount: 40,
                    candidatesTokenCount: 18,
                    thoughtsTokenCount: 12,
                    totalTokenCount: 250,
                  },
                },
              ]
            : [
                {
                  responseId: 'vtx-turn-1',
                  candidates: [{
                    content: {
                      role: 'model',
                      parts: [
                        { thought: true, text: 'Need to inspect diagram.png first.' },
                        {
                          functionCall: { id: 'call_vtx_1', name: 'Read', args: { path: 'diagram.png' } },
                          thoughtSignature: 'vertex-sig-turn1',
                        },
                      ],
                    },
                    finishReason: 'STOP',
                  }],
                  usageMetadata: { promptTokenCount: 95, candidatesTokenCount: 20, thoughtsTokenCount: 15, totalTokenCount: 130 },
                },
              ]

          const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')
          return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
        }

        // 3) Vertex Anthropic Claude (`rawPredict` / `streamRawPredict`)
        if (url.pathname.startsWith('/v1/projects/demo-proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:')) {
          if (auth !== 'Bearer ya29.mock-vertex-oauth') {
            return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Missing Bearer' } }, { status: 401 })
          }
          if ('model' in body) {
            return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Vertex rawPredict forbids model field in body' } }, { status: 400 })
          }
          if (body.anthropic_version !== 'vertex-2023-10-16') {
            return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing anthropic_version vertex-2023-10-16' } }, { status: 400 })
          }

          if (url.pathname.endsWith(':rawPredict')) {
            return Response.json({
              id: 'msg_vertex_claude_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 14, output_tokens: 3 },
            })
          }

          const sse = [
            `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_vc_stream', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking Vertex Claude.' } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'vc-sig-1' } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Vertex Claude stream ok.' } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
          ].join('')
          return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
        }

        return Response.json({ error: { code: 404, message: `Unknown Vertex route: ${url.pathname}` } }, { status: 404 })
      },
    })

    try {
      const origin = `http://127.0.0.1:${vertexServer.port}`
      const vertexGeminiBase = `${origin}/v1/projects/demo-proj/locations/us-central1`

      // Model catalog discovery on Vertex AI
      const catalog = await fetchProviderModels({
        baseUrl: vertexGeminiBase,
        apiKey: 'ya29.mock-vertex-oauth',
        apiFormat: 'google_vertex',
      })
      expect(catalog.ok).toBe(true)
      if (catalog.ok) {
        expect(catalog.models.map((m) => m.id)).toEqual(['gemini-3-pro'])
      }

      // Save Vertex Gemini provider with Priority service tier
      const vertexProvider = await providerService.addProvider({
        presetId: 'custom',
        name: 'GCP Vertex Gemini',
        baseUrl: vertexGeminiBase,
        apiKey: 'ya29.mock-vertex-oauth',
        apiFormat: 'google_vertex',
        requestCompatibility: { serviceTier: 'priority' },
        models: { main: 'gemini-3-pro', haiku: 'gemini-3-pro', sonnet: 'gemini-3-pro', opus: 'gemini-3-pro' },
      })

      // Step 1 connectivity + Step 2 proxy pipeline test
      const testRes = await providerService.testProvider(vertexProvider.id)
      expect(testRes.connectivity.success).toBe(true)
      expect(testRes.proxy?.success).toBe(true)

      // Multi-turn streaming: Turn 1 (thinking + tool_use + signature)
      const proxyUrl = `http://127.0.0.1/proxy/providers/${vertexProvider.id}/v1/messages`
      const turn1Res = await handleProxyRequest(
        new Request(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-3-pro',
            max_tokens: 2048,
            stream: true,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'high' },
            tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
            messages: [{ role: 'user', content: 'Inspect diagram.png' }],
          }),
        }),
        new URL(proxyUrl),
      )
      expect(turn1Res.status).toBe(200)
      const turn1Events = await parseAnthropicSse(turn1Res)
      const redactedBlock = turn1Events.find(
        (e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>).type === 'redacted_thinking',
      )
      const redactedData = (redactedBlock?.data.content_block as Record<string, unknown>)?.data as string
      expect(redactedData).toContain('vertex-sig-turn1')

      // Verify Vertex priority PayGo headers reached the mock server
      const turn1Upstream = receivedCalls.at(-1)!
      expect(turn1Upstream.requestType).toBe('shared')
      expect(turn1Upstream.sharedType).toBe('priority')

      // Turn 2: replay thoughtSignature + nested PNG in tool_result + user PNG attachment
      const turn2Res = await handleProxyRequest(
        new Request(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-3-pro',
            max_tokens: 2048,
            stream: true,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'high' },
            tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
            messages: [
              { role: 'user', content: 'Inspect diagram.png' },
              {
                role: 'assistant',
                content: [
                  { type: 'thinking', thinking: 'Need to inspect diagram.png first.' },
                  { type: 'redacted_thinking', data: redactedData },
                  { type: 'tool_use', id: 'call_vtx_1', name: 'Read', input: { path: 'diagram.png' } },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_vtx_1',
                    content: [
                      { type: 'text', text: 'Loaded diagram.png' },
                      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_TOOL } },
                    ],
                  },
                  { type: 'text', text: 'Compare with my reference screenshot.' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_USER } },
                ],
              },
            ],
          }),
        }),
        new URL(proxyUrl),
      )
      expect(turn2Res.status).toBe(200)
      const turn2Events = await parseAnthropicSse(turn2Res)
      const turn2Text = turn2Events
        .filter((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).type === 'text_delta')
        .map((e) => (e.data.delta as Record<string, unknown>).text)
        .join('')
      expect(turn2Text).toBe('Verified Vertex multi-turn image + signature flow.')

      const turn2Upstream = receivedCalls.at(-1)!
      const contents = turn2Upstream.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
      expect(contents[1]!.parts.some((p) => p.thoughtSignature === 'vertex-sig-turn1' && 'functionCall' in p)).toBe(true)
      const fnResp = contents[2]!.parts[0]!.functionResponse as { parts?: Array<{ inlineData: { data: string } }> }
      expect(fnResp.parts?.[0]?.inlineData.data).toBe(TINY_PNG_TOOL)
      expect(contents[3]!.parts.some((p) => (p.inlineData as { data?: string } | undefined)?.data === TINY_PNG_USER)).toBe(true)

      // Vertex Express Mode (`x-goog-api-key`) works even with custom preset's default authStrategy: 'auth_token'
      const expressResult = await providerService.testProviderConfig({
        baseUrl: origin,
        apiKey: 'AQ.mock-vertex-express-key',
        authStrategy: 'auth_token',
        modelId: 'gemini-3-flash',
        apiFormat: 'google_vertex',
      })
      expect(expressResult.connectivity.success).toBe(true)
      expect(expressResult.proxy?.success).toBe(true)

      // Vertex Anthropic Claude (`rawPredict` + `streamRawPredict`) + trace header redaction & spoof stripping
      const vertexClaudeProvider = await providerService.addProvider({
        presetId: 'custom',
        name: 'GCP Vertex Claude',
        baseUrl: `${origin}/v1/projects/demo-proj/locations/us-east5`,
        apiKey: 'ya29.mock-vertex-oauth',
        apiFormat: 'google_vertex',
        requestCompatibility: { serviceTier: 'flex' },
        models: { main: 'claude-sonnet-4-6', haiku: 'claude-sonnet-4-6', sonnet: 'claude-sonnet-4-6', opus: 'claude-sonnet-4-6' },
      })
      const vcTest = await providerService.testProvider(vertexClaudeProvider.id)
      expect(vcTest.connectivity.success).toBe(true)
      expect(vcTest.proxy?.success).toBe(true)

      await updateTraceCaptureSettings({ enabled: true })
      const vcSessionId = 'vertex-claude-trace-session'
      const vcProxyUrl = `http://127.0.0.1/proxy/providers/${vertexClaudeProvider.id}/v1/messages`
      const vcStreamRes = await handleProxyRequest(
        new Request(vcProxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-code-session-id': vcSessionId,
            'x-goog-api-key': 'spoofed-client-key',
            'x-vertex-ai-llm-request-type': 'spoofed',
            'x-custom-secret': 'do-not-log-in-trace',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            stream: true,
            messages: [{ role: 'user', content: 'Ping Vertex Claude' }],
          }),
        }),
        new URL(vcProxyUrl),
      )
      expect(vcStreamRes.status).toBe(200)
      const vcEvents = await parseAnthropicSse(vcStreamRes)
      expect(vcEvents.some((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).text === 'Vertex Claude stream ok.')).toBe(true)
      expect(receivedCalls.at(-1)!.apiKeyHeader).toBeNull()
      expect(receivedCalls.at(-1)!.requestType).toBe('shared')
      expect(receivedCalls.at(-1)!.sharedType).toBe('flex')

      await drainTraceCaptureForTests()
      const traceOverview = await traceCaptureService.getSessionTraceOverview(vcSessionId)
      const lastCallId = traceOverview.calls.at(-1)?.id
      expect(lastCallId).toBeDefined()
      const traceCall = lastCallId ? await traceCaptureService.getSessionTraceCall(vcSessionId, lastCallId) : null
      expect(traceCall?.request.headers['x-custom-secret']).toBe('[redacted]')
      expect(traceCall?.request.headers['Authorization']).toBe('[redacted]')
      expect(traceCall?.request.headers['X-Vertex-AI-LLM-Shared-Request-Type']).toBe('flex')

      // Non-streaming Vertex Anthropic Claude (`rawPredict`) + upstream error trace capture
      const vcNonStreamRes = await handleProxyRequest(
        new Request(vcProxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': vcSessionId },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 256,
            stream: false,
            messages: [{ role: 'user', content: 'Non-stream Vertex Claude' }],
          }),
        }),
        new URL(vcProxyUrl),
      )
      expect(vcNonStreamRes.status).toBe(200)
      const vcNonStreamJson = await vcNonStreamRes.json() as { type: string; content: Array<{ text: string }> }
      expect(vcNonStreamJson.type).toBe('message')
      expect(vcNonStreamJson.content[0]?.text).toBe('ok')

      const vcErrRes = await handleProxyRequest(
        new Request(vcProxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': vcSessionId },
          body: JSON.stringify({
            model: 'claude-unknown-404',
            max_tokens: 128,
            stream: false,
            messages: [{ role: 'user', content: 'Trigger 404' }],
          }),
        }),
        new URL(vcProxyUrl),
      )
      expect(vcErrRes.status).toBe(404)
      await drainTraceCaptureForTests()
      await updateTraceCaptureSettings({ enabled: false })
    } finally {
      vertexServer.stop(true)
    }
  })

  test('AWS Bedrock Converse — cryptographic SigV4 + Bearer API key + binary EventStream + thinking/signature/redacted_thinking + tool_result images', async () => {
    const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE'
    const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const SESSION_TOKEN = 'FwoGZXIvYXdzEBYaDTESTSESSION'
    const BEARER_KEY = 'ABSKQmVkcm9ja01vY2tLZXk='
    const capturedBodies: Array<Record<string, unknown>> = []

    const bedrockServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        const rawBody = req.method === 'POST' ? await req.text() : ''
        const auth = req.headers.get('authorization') ?? ''

        // Authenticate via EITHER Bearer token OR strict cryptographic AWS SigV4
        if (auth === `Bearer ${BEARER_KEY}`) {
          // Valid Bedrock API key
        } else {
          const verified = verifyAwsSigV4Request({
            method: req.method,
            url,
            headers: req.headers,
            rawBody,
            expectedAccessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            expectedService: 'bedrock',
          })
          if (!verified.ok) {
            return Response.json({ message: `InvalidSignatureException: ${verified.reason}` }, { status: 403 })
          }
          if (req.headers.get('x-amz-security-token') !== SESSION_TOKEN) {
            return Response.json({ message: 'InvalidSessionToken' }, { status: 403 })
          }
        }

        // Control-plane foundation models list
        if (req.method === 'GET' && url.pathname === '/foundation-models') {
          return Response.json({
            modelSummaries: [
              { modelId: 'us.anthropic.claude-sonnet-4-6-v1:0', providerName: 'Anthropic' },
              { modelId: 'amazon.nova-pro-v1:0', providerName: 'Amazon' },
            ],
          })
        }

        const body = JSON.parse(rawBody) as Record<string, unknown>
        capturedBodies.push(body)

        // Official Bedrock Converse validation: minLength >= 1 on text blocks and maxTokens > thinking.budget_tokens
        const bodyMessages = Array.isArray(body.messages) ? body.messages as Array<{ content?: Array<Record<string, unknown>> }> : []
        for (const msg of bodyMessages) {
          for (const block of msg.content ?? []) {
            if (typeof block.text === 'string' && block.text.length === 0) {
              return Response.json({ message: 'ValidationException: text field must have minLength 1' }, { status: 400 })
            }
            const tr = block.toolResult as { content?: Array<Record<string, unknown>> } | undefined
            for (const sub of tr?.content ?? []) {
              if (typeof sub.text === 'string' && sub.text.length === 0) {
                return Response.json({ message: 'ValidationException: toolResult text must have minLength 1' }, { status: 400 })
              }
            }
          }
        }
        const additionalFields = body.additionalModelRequestFields as { thinking?: { type?: string; budget_tokens?: number } } | undefined
        const infCfg = body.inferenceConfig as { maxTokens?: number } | undefined
        if (additionalFields?.thinking?.type === 'enabled' && typeof additionalFields.thinking.budget_tokens === 'number') {
          if (typeof infCfg?.maxTokens !== 'number' || infCfg.maxTokens <= additionalFields.thinking.budget_tokens) {
            return Response.json({ message: 'ValidationException: max_tokens must be greater than thinking.budget_tokens' }, { status: 400 })
          }
        }

        // Non-streaming Converse
        if (url.pathname === '/model/us.anthropic.claude-sonnet-4-6-v1%3A0/converse') {
          return Response.json(
            {
              output: {
                message: {
                  role: 'assistant',
                  content: [{ text: 'ok' }],
                },
              },
              stopReason: 'end_turn',
              usage: { inputTokens: 15, outputTokens: 3, totalTokens: 18 },
            },
            { headers: { 'x-amzn-requestid': 'amzn-converse-1' } },
          )
        }

        // Streaming ConverseStream with REAL binary AWS EventStream encoding
        if (url.pathname === '/model/us.anthropic.claude-sonnet-4-6-v1%3A0/converse-stream') {
          const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
          const hasToolResult = messages.some((m) => m.content.some((b) => 'toolResult' in b))

          const frames = hasToolResult
            ? [
                encodeBedrockEventStreamFrame('messageStart', { role: 'assistant' }),
                encodeBedrockEventStreamFrame('contentBlockDelta', {
                  contentBlockIndex: 0,
                  delta: { text: 'Bedrock verified signed thinking, redacted content, and both PNG images.' },
                }),
                encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 0 }),
                encodeBedrockEventStreamFrame('messageStop', { stopReason: 'end_turn' }),
                encodeBedrockEventStreamFrame('metadata', {
                  usage: { inputTokens: 280, outputTokens: 24, cacheReadInputTokens: 64, cacheWriteInputTokens: 16 },
                }),
              ]
            : [
                encodeBedrockEventStreamFrame('messageStart', { role: 'assistant' }),
                encodeBedrockEventStreamFrame('contentBlockDelta', {
                  contentBlockIndex: 0,
                  delta: { reasoningContent: { text: 'Inspecting image via Read tool.' } },
                }),
                encodeBedrockEventStreamFrame('contentBlockDelta', {
                  contentBlockIndex: 0,
                  delta: { reasoningContent: { signature: 'bedrock-sig-turn1' } },
                }),
                encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 0 }),
                encodeBedrockEventStreamFrame('contentBlockDelta', {
                  contentBlockIndex: 1,
                  delta: { reasoningContent: { redactedContent: 'cmVkYWN0ZWQtYmVkcm9jaw==' } },
                }),
                encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 1 }),
                encodeBedrockEventStreamFrame('contentBlockStart', {
                  contentBlockIndex: 2,
                  start: { toolUse: { toolUseId: 'tooluse_bdrk_1', name: 'Read' } },
                }),
                encodeBedrockEventStreamFrame('contentBlockDelta', {
                  contentBlockIndex: 2,
                  delta: { toolUse: { input: '{"path":"chart.png"}' } },
                }),
                encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 2 }),
                encodeBedrockEventStreamFrame('messageStop', { stopReason: 'tool_use' }),
                encodeBedrockEventStreamFrame('metadata', {
                  usage: { inputTokens: 110, outputTokens: 32 },
                }),
              ]

          return new Response(concatBytes(frames), {
            headers: {
              'Content-Type': 'application/vnd.amazon.eventstream',
              'x-amzn-requestid': hasToolResult ? 'amzn-stream-2' : 'amzn-stream-1',
            },
          })
        }

        return Response.json({ message: `Unknown Bedrock path: ${url.pathname}` }, { status: 404 })
      },
    })

    try {
      const origin = `http://127.0.0.1:${bedrockServer.port}`
      const sigv4Credential = JSON.stringify({
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        sessionToken: SESSION_TOKEN,
        region: 'us-west-2',
      })

      // 1) Model discovery via SigV4 GET /foundation-models
      const catalog = await fetchProviderModels({
        baseUrl: origin,
        apiKey: sigv4Credential,
        apiFormat: 'bedrock_converse',
      })
      expect(catalog.ok).toBe(true)
      if (catalog.ok) {
        expect(catalog.models).toEqual([
          { id: 'amazon.nova-pro-v1:0', ownedBy: 'Amazon' },
          { id: 'us.anthropic.claude-sonnet-4-6-v1:0', ownedBy: 'Anthropic' },
        ])
      }

      // 2) Provider connectivity + proxy pipeline tests (both SigV4 and Bedrock Bearer API key)
      const sigv4Provider = await providerService.addProvider({
        presetId: 'custom',
        name: 'AWS Bedrock SigV4',
        baseUrl: origin,
        apiKey: sigv4Credential,
        apiFormat: 'bedrock_converse',
        requestCompatibility: { serviceTier: 'flex' },
        models: {
          main: 'us.anthropic.claude-sonnet-4-6-v1:0',
          haiku: 'us.anthropic.claude-sonnet-4-6-v1:0',
          sonnet: 'us.anthropic.claude-sonnet-4-6-v1:0',
          opus: 'us.anthropic.claude-sonnet-4-6-v1:0',
        },
      })
      const sigv4Test = await providerService.testProvider(sigv4Provider.id)
      expect(sigv4Test.connectivity.success).toBe(true)
      expect(sigv4Test.proxy?.success).toBe(true)

      const bearerTest = await providerService.testProviderConfig({
        baseUrl: origin,
        apiKey: BEARER_KEY,
        modelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
        apiFormat: 'bedrock_converse',
      })
      expect(bearerTest.connectivity.success).toBe(true)
      expect(bearerTest.proxy?.success).toBe(true)

      // 2b) Ambient AWS environment credentials (empty apiKey) across schema, /api/providers/models, and testProvider
      expect(TestProviderSchema.safeParse({
        baseUrl: origin,
        apiKey: '',
        modelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
        apiFormat: 'bedrock_converse',
      }).success).toBe(true)
      expect(TestProviderSchema.safeParse({
        baseUrl: origin,
        apiKey: '',
        modelId: 'gpt-4o',
        apiFormat: 'openai_chat',
      }).success).toBe(false)

      const previousAwsBearer = process.env.AWS_BEARER_TOKEN_BEDROCK
      process.env.AWS_BEARER_TOKEN_BEDROCK = BEARER_KEY
      try {
        const ambientProvider = await providerService.addProvider({
          presetId: 'custom',
          name: 'AWS Bedrock Ambient',
          baseUrl: origin,
          apiKey: '',
          apiFormat: 'bedrock_converse',
          models: {
            main: 'us.anthropic.claude-sonnet-4-6-v1:0',
            haiku: 'us.anthropic.claude-sonnet-4-6-v1:0',
            sonnet: 'us.anthropic.claude-sonnet-4-6-v1:0',
            opus: 'us.anthropic.claude-sonnet-4-6-v1:0',
          },
        })
        const ambientTest = await providerService.testProvider(ambientProvider.id)
        expect(ambientTest.connectivity.success).toBe(true)
        expect(ambientTest.proxy?.success).toBe(true)

        const modelsApiUrl = new URL('http://127.0.0.1/api/providers/models')
        const ambientModelsRes = await handleProvidersApi(
          new Request(modelsApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: origin, apiKey: '', apiFormat: 'bedrock_converse' }),
          }),
          modelsApiUrl,
          ['api', 'providers', 'models'],
        )
        expect(ambientModelsRes.status).toBe(200)
        const rejectedModelsRes = await handleProvidersApi(
          new Request(modelsApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: origin, apiKey: '', apiFormat: 'openai_chat' }),
          }),
          modelsApiUrl,
          ['api', 'providers', 'models'],
        )
        expect(rejectedModelsRes.status).toBe(400)
      } finally {
        if (previousAwsBearer === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK
        else process.env.AWS_BEARER_TOKEN_BEDROCK = previousAwsBearer
      }

      // 3) Multi-turn binary EventStream E2E with trace capture enabled, thinking, signature, redacted_thinking, tool_use, and images
      await updateTraceCaptureSettings({ enabled: true })
      const bedrockSessionId = 'bedrock-converse-trace-session'
      const proxyUrl = `http://127.0.0.1/proxy/providers/${sigv4Provider.id}/v1/messages`
      const turn1Res = await handleProxyRequest(
        new Request(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': bedrockSessionId },
          body: JSON.stringify({
            model: 'us.anthropic.claude-sonnet-4-6-v1:0',
            max_tokens: 4096,
            stream: true,
            thinking: { type: 'enabled', budget_tokens: 2048 },
            tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
            messages: [{ role: 'user', content: 'Read chart.png' }],
          }),
        }),
        new URL(proxyUrl),
      )
      expect(turn1Res.status).toBe(200)
      const turn1Events = await parseAnthropicSse(turn1Res)
      expect(turn1Events.some((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).signature === 'bedrock-sig-turn1')).toBe(true)
      expect(turn1Events.some((e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>).data === 'cmVkYWN0ZWQtYmVkcm9jaw==')).toBe(true)
      expect(turn1Events.some((e) => e.event === 'message_delta' && (e.data.delta as Record<string, unknown>).stop_reason === 'tool_use')).toBe(true)

      const turn1Sent = capturedBodies.at(-1)!
      expect(turn1Sent.serviceTier).toEqual({ type: 'flex' })
      expect(turn1Sent.additionalModelRequestFields).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } })

      // Turn 2: replay signed thinking + redacted_thinking + nested PNG tool_result + user PNG
      const turn2Res = await handleProxyRequest(
        new Request(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'us.anthropic.claude-sonnet-4-6-v1:0',
            max_tokens: 4096,
            stream: true,
            thinking: { type: 'enabled', budget_tokens: 2048 },
            tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
            messages: [
              { role: 'user', content: 'Read chart.png' },
              {
                role: 'assistant',
                content: [
                  { type: 'thinking', thinking: 'Inspecting image via Read tool.', signature: 'bedrock-sig-turn1' },
                  { type: 'redacted_thinking', data: 'cmVkYWN0ZWQtYmVkcm9jaw==' },
                  { type: 'tool_use', id: 'tooluse_bdrk_1', name: 'Read', input: { path: 'chart.png' } },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'tooluse_bdrk_1',
                    content: [
                      { type: 'text', text: 'chart.png loaded' },
                      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_TOOL } },
                    ],
                  },
                  { type: 'text', text: 'Compare with my image.' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_USER } },
                ],
              },
            ],
          }),
        }),
        new URL(proxyUrl),
      )
      expect(turn2Res.status).toBe(200)
      const turn2Events = await parseAnthropicSse(turn2Res)
      const finalText = turn2Events
        .filter((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).type === 'text_delta')
        .map((e) => (e.data.delta as Record<string, unknown>).text)
        .join('')
      expect(finalText).toBe('Bedrock verified signed thinking, redacted content, and both PNG images.')
      const finalDelta = turn2Events.find((e) => e.event === 'message_delta')
      expect(finalDelta?.data.usage).toEqual({
        input_tokens: 280,
        output_tokens: 24,
        cache_read_input_tokens: 64,
        cache_creation_input_tokens: 16,
      })

      // Assert exact Bedrock Converse wire shape replayed to mock server on Turn 2
      const turn2Sent = capturedBodies.at(-1)!
      const sentMsgs = turn2Sent.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
      expect(sentMsgs[1]!.content[0]).toEqual({
        reasoningContent: { reasoningText: { text: 'Inspecting image via Read tool.', signature: 'bedrock-sig-turn1' } },
      })
      expect(sentMsgs[1]!.content[1]).toEqual({
        reasoningContent: { redactedContent: 'cmVkYWN0ZWQtYmVkcm9jaw==' },
      })
      const toolResultBlock = sentMsgs[2]!.content[0]!.toolResult as { content: Array<Record<string, unknown>> }
      expect(toolResultBlock.content[1]).toEqual({ image: { format: 'png', source: { bytes: TINY_PNG_TOOL } } })
      expect(sentMsgs[2]!.content.some((c) => (c.image as { source?: { bytes?: string } } | undefined)?.source?.bytes === TINY_PNG_USER)).toBe(true)

      // Non-streaming Bedrock Converse + upstream 403 error path through proxy handler
      const nonStreamBedrockRes = await handleProxyRequest(
        new Request(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': bedrockSessionId },
          body: JSON.stringify({
            model: 'us.anthropic.claude-sonnet-4-6-v1:0',
            max_tokens: 256,
            stream: false,
            messages: [{ role: 'user', content: 'Non-stream Bedrock' }],
          }),
        }),
        new URL(proxyUrl),
      )
      expect(nonStreamBedrockRes.status).toBe(200)
      const nonStreamBedrockJson = await nonStreamBedrockRes.json() as { id: string; type: string; content: Array<{ text: string }> }
      expect(nonStreamBedrockJson.id).toBe('msg_amzn-converse-1')
      expect(nonStreamBedrockJson.content[0]?.text).toBe('ok')

      const badKeyBedrockProvider = await providerService.addProvider({
        presetId: 'custom',
        name: 'AWS Bedrock Bad Key',
        baseUrl: origin,
        apiKey: 'ABSKinvalid-key',
        apiFormat: 'bedrock_converse',
        models: {
          main: 'us.anthropic.claude-sonnet-4-6-v1:0',
          haiku: 'us.anthropic.claude-sonnet-4-6-v1:0',
          sonnet: 'us.anthropic.claude-sonnet-4-6-v1:0',
          opus: 'us.anthropic.claude-sonnet-4-6-v1:0',
        },
      })
      const badBedrockUrl = `http://127.0.0.1/proxy/providers/${badKeyBedrockProvider.id}/v1/messages`
      const badBedrockRes = await handleProxyRequest(
        new Request(badBedrockUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': bedrockSessionId },
          body: JSON.stringify({
            model: 'us.anthropic.claude-sonnet-4-6-v1:0',
            max_tokens: 128,
            stream: false,
            messages: [{ role: 'user', content: 'Trigger auth error' }],
          }),
        }),
        new URL(badBedrockUrl),
      )
      expect(badBedrockRes.status).toBe(403)
      await drainTraceCaptureForTests()
      await updateTraceCaptureSettings({ enabled: false })
    } finally {
      bedrockServer.stop(true)
    }
  })

  test('Microsoft Azure OpenAI / Azure AI Foundry — classic deployment + api-version + api-key + Foundry v1 Responses + Entra Bearer', async () => {
    const ENTRA_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJlbnRyYS11c2VyIn0.c2lnbmF0dXJl'
    const azureCalls: Array<{ path: string; apiVersion: string | null; apiKey: string | null; auth: string | null; body: Record<string, unknown> }> = []

    const azureServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        const apiKey = req.headers.get('api-key')
        const auth = req.headers.get('authorization')

        // Classic Azure models catalog
        if (req.method === 'GET' && url.pathname === '/openai/models' && url.searchParams.get('api-version') === '2024-10-21') {
          if (apiKey !== 'azure-prod-key') return Response.json({ error: { message: 'Invalid api-key' } }, { status: 401 })
          return Response.json({ data: [{ id: 'gpt-4o-prod', owned_by: 'azure' }] })
        }

        const body = await req.json() as Record<string, unknown>
        azureCalls.push({
          path: url.pathname,
          apiVersion: url.searchParams.get('api-version'),
          apiKey,
          auth,
          body,
        })

        // Classic Azure OpenAI deployment chat/completions — strictly requires `api-key` and `api-version`
        if (url.pathname === '/openai/deployments/gpt-4o-prod/chat/completions') {
          if (apiKey !== 'azure-prod-key' || auth !== null) {
            return Response.json({ error: { message: 'Azure deployment requires api-key header (not Bearer)' } }, { status: 401 })
          }
          if (url.searchParams.get('api-version') !== '2024-10-21') {
            return Response.json({ error: { message: 'Missing or invalid api-version' } }, { status: 400 })
          }

          if (!body.stream) {
            return Response.json({
              id: 'chatcmpl-azure-1',
              object: 'chat.completion',
              created: 1700000000,
              model: 'gpt-4o-prod',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
            })
          }

          const sse = [
            `data: ${JSON.stringify({ id: 'chatcmpl-az-s1', object: 'chat.completion.chunk', created: 1700000000, model: 'gpt-4o-prod', choices: [{ index: 0, delta: { role: 'assistant', content: 'Azure deployment verified with image.' }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: 'chatcmpl-az-s1', object: 'chat.completion.chunk', created: 1700000000, model: 'gpt-4o-prod', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 48, completion_tokens: 9, total_tokens: 57 } })}\n\n`,
            'data: [DONE]\n\n',
          ].join('')
          return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
        }

        // Modern Azure AI Foundry v1 Responses API with Entra ID Bearer token
        if (url.pathname === '/openai/v1/responses') {
          if (auth !== `Bearer ${ENTRA_JWT}`) {
            return Response.json({ error: { message: 'Expected Entra ID Bearer token' } }, { status: 401 })
          }
          const sse = [
            `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_az_1', status: 'in_progress', model: 'gpt-5-foundry' } })}\n\n`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Foundry v1 Responses ok.' })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_az_1', status: 'completed', model: 'gpt-5-foundry', usage: { input_tokens: 22, output_tokens: 6 } } })}\n\n`,
          ].join('')
          return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
        }

        return Response.json({ error: { message: `Unknown Azure path: ${url.pathname}${url.search}` } }, { status: 404 })
      },
    })

    try {
      const origin = `http://127.0.0.1:${azureServer.port}`
      const classicBaseUrl = `${origin}/openai/deployments/gpt-4o-prod?api-version=2024-10-21`

      // 1) Classic Azure model discovery
      const catalog = await fetchProviderModels({
        baseUrl: classicBaseUrl,
        apiKey: 'azure-prod-key',
        apiFormat: 'azure_openai',
      })
      expect(catalog.ok).toBe(true)
      if (catalog.ok) {
        expect(catalog.models).toEqual([{ id: 'gpt-4o-prod', ownedBy: 'azure' }])
      }

      // 2) Classic Azure deployment provider + Priority service tier (using custom preset's default authStrategy: 'auth_token'!)
      const azureProvider = await providerService.addProvider({
        presetId: 'custom',
        name: 'Azure OpenAI Classic',
        baseUrl: classicBaseUrl,
        apiKey: 'azure-prod-key',
        authStrategy: 'auth_token',
        apiFormat: 'azure_openai',
        requestCompatibility: { serviceTier: 'priority' },
        models: { main: 'gpt-4o-prod', haiku: 'gpt-4o-prod', sonnet: 'gpt-4o-prod', opus: 'gpt-4o-prod' },
      })

      const testRes = await providerService.testProvider(azureProvider.id)
      expect(testRes.connectivity.success).toBe(true)
      expect(testRes.proxy?.success).toBe(true)

      const proxyUrl = `http://127.0.0.1/proxy/providers/${azureProvider.id}/v1/messages`
      const streamRes = await handleProxyRequest(
        new Request(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-prod',
            max_tokens: 512,
            stream: true,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'What color is this pixel?' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_USER } },
                ],
              },
            ],
          }),
        }),
        new URL(proxyUrl),
      )
      expect(streamRes.status).toBe(200)
      const events = await parseAnthropicSse(streamRes)
      const text = events
        .filter((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).type === 'text_delta')
        .map((e) => (e.data.delta as Record<string, unknown>).text)
        .join('')
      expect(text).toBe('Azure deployment verified with image.')

      const sentCall = azureCalls.at(-1)!
      expect(sentCall.apiVersion).toBe('2024-10-21')
      expect(sentCall.apiKey).toBe('azure-prod-key')
      expect(sentCall.auth).toBeNull()
      expect(sentCall.body.service_tier).toBe('priority')

      // 3) Modern Azure AI Foundry v1 Responses API with Entra ID JWT Bearer token
      const foundryProvider = await providerService.addProvider({
        presetId: 'custom',
        name: 'Azure AI Foundry Responses',
        baseUrl: `${origin}/openai/v1`,
        apiKey: ENTRA_JWT,
        authStrategy: 'auth_token',
        apiFormat: 'openai_responses',
        models: { main: 'gpt-5-foundry', haiku: 'gpt-5-foundry', sonnet: 'gpt-5-foundry', opus: 'gpt-5-foundry' },
      })
      const foundryUrl = `http://127.0.0.1/proxy/providers/${foundryProvider.id}/v1/messages`
      const foundryRes = await handleProxyRequest(
        new Request(foundryUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5-foundry',
            max_tokens: 256,
            stream: true,
            messages: [{ role: 'user', content: 'Hello Foundry' }],
          }),
        }),
        new URL(foundryUrl),
      )
      expect(foundryRes.status).toBe(200)
      const foundryEvents = await parseAnthropicSse(foundryRes)
      const foundryText = foundryEvents
        .filter((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).type === 'text_delta')
        .map((e) => (e.data.delta as Record<string, unknown>).text)
        .join('')
      expect(foundryText).toBe('Foundry v1 Responses ok.')
    } finally {
      azureServer.stop(true)
    }
  })
})
