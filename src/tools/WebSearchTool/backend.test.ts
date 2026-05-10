import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resetSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  __testing,
  getExternalFallbackProviders,
  getFallbackProvidersAfter,
  isLikelyClaudeModel,
  isWebSearchEnabledForModel,
  resolveWebSearchProvider,
  searchWithExternalProvider,
  shouldFallbackFromNativeError,
} from './backend.js'
import { WebSearchTool } from './WebSearchTool.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetSettingsCache()
})

describe('WebSearch backend resolver', () => {
  test('detects Claude models by model name instead of provider URL', () => {
    expect(isLikelyClaudeModel('claude-sonnet-4-5')).toBe(true)
    expect(isLikelyClaudeModel('anthropic/claude-3-7-sonnet')).toBe(true)
    expect(isLikelyClaudeModel('anthropic.claude-opus-4-1')).toBe(true)
    expect(isLikelyClaudeModel('MiniMax-M2.7-highspeed')).toBe(false)
  })

  test('auto mode prefers native Anthropic web search for Claude model names', () => {
    expect(
      resolveWebSearchProvider('anthropic/claude-3-7-sonnet', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('anthropic')
  })

  test('auto mode keeps WebSearch available for non-Claude models with fallback keys', () => {
    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('tavily')

    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('brave')

    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
      }).provider,
    ).toBe('duckduckgo')
  })

  test('auto mode falls back through Tavily, Brave, and DuckDuckGo', () => {
    const settings = {
      mode: 'auto' as const,
      tavilyApiKey: 'tvly-key',
      braveApiKey: 'brave-key',
    }

    expect(getExternalFallbackProviders(settings)).toEqual([
      'tavily',
      'brave',
      'duckduckgo',
    ])
    expect(getFallbackProvidersAfter('tavily', settings)).toEqual([
      'brave',
      'duckduckgo',
    ])
    expect(getFallbackProvidersAfter('brave', settings)).toEqual(['duckduckgo'])
  })

  test('explicit provider modes require their API key', () => {
    expect(resolveWebSearchProvider('gpt-5.4', { mode: 'tavily' }).provider).toBe(
      'disabled',
    )
    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'brave',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('brave')
  })

  test('explicit DuckDuckGo mode enables keyless managed search', () => {
    expect(resolveWebSearchProvider('gpt-5.4', { mode: 'duckduckgo' }).provider).toBe(
      'duckduckgo',
    )
    expect(isWebSearchEnabledForModel('qwen3-coder', { mode: 'duckduckgo' })).toBe(
      true,
    )
  })

  test('isEnabled reflects native Claude or external fallback availability', () => {
    expect(isWebSearchEnabledForModel('claude-sonnet-4-5', { mode: 'auto' })).toBe(
      true,
    )
    expect(
      isWebSearchEnabledForModel('qwen3-coder', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
      }),
    ).toBe(true)
    expect(isWebSearchEnabledForModel('qwen3-coder', { mode: 'auto' })).toBe(true)
  })

  test('falls back on native tool schema/provider mismatch errors', () => {
    expect(
      shouldFallbackFromNativeError(
        new Error('422 Extra inputs are not permitted: web_search_20250305'),
      ),
    ).toBe(true)
    expect(shouldFallbackFromNativeError(new Error('network timeout'))).toBe(
      false,
    )
  })
})

describe('DuckDuckGo keyless WebSearch provider', () => {
  test('parses DuckDuckGo HTML results and preserves domain filters in the query', async () => {
    let requestedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      requestedUrl = String(url)
      return new Response(
        `
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example &amp; Title</a>
          <a class="result__snippet">First <b>snippet</b> &hellip;</a>
          <a class="result__a" href="https://example.org/b">Second result</a>
          <div class="result__snippet">Second snippet</div>
        `,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      )
    }) as typeof fetch

    const data = await searchWithExternalProvider(
      'duckduckgo',
      {
        query: 'OpenClaw plugin SDK',
        allowed_domains: ['example.com'],
        blocked_domains: ['bad.example'],
      },
      null,
      new AbortController().signal,
    )

    const query = new URL(requestedUrl).searchParams.get('q')
    expect(query).toBe('(site:example.com) -site:bad.example OpenClaw plugin SDK')
    expect(data.results[0]).toBe('Search provider: duckduckgo')
    expect(data.results[1]).toEqual({
      tool_use_id: 'duckduckgo-web-search',
      content: [
        {
          title: 'Example & Title',
          url: 'https://example.com/a?x=1',
          snippet: 'First snippet ...',
        },
        {
          title: 'Second result',
          url: 'https://example.org/b',
          snippet: 'Second snippet',
        },
      ],
    })
  })

  test('detects DuckDuckGo bot challenge pages', () => {
    expect(__testing.isDuckDuckGoBotChallenge('<form id="challenge-form"></form>')).toBe(
      true,
    )
    expect(
      __testing.isDuckDuckGoBotChallenge('<a class="result__a" href="https://x.test">x</a>'),
    ).toBe(false)
  })
})

describe('WebSearch auto fallback execution', () => {
  test('falls back from a failing Tavily key to DuckDuckGo in auto mode', async () => {
    const requestedUrls: string[] = []
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      requestedUrls.push(String(url))

      if (String(url).includes('api.tavily.com')) {
        return new Response('bad key', { status: 401 })
      }

      return new Response(
        `
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbbs.kanxue.com%2Fthread%2D291016.htm&amp;rut=abc">Kanxue Hermes</a>
          <a class="result__snippet">Hermes 自动化能力验证</a>
        `,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      )
    }) as typeof fetch

    setSessionSettingsCache({
      settings: {
        webSearch: {
          mode: 'auto',
          tavilyApiKey: 'bad-tvly-key',
        },
      },
      errors: [],
    })

    const progress: unknown[] = []
    const result = await WebSearchTool.call(
      { query: 'kanxue hermes' },
      {
        abortController: new AbortController(),
        options: { mainLoopModel: 'gpt-5.4' },
      } as never,
      async () => ({ behavior: 'allow' }) as never,
      {} as never,
      event => progress.push(event),
    )

    expect(requestedUrls.some(url => url.includes('api.tavily.com'))).toBe(true)
    expect(requestedUrls.some(url => url.includes('html.duckduckgo.com'))).toBe(
      true,
    )
    expect(result.data.results[0]).toBe('Search provider: duckduckgo')
    expect(progress).toEqual(
      expect.arrayContaining([
        {
          toolUseID: 'tavily-web-search',
          data: { type: 'query_update', query: 'kanxue hermes' },
        },
        {
          toolUseID: 'duckduckgo-web-search',
          data: { type: 'query_update', query: 'kanxue hermes' },
        },
      ]),
    )
  })
})
