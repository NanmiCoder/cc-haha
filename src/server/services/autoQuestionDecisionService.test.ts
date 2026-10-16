import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from './providerService.js'
import { drainTraceCaptureForTests } from './traceCaptureService.js'
import { hahaOAuthService } from './hahaOAuthService.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import { hahaDeepSeekOAuthService } from './hahaDeepSeekOAuthService.js'
import {
  decideAutoQuestionAnswers,
  type AutoQuestion,
} from './autoQuestionDecisionService.js'

const recommended: AutoQuestion = {
  question: 'Which approach?',
  options: [
    { label: 'Use cache (Recommended)', description: 'Reuse local data' },
    { label: 'Fetch again', description: 'Refresh from provider' },
  ],
}
const undecided: AutoQuestion = {
  question: 'Which format?',
  options: [
    { label: 'JSON', description: 'Machine readable' },
    { label: 'Markdown', description: 'Human readable' },
  ],
}

describe('autoQuestionDecisionService', () => {
  let configDir: string
  let originalConfigDir: string | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalFetch = globalThis.fetch
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-question-test-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    await fs.mkdir(path.join(configDir, 'cc-haha', 'traces'), { recursive: true })
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    hahaOpenAIOAuthService.dispose()
    await drainTraceCaptureForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(configDir, { recursive: true, force: true })
  })

  test('asks the session Haiku model for every question including explicit recommendations', async () => {
    const bodies: Array<Record<string, any>> = []
    const headers: Headers[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        headers.push(req.headers)
        bodies.push(await req.json() as Record<string, any>)
        return Response.json({
          content: [{ type: 'text', text: '{"answers":[{"questionIndex":0,"optionLabels":["Use cache (Recommended)"]},{"questionIndex":1,"optionLabels":["JSON"]}]}' }],
        })
      },
    })
    try {
      const provider = await new ProviderService().addProvider({
        presetId: 'custom', name: 'Fixture', apiKey: 'fake-key', authStrategy: 'api_key',
        baseUrl: `http://127.0.0.1:${server.port}/anthropic`, apiFormat: 'anthropic',
        models: { main: 'large-test', haiku: 'small-test', sonnet: 'large-test', opus: 'large-test' },
      })
      expect(await decideAutoQuestionAnswers({
        questions: [recommended, undecided],
        conversationText: 'The user prefers machine readable output.',
        providerId: provider.id,
        sessionId: 'session-test',
        signal: new AbortController().signal,
      })).toEqual({
        'Which approach?': 'Use cache (Recommended)',
        'Which format?': 'JSON',
      })
      expect(bodies).toHaveLength(1)
      expect(bodies[0]?.model).toBe('small-test')
      expect(bodies[0]?.thinking).toEqual({ type: 'disabled' })
      expect(bodies[0]?.messages?.[0]?.content).toContain('machine readable output')
      expect(bodies[0]?.messages?.[0]?.content).toContain('Which approach?')
      expect(headers[0]?.get('x-api-key')).toBe('fake-key')
    } finally {
      server.stop(true)
    }
  })

  test('passes natural-language recommendations to the model and never invents answers locally', async () => {
    const bodies: Array<Record<string, any>> = []
    let modelText = ''
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(req) {
        bodies.push(await req.json() as Record<string, any>)
        return Response.json({ content: [{ type: 'text', text: modelText }] })
      },
    })
    try {
      const provider = await new ProviderService().addProvider({
        presetId: 'custom', name: 'Fixture', apiKey: 'fake-key', authStrategy: 'api_key',
        baseUrl: `http://127.0.0.1:${server.port}`, apiFormat: 'anthropic',
        models: { main: 'large-test', haiku: 'small-test', sonnet: 'large-test', opus: 'large-test' },
      })
      for (const option of [
        { label: '选项 A（推荐）' },
        { label: '建议采用缓存方案' },
        { label: 'Cache', description: 'こちらの選択肢をお勧めします' },
      ]) {
        const question = { ...recommended, options: [option, { label: 'Alternative' }] }
        modelText = JSON.stringify({ answers: [{ questionIndex: 0, optionLabels: ['Alternative'] }] })
        expect(await decideAutoQuestionAnswers({
          questions: [question], conversationText: 'Prefer a fresh result.', providerId: provider.id,
          signal: new AbortController().signal,
        })).toEqual({ [question.question]: 'Alternative' })
        const prompt = bodies.at(-1)?.messages?.[0]?.content
        expect(prompt).toContain(option.label)
        if ('description' in option) expect(prompt).toContain(option.description)
        expect(prompt).toContain('recommendations expressed naturally in any language')
      }
      expect(bodies).toHaveLength(3)
      for (const invalid of [
        { answers: [{ questionIndex: 0, optionLabels: ['Invented answer'] }] },
        { answers: [] },
        { answers: [{ questionIndex: 0, optionLabels: ['Use cache (Recommended)', 'Fetch again'] }] },
      ]) {
        modelText = JSON.stringify(invalid)
        expect(await decideAutoQuestionAnswers({
          questions: [recommended], conversationText: '', providerId: provider.id,
          signal: new AbortController().signal,
        })).toBeNull()
      }
      expect(bodies).toHaveLength(6)
    } finally {
      server.stop(true)
    }
  })

  test('uses a preset token when a local provider has no saved API key', async () => {
    const headers: Headers[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(req) {
        headers.push(req.headers)
        return Response.json({ content: [{ type: 'text', text:
          '{"answers":[{"questionIndex":0,"optionLabels":["JSON"]}]}' }] })
      },
    })
    try {
      const provider = await new ProviderService().addProvider({
        presetId: 'lmstudio', name: 'Local fixture', apiKey: '',
        baseUrl: `http://127.0.0.1:${server.port}`, apiFormat: 'anthropic',
        models: { main: 'large-test', haiku: 'small-test', sonnet: 'large-test', opus: 'large-test' },
      })
      expect(await decideAutoQuestionAnswers({
        questions: [undecided], conversationText: '', providerId: provider.id,
        signal: new AbortController().signal,
      })).toEqual({ 'Which format?': 'JSON' })
      expect(headers[0]?.get('authorization')).toBe('Bearer lmstudio')
    } finally {
      server.stop(true)
    }
  })

  test('rejects non-option, duplicate, and incomplete model answers', async () => {
    let text = '{"answers":[{"questionIndex":0,"optionLabels":["Other"]}]}'
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch() { return Response.json({ content: [{ type: 'text', text }] }) },
    })
    try {
      const provider = await new ProviderService().addProvider({
        presetId: 'custom', name: 'Fixture', apiKey: 'fake-key',
        baseUrl: `http://127.0.0.1:${server.port}`, apiFormat: 'anthropic',
        models: { main: 'large-test', haiku: 'small-test', sonnet: 'large-test', opus: 'large-test' },
      })
      const decide = () => decideAutoQuestionAnswers({
        questions: [undecided], conversationText: '', providerId: provider.id,
        signal: new AbortController().signal,
      })
      expect(await decide()).toBeNull()
      text = '{"answers":[]}'
      expect(await decide()).toBeNull()
      text = '{"answers":[{"questionIndex":0,"optionLabels":["JSON","JSON"]}]}'
      expect(await decide()).toBeNull()
      text = '{"answers":[{"questionIndex":0,"optionLabels":["JSON","Markdown"]}]}'
      expect(await decide()).toBeNull()
      text = 'not json'
      expect(await decide()).toBeNull()
    } finally {
      server.stop(true)
    }
  })

  test('uses the provider proxy for OpenAI-format small models', async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return Response.json({
        id: 'chatcmpl-auto-question', object: 'chat.completion', model: 'glm-flash',
        choices: [{ index: 0, message: {
          role: 'assistant',
          content: '{"answers":[{"questionIndex":0,"optionLabels":["JSON"]}]}',
        }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }) as typeof fetch
    const provider = await new ProviderService().addProvider({
      presetId: 'opencode-go', name: 'Proxy Fixture', apiKey: 'fake-proxy-key',
      baseUrl: 'https://opencode.ai/zen/go/v1', apiFormat: 'openai_chat',
      models: { main: 'glm-large', haiku: 'glm-flash', sonnet: 'glm-large', opus: 'glm-large' },
    })
    expect(await decideAutoQuestionAnswers({
      questions: [undecided], conversationText: '', providerId: provider.id,
      sessionId: 'session-auto-question', signal: new AbortController().signal,
    })).toEqual({ 'Which format?': 'JSON' })
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).pathname).toBe('/zen/go/v1/chat/completions')
    expect(calls[0]!.body.model).toBe('glm-flash')
    expect(calls[0]!.headers.get('x-opencode-session')).toBe('session-auto-question')
  })

  test('never presents the Claude Official OAuth token itself when the session has no provider ID', async () => {
    // A hand-built request cannot carry the Claude Code CLI's identity
    // (User-Agent, system prefix, billing header, body signature), so the
    // subscription token must not leave through this path at all.
    await hahaOAuthService.saveTokens({
      accessToken: 'fake-claude-token', refreshToken: 'fake-refresh-token',
      expiresAt: Date.now() + 60 * 60_000, scopes: ['user:inference'], subscriptionType: 'pro',
    })
    const calls: string[] = []
    globalThis.fetch = (async (input) => {
      calls.push(String(input))
      return Response.json({ content: [{ type: 'text', text:
        '{"answers":[{"questionIndex":0,"optionLabels":["Markdown"]}]}' }] })
    }) as typeof fetch

    expect(await decideAutoQuestionAnswers({
      questions: [undecided], conversationText: '', providerId: null,
      signal: new AbortController().signal,
    })).toBeNull()
    expect(calls).toEqual([])
  })

  test('uses ChatGPT Official OAuth through its Responses endpoint', async () => {
    await hahaOpenAIOAuthService.saveTokens({
      accessToken: 'fake-openai-token', refreshToken: 'fake-refresh-token',
      expiresAt: Date.now() + 60 * 60_000, accountId: 'acct-auto-question', email: 'test@example.com',
    })
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_auto_question","object":"response","created_at":1779118000,"model":"gpt-5.3-codex","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\\"answers\\":[{\\"questionIndex\\":0,\\"optionLabels\\":[\\"JSON\\"]}]}"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch
    expect(await decideAutoQuestionAnswers({
      questions: [undecided], conversationText: '', providerId: 'openai-official',
      signal: new AbortController().signal,
    })).toEqual({ 'Which format?': 'JSON' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/backend-api/codex/responses')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer fake-openai-token')
    expect(calls[0]!.headers.get('chatgpt-account-id')).toBe('acct-auto-question')
    expect(calls[0]!.body.stream).toBe(true)
  })

  test('uses Grok Official OAuth when no API key is saved', async () => {
    await hahaGrokOAuthService.saveTokens({
      accessToken: 'fake-grok-token', refreshToken: 'fake-refresh-token',
      expiresAt: Date.now() + 60 * 60_000, email: null,
    })
    const calls: Array<{ url: string; headers: Headers }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_auto_question","object":"response","created_at":1779118000,"model":"grok","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\\"answers\\":[{\\"questionIndex\\":0,\\"optionLabels\\":[\\"JSON\\"]}]}"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch
    expect(await decideAutoQuestionAnswers({
      questions: [undecided], conversationText: '', providerId: 'grok-official',
      signal: new AbortController().signal,
    })).toEqual({ 'Which format?': 'JSON' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('cli-chat-proxy.grok.com/v1/responses')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer fake-grok-token')
  })

  test('answers with the DeepSeek account token header, never an API key', async () => {
    await hahaDeepSeekOAuthService.saveTokens({
      token: 'dsh_test_account_token',
      issuer: 'https://platform.deepseek.com',
      deviceId: 'device-1',
    })
    const calls: Array<{ url: string; headers: Headers }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({
        content: [{ type: 'text', text: '{"answers":[{"questionIndex":0,"optionLabels":["JSON"]}]}' }],
      })
    }) as typeof fetch
    expect(await decideAutoQuestionAnswers({
      questions: [undecided], conversationText: '', providerId: 'deepseek-account',
      signal: new AbortController().signal,
    })).toEqual({ 'Which format?': 'JSON' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(calls[0]!.headers.get('x-dsh-auth-token')).toBe('dsh_test_account_token')
    expect(calls[0]!.headers.get('x-api-key')).toBeNull()
    expect(calls[0]!.headers.get('authorization')).toBeNull()
  })

  test('leaves the question with the user while the DeepSeek account is signed out', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return Response.json({})
    }) as typeof fetch
    expect(await decideAutoQuestionAnswers({
      questions: [undecided], conversationText: '', providerId: 'deepseek-account',
      signal: new AbortController().signal,
    })).toBeNull()
    expect(called).toBe(false)
  })

  test('accepts a unique nonempty subset for multi-select questions', async () => {
    const multi: AutoQuestion = {
      question: 'Which checks?', multiSelect: true,
      options: [{ label: 'Lint' }, { label: 'Typecheck' }, { label: 'Build' }],
    }
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch() {
        return Response.json({ content: [{ type: 'text', text: '{"answers":[{"questionIndex":0,"optionLabels":["Lint","Build"]}]}' }] })
      },
    })
    try {
      const provider = await new ProviderService().addProvider({
        presetId: 'custom', name: 'Fixture', apiKey: 'fake-key',
        baseUrl: `http://127.0.0.1:${server.port}`, apiFormat: 'anthropic',
        models: { main: 'large-test', haiku: 'small-test', sonnet: 'large-test', opus: 'large-test' },
      })
      expect(await decideAutoQuestionAnswers({
        questions: [multi], conversationText: '', providerId: provider.id,
        signal: new AbortController().signal,
      })).toEqual({ 'Which checks?': 'Lint, Build' })
    } finally {
      server.stop(true)
    }
  })

  test('aborts before sending a model request', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await decideAutoQuestionAnswers({
      questions: [undecided], conversationText: '', providerId: 'missing',
      signal: controller.signal,
    })).toBeNull()
  })
})
