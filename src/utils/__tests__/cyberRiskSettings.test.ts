import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const originalEnv = { ...process.env }
const sandboxHome = mkdtempSync(join(tmpdir(), 'cyber-risk-settings-'))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(
  process.env,
  createSandboxedTestEnvironment(sandboxHome, {}, originalEnv),
)

const { shouldIncludeCyberRiskInstruction } = await import('../cyberRiskSettings.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')
const { getOriginalCwd, setOriginalCwd } = await import('../../bootstrap/state.js')

const initialOriginalCwd = getOriginalCwd()
const configDir = join(sandboxHome, '.claude')
const projectDir = join(sandboxHome, 'project')
mkdirSync(configDir, { recursive: true })
mkdirSync(join(projectDir, '.claude'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = configDir
setOriginalCwd(projectDir)

const ENV_NAME = 'CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION'

afterAll(() => {
  setOriginalCwd(initialOriginalCwd)
  resetSettingsCache()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
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

beforeEach(() => {
  delete process.env[ENV_NAME]
  writeUserSettings(null)
})

describe('shouldIncludeCyberRiskInstruction', () => {
  test('defaults to true when nothing is configured', () => {
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)
  })

  test('returns false when the setting is false', () => {
    writeUserSettings({ includeCyberRiskInstruction: false })
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })

  test('returns true when the setting is true', () => {
    writeUserSettings({ includeCyberRiskInstruction: true })
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)
  })

  test('env=1 disables even when the setting is true', () => {
    writeUserSettings({ includeCyberRiskInstruction: true })
    process.env[ENV_NAME] = '1'
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })

  test('env=0 enables even when the setting is false', () => {
    writeUserSettings({ includeCyberRiskInstruction: false })
    process.env[ENV_NAME] = '0'
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)
  })

  test('empty env falls through to the setting', () => {
    writeUserSettings({ includeCyberRiskInstruction: false })
    process.env[ENV_NAME] = ''
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })
})
