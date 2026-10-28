export const GROK_DEFAULT_MAIN_MODEL = 'grok-4.7'
export const GROK_DEFAULT_SONNET_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_HAIKU_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_CONTEXT_WINDOW = 500_000
export const GROK_MODEL_CATALOG_ENV_KEY = 'CC_HAHA_GROK_MODEL_CATALOG'

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
  if (
    runtimeCatalog === GROK_MODEL_CATALOG &&
    process.env.CC_HAHA_GROK_OAUTH_PROVIDER === '1'
  ) {
    return parseRuntimeModelCatalog(process.env[GROK_MODEL_CATALOG_ENV_KEY]) ?? runtimeCatalog
  }
  return runtimeCatalog
}

// A server's in-memory discovery does not survive the CLI process boundary.
// Read its launch snapshot only until this process accepts its own live catalog.
function parseRuntimeModelCatalog(raw: string | undefined): GrokModelCatalogEntry[] | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.length) return undefined
    const models: GrokModelCatalogEntry[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
      const record = entry as Record<string, unknown>
      if (typeof record.value !== 'string' || !record.value.trim()) return undefined
      if (record.label !== undefined && typeof record.label !== 'string') return undefined
      if (record.description !== undefined && typeof record.description !== 'string') return undefined
      if (record.supportsReasoningEffort !== undefined && typeof record.supportsReasoningEffort !== 'boolean') return undefined
      if (record.reasoningEffort !== undefined && (typeof record.reasoningEffort !== 'string' || !record.reasoningEffort.trim())) return undefined
      if (record.reasoningEfforts !== undefined && (
        !Array.isArray(record.reasoningEfforts) ||
        !record.reasoningEfforts.every((effort) => typeof effort === 'string' && !!effort.trim())
      )) return undefined
      if (record.contextWindow !== undefined && (
        typeof record.contextWindow !== 'number' || !Number.isFinite(record.contextWindow) || record.contextWindow <= 0
      )) return undefined
      if (record.source !== undefined && record.source !== 'official' && record.source !== 'cli') return undefined
      models.push({
        value: record.value,
        label: record.label ?? record.value,
        description: record.description ?? '',
        ...(record.contextWindow !== undefined && { contextWindow: record.contextWindow }),
        ...(record.source !== undefined && { source: record.source }),
        ...(record.supportsReasoningEffort !== undefined && { supportsReasoningEffort: record.supportsReasoningEffort }),
        ...(record.reasoningEffort !== undefined && { reasoningEffort: record.reasoningEffort }),
        ...(record.reasoningEfforts !== undefined && { reasoningEfforts: record.reasoningEfforts }),
      })
    }
    return models
  } catch {
    return undefined
  }
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
