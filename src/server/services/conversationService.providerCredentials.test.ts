import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { ConversationService } from './conversationService.js'
import { ProviderService } from './providerService.js'
import { StructuredIO } from '../../cli/structuredIO.js'
import { getAnthropicClient } from '../../services/api/client.js'
import { handleProxyRequest } from '../proxy/handler.js'

const originalEnv = { ...process.env }
let sandbox: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'provider-key-refresh-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {}, originalEnv))
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(sandbox, { recursive: true, force: true })
})

async function fixture() {
  const providers = new ProviderService()
  const provider = await providers.addProvider({
    presetId: 'custom', name: 'OpenCode direct fixture', baseUrl: 'https://fixture.invalid/anthropic',
    apiKey: 'expired-fixture-key', apiFormat: 'anthropic', authStrategy: 'api_key',
    models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
  })
  const service = new ConversationService()
  const sent: Array<{ type: string; variables?: Record<string, string> }> = []
  const session = {
    providerId: provider.id,
    providerAuth: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, authToken: '' },
    sdkSocket: { send(line: string) { sent.push(JSON.parse(line)) } },
    pendingOutbound: [],
  }
  ;(service as any).sessions.set('running', session)
  return { providers, provider, service, session, sent }
}

test('a saved replacement key reaches the same running CLI before its next user turn', async () => {
  const { providers, provider, service, sent } = await fixture()
  await providers.updateProvider(provider.id, { apiKey: 'replacement-fixture-key' })

  expect(await service.sendMessage('running', 'retry the original conversation')).toBe(true)
  expect(sent).toHaveLength(2)
  expect(sent[0]).toEqual({ type: 'update_environment_variables', variables: {
    ANTHROPIC_API_KEY: 'replacement-fixture-key', ANTHROPIC_AUTH_TOKEN: '',
  } })
  expect(sent[1]!.type).toBe('user')

  await service.sendMessage('running', 'next turn')
  expect(sent).toHaveLength(3)
  expect(sent[2]!.type).toBe('user')
})

test('auth strategy changes clear the previous credential header', async () => {
  const { providers, provider, service, sent } = await fixture()
  await providers.updateProvider(provider.id, { apiKey: 'replacement-fixture-key', authStrategy: 'auth_token' })
  await service.sendMessage('running', 'retry')
  expect(sent[0]!.variables).toEqual({ ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'replacement-fixture-key' })
})

test('changing the provider address does not send its new key to the old running endpoint', async () => {
  const { providers, provider, service, sent } = await fixture()
  await providers.updateProvider(provider.id, { apiKey: 'other-endpoint-key', baseUrl: 'https://other.invalid' })
  await service.sendMessage('running', 'retry')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.type).toBe('user')
})

test('CLI environment update replaces the rejected credential in the next real SDK request', async () => {
  const received: Array<string | null> = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const key = request.headers.get('x-api-key')
    received.push(key)
    return key === 'replacement-fixture-key'
      ? Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'restored' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
      : Response.json({ type: 'error', error: { type: 'authentication_error', message: 'expired fixture key' } }, { status: 401 })
  } })
  try {
    const { providers, provider, service, session, sent } = await fixture()
    const baseUrl = `http://127.0.0.1:${server.port}`
    await providers.updateProvider(provider.id, { baseUrl })
    session.providerAuth.baseUrl = baseUrl
    Object.assign(process.env, { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: provider.apiKey })
    const body = { model: 'fixture', max_tokens: 16, messages: [{ role: 'user' as const, content: 'retry' }] }
    const rejectedClient = await getAnthropicClient({ maxRetries: 0, model: 'fixture' })
    await expect(Promise.resolve(rejectedClient.messages.create(body))).rejects.toMatchObject({ status: 401 })

    await providers.updateProvider(provider.id, { apiKey: 'replacement-fixture-key' })
    await service.sendMessage('running', 'retry')
    async function* input() {
      for (const message of sent) yield `${JSON.stringify(message)}\n`
    }
    const io = new StructuredIO(input())
    for await (const _message of io.structuredInput) { /* Consume the real CLI control parser. */ }

    const refreshedClient = await getAnthropicClient({ maxRetries: 0, model: 'fixture' })
    expect((await refreshedClient.messages.create(body)).content).toEqual([{ type: 'text', text: 'restored' }])
    expect(received).toEqual(['expired-fixture-key', 'replacement-fixture-key'])
  } finally {
    server.stop(true)
  }
})

test('OpenCode Go proxy already re-reads a replacement key for the same session endpoint', async () => {
  const providers = new ProviderService()
  const provider = await providers.addProvider({
    presetId: 'opencode-go', name: 'OpenCode Go fixture', baseUrl: 'https://opencode.ai/zen/go/v1',
    apiFormat: 'openai_chat', apiKey: 'expired-fixture-key',
    models: { main: 'glm-5.3', haiku: 'glm-5.3', sonnet: 'glm-5.3', opus: 'glm-5.3' },
  })
  const received: Array<string | null> = []
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const authorization = new Headers(init?.headers).get('Authorization')
    received.push(authorization)
    return authorization === 'Bearer replacement-fixture-key'
      ? Response.json({ id: 'fixture', choices: [{ message: { content: 'restored' }, finish_reason: 'stop' }] })
      : Response.json({ error: { message: 'expired fixture key' } }, { status: 401 })
  })
  try {
    const request = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'glm-5.3', max_tokens: 16, messages: [{ role: 'user', content: 'retry' }] }),
    })
    expect((await handleProxyRequest(request.clone(), new URL(request.url))).status).toBe(401)
    await providers.updateProvider(provider.id, { apiKey: 'replacement-fixture-key' })
    expect((await handleProxyRequest(request.clone(), new URL(request.url))).status).toBe(200)
    expect(received).toEqual(['Bearer expired-fixture-key', 'Bearer replacement-fixture-key'])
  } finally {
    fetchMock.mockRestore()
  }
})
