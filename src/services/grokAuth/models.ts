export const GROK_DEFAULT_MAIN_MODEL = 'grok-4.7'
export const GROK_DEFAULT_SONNET_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_HAIKU_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_CONTEXT_WINDOW = 500_000

export type GrokModelCatalogEntry = {
  value: string
  label: string
  description: string
  contextWindow?: number
  source?: 'official' | 'cli'
  supportsReasoningEffort?: boolean
  reasoningEffort?: string
  reasoningEfforts?: string[]
}

export const GROK_MODEL_CATALOG: GrokModelCatalogEntry[] = [
  {
    ...model('grok-4.7', 'Grok 4.7', "SpaceXAI's latest frontier model", 500_000),
    supportsReasoningEffort: true,
    reasoningEffort: 'high',
    reasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
  },
  {
    ...model('grok-4.7-build-fast', 'Grok 4.7 Fast', 'Fast variant. 2x the price.', 500_000),
    supportsReasoningEffort: true,
    reasoningEffort: 'high',
    reasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
  },
  {
    ...model('grok-4.6', 'Grok 4.6', 'Grok 4.6 frontier model', 500_000),
    supportsReasoningEffort: true,
    reasoningEffort: 'high',
    reasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
  },
  {
    ...model('grok-4.5', 'Grok 4.5', 'Grok frontier text model', 500_000),
    supportsReasoningEffort: true,
    reasoningEffort: 'high',
    reasoningEfforts: ['high', 'medium', 'low'],
  },
]

function model(
  value: string,
  label: string,
  description: string,
  contextWindow: number,
  source: 'official' | 'cli' = 'official',
): GrokModelCatalogEntry {
  return { value, label, description, contextWindow, source }
}

/**
 * The catalog as last seen from the live `/v1/models` feed, falling back to the
 * bundled entries until that fetch lands.
 *
 * This state lives here rather than in `modelCatalog.ts` because that module
 * builds its request endpoint from `fetch.ts`, and the request transform in
 * `fetch.ts` needs to read the live catalog. Keeping the pointer in the
 * dependency-free catalog module is what lets both sides share it without an
 * import cycle.
 */
let runtimeCatalog: readonly GrokModelCatalogEntry[] = GROK_MODEL_CATALOG

export function setGrokRuntimeModelCatalog(
  models: readonly GrokModelCatalogEntry[],
): void {
  runtimeCatalog = models
}

export function getGrokRuntimeModelCatalog(): readonly GrokModelCatalogEntry[] {
  return runtimeCatalog
}

const EXPLICIT_MODELS = new Set(GROK_MODEL_CATALOG.map((entry) => entry.value))
const CLAUDE_COMPATIBILITY_ALIASES = new Set([
  'default',
  'grok',
  'haiku',
  'sonnet',
  'opus',
])

export function resolveGrokModel(modelId: string): string {
  const requested = modelId.trim()
  const normalized = requested.toLowerCase()
  if (EXPLICIT_MODELS.has(normalized)) return normalized
  if (
    !normalized ||
    normalized.startsWith('claude-') ||
    CLAUDE_COMPATIBILITY_ALIASES.has(normalized)
  ) {
    return GROK_DEFAULT_MAIN_MODEL
  }

  // The authenticated catalog can expose models newer than this bundled
  // client. Forward those IDs unchanged so selecting a remotely advertised
  // model never silently sends the request to a different model.
  return requested
}

export function getGrokContextWindowForModel(modelId: string): number | null {
  const resolved = resolveGrokModel(modelId)
  return GROK_MODEL_CATALOG.find((model) => model.value === resolved)?.contextWindow ?? null
}

/**
 * `catalog` is the live `/v1/models` view. The bundled catalog is only a
 * fallback, so a model that exists upstream but predates this build must be
 * resolved against the live entries or every future model launch silently
 * degrades its effort to the upstream default.
 */
export function resolveGrokReasoningEffort(
  modelId: string,
  requestedEffort: unknown,
  catalog: readonly GrokModelCatalogEntry[] = GROK_MODEL_CATALOG,
): string | undefined {
  const resolved = resolveGrokModel(modelId)
  const model =
    catalog.find((entry) => entry.value === resolved) ??
    GROK_MODEL_CATALOG.find((entry) => entry.value === resolved)
  if (model) {
    if (model.supportsReasoningEffort === false) return undefined
    if (
      typeof requestedEffort === 'string' &&
      model.reasoningEfforts?.includes(requestedEffort)
    ) {
      return requestedEffort
    }
    return model.reasoningEffort
  }
  // Absent from both catalogs, so upstream advertises a model this build does
  // not describe. The requested effort already went through the OpenAI effort
  // vocabulary and the server validated it against that same live catalog, so
  // forward it rather than silently sending a different effort than the user
  // selected.
  return typeof requestedEffort === 'string' ? requestedEffort : undefined
}
