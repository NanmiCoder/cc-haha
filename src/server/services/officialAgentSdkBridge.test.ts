import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, mock, test } from 'bun:test'
import type { Options, Query, SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk/core'
import { createOfficialAgentSdkBridge, parseOfficialAgentSdkArgs, type OfficialAgentSdkExtensions } from './officialAgentSdkBridge.js'

const sessionId = '00000000-0000-4000-8000-000000000001'
const sdkUrl = `ws://127.0.0.1:12345/sdk/${sessionId}?token=fixture-token`
const launchArgs = ['--sdk-url', sdkUrl, '--session-id', sessionId]

class OutputQueue {
  private messages: SDKMessage[] = []
  private waiting: ((value: IteratorResult<SDKMessage, void>) => void) | undefined
  private ended = false

  push(message: Record<string, unknown>): void {
    const typed = message as SDKMessage
    if (this.waiting) {
      this.waiting({ done: false, value: typed })
      this.waiting = undefined
    } else this.messages.push(typed)
  }

  close(): void {
    this.ended = true
    this.waiting?.({ done: true, value: undefined })
    this.waiting = undefined
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.messages.length) return Promise.resolve({ done: false, value: this.messages.shift()! })
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => { this.waiting = resolve })
  }
}

function harness(extraArgs: string[] = [], initialize?: () => Promise<unknown>, extensions?: OfficialAgentSdkExtensions, environment: NodeJS.ProcessEnv = {}) {
  const config = parseOfficialAgentSdkArgs([...launchArgs, ...extraArgs], '/fixture/project', {
    ANTHROPIC_API_KEY: 'fake-api-key',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    CC_HAHA_AGENT_SDK_EXECUTABLE: '/fixture/official-sdk/claude',
    ...environment,
  })
  const output = new OutputQueue()
  const sent: Record<string, any>[] = []
  let options!: Options
  let prompt!: AsyncIterator<SDKUserMessage>
  const methods = {
    interrupt: mock(async () => ({ still_queued: [] })),
    setModel: mock(async (_model?: string) => {}),
    setPermissionMode: mock(async (_mode: string) => {}),
    setMaxThinkingTokens: mock(async (_limit: number | null) => {}),
    initializationResult: mock(initialize ?? (async () => ({ commands: [], models: [], agents: [], account: {}, output_style: 'default', available_output_styles: ['default'] }))),
    supportedCommands: mock(async () => [{ name: 'help', description: 'Help', argumentHint: '' }]),
    supportedModels: mock(async () => [{ value: 'fixture-model', displayName: 'Fixture', description: '' }]),
    mcpServerStatus: mock(async () => []),
    supportedAgents: mock(async () => [{ name: 'reviewer' }]),
    reconnectMcpServer: mock(async (_name: string) => {}),
    toggleMcpServer: mock(async (_name: string, _enabled: boolean) => {}),
    setMcpServers: mock(async (_servers: unknown) => ({ added: [], removed: [], errors: {} })),
    reloadPlugins: mock(async (_options?: unknown) => ({ commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 })),
    reloadSkills: mock(async () => ({ commands: [] })),
    reloadOutputStyles: mock(async () => ({ available_output_styles: ['default'] })),
    rewindFiles: mock(async (_uuid: string, _options?: unknown) => ({ canRewind: true, filesChanged: ['fixture.txt'] })),
    applyFlagSettings: mock(async (_settings: unknown) => {}),
    getContextUsage: mock(async (_opts?: unknown) => ({ used_tokens: 12 })),
    backgroundTasks: mock(async (_id?: string) => true),
    stopTask: mock(async (_taskId: string) => {}),
    close: mock(() => output.close()),
  }
  const mockQuery = mock((params: Parameters<typeof query>[0]) => {
    options = params.options!
    if (typeof params.prompt === 'string') throw new Error('Expected streaming input')
    prompt = params.prompt[Symbol.asyncIterator]()
    return {
      ...methods,
      next: () => output.next(),
      [Symbol.asyncIterator]() { return this },
    } as unknown as Query
  })
  const bridge = createOfficialAgentSdkBridge(config, { query: mockQuery, extensions, send: message => sent.push(message) })
  return { config, bridge, output, sent, options, prompt, methods, mockQuery }
}

const user = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content } })
const control = (subtype: string, fields: Record<string, unknown> = {}) => JSON.stringify({
  type: 'control_request', request_id: `host-${subtype}`, request: { subtype, ...fields },
})
const permissionReply = (requestId: string, decision: unknown) => JSON.stringify({
  type: 'control_response', response: { subtype: 'success', request_id: requestId, response: decision },
})
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))
const result = () => ({ type: 'result', subtype: 'success', session_id: sessionId, result: 'done' })

