import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SavedProvider } from '../types/provider.js'
import { ProviderService } from './providerService.js'
import {
  classifyProviderStatus,
  providerTextCompletion,
  stripThinkBlocks,
} from './providerTextCompletion.js'
import { drainTraceCaptureForTests } from './traceCaptureService.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalFetch: typeof globalThis.fetch
const servers: Array<{ stop: (force?: boolean) => void }> = []

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalFetch = globalThis.fetch
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-text-completion-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  await fs.mkdir(path.join(tmpDir, 'cc-haha', 'traces'), { recursive: true })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const server of servers.splice(0)) server.stop(true)
  await drainTraceCaptureForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function provider(baseUrl: string, overrides: Partial<SavedProvider> = {}): SavedProvider {
  return {
    id: 'fixture-provider',
    presetId: 'custom',
    name: 'Fixture',
    apiKey: 'fake-key',
    baseUrl,
    apiFormat: 'anthropic',
    runtimeKind: 'anthropic_compatible',
    models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
    ...overrides,
  } as SavedProvider
}

/** Loopback Anthropic Messages endpoint answering with `respond`, recording request bodies. */
function upstream(respond: (body: Record<string, unknown>, index: number) => Response | Promise<Response>) {
  const bodies: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = await req.json() as Record<string, unknown>
      bodies.push(body)
      return respond(body, bodies.length - 1)
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, bodies }
}

const reply = (text: string) => Response.json({ content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text }] })
const request = (target: SavedProvider, extra: Partial<Parameters<typeof providerTextCompletion>[0]> = {}) =>
  providerTextCompletion({ provider: target, modelId: 'fast-model[1m]', system: 'SYSTEM', user: 'USER', maxTokens: 64, ...extra })

