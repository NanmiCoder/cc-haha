export const API_KEY_JSON_PLACEHOLDER = '••••••••'

const API_KEY_JSON_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const

const PROVIDER_SETTINGS_JSON_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ENABLE_TOOL_SEARCH',
  'CC_HAHA_OPENAI_OAUTH_PROVIDER',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'OPENAI_CODEX_OAUTH_FILE',
])

function getEnvRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as { env?: unknown }
    if (!parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) {
      return null
    }
    return parsed.env as Record<string, unknown>
  } catch {
    return null
  }
}

function isSecretDisplayValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value !== API_KEY_JSON_PLACEHOLDER &&
    value !== '(your API key)' &&
    value !== 'proxy-managed'
  )
}

export function maskSettingsJsonSecrets(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> }
    if (!parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) return raw
    let changed = false
    for (const key of API_KEY_JSON_KEYS) {
      if (isSecretDisplayValue(parsed.env[key])) {
        parsed.env[key] = API_KEY_JSON_PLACEHOLDER
        changed = true
      }
    }
    return changed ? JSON.stringify(parsed, null, 2) : raw
  } catch {
    return raw
  }
}

export function restoreSettingsJsonSecrets<T>(
  settings: T,
  previousRaw: string,
  fallbackApiKey = '',
): T {
  if (!settings || typeof settings !== 'object') return settings
  const parsed = settings as { env?: Record<string, unknown> }
  if (!parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) return settings

  const previousEnv = getEnvRecord(previousRaw)
  const fallback = fallbackApiKey.trim()

  for (const key of API_KEY_JSON_KEYS) {
    if (parsed.env[key] !== API_KEY_JSON_PLACEHOLDER) continue
    const previousValue = previousEnv?.[key]
    if (isSecretDisplayValue(previousValue)) {
      parsed.env[key] = previousValue
    } else if (fallback) {
      parsed.env[key] = fallback
    }
  }

  return settings
}

export function stripProviderSettingsJsonEnv(
  env: Record<string, string>,
  extraManagedKeys: Iterable<string> = [],
): Record<string, string> {
  const extraKeys = new Set(Array.from(extraManagedKeys, key => key.toUpperCase()))
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const upperKey = key.toUpperCase()
      return !PROVIDER_SETTINGS_JSON_ENV_KEYS.has(upperKey) && !extraKeys.has(upperKey)
    }),
  )
}