test('native refusal resolution retracts streamed frames and returns the original human prompt to edit', async () => {
  const h = harness()
  const human = '00000000-0000-4000-8000-000000000099'
  await h.bridge.receive(JSON.stringify({ type: 'user', uuid: human, cc_haha_human_input: true, cc_haha_human_text: 'Edit this original',
    message: { role: 'user', content: 'Edit this original' } }))
  h.output.push({ type: 'stream_event', user_message_uuid: human, event: { type: 'message_start', message: { id: 'api' } } })
  h.output.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } } })
  h.output.push({ type: 'assistant', uuid: 'partial', message: { id: 'api', content: [{ type: 'text', text: 'partial' }] } })
  await tick(); await tick(); await tick()
  const pending = h.options.onUserDialog!({ dialogKind: 'refusal_fallback_prompt', payload: {
    originalModel: 'primary', fallbackModel: 'fallback', retractedMessageUuids: ['partial'],
  } }, { signal: new AbortController().signal, requestId: 'edit-refusal' })
  expect(h.sent.some(message => message.subtype === 'official_sdk_messages_retracted')).toBe(false)
  const envelope = h.sent.at(-1)!.request.input
  await h.bridge.receive(permissionReply('edit-refusal', { behavior: 'allow', updatedInput: { ...envelope, sdkDialogResult: { choice: 'edit_prompt' } } }))
  expect(await pending).toEqual({ behavior: 'completed', result: 'edit_prompt' })
  expect(h.sent.find(message => message.subtype === 'official_sdk_messages_retracted')).toMatchObject({
    ids: ['partial', 'sdk-block:["","api"]:0'], edit: { text: 'Edit this original', uuid: human },
  })
  h.bridge.close()
  await h.bridge.done
})

test('desktop mode controls and slash commands stay local and keep Haiku effort unchanged', async () => {
  const h = harness(['--model', 'claude-haiku-5-5', '--effort', 'low'])
  await h.bridge.receive(control('set_ultracode', { enabled: true }))
  expect(h.methods.applyFlagSettings).toHaveBeenLastCalledWith({ ultracode: true })
  expect(h.options.effort).toBe('low')
  await h.bridge.receive(JSON.stringify({ type: 'user', cc_haha_human_input: true, message: { role: 'user', content: '/effort ultracode off' } }))
  expect(h.methods.applyFlagSettings).toHaveBeenLastCalledWith({ ultracode: false })
  expect(h.sent.some(message => message.type === 'result')).toBe(true)
  expect(h.sent.find(message => message.subtype === 'local_command_output')?.content).toContain('Ultracode is off')
  h.bridge.close()
  await h.bridge.done
})

test('SDK credential control updates the pinned key without accepting endpoint or authentication overrides', async () => {
  const h = harness()
  try {
    await h.bridge.receive(control('update_provider_credentials', { apiKey: 'replacement-fixture-key' }))
    expect(h.sent.at(-1)?.response.subtype).toBe('success')
    expect(h.methods.applyFlagSettings).toHaveBeenLastCalledWith({ env: expect.objectContaining({
      ANTHROPIC_API_KEY: 'replacement-fixture-key', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    }) })
    expect(h.options.env?.ANTHROPIC_API_KEY).toBe('replacement-fixture-key')
    await h.bridge.receive(control('update_provider_credentials', { apiKey: 'other-key', baseUrl: 'https://other.invalid' }))
    expect(h.sent.at(-1)?.response.subtype).toBe('error')
    expect(h.methods.applyFlagSettings).toHaveBeenCalledTimes(1)
  } finally {
    h.bridge.close()
    await h.bridge.done
  }
})

test.each([
  ['serialized worker configuration', JSON.stringify({
    parentSessionId: '00000000-0000-4000-8000-000000000002',
    teamName: 'fixture-team', memberId: 'worker', name: 'worker',
  })],
  ['legacy worker marker', '1'],
])('team workers cannot enable Ultracode through controls or slash commands: %s', async (_description, marker) => {
  const h = harness(['--model', 'claude-haiku-5-5'], undefined, undefined, { CC_HAHA_TEAM_WORKER: marker })
  try {
    await h.bridge.receive(control('get_ultracode'))
    expect(h.sent.at(-1)?.response?.response).toMatchObject({ enabled: false, active: false, available: false, reason: 'session' })
    await h.bridge.receive(control('set_ultracode', { enabled: true }))
    expect(h.sent.at(-1)?.response).toMatchObject({
      subtype: 'error', error: 'Ultracode is available only in a full main conversation.',
    })
    await expect(h.bridge.receive(JSON.stringify({
      type: 'user', cc_haha_human_input: true,
      message: { role: 'user', content: '/effort ultracode on' },
    }))).rejects.toThrow('Ultracode is available only in a full main conversation.')
    expect(h.methods.applyFlagSettings).not.toHaveBeenCalled()
  } finally {
    h.bridge.close()
    await h.bridge.done
  }
})

