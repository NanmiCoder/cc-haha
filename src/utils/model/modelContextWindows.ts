export const MODEL_CONTEXT_WINDOWS_ENV_KEY = 'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS'
export const MODEL_CONTEXT_WINDOW_MIN = 16_000
export const MODEL_CONTEXT_WINDOW_MAX = 10_000_000

const DIRECT_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-ai/deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
  'k3': 262_144,
  'kimi-for-coding': 262_144,
  'kimi-for-coding-highspeed': 262_144,
  'kimi-k2.7-code': 262_144,
  'kimi-k2.7-code-highspeed': 262_144,
  'kimi-k2.6': 262_144,
  'kimi-k2.5': 262_144,
  'kimi-k2-0905-preview': 262_144,
  'kimi-k2-turbo-preview': 262_144,
  'kimi-k2-thinking': 262_144,
  'kimi-k2-thinking-turbo': 262_144,
  'minimax-m3': 1_000_000,
  'minimax-m2.7': 204_800,
  'minimax-m2.7-highspeed': 204_800,
  'qwen/qwen3.6-27b': 262_144,
  'qwen3.6:27b': 262_144,
  'glm-5.3': 1_000_000,
  'glm-5.3-flash': 1_000_000,
  'glm-5.2': 1_000_000,
  'glm-5.1': 200_000,
  'glm-5': 200_000,
  'glm-5-turbo': 200_000,
  'glm-4.7': 200_000,
  'glm-4.6': 200_000,
  'glm-4.5': 128_000,
  'glm-4.5-air': 128_000,
}

const PATTERN_MODEL_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/^anthropic\/claude-fable-5\b/i, 1_000_000],
  [/^anthropic\/claude-opus-4\.8\b/i, 1_000_000],
  [/^anthropic\/claude-sonnet-5\b/i, 1_000_000],
  [/^anthropic\/claude-opus-4\.7\b/i, 1_000_000],
  [/^anthropic\/claude-sonnet-4\.6\b/i, 200_000],
  [/^anthropic\/claude-haiku-4\.5\b/i, 200_000],
  [/^openai\/gpt-4\.1\b/i, 1_047_576],
  [/^openai\/gpt-5(?:[.-]\d+)?\b/i, 400_000],
  [/^google\/gemini-(?:2\.0|2\.5|3)/i, 1_048_576],
  [/^gemini-(?:2\.0|2\.5|3)/i, 1_048_576],
  [/^zai-org\/glm-5\.3(?:-flash)?\b/i, 1_000_000],
  [/^zai-org\/glm-5\.2\b/i, 1_000_000],
  [/^(?:qwen\/)?qwen3\.7-(?:max|plus)(?:[-.][\w.-]+)?\b/i, 1_000_000],
  [/^(?:qwen\/)?qwen3\.6-(?:plus|flash)(?:[-.][\w.-]+)?\b/i, 1_000_000],
  [/^(?:qwen\/)?qwen3\.6-max-preview\b/i, 262_144],
  [/^(?:qwen\/)?qwen3\.5-(?:plus|flash)(?:[-.][\w.-]+)?\b/i, 1_000_000],
  [/^(?:qwen\/)?qwen3-max(?:[-.][\w.-]+)?\b/i, 262_144],
  [/^(?:qwen\/)?qwen3-coder-plus(?:[-.][\w.-]+)?\b/i, 1_000_000],
  [/^(?:qwen\/)?qwen3-coder-next(?:[-.][\w.-]+)?\b/i, 262_144],
  [/qwen-long/i, 10_000_000],
]

export function normalizeModelContextKey(model: string): string {
  return model
    .trim()
    .replace(/\[1m\]$/i, '')
    .replace(/:1m$/i, '')
    .toLowerCase()
}

function normalizeWindow(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined
  }
  if (value < MODEL_CONTEXT_WINDOW_MIN || value > MODEL_CONTEXT_WINDOW_MAX) {
    return undefined
  }
  return value
}

function normalizeConfiguredContextWindows(parsed: unknown): Record<string, number> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  const windows: Record<string, number> = {}
  for (const [model, value] of Object.entries(parsed)) {
    const normalized = normalizeWindow(value)
    if (normalized !== undefined) {
      windows[normalizeModelContextKey(model)] = normalized
    }
  }
  return windows
}

function findConfiguredModelContextWindow(
  model: string,
  configured: Record<string, number>,
): number | undefined {
  const normalizedModel = normalizeModelContextKey(model)
  const exact = configured[normalizedModel]
  if (exact !== undefined) {
    return exact
  }

  for (const [configuredModel, window] of Object.entries(configured)) {
    if (
      normalizedModel.endsWith(`/${configuredModel}`) ||
      normalizedModel.endsWith(`:${configuredModel}`)
    ) {
      return window
    }
  }
  return undefined
}

export function getModelContextWindowFromEnvValue(
  model: string,
  raw: string | undefined,
): number | undefined {
  if (!raw?.trim()) {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return findConfiguredModelContextWindow(
      model,
      normalizeConfiguredContextWindows(parsed),
    )
  } catch {
    return undefined
  }
}

function parseConfiguredContextWindows(): Record<string, number> {
  const raw = process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
  if (!raw?.trim()) {
    return {}
  }

  try {
    return normalizeConfiguredContextWindows(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return {}
  }
}

export function getConfiguredModelContextWindow(
  model: string,
): number | undefined {
  return findConfiguredModelContextWindow(model, parseConfiguredContextWindows())
}

export function getBuiltInModelContextWindow(model: string): number | undefined {
  const normalizedModel = normalizeModelContextKey(model)
  const exact = DIRECT_MODEL_CONTEXT_WINDOWS[normalizedModel]
  if (exact !== undefined) {
    return exact
  }

  for (const [pattern, window] of PATTERN_MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(normalizedModel)) {
      return window
    }
  }
  return undefined
}

export function getConfiguredOrBuiltInModelContextWindow(
  model: string,
): number | undefined {
  return (
    getConfiguredModelContextWindow(model) ??
    getBuiltInModelContextWindow(model)
  )
}
