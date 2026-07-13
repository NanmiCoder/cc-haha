import {
  buildGrokIdentityHeaders,
  GROK_CLI_BASE_URL,
} from './fetch.js'
import { ensureFreshGrokTokens } from './refresh.js'
import {
  GROK_DEFAULT_CONTEXT_WINDOW,
  GROK_MODEL_CATALOG,
  type GrokModelCatalogEntry,
} from './models.js'

export const GROK_MODELS_ENDPOINT = `${GROK_CLI_BASE_URL}/models`
const MODEL_CATALOG_TTL_MS = 5 * 60_000
let cachedCatalog: {
  accountKey: string
  expiresAt: number
  models: GrokModelCatalogEntry[]
} | null = null

export async function fetchGrokModelCatalog(
  fetchOverride: typeof fetch = globalThis.fetch,
  accessToken?: string,
): Promise<GrokModelCatalogEntry[]> {
  const token = accessToken || (await ensureFreshGrokTokens({ fetchOverride }))?.accessToken
  if (!token) throw new Error('Grok OAuth token is unavailable')
  const response = await fetchOverride(GROK_MODELS_ENDPOINT, {
    method: 'GET',
    headers: buildGrokIdentityHeaders(token),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    throw new Error(`Grok models endpoint returned HTTP ${response.status}`)
  }
  const body = await response.json() as unknown
  const rows = extractModelRows(body)
  const models = rows
    .map(normalizeRemoteModel)
    .filter((model): model is GrokModelCatalogEntry => model !== null)
  if (!models.length) throw new Error('Grok models endpoint returned no models')
  return models
}

export async function getGrokModelCatalog(options?: {
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
  accessToken?: string
  accountKey?: string
}): Promise<GrokModelCatalogEntry[]> {
  const accountKey = options?.accountKey ?? (options?.accessToken ? 'authenticated' : 'default')
  if (
    !options?.forceRefresh &&
    cachedCatalog?.accountKey === accountKey &&
    cachedCatalog.expiresAt > Date.now()
  ) {
    return cachedCatalog.models
  }
  try {
    const models = await fetchGrokModelCatalog(
      options?.fetchOverride,
      options?.accessToken,
    )
    cachedCatalog = {
      accountKey,
      expiresAt: Date.now() + MODEL_CATALOG_TTL_MS,
      models,
    }
    return models
  } catch {
    return GROK_MODEL_CATALOG
  }
}

export function clearGrokModelCatalogCache(): void {
  cachedCatalog = null
}

function extractModelRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return []
  const record = body as Record<string, unknown>
  if (Array.isArray(record.models)) return record.models
  if (isKeyedObject(record.models)) return keyedModelRows(record.models)
  if (Array.isArray(record.data)) return record.data
  if (isKeyedObject(record.data)) return keyedModelRows(record.data)
  return keyedModelRows(record)
}

function keyedModelRows(record: Record<string, unknown>): unknown[] {
  return Object.entries(record)
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([key, value]) => ({ ...(value as Record<string, unknown>), __key: key }))
}

function normalizeRemoteModel(value: unknown): GrokModelCatalogEntry | null {
  if (!value || typeof value !== 'object') return null
  const outer = value as Record<string, unknown>
  const meta = isKeyedObject(outer.meta) ? outer.meta : {}
  const info = isKeyedObject(outer.info) ? outer.info : {}
  const record = { ...outer, ...meta, ...info }
  if (record.hidden === true || record.supported_in_api === false || record.supportedInApi === false) {
    return null
  }
  const id = firstString(record.id, record.slug, record.model, record.value, record.__key)
  if (!id) return null
  const fallback = GROK_MODEL_CATALOG.find((model) => model.value === id)
  const label = firstString(record.display_name, record.displayName, record.name, record.label) ?? fallback?.label ?? id
  const description = firstString(record.description) ?? fallback?.description ?? ''
  const contextWindow = firstNumber(
    record.totalContextTokens,
    record.total_context_tokens,
    record.context_window,
    record.contextWindow,
  ) ?? fallback?.contextWindow ?? GROK_DEFAULT_CONTEXT_WINDOW
  const supportsReasoningEffort = firstBoolean(
    record.supportsReasoningEffort,
    record.supports_reasoning_effort,
  )
  const reasoningEffort = firstString(
    record.reasoningEffort,
    record.reasoning_effort,
  )
  const reasoningEfforts = firstStringArray(
    record.reasoningEfforts,
    record.reasoning_efforts,
  )
  return {
    value: id,
    label,
    description,
    contextWindow,
    source: fallback?.source ?? 'official',
    ...(supportsReasoningEffort !== undefined && { supportsReasoningEffort }),
    ...(reasoningEffort && { reasoningEffort }),
    ...(reasoningEfforts && { reasoningEfforts }),
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && !!value.trim())?.trim()
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean')
}

function firstStringArray(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue
    const strings = value.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item.trim()]
      if (!isKeyedObject(item)) return []
      const candidate = firstString(item.value, item.id)
      return candidate ? [candidate] : []
    })
    if (strings.length) return strings
  }
  return undefined
}

function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
