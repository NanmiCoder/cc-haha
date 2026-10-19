import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSandboxLaneEnv } from '../scripts/quality-gate/sandbox.js'
import { startMockLlmServer, type MockLlmServer } from '../scripts/quality-gate/mock-llm/server.js'

// Real CLI startup against a loopback model: a configured MCP server that never
// answers must not be launched or awaited by lean, while standard still is.
const root = resolve(import.meta.dir, '..')
let home: string
let workDir: string
let markers: string
let env: Record<string, string>
let upstream: MockLlmServer
let firstAgentRequestAt = 0

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-haha-lean-mcp-'))
  workDir = join(home, 'project')
  markers = join(home, 'launches')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(markers, { recursive: true })
  // Only loopback-safe names pass through; no provider or proxy state is inherited.
  env = buildSandboxLaneEnv(home, {}, { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT })
  const server = join(home, 'silent-mcp.cjs')
  // Records every launch and never answers `initialize`; it cannot outlive the CLI.
  writeFileSync(server, [
    `require('fs').writeFileSync(${JSON.stringify(markers)} + '/' + process.pid, '')`,
    "process.stdin.on('end', () => process.exit(0)).resume()",
    'setTimeout(() => process.exit(0), 120000)',
  ].join('\n'))
  mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true })
  writeFileSync(join(env.CLAUDE_CONFIG_DIR!, '.claude.json'), JSON.stringify({
    mcpServers: { silent: { type: 'stdio', command: process.execPath, args: [server] } },
  }))
  upstream = startMockLlmServer(request => {
    if (request.tools?.some(tool => tool.name === 'Read') && !firstAgentRequestAt) firstAgentRequestAt = performance.now()
    return { kind: 'message', content: [{ type: 'text', text: 'LEAN_MCP_DONE' }], stopReason: 'end_turn' }
  })
})

afterAll(async () => {
  await upstream.stop()
  rmSync(home, { recursive: true, force: true })
})

async function runCli(profile: 'standard' | 'lean', mcpTimeoutMs: number, extraArgs: string[] = []) {
  for (const marker of readdirSync(markers)) rmSync(join(markers, marker))
  firstAgentRequestAt = 0
  const requestsBefore = upstream.requests.length
  const startedAt = performance.now()
  const child = Bun.spawn([
    process.execPath, '--no-env-file', '--preload', join(root, 'preload.ts'), join(root, 'src/entrypoints/cli.tsx'),
    '--print', '--agent-profile', profile, '--model', 'mock-model', '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json', '--verbose', ...extraArgs, 'say done',
  ], {
    cwd: workDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: {
      ...env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
      ANTHROPIC_BASE_URL: upstream.url, ANTHROPIC_API_KEY: 'mock-api-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', MCP_TIMEOUT: String(mcpTimeoutMs),
    },
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    // The SDK init message is the session's advertised MCP inventory.
    const init = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>)
      .find(message => message.type === 'system' && message.subtype === 'init')
    return {
      code, stdout, stderr, mcpServers: init?.mcp_servers,
      firstRequestMs: firstAgentRequestAt ? firstAgentRequestAt - startedAt : undefined,
      launches: readdirSync(markers).length,
      requests: upstream.requests.length - requestsBefore,
    }
  } finally {
    clearTimeout(timer)
  }
}

test('lean neither launches nor waits for a configured MCP server before its first request', async () => {
  // Waiting for this server would hold the first request for the full 20s timeout.
  const lean = await runCli('lean', 20_000)
  expect(lean.code, lean.stderr).toBe(0)
  expect(lean.stdout).toContain('LEAN_MCP_DONE')
  expect(lean.launches).toBe(0)
  expect(lean.firstRequestMs).toBeLessThan(10_000)
  // Not even a pending/failed placeholder: lean resolves no MCP configuration.
  expect(lean.mcpServers).toEqual([])
}, 60_000)

test('standard still launches and awaits the same MCP server', async () => {
  const standard = await runCli('standard', 2_000)
  expect(standard.code, standard.stderr).toBe(0)
  expect(standard.stdout).toContain('LEAN_MCP_DONE')
  expect(standard.launches).toBe(1)
  expect(standard.firstRequestMs).toBeGreaterThanOrEqual(2_000)
  expect(standard.mcpServers).toEqual([expect.objectContaining({ name: 'silent' })])
}, 60_000)

test('lean rejects an explicit --mcp-config before any request', async () => {
  const rejected = await runCli('lean', 20_000, ['--mcp-config', '{"mcpServers":{}}'])
  expect(rejected.code).not.toBe(0)
  expect(rejected.stderr).toContain('--agent-profile lean cannot be combined with --mcp-config.')
  expect(rejected.requests).toBe(0)
  expect(rejected.launches).toBe(0)
}, 60_000)

// The three sources below need credentials or a desktop session that the loopback
// lane above cannot provide (claude.ai connectors, Computer Use's own MCP server,
// the official registry prefetch), so the real CLI cannot prove they stay off in
// lean. Each is started from exactly one place in main.tsx and that place has to
// stay behind the profile; a second, ungated start fails the count.
test('main.tsx starts every MCP source behind the profile, each from one place', () => {
  const main = readFileSync(join(root, 'src/main.tsx'), 'utf8')
  const calls = (name: string) => [...main.matchAll(new RegExp(`${name}\\(`, 'g'))].length

  // Official registry URL prefetch (a network call).
  expect(calls('prefetchOfficialMcpUrls')).toBe(1)
  expect(main).toMatch(/if \(isAgentProfileMcpEnabled\(\)\) void prefetchOfficialMcpUrls\(\)/)

  // claude.ai connectors (fetched with the user's login).
  expect(calls('fetchClaudeAIMcpConfigsIfEligible')).toBe(1)
  expect(main).toMatch(/const claudeaiConfigPromise[^=]*=\s*agentProfileMcp &&/)

  // Computer Use's MCP server (macOS and Windows).
  expect(calls('setupComputerUseMCP')).toBe(1)
  expect(main).toMatch(/if \(agentProfileMcp && \(process\.platform === 'darwin' \|\| process\.platform === 'win32'\)\) \{\s*try \{\s*const \{\s*getChicagoEnabled/)

  // User, project and plugin configuration (the real-CLI tests above show it end to end).
  expect(calls('getClaudeCodeMcpConfigs')).toBe(1)
  expect(main).toMatch(/const mcpConfigPromise = \(!agentProfileMcp \|\|/)
})
