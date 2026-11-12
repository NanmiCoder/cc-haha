import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMcpToolName } from '../../../src/services/mcp/mcpStringUtils'
import { MCP_FIXTURE_CERT, startRecordingProxy, startStreamableMcpServer } from '../../../src/services/mcp/__tests__/networkProxyFixtures'
import { executeAgentFlowAgainstProvider } from '../agent-flow/live'
import { startMockLlmServer } from './server'
import { toolResultsSentUpstream } from './scenarios'
import { searchTransportBunOptions } from './searchTransportOptions'
import type { MockReply, MockRequest } from './scriptedModel'
import { connectorActionFailure } from './connectorProxyFixture'

const SCENARIO = 'mock-connector-proxy'
const MARKER = 'CONNECTOR_PROXY_CALL'
const TOOL = buildMcpToolName('plugin:office-huggingface:service', 'echo')
const text = (value: string): MockReply => ({ kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: value }] })

function respond(request: MockRequest): MockReply {
  if (!JSON.stringify(request.messages).includes('MOCK_CONNECTOR_PROXY')) return text('CONNECTOR_WARM_SESSION')
  const results = request.messages?.filter(message => message.role === 'user')
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result') ?? []
  if (results.some(block => !block.is_error && JSON.stringify(block.content).includes(`echo:${MARKER}`))) return text('CONNECTOR_RESULT_REACHED_MODEL')
  const name = request.tools?.some(tool => tool.name === TOOL) ? TOOL : 'ToolSearch'
  const input = name === TOOL ? { value: MARKER } : { query: `select:${TOOL}` }
  return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: name === TOOL ? 'connector-echo' : 'connector-search', name, input }] }
}

