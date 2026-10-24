import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService } from './conversationService.js'
import { CronScheduler } from './cronScheduler.js'
import { ProviderService } from './providerService.js'
import { CreateProviderSchema } from '../types/provider.js'
import { sessionService } from './sessionService.js'
import { markAgentSdkSession } from './officialAgentSdkRuntime.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'
import { registerSideChat } from './sideChatRegistry.js'
import { parseOfficialAgentSdkArgs } from './officialAgentSdkBridge.js'

let directory: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  directory = await mkdtemp(join(tmpdir(), 'conversation-sdk-'))
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  resetTerminalShellEnvironmentCacheForTests()
})
afterEach(async () => {
  mock.restore()
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetTerminalShellEnvironmentCacheForTests()
  await rm(directory, { recursive: true, force: true })
})

async function addSdkProvider() {
  return new ProviderService().addProvider(CreateProviderSchema.parse({
    presetId: 'custom', name: 'SDK fixture', apiKey: 'fake-sdk-key',
    baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic',
    authStrategy: 'api_key', runtime: 'agent-sdk',
    models: { main: 'fixture-model', haiku: '', sonnet: '', opus: '' },
  }))
}

test('SDK child pins selected credentials and fresh app context without inherited CLI identity', async () => {
  const provider = await addSdkProvider()
  process.env.ANTHROPIC_AUTH_TOKEN = 'unrelated-token'
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.CC_HAHA_TEAM_LEADER_RUNTIME = JSON.stringify({ providerId: 'poison', modelId: 'poison' })
  const service = new ConversationService() as any
  const capture: { fingerprint?: string } = {}
  const env = await service.buildChildEnv(directory, 'ws://127.0.0.1/sdk/test?token=fixture', {
    providerId: provider.id, model: 'selected-model',
  }, undefined, undefined, capture)
  expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'fake-sdk-key', ANTHROPIC_MODEL: 'selected-model', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', PWD: directory })
  expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
  expect(env).not.toHaveProperty('CLAUDE_CODE_ATTRIBUTION_HEADER')
  expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
  expect(JSON.parse(env.CC_HAHA_TEAM_LEADER_RUNTIME)).toMatchObject({ providerId: provider.id, modelId: 'selected-model' })
  expect(env.CC_HAHA_SESSION_ID).toBe('test')
  expect(env.CC_HAHA_SESSION_COLLABORATION_TOKEN).toBe('fixture')
  expect(env.CC_HAHA_TEAM_REVIEW_REQUIRED).toBe('1')
  expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
  expect(JSON.parse(capture.fingerprint!).runtime).toBe('agent-sdk')
})

test('SDK launch selects fresh/resume identity and only enables bypass when explicitly selected', () => {
  const service = new ConversationService() as any
  process.env.CLAUDE_DANGEROUS_MODE = '1'
  process.env.CLAUDE_CLI_PATH = '/unrelated/fork'
  const fresh = service.buildSessionAgentSdkArgs('id', 'ws://127.0.0.1/sdk/id?token=test', false, { model: 'fixture', effort: 'high' })
  expect(fresh[3]).toEndWith('/entrypoints/officialAgentSdk.ts')
  expect(fresh).toContain('--session-id')
  expect(fresh).not.toContain('--dangerously-skip-permissions')
  expect(fresh).not.toContain('/unrelated/fork')
  expect(fresh).toContain('--allow-dangerously-skip-permissions')
  const resumed = service.buildSessionAgentSdkArgs('id', 'ws://127.0.0.1/sdk/id?token=test', true, { permissionMode: 'bypassPermissions' })
  expect(resumed).toContain('--resume')
  expect(resumed).not.toContain('--session-id')
  expect(resumed).toContain('--dangerously-skip-permissions')
  spyOn(sessionService, 'shouldPersistSession').mockReturnValue(false)
  expect(service.buildSessionAgentSdkArgs('id', 'ws://127.0.0.1/sdk/id?token=test', false)).toContain('--no-session-persistence')
})

test('startup rejects an existing CLI transcript before clearing history or spawning', async () => {
  const provider = await addSdkProvider()
  const clear = spyOn(sessionService, 'clearSessionTranscript')
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({ transcriptMessageCount: 2, agentProfile: 'standard' } as any)
  const service = new ConversationService() as any
  const launch = spyOn(service, 'buildSessionAgentSdkArgs')
  await expect(service.startSession('old-session', directory, 'ws://127.0.0.1/sdk/old-session?token=test', { providerId: provider.id })).rejects.toThrow('Start a new conversation')
  expect(clear).not.toHaveBeenCalled()
  expect(launch).not.toHaveBeenCalled()
})

