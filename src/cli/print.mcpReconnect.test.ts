import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Tool } from '../Tool.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import { Stream } from '../utils/stream.js'
import { StructuredIO } from './structuredIO.js'

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
process.env.ANTHROPIC_API_KEY = 'test-key'

const mcpClient = { ...await import('../services/mcp/client.js') }
const mcpConfig = { ...await import('../services/mcp/config.js') }
const contextModule = { ...await import('../commands/context/context-noninteractive.js') }
mock.module('../commands/context/context-noninteractive.js', () => ({
  ...contextModule,
  collectContextData: async ({ options }: { options: { tools: Tool[] } }) => ({ toolNames: options.tools.map(tool => tool.name) }),
}))

let isDisabled = false
let sdkSetupEnabled = false
let resolveSdkSetup: (() => void) | undefined
const sdkCleanup = mock(async () => {})
let hasConfig = true
let resolveReconnect: ((result: ReturnType<typeof reconnectResult>) => void) | undefined
const cleanup = mock(async () => {})
const clearServerCache = mock(async () => {})

function reconnectResult(
  client: MCPServerConnection = connectedClient(),
  withAssets = false,
) {
  return {
    name: 'test-server',
    client,
    tools: withAssets ? [{ name: 'mcp__test-server__lookup' } as Tool] : [],
    commands: withAssets
      ? [{ name: 'mcp__test-server__prompt', description: '', argumentHint: '' }]
      : [],
    resources: withAssets
      ? [{
          server: 'test-server',
          uri: 'test://resource',
          name: 'resource',
        }]
      : [],
  }
}

function connectedClient(): ConnectedMCPServer {
  return {
    name: 'test-server',
    type: 'connected',
    client: {} as ConnectedMCPServer['client'],
    capabilities: {},
    config: { type: 'sse', url: 'https://example.com/mcp' },
    cleanup,
  }
}

function failedClient(): MCPServerConnection {
  return {
    name: 'test-server',
    type: 'failed',
    config: { type: 'sse', url: 'https://example.com/mcp' },
    error: 'reconnect failed',
  }
}

mock.module('../services/mcp/client.js', () => ({
  ...mcpClient,
  reconnectMcpServerImpl: () =>
    new Promise<ReturnType<typeof reconnectResult>>(resolve => {
      resolveReconnect = resolve
    }),
  clearServerCache,
  setupSdkMcpClients: async () => {
    await new Promise<void>(resolve => { resolveSdkSetup = resolve })
    return {
      clients: [{ ...connectedClient(), cleanup: sdkCleanup }],
      tools: [{ name: 'unprefixed-sdk-tool', mcpInfo: { serverName: 'test-server', toolName: 'sdk' } } as Tool],
    }
  },
}))

mock.module('../services/mcp/config.js', () => ({
  ...mcpConfig,
  getMcpConfigByName: () =>
    hasConfig
      ? {
          type: 'sse',
          url: 'https://example.com/mcp',
        }
      : undefined,
  isMcpServerDisabled: () => isDisabled,
  isMcpServerDisabledForExecution: () => isDisabled,
  setMcpServerEnabled: (_name: string, enabled: boolean) => {
    isDisabled = !enabled
  },
}))

const { __runHeadlessStreamingForTests } = await import('./print.js')

function startHeadless(input: Stream<string>, initialClient?: MCPServerConnection, initialTools: Tool[] = []) {
  const io = new StructuredIO(input)
  let state = getDefaultAppState()
  state = {
    ...state,
    mcp: {
      ...state.mcp,
      clients: [
        initialClient ?? {
          name: 'test-server',
          type: 'disabled',
          config: { type: 'sse', url: 'https://example.com/mcp' },
        },
        {
          name: 'other-server',
          type: 'pending',
          config: { type: 'stdio', command: 'other' },
        },
      ],
      tools: [{ name: 'mcp__test-server__old', isReadOnly: () => true } as Tool],
      commands: [
        { name: 'mcp__test-server__old', description: '', argumentHint: '' },
      ],
      resources: { 'test-server': [] },
    },
  }
  const output = __runHeadlessStreamingForTests(
    io,
    [],
    [],
    initialTools,
    [],
    (() => undefined) as unknown as CanUseToolFn,
    sdkSetupEnabled ? { 'test-server': { type: 'sdk', name: 'test-server' } } : {},
    () => state,
    update => {
      state = update(state)
    },
    [],
    { outputFormat: 'stream-json' },
  )
  return { io, output, getState: () => state, setState: (next: typeof state) => { state = next } }
}