test('editing a queued turn uses its dispatched human prompt even without optional native correlation', async () => {
  const h = harness()
  for (const [suffix, text] of [['1', 'First'], ['2', 'Second']] as const) {
    await h.bridge.receive(JSON.stringify({ type: 'user', uuid: `00000000-0000-4000-8000-00000000000${suffix}`,
      cc_haha_human_input: true, message: { role: 'user', content: text } }))
  }
  await h.prompt.next()
  h.output.push(result())
  await tick(); await tick()
  await h.prompt.next()
  const pending = h.options.onUserDialog!({ dialogKind: 'refusal_fallback_prompt', payload: {
    originalModel: 'primary', fallbackModel: 'fallback', retractedMessageUuids: [],
  } }, { signal: new AbortController().signal, requestId: 'queued-edit' })
  await h.bridge.receive(permissionReply('queued-edit', { behavior: 'allow', updatedInput: { sdkDialogResult: { choice: 'edit_prompt' } } }))
  await pending
  expect(h.sent.find(message => message.subtype === 'official_sdk_messages_retracted')?.edit.text).toBe('Second')
  h.bridge.close()
  await h.bridge.done
})

test('MCP URL completion resolves only its exact server and elicitation without approving forms', async () => {
  const h = harness()
  const options = (requestId: string) => ({ requestId, signal: new AbortController().signal })
  const pending = h.options.onElicitation!({ mode: 'url', message: 'Authorize', url: 'https://example.test/auth', serverName: 'one', elicitationId: 'auth' }, options('url-one'))
  const other = h.options.onElicitation!({ mode: 'url', message: 'Authorize', url: 'https://example.test/auth', serverName: 'two', elicitationId: 'auth' }, options('url-two'))
  const form = h.options.onElicitation!({ mode: 'form', message: 'Form', serverName: 'one', elicitationId: 'auth', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }, options('form'))
  h.output.push({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'one', elicitation_id: 'auth' })
  expect(await pending).toEqual({ action: 'accept' })
  expect(h.sent.filter(message => message.type === 'control_cancel_request').map(message => message.request_id)).toEqual(['url-one'])
  h.output.push({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'one', elicitation_id: 'auth' })
  await tick()
  expect(h.sent.filter(message => message.type === 'control_cancel_request')).toHaveLength(1)
  h.bridge.close()
  expect(await other).toEqual({ action: 'cancel' })
  expect(await form).toEqual({ action: 'cancel' })
  await h.bridge.done
})

test('SDK dialogs share pending-request identity, cancellation and reconnect envelopes without generic approval', async () => {
  const h = harness()
  const controller = new AbortController()
  const request = { serverName: 'fixture', message: 'Authorize fixture', mode: 'url' as const, url: 'https://example.test/auth' }
  const pending = h.options.onElicitation!(request, { signal: controller.signal, requestId: 'dialog-1' })
  const duplicate = h.options.onElicitation!(request, { signal: controller.signal, requestId: 'dialog-1' })
  expect(h.sent.filter(message => message.request_id === 'dialog-1')).toHaveLength(1)
  expect(h.sent.at(-1)?.request).toMatchObject({ subtype: 'can_use_tool', tool_name: '__cc_haha_sdk_dialog', suppress_always_allow_rule: true })
  await h.bridge.receive(permissionReply('dialog-1', { behavior: 'allow', updatedInput: {} }))
  expect(await pending).toEqual({ action: 'cancel' })
  expect(await duplicate).toEqual({ action: 'cancel' })
  const second = h.options.onElicitation!(request, { signal: controller.signal, requestId: 'dialog-2' })
  controller.abort()
  expect(await second).toEqual({ action: 'cancel' })
  expect(h.sent.at(-1)).toEqual({ type: 'control_cancel_request', request_id: 'dialog-2' })
  const third = h.options.onUserDialog!({ dialogKind: 'auto_mode_server_fallback', payload: { title: 'Usage', paragraphs: ['Costs may apply.'] } }, { signal: new AbortController().signal, requestId: 'dialog-3' })
  h.bridge.close()
  expect(await third).toEqual({ behavior: 'cancelled' })
  await h.bridge.done
})