test('a recorded SDK conversation cannot silently switch back to the fork', async () => {
  markAgentSdkSession(directory, 'sdk-session')
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({ transcriptMessageCount: 2 } as any)
  await expect(new ConversationService().startSession('sdk-session', directory, 'ws://127.0.0.1/sdk/sdk-session?token=test', { providerId: null })).rejects.toThrow('Select an Agent SDK provider')
})

test('SDK team workers retain reviewed agent restrictions, hooks and app mailbox identity', async () => {
  const provider = await addSdkProvider()
  const service = new ConversationService() as any
  const hooks = { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'exit 2' }] }] }
  const worker = {
    parentSessionId: 'parent', teamName: 'team', memberId: 'child', name: 'reviewer', systemPrompt: 'Review only', tools: ['Read', 'Grep'],
    agentDefinition: { disallowedTools: ['Write'], maxTurns: 4, skills: ['review'], omitClaudeMd: true, hooks },
  }
  const id = crypto.randomUUID()
  const args = service.buildSessionAgentSdkArgs(id, `ws://127.0.0.1/sdk/${id}?token=test`, false, { providerId: provider.id, model: 'fixture', teamWorker: worker })
  const config = parseOfficialAgentSdkArgs(args.slice(4), directory, { ...process.env, ANTHROPIC_API_KEY: 'fake', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  expect(config.launchOptions.agents?.reviewer?.tools).toContain('mcp__cc_haha__TaskList')
  expect(config.launchOptions).toMatchObject({ agent: 'reviewer', agentHooks: hooks, maxTurns: 4, disallowedTools: ['Write'], agents: { reviewer: { prompt: 'Review only', tools: expect.arrayContaining(['Read', 'Grep', 'SendMessage']), skills: ['review'], omitClaudeMd: true } } })
  expect(config.launchOptions.tools).toContain('SendMessage')
  expect(config.launchOptions.tools).toContain('mcp__cc_haha__SendMessage')
  const env = await service.buildChildEnv(directory, `ws://127.0.0.1/sdk/${id}?token=test`, { providerId: provider.id, model: 'fixture', teamWorker: worker })
  expect(JSON.parse(env.CC_HAHA_TEAM_WORKER)).toEqual(worker)
})

test('scheduled jobs never silently run an SDK provider through the CLI backend', async () => {
  const provider = await addSdkProvider()
  const scheduler = new CronScheduler() as any
  const env = await scheduler.buildTaskChildEnv(directory, { providerId: provider.id, model: 'scheduled-model' })
  expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'fake-sdk-key', ANTHROPIC_MODEL: 'scheduled-model', CC_HAHA_DESKTOP_PROVIDER_ID: provider.id })
  expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
  expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
})

