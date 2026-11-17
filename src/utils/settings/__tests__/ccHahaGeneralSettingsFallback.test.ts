import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../../scripts/pr/test-environment.js'
import { setAgentProfile } from '../../agentProfile.js'

const originalEnv = { ...process.env }
const sandboxHome = mkdtempSync(join(tmpdir(), 'cc-haha-general-fallback-'))
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

const { getSystemPrompt } = await import('../../../constants/prompts.js')
const { executeEffort } = await import('../../../commands/effort/effort.js')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
const { getTools } = await import('../../../tools.js')
const { getInitialEffortSetting } = await import('../../effort.js')
const {
  getInitialSettings,
  getUserLanguageSettingWithFallback,
  updateSettingsForSource,
} = await import('../settings.js')
const { resetSettingsCache } = await import('../settingsCache.js')
const { getOriginalCwd, setOriginalCwd } = await import('../../../bootstrap/state.js')

const initialOriginalCwd = getOriginalCwd()

afterAll(() => {
  setAgentProfile('standard')
  setOriginalCwd(initialOriginalCwd)
  resetSettingsCache()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  rmSync(sandboxHome, { recursive: true, force: true })
})

describe('cc-haha managed General settings fallback for CLI runtime', () => {
  let configDir: string
  let projectDir: string

  beforeEach(() => {
    setAgentProfile('standard')
    const caseRoot = mkdtempSync(join(sandboxHome, 'case-'))
    configDir = join(caseRoot, '.claude')
    projectDir = join(caseRoot, 'project')
    mkdirSync(join(configDir, 'cc-haha'), { recursive: true })
    mkdirSync(join(projectDir, '.claude'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    setOriginalCwd(projectDir)
    resetSettingsCache()
  })

  test('restores response language and xhigh effort in CLI prompts and runtime after CC Switch overwrites settings.json', async () => {
    writeFileSync(
      join(configDir, 'cc-haha', 'settings.json'),
      JSON.stringify({ defaultEffort: 'xhigh', language: 'chinese' }),
      'utf-8',
    )
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        env: {
          ANTHROPIC_API_KEY: 'PROXY_MANAGED',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        },
        outputStyle: 'engineer-professional',
      }),
      'utf-8',
    )
    resetSettingsCache()

    expect(getInitialSettings().language).toBe('chinese')
    expect(getInitialEffortSetting()).toBe('xhigh')

    const tools = getTools(getEmptyToolPermissionContext())
    const standardPrompt = (await getSystemPrompt(tools, 'claude-opus-5-5')).join('\n')
    expect(standardPrompt).toContain('Always respond in chinese.')

    setAgentProfile('lean')
    const leanPrompt = (await getSystemPrompt(tools, 'claude-opus-5-5')).join('\n')
    expect(leanPrompt).toContain('Respond in chinese.')
  })

  test('lets explicit user reset or higher-priority project settings override the cc-haha fallback', () => {
    writeFileSync(
      join(configDir, 'cc-haha', 'settings.json'),
      JSON.stringify({ defaultEffort: 'xhigh', language: 'chinese' }),
      'utf-8',
    )

    // Explicit empty string in ~/.claude/settings.json means Default (English).
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ language: '' }),
      'utf-8',
    )
    resetSettingsCache()
    expect(getInitialSettings().language).toBe('')

    // Project settings override user-level cc-haha fallback when user settings lost the fields.
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({}), 'utf-8')
    writeFileSync(
      join(projectDir, '.claude', 'settings.json'),
      JSON.stringify({ language: 'japanese', effortLevel: 'low' }),
      'utf-8',
    )
    resetSettingsCache()
    expect(getInitialSettings().language).toBe('japanese')
    expect(getInitialEffortSetting()).toBe('low')
  })

  test('reads effort from settings.json while keeping manual effortLevel=max session-scoped for external users', () => {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ effort: 'xhigh' }),
      'utf-8',
    )
    resetSettingsCache()
    expect(getInitialEffortSetting()).toBe('xhigh')

    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ effortLevel: 'max' }),
      'utf-8',
    )
    resetSettingsCache()
    expect(getInitialEffortSetting()).toBeUndefined()

    // Standard high effort in cc-haha/settings.json populates effortLevel fallback; empty/array files are ignored safely.
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({}), 'utf-8')
    writeFileSync(join(configDir, 'cc-haha', 'settings.json'), JSON.stringify({ defaultEffort: 'high' }), 'utf-8')
    resetSettingsCache()
    expect(getInitialSettings().effortLevel).toBe('high')
    expect(getInitialEffortSetting()).toBe('high')

    writeFileSync(join(configDir, 'cc-haha', 'settings.json'), '', 'utf-8')
    resetSettingsCache()
    expect(getInitialEffortSetting()).toBeUndefined()

    writeFileSync(join(configDir, 'cc-haha', 'settings.json'), '[]', 'utf-8')
    resetSettingsCache()
    expect(getInitialEffortSetting()).toBeUndefined()
  })

  test('syncs CLI /effort and language updates/resets with cc-haha/settings.json without resurrecting cleared values', () => {
    const userPath = join(configDir, 'settings.json')
    const managedPath = join(configDir, 'cc-haha', 'settings.json')
    rmSync(managedPath, { force: true })

    // Clearing when cc-haha/settings.json does not exist yet must not create it.
    writeFileSync(userPath, JSON.stringify({}), 'utf-8')
    resetSettingsCache()
    expect(updateSettingsForSource('userSettings', { language: undefined }).error).toBeNull()
    expect(existsSync(managedPath)).toBe(false)

    // Setting language and effort via CLI writes both ~/.claude/settings.json and cc-haha/settings.json.
    writeFileSync(
      managedPath,
      JSON.stringify({ futureManagedField: { keep: true } }, null, 2),
      'utf-8',
    )
    expect(updateSettingsForSource('userSettings', { language: 'spanish' }).error).toBeNull()
    expect(executeEffort('high').effortUpdate?.value).toBe('high')

    expect(JSON.parse(readFileSync(userPath, 'utf-8'))).toEqual({
      language: 'spanish',
      effort: 'high',
      effortLevel: 'high',
    })
    expect(JSON.parse(readFileSync(managedPath, 'utf-8'))).toEqual({
      futureManagedField: { keep: true },
      language: 'spanish',
      defaultEffort: 'high',
    })
    expect(getInitialSettings().language).toBe('spanish')
    expect(getInitialEffortSetting()).toBe('high')

    // Suppose Desktop later saved xhigh (so settings.json has effort: 'xhigh') and user runs `/effort auto` in CLI.
    writeFileSync(userPath, JSON.stringify({ language: 'spanish', effort: 'xhigh' }), 'utf-8')
    writeFileSync(
      managedPath,
      JSON.stringify({ futureManagedField: { keep: true }, language: 'spanish', defaultEffort: 'xhigh' }),
      'utf-8',
    )
    resetSettingsCache()
    expect(executeEffort('auto').effortUpdate?.value).toBeUndefined()

    const userAfterAuto = JSON.parse(readFileSync(userPath, 'utf-8'))
    expect(userAfterAuto).not.toHaveProperty('effort')
    expect(userAfterAuto).not.toHaveProperty('effortLevel')
    const managedAfterAuto = JSON.parse(readFileSync(managedPath, 'utf-8'))
    expect(managedAfterAuto).toEqual({
      futureManagedField: { keep: true },
      language: 'spanish',
    })
    expect(getInitialEffortSetting()).toBeUndefined()

    // Resetting language in CLI `/config` clears both files so CC Switch overwrite cannot resurrect it.
    expect(updateSettingsForSource('userSettings', { language: undefined }).error).toBeNull()
    expect(JSON.parse(readFileSync(userPath, 'utf-8'))).toEqual({})
    expect(JSON.parse(readFileSync(managedPath, 'utf-8'))).toEqual({
      futureManagedField: { keep: true },
    })
    expect(getInitialSettings().language).toBeUndefined()
  })

  test('resolves pre-existing conflicting effort/effortLevel deterministically and respects cross-source overrides', () => {
    const userPath = join(configDir, 'settings.json')
    const projectPath = join(projectDir, '.claude', 'settings.json')

    // Desktop xhigh/max wins over stale schema-limited effortLevel in the same file.
    writeFileSync(userPath, JSON.stringify({ effortLevel: 'low', effort: 'xhigh' }), 'utf-8')
    resetSettingsCache()
    expect(getInitialEffortSetting()).toBe('xhigh')

    // Official CLI effortLevel ('low'|'medium'|'high') wins over stale standard effort in the same file.
    writeFileSync(userPath, JSON.stringify({ effort: 'high', effortLevel: 'low' }), 'utf-8')
    resetSettingsCache()
    expect(getInitialEffortSetting()).toBe('low')

    // Project settings override user settings in both directions across layers.
    writeFileSync(userPath, JSON.stringify({ effort: 'xhigh' }), 'utf-8')
    writeFileSync(projectPath, JSON.stringify({ effortLevel: 'medium', language: 'japanese' }), 'utf-8')
    resetSettingsCache()
    expect(getInitialEffortSetting()).toBe('medium')
    expect(getUserLanguageSettingWithFallback()).toBeUndefined()

    writeFileSync(userPath, JSON.stringify({ effort: 'low', effortLevel: 'low' }), 'utf-8')
    writeFileSync(projectPath, JSON.stringify({ effort: 'xhigh' }), 'utf-8')
    resetSettingsCache()
    expect(getInitialEffortSetting()).toBe('xhigh')
  })
})
