import { EFFORT_LEVELS, type EffortValue, parseEffortValue } from '../../utils/effort.js'
import {
  getEnabledSettingSources,
  type SettingSource,
} from '../../utils/settings/constants.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { resolveAgentModelSpec, usesNonClaudeAgentRouting } from '../../utils/model/agentModelRouting.js'

/**
 * `SettingsSchema` inlines its effort level list to avoid a
 * types -> effort -> settings -> types import cycle. Exported so
 * builtInAgentOverrides.test.ts can assert the copy has not drifted.
 */
export const BUILT_IN_AGENT_OVERRIDE_EFFORT_LEVELS = EFFORT_LEVELS

export type OverriddenField<T> = {
  value: T
  /** Which settings file supplied this value — drives editability in the UI. */
  source: SettingSource
}

export type ResolvedBuiltInAgentOverride = {
  model?: OverriddenField<string>
  effort?: OverriddenField<EffortValue>
}

/**
 * Read `builtInAgentOverrides` from every enabled settings source, lowest
 * priority first, recording per field which source won.
 *
 * Deliberately walks sources instead of reading the merged settings object.
 * The merged value would be identical, but the per-source walk buys two things
 * the merge cannot:
 *   1. Field-level source attribution, so the desktop can disable a control
 *      whose value comes from a managed policy the user cannot edit.
 *   2. Load-time enforcement of `strictPluginOnlyCustomization`. That policy
 *      already blocks `~/.claude/agents/*.md` in markdownConfigLoader; without
 *      the same filter here, a hand-edited settings.json would be a way around
 *      it. Blocking only the write path would not be enough — settings.json is
 *      user-writable by definition.
 */
export function resolveBuiltInAgentOverrides(): Map<
  string,
  ResolvedBuiltInAgentOverride
> {
  const resolved = new Map<string, ResolvedBuiltInAgentOverride>()
  const agentsLocked = isRestrictedToPluginOnly('agents')

  for (const source of getEnabledSettingSources()) {
    if (agentsLocked && !isSourceAdminTrusted(source)) continue

    const overrides = getSettingsForSource(source)?.builtInAgentOverrides
    if (!overrides) continue

    for (const [agentType, entry] of Object.entries(overrides)) {
      if (!entry || typeof entry !== 'object') continue

      // Re-validate rather than trusting the schema: policySettings can arrive
      // from MDM/registry/remote sync, which never passes through the file
      // parser that applies the per-field .catch().
      const model =
        typeof entry.model === 'string' && entry.model.trim().length > 0
          ? entry.model.trim()
          : undefined
      const effort = parseEffortValue(entry.effort)
      if (model === undefined && effort === undefined) continue

      const current = resolved.get(agentType) ?? {}
      // Later sources win, but only for the fields they actually specify — a
      // project-level model must not erase a user-level effort.
      if (model !== undefined) current.model = { value: model, source }
      if (effort !== undefined) current.effort = { value: effort, source }
      resolved.set(agentType, current)
    }
  }

  return resolved
}

/** Shipped Claude tiers are defaults; only user overrides pin non-Claude runs. */
export function getAgentModelSetting(
  agent: AgentDefinition | undefined,
  parentModel: string | null,
): string | undefined {
  if (
    agent?.source === 'built-in' &&
    usesNonClaudeAgentRouting(parentModel) &&
    !resolveBuiltInAgentOverrides().get(agent.agentType)?.model
  ) return 'inherit'
  const model = agent?.model
  return model && model !== 'inherit' && usesNonClaudeAgentRouting(parentModel)
    ? resolveAgentModelSpec(model, parentModel)
    : model
}

/**
 * Apply resolved overrides onto built-in agent definitions.
 *
 * Two constraints that are load-bearing, not stylistic:
 *
 *   - Never mutate in place, and only copy the entries that actually carry an
 *     override. Call sites such as resumeAgent hold references to the exported
 *     module constants, so untouched agents must come back with their original
 *     object identity.
 *   - Never wrap `getSystemPrompt`. serializeActiveAgent in the agents API
 *     branches on `getSystemPrompt.length === 0` to decide whether it can call
 *     the function with no arguments; CLAUDE_CODE_GUIDE_AGENT declares one
 *     parameter and the other built-ins declare none. Any `(...args) => fn()`
 *     wrapper reports length 0 for all of them and the guide agent then
 *     destructures `undefined`. Spreading preserves both the reference and the
 *     arity.
 */
export function applyBuiltInAgentOverrides(
  agents: AgentDefinition[],
): AgentDefinition[] {
  const overrides = resolveBuiltInAgentOverrides()
  if (overrides.size === 0) return agents

  return agents.map(agent => {
    const override = overrides.get(agent.agentType)
    if (!override?.model && !override?.effort) return agent

    return {
      ...agent,
      ...(override.model ? { model: override.model.value } : {}),
      ...(override.effort ? { effort: override.effort.value } : {}),
    }
  })
}