/** Real connector API → plugin files/reload → old and new CLI → TLS MCP tool. */
export async function runConnectorProxyScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const certificate = join(artifactDir, 'fixture-ca.pem')
  writeFileSync(certificate, MCP_FIXTURE_CERT)
  writeFileSync(join(artifactDir, 'preload.ndjson'), '')
  const mcp = startStreamableMcpServer({ tls: true })
  const proxy = await startRecordingProxy(mcp.port, { tunnelTls: true })
  const upstream = startMockLlmServer(respond)
  const evidence: Record<string, unknown> = { scenario: SCENARIO, endpoint: 'https://mcp.blocked.test/mcp', pluginBridgeStubbed: false, realCli: true, credentialStore: 'sandboxed fake file, no OS keychain' }
  try {
    const results = await executeAgentFlowAgainstProvider({
      rootDir, artifactDir, label: SCENARIO, seedProviders: false, stepTimeoutMs: 60_000,
      serverPreload: join(rootDir, 'scripts/quality-gate/mock-llm/connectorProxyTransport.ts'),
      scenarios: [{ id: SCENARIO, title: 'Save a proxied connector, reload its persisted plugin into an existing CLI and call it from old/new sessions' }],
      envOverrides: {
        BUN_OPTIONS: searchTransportBunOptions(join(rootDir, 'scripts/quality-gate/mock-llm/connectorProxyTransport.ts')),
        MOCK_CONNECTOR_ENDPOINT: 'https://mcp.blocked.test/mcp',
        MOCK_CONNECTOR_TRACE: join(artifactDir, 'preload.ndjson'),
        CC_HAHA_SYSTEM_PROXY_URL: proxy.url,
        NODE_EXTRA_CA_CERTS: certificate,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH: '1',
      },
      async resolveTarget({ baseUrl }) {
        const response = await fetch(`${baseUrl}/api/providers`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ presetId: 'custom', name: 'Offline connector model', apiKey: 'fake-connector-model-key', baseUrl: upstream.url,
            apiFormat: 'anthropic', models: { main: 'mock-model', haiku: 'mock-model', sonnet: 'mock-model', opus: 'mock-model' } }),
        })
        assert.ok(response.ok)
        const body = await response.json() as { id?: string, provider?: { id?: string } }
        const providerId = body.id ?? body.provider?.id
        assert.ok(providerId)
        return { providerId, providerName: 'Offline connector model', modelId: 'mock-model', host: upstream.url, source: SCENARIO }
      },
      runners: {
        async [SCENARIO](ctx) {
          const sessionId = await ctx.createSession()
          const oldSocket = await ctx.openSocket(sessionId)
          ctx.pinRuntime(oldSocket)
          let newSocket: Awaited<ReturnType<typeof ctx.openSocket>> | undefined
          const connectorUrl = `${ctx.baseUrl}/api/connectors/huggingface`
          async function action(kind: string, body: object = {}) {
            const response = await fetch(`${connectorUrl}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            if (response.status !== 202) {
              const failure = connectorActionFailure(kind, response.status, await response.json().catch(() => null))
              evidence.actionFailure = failure
              assert.equal(response.status, 202, JSON.stringify(failure))
            }
            const deadline = Date.now() + 30_000
            while (Date.now() < deadline) {
              const current = await fetch(connectorUrl)
              assert.ok(current.ok)
              const { connector } = await current.json() as { connector: { operation?: unknown, status: string, error?: string } }
              if (!connector.operation) return connector
              await Bun.sleep(40)
            }
            throw new Error(`Connector ${kind} did not settle`)
          }
          try {
            oldSocket.send({ type: 'user_message', content: 'Warm this existing conversation before a connector is installed.' })
            await oldSocket.waitFor(message => message.type === 'message_complete', ctx.stepTimeoutMs, 'warm CLI before connector installation')
            assert.equal((await action('prepare', { sessionId })).status, 'needs-auth')
            const checked = await action('authenticate', { sessionId, configuration: { apiKey: 'fake-connector-api-key' } })
            evidence.checkedConnector = checked
            assert.equal(checked.status, 'ready', checked.error)
            assert.equal(mcp.methods.filter(method => method === 'tools/call').length, 0, 'verification must not invoke business tools')
            const pluginFile = join(ctx.configDir, 'connectors/marketplace/plugins/office-huggingface/.mcp.json')
            const plugin = readFileSync(pluginFile, 'utf8')
            assert.ok(plugin.includes('https://mcp.blocked.test/mcp'))
            assert.ok(!plugin.includes('fake-connector-api-key'))
            evidence.pluginPersistedWithCredentialPlaceholder = true
            newSocket = await ctx.openSocket(await ctx.createSession())
            ctx.pinRuntime(newSocket)
            for (const socket of [oldSocket, newSocket]) {
              const since = upstream.requests.length
              const start = socket.messages.length
              socket.send({ type: 'user_message', content: 'MOCK_CONNECTOR_PROXY' })
              const settled = await socket.waitFor(message => message.type === 'permission_request' || message.type === 'message_complete', ctx.stepTimeoutMs, 'connector tool permission or completion', start)
              if (settled.type === 'permission_request') socket.send({ type: 'permission_response', requestId: settled.requestId, allowed: true, rule: 'agent-flow-mock' })
              await socket.waitFor(message => message.type === 'message_complete', ctx.stepTimeoutMs, 'connector tool result', start)
              assert.ok(toolResultsSentUpstream(upstream.requests, since).some(result => !result.is_error && JSON.stringify(result.content).includes(`echo:${MARKER}`)), 'actual MCP tool result must reach the scripted model')
            }
            assert.equal(mcp.methods.filter(method => method === 'tools/call').length, 2)
            assert.ok(proxy.requests.some(request => request === 'CONNECT mcp.blocked.test:443'))
            assert.ok(mcp.requests.filter(request => request.rpc).every(request => request.headers.authorization === 'Bearer fake-connector-api-key'))
            evidence.oldCliReloaded = true
            evidence.newCliLoadedPersistedPlugin = true
            evidence.realToolResultsReachedModel = 2
          } finally {
            oldSocket.close()
            newSocket?.close()
          }
        },
      },
    })
    evidence.results = results
    assert.ok(results.every(result => result.status === 'passed'), JSON.stringify(results))
  } finally {
    evidence.methods = mcp.methods
    evidence.proxyRequests = proxy.requests
    await upstream.stop()
    await proxy.close()
    await mcp.stop()
    evidence.fixtureProcessesStopped = true
    writeFileSync(join(artifactDir, 'connector-proxy.json'), JSON.stringify(evidence, null, 2) + '\n')
  }
}