async function nextControlResponse(output: AsyncIterable<unknown>) {
  for await (const message of output) {
    if ((message as { type?: string }).type === 'control_response') return message
  }
  throw new Error('Missing control response')
}

afterEach(() => {
  hasConfig = true
  isDisabled = false
  sdkSetupEnabled = false
  resolveSdkSetup = undefined
  sdkCleanup.mockClear()
  resolveReconnect = undefined
  clearServerCache.mockClear()
  cleanup.mockClear()
})

afterAll(() => {
  mock.module('../services/mcp/client.js', () => mcpClient)
  mock.module('../services/mcp/config.js', () => mcpConfig)
  mock.module('../commands/context/context-noninteractive.js', () => contextModule)
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
})

describe('headless MCP reconnect races', () => {
  test('keeps a server disabled when reconnect resolves after disable', async () => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'reconnect-1',
        request: { subtype: 'mcp_reconnect', serverName: 'test-server' },
      })}\n`,
    )

    await Bun.sleep(0)
    isDisabled = true
    resolveReconnect?.(reconnectResult(connectedClient(), true))

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: 'reconnect-1', subtype: 'success' },
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(clearServerCache).not.toHaveBeenCalled()
    expect(getState().mcp.clients[0]?.type).toBe('disabled')
    expect(getState().mcp.clients[1]?.name).toBe('other-server')
    input.done()
  })

  test('keeps a server disabled when enable reconnect loses to disable', async () => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'toggle-1',
        request: {
          subtype: 'mcp_toggle',
          serverName: 'test-server',
          enabled: true,
        },
      })}\n`,
    )

    await Bun.sleep(0)
    isDisabled = true
    resolveReconnect?.(reconnectResult(connectedClient(), true))

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: 'toggle-1', subtype: 'success' },
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(clearServerCache).not.toHaveBeenCalled()
    expect(getState().mcp.clients[0]?.type).toBe('disabled')
    expect(getState().mcp.clients[1]?.name).toBe('other-server')
    input.done()
  })

  test.each([
    ['mcp_reconnect', 'missing-reconnect'],
    ['mcp_toggle', 'missing-toggle'],
  ] as const)('rejects %s when the server config is missing', async (subtype, requestId) => {
    hasConfig = false
    const input = new Stream<string>()
    const { output } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: subtype === 'mcp_reconnect'
          ? { subtype, serverName: 'missing-server' }
          : { subtype, serverName: 'missing-server', enabled: false },
      })}\n`,
    )

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: {
        request_id: requestId,
        subtype: 'error',
        error: 'Server not found: missing-server',
      },
    })
    input.done()
  })

  test('disables and clears a connected server', async () => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input, connectedClient())
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'toggle-disable',
        request: {
          subtype: 'mcp_toggle',
          serverName: 'test-server',
          enabled: false,
        },
      })}\n`,
    )

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: 'toggle-disable', subtype: 'success' },
    })
    expect(clearServerCache).toHaveBeenCalledWith(
      'test-server',
      { type: 'sse', url: 'https://example.com/mcp' },
    )
    expect(getState().mcp.clients[0]?.type).toBe('disabled')
    expect(getState().mcp.clients[1]?.name).toBe('other-server')
    input.done()
  })

  test.each([
    ['mcp_reconnect', 'reconnect-success'],
    ['mcp_toggle', 'toggle-success'],
  ] as const)('stores a successful %s result', async (subtype, requestId) => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: subtype === 'mcp_reconnect'
          ? { subtype, serverName: 'test-server' }
          : { subtype, serverName: 'test-server', enabled: true },
      })}\n`,
    )

    await Bun.sleep(0)
    resolveReconnect?.(reconnectResult(connectedClient(), true))

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: requestId, subtype: 'success' },
    })
    expect(getState().mcp.clients[0]?.type).toBe('connected')
    expect(getState().mcp.tools).toHaveLength(1)
    expect(getState().mcp.commands).toHaveLength(1)
    expect(getState().mcp.resources['test-server']).toHaveLength(1)
    input.done()
  })

  test.each([
    ['mcp_reconnect', 'reconnect-failed'],
    ['mcp_toggle', 'toggle-failed'],
  ] as const)('reports a failed %s result', async (subtype, requestId) => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: subtype === 'mcp_reconnect'
          ? { subtype, serverName: 'test-server' }
          : { subtype, serverName: 'test-server', enabled: true },
      })}\n`,
    )

    await Bun.sleep(0)
    resolveReconnect?.(reconnectResult(failedClient()))

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: {
        request_id: requestId,
        subtype: 'error',
        error: 'reconnect failed',
      },
    })
    expect(getState().mcp.clients[0]?.type).toBe('failed')
    input.done()
  })
})