test('SDK side chats use a separate native identity and fixed parent boundary without persistence', () => {
  const id = `side-${crypto.randomUUID()}`
  const nativeId = crypto.randomUUID()
  const boundary = crypto.randomUUID()
  const resumePath = join(directory, 'parent.jsonl')
  registerSideChat({ sessionId: id, cliSessionId: nativeId, parentSessionId: crypto.randomUUID(), resumePath, resumeAt: boundary, launchInfo: {} as any, started: false, closed: false, createdAt: new Date().toISOString() })
  const args = (new ConversationService() as any).buildSessionAgentSdkArgs(id, `ws://127.0.0.1/sdk/${id}?token=test`, false)
  const config = parseOfficialAgentSdkArgs(args.slice(4), directory, { ...process.env, ANTHROPIC_API_KEY: 'fake', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  expect(config).toMatchObject({ hostSessionId: id, sessionId: nativeId, resumeFrom: resumePath, resumeSessionAt: boundary, forkSession: true, persistSession: false })
  expect(config.launchOptions.appendSystemPrompt).toContain('reference context only')
})

test('SDK network changes are acknowledged before a turn and rejected updates retain the previous fingerprint', async () => {
  const service = new ConversationService() as any
  const session = { runtime: 'agent-sdk', networkRoutingFingerprint: 'previous' }
  service.sessions.set('session', session)
  const send = spyOn(service, 'sendSdkMessage').mockReturnValue(true)
  const control = spyOn(service, 'requestControl').mockRejectedValueOnce(new Error('network rejected'))
  await expect(service.refreshNetworkEnvironmentBeforeTurn('session', session)).rejects.toThrow('network rejected')
  expect(session.networkRoutingFingerprint).toBe('previous')
  expect(send).not.toHaveBeenCalled()
  control.mockResolvedValue({})
  expect(await service.refreshNetworkEnvironmentBeforeTurn('session', session)).toBe(true)
  expect(control).toHaveBeenLastCalledWith('session', {
    subtype: 'update_network_environment', variables: expect.objectContaining({ API_TIMEOUT_MS: expect.any(String) }),
  }, 10_000)
  expect(session.networkRoutingFingerprint).not.toBe('previous')
  const calls = control.mock.calls.length
  expect(await service.refreshNetworkEnvironmentBeforeTurn('session', session)).toBe(true)
  expect(control.mock.calls.length).toBe(calls)
})

test('SDK network acknowledgements cannot update a replaced session', async () => {
  const service = new ConversationService() as any
  const session = { runtime: 'agent-sdk', networkRoutingFingerprint: 'previous' }
  service.sessions.set('session', session)
  spyOn(service, 'requestControl').mockImplementation(async () => {
    service.sessions.set('session', { runtime: 'agent-sdk', networkRoutingFingerprint: 'replacement' })
    return {}
  })
  expect(await service.refreshNetworkEnvironmentBeforeTurn('session', session)).toBe(false)
  expect(session.networkRoutingFingerprint).toBe('previous')
})

test('SDK credential replacement is acknowledged before a turn and preserves the old key on rejection', async () => {
  const provider = await addSdkProvider()
  const service = new ConversationService() as any
  const session = { runtime: 'agent-sdk', providerId: provider.id,
    providerAuth: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, authToken: '' } }
  service.sessions.set('session', session)
  spyOn(service, 'refreshNetworkEnvironmentBeforeTurn').mockResolvedValue(true)
  const send = spyOn(service, 'sendSdkMessage').mockReturnValue(true)
  const control = spyOn(service, 'requestControl').mockRejectedValueOnce(new Error('credential rejected'))
  await new ProviderService().updateProvider(provider.id, { apiKey: 'replacement-fixture-key' })
  await expect(service.sendMessage('session', 'retry')).rejects.toThrow('credential rejected')
  expect(session.providerAuth.apiKey).toBe('fake-sdk-key')
  expect(send).not.toHaveBeenCalled()
  control.mockImplementation(async () => {
    expect(session.providerAuth.apiKey).toBe('fake-sdk-key')
    expect(send).not.toHaveBeenCalled()
    return {}
  })
  expect(await service.sendMessage('session', 'retry')).toBe(true)
  expect(control).toHaveBeenLastCalledWith('session', {
    subtype: 'update_provider_credentials', apiKey: 'replacement-fixture-key',
  }, 10_000)
  expect(session.providerAuth.apiKey).toBe('replacement-fixture-key')
  expect(send.mock.calls[0]?.[1].type).toBe('user')
  await service.sendMessage('session', 'next turn')
  expect(control).toHaveBeenCalledTimes(2)
})

test('SDK credential acknowledgements cannot update a replaced session or retarget the old engine', async () => {
  const provider = await addSdkProvider()
  const service = new ConversationService() as any
  const session = { runtime: 'agent-sdk', providerId: provider.id,
    providerAuth: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, authToken: '' } }
  service.sessions.set('session', session)
  spyOn(service, 'sendSdkMessage').mockReturnValue(true)
  const control = spyOn(service, 'requestControl').mockImplementation(async () => {
    service.sessions.set('session', { runtime: 'agent-sdk' })
    return {}
  })
  await new ProviderService().updateProvider(provider.id, { apiKey: 'replacement-fixture-key' })
  expect(await service.refreshProviderCredentialsBeforeTurn('session', session)).toBe(false)
  expect(session.providerAuth.apiKey).toBe('fake-sdk-key')
  service.sessions.set('session', session)
  await new ProviderService().updateProvider(provider.id, { runtime: 'claude-code', apiKey: 'other-engine-key' })
  expect(await service.refreshProviderCredentialsBeforeTurn('session', session)).toBe(true)
  expect(control).toHaveBeenCalledTimes(1)
})

test('SDK human provenance is opt-in and carries original typed text separately from attachment expansion', async () => {
  const service = new ConversationService() as any
  service.sessions.set('session', { runtime: 'agent-sdk' })
  spyOn(service, 'buildUserContent').mockResolvedValue('attachment contains ultracode; expanded prompt')
  spyOn(service, 'refreshNetworkEnvironmentBeforeTurn').mockResolvedValue(true)
  spyOn(service, 'refreshOfficialOAuthTokenBeforeTurn').mockResolvedValue(undefined)
  const send = spyOn(service, 'sendSdkMessage').mockReturnValue(true)
  await service.sendMessage('session', 'host automation')
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ cc_haha_human_input: false })
  expect(send.mock.calls.at(-1)?.[1]).not.toHaveProperty('cc_haha_human_text')
  await service.sendMessage('session', 'expanded skill', undefined, { humanInput: true, humanText: '/my-skill' })
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ cc_haha_human_input: true, cc_haha_human_text: '/my-skill' })
})

