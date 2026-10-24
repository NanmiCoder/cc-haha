import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearOAuthTokenCache } from '../auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { resolveTeammateModel } from '../swarm/resolveTeammateModel.js'
import { getAgentModel } from './agent.js'
import { applyBuiltInAgentOverrides, getAgentModelSetting } from '../../tools/AgentTool/builtInAgentOverrides.js'
import { STATUSLINE_SETUP_AGENT } from '../../tools/AgentTool/built-in/statuslineSetup.js'
import { isCustomAgent, isPluginAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import { buildInProcessTeammateAgentDefinition } from '../swarm/inProcessRunner.js'

const envKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_AZURE_OPENAI',
] as const
let savedEnv: (string | undefined)[]
let temporaryHome: string
let originalTeammateModel: string | null | undefined

beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key])
  for (const key of envKeys) delete process.env[key]
  temporaryHome = mkdtempSync(join(tmpdir(), 'agent-provider-routing-'))
  Object.assign(process.env, {
    HOME: temporaryHome,
    CLAUDE_CONFIG_DIR: join(temporaryHome, '.claude'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic',
    ANTHROPIC_API_KEY: 'fake-key',
    ANTHROPIC_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
  })
  resetSettingsCache()
  clearOAuthTokenCache()
  originalTeammateModel = getGlobalConfig().teammateDefaultModel
})

