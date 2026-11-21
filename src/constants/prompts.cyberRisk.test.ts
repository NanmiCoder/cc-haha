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

if (feature('PROACTIVE') || feature('KAIROS')) {
  mock.module('../proactive/index.js', () => ({
    isProactiveActive: () => true,
  }))
}

const { getSystemPrompt } = await import('./prompts.js')
const { CYBER_RISK_INSTRUCTION } = await import('./cyberRiskInstruction.js')
const { getEmptyToolPermissionContext } = await import('../Tool.js')
const { getTools } = await import('../tools.js')
const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
const { resetCyberRiskInstructionSessionLatch } = await import('../utils/cyberRiskSettings.js')
const { resetSettingsCache } = await import('../utils/settings/settingsCache.js')

const configDir = join(sandboxHome, '.claude')
mkdirSync(configDir, { recursive: true })

afterAll(() => {
  resetSettingsCache()
  resetCyberRiskInstructionSessionLatch()
  getClaudeAIOAuthTokens.cache.clear?.()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  rmSync(sandboxHome, { recursive: true, force: true })
})

function writeUserSettings(settings: Record<string, unknown> | null, resetLatch = true) {
  if (settings === null) {
    rmSync(join(configDir, 'settings.json'), { force: true })
  } else {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
  }
  resetSettingsCache()
  if (resetLatch) resetCyberRiskInstructionSessionLatch()
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
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_API_KEY = 'offline-fixture-key'
  getClaudeAIOAuthTokens.cache.clear?.()
  writeUserSettings(null)
})

const proactiveEnabled = (feature('PROACTIVE') || feature('KAIROS')) ? true : false
const standardTest = proactiveEnabled ? test.skip : test
const proactiveTest = proactiveEnabled ? test : test.skip

standardTest('default system prompt includes the cyber-risk instruction in the intro', async () => {
  const prompt = await buildPrompt()
  expect(prompt).toContain(CYBER_RISK_INSTRUCTION)
  expect(prompt).toContain(
    `\n\n${CYBER_RISK_INSTRUCTION}\nIMPORTANT: You must NEVER generate or guess URLs`,
  )
})

test('explicit true and unset produce byte-identical prompts', async () => {
  const unset = await buildPrompt()
  writeUserSettings({ includeCyberRiskInstruction: true })
  expect(await buildPrompt()).toBe(unset)
})

standardTest('setting false removes the instruction for third-party providers while keeping the rest of the intro', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  const enabled = await buildPrompt()
  writeUserSettings({ includeCyberRiskInstruction: false })
  const disabled = await buildPrompt()
  expect(disabled).not.toContain(CYBER_RISK_INSTRUCTION)
  expect(disabled).toContain('You are an interactive agent')
  expect(disabled).toContain(
    'IMPORTANT: You must NEVER generate or guess URLs',
  )
  expect(disabled).toBe(enabled.replace(`${CYBER_RISK_INSTRUCTION}\n`, ''))
})

standardTest('setting false preserves the instruction byte-for-byte on Claude official OAuth accounts', async () => {
  delete process.env.ANTHROPIC_API_KEY
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-oauth-token'
  getClaudeAIOAuthTokens.cache.clear?.()

  const baseline = await buildPrompt()
  writeUserSettings({ includeCyberRiskInstruction: false })
  const afterOptOut = await buildPrompt()
  expect(afterOptOut).toContain(CYBER_RISK_INSTRUCTION)
  expect(afterOptOut).toBe(baseline)
})

standardTest('changing settings mid-session does not mutate a running session prompt prefix', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  const before = await buildPrompt()
  expect(before).toContain(CYBER_RISK_INSTRUCTION)

  // Disk write + settingsCache reset (as triggered by settingsChangeDetector)
  // leaves the running session's prompt prefix unchanged to preserve prompt cache.
  writeUserSettings({ includeCyberRiskInstruction: false }, false)
  expect(await buildPrompt()).toBe(before)

  // A new session picks up the saved setting.
  resetCyberRiskInstructionSessionLatch()
  expect(await buildPrompt()).not.toContain(CYBER_RISK_INSTRUCTION)
})

test('re-enabling restores the default prompt byte-for-byte in a new session', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  const before = await buildPrompt()
  writeUserSettings({ includeCyberRiskInstruction: false })
  await buildPrompt()
  writeUserSettings(null)
  expect(await buildPrompt()).toBe(before)
})

proactiveTest('proactive prompt gates the cyber-risk instruction', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  const enabled = await buildPrompt()
  expect(enabled).toContain('You are an autonomous agent')
  expect(enabled).toContain(`do useful work.\n\n${CYBER_RISK_INSTRUCTION}`)
  writeUserSettings({ includeCyberRiskInstruction: false })
  const disabled = await buildPrompt()
  expect(disabled).toContain('You are an autonomous agent')
  expect(disabled).not.toContain(CYBER_RISK_INSTRUCTION)
  expect(disabled).toBe(enabled.replace(`\n\n${CYBER_RISK_INSTRUCTION}`, ''))
})
