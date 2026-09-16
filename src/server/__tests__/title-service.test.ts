import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { OPENAI_CODEX_API_ENDPOINT } from '../../services/openaiAuth/client.js'
import { ProviderService } from '../services/providerService.js'
import {
  deriveTitle,
  generateTitle,
  parseGeneratedTitleText,
  resolveTitleLanguagePreference,
  saveAiTitle,
} from '../services/titleService.js'
import { sessionService } from '../services/sessionService.js'
import { hahaOpenAIOAuthService } from '../services/hahaOpenAIOAuthService.js'
import { SYSTEM_PROXY_URL_ENV } from '../services/networkSettings.js'

describe('titleService', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalSystemProxyUrl: string | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalSystemProxyUrl = process.env[SYSTEM_PROXY_URL_ENV]
    originalFetch = globalThis.fetch
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'title-service-test-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    hahaOpenAIOAuthService.dispose()
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnv(SYSTEM_PROXY_URL_ENV, originalSystemProxyUrl)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('generates titles with a versioned Anthropic base URL (#1279)', async () => {
    const paths: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const requestPath = new URL(req.url).pathname
        paths.push(requestPath)
        if (requestPath !== '/anthropic/v1/messages') {
          return Response.json({ error: 'Unknown endpoint' }, { status: 404 })
        }
        return Response.json({ content: [{ type: 'text', text: '{"title":"Endpoint compatibility"}' }] })
      },
    })
    try {
      const provider = await new ProviderService().addProvider({
        presetId: 'custom', name: 'Versioned Anthropic', apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${server.port}/anthropic/v1/`, apiFormat: 'anthropic',
        models: { main: 'test-model', haiku: 'test-model', sonnet: 'test-model', opus: 'test-model' },
      })
      expect(await generateTitle('Explain endpoint compatibility', provider.id)).toBe('Endpoint compatibility')
      expect(paths).toEqual(['/anthropic/v1/messages'])
    } finally {
      server.stop(true)
    }
  })

  test('sends disabled thinking for title generation by default', async () => {
    let requestBody: Record<string, unknown> | null = null
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        requestBody = await req.json() as Record<string, unknown>
        return Response.json({
          content: [{ type: 'text', text: '{"title":"Trace ok"}' }],
        })
      },
    })

    try {
      const providerId = 'zhipu-test'
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'providers.json'),
        JSON.stringify({
          activeId: providerId,
          providers: [
            {
              id: providerId,
              presetId: 'zhipuglm',
              name: 'Zhipu GLM',
              apiKey: 'test-key',
              baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
              apiFormat: 'anthropic',
              models: {
                main: 'glm-5.1',
                haiku: 'glm-4.5-air',
                sonnet: 'glm-5-turbo',
                opus: 'glm-5.1',
              },
            },
          ],
        }, null, 2),
      )

      await expect(generateTitle('请只回复 trace-ok')).resolves.toBe('Trace ok')
      expect(requestBody?.thinking).toEqual({ type: 'disabled' })
    } finally {
      server.stop(true)
    }
  })

  test('retries title generation without thinking when the provider rejects it', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const requestBody = await req.json() as Record<string, unknown>
        requestBodies.push(requestBody)
        if (requestBody.thinking) {
          return Response.json({ error: 'thinking is not supported' }, { status: 400 })
        }
        return Response.json({
          content: [{ type: 'text', text: '{"title":"Trace ok"}' }],
        })
      },
    })

    try {
      const providerId = 'fallback-thinking-test'
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'providers.json'),
        JSON.stringify({
          activeId: providerId,
          providers: [
            {
              id: providerId,
              presetId: 'custom',
              name: 'Thinking Fallback',
              apiKey: 'test-key',
              baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
              apiFormat: 'anthropic',
              models: {
                main: 'fallback-main',
                haiku: 'fallback-haiku',
                sonnet: 'fallback-main',
                opus: 'fallback-main',
              },
            },
          ],
        }, null, 2),
      )

      await expect(generateTitle('请只回复 trace-ok')).resolves.toBe('Trace ok')
      expect(requestBodies).toHaveLength(2)
      expect(requestBodies[0].thinking).toEqual({ type: 'disabled' })
      expect(requestBodies[1].thinking).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })

  test('sends disabled thinking for DeepSeek title generation', async () => {
    let requestBody: Record<string, unknown> | null = null
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        requestBody = await req.json() as Record<string, unknown>
        return Response.json({
          content: [{ type: 'text', text: '{"title":"Trace ok"}' }],
        })
      },
    })

    try {
      const providerId = 'deepseek-test'
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'providers.json'),
        JSON.stringify({
          activeId: providerId,
          providers: [
            {
              id: providerId,
              presetId: 'deepseek',
              name: 'DeepSeek',
              apiKey: 'test-key',
              baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
              apiFormat: 'anthropic',
              models: {
                main: 'deepseek-v4-pro',
                haiku: 'deepseek-v4-pro',
                sonnet: 'deepseek-v4-pro',
                opus: 'deepseek-v4-pro',
              },
            },
          ],
        }, null, 2),
      )

      await expect(generateTitle('请只回复 trace-ok')).resolves.toBe('Trace ok')
      expect(requestBody?.thinking).toEqual({ type: 'disabled' })
    } finally {
      server.stop(true)
    }
  })

  test('derives slash-command titles from command metadata without raw XML tags', () => {
    const raw = [
      '<command-message>frontend-design</command-message>',
      '<command-name>/frontend-design</command-name>',
      '<command-args>@website 重新设计首页</command-args>',
    ].join('\n')

    expect(deriveTitle(raw)).toBe('/frontend-design @website 重新设计首页')
  })

  test('sends cleaned slash-command text to the title model', async () => {
    let requestBody: {
      messages?: Array<{ content?: string }>
    } | null = null
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        requestBody = await req.json() as {
          messages?: Array<{ content?: string }>
        }
        return Response.json({
          content: [{ type: 'text', text: '{"title":"Redesign website"}' }],
        })
      },
    })

    try {
      const providerId = 'title-clean-test'
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'providers.json'),
        JSON.stringify({
          activeId: providerId,
          providers: [
            {
              id: providerId,
              presetId: 'anthropic',
              name: 'Anthropic',
              apiKey: 'test-key',
              baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
              apiFormat: 'anthropic',
              models: {
                main: 'claude-sonnet-4-7',
                haiku: 'claude-haiku-4-5',
                sonnet: 'claude-sonnet-4-7',
                opus: 'claude-opus-4-7',
              },
            },
          ],
        }, null, 2),
      )

      await expect(generateTitle([
        '<command-message>frontend-design</command-message>',
        '<command-name>/frontend-design</command-name>',
        '<command-args>@website 重新设计首页</command-args>',
      ].join('\n'))).resolves.toBe('Redesign website')

      const titlePrompt = String(requestBody?.messages?.[0]?.content ?? '')
      expect(titlePrompt).toContain('/frontend-design @website 重新设计首页')
      expect(titlePrompt).toContain('<conversation>')
      expect(titlePrompt).not.toContain('<command-message>')
    } finally {
      server.stop(true)
    }
  })

  test('keeps generated titles in the first user message language', async () => {
    const requestBodies: Array<{
      messages?: Array<{ content?: string }>
    }> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const requestBody = await req.json() as {
          messages?: Array<{ content?: string }>
        }
        requestBodies.push(requestBody)
        const title = requestBodies.length === 1
          ? 'Summarize recent changes'
          : '总结最近变更'
        return Response.json({
          content: [{ type: 'text', text: JSON.stringify({ title }) }],
        })
      },
    })

    try {
      const providerId = 'title-language-test'
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'providers.json'),
        JSON.stringify({
          activeId: providerId,
          providers: [
            {
              id: providerId,
              presetId: 'minimax',
              name: 'MiniMax',
              apiKey: 'test-key',
              baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
              apiFormat: 'anthropic',
              models: {
                main: 'minimax-main',
                haiku: 'minimax-haiku',
                sonnet: 'minimax-main',
                opus: 'minimax-main',
              },
            },
          ],
        }, null, 2),
      )

      const languagePreference = resolveTitleLanguagePreference(
        '最近我们在最近 15 天做了很多的变更，你去看一下',
        'english',
      )
      await expect(generateTitle(
        [
          '最近我们在最近 15 天做了很多的变更，你去看一下',
          'The assistant answered in English and summarized desktop changes.',
        ].join('\n'),
        undefined,
        languagePreference,
      )).resolves.toBe('总结最近变更')

      expect(languagePreference).toEqual({
        language: 'Chinese',
        source: 'first-user-message',
      })
      expect(requestBodies).toHaveLength(2)
      const firstPrompt = String(requestBodies[0]?.messages?.[0]?.content ?? '')
      const retryPrompt = String(requestBodies[1]?.messages?.[0]?.content ?? '')
      expect(firstPrompt).toContain('Return the title in Chinese.')
      expect(retryPrompt).toContain('The title must be in Chinese.')
      expect(firstPrompt).not.toContain('Return the title in English.')
    } finally {
      server.stop(true)
    }
  })

  test('falls back to response language when the first user message language is ambiguous', () => {
    expect(resolveTitleLanguagePreference('/tmp/2026-06-03', 'english')).toEqual({
      language: 'English',
      source: 'response-language',
    })
  })

  test('generates titles when ChatGPT Official OAuth is active', async () => {
    const systemProxyUrl = 'http://127.0.0.1:17890'
    process.env[SYSTEM_PROXY_URL_ENV] = systemProxyUrl
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          proxy: { mode: 'system', url: '' },
        },
      }),
      'utf-8',
    )
    const providerService = new ProviderService()
    await providerService.activateProvider('openai-official')
    await hahaOpenAIOAuthService.saveTokens({
      accessToken: 'access-for-title',
      refreshToken: 'refresh-for-title',
      expiresAt: Date.now() + 60 * 60_000,
      accountId: 'acct_title',
      email: 'title@example.com',
    })

    const upstreamCalls: Array<{
      url: string
      headers: Record<string, string>
      body: Record<string, unknown>
      proxy?: string
    }> = []
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers)
      upstreamCalls.push({
        url: String(input),
        headers: Object.fromEntries(headers.entries()),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        proxy: (init as RequestInit & { proxy?: string } | undefined)?.proxy,
      })
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_title","object":"response","created_at":1779118000,"model":"gpt-5.3-codex","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\\"title\\":\\"Trace ok\\"}"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
      ].join('\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    await expect(generateTitle('请只回复 trace-ok')).resolves.toBe('Trace ok')
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0].url).toBe(OPENAI_CODEX_API_ENDPOINT)
    expect(upstreamCalls[0].headers.authorization).toBe('Bearer access-for-title')
    expect(upstreamCalls[0].headers['chatgpt-account-id']).toBe('acct_title')
    expect(upstreamCalls[0].body.stream).toBe(true)
    expect(upstreamCalls[0].proxy).toBe(systemProxyUrl)
  })

  test('honors the configured provider auth strategy for title generation', async () => {
    const upstreamCalls: Array<{ headers: Record<string, string> }> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        upstreamCalls.push({
          headers: Object.fromEntries(req.headers.entries()),
        })
        return Response.json({
          content: [{ type: 'text', text: '{"title":"Trace ok"}' }],
        })
      },
    })

    try {
      const providerId = 'auth-token-title-test'
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'providers.json'),
        JSON.stringify({
          activeId: providerId,
          providers: [
            {
              id: providerId,
              presetId: 'custom',
              name: 'Bearer Provider',
              apiKey: 'bearer-title-key',
              authStrategy: 'auth_token',
              baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
              apiFormat: 'anthropic',
              models: {
                main: 'bearer-main',
                haiku: 'bearer-haiku',
                sonnet: 'bearer-main',
                opus: 'bearer-main',
              },
            },
          ],
        }, null, 2),
      )

      await expect(generateTitle('请只回复 trace-ok')).resolves.toBe('Trace ok')

      expect(upstreamCalls).toHaveLength(1)
      expect(upstreamCalls[0].headers.authorization).toBe('Bearer bearer-title-key')
      expect(upstreamCalls[0].headers['x-api-key']).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })

  test('parses JSON title responses wrapped in markdown fences', () => {
    expect(parseGeneratedTitleText('```json\n{"title":"Write bash script"}\n```'))
      .toBe('Write bash script')
  })

  test('parses escaped JSON title responses', () => {
    expect(parseGeneratedTitleText('```json\n{\\"title\\":\\"Write bash script\\"}\n```'))
      .toBe('Write bash script')
  })

  test('rejects incomplete JSON title fragments instead of using them as titles', () => {
    expect(parseGeneratedTitleText('```json\n{\\"title\\":')).toBeNull()
  })

  test('normalizes XML-like title model output before persisting it', () => {
    expect(parseGeneratedTitleText([
      '<command-message>frontend-design</command-message>',
      '<command-name>/frontend-design</command-name>',
      '<command-args>@website</command-args>',
    ].join(' '))).toBe('/frontend-design @website')
  })

  test('does not persist automatic titles over a user custom title', async () => {
    const { sessionId } = await sessionService.createSession(os.tmpdir())
    await sessionService.renameSession(sessionId, 'My fixed name')

    await expect(saveAiTitle(sessionId, 'Automatic topic')).resolves.toBe(false)

    const detail = await sessionService.getSession(sessionId)
    expect(detail?.title).toBe('My fixed name')

    const found = await sessionService.findSessionFile(sessionId)
    expect(found).not.toBeNull()
    const content = await fs.readFile(found!.filePath, 'utf-8')
    expect(content).not.toContain('"type":"ai-title"')
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
