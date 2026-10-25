import '../../../preload.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAnthropicClient } from './client.js'
import { getProviderRuntimeContext, runWithProviderRuntime, type ProviderRuntimeContext } from './providerRuntimeContext.js'
import { getOpenAIOAuthTokens, saveOpenAIOAuthTokens } from '../openaiAuth/storage.js'

let root: string
let saved: NodeJS.ProcessEnv
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'agent-provider-client-'))
  saved = { ...process.env }
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'parent-key', ANTHROPIC_AUTH_TOKEN: 'parent-token',
    ANTHROPIC_BASE_URL: 'https://parent.invalid',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer parent-custom\nX-Parent: secret',
    CC_HAHA_OPENAI_OAUTH_PROVIDER: '1',
  })
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await fs.rm(root, { recursive: true, force: true })
})

function runtime(providerId: string, env: NodeJS.ProcessEnv, runtimeKind: ProviderRuntimeContext['runtimeKind'] = 'anthropic_compatible'): ProviderRuntimeContext {
  return { providerId, runtimeKind, env: { CLAUDE_CONFIG_DIR: root, ...env } }
}
function message(model: string) {
  return Response.json({ id: 'test-message', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
}
const request = { model: 'fixture-model', max_tokens: 8, messages: [{ role: 'user' as const, content: 'hi' }] }

test('an explicit provider bypasses the parent SSH socket that pins requests to Anthropic', async () => {
  process.env.ANTHROPIC_UNIX_SOCKET = '/parent/anthropic-auth.sock'
  let unix: string | undefined
  const client = await runWithProviderRuntime(runtime('target', {
    ANTHROPIC_BASE_URL: 'https://target.invalid', ANTHROPIC_API_KEY: 'target-key',
  }), () => getAnthropicClient({
    maxRetries: 0,
    fetchOverride: async (input, init) => {
      expect(String(input)).toBe('https://target.invalid/v1/messages')
      unix = (init as RequestInit & { unix?: string }).unix
      return message(request.model)
    },
  }))
  await client.messages.create(request)
  expect(unix).toBeUndefined()
})

test('clients retain separate endpoints and credentials when invoked outside their creation contexts', async () => {
  const seen: Array<{ id?: string; url: string; key: string | null; auth: string | null; custom: string | null }> = []
  const clients = await Promise.all(['a', 'b'].map(providerId => runWithProviderRuntime(runtime(providerId, {
    ANTHROPIC_BASE_URL: `https://${providerId}.invalid/anthropic`, ANTHROPIC_API_KEY: `key-${providerId}`,
  }), () => getAnthropicClient({
    maxRetries: 0,
    fetchOverride: async (input, init) => {
      await Promise.resolve()
      const headers = new Headers(init?.headers)
      seen.push({ id: getProviderRuntimeContext()?.providerId, url: String(input), key: headers.get('x-api-key'), auth: headers.get('authorization'), custom: headers.get('x-parent') })
      return message(request.model)
    },
  }))))
  await Promise.all(clients.map(client => client.messages.create(request)))
  expect(seen.sort((a, b) => a.id!.localeCompare(b.id!))).toEqual(['a', 'b'].map(id => ({ id, url: `https://${id}.invalid/anthropic/v1/messages`, key: `key-${id}`, auth: null, custom: null })))
  expect(process.env.ANTHROPIC_API_KEY).toBe('parent-key')
})

test('explicit Claude uses its OAuth token and official endpoint without the parent provider key', async () => {
  const client = await runWithProviderRuntime(runtime('claude-official', { CLAUDE_CODE_OAUTH_TOKEN: 'official-token' }, 'claude_oauth'), () => getAnthropicClient({
    maxRetries: 0,
    fetchOverride: async (input, init) => {
      expect(String(input)).toBe('https://api.anthropic.com/v1/messages')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer official-token')
      expect(headers.has('x-api-key')).toBe(false)
      expect(headers.has('x-parent')).toBe(false)
      return message(request.model)
    },
  }))
  await client.messages.create(request)
})

test.each(['direct-bearer', 'managed-proxy'] as const)('authenticates an explicit %s without borrowing parent credentials', async kind => {
  const baseURL = kind === 'managed-proxy' ? 'http://127.0.0.1:3456/proxy/providers/target' : 'https://target.invalid'
  const env = kind === 'managed-proxy'
    ? { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'proxy-managed', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CC_HAHA_LOCAL_ACCESS_TOKEN: 'target-local-token' }
    : { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_AUTH_TOKEN: 'target-bearer' }
  const client = await runWithProviderRuntime(runtime('target', env), () => getAnthropicClient({
    maxRetries: 0,
    fetchOverride: async (input, init) => {
      expect(String(input)).toBe(`${baseURL}/v1/messages`)
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(kind === 'managed-proxy' ? 'Bearer target-local-token' : 'Bearer target-bearer')
      expect(headers.get('x-api-key')).toBe(kind === 'managed-proxy' ? 'proxy-managed' : null)
      expect(headers.has('x-parent')).toBe(false)
      return message(request.model)
    },
  }))
  await client.messages.create(request)
})

test('missing explicit credentials fail instead of borrowing the parent login', async () => {
  await expect(runWithProviderRuntime(runtime('missing', {}), () => getAnthropicClient({ maxRetries: 0 }))).rejects.toThrow('Provider "missing" is not authenticated')
  const ctx = runtime('openai-missing', {}, 'openai_oauth')
  expect(runWithProviderRuntime(ctx, () => getOpenAIOAuthTokens())).toBeNull()
  expect(runWithProviderRuntime(ctx, () => saveOpenAIOAuthTokens({ accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 60_000 }))).toEqual({ success: false, warning: 'Explicit OpenAI provider has no token file' })
})

test('refreshes the selected official account for each request and stops after sign-out', async () => {
  let token: string | null = 'refreshed-first'
  const ctx = { ...runtime('claude-official', { CLAUDE_CODE_OAUTH_TOKEN: 'old-snapshot' }, 'claude_oauth'), getClaudeOAuthAccessToken: async () => token }
  const received: Array<string | null> = []
  const client = await runWithProviderRuntime(ctx, () => getAnthropicClient({
    maxRetries: 0,
    fetchOverride: async (_input, init) => {
      received.push(new Headers(init?.headers).get('authorization'))
      return message(request.model)
    },
  }))
  await client.messages.create(request)
  token = 'refreshed-next'
  await client.messages.create(request)
  token = null
  await expect(Promise.resolve(client.messages.create(request))).rejects.toThrow()
  expect(received).toEqual(['Bearer refreshed-first', 'Bearer refreshed-next'])
})

test.each(['openai_oauth', 'grok_oauth', 'deepseek_oauth'] as const)('native %s reads its target token file during a delayed SDK request', async kind => {
  const tokenFile = join(root, `${kind}.json`)
  await fs.writeFile(tokenFile, JSON.stringify(kind === 'deepseek_oauth'
    ? { token: 'dsh_target_token', issuer: 'https://platform.deepseek.com', deviceId: 'fixture' }
    : { accessToken: 'target-token', refreshToken: 'target-refresh', expiresAt: Date.now() + 3600_000 }))
  const env = kind === 'openai_oauth'
    ? { OPENAI_CODEX_OAUTH_FILE: tokenFile, CC_HAHA_OPENAI_REQUEST_COMPRESSION: '0' }
    : kind === 'grok_oauth'
      ? { GROK_OAUTH_FILE: tokenFile }
      : { DEEPSEEK_OAUTH_FILE: tokenFile, ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }
  let called = false
  const client = await runWithProviderRuntime(runtime(kind, env, kind), () => getAnthropicClient({
    maxRetries: 0,
    fetchOverride: async (input, init) => {
      called = true
      expect(getProviderRuntimeContext()?.providerId).toBe(kind)
      const headers = new Headers(init?.headers)
      expect(headers.has('x-api-key')).toBe(false)
      expect(headers.has('x-parent')).toBe(false)
      if (kind === 'deepseek_oauth') {
        expect(String(input)).toBe('https://api.deepseek.com/anthropic/v1/messages')
        expect(headers.get('x-dsh-auth-token')).toBe('dsh_target_token')
        expect(headers.has('authorization')).toBe(false)
        return message(request.model)
      }
      expect(headers.get('authorization')).toBe('Bearer target-token')
      expect(new URL(String(input)).hostname).toBe(kind === 'openai_oauth' ? 'chatgpt.com' : 'cli-chat-proxy.grok.com')
      return Response.json({ error: 'offline fixture rejection' }, { status: 429 })
    },
  }))
  if (kind === 'deepseek_oauth') await client.messages.create(request)
  else await expect(Promise.resolve(client.messages.create(request))).rejects.toThrow()
  expect(called).toBe(true)
})
