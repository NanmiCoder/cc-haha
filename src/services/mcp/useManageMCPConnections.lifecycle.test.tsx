import '../../../preload.ts'
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import React from 'react'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from './types.js'

const appStateModule = { ...await import('../../state/AppState.js') }
const clientModule = { ...await import('./client.js') }
const configModule = { ...await import('./config.js') }

let state: AppState
let closeHandler: ((name: string, client: ConnectedMCPServer['client']) => void) | undefined
let isDisabled = true
let transportType: 'sse' | 'stdio' = 'sse'
const reconnectMcpServerImpl = mock(async () => ({
  name: 'test-server',
  client: connectedServer(),
  tools: [],
  commands: [],
  resources: [],
}))

const store = {
  getState: () => state,
  setState: (updater: (previous: AppState) => AppState) => {
    state = updater(state)
  },
  subscribe: () => () => {},
}

mock.module('../../state/AppState.js', () => ({
  ...appStateModule,
  useAppStateStore: () => store,
  useSetAppState: () => store.setState,
  useAppState: (selector: (current: AppState) => unknown) => selector(state),
}))

mock.module('./client.js', () => ({
  ...clientModule,
  setMcpConnectionClosedHandler: (handler: typeof closeHandler) => {
    closeHandler = handler
  },
  getMcpToolsCommandsAndResources: async () => {},
  reconnectMcpServerImpl,
}))

mock.module('./config.js', () => ({
  ...configModule,
  getClaudeCodeMcpConfigs: async () => ({ servers: {}, errors: [] }),
  fetchClaudeAIMcpConfigsIfEligible: async () => ({}),
  doesEnterpriseMcpConfigExist: () => false,
  isMcpServerDisabled: () => isDisabled,
}))

const { useManageMCPConnections } = await import('./useManageMCPConnections.js')

let actions: ReturnType<typeof useManageMCPConnections>

function Harness({ configs }: { configs?: Record<string, ScopedMcpServerConfig> }) {
  actions = useManageMCPConnections(configs)
  return null
}

function connectedServer(): ConnectedMCPServer {
  return {
    name: 'test-server',
    type: 'connected',
    client: {} as ConnectedMCPServer['client'],
    capabilities: {},
    config:
      transportType === 'sse'
        ? { type: 'sse', url: 'https://example.com/mcp' }
        : { type: 'stdio', command: 'test' },
    cleanup: async () => {},
  }
}

beforeEach(() => {
  closeHandler = undefined
  isDisabled = true
  transportType = 'sse'
  reconnectMcpServerImpl.mockClear()
  reconnectMcpServerImpl.mockImplementation(async () => ({
    name: 'test-server',
    client: connectedServer(),
    tools: [],
    commands: [],
    resources: [],
  }))
  state = getDefaultAppState()
  state = {
    ...state,
    mcp: {
      ...state.mcp,
      clients: [connectedServer()],
    },
  }
})

afterAll(() => {
  mock.module('../../state/AppState.js', () => appStateModule)
  mock.module('./client.js', () => clientModule)
  mock.module('./config.js', () => configModule)
})

afterEach(() => {
  closeHandler = undefined
})

describe('useManageMCPConnections close lifecycle', () => {
  test('marks a disabled server after its connection closes', async () => {
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    expect(closeHandler).toBeDefined()
    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(20)

    expect(state.mcp.clients).toContainEqual({
      name: 'test-server',
      type: 'disabled',
      config: { type: 'sse', url: 'https://example.com/mcp' },
    })
    app.unmount()
  })

  test('reconnects an enabled remote server after its connection closes', async () => {
    isDisabled = false
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(20)

    expect(reconnectMcpServerImpl).toHaveBeenCalledWith(
      'test-server',
      { type: 'sse', url: 'https://example.com/mcp' },
    )
    expect(state.mcp.clients[0]?.type).toBe('connected')
    app.unmount()
  })

  test('marks local transports failed without reconnecting', async () => {
    isDisabled = false
    transportType = 'stdio'
    state = {
      ...state,
      mcp: { ...state.mcp, clients: [connectedServer()] },
    }
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(20)

    expect(reconnectMcpServerImpl).not.toHaveBeenCalled()
    expect(state.mcp.clients[0]?.type).toBe('failed')
    app.unmount()
  })

  test('stops automatic reconnect when disable wins before the attempt', async () => {
    isDisabled = false
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    isDisabled = true
    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(20)

    expect(reconnectMcpServerImpl).not.toHaveBeenCalled()
    app.unmount()
  })

  test('records the final automatic reconnect failure', async () => {
    isDisabled = false
    reconnectMcpServerImpl.mockImplementation(async () => ({
      name: 'test-server',
      client: {
        name: 'test-server',
        type: 'failed',
        config: { type: 'sse', url: 'https://example.com/mcp' },
        error: 'reconnect failed',
      },
      tools: [],
      commands: [],
      resources: [],
    }))
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(15_100)

    expect(reconnectMcpServerImpl).toHaveBeenCalledTimes(5)
    expect(state.mcp.clients[0]?.type).toBe('failed')
    app.unmount()
  }, 20_000)

  test('records the final automatic reconnect exception', async () => {
    isDisabled = false
    reconnectMcpServerImpl.mockRejectedValue(new Error('network failed'))
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(15_100)

    expect(reconnectMcpServerImpl).toHaveBeenCalledTimes(5)
    expect(state.mcp.clients[0]?.type).toBe('failed')
    app.unmount()
  }, 20_000)

  test('unregisters the close handler on unmount', async () => {
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)
    expect(closeHandler).toBeDefined()

    app.unmount()
    await Bun.sleep(0)

    expect(closeHandler).toBeUndefined()
  })
})


