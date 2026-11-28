/**
 * Shared Claude fast-mode model eligibility helpers used across CLI, desktop
 * server, and desktop UI.
 *
 * Mirrors the official Claude Code CLI fast-mode model matrix:
 * - Opus 5.5, Opus 5, Opus 4.8, Fable 5.2, Mythos 5.2 (current fast-mode models)
 * - Opus 4.6 (legacy fast-mode model still accepted by first-party API)
 * - Short aliases `opus`, `fable`, and `best` (which resolve to fast-mode models)
 */

const CLAUDE_FAST_MODE_ALIAS_SET = new Set(['opus', 'fable', 'best'])

const CLAUDE_FAST_MODE_EXACT_MODELS = new Set([
  'claude-opus-4-6',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5-2',
  'claude-mythos-5-2',
])

export const CLAUDE_FAST_MODE_SUPPORTED_MODELS_DISPLAY =
  'Opus 5.5 / 5 / 4.8 / 4.6, Fable 5.2'

/**
 * Normalize a raw model ID or alias into its canonical lower-case base ID
 * without 1M context suffixes, provider prefixes, or snapshot date suffixes.
 */
export function normalizeClaudeFastModeModelId(
  model: string | null | undefined,
): string {
  if (!model) return ''
  let normalized = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/i, '')
    .replace(/:1m$/i, '')
    .trim()

  // Strip Bedrock/Vertex/Foundry prefixes & version suffixes if present.
  normalized = normalized
    .replace(/^(?:us|eu|apac|global)\.anthropic\./, '')
    .replace(/^anthropic\./, '')
    .replace(/@\d{8}$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '')

  return normalized
}

/**
 * Returns true if the given model ID or alias identifies a Claude-family model
 * (including unsupported generations such as Sonnet/Haiku/Opus 4.5/Fable 5.1).
 */
export function isClaudeFamilyModelId(
  model: string | null | undefined,
): boolean {
  const normalized = normalizeClaudeFastModeModelId(model)
  if (!normalized) return false
  return (
    normalized.startsWith('claude-') ||
    normalized === 'opus' ||
    normalized === 'sonnet' ||
    normalized === 'haiku' ||
    normalized === 'fable' ||
    normalized === 'best'
  )
}

/**
 * Returns true if the given Claude model ID or alias supports official
 * Anthropic fast mode (`speed: "fast"` + `fast-mode-2026-02-01` beta).
 */
export function isClaudeFastModeSupportedModel(
  model: string | null | undefined,
): boolean {
  const normalized = normalizeClaudeFastModeModelId(model)
  if (!normalized) return false
  if (CLAUDE_FAST_MODE_ALIAS_SET.has(normalized)) return true
  return CLAUDE_FAST_MODE_EXACT_MODELS.has(normalized)
}
