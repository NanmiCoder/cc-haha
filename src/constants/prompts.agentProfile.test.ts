import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { filterAgentProfileTools, setAgentProfile } from '../utils/agentProfile.js'

const originalEnv = { ...process.env }
const sandboxHome = mkdtempSync(join(tmpdir(), 'lean-prompt-'))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(sandboxHome, {
  ANTHROPIC_API_KEY: 'offline-fixture-key',
}, originalEnv))
const globals = globalThis as typeof globalThis & { MACRO?: { ISSUES_EXPLAINER: string } }
const originalMacro = globals.MACRO
globals.MACRO = { ISSUES_EXPLAINER: 'use the fixture issue tracker' }
const { computeSimpleEnvInfo, getSystemPrompt } = await import('./prompts.js')
const { getEmptyToolPermissionContext } = await import('../Tool.js')
const { getTools } = await import('../tools.js')
const { getAutoMemPath } = await import('../memdir/paths.js')
const { getCwd } = await import('../utils/cwd.js')
afterAll(() => {
  setAgentProfile('standard')
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  rmSync(sandboxHome, { recursive: true, force: true })
})

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
// Fixed lean prefix without host paths: core prompt + environment + compact memory
// (measured ~2.2KB; the full auto-memory guide alone is ~12.8KB).
const LEAN_SYSTEM_PROMPT_BUDGET_BYTES = 2450
const mentionsOf = (names: readonly string[], text: string) =>
  names.filter(name => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text))

function toolPools() {
  setAgentProfile('standard')
  const standardNames = getTools(getEmptyToolPermissionContext()).map(tool => tool.name)
  setAgentProfile('lean')
  const leanTools = filterAgentProfileTools(getTools(getEmptyToolPermissionContext()))
  const leanNames = new Set(leanTools.map(tool => tool.name))
  const unavailable = standardNames.filter(name => !leanNames.has(name))
  expect(unavailable).toEqual(expect.arrayContaining(['Agent', 'TodoWrite', 'EnterPlanMode']))
  return { leanTools, unavailable }
}

test('lean prompt assembly skips MCP instructions and restores standard behavior', async () => {
  const clients = [{
    type: 'connected', name: 'fixture', instructions: 'MCP_INSTRUCTION_SENTINEL',
  }] as unknown as NonNullable<Parameters<typeof getSystemPrompt>[3]>
  const build = () => getSystemPrompt(
    getTools(getEmptyToolPermissionContext()), 'fixture-model', ['/fixture/extra'], clients,
  )
  const before = await build()
  setAgentProfile('lean')
  const lean = (await build()).join('\n')
  expect(lean).toContain('You are cc-haha')
  expect(lean).toContain('/fixture/extra')
  expect(lean).not.toContain('MCP_INSTRUCTION_SENTINEL')
  expect(lean).not.toContain('# MCP Server Instructions')
  setAgentProfile('standard')
  expect(await build()).toEqual(before)
})

// Pinned before the lean compaction landed: lean work must not move a byte of the
// standard prompt. The environment section (cwd, OS, shell, model lineup) and the
// auto-memory path are host-specific, so they are factored out of the hash.
test.skipIf(process.platform === 'win32')('standard system prompt is byte-identical to the pinned baseline', async () => {
  setAgentProfile('standard')
  const sections = await getSystemPrompt(getTools(getEmptyToolPermissionContext()), 'fixture-model', ['/fixture/extra'], [])
  const envInfo = await computeSimpleEnvInfo('fixture-model', ['/fixture/extra'])
  expect(sections).toContain(envInfo)
  const text = sections.filter(section => section !== envInfo).join('\n').split(getAutoMemPath()).join('<auto-memory>/')
  expect(text).toContain('`<auto-memory>/`')
  expect(text).toContain('## Types of memory')
  expect(text).not.toContain(sandboxHome)
  expect(text).not.toContain(getCwd())
  expect(sha256(text)).toBe('47cefa517760ede60b94136d5433a3fa37365516cd76d06a55ec121f139af3c3')
})

test('lean system prompt carries compact memory guidance within budget and names no unavailable tool', async () => {
  const { leanTools, unavailable } = toolPools()
  const text = (await getSystemPrompt(leanTools, 'fixture-model', [], [])).join('\n')
  const memoryDir = getAutoMemPath()
  expect(text).toContain(`\`${memoryDir}\``)
  expect(text).toContain('only when the user explicitly asks you to remember something')
  for (const absent of ['## Types of memory', 'Memory and other forms of persistence', 'use a Plan', 'use tasks']) {
    expect(text).not.toContain(absent)
  }
  expect(mentionsOf(unavailable, text)).toEqual([])
  const hostBytes = Buffer.byteLength(memoryDir) + Buffer.byteLength(getCwd())
  expect(Buffer.byteLength(text) - hostBytes).toBeLessThanOrEqual(LEAN_SYSTEM_PROMPT_BUDGET_BYTES)
})

test('lean tool descriptions name no tool outside the lean pool', async () => {
  const { leanTools, unavailable } = toolPools()
  const context = getEmptyToolPermissionContext()
  const mentions: Record<string, string[]> = {}
  for (const tool of leanTools) {
    const description = await tool.prompt({ getToolPermissionContext: async () => context, tools: leanTools, agents: [] })
    mentions[tool.name] = mentionsOf(unavailable, description)
  }
  expect(Object.keys(mentions)).toEqual(expect.arrayContaining(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill']))
  expect(Object.values(mentions).flat()).toEqual([])
})
