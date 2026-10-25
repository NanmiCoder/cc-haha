import { getCanonicalName, parseUserSpecifiedModel } from './model.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'
import { isModelAlias } from './aliases.js'

export function getClaudeAgentModelFamily(model: string): string | undefined {
  const base = model.trim().replace(/\[1m\]$/i, '').toLowerCase()
  // Include old versions absent from today's catalog and Claude 3.x IDs.
  return base.match(/^claude-(?:\d+(?:-\d+)*-)?(fable|opus|sonnet|haiku)-(?:\d[\d.-]*|latest)$/)?.[1]
}

export function isClaudeAgentModelSuggestion(model: string): boolean {
  return isModelAlias(model.trim().toLowerCase()) || getClaudeAgentModelFamily(model) !== undefined
}

/** Claude tier suggestions cannot select a different model on a non-Claude session. */
export function usesNonClaudeAgentRouting(parentModel: string | null): boolean {
  return Boolean(
    parentModel &&
    getAPIProvider() === 'firstParty' &&
    !isFirstPartyAnthropicBaseUrl() &&
    !getCanonicalName(parentModel).startsWith('claude-'),
  )
}

/** Resolve saved Claude version pins through an explicitly mapped provider slot. */
export function resolveAgentModelSpec(model: string, parentModel: string | null): string {
  if (usesNonClaudeAgentRouting(parentModel)) {
    const family = getClaudeAgentModelFamily(model)
    if (family) {
      const mapped = process.env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`]?.trim() ||
        (family === 'fable' ? process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() : undefined)
      if (mapped && !getCanonicalName(mapped).startsWith('claude-')) return mapped
    }
  }
  return parseUserSpecifiedModel(model)
}