test('only authenticated human provenance reaches ultracode and synthetic workflow notifications bypass expansion', async () => {
  let notify!: (text: string) => void
  const transformPrompt = mock(async (text: string, _context?: unknown) => text)
  const backgroundTasks = mock(async () => true)
  const h = harness([], undefined, { transformPrompt, backgroundTasks, configure(context) { notify = context.notify! } })
  const content = [{ type: 'text', text: 'first' }, { type: 'image', source: { type: 'base64', data: 'fixture' } }, { type: 'text', text: 'ultracode second' }]
  await h.bridge.receive(JSON.stringify({ type: 'user', cc_haha_human_input: true, message: { role: 'user', content } }))
  expect(transformPrompt).toHaveBeenLastCalledWith('first', { isHumanInput: true, humanText: 'first\nultracode second' })
  await h.prompt.next()
  h.output.push(result())
  await tick()
  await h.bridge.receive(JSON.stringify({ type: 'user', cc_haha_human_input: true, isMeta: true, message: { role: 'user', content: 'ultracode untrusted' } }))
  expect(transformPrompt).toHaveBeenLastCalledWith('ultracode untrusted', { isHumanInput: false })
  await h.prompt.next()
  h.output.push(result())
  await tick()
  notify('Workflow fixture complete')
  expect((await h.prompt.next()).value).toMatchObject({ isSynthetic: true, isMeta: true, message: { content: 'Workflow fixture complete' } })
  expect(transformPrompt).toHaveBeenCalledTimes(2)
  await h.bridge.receive(control('background_tasks', { tool_use_id: 'workflow-fixture' }))
  expect(backgroundTasks).toHaveBeenCalledWith('workflow-fixture')
  expect(h.sent.at(-1)?.response?.response).toEqual({ backgrounded: true })
  h.bridge.close()
  await h.bridge.done
})

