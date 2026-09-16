import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { handleProxyRequest } from './handler.js'
import { OUTPUT_BUDGET_SOURCE_HEADER } from '../../services/api/outputBudget.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

describe('saved provider request compatibility reaches the upstream wire', () => {
  let fixture: string
  let previous: string | undefined
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'handler-compatibility-'))
    previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = fixture
    resetSettingsCache()
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    resetSettingsCache()
    await rm(fixture, { recursive: true, force: true })
  })

  for (const apiFormat of ['openai_chat', 'openai_responses'] as const) {
    test(`${apiFormat} applies provider default, preserves an explicit small budget, and consumes its local header`, async () => {
      const provider = await new ProviderService().addProvider({
        presetId: 'custom', name: 'Fixture', baseUrl: 'https://fixture.invalid', apiKey: 'fake-key', apiFormat,
        models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
        requestCompatibility: { maxOutputTokens: 96_000, outputTokenLimit: 64_000, outputTokenField: 'max_completion_tokens' },
      })
      const calls: Array<{ body: Record<string, unknown>; headers: Headers }> = []
      const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        calls.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })
        return apiFormat === 'openai_chat'
          ? Response.json({ id: 'fixture', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
          : Response.json({ id: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] })
      })
      try {
        for (const source of ['default', 'explicit', undefined]) {
          const headers = new Headers({ 'Content-Type': 'application/json' })
          if (source) headers.set(OUTPUT_BUDGET_SOURCE_HEADER, source)
          const req = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
            method: 'POST', headers, body: JSON.stringify({ model: 'fixture', max_tokens: 64, messages: [{ role: 'user', content: 'fixture' }] }),
          })
          expect((await handleProxyRequest(req, new URL(req.url))).status).toBe(200)
        }
        const field = apiFormat === 'openai_chat' ? 'max_completion_tokens' : 'max_output_tokens'
        expect(calls.map(call => call.body[field])).toEqual([64_000, 64, 64])
        expect(calls.every(call => !call.headers.has(OUTPUT_BUDGET_SOURCE_HEADER))).toBe(true)
      } finally {
        fetchMock.mockRestore()
      }
    })
  }

  test('an impossible explicit constraint fails before any upstream request', async () => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Fixture', baseUrl: 'https://fixture.invalid', apiKey: 'fake-key', apiFormat: 'openai_chat',
      models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
      requestCompatibility: { outputTokenField: 'omit' },
    })
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('must not call upstream') })
    try {
      const req = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST', body: JSON.stringify({ model: 'fixture', max_tokens: 64, messages: [{ role: 'user', content: 'fixture' }] }),
      })
      const response = await handleProxyRequest(req, new URL(req.url))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error' } })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
    }
  })
})
