import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { EFFORT_LEVELS } from '../../utils/effort.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { isolateModelDefaultsEnv } from '../../testUtils/modelEnv.js'

// strictPluginOnlyCustomization comes from managed settings, whose path is
// memoized without a cache key and cannot be redirected on a non-ant build.
// Only the policy answer is faked; every other input below is a real file.
let agentsSurfaceLocked = false
const actualPolicy = await import('../../utils/settings/pluginOnlyPolicy.js')
mock.module('../../utils/settings/pluginOnlyPolicy.js', () => ({
  ...actualPolicy,
  isRestrictedToPluginOnly: (surface: string) =>
    surface === 'agents' ? agentsSurfaceLocked : false,
}))

const { getBuiltInAgents, getBuiltInAgentsWithoutOverrides } = await import(
  './builtInAgents.js'
)
const { BUILT_IN_AGENT_OVERRIDE_EFFORT_LEVELS, resolveBuiltInAgentOverrides } =
  await import('./builtInAgentOverrides.js')

isolateModelDefaultsEnv()

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

let tmpDir: string

/** Write the user settings file the resolver reads, then clear the caches. */
function writeUserSettings(settings: unknown): void {
  fs.writeFileSync(
    path.join(tmpDir, 'settings.json'),
    JSON.stringify(settings ?? {}),
  )
  resetSettingsCache()
}

/** The shipped definition for an agent, whatever this build defaults it to. */
function baseline(agentType: string) {
  const agent = getBuiltInAgentsWithoutOverrides().find(
    candidate => candidate.agentType === agentType,
  )
  if (!agent) throw new Error(`No built-in agent named ${agentType}`)
  return agent
}