afterEach(() => {
  saveGlobalConfig(current => ({ ...current, teammateDefaultModel: originalTeammateModel }))
  resetSettingsCache()
  clearOAuthTokenCache()
  rmSync(temporaryHome, { recursive: true, force: true })
  envKeys.forEach((key, index) => {
    const value = savedEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

describe('Agent routing on a non-Claude provider', () => {
  for (const alias of ['opus', 'sonnet', 'fable', 'haiku'] as const) {
    test(`automatic ${alias} suggestions keep the selected Flash model`, () => {
      expect(getAgentModel('inherit', 'deepseek-v4-flash', alias)).toBe('deepseek-v4-flash')
      expect(resolveTeammateModel(alias, 'deepseek-v4-flash', 'inherit')).toBe('deepseek-v4-flash')
    })
  }

  test('automatic suggestions preserve the configured Agent model', () => {
    for (const preset of ['deepseek-v4-pro', 'opus']) {
      const expected = preset === 'opus' ? 'deepseek-v4-pro[1m]' : preset
      expect(getAgentModel(preset, 'deepseek-v4-flash', 'haiku')).toBe(expected)
      expect(resolveTeammateModel('haiku', 'deepseek-v4-flash', preset)).toBe(expected)
    }
    expect(getAgentModel('haiku', 'deepseek-v4-pro[1m]', 'opus')).toBe('deepseek-v4-flash')
  })

  test('unmodified built-in tiers inherit Flash while manual model overrides still apply', () => {
    const parent = 'deepseek-v4-flash'
    const defaultModel = getAgentModelSetting(STATUSLINE_SETUP_AGENT, parent)
    expect(defaultModel).toBe('inherit')
    expect(getAgentModel(defaultModel, parent)).toBe(parent)
    const configDir = process.env.CLAUDE_CONFIG_DIR!
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
      builtInAgentOverrides: { [STATUSLINE_SETUP_AGENT.agentType]: { model: 'opus' } },
    }))
    resetSettingsCache()
    const configured = applyBuiltInAgentOverrides([STATUSLINE_SETUP_AGENT])[0]!
    expect(getAgentModel(getAgentModelSetting(configured, parent), parent, 'haiku')).toBe('deepseek-v4-pro[1m]')
  })

  test('complete Claude IDs generated for teammates follow the selected preset or Flash', () => {
    for (const suggestion of ['claude-opus-4-6', 'claude-opus-4-8[1m]']) {
      expect(resolveTeammateModel(suggestion, 'deepseek-v4-flash', 'inherit')).toBe('deepseek-v4-flash')
      expect(resolveTeammateModel(suggestion, 'deepseek-v4-flash', 'deepseek-v4-pro')).toBe('deepseek-v4-pro')
    }
  })

  test('legacy Claude preset IDs use the matching configured provider slot', () => {
    for (const model of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-3-opus-20240229', 'claude-opus-4-8[1m]']) {
      expect(getAgentModel(model, 'deepseek-v4-flash')).toBe('deepseek-v4-pro[1m]')
      expect(resolveTeammateModel(undefined, 'deepseek-v4-flash', model)).toBe('deepseek-v4-pro[1m]')
    }
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-flash'
    expect(getAgentModel('claude-opus-4-8[1m]', 'deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(resolveTeammateModel('claude-opus-4-8', 'deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(getAgentModel('claude-3-5-sonnet-20241022', 'deepseek-v4-flash')).toBe('deepseek-v4-pro[1m]')
  })

  test('concrete environment overrides and teammate defaults remain authoritative', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-v4-pro'
    expect(getAgentModel('inherit', 'deepseek-v4-flash', 'haiku')).toBe('deepseek-v4-pro')
    expect(resolveTeammateModel('haiku', 'deepseek-v4-flash', 'inherit')).toBe('deepseek-v4-pro')
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    saveGlobalConfig(current => ({ ...current, teammateDefaultModel: 'deepseek-v4-pro' }))
    expect(resolveTeammateModel('opus', 'deepseek-v4-flash')).toBe('deepseek-v4-pro')
    expect(getGlobalConfig().teammateDefaultModel).toBe('deepseek-v4-pro')
  })

  for (const [parent, configured, alias] of [
    ['deepseek-v4-flash', 'deepseek-v4-pro[1m]', 'opus'],
    ['deepseek-v4-pro[1m]', 'deepseek-v4-flash', 'haiku'],
  ] as const) {
    test(`in-process teammates execute the configured default ${configured} under ${parent}`, () => {
      saveGlobalConfig(current => ({ ...current, teammateDefaultModel: configured }))
      const selected = resolveTeammateModel(undefined, parent)
      const definition = buildInProcessTeammateAgentDefinition('worker', 'Fixture prompt')

      expect(selected).toBe(configured)
      expect(getAgentModel(getAgentModelSetting(definition, parent), parent, selected)).toBe(configured)
    })

    test(`in-process teammates execute a manual built-in ${alias} override under ${parent}`, () => {
      mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
      writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({
        builtInAgentOverrides: { [STATUSLINE_SETUP_AGENT.agentType]: { model: alias } },
      }))
      resetSettingsCache()
      const agent = applyBuiltInAgentOverrides([STATUSLINE_SETUP_AGENT])[0]!
      const selected = resolveTeammateModel(undefined, parent, getAgentModelSetting(agent, parent), true)
      // The spawn boundary passes only custom/plugin definitions to this wrapper.
      const definition = buildInProcessTeammateAgentDefinition('worker', 'Fixture prompt',
        isCustomAgent(agent) || isPluginAgent(agent) ? agent : undefined)

      expect(selected).toBe(configured)
      expect(getAgentModel(getAgentModelSetting(definition, parent), parent, selected)).toBe(configured)
    })
  }

  test('concrete custom IDs keep their exact spelling', () => {
    expect(getAgentModel('MyDeployment', 'deepseek-v4-flash')).toBe('MyDeployment')
    expect(resolveTeammateModel('MyDeployment', 'deepseek-v4-flash', 'inherit')).toBe('MyDeployment')
  })

  test('resolved teammate Claude version pins remain concrete on a mixed-model provider', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5-5'
    const parent = 'deepseek-v4-flash'
    const selected = resolveTeammateModel(undefined, parent, 'claude-opus-4-6', true)
    expect(selected).toBe('claude-opus-4-6')
    expect(getAgentModel(undefined, parent, selected)).toBe('claude-opus-4-6')
  })

  test('Claude sessions keep their invocation override and version pins', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5-5'
    expect(getAgentModel('inherit', 'claude-sonnet-4-6', 'opus')).toBe('claude-opus-5-5')
    expect(resolveTeammateModel('opus', 'claude-sonnet-4-6', 'inherit')).toBe('claude-opus-5-5')
    expect(getAgentModel('claude-opus-4-8', 'claude-sonnet-4-6')).toBe('claude-opus-4-8')
    expect(resolveTeammateModel(undefined, 'claude-sonnet-4-6', 'claude-opus-4-8')).toBe('claude-opus-4-8')
  })
})
