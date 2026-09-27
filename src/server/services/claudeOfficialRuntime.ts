import type { SubscriptionType } from '../../services/oauth/types.js'
import type { ModelMapping } from '../types/provider.js'
import { hahaOAuthService } from './hahaOAuthService.js'

export const CLAUDE_OFFICIAL_OPUS_MODEL_ID = 'claude-opus-5-5'
export const CLAUDE_OFFICIAL_SONNET_MODEL_ID = 'claude-sonnet-5'

export const CLAUDE_OFFICIAL_DEFAULT_MODELS: ModelMapping = {
  main: CLAUDE_OFFICIAL_OPUS_MODEL_ID,
  fable: 'claude-fable-5-1',
  haiku: 'claude-haiku-4-5',
  sonnet: CLAUDE_OFFICIAL_SONNET_MODEL_ID,
  opus: CLAUDE_OFFICIAL_OPUS_MODEL_ID,
}

const CURRENT_MODEL_ALIASES = new Map<string, string>([
  ['fable', 'claude-fable-5'],
  ['opus', CLAUDE_OFFICIAL_OPUS_MODEL_ID],
  ['sonnet', CLAUDE_OFFICIAL_SONNET_MODEL_ID],
  ['haiku', 'claude-haiku-4-5'],
  ['claude-fable-5', 'claude-fable-5'],
  [CLAUDE_OFFICIAL_OPUS_MODEL_ID, CLAUDE_OFFICIAL_OPUS_MODEL_ID],
  [CLAUDE_OFFICIAL_SONNET_MODEL_ID, CLAUDE_OFFICIAL_SONNET_MODEL_ID],
  ['claude-haiku-4-5', 'claude-haiku-4-5'],
])

export function isLegacyClaudeOfficialDefaultModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase() === 'opus[1m]'
}

export function getClaudeOfficialDefaultModelId(
  subscriptionType: SubscriptionType | null,
): string {
  return subscriptionType === 'max'
    ? CLAUDE_OFFICIAL_OPUS_MODEL_ID
    : CLAUDE_OFFICIAL_SONNET_MODEL_ID
}

export function normalizeExplicitClaudeOfficialModelId(modelId: string): string | null {
  const trimmed = modelId.trim()
  if (!trimmed) return null

  const withoutContext = trimmed.replace(/(?:\[1m\]|:1m)$/i, '')
  const knownModel = CURRENT_MODEL_ALIASES.get(withoutContext.toLowerCase())
  if (knownModel) return knownModel

  // Keep an explicit first-party full model id, including older Claude models.
  // Unknown third-party ids must not leak into the managed Claude OAuth runtime.
  return withoutContext.toLowerCase().startsWith('claude-') ? withoutContext : null
}

/**
 * Resolve a model only when the desktop-managed Claude OAuth login is active.
 * A null result means the caller is not in that auth mode and must preserve its
 * existing API-key/provider behavior.
 */
export async function resolveClaudeOfficialRuntimeModel(
  configuredModel?: unknown,
): Promise<string | null> {
  const tokens = await hahaOAuthService.ensureFreshTokens()
  if (!tokens?.accessToken) return null

  const defaultModel = getClaudeOfficialDefaultModelId(tokens.subscriptionType)
  if (typeof configuredModel !== 'string') return defaultModel
  if (isLegacyClaudeOfficialDefaultModelId(configuredModel)) return defaultModel

  return normalizeExplicitClaudeOfficialModelId(configuredModel) ?? defaultModel
}
