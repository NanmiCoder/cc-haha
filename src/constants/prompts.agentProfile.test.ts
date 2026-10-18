import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { setAgentProfile } from '../utils/agentProfile.js'

const originalEnv = { ...process.env }
const sandboxHome = mkdtempSync(join(tmpdir(), 'lean-prompt-'))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(sandboxHome, {
  ANTHROPIC_API_KEY: 'offline-fixture-key',
}, originalEnv))
const globals = globalThis as typeof globalThis & { MACRO?: { ISSUES_EXPLAINER: string } }
const originalMacro = globals.MACRO
globals.MACRO = { ISSUES_EXPLAINER: 'use the fixture issue tracker' }
const { getSystemPrompt } = await import('./prompts.js')
const { getEmptyToolPermissionContext } = await import('../Tool.js')
const { getTools } = await import('../tools.js')
afterAll(() => {
  setAgentProfile('standard')
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  rmSync(sandboxHome, { recursive: true, force: true })
})

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