test('ignores a previous connection close after an explicit reconnect', async () => {
  isDisabled = false
  const previous = state.mcp.clients[0] as ConnectedMCPServer
  const app = render(<Harness />, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitOnCtrlC: false,
    patchConsole: false,
  })
  try {
    await Bun.sleep(0)
    await actions.reconnectMcpServer('test-server')
    await Bun.sleep(20)
    const current = state.mcp.clients[0] as ConnectedMCPServer
    expect(current.type).toBe('connected')
    expect(current.client).not.toBe(previous.client)
    expect(reconnectMcpServerImpl).toHaveBeenCalledTimes(1)
    closeHandler?.('test-server', previous.client)
    await Bun.sleep(20)
    expect(reconnectMcpServerImpl).toHaveBeenCalledTimes(1)
    expect(state.mcp.clients[0]).toBe(current)
  } finally {
    app.unmount()
  }
})


describe('MCP list change notification cache isolation', () => {
  test.each(['tools', 'prompts', 'resources'] as const)(
    '%s notification refreshes only the originating project for same-name servers',
    async (kind) => {
      isDisabled = false
      const root = mkdtempSync(join(tmpdir(), 'qa005-notification-'))
      const firstProject = join(root, 'first')
      const secondProject = join(root, 'second')
      mkdirSync(firstProject)
      mkdirSync(secondProject)
      const connections: ConnectedMCPServer[] = []
      const fetchers = {
        tools: clientModule.fetchToolsForClient,
        prompts: clientModule.fetchCommandsForClient,
        resources: clientModule.fetchResourcesForClient,
      }
      const schemas = {
        tools: ToolListChangedNotificationSchema,
        prompts: PromptListChangedNotificationSchema,
        resources: ResourceListChangedNotificationSchema,
      }
      let app: ReturnType<typeof render> | undefined
      let notificationSpy: ReturnType<typeof spyOn> | undefined
      try {
        async function createFixture(project: string, label: string) {
          let version = 1
          const requests: string[] = []
          const result = await runWithCwdOverride(project, () => clientModule.setupSdkMcpClients(
            { 'test-server': { type: 'sdk', name: 'test-server' } },
            async (_name, message) => {
              if (!('method' in message) || !('id' in message)) return message
              const method = message.method
              requests.push(method)
              const itemName = `${label}-v${version}`
              const result = method === 'initialize'
                ? {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                      tools: { listChanged: true },
                      prompts: { listChanged: true },
                      resources: { listChanged: true },
                    },
                    serverInfo: { name: 'notification-fixture', version: '1' },
                  }
                : method === 'tools/list'
                  ? { tools: [{ name: itemName, inputSchema: { type: 'object' } }] }
                  : method === 'prompts/list'
                    ? { prompts: [{ name: itemName }] }
                    : { resources: [{ name: itemName, uri: `fixture://${itemName}` }] }
              return { jsonrpc: '2.0', id: message.id, result }
            },
          ))
          const client = result.clients[0]
          if (!client || client.type !== 'connected') throw new Error(`Fixture must connect: ${JSON.stringify(client)}`)
          connections.push(client)
          return { client, requests, advance: () => { version++ } }
        }

        const first = await createFixture(firstProject, 'first')
        const second = await createFixture(secondProject, 'second')
        const fetchList = fetchers[kind]
        const firstBefore = await fetchList(first.client)
        const secondBefore = await fetchList(second.client)
        const firstRequestsBefore = first.requests.filter(method => method === `${kind}/list`).length
        const secondRequestsBefore = second.requests.filter(method => method === `${kind}/list`).length
        expect(firstBefore).not.toBe(secondBefore)

        let notify: (() => Promise<void>) | undefined
        const setNotificationHandler = first.client.client.setNotificationHandler.bind(first.client.client)
        notificationSpy = spyOn(first.client.client, 'setNotificationHandler').mockImplementation((schema, handler) => {
          if (schema === schemas[kind]) notify = handler as () => Promise<void>
          setNotificationHandler(schema, handler)
        })
        state = { ...state, mcp: { ...state.mcp, clients: [first.client] } }
        reconnectMcpServerImpl.mockResolvedValue({
          name: 'test-server', client: first.client, tools: [], commands: [], resources: [],
        })
        app = render(<Harness configs={{ 'test-server': first.client.config }} />, {
          stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
          exitOnCtrlC: false, patchConsole: false,
        })
        await Bun.sleep(0)
        await actions.reconnectMcpServer('test-server')
        expect(notify).toBeDefined()

        first.advance()
        second.advance()
        // Delivery can occur while a different project is active. The client
        // that registered the handler still owns this notification's cache.
        await runWithCwdOverride(secondProject, () => notify!())
        await Bun.sleep(20)
        const firstAfter = await fetchList(first.client)
        const secondAfter = await fetchList(second.client)
        expect(firstAfter).not.toBe(firstBefore)
        expect(firstAfter[0]?.name).toContain('first-v2')
        expect(secondAfter).toBe(secondBefore)
        expect(secondAfter[0]?.name).toContain('second-v1')
        expect(first.requests.filter(method => method === `${kind}/list`)).toHaveLength(firstRequestsBefore + 1)
        expect(second.requests.filter(method => method === `${kind}/list`)).toHaveLength(secondRequestsBefore)
        const published = kind === 'tools'
          ? state.mcp.tools
          : kind === 'prompts'
            ? state.mcp.commands
            : state.mcp.resources['test-server']
        expect(published?.[0]?.name).toContain('first-v2')
      } finally {
        app?.unmount()
        notificationSpy?.mockRestore()
        await Promise.all(connections.map(connection => connection.cleanup()))
        for (const fetchList of Object.values(fetchers)) fetchList.cache.clear()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
