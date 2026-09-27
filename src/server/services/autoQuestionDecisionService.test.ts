import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from './providerService.js'
import { drainTraceCaptureForTests } from './traceCaptureService.js'
import { hahaOAuthService } from './hahaOAuthService.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import {
  decideAutoQuestionAnswers,
  getRecommendedQuestionAnswers,
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

  test('uses only a unique explicit Recommended suffix', () => {
    expect(getRecommendedQuestionAnswers([recommended])).toEqual({
      'Which approach?': 'Use cache (Recommended)',
    })
    expect(getRecommendedQuestionAnswers([
      { ...recommended, question: 'Ambiguous?', options: [
        { label: 'One (Recommended)' }, { label: 'Two (Recommended)' },
      ] },
      { ...recommended, question: 'Description only?', options: [
        { label: 'One', description: 'Recommended' }, { label: 'Two' },
      ] },
      { ...recommended, question: 'Not a suffix?', options: [
        { label: '(Recommended) One' }, { label: 'Two' },
      ] },
    ])).toEqual({})
  })

  test('answers explicit recommendations without contacting a provider', async () => {
    expect(await decideAutoQuestionAnswers({
      questions: [recommended],
      conversationText: '',
      providerId: null,
      signal: new AbortController().signal,
    })).toEqual({ 'Which approach?': 'Use cache (Recommended)' })
  })

  test('asks the session Haiku model only for unresolved questions', async () => {
    const bodies: Array<Record<string, any>> = []
    const headers: Headers[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        headers.push(req.headers)
        bodies.push(await req.json() as Record<string, any>)
        return Response.json({
          content: [{ type: 'text', text: '{"answers":[{"questionIndex":0,"optionLabels":["JSON"]}]}' }],
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
      expect(bodies[0]?.messages?.[0]?.content).not.toContain('Which approach?')
      expect(headers[0]?.get('x-api-key')).toBe('fake-key')
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

  test('uses Claude Official OAuth Haiku when the session has no provider ID', async () => {
    await hahaOAuthService.saveTokens({
      accessToken: 'fake-claude-token', refreshToken: 'fake-refresh-token',
      expiresAt: Date.now() + 60 * 60_000, scopes: ['user:inference'], subscriptionType: 'pro',
    })
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return Response.json({ content: [{ type: 'text', text:
        '{"answers":[{"questionIndex":0,"optionLabels":["Markdown"]}]}' }] })
    }) as typeof fetch

    expect(await decideAutoQuestionAnswers({
      questions: [undecided], conversationText: '', providerId: null,
      signal: new AbortController().signal,
    })).toEqual({ 'Which format?': 'Markdown' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer fake-claude-token')
    expect(calls[0]!.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(calls[0]!.body.model).toBe('claude-haiku-4-5')
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
