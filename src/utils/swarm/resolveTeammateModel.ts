import { getGlobalConfig } from '../config.js'
import { isClaudeAgentModelSuggestion, resolveAgentModelSpec, usesNonClaudeAgentRouting } from '../model/agentModelRouting.js'
import { getHardcodedTeammateModelFallback } from './teammateModel.js'

function getDefaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (typeof configured === 'string' && configured.trim()) {
    return resolveAgentModelSpec(configured, leaderModel)
  }
  // Unset (`undefined`) and /config "Default" (`null`) both follow the leader.
  // A first-party Opus ID here is what sent mapped third-party teammates
  // (cc-switch DeepSeek, etc.) to the upstream's most expensive model.
  return leaderModel ?? getHardcodedTeammateModelFallback()
}

/**
 * Resolve a teammate model using the same precedence for tmux and in-process
 * teammates: concrete env override, invocation override, selected Agent
 * definition, then leader/default. `inherit` is never forwarded literally;
 * it falls through to the next source. gh-31069 documents why passing it to
 * --model is invalid.
 * On non-Claude sessions, invocation tier aliases defer to the selected Agent
 * or leader/default. Concrete user presets still resolve through provider slots.
 *
 * Exported for testing.
 */
export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
  agentModel?: string,
  hasAgentDefinition = agentModel !== undefined,
): string {
  const normalizeModelSpec = (
    value: string | undefined,
  ): string | undefined => {
    const trimmed = value?.trim()
    return trimmed || undefined
  }

  const configuredSubagentModel = normalizeModelSpec(
    process.env.CLAUDE_CODE_SUBAGENT_MODEL,
  )
  if (
    configuredSubagentModel &&
    configuredSubagentModel.toLowerCase() !== 'inherit'
  ) {
    return resolveAgentModelSpec(configuredSubagentModel, leaderModel)
  }

  const invocationModel = normalizeModelSpec(inputModel)
  if (invocationModel) {
    if (invocationModel.toLowerCase() === 'inherit') {
      return leaderModel ?? getDefaultTeammateModel(leaderModel)
    }
    // A generated Claude tier is only a model choice in a Claude session.
    // Non-Claude sessions keep the selected Agent/default rather than jumping
    // from e.g. DeepSeek Flash to the provider's Opus → Pro mapping.
    if (!usesNonClaudeAgentRouting(leaderModel) || !isClaudeAgentModelSuggestion(invocationModel)) {
      return resolveAgentModelSpec(invocationModel, leaderModel)
    }
  }

  if (hasAgentDefinition) {
    const definitionModel = normalizeModelSpec(agentModel)
    if (
      definitionModel &&
      definitionModel.toLowerCase() !== 'inherit'
    ) {
      // Agent page / frontmatter is the highest teammate-specific pin.
      // Resolve aliases so `opus` on a mapped provider becomes that
      // provider's opus slot, not a first-party Opus ID.
      return resolveAgentModelSpec(definitionModel, leaderModel)
    }
    // Official Agent frontmatter defaults to `inherit`, so a selected Agent
    // follows the leader when its model is omitted or explicitly inherit.
    return leaderModel ?? getDefaultTeammateModel(leaderModel)
  }

  // Plain teammates: a pinned /config teammateDefaultModel still wins;
  // otherwise follow the leader (same as an Agent whose model is inherit).
  return getDefaultTeammateModel(leaderModel)
}
