import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const envKeys = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'USER_TYPE',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CC_HAHA_AGENT_TEAMS_DEFAULT',
  'CC_HAHA_AGENT_TEAMS_ENABLED',
] as const

describe('Agent Teams runtime opt-in', () => {
  let originalEnv: Record<string, string | undefined>
  let originalArgv: string[]
  let fixtureDir: string
  let isAgentSwarmsEnabled: typeof import('./agentSwarmsEnabled.js').isAgentSwarmsEnabled
  let growthbook: typeof import('../services/analytics/growthbook.js')
  let gate: ReturnType<typeof spyOn>

  beforeAll(async () => {
    originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    originalArgv = [...process.argv]
    fixtureDir = mkdtempSync(join(tmpdir(), 'agent-teams-gate-'))
    process.env.HOME = fixtureDir
    process.env.CLAUDE_CONFIG_DIR = fixtureDir
    growthbook = await import('../services/analytics/growthbook.js')
    const runtime = await import('./agentSwarmsEnabled.js')
    isAgentSwarmsEnabled = runtime.isAgentSwarmsEnabled
  })

  beforeEach(() => {
    delete process.env.USER_TYPE
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    delete process.env.CC_HAHA_AGENT_TEAMS_DEFAULT
    delete process.env.CC_HAHA_AGENT_TEAMS_ENABLED
    process.argv = originalArgv.filter(arg => arg !== '--agent-teams')
    gate = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockReturnValue(true)
  })

  afterEach(() => {
    gate.mockRestore()
  })

  afterAll(() => {
    process.argv = originalArgv
    for (const key of envKeys) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  test('enables a cc-haha managed session without an upstream opt-in', () => {
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT = '1'
    expect(isAgentSwarmsEnabled()).toBe(true)
    expect(gate).toHaveBeenCalledWith('tengu_amber_flint', true)
  })

  test.each(['0', 'false', ''])('preserves the explicit user opt-out %j over the host default', value => {
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT = '1'
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = value
    expect(isAgentSwarmsEnabled()).toBe(false)
    expect(gate).not.toHaveBeenCalled()
  })

  test('keeps standalone CLI sessions opt-in', () => {
    expect(isAgentSwarmsEnabled()).toBe(false)
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    expect(isAgentSwarmsEnabled()).toBe(true)
  })

  test.each([true, false])('uses the explicit General preference %j over legacy env', enabled => {
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT = '1'
    process.env.CC_HAHA_AGENT_TEAMS_ENABLED = enabled ? '1' : '0'
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = enabled ? '0' : '1'
    expect(isAgentSwarmsEnabled()).toBe(enabled)
  })

  test.each([undefined, 'ant'])('honors General opt-out with a forced launch (%j)', userType => {
    if (userType) process.env.USER_TYPE = userType
    process.env.CC_HAHA_AGENT_TEAMS_ENABLED = '0'
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    process.argv.push('--agent-teams')
    expect(isAgentSwarmsEnabled()).toBe(false)
    expect(gate).not.toHaveBeenCalled()
  })

  test('retains the explicit CLI flag even when the environment opts out', () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'
    process.argv.push('--agent-teams')
    expect(isAgentSwarmsEnabled()).toBe(true)
  })

  test.each(['0', 'false', ''])('does not enable an inactive host default %j', value => {
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT = value
    expect(isAgentSwarmsEnabled()).toBe(false)
  })

  test('continues to respect the external killswitch with a host default', () => {
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT = '1'
    gate.mockReturnValue(false)
    expect(isAgentSwarmsEnabled()).toBe(false)
    expect(gate).toHaveBeenCalledWith('tengu_amber_flint', true)
  })

  test('retains the Ant build bypass', () => {
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'
    gate.mockReturnValue(false)
    expect(isAgentSwarmsEnabled()).toBe(true)
    expect(gate).not.toHaveBeenCalled()
  })

  test('preserves the persisted team preference through settings parsing', async () => {
    const { SettingsSchema } = await import('./settings/types.js')
    for (const agentTeamsEnabled of [true, false]) {
      expect(SettingsSchema().parse({ agentTeamsEnabled }).agentTeamsEnabled).toBe(agentTeamsEnabled)
    }
    expect(SettingsSchema().safeParse({ agentTeamsEnabled: 'false' }).success).toBe(false)
  })
})