test.each(['mcp_reconnect', 'mcp_toggle'] as const)(
  'preserves a later enable while stale %s cleanup is pending',
  async subtype => {
    let finishCleanup!: () => void
    const cleanupFinished = new Promise<void>(resolve => { finishCleanup = resolve })
    cleanup.mockImplementationOnce(() => cleanupFinished)
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    const iterator = output[Symbol.asyncIterator]()
    const nextResponse = async () => {
      while (true) {
        const { value, done } = await iterator.next()
        if (done) throw new Error('Missing control response')
        if (value.type === 'control_response') return value
      }
    }
    try {
      input.enqueue(`${JSON.stringify({
        type: 'control_request',
        request_id: 'old-reconnect',
        request: subtype === 'mcp_reconnect'
          ? { subtype, serverName: 'test-server' }
          : { subtype, serverName: 'test-server', enabled: true },
      })}\n`)
      await Bun.sleep(0)
      isDisabled = true
      resolveReconnect?.(reconnectResult())
      // Cleanup may wait on transport shutdown. It must not postpone the
      // disabled state write into a future enable operation.
      const response = nextResponse()
      const responded = await Promise.race([
        response.then(() => true),
        Bun.sleep(100).then(() => false),
      ])
      expect(responded).toBe(true)
      expect(getState().mcp.clients[0]?.type).toBe('disabled')
      input.enqueue(`${JSON.stringify({
        type: 'control_request',
        request_id: 'new-enable',
        request: { subtype: 'mcp_toggle', serverName: 'test-server', enabled: true },
      })}\n`)
      await Bun.sleep(0)
      const newer = connectedClient()
      resolveReconnect?.(reconnectResult(newer, true))
      await nextResponse()
      expect(isDisabled).toBe(false)
      expect(getState().mcp.clients[0]).toBe(newer)
      finishCleanup()
      await cleanupFinished
      await Bun.sleep(0)
      expect(getState().mcp.clients[0]).toBe(newer)
      expect(getState().mcp.tools).toHaveLength(1)
      expect(getState().mcp.commands).toHaveLength(1)
      expect(getState().mcp.resources['test-server']).toHaveLength(1)
    } finally {
      finishCleanup()
      input.done()
    }
  },
)

async function controlReader(output: AsyncIterable<unknown>) {
  const iterator = output[Symbol.asyncIterator]()
  return async () => {
    while (true) {
      const { value, done } = await iterator.next()
      if (done) throw new Error('Missing control response')
      if ((value as { type?: string }).type === 'control_response') return value
    }
  }
}

