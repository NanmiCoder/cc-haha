/**
 * Models a signed-in DeepSeek account may use.
 *
 * The account route does not list the same ids as the API-key route (V4.1
 * Flash is `deepseek-flash` there; `deepseek-v4-flash` is not listed), so the
 * picker reads `GET {inference}/models` with the account token, as DeepSeek
 * Harness does. Until a listing succeeds, the bundled catalog mirrors the one DeepSeek
 * Harness ships.
 */
import { createHash } from 'node:crypto'
import semver from 'semver'
import { createModelCatalogCache } from '../modelCatalogCache.js'
import {
  DEEPSEEK_AUTH_HEADER,
  DEEPSEEK_CLIENT_VERSION,
  DEEPSEEK_INFERENCE_ORIGIN,
  resolveProxyFetchOptions,
} from './client.js'

export const DEEPSEEK_MODELS_ENDPOINT = `${DEEPSEEK_INFERENCE_ORIGIN}/models`
// `client_requirements` is keyed by the product token of the client whose
// protocol the login speaks (see DEEPSEEK_CLIENT_VERSION).
const DEEPSEEK_CLIENT_PRODUCT = 'deepseek-harness'
const MODEL_CATALOG_TTL_MS = 10 * 60_000
const MODEL_CATALOG_FAILURE_BACKOFF_MS = 60_000
const MODEL_LISTING_TIMEOUT_MS = 5_000

export type DeepSeekAccountModel = {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities: Array<'text' | 'image'>
}

export const DEEPSEEK_ACCOUNT_MODEL_CATALOG: readonly DeepSeekAccountModel[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 1_000_000,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 1_000_000,
    inputModalities: ['text'],
  },
]

const catalogCache = createModelCatalogCache<readonly DeepSeekAccountModel[]>({
  ttlMs: MODEL_CATALOG_TTL_MS,
  failureBackoffMs: MODEL_CATALOG_FAILURE_BACKOFF_MS,
})

type Fields = Record<string, unknown>

function fieldsOf(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** A listed model this client may not drive: it requires a newer client than the one the login claims. */
function requiresNewerClient(entry: Fields): boolean {
  const own = fieldsOf(fieldsOf(entry.client_requirements)?.[DEEPSEEK_CLIENT_PRODUCT])
  const minVersion = own?.min_version
  if (minVersion === undefined) return false
  return typeof minVersion !== 'string' || !semver.valid(minVersion) ||
    semver.lt(DEEPSEEK_CLIENT_VERSION, minVersion)
}

function projectEntry(entry: Fields): DeepSeekAccountModel | null {
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!id) return null
  // Requests go out in Anthropic Messages format and expect text back.
  if (!fieldsOf(fieldsOf(entry.api_capabilities)?.anthropic_messages)) return null
  const outputs = entry.output_modalities === undefined ? ['text'] : stringList(entry.output_modalities)
  if (!outputs?.includes('text')) return null
  if (requiresNewerClient(entry)) return null

  const inputs = entry.input_modalities === undefined ? ['text'] : stringList(entry.input_modalities) ?? []
  const inputModalities = (['text', 'image'] as const).filter((modality) => inputs.includes(modality))
  if (inputModalities.length === 0) return null

  const contextWindow = positiveInteger(entry.context_window)
  const maxOutputTokens = positiveInteger(entry.max_output_tokens)
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id
  return {
    id,
    name,
    ...(contextWindow !== undefined && { contextWindow }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    inputModalities,
  }
}

/** Decode a `/models` body, keeping listing order and dropping repeats and models this client cannot drive. */
export function parseDeepSeekModelListing(body: unknown): DeepSeekAccountModel[] {
  const data = fieldsOf(body)?.data
  if (!Array.isArray(data)) throw new Error('DeepSeek model listing has no data array')
  const seen = new Set<string>()
  const models: DeepSeekAccountModel[] = []
  for (const row of data) {
    const entry = fieldsOf(row)
    const model = entry ? projectEntry(entry) : null
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  if (models.length === 0) throw new Error('DeepSeek model listing contains no usable model')
  return models
}

/**
 * @param proxyUrl - the app's network proxy, as the account's other requests
 *   use it; `undefined` leaves the process default (the desktop host clears
 *   inherited proxy variables, so that is a direct connection there).
 */
export async function fetchDeepSeekAccountModelCatalog(
  token: string,
  fetchOverride: typeof fetch = globalThis.fetch,
  proxyUrl?: string | null,
): Promise<DeepSeekAccountModel[]> {
  const response = await fetchOverride(DEEPSEEK_MODELS_ENDPOINT, {
    method: 'GET',
    headers: { accept: 'application/json', [DEEPSEEK_AUTH_HEADER]: token },
    // A redirect would replay the account token to another origin.
    redirect: 'error',
    signal: AbortSignal.timeout(MODEL_LISTING_TIMEOUT_MS),
    ...(await resolveProxyFetchOptions(proxyUrl)),
  })
  if (!response.ok) {
    throw new Error(`DeepSeek models endpoint returned HTTP ${response.status}`)
  }
  return parseDeepSeekModelListing(await response.json())
}

/**
 * The account's model catalog: the cached listing for this token, or the
 * bundled catalog while signed out or before a listing succeeds. Answers
 * without waiting for the network unless `forceRefresh` is set.
 */
export function getDeepSeekAccountModelCatalog(options: {
  token: string | null
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
  /** Resolved per listing request, so a proxy failure only fails that request. */
  resolveProxyUrl?: () => Promise<string | null | undefined>
}): Promise<readonly DeepSeekAccountModel[]> {
  const { token } = options
  if (!token) return Promise.resolve(DEEPSEEK_ACCOUNT_MODEL_CATALOG)
  return catalogCache.resolve({
    // Keyed by a digest so a different account never reuses the listing.
    accountKey: createHash('sha256').update(token).digest('hex'),
    fetchCatalog: async () => fetchDeepSeekAccountModelCatalog(
      token,
      options.fetchOverride,
      await options.resolveProxyUrl?.(),
    ),
    fallback: DEEPSEEK_ACCOUNT_MODEL_CATALOG,
    ...(options.forceRefresh && { forceRefresh: true }),
  })
}

export function clearDeepSeekAccountModelCatalogCache(): void {
  catalogCache.clear()
}
