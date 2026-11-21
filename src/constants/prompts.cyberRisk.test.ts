import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

const originalEnv = { ...process.env }
const sandboxHome = mkdtempSync(join(tmpdir(), 'cyber-risk-prompt-'))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(
  process.env,
  createSandboxedTestEnvironment(
    sandboxHome,
    { ANTHROPIC_API_KEY: 'offline-fixture-key' },
    originalEnv,
  ),
)
const globals = globalThis as typeof globalThis & { MACRO?: { ISSUES_EXPLAINER: string } }
const originalMacro = globals.MACRO
globals.MACRO = { ISSUES_EXPLAINER: 'use the fixture issue tracker' }

// The external-build proactive stub has no isProactiveActive named export;
// supply one so the feature-gated prompt path can run under --feature.
// Must be registered before anything loads the module (require cache).
if (feature('PROACTIVE') || feature('KAIROS')) {
  mock.module('../proactive/index.js', () => ({
    isProactiveActive: () => true,
  }))
}

const { getSystemPrompt } = await import('./prompts.js')
const { CYBER_RISK_INSTRUCTION } = await import('./cyberRiskInstruction.js')
const { getEmptyToolPermissionContext } = await import('../Tool.js')
const { getTools } = await import('../tools.js')
const { resetSettingsCache } = await import('../utils/settings/settingsCache.js')

const configDir = join(sandboxHome, '.claude')
mkdirSync(configDir, { recursive: true })

afterAll(() => {
  resetSettingsCache()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  rmSync(sandboxHome, { recursive: true, force: true })
})

function writeUserSettings(settings: Record<string, unknown> | null) {
  if (settings === null) {
    rmSync(join(configDir, 'settings.json'), { force: true })
  } else {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
  }
  resetSettingsCache()
}

const buildPrompt = async () =>
  (
    await getSystemPrompt(
      getTools(getEmptyToolPermissionContext()),
      'fixture-model',
      [],
      [],
    )
  ).join('\n')

beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION
  writeUserSettings(null)
})

// With --feature PROACTIVE/KAIROS the mock keeps the proactive path always
// active, so intro-specific assertions only apply to the standard path.
const proactiveEnabled = (feature('PROACTIVE') || feature('KAIROS')) ? true : false
const standardTest = proactiveEnabled ? test.skip : test
const proactiveTest = proactiveEnabled ? test : test.skip

standardTest('default system prompt includes the cyber-risk instruction in the intro', async () => {
  const prompt = await buildPrompt()
  expect(prompt).toContain(CYBER_RISK_INSTRUCTION)
  // Pin the exact placement: blank line before, single newline after, then
  // the URL rule. Guards the default path against spacing drift.
  expect(prompt).toContain(
    `\n\n${CYBER_RISK_INSTRUCTION}\nIMPORTANT: You must NEVER generate or guess URLs`,
  )
})

test('explicit true and unset produce byte-identical prompts', async () => {
  const unset = await buildPrompt()
  writeUserSettings({ includeCyberRiskInstruction: true })
  expect(await buildPrompt()).toBe(unset)
})

standardTest('setting false removes the instruction but keeps the rest of the intro', async () => {
  const enabled = await buildPrompt()
  writeUserSettings({ includeCyberRiskInstruction: false })
  const disabled = await buildPrompt()
  expect(disabled).not.toContain(CYBER_RISK_INSTRUCTION)
  expect(disabled).toContain('You are an interactive agent')
  expect(disabled).toContain(
    'IMPORTANT: You must NEVER generate or guess URLs',
  )
  // Only the instruction paragraph (plus its trailing newline) disappears.
  expect(disabled).toBe(enabled.replace(`${CYBER_RISK_INSTRUCTION}\n`, ''))
})

test('re-enabling restores the default prompt byte-for-byte', async () => {
  const before = await buildPrompt()
  writeUserSettings({ includeCyberRiskInstruction: false })
  await buildPrompt()
  writeUserSettings(null)
  expect(await buildPrompt()).toBe(before)
})

// The proactive path is compile-time feature-gated; run with
// `bun test --feature PROACTIVE` (or KAIROS) to exercise it.
proactiveTest('proactive prompt gates the cyber-risk instruction', async () => {
  const enabled = await buildPrompt()
  expect(enabled).toContain('You are an autonomous agent')
  expect(enabled).toContain(`do useful work.\n\n${CYBER_RISK_INSTRUCTION}`)
  writeUserSettings({ includeCyberRiskInstruction: false })
  const disabled = await buildPrompt()
  expect(disabled).toContain('You are an autonomous agent')
  expect(disabled).not.toContain(CYBER_RISK_INSTRUCTION)
  expect(disabled).toBe(enabled.replace(`\n\n${CYBER_RISK_INSTRUCTION}`, ''))
})