describe('official Agent SDK launch contract', () => {
  test('readiness waits for the native initialize response before the host can restore its placeholder', async () => {
    let initialized!: () => void
    const h = harness([], () => new Promise<void>(resolve => { initialized = resolve }))
    let ready = false
    void h.bridge.ready.then(() => { ready = true })
    await tick()
    expect(ready).toBe(false)
    initialized()
    await h.bridge.ready
    expect(ready).toBe(true)
    h.bridge.close()
    await h.bridge.done
  })

  test('uses SDK native session identity, explicit runtime executable and native filesystem configuration', async () => {
    const h = harness(['--model', 'claude-opus-5-5', '--effort', 'high', '--thinking', 'disabled', '--permission-mode', 'plan'])
    expect(h.options).toMatchObject({
      sessionId,
      cwd: '/fixture/project',
      model: 'claude-opus-5-5',
      effort: 'high',
      thinking: { type: 'disabled' },
      permissionMode: 'plan',
      allowDangerouslySkipPermissions: false,
      pathToClaudeCodeExecutable: '/fixture/official-sdk/claude',
      includePartialMessages: true,
      persistSession: true,
      settingSources: ['user', 'project', 'local'],
      strictMcpConfig: false,
      skills: 'all',
      tools: { type: 'preset', preset: 'claude_code' },
      enableFileCheckpointing: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    })
    expect(h.options.env).toMatchObject({
      ANTHROPIC_API_KEY: 'fake-api-key',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_CODE_BG_TASKS_REPORT_RUNNING: '1',
    })
    expect(h.options.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(h.options.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined()
    expect(h.options.extraArgs).toBeUndefined()
    expect(typeof h.options.settings).toBe('string')
    const settingsPath = h.options.settings as string
    expect(settingsPath).not.toContain('fake-api-key')
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_API_KEY).toBe('fake-api-key')
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
    h.bridge.close()
    await h.bridge.done
    expect(existsSync(settingsPath)).toBe(false)
  })

  test('supports explicit stdio and native forks without confusing the desktop host identity', async () => {
    const childId = '00000000-0000-4000-8000-000000000002'
    const config = parseOfficialAgentSdkArgs(['--stdio', '--session-id', childId, '--resume', sessionId,
      '--fork-session', '--resume-session-at', sessionId, '--no-session-persistence',
      '--launch-options', JSON.stringify({ appendSystemPrompt: 'side chat', tools: ['Read'], maxTurns: 5 })], '/fixture', {})
    expect(config).toMatchObject({ transport: 'stdio', sessionId: childId, resumeFrom: sessionId, forkSession: true,
      resumeSessionAt: sessionId, launchOptions: { appendSystemPrompt: 'side chat', tools: ['Read'], maxTurns: 5 } })
    expect(config.sdkUrl).toBeUndefined()
    expect(parseOfficialAgentSdkArgs(['--session-id', childId, '--host-session-id', `side-${childId}`,
      '--sdk-url', `ws://127.0.0.1/sdk/side-${childId}?token=x`, '--resume', '/fixture/source.jsonl', '--fork-session'], '/fixture', {}).resumeFrom).toBe('/fixture/source.jsonl')
    for (const args of [
      [...launchArgs, '--stdio'],
      ['--stdio', '--session-id', childId, '--fork-session'],
      ['--stdio', '--resume', '/fixture/source.jsonl'],
      ['--stdio', '--session-id', childId, '--resume-session-at', sessionId],
      [...launchArgs, '--host-session-id', 'foreign'],
    ]) expect(() => parseOfficialAgentSdkArgs(args, '/fixture', {})).toThrow()
  })

  test('passes resume through the real SDK without allocating another session', async () => {
    const config = parseOfficialAgentSdkArgs(['--sdk-url', sdkUrl, '--resume', sessionId], '/fixture', {})
    let options: Options | undefined
    const runtime = (async function* () {})() as Query
    runtime.close = () => {}
    runtime.initializationResult = async () => ({} as Awaited<ReturnType<Query['initializationResult']>>)
    const bridge = createOfficialAgentSdkBridge(config, {
      query: params => { options = params.options; return runtime },
      send: () => {},
    })
    await bridge.done
    expect(options?.resume).toBe(sessionId)
    expect(options?.sessionId).toBeUndefined()
  })

  test('honors the user no-history setting without enabling bypass permissions', async () => {
    const h = harness(['--no-session-persistence', '--allow-dangerously-skip-permissions'])
    expect(h.options.persistSession).toBe(false)
    expect(h.options.allowDangerouslySkipPermissions).toBe(true)
    expect(h.options.permissionMode).toBe('default')
    h.bridge.close()
    await h.bridge.done
  })

  test('rejects untrusted destinations, ambiguous identities, unknown flags, and implicit bypass', () => {
    for (const args of [
      ['--sdk-url', `ws://example.com/sdk/${sessionId}?token=fixture`, '--session-id', sessionId],
      ['--sdk-url', `ws://127.0.0.1/sdk/${sessionId}`, '--session-id', sessionId],
      [...launchArgs, '--resume', sessionId],
      [...launchArgs, '--model', 'first', '--model', 'second'],
      [...launchArgs, '--agent-profile', 'lean'],
      [...launchArgs, '--permission-mode', 'bypassPermissions'],
      [...launchArgs, '--permission-mode', 'invalid'],
      [...launchArgs, '--effort', 'ultra'],
      [...launchArgs, '--thinking', 'invalid'],
    ]) expect(() => parseOfficialAgentSdkArgs(args, '/fixture', {})).toThrow()
    expect(parseOfficialAgentSdkArgs([...launchArgs, '--dangerously-skip-permissions'], '/fixture', {})).toMatchObject({
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    })
  })
})

describe('official Agent SDK desktop bridge', () => {
  test('streams native events unchanged and keeps multiple prompts in one query', async () => {
    const h = harness()
    try {
      await h.bridge.receive(user('first'))
      expect((await h.prompt.next()).value?.message.content).toBe('first')
      await h.bridge.receive(user('second'))
      let delivered = false
      const next = h.prompt.next().then(value => { delivered = true; return value })
      await tick()
      expect(delivered).toBe(false)
      const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'Hello' } }, session_id: sessionId }
      h.output.push(delta)
      h.output.push(result())
      expect((await next).value?.message.content).toBe('second')
      expect(h.sent[0]).toEqual(delta)
      expect(h.sent[1]).toEqual(result())
      // The real SDK owns authoritative idle transitions; result alone must not create one.
      expect(h.sent.some(message => message.subtype === 'session_state_changed')).toBe(false)
      h.output.push({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: sessionId })
      await tick()
      expect(h.sent.at(-1)?.state).toBe('idle')
      expect(h.mockQuery).toHaveBeenCalledTimes(1)
    } finally {
      h.bridge.close()
      await h.bridge.done
    }
  })

  test('routes permission decisions by native request ID and preserves edited input', async () => {
    const h = harness()
    try {
      const signal = new AbortController().signal
      const permission = h.options.canUseTool!('Bash', { command: 'fixture' }, {
        signal, requestId: 'permission-1', toolUseID: 'tool-1', agentID: 'agent-1',
        description: 'Run fixture command', defaultToNo: true,
      })
      expect(h.sent[0]).toMatchObject({
        type: 'control_request', request_id: 'permission-1', request: {
          subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-1', agent_id: 'agent-1',
          description: 'Run fixture command', default_to_no: true,
        },
      })
      const duplicate = h.options.canUseTool!('Bash', { command: 'fixture' }, { signal, requestId: 'permission-1', toolUseID: 'tool-1' })
      expect(duplicate).toBe(permission)
      expect(h.sent).toHaveLength(1)
      await h.bridge.receive(permissionReply('unrelated', { behavior: 'allow' }))
      await h.bridge.receive(permissionReply('permission-1', { behavior: 'allow', updatedInput: { command: 'edited' } }))
      expect(await permission).toEqual({ behavior: 'allow', updatedInput: { command: 'edited' } })
    } finally {
      h.bridge.close()
      await h.bridge.done
    }
  })

  test('denies malformed permission replies, aborted prompts, and unreviewable persistent grants', async () => {
    const h = harness()
    try {
      const aborted = new AbortController()
      const permission = h.options.canUseTool!('Write', { path: 'fixture' }, {
        signal: aborted.signal, requestId: 'aborted', toolUseID: 'tool-aborted',
      })
      aborted.abort()
      expect(await permission).toMatchObject({ behavior: 'deny', interrupt: true })
      expect(h.sent.at(-1)).toEqual({ type: 'control_cancel_request', request_id: 'aborted' })
      const malformed = h.options.canUseTool!('Write', {}, {
        signal: new AbortController().signal, requestId: 'malformed', toolUseID: 'tool-malformed',
      })
      await h.bridge.receive(permissionReply('malformed', { behavior: 'allow', updatedInput: 'not-an-object' }))
      expect(await malformed).toMatchObject({ behavior: 'deny' })
      const noPersistent = h.options.canUseTool!('Bash', {}, {
        signal: new AbortController().signal, requestId: 'no-persistent', toolUseID: 'tool-no-persistent', suppressAlwaysAllowRule: true,
      })
      await h.bridge.receive(permissionReply('no-persistent', { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }))
      expect(await noPersistent).toMatchObject({ behavior: 'deny' })
    } finally {
      h.bridge.close()
      await h.bridge.done
    }
  })

  test('interrupt cancels queued work and permissions, then accepts another turn', async () => {
    const h = harness()
    try {
      await h.bridge.receive(user('first'))
      await h.prompt.next()
      await h.bridge.receive(user('discard queued prompt'))
      const permission = h.options.canUseTool!('Write', {}, { signal: new AbortController().signal, requestId: 'stop-me', toolUseID: 'tool-stop-me' })
      await h.bridge.receive(control('interrupt'))
      expect(h.methods.interrupt).toHaveBeenCalledTimes(1)
      expect(await permission).toMatchObject({ behavior: 'deny', interrupt: true })
      h.output.push(result())
      await h.bridge.receive(user('after interruption'))
      expect((await h.prompt.next()).value?.message.content).toBe('after interruption')
      expect(h.mockQuery).toHaveBeenCalledTimes(1)
    } finally {
      h.bridge.close()
      await h.bridge.done
    }
  })

  test('maps controls through public methods and rejects unsupported or unauthorized controls', async () => {
    const h = harness()
    try {
      await h.bridge.receive(control('initialize'))
      expect(h.sent.at(-1)?.response.response.output_style).toBe('default')
      await h.bridge.receive(control('set_model', { model: 'claude-sonnet-5-5' }))
      expect(h.methods.setModel).toHaveBeenCalledWith('claude-sonnet-5-5')
      await h.bridge.receive(control('set_permission_mode', { mode: 'plan' }))
      expect(h.methods.setPermissionMode).toHaveBeenCalledWith('plan')
      expect(h.sent.at(-2)).toMatchObject({ type: 'system', subtype: 'status', permissionMode: 'plan' })
      await h.bridge.receive(control('set_permission_mode', { mode: 'bypassPermissions' }))
      expect(h.sent.at(-1)?.response.subtype).toBe('error')
      await h.bridge.receive(control('supported_commands'))
      expect(h.sent.at(-1)?.response.response.commands[0].name).toBe('help')
      await h.bridge.receive(control('supported_models'))
      expect(h.sent.at(-1)?.response.response.models[0].value).toBe('fixture-model')
      await h.bridge.receive(control('mcp_status'))
      expect(h.sent.at(-1)?.response.response.mcpServers).toEqual([])
      await h.bridge.receive(control('stop_task', { task_id: 'background-task' }))
      expect(h.methods.stopTask).toHaveBeenCalledWith('background-task')
      expect(h.sent.at(-1)?.response.subtype).toBe('success')
      h.methods.stopTask.mockImplementationOnce(async () => { throw new Error('Task stop failed') })
      await h.bridge.receive(control('stop_task', { task_id: 'background-task' }))
      expect(h.sent.at(-1)?.response).toMatchObject({ subtype: 'error', error: 'Task stop failed' })
      await h.bridge.receive(control('stop_task', { task_id: '' }))
      expect(h.sent.at(-1)?.response.subtype).toBe('error')
      expect(h.methods.stopTask).toHaveBeenCalledTimes(2)
      await h.bridge.receive(control('team_plan_pause'))
      expect(h.sent.at(-1)?.response).toMatchObject({ subtype: 'error', request_id: 'host-team_plan_pause' })
      await h.bridge.receive(control('initialize', { systemPrompt: 'must not be silently ignored' }))
      expect(h.sent.at(-1)?.response.subtype).toBe('error')
    } finally {
      h.bridge.close()
      await h.bridge.done
    }
  })

  test('native discovery, MCP controls and rewind use public SDK methods with validated payloads', async () => {
    const h = harness()
    try {
      for (const subtype of ['supported_agents', 'reload_plugins', 'reload_skills', 'reload_output_styles']) {
        await h.bridge.receive(control(subtype))
        expect(h.sent.at(-1)?.response.subtype).toBe('success')
      }
      await h.bridge.receive(control('mcp_reconnect', { serverName: 'fixture' }))
      expect(h.methods.reconnectMcpServer).toHaveBeenCalledWith('fixture')
      await h.bridge.receive(control('mcp_toggle', { serverName: 'fixture', enabled: false, alreadyPersisted: true }))
      expect(h.methods.toggleMcpServer).toHaveBeenCalledWith('fixture', false)
      await h.bridge.receive(control('mcp_set_servers', { servers: { fixture: { type: 'http', url: 'http://127.0.0.1:3001' } } }))
      expect(h.methods.setMcpServers).toHaveBeenCalledWith({ fixture: { type: 'http', url: 'http://127.0.0.1:3001' } })
      await h.bridge.receive(control('rewind_files', { user_message_id: sessionId, dry_run: true }))
      expect(h.methods.rewindFiles).toHaveBeenCalledWith(sessionId, { dryRun: true })
      expect(h.sent.at(-1)?.response.response.canRewind).toBe(true)
      await h.bridge.receive(control('apply_flag_settings', { settings: { effortLevel: 'low' } }))
      expect(h.methods.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'low' })
      await h.bridge.receive(control('get_context_usage', { detail: 'summary' }))
      expect(h.methods.getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })
      await h.bridge.receive(control('get_context_usage', { estimateOnly: true }))
      expect(h.methods.getContextUsage).toHaveBeenLastCalledWith({ detail: 'summary' })
      for (const [subtype, fields] of [
        ['mcp_reconnect', { serverName: '' }], ['mcp_toggle', { serverName: 'x', enabled: 'yes' }],
        ['rewind_files', { user_message_id: 'wrong' }], ['mcp_set_servers', { servers: [] }],
        ['reload_plugins', { add_plugins: [{ type: 'local', path: 'relative' }] }],
        ['apply_flag_settings', { settings: { env: { ANTHROPIC_API_KEY: 'different' } } }],
      ] as const) {
        await h.bridge.receive(control(subtype, fields))
        expect(h.sent.at(-1)?.response.subtype).toBe('error')
      }
    } finally { h.bridge.close(); await h.bridge.done }
  })

  test('host extensions share permission decisions, retain MCP servers, transform workflows and drain cleanup once', async () => {
    let permissionHandler: Options['canUseTool']
    const onTurnEnd = mock(async () => {})
    const close = mock(async () => {})
    const mcpServers = { cc_haha: { type: 'http' as const, url: 'http://127.0.0.1:3000' } }
    const h = harness(['--launch-options', JSON.stringify({ appendSystemPrompt: 'host instructions' })], undefined, {
      mcpServers, toolAliases: { TeamPlan: 'mcp__cc_haha__TeamPlan' },
      appendSystemPrompt: 'extension instructions',
      configure: context => { permissionHandler = context.canUseTool },
      transformPrompt: async text => text === '/fixture-workflow' ? 'execute saved workflow' : text,
      onTurnEnd, close,
    })
    expect(permissionHandler).toBe(h.options.canUseTool)
    expect(h.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'host instructions\n\nextension instructions' })
    expect(h.options.toolAliases).toEqual({ TeamPlan: 'mcp__cc_haha__TeamPlan' })
    await h.bridge.receive(user('/fixture-workflow'))
    expect((await h.prompt.next()).value?.message.content).toBe('execute saved workflow')
    h.output.push(result())
    await tick()
    await tick()
    expect(onTurnEnd).toHaveBeenCalledTimes(1)
    await h.bridge.receive(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/fixture-workflow' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }] } }))
    expect((await h.prompt.next()).value?.message.content).toEqual([{ type: 'text', text: 'execute saved workflow' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }])
    await h.bridge.receive(control('mcp_set_servers', { servers: {} }))
    expect(h.methods.setMcpServers).toHaveBeenCalledWith(mcpServers)
    h.bridge.close()
    h.bridge.close()
    await h.bridge.done
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('lean keeps its reduced tool and MCP contract even when host extensions are available', async () => {
    const configure = mock(() => {})
    const h = harness(['--launch-options', JSON.stringify({ agentProfile: 'lean' })], undefined, {
      configure, mcpServers: { blocked: { type: 'http', url: 'http://127.0.0.1:3000' } },
    })
    expect(h.options.strictMcpConfig).toBe(true)
    expect(h.options.mcpServers).toBeUndefined()
    expect(configure).not.toHaveBeenCalled()
    expect(h.options.tools).toEqual(['Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Skill'])
    expect(h.options.systemPrompt).toContain('Load a skill only when the user explicitly selects it')
    await h.bridge.receive(control('mcp_set_servers', { servers: { blocked: { type: 'http', url: 'http://127.0.0.1:3000' } } }))
    expect(h.sent.at(-1)?.response.subtype).toBe('error')
    await h.bridge.receive(control('set_permission_mode', { mode: 'plan' }))
    expect(h.sent.at(-1)?.response.subtype).toBe('error')
    h.bridge.close()
    await h.bridge.done
  })

  test('projects owned MCP tool names for the UI while permission grants and native events retain exact identities', async () => {
    const h = harness()
    const nativeName = 'mcp__cc_haha__TeamPlan'
    const permission = h.options.canUseTool!(nativeName, { operation: 'create' }, {
      signal: new AbortController().signal, requestId: 'mcp-approval', toolUseID: 'mcp-tool',
      suggestions: [{ type: 'addRules', rules: [{ toolName: nativeName }], behavior: 'allow', destination: 'session' }],
    })
    expect(h.sent[0].request).toMatchObject({ tool_name: 'TeamPlan', native_tool_name: nativeName, permission_suggestions: [{ rules: [{ toolName: nativeName }] }] })
    await h.bridge.receive(permissionReply('mcp-approval', { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'TeamPlan' }], behavior: 'allow', destination: 'session' }] }))
    expect(await permission).toMatchObject({ updatedPermissions: [{ rules: [{ toolName: nativeName }] }] })
    const message = { type: 'assistant', uuid: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'native-tool', name: nativeName, input: {} }] }, session_id: sessionId }
    h.output.push(message)
    await tick()
    expect(h.sent.at(-1)?.message.content[0].name).toBe('TeamPlan')
    expect(message.message.content[0].name).toBe(nativeName)
    h.output.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: message.message.content[0] }, session_id: sessionId })
    await tick()
    expect(h.sent.at(-1)?.event.content_block.name).toBe('TeamPlan')
    h.bridge.close()
    await h.bridge.done
  })

  test('app workflow stop, interruption and usage compose with the official runtime', async () => {
    const stopTask = mock(async (id: string) => id === 'app-workflow')
    const interrupt = mock(async () => {})
    const h = harness([], undefined, { stopTask, interrupt, usage: () => ({ totalCostUSD: 0.04, durationApiMs: 12, modelUsage: {} }) })
    await h.bridge.receive(control('stop_task', { task_id: 'app-workflow' }))
    expect(h.methods.stopTask).not.toHaveBeenCalled()
    await h.bridge.receive(control('stop_task', { task_id: 'native-task' }))
    expect(h.methods.stopTask).toHaveBeenCalledWith('native-task')
    await h.bridge.receive(control('interrupt'))
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(h.methods.interrupt).toHaveBeenCalledTimes(1)
    await h.bridge.receive(control('get_session_usage'))
    expect(h.sent.at(-1)?.response.response).toMatchObject({ totalCostUSD: 0.04, totalAPIDuration: 12 })
    h.output.push({ ...result(), total_cost_usd: 0.01, modelUsage: {} })
    await tick()
    expect(h.sent.at(-1)?.total_cost_usd).toBe(0.05)
    h.bridge.close()
    await h.bridge.done
  })

  test('connection closure denies outstanding approvals and terminates the real runtime handle', async () => {
    const h = harness()
    const permission = h.options.canUseTool!('Bash', {}, { signal: new AbortController().signal, requestId: 'disconnect', toolUseID: 'disconnect-tool' })
    h.bridge.close()
    expect(await permission).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(h.options.abortController?.signal.aborted).toBe(true)
    expect(h.methods.close).toHaveBeenCalledTimes(1)
    expect((await h.prompt.next()).done).toBe(true)
    await expect(h.bridge.receive(user('late'))).rejects.toThrow('closed')
    await h.bridge.done
  })

  test('end_session acknowledges shutdown and drains input before force-closing the SDK', async () => {
    const h = harness(['--thinking', 'enabled'])
    expect(h.options.thinking).toEqual({ type: 'enabled' })
    await h.bridge.receive(control('end_session', { reason: 'data_migration' }))
    expect(h.sent.at(-1)?.response).toMatchObject({ subtype: 'success', request_id: 'host-end_session' })
    expect((await h.prompt.next()).done).toBe(true)
    expect(h.methods.close).not.toHaveBeenCalled()
    h.output.close()
    await h.bridge.done
    expect(h.methods.close).toHaveBeenCalledTimes(1)
  })

  test('a broken permission transport still denies the pending tool and closes the SDK', async () => {
    const output = new OutputQueue()
    let options!: Options
    let transportOpen = true
    const close = mock(() => output.close())
    const bridge = createOfficialAgentSdkBridge(parseOfficialAgentSdkArgs(launchArgs, '/fixture', {}), {
      query: params => {
        options = params.options!
        return { initializationResult: async () => ({}), next: () => output.next(), [Symbol.asyncIterator]() { return this }, close } as unknown as Query
      },
      send: () => { if (!transportOpen) throw new Error('socket closed') },
    })
    const permission = options.canUseTool!('Write', {}, { signal: new AbortController().signal, requestId: 'broken', toolUseID: 'tool-broken' })
    transportOpen = false
    bridge.close()
    expect(await permission).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(close).toHaveBeenCalledTimes(1)
    await bridge.done
  })
})
