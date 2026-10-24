import { afterEach, expect, spyOn, test } from 'bun:test'
import { SettingsSchema } from '../../utils/settings/types.js'
import {
  getConfiguredWebSearchSettings,
  getFallbackProvider,
  getApiKeyForProvider,
  resolveWebSearchProvider,
  searchWithExternalProvider,
} from './backend.js'

let fetchMock: ReturnType<typeof spyOn> | undefined
afterEach(() => fetchMock?.mockRestore())

function respond(body: unknown, status = 200) {
  fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body, { status }))
}

const signal = () => new AbortController().signal

test('old WebSearch settings migrate additively without changing provider or keys', () => {
  const fixture = { webSearch: { mode: 'auto' as const, tavilyApiKey: 'old-key', braveApiKey: 'old-brave' } }
  const normalized = getConfiguredWebSearchSettings(fixture)
  expect(normalized).toEqual({ ...fixture.webSearch, deepseekApiKey: undefined })
  expect(resolveWebSearchProvider('other-model', normalized).provider).toBe('tavily')
  expect(getConfiguredWebSearchSettings({}).deepseekApiKey).toBeUndefined()
  expect(getConfiguredWebSearchSettings({ webSearch: { mode: 'deepseek', deepseekApiKey: ' fake-key ' } }).deepseekApiKey).toBe('fake-key')
})

test('explicit DeepSeek requires its own key and auto preserves existing fallback priority', () => {
  expect(resolveWebSearchProvider('other-model', { mode: 'deepseek' }).provider).toBe('disabled')
  const settings = { deepseekApiKey: 'fake-key' }
  expect(resolveWebSearchProvider('other-model', settings).provider).toBe('deepseek')
  expect(resolveWebSearchProvider('claude-sonnet-4-5', settings).provider).toBe('anthropic')
  expect(resolveWebSearchProvider('other-model', { ...settings, braveApiKey: 'fake-brave' }).provider).toBe('brave')
  expect(resolveWebSearchProvider('claude-sonnet-4-5', { ...settings, mode: 'deepseek' }).provider).toBe('deepseek')
  expect(getFallbackProvider(settings)).toBe('deepseek')
  expect(getApiKeyForProvider('deepseek', settings)).toBe('fake-key')
})

test('standalone search uses official endpoint and keeps model summaries with domain filters', async () => {
  respond({ results: [
    { title: 'Source', url: 'https://example.com/article', summary: 'Evidence for the model', snippet: 'Short display text' },
    { title: 'Fallback', url: 'https://example.com/fallback', snippet: 'Fallback summary' },
    { title: 'Unsafe', url: 'javascript:alert(1)' },
    null,
  ] })
  const output = await searchWithExternalProvider('deepseek', {
    query: 'fixture', allowed_domains: ['example.com'], blocked_domains: ['bad.example'],
  }, 'fake-key', signal())
  const [url, init] = fetchMock!.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.deepseek.com/v1/tools/search')
  expect(init.headers).toEqual({ Authorization: 'Bearer fake-key', 'Content-Type': 'application/json' })
  expect(JSON.parse(init.body as string)).toEqual({ query: '(site:example.com) -site:bad.example fixture', count: 8, need_content: false })
  expect(output.results[1]).toEqual({ tool_use_id: 'deepseek-web-search', content: [
    { title: 'Source', url: 'https://example.com/article', summary: 'Evidence for the model' },
    { title: 'Fallback', url: 'https://example.com/fallback', summary: 'Fallback summary' },
  ] })
})

test('empty results are successful, invalid payloads are not mistaken for no results', async () => {
  respond({ results: [] })
  expect((await searchWithExternalProvider('deepseek', { query: 'fixture' }, 'fake', signal())).results[1]).toEqual({ tool_use_id: 'deepseek-web-search', content: [] })
  fetchMock!.mockResolvedValueOnce(Response.json({ error: 'bad shape' }))
  await expect(searchWithExternalProvider('deepseek', { query: 'fixture' }, 'fake', signal())).rejects.toThrow('invalid results payload')
})

test('query limit counts Unicode code points and filters and rejects before sending', async () => {
  respond({ results: [] })
  await searchWithExternalProvider('deepseek', { query: '😀'.repeat(128) }, 'fake', signal())
  await expect(searchWithExternalProvider('deepseek', { query: '😀'.repeat(129) }, 'fake', signal())).rejects.toThrow('1–128')
  await expect(searchWithExternalProvider('deepseek', { query: 'x'.repeat(128), allowed_domains: ['example.com'] }, 'fake', signal())).rejects.toThrow('1–128')
  await expect(searchWithExternalProvider('deepseek', { query: '  ' }, 'fake', signal())).rejects.toThrow('1–128')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

for (const [status, reason] of [[401, 'invalid API key'], [402, 'insufficient balance'], [429, 'rate limit'], [500, 'request failed']] as const) {
  test(`reports HTTP ${status} without leaking upstream bodies or retrying`, async () => {
    respond({ error: 'secret-credential-echo' }, status)
    await expect(searchWithExternalProvider('deepseek', { query: 'fixture' }, 'fake', signal())).rejects.toThrow(reason)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
}

test('propagates cancellation to the HTTP request', async () => {
  fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    init!.signal!.throwIfAborted()
    return Response.json({ results: [] })
  })
  const controller = new AbortController()
  controller.abort(new Error('fixture cancelled'))
  await expect(searchWithExternalProvider('deepseek', { query: 'fixture' }, 'fake', controller.signal)).rejects.toThrow('fixture cancelled')
})

test('settings schema accepts standalone DeepSeek and old provider settings', () => {
  const legacy = { webSearch: { mode: 'brave', braveApiKey: 'old-key' } }
  expect(SettingsSchema().parse(legacy).webSearch).toEqual(legacy.webSearch)
  const current = { webSearch: { mode: 'deepseek', deepseekApiKey: 'fake-key' } }
  expect(SettingsSchema().parse(current).webSearch).toEqual(current.webSearch)
})
