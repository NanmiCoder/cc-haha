import { expect, test } from 'bun:test'
import { parse, type Node } from 'acorn'
import { simple } from 'acorn-walk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isComputerUseSupportedPlatform } from './utils/computerUse/common.js'

// Execute the actual startup branch without importing main's side effects or
// consulting a user's config, native desktop, or provider. The import rewrite
// uses parsed expression ranges so the fixture cannot hide the platform guard.
function startupBranch() {
  const source = new Bun.Transpiler({ loader: 'tsx' }).transformSync(
    readFileSync(join(import.meta.dir, 'main.tsx'), 'utf8'),
  )
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  let branch: Node | undefined
  simple(tree, {
    IfStatement(node) {
      if (source.slice(node.test.start, node.test.end).includes('agentProfileMcp')
        && source.slice(node.consequent.start, node.consequent.end).includes('setupComputerUseMCP()')) {
        if (branch) throw new Error('Computer Use must have one startup branch')
        branch = node
      }
    },
  })
  if (!branch) throw new Error('Computer Use startup branch not found')
  const selected = branch
  const imports: number[] = []
  simple(selected, { ImportExpression(node) { imports.push(node.start - selected.start) } })
  let body = source.slice(selected.start, selected.end)
  for (const start of imports.sort((a, b) => b - a)) {
    body = body.slice(0, start) + 'loadModule' + body.slice(start + 'import'.length)
  }
  return new Function(
    'agentProfileMcp', 'process', 'isComputerUseSupportedPlatform', 'options',
    'loadModule', 'logForDebugging', 'errorMessage', 'dynamicMcpConfig', 'allowedTools',
    `return (async () => { ${body}; return { dynamicMcpConfig, allowedTools } })()`,
  )
}

const executeStartup = startupBranch()

async function fixture(options: {
  platform?: NodeJS.Platform
  profileMcp?: boolean
  cliEnabled?: boolean
  globallyEnabled?: boolean
  savedEnabled?: boolean
  configFailure?: boolean
} = {}) {
  const platform = options.platform ?? 'linux'
  const calls: string[] = []
  const messages: string[] = []
  const nativeConfig = { type: 'stdio', command: 'fixture-native-runtime', args: [], scope: 'dynamic' }
  const existing = { other: { type: 'stdio', command: 'fixture-existing-server' } }
  const loadModule = async (name: string) => {
    calls.push(name)
    if (name.endsWith('/gates.js')) return { getChicagoEnabled: () => options.globallyEnabled !== false }
    if (name.endsWith('/preauthorizedConfig.js')) return {
      loadStoredComputerUseConfig: async () => {
        if (options.configFailure) throw new Error('fixture config unavailable')
        return { enabled: options.savedEnabled !== false }
      },
    }
    if (name.endsWith('/setup.js')) return {
      setupComputerUseMCP: () => {
        calls.push('setup')
        return { mcpConfig: { 'computer-use': nativeConfig }, allowedTools: ['mcp__computer-use__desktop'] }
      },
    }
    throw new Error(`Unexpected startup import: ${name}`)
  }
  const result = await executeStartup(
    options.profileMcp !== false,
    { platform },
    () => isComputerUseSupportedPlatform(platform),
    { computerUse: options.cliEnabled !== false },
    loadModule,
    (message: string) => messages.push(message),
    (cause: unknown) => cause instanceof Error ? cause.message : String(cause),
    existing,
    ['Read'],
  )
  return { ...result, calls, messages, nativeConfig, existing }
}

test('main startup registers native Computer Use on Linux and merges its tool allowlist', async () => {
  const result = await fixture()
  expect(result.dynamicMcpConfig).toEqual({ ...result.existing, 'computer-use': result.nativeConfig })
  expect(result.allowedTools).toEqual(['Read', 'mcp__computer-use__desktop'])
  expect(result.calls.at(-1)).toBe('setup')
})

test.each([
  { profileMcp: false },
  { cliEnabled: false },
  { globallyEnabled: false },
  { savedEnabled: false },
  { platform: 'freebsd' as const },
  { configFailure: true },
])('main startup keeps native desktop registration behind its gates: %j', async options => {
  const result = await fixture(options)
  expect(result.dynamicMcpConfig).toEqual(result.existing)
  expect(result.allowedTools).toEqual(['Read'])
  expect(result.calls).not.toContain('setup')
  if (options.profileMcp === false || options.platform === 'freebsd') expect(result.calls).toEqual([])
})