function enqueueControl(input: Stream<string>, requestId: string, request: Record<string, unknown>) {
  input.enqueue(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`)
}

test('removes startup and dynamic tools after disable and restores only fresh tools on enable', async () => {
  const input = new Stream<string>()
  const { output } = startHeadless(input, connectedClient(), [{ name: 'mcp__test-server__startup' } as Tool])
  const next = await controlReader(output)
  try {
    enqueueControl(input, 'reconnect', { subtype: 'mcp_reconnect', serverName: 'test-server' })
    await Bun.sleep(0)
    resolveReconnect?.(reconnectResult(connectedClient(), true))
    await next()
    enqueueControl(input, 'disable', { subtype: 'mcp_toggle', serverName: 'test-server', enabled: false })
    await next()
    enqueueControl(input, 'disabled-pool', { subtype: 'get_context_usage', estimateOnly: true })
    const disabled = await next() as { response: { response: { toolNames: string[] } } }
    expect(disabled.response.response.toolNames.filter(name => name.startsWith('mcp__test-server__'))).toEqual([])
    enqueueControl(input, 'enable', { subtype: 'mcp_toggle', serverName: 'test-server', enabled: true })
    await Bun.sleep(0)
    resolveReconnect?.(reconnectResult(connectedClient(), true))
    await next()
    enqueueControl(input, 'enabled-pool', { subtype: 'get_context_usage', estimateOnly: true })
    const enabled = await next() as { response: { response: { toolNames: string[] } } }
    expect(enabled.response.response.toolNames.filter(name => name.startsWith('mcp__test-server__'))).toEqual(['mcp__test-server__lookup'])
  } finally { input.done() }
})

test('invalidates a pending connection when disabling without a connected client', async () => {
  const input = new Stream<string>()
  const { output } = startHeadless(input, { name: 'test-server', type: 'pending', config: connectedClient().config })
  enqueueControl(input, 'disable-pending', { subtype: 'mcp_toggle', serverName: 'test-server', enabled: false })
  await nextControlResponse(output)
  expect(clearServerCache).toHaveBeenCalledTimes(1)
  input.done()
})

test('does not overwrite a newer persisted disable with a delayed enable control', async () => {
  isDisabled = true
  const input = new Stream<string>()
  const { output, getState } = startHeadless(input)
  enqueueControl(input, 'stale-enable', { subtype: 'mcp_toggle', serverName: 'test-server', enabled: true, alreadyPersisted: true })
  await Bun.sleep(0)
  // Resolve the buggy reconnect so this assertion fails without timing out.
  resolveReconnect?.(reconnectResult(connectedClient(), true))
  await nextControlResponse(output)
  expect(isDisabled).toBe(true)
  expect(resolveReconnect).toBeUndefined()
  expect(getState().mcp.clients[0]?.type).toBe('disabled')
  input.done()
})

test('filters a late initialization result from tool assembly and status after persisted disable', async () => {
  const input = new Stream<string>()
  const { output, getState, setState } = startHeadless(input, connectedClient())
  const next = await controlReader(output)
  const lateState = getState()
  enqueueControl(input, 'disable-before-init', { subtype: 'mcp_toggle', serverName: 'test-server', enabled: false })
  await next()
  setState(lateState)
  enqueueControl(input, 'late-pool', { subtype: 'get_context_usage', estimateOnly: true })
  const pool = await next() as { response: { response: { toolNames: string[] } } }
  expect(pool.response.response.toolNames.filter(name => name.startsWith('mcp__test-server__'))).toEqual([])
  enqueueControl(input, 'late-status', { subtype: 'mcp_status' })
  expect(await next()).toMatchObject({ response: { response: { mcpServers: [
    { name: 'test-server', status: 'disabled' }, { name: 'other-server' },
  ] } } })
  input.done()
})

test.each([false, true])('cleans SDK tools and transports when initialization finishes after disable: %s', async late => {
  sdkSetupEnabled = true
  const input = new Stream<string>()
  const { output, getState } = startHeadless(input, connectedClient())
  const next = await controlReader(output)
  if (!late) {
    resolveSdkSetup?.()
    await Bun.sleep(0)
  }
  enqueueControl(input, 'disable-sdk', { subtype: 'mcp_toggle', serverName: 'test-server', enabled: false })
  await next()
  if (late) {
    resolveSdkSetup?.()
    await Bun.sleep(0)
  }
  expect(sdkCleanup).toHaveBeenCalledTimes(1)
  expect(getState().mcp.tools.some(tool => tool.mcpInfo?.serverName === 'test-server')).toBe(false)
  enqueueControl(input, 'sdk-pool', { subtype: 'get_context_usage', estimateOnly: true })
  const pool = await next() as { response: { response: { toolNames: string[] } } }
  expect(pool.response.response.toolNames).not.toContain('unprefixed-sdk-tool')
  input.done()
})