function effective(agentType: string) {
  const agent = getBuiltInAgents().find(
    candidate => candidate.agentType === agentType,
  )
  if (!agent) throw new Error(`No built-in agent named ${agentType}`)
  return agent
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'built-in-agent-overrides-'))
  // getClaudeConfigHomeDir memoizes on the value of this var, so assigning it
  // is enough to redirect the read without clearing a cache.
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  agentsSurfaceLocked = false
  writeUserSettings({})
})

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  resetSettingsCache()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('built-in agent overrides', () => {
  test('applies model and effort without mutating the shipped definitions', () => {
    const shippedModel = baseline('Explore').model
    const shippedEffort = baseline('Explore').effort

    writeUserSettings({
      builtInAgentOverrides: { Explore: { model: 'sonnet', effort: 'low' } },
    })

    const overridden = effective('Explore')
    expect(overridden.model).toBe('sonnet')
    expect(overridden.effort).toBe('low')
    expect(overridden.source).toBe('built-in')

    // The shipped definitions are module-level constants that resumeAgent and
    // AgentTool reference directly. An in-place write would leak across every
    // later caller and could not be undone by removing the setting.
    expect(baseline('Explore').model).toBe(shippedModel)
    expect(baseline('Explore').effort).toBe(shippedEffort)

    // …and applying twice must not accumulate.
    expect(effective('Explore').model).toBe('sonnet')
  })

  test('leaves agents without an override at their original object identity', () => {
    writeUserSettings({
      builtInAgentOverrides: { Explore: { model: 'sonnet' } },
    })

    const untouched = effective('general-purpose')
    expect(untouched).toBe(baseline('general-purpose'))
  })

  test('returns to the shipped default when the override is removed', () => {
    writeUserSettings({
      builtInAgentOverrides: { Explore: { model: 'sonnet', effort: 'high' } },
    })
    expect(effective('Explore').model).toBe('sonnet')

    writeUserSettings({})

    // Compared against the runtime baseline, never a literal: Explore ships as
    // 'haiku' externally and 'inherit' for ants, so a hardcoded expectation
    // would be wrong in half the builds and would rot the day the default moves.
    expect(effective('Explore').model).toBe(baseline('Explore').model)
    expect(effective('Explore').effort).toBe(baseline('Explore').effort)
  })

  test('clears one field while the other override survives', () => {
    writeUserSettings({
      builtInAgentOverrides: { Explore: { model: 'sonnet', effort: 'high' } },
    })
    writeUserSettings({
      builtInAgentOverrides: { Explore: { effort: 'high' } },
    })

    expect(effective('Explore').model).toBe(baseline('Explore').model)
    expect(effective('Explore').effort).toBe('high')
  })

  test('treats model "inherit" as a real override, not as a reset', () => {
    // Explore ships pinned to a small model externally, so "inherit" is a
    // meaningful and different choice. Collapsing it into "no override" would
    // make following the main session unreachable from the UI.
    writeUserSettings({
      builtInAgentOverrides: { Explore: { model: 'inherit' } },
    })

    expect(effective('Explore').model).toBe('inherit')
    expect(resolveBuiltInAgentOverrides().get('Explore')?.model).toEqual({
      value: 'inherit',
      source: 'userSettings',
    })
  })

  test('preserves the system-prompt function reference and arity', () => {
    writeUserSettings({
      builtInAgentOverrides: {
        'claude-code-guide': { model: 'sonnet' },
        Explore: { model: 'sonnet' },
      },
    })

    // serializeActiveAgent decides whether it may call getSystemPrompt with no
    // arguments by reading `.length`. claude-code-guide declares a parameter;
    // the others declare none. A wrapper would report 0 for both and the guide
    // agent would destructure undefined.
    const guide = effective('claude-code-guide')
    expect(guide.getSystemPrompt).toBe(baseline('claude-code-guide').getSystemPrompt)
    expect(guide.getSystemPrompt.length).toBe(1)

    const explore = effective('Explore')
    expect(explore.getSystemPrompt).toBe(baseline('Explore').getSystemPrompt)
    expect(explore.getSystemPrompt.length).toBe(0)
  })

  test('ignores an unknown agent and an invalid effort without dropping valid siblings', () => {
    writeUserSettings({
      builtInAgentOverrides: {
        Explorer: { model: 'opus' },
        Explore: { model: 'opus', effort: 'extreme' },
        Plan: { model: 'sonnet' },
      },
    })

    const explore = effective('Explore')
    expect(explore.model).toBe('opus')
    expect(explore.effort).toBe(baseline('Explore').effort)
    expect(effective('Plan').model).toBe('sonnet')
    // The unknown key is kept on disk — the built-in set varies with feature
    // flags and entrypoint, so pruning it would destroy a valid config the
    // moment a flag flipped.
    expect(
      getBuiltInAgents().some(agent => agent.agentType === 'Explorer'),
    ).toBe(false)
  })

  test('keeps a numeric effort, which existing SDK configs still use', () => {
    writeUserSettings({
      builtInAgentOverrides: { Explore: { effort: 7 } },
    })

    expect(effective('Explore').effort).toBe(7)
  })

  test('drops user overrides when the agents surface is locked to plugins', () => {
    writeUserSettings({
      builtInAgentOverrides: { Explore: { model: 'sonnet' } },
    })
    agentsSurfaceLocked = true
    resetSettingsCache()

    // settings.json is user-writable, so blocking only the write endpoint would
    // leave the policy trivially bypassable. It has to be enforced on read.
    expect(effective('Explore').model).toBe(baseline('Explore').model)
    expect(resolveBuiltInAgentOverrides().size).toBe(0)
  })

  test('applies user overrides when no such policy is set', () => {
    writeUserSettings({
      builtInAgentOverrides: { Explore: { model: 'sonnet' } },
    })
    agentsSurfaceLocked = false
    resetSettingsCache()

    expect(effective('Explore').model).toBe('sonnet')
  })

  test('keeps the SDK blank-slate opt-out ahead of overrides', () => {
    const originalDisable = process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
    process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = 'true'
    writeUserSettings({
      builtInAgentOverrides: { Explore: { model: 'sonnet' } },
    })

    try {
      expect(getBuiltInAgents()).toEqual([])
    } finally {
      if (originalDisable === undefined) {
        delete process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
      } else {
        process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = originalDisable
      }
    }
  })

  test('accepts every effort level the settings schema accepts', () => {
    // The schema inlines its level list to dodge an import cycle; this is the
    // join that proves the copy still matches the runtime source.
    expect(BUILT_IN_AGENT_OVERRIDE_EFFORT_LEVELS).toEqual(EFFORT_LEVELS)

    for (const effort of EFFORT_LEVELS) {
      const parsed = SettingsSchema().parse({
        builtInAgentOverrides: { Explore: { effort } },
      })
      expect(parsed.builtInAgentOverrides?.Explore?.effort).toBe(effort)

      writeUserSettings({ builtInAgentOverrides: { Explore: { effort } } })
      expect(effective('Explore').effort).toBe(effort)
    }
  })
})
