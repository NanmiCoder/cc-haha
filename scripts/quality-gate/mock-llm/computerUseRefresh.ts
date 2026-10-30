import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createQualityGateSandbox } from '../sandbox'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const textReply = (text: string): MockReply => ({
  kind: 'message',
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
})
const COMPUTER_PREFIX = 'mcp__computer-use__'

/** Real CLI, real MCP transports, scripted model; only the native boundary is a fixture. */
export async function runComputerUseRefreshScenario(rootDir: string, artifactDir: string): Promise<'passed' | 'skipped'> {
  mkdirSync(artifactDir, { recursive: true })
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return 'skipped'
  }
  const sandbox = createQualityGateSandbox({
    label: 'computer-use-refresh',
    seedProviders: false,
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
  })
  const workDir = join(sandbox.home, 'project')
  const configPath = join(sandbox.configDir, 'cc-haha', 'computer-use-config.json')
  const fixtureLog = join(sandbox.configDir, 'computer-use-native-fixture.ndjson')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(sandbox.configDir, 'cc-haha'), { recursive: true })
  const setEnabled = (enabled: boolean) => writeFileSync(configPath, JSON.stringify({
    enabled,
    grantFlags: { clipboardRead: true, clipboardWrite: true, systemKeyCombos: true },
  }))
  const agentRequests: MockRequest[] = []
  let skillProbe: {
    issued: boolean
    result?: { is_error?: boolean, content?: unknown }
    messages?: string
  } | undefined
  const upstream = startMockLlmServer(request => {
    if (!request.tools?.some(tool => tool.name === 'Read')) return textReply('Mock auxiliary reply')
    agentRequests.push(request)
    if (skillProbe) {
      if (!skillProbe.issued) {
        skillProbe.issued = true
        return {
          kind: 'message',
          content: [{
            type: 'tool_use',
            id: 'computer_use_enabled_skill',
            name: 'Skill',
            input: { skill: 'computer-use' },
          }],
          stopReason: 'tool_use',
        }
      }
      skillProbe.result = request.messages?.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === 'computer_use_enabled_skill')
      skillProbe.messages = JSON.stringify(request.messages)
    }
    return textReply('COMPUTER_USE_INVENTORY_CAPTURED')
  })
  const otherServerPath = join(sandbox.home, 'other-mcp.cjs')
  writeFileSync(otherServerPath, String.raw`
    let buffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', data => {
      buffer += data
      for (;;) {
        const at = buffer.indexOf('\n')
        if (at < 0) break
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (!line.trim()) continue
        const req = JSON.parse(line)
        if (req.id === undefined) continue
        const result = req.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'other-fixture', version: '1' },
            }
          : req.method === 'tools/list'
            ? {
                tools: [{
                  name: 'business',
                  description: 'Unrelated fixture business tool',
                  inputSchema: { type: 'object', properties: {} },
                }],
              }
            : {}
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
      }
    })
    process.stdin.on('end', () => process.exit(0))
  `)
  writeFileSync(join(sandbox.configDir, '.claude.json'), JSON.stringify({
    mcpServers: {
      unrelated_fixture: { type: 'stdio', command: process.execPath, args: [otherServerPath] },
    },
  }))
  const connections = () => existsSync(fixtureLog)
    ? readFileSync(fixtureLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid: number })
    : []
  const captures: Array<{
    profile: string
    phase: string
    pid: number
    tools: string[]
    connections: number
    skill?: { returned: boolean, isError: boolean, workflowLoaded: boolean }
  }> = []

  async function run(
    profile: 'standard' | 'lean',
    boundary: 'allowed' | 'cli-disabled' | 'env-disabled' | 'helper-unavailable' = 'allowed',
  ) {
    rmSync(configPath, { force: true })
    const label = boundary === 'allowed' ? profile : boundary
    const child = Bun.spawn([
      process.execPath, '--no-env-file', '--preload', join(rootDir, 'preload.ts'),
      '--preload', join(rootDir, 'scripts/quality-gate/mock-llm/computerUseNativeFixture.ts'),
      join(rootDir, 'src/entrypoints/cli.tsx'), '--print', '--agent-profile', profile, '--model', 'mock-model',
      '--permission-mode', 'bypassPermissions', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      ...(boundary === 'cli-disabled' ? ['--no-computer-use'] : []),
    ], {
      cwd: workDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...sandbox.env,
        CALLER_DIR: workDir,
        CC_HAHA_SKIP_DOTENV: '1',
        ANTHROPIC_BASE_URL: upstream.url,
        ANTHROPIC_API_KEY: 'mock-api-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        MOCK_COMPUTER_USE_FIXTURE_LOG: fixtureLog,
        ...(boundary === 'env-disabled' ? { CLAUDE_COMPUTER_USE_ENABLED: 'false' } : {}),
        ...(boundary === 'helper-unavailable' ? { MOCK_COMPUTER_USE_HELPER_UNAVAILABLE: '1' } : {}),
        CI: '1',
        MCP_TIMEOUT: '3000',
      },
    })
    let stdout = ''
    let stderr = ''
    let results = 0
    const drainOut = (async () => {
      const decoder = new TextDecoder()
      let pending = ''
      for await (const data of child.stdout) {
        const text = decoder.decode(data, { stream: true })
        stdout += text
        pending += text
        for (;;) {
          const at = pending.indexOf('\n')
          if (at < 0) break
          const line = pending.slice(0, at)
          pending = pending.slice(at + 1)
          try {
            if (JSON.parse(line).type === 'result') results++
          } catch {}
        }
      }
    })()
    const drainErr = (async () => {
      stderr = await new Response(child.stderr).text()
    })()
    async function turn(phase: string, enabled: boolean | null) {
      if (enabled !== null) setEnabled(enabled)
      const verifySkill = phase === 'enabled-next-turn' && profile === 'standard' && boundary === 'allowed'
      skillProbe = verifySkill ? { issued: false } : undefined
      const before = agentRequests.length
      const beforeResults = results
      const content = `${verifySkill ? 'Use the Skill tool with skill: "computer-use" for this request.\n\n' : ''}Report inventory for ${phase}.`
      child.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: '',
      }) + '\n')
      await child.stdin.flush()
      const deadline = Date.now() + 60_000
      while (results === beforeResults && child.exitCode === null && Date.now() < deadline) {
        await Bun.sleep(20)
      }
      assert.ok(results > beforeResults, `CLI did not complete ${phase}: ${stderr}\n${stdout}`)
      const request = agentRequests.slice(before).at(-1)
      assert.ok(request, `${phase} never reached the model`)
      const tools = request.tools!.map(tool => tool.name!).sort()
      const workflowLoaded = Boolean(skillProbe?.messages?.includes(
        process.platform === 'win32' ? 'Operating Windows apps' : 'Operating Mac apps',
      ))
      captures.push({
        profile: label,
        phase,
        pid: child.pid,
        tools,
        connections: connections().filter(row => row.pid === child.pid).length,
        ...(verifySkill ? {
          skill: {
            returned: Boolean(skillProbe?.result),
            isError: Boolean(skillProbe?.result?.is_error),
            workflowLoaded,
          },
        } : {}),
      })
      if (profile === 'standard') {
        assert.ok(tools.includes('mcp__unrelated_fixture__business'), 'refresh dropped an unrelated MCP server')
      }
      const computerTools = tools.filter(name => name.startsWith(COMPUTER_PREFIX))
      if (enabled && profile === 'standard' && boundary === 'allowed') {
        const required = process.platform === 'darwin'
          ? ['mcp__computer-use__js', 'mcp__computer-use__js_reset']
          : ['mcp__computer-use__screenshot']
        for (const name of required) {
          assert.ok(
            computerTools.includes(name),
            `${phase} is missing ${name} after enabling Computer Use in an already running CLI`,
          )
        }
      } else {
        assert.deepEqual(computerTools, [], `${phase} leaked disabled/profile-excluded Computer Use tools`)
      }
      if (verifySkill) {
        assert.ok(skillProbe?.result, 'the real Skill tool result did not return to the model')
        assert.ok(
          !skillProbe.result.is_error,
          `the newly enabled computer-use skill failed: ${JSON.stringify(skillProbe.result.content)}`,
        )
        assert.ok(workflowLoaded, 'the selected Computer Use workflow did not reach the model')
      }
    }
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    try {
      // The first-use case has no config file for the skill watcher to watch.
      await turn('disabled-start-without-config', null)
      await turn('enabled-next-turn', true)
      const count = connections().filter(row => row.pid === child.pid).length
      await turn('enabled-stable', true)
      assert.equal(
        connections().filter(row => row.pid === child.pid).length,
        count,
        'stable enabled turns must not reconnect the native server',
      )
      await turn('disabled-again', false)
      await turn('reenabled', true)
      if (profile === 'lean' || boundary !== 'allowed') {
        assert.equal(
          connections().filter(row => row.pid === child.pid).length,
          0,
          'an excluded profile/flag or unavailable helper must never connect the native server',
        )
      }
    } finally {
      child.stdin.end()
      const exitTimer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      let exitCode: number
      try {
        exitCode = await child.exited
        await Promise.all([drainOut, drainErr])
      } finally {
        clearTimeout(exitTimer)
        clearTimeout(killTimer)
      }
      writeFileSync(join(artifactDir, `${label}.log`), `${stdout}\n${stderr}`)
      assert.equal(exitCode, 0, `${label} CLI did not shut down cleanly: ${stderr}`)
    }
  }
  try {
    await run('standard')
    await run('standard', 'cli-disabled')
    await run('standard', 'env-disabled')
    if (process.platform === 'darwin') await run('standard', 'helper-unavailable')
    await run('lean')
  } finally {
    writeFileSync(join(artifactDir, 'inventory.json'), JSON.stringify({
      nativeBoundary: 'fixture; no app enumeration, screenshots or actions',
      skillBoundary: 'real bundled Skill invocation and result',
      captures,
      nativeConnections: connections(),
    }, null, 2) + '\n')
    await upstream.stop()
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'lane mutated real user state')
  }
  return 'passed'
}