describe('providerTextCompletion', () => {
  test('sends one system + user message with thinking disabled and returns the text without think blocks', async () => {
    const server = upstream(() => reply('<think>reasoning</think>Corrected text'))

    expect(await request(provider(server.url))).toEqual({ ok: true, text: 'Corrected text' })
    expect(server.bodies).toEqual([{
      model: 'fast-model',
      max_tokens: 64,
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'USER' }],
      thinking: { type: 'disabled' },
    }])
  })

  test.each([400, 422])('retries once without thinking when the provider rejects the request with %i', async (status) => {
    const server = upstream((body) => body.thinking
      ? Response.json({ error: 'thinking unsupported' }, { status })
      : reply('ok'))

    expect(await request(provider(server.url))).toEqual({ ok: true, text: 'ok' })
    expect(server.bodies.map(body => body.thinking)).toEqual([{ type: 'disabled' }, undefined])
  })

  test('answers a rate limit as is instead of resending with thinking back on', async () => {
    // DeepSeek Flash thinks by default: without `thinking: disabled` it spends the
    // whole budget reasoning and returns no text, which callers read as a bad answer.
    const server = upstream((body) => body.thinking
      ? Response.json({ error: { message: 'Rate limit reached' } }, { status: 429 })
      : Response.json({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: 'still reasoning' }] }))

    expect(await request(provider(server.url))).toEqual({
      ok: false,
      reason: 'rate-limit',
      status: 429,
      message: 'The provider answered HTTP 429',
    })
    expect(server.bodies.map(body => body.thinking)).toEqual([{ type: 'disabled' }])
  })

  test('sends a requested temperature with the first attempt and drops it with thinking on the retry', async () => {
    const server = upstream((body) => body.thinking
      ? Response.json({ error: 'temperature not allowed here' }, { status: 400 })
      : reply('ok'))

    expect(await request(provider(server.url), { temperature: 0 })).toEqual({ ok: true, text: 'ok' })
    expect(server.bodies.map(body => [body.thinking, body.temperature])).toEqual([
      [{ type: 'disabled' }, 0],
      [undefined, undefined],
    ])
  })

  test('omits temperature unless the caller asks for one', async () => {
    const server = upstream(() => reply('ok'))

    await request(provider(server.url))
    expect('temperature' in server.bodies[0]!).toBe(false)
  })

  test.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate-limit'],
    [404, 'upstream'],
    [500, 'upstream'],
    [529, 'upstream'],
  ] as const)('classifies HTTP %i as %s', async (status, reason) => {
    const server = upstream(() => Response.json({ error: 'nope' }, { status }))

    expect(await request(provider(server.url))).toMatchObject({ ok: false, reason, status })
    // Only a rejected request (400/422) earns the retry without thinking.
    expect(server.bodies).toHaveLength(1)
    expect(classifyProviderStatus(status)).toBe(reason)
  })

  test('reports a missing key as auth without sending anything', async () => {
    const server = upstream(() => reply('never'))
    expect(await request(provider(server.url, { apiKey: '' }))).toMatchObject({ ok: false, reason: 'auth' })
    expect(server.bodies).toEqual([])
  })

  test('ends with timeout when the whole call outlives timeoutMs, and aborted when the caller cancels', async () => {
    const server = upstream(() => new Promise<Response>(resolve => setTimeout(() => resolve(reply('late')), 2_000)))

    const started = performance.now()
    expect(await request(provider(server.url), { timeoutMs: 100 })).toMatchObject({ ok: false, reason: 'timeout' })
    expect(performance.now() - started).toBeLessThan(1_500)

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    expect(await request(provider(server.url), { signal: controller.signal, timeoutMs: 5_000 }))
      .toMatchObject({ ok: false, reason: 'aborted' })
    expect(await request(provider(server.url), { signal: AbortSignal.abort() }))
      .toMatchObject({ ok: false, reason: 'aborted' })
  })

  test('a network failure is upstream', async () => {
    const server = upstream(() => reply('unused'))
    const url = server.url
    servers.splice(0).forEach(item => item.stop(true))
    expect(await request(provider(url))).toMatchObject({ ok: false, reason: 'upstream' })
  })

  test('applies the hard timeout to providers routed through the local proxy too', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const proxied = await new ProviderService().addProvider({
      presetId: 'opencode-go',
      name: 'Proxied',
      apiKey: 'fake-key',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'openai_chat',
      models: { main: 'glm-5.3', haiku: 'glm-5.3-flash', sonnet: 'glm-5.3', opus: 'glm-5.3' },
    })

    expect(await providerTextCompletion({
      provider: proxied,
      modelId: 'glm-5.3-flash',
      system: 'SYSTEM',
      user: 'USER',
      maxTokens: 64,
      timeoutMs: 100,
    })).toMatchObject({ ok: false, reason: 'timeout' })
    expect(calls).toBeGreaterThan(0)
  })

  test.each([
    [400, { ok: true, text: 'ok' }, 2],
    [429, { ok: false, reason: 'rate-limit', status: 429 }, 1],
  ] as const)('through the local proxy, HTTP %i from the upstream ends as %o after %i request(s)', async (status, expected, requests) => {
    const sent: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (sent.length === 1) return Response.json({ error: { message: 'rejected' } }, { status })
      return Response.json({
        id: 'chatcmpl-fixture',
        object: 'chat.completion',
        model: 'fast-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }) as unknown as typeof fetch
    const proxied = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Proxied chat',
      apiKey: 'fake-key',
      baseUrl: 'https://chat.fixture.invalid/v1',
      apiFormat: 'openai_chat',
      models: { main: 'fast-model', haiku: 'fast-model', sonnet: 'fast-model', opus: 'fast-model' },
    })

    expect(await providerTextCompletion({
      provider: proxied, modelId: 'fast-model', system: 'SYSTEM', user: 'USER', maxTokens: 64, reasoningEffort: 'low',
    })).toMatchObject(expected)
    expect(sent).toHaveLength(requests)
    // The retry goes out without the first attempt's extras.
    expect(sent.map(body => body.reasoning_effort)).toEqual(['low', undefined].slice(0, requests))
  })

  test('asks proxied OpenAI-format models for low reasoning only when requested', async () => {
    // `thinking: disabled` alone maps to no reasoning setting on OpenAI-format
    // upstreams, which leaves a reasoning model at its default effort.
    const sent: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        id: 'chatcmpl-fixture',
        object: 'chat.completion',
        model: 'fast-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }) as unknown as typeof fetch
    const proxied = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Proxied chat',
      apiKey: 'fake-key',
      baseUrl: 'https://chat.fixture.invalid/v1',
      apiFormat: 'openai_chat',
      models: { main: 'fast-model', haiku: 'fast-model', sonnet: 'fast-model', opus: 'fast-model' },
    })
    const ask = (extra: Partial<Parameters<typeof providerTextCompletion>[0]>) => providerTextCompletion({
      provider: proxied, modelId: 'fast-model', system: 'SYSTEM', user: 'USER', maxTokens: 64, ...extra,
    })

    expect(await ask({ reasoningEffort: 'low' })).toEqual({ ok: true, text: 'ok' })
    expect(sent[0]?.reasoning_effort).toBe('low')
    expect(await ask({})).toEqual({ ok: true, text: 'ok' })
    expect('reasoning_effort' in sent[1]!).toBe(false)
  })

  test('never sends output_config to a direct Anthropic-format endpoint', async () => {
    const server = upstream(() => reply('ok'))

    await request(provider(server.url), { reasoningEffort: 'low' })
    expect('output_config' in server.bodies[0]!).toBe(false)
  })

  test('strips closed and unterminated think blocks', () => {
    expect(stripThinkBlocks('<think>a</think>keep<THINK>b</THINK> this')).toBe('keep this')
    expect(stripThinkBlocks('answer<think>cut off')).toBe('answer')
  })
})
