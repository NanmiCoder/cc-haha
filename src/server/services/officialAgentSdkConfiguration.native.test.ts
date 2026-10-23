import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'

test('native SDK loads CLAUDE.md, skills, plugin, hooks and project MCP without overriding the selected provider', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-sdk-native-config-'))
  const workDir = join(sandbox, 'project')
  const configDir = join(sandbox, '.claude')
  const plugin = join(configDir, 'plugins', 'cache', 'fixture-market', 'configuration-fixture', '1.0.0')
  const sessionId = crypto.randomUUID()
  const leanSessionId = crypto.randomUUID()
  const hookFile = join(sandbox, 'hook-ran.txt')
  const deniedFile = join(workDir, 'denied-by-hook.txt')
  const mcpCalls: string[] = []
  const mcpMethods: string[] = []
  const mcp = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const message = await request.json() as Record<string, any>
    mcpMethods.push(message.method)
    if (message.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Return configuration fixture evidence', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
    else if (message.method === 'tools/call') { mcpCalls.push(message.params.name); result = { content: [{ type: 'text', text: 'MCP_CONFIGURATION_FIXTURE_OK' }] } }
    else result = {}
    return Response.json({ jsonrpc: '2.0', id: message.id, result })
  } })
  const model = startMockLlmServer(request => {
    const wire = JSON.stringify(request.messages)
    if (!wire.includes('OFFLINE_SDK_CONFIG')) return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'Auxiliary fixture.' }] }
    if (!wire.includes('MCP_CONFIGURATION_FIXTURE_OK')) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_fixture_mcp', name: 'mcp__fixture__echo', input: {} }] }
    if (!wire.includes('SKILL_CONFIGURATION_FIXTURE_BODY')) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_fixture_skill', name: 'Skill', input: { skill: 'fixture-project' } }] }
    if (!wire.includes('HOOK_CONFIGURATION_FIXTURE_DENIED')) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_fixture_write', name: 'Write', input: { file_path: deniedFile, content: 'forbidden' } }] }
    return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'Configuration fixture complete.' }] }
  })
  const apiKeys: (string | null)[] = []
  const selectedEndpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    apiKeys.push(request.headers.get('x-api-key'))
    const upstream = new URL(new URL(request.url).pathname + new URL(request.url).search, model.url)
    return fetch(upstream, { method: request.method, headers: request.headers, body: await request.arrayBuffer() })
  } })
  const events: Record<string, any>[] = []
  let socket: ServerWebSocket<{}> | undefined
  const server = Bun.serve<{}>({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if ([`/sdk/${sessionId}`, `/sdk/${leanSessionId}`].includes(url.pathname) && url.searchParams.get('token') === 'fixture' && server.upgrade(request, { data: {} })) return
      return new Response('unauthorized', { status: 401 })
    }, websocket: { open(ws) { socket = ws }, message(ws, data) {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const event = JSON.parse(line)
        events.push(event)
        if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') ws.send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: event.request.input } } }))
      }
    } },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stderr: Promise<string> = Promise.resolve('')
  try {
    for (const dir of [join(workDir, '.claude', 'skills', 'fixture-project'), join(configDir, 'skills', 'fixture-user'), join(plugin, '.claude-plugin'), join(plugin, 'skills', 'fixture-plugin')]) await mkdir(dir, { recursive: true })
    await writeFile(join(workDir, 'CLAUDE.md'), 'CLAUDE_PROJECT_CONFIGURATION_FIXTURE\n')
    await writeFile(join(configDir, 'CLAUDE.md'), 'CLAUDE_USER_CONFIGURATION_FIXTURE\n')
    await writeFile(join(workDir, '.claude', 'skills', 'fixture-project', 'SKILL.md'), '---\nname: fixture-project\ndescription: Project fixture skill\n---\nSKILL_CONFIGURATION_FIXTURE_BODY\n')
    await writeFile(join(configDir, 'skills', 'fixture-user', 'SKILL.md'), '---\nname: fixture-user\ndescription: User fixture skill\n---\nUSER_SKILL_CONFIGURATION_FIXTURE_BODY\n')
    await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'configuration-fixture', version: '1.0.0' }))
    await writeFile(join(plugin, 'skills', 'fixture-plugin', 'SKILL.md'), '---\nname: fixture-plugin\ndescription: Plugin fixture skill\n---\nPLUGIN_CONFIGURATION_FIXTURE_BODY\n')
    const hookScript = join(sandbox, 'hook.ts')
    await writeFile(hookScript, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(hookFile)}, 'hook executed'); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'HOOK_CONFIGURATION_FIXTURE_DENIED'}}))`)
    const userSettings = { enabledPlugins: { 'configuration-fixture@fixture-market': true }, env: { ANTHROPIC_API_KEY: 'wrong-settings-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'wrong-token', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'wrong-model' }, model: 'wrong-model' }
    const projectSettings = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}` }] }] } }
    const market = join(sandbox, 'market')
    await mkdir(join(market, '.claude-plugin'), { recursive: true })
    await cp(plugin, join(market, 'configuration-fixture'), { recursive: true })
    await writeFile(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'fixture-market', owner: { name: 'Fixture' }, plugins: [{ name: 'configuration-fixture', source: './configuration-fixture', version: '1.0.0' }] }))
    await writeFile(join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'fixture-market': { source: { source: 'directory', path: market }, installLocation: market, lastUpdated: '2026-01-01T00:00:00.000Z', autoUpdate: false } }))
    await writeFile(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'configuration-fixture@fixture-market': [{ scope: 'user', installPath: plugin, version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z' }] } }))
    await writeFile(join(configDir, 'settings.json'), JSON.stringify(userSettings))
    await writeFile(join(workDir, '.claude', 'settings.json'), JSON.stringify(projectSettings))
    await writeFile(join(workDir, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    await writeFile(join(workDir, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { type: 'http', url: `http://127.0.0.1:${mcp.port}/mcp` } } }))
    const env = createSandboxedTestEnvironment(sandbox, {
      ANTHROPIC_API_KEY: 'fake-selected-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${selectedEndpoint.port}`, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', ENABLE_TOOL_SEARCH: 'false',
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    })
    child = Bun.spawn([process.execPath, '--no-env-file', 'run', resolve(import.meta.dir, '../../entrypoints/officialAgentSdk.ts'), '--sdk-url', `ws://127.0.0.1:${server.port}/sdk/${sessionId}?token=fixture`, '--session-id', sessionId, '--model', 'claude-haiku-5-5', '--launch-options', JSON.stringify({ maxTurns: 8 })], { cwd: workDir, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
    stderr = new Response(child.stderr).text()
    async function waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 25_000
      while (!predicate()) {
        if (child!.exitCode !== null) throw new Error(`Native config runtime exited: ${await stderr}`)
        if (Date.now() >= deadline) throw new Error(`Native config timed out: ${JSON.stringify(events)}`)
        await Bun.sleep(50)
      }
    }
    await waitFor(() => Boolean(socket))
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'reload', request: { subtype: 'reload_plugins' } }))
    await waitFor(() => events.some(event => event.response?.request_id === 'reload'))
    const reload = events.find(event => event.response?.request_id === 'reload')!.response
    expect(reload.subtype).toBe('success')
    expect(reload.response.commands.map((command: { name: string }) => command.name)).toEqual(expect.arrayContaining(['fixture-project', 'fixture-user', 'configuration-fixture:fixture-plugin']))
    expect(reload.response.plugins.some((item: { name: string }) => item.name === 'configuration-fixture')).toBe(true)
    socket!.send(JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'OFFLINE_SDK_CONFIG' } }))
    await waitFor(() => events.some(event => event.type === 'result'))
    expect(events.find(event => event.type === 'result')).toMatchObject({ is_error: false })
    expect(mcpCalls).toEqual(['echo'])
    expect(apiKeys.length).toBeGreaterThan(0)
    expect(apiKeys.every(key => key === 'fake-selected-key')).toBe(true)
    expect(await readFile(hookFile, 'utf8')).toBe('hook executed')
    expect(existsSync(deniedFile)).toBe(false)
    const requestText = JSON.stringify(model.requests.map(request => request.body))
    for (const marker of ['CLAUDE_PROJECT_CONFIGURATION_FIXTURE', 'CLAUDE_USER_CONFIGURATION_FIXTURE', 'SKILL_CONFIGURATION_FIXTURE_BODY', 'HOOK_CONFIGURATION_FIXTURE_DENIED', 'MCP_CONFIGURATION_FIXTURE_OK']) expect(requestText).toContain(marker)
    expect(model.requests.every(request => request.body.model === 'claude-haiku-5-5')).toBe(true)
    expect(JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))).toEqual(userSettings)
    expect(JSON.parse(await readFile(join(workDir, '.claude', 'settings.json'), 'utf8'))).toEqual(projectSettings)
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'end', request: { subtype: 'end_session' } }))
    expect(await child.exited).toBe(0)
    const previousMcpCount = mcpMethods.length
    events.length = 0
    socket = undefined
    child = Bun.spawn([process.execPath, '--no-env-file', 'run', resolve(import.meta.dir, '../../entrypoints/officialAgentSdk.ts'), '--sdk-url', `ws://127.0.0.1:${server.port}/sdk/${leanSessionId}?token=fixture`, '--session-id', leanSessionId, '--model', 'claude-haiku-5-5', '--launch-options', JSON.stringify({ agentProfile: 'lean', plugins: [{ type: 'local', path: plugin }] })], { cwd: workDir, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
    stderr = new Response(child.stderr).text()
    await waitFor(() => Boolean(socket))
    socket!.send(JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'OFFLINE_SDK_LEAN' } }))
    await waitFor(() => events.some(event => event.type === 'result'))
    expect(events.find(event => event.type === 'result')).toMatchObject({ is_error: false })
    expect(mcpMethods).toHaveLength(previousMcpCount)
    const init = events.find(event => event.type === 'system' && event.subtype === 'init')
    expect(init.tools).toContain('Read')
    expect(init.tools).not.toContain('Agent')
    expect(init.tools.some((tool: string) => tool.startsWith('mcp__'))).toBe(false)
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'end-lean', request: { subtype: 'end_session' } }))
    expect(await child.exited).toBe(0)
  } finally {
    socket?.close()
    if (child?.exitCode === null) child.kill()
    await child?.exited
    await server.stop(true)
    await mcp.stop(true)
    await selectedEndpoint.stop(true)
    await model.stop()
    await rm(sandbox, { recursive: true, force: true })
  }
}, 60_000)