test('SDK automatic question answering stays disabled unless the user enables it', async () => {
  const service = new ConversationService() as any
  const request = { toolName: 'AskUserQuestion' }
  await service.scheduleAutoQuestionAnswer('session', { runtime: 'agent-sdk' }, 'request', request)
  expect(request).not.toHaveProperty('autoAnswerTimer')
})

test('system proxy fingerprint survives SDK environment sanitization and permits the first turn', async () => {
  const provider = await addSdkProvider()
  process.env.CC_HAHA_SYSTEM_PROXY_URL = 'http://127.0.0.1:17890'
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ network: { proxy: { mode: 'system', url: '' } } }))
  const service = new ConversationService() as any
  const metadata: Record<string, unknown> = {}
  const env = await service.buildChildEnv(directory, undefined, { providerId: provider.id }, undefined, metadata)
  expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:17890')
  expect(env).not.toHaveProperty('CC_HAHA_SYSTEM_PROXY_URL')
  const session = { runtime: 'agent-sdk', networkRoutingFingerprint: metadata.routingFingerprint }
  service.sessions.set('session', session)
  expect(await service.refreshNetworkEnvironmentBeforeTurn('session', session)).toBe(true)
})

test('host starts an active SDK provider through its own launcher without project preloads', async () => {
  const provider = await addSdkProvider()
  await new ProviderService().activateProvider(provider.id)
  const sessionId = crypto.randomUUID()
  const service = new ConversationService() as any
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue(null)
  spyOn(service, 'resolveCliArgs').mockImplementation(() => { throw new Error('Legacy CLI must not run') })
  // Replace only the actual SDK implementation. Exercise the real launch args,
  // environment, WebSocket authorization, startup and persisted engine choice.
  const fixture = join(directory, 'sdk-fixture.ts')
  await writeFile(fixture, `
    const args = process.argv.slice(2)
    const socket = new WebSocket(args[args.indexOf('--sdk-url') + 1])
    socket.onopen = () => socket.send(JSON.stringify({type:'system',subtype:'init',session_id:${JSON.stringify(sessionId)},model:'fixture-model',fixtureKey:process.env.ANTHROPIC_API_KEY,poison:process.env.SDK_PROJECT_POISON}))
    socket.onclose = () => process.exit(0)
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.type === 'user') socket.send(JSON.stringify({type:'result',subtype:'success',result:'fixture done',session_id:${JSON.stringify(sessionId)}}))
    }
  `)
  await writeFile(join(directory, 'bunfig.toml'), 'preload = ["./poison.ts"]\n')
  await writeFile(join(directory, 'poison.ts'), 'throw new Error("Project preload ran")\n')
  await writeFile(join(directory, '.env'), 'SDK_PROJECT_POISON=loaded\n')
  const launch = service.buildSessionAgentSdkArgs.bind(service)
  spyOn(service, 'buildSessionAgentSdkArgs').mockImplementation((...args: unknown[]) => {
    const command = launch(...args)
    command[3] = fixture
    return command
  })
  const transport = Bun.serve<{ id: string }>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const id = url.pathname.split('/').pop()!
      if (!service.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
      return server.upgrade(request, { data: { id } }) ? undefined : new Response('failed', { status: 400 })
    },
    websocket: {
      open(ws) { service.attachSdkConnection(ws.data.id, ws) },
      message(ws, message) { service.handleSdkPayload(ws.data.id, String(message)) },
      close(ws) { service.detachSdkConnection(ws.data.id, ws) },
    },
  })
  try {
    await service.startSession(sessionId, directory, `ws://127.0.0.1:${transport.port}/sdk/${sessionId}?token=fixture`)
    const deadline = Date.now() + 5_000
    while (!service.getSessionInitMessage(sessionId) && Date.now() < deadline) await Bun.sleep(10)
    expect(service.getSessionInitMessage(sessionId)).toMatchObject({ fixtureKey: 'fake-sdk-key', model: 'fixture-model' })
    expect(service.getSessionInitMessage(sessionId)).not.toHaveProperty('poison')
    expect(service.sessions.get(sessionId).runtime).toBe('agent-sdk')
    expect(service.sessions.get(sessionId).providerAuth).toEqual({ baseUrl: 'https://api.anthropic.com', apiKey: 'fake-sdk-key', authToken: '' })
    const { readConversationRuntime } = await import('./officialAgentSdkRuntime.js')
    expect(readConversationRuntime(directory, sessionId)).toBe('agent-sdk')
    const result = new Promise<void>(resolve => service.onOutput(sessionId, (message: any) => { if (message.type === 'result') resolve() }))
    expect(await service.sendMessage(sessionId, 'Fixture')).toBe(true)
    await result
  } finally {
    await service.stopAllSessionsAndWait(1_000)
    await transport.stop(true)
  }
}, 15_000)
