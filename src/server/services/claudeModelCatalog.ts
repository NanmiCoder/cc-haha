import { createHash } from 'node:crypto'
import { CLAUDE_CODE_20250219_BETA_HEADER } from '../../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { createModelCatalogCache } from '../../services/modelCatalogCache.js'
import { MODEL_REASONING_EFFORTS } from '../../shared/modelReasoning.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { hahaOAuthService } from './hahaOAuthService.js'
import { getNetworkProxyFetchOptions, loadNetworkSettings } from './networkSettings.js'

export type ClaudeModelCatalogEntry = {
  id: string
  name: string
  description: string
  context: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: string[]
}

export const CLAUDE_MODEL_CATALOG: ClaudeModelCatalogEntry[] = [
  {
    id: 'claude-fable-5-1',
    name: 'Fable 5.1',
    description: 'Highest capability for long-running tasks',
    context: '1m',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-fable-5',
    name: 'Fable 5',
    description: 'Highest capability for long-running tasks',
    context: '1m',
  },
  {
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    description: 'Best for complex agentic coding and enterprise work',
    context: '1m',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-opus-5',
    name: 'Opus 5',
    description: 'Best for complex agentic coding and enterprise work',
    context: '1m',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    description: 'Best for complex agentic coding and enterprise work',
    context: '1m',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Sonnet 5.5',
    description: 'Best combination of speed and intelligence',
    context: '1m',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    description: 'Best combination of speed and intelligence',
    context: '1m',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-haiku-5-5',
    name: 'Haiku 5.5',
    description: 'Fastest for high-volume, latency-sensitive tasks',
    context: '1m',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    description: 'Fastest with near-frontier intelligence',
    context: '200k',
  },
]

export const CLAUDE_MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models'
const MODEL_CATALOG_MAX_PAGES = 10
const MODEL_CATALOG_TIMEOUT_MS = 5_000
const catalogCache = createModelCatalogCache<ClaudeModelCatalogEntry[]>({
  ttlMs: 5 * 60_000,
  failureBackoffMs: 60_000,
})

function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeModel(value: unknown): ClaudeModelCatalogEntry | null {
  const entry = fieldsOf(value)
  const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
  if (!entry || !id || entry.lifecycle === 'retired') return null
  const fallback = CLAUDE_MODEL_CATALOG.find(model => model.id === id)
  const effort = fieldsOf(fieldsOf(entry.capabilities)?.effort)
  const supportedReasoningEfforts = effort?.supported === false
    ? []
    : effort?.supported === true
      ? MODEL_REASONING_EFFORTS.filter(level => fieldsOf(effort[level])?.supported === true)
      : fallback?.supportedReasoningEfforts
  const defaultReasoningEffort = supportedReasoningEfforts?.length
    ? fallback?.defaultReasoningEffort && supportedReasoningEfforts.includes(fallback.defaultReasoningEffort)
      ? fallback.defaultReasoningEffort
      : supportedReasoningEfforts.includes('medium') ? 'medium' : supportedReasoningEfforts[0]
    : undefined

  return {
    id,
    name: typeof entry.display_name === 'string' && entry.display_name.trim()
      ? entry.display_name.trim()
      : fallback?.name ?? id,
    description: fallback?.description ?? '',
    context: typeof entry.max_input_tokens === 'number' && Number.isSafeInteger(entry.max_input_tokens) && entry.max_input_tokens > 0
      ? String(entry.max_input_tokens)
      : fallback?.context ?? '',
    ...(supportedReasoningEfforts && { supportedReasoningEfforts: [...supportedReasoningEfforts] }),
    ...(defaultReasoningEffort && { defaultReasoningEffort }),
  }
}

async function fetchClaudeModelCatalog(accessToken: string, fetchOverride: typeof fetch): Promise<ClaudeModelCatalogEntry[]> {
  const networkSettings = await loadNetworkSettings()
  const signal = AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS)
  const models = new Map<string, ClaudeModelCatalogEntry>()
  const cursors = new Set<string>()
  let afterId: string | undefined

  // https://platform.claude.com/docs/en/api/models/list uses last_id/after_id.
  // Keep one deadline for the complete listing, and reject partial listings.
  for (let page = 0; page < MODEL_CATALOG_MAX_PAGES; page += 1) {
    const url = new URL(CLAUDE_MODELS_ENDPOINT)
    url.searchParams.set('limit', '1000')
    if (afterId) url.searchParams.set('after_id', afterId)
    const response = await fetchOverride(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': `${CLAUDE_CODE_20250219_BETA_HEADER},${OAUTH_BETA_HEADER}`,
        'User-Agent': getClaudeCodeUserAgent(),
        'x-app': 'cli',
      },
      redirect: 'error',
      signal,
      ...getNetworkProxyFetchOptions(networkSettings, url),
    })
    if (!response.ok) throw new Error(`Claude models endpoint returned HTTP ${response.status}`)
    const body = fieldsOf(await response.json())
    if (!Array.isArray(body?.data) || (body.has_more !== undefined && typeof body.has_more !== 'boolean')) {
      throw new Error('Claude models endpoint returned an invalid response')
    }
    for (const row of body.data) {
      const model = normalizeModel(row)
      if (model && !models.has(model.id)) models.set(model.id, model)
    }
    if (!body.has_more) {
      if (!models.size) throw new Error('Claude models endpoint returned no models')
      return [...models.values()]
    }
    const cursor = typeof body.last_id === 'string' ? body.last_id.trim() : ''
    if (!cursor || !body.data.length || cursors.has(cursor)) {
      throw new Error('Claude models endpoint returned an invalid pagination cursor')
    }
    cursors.add(cursor)
    afterId = cursor
  }
  throw new Error('Claude model listing pagination did not finish')
}

/** The desktop account alone owns discovery; CLI credentials are never consulted. */
export async function getDesktopClaudeModelCatalog(options?: {
  forceRefresh?: boolean
  throwOnError?: boolean
  fetchOverride?: typeof fetch
}): Promise<ClaudeModelCatalogEntry[]> {
  const tokens = await hahaOAuthService.ensureFreshTokens().catch(() => null)
  if (!tokens?.accessToken) {
    if (options?.forceRefresh && options.throwOnError) throw new Error('Claude OAuth token is unavailable')
    return CLAUDE_MODEL_CATALOG
  }
  return catalogCache.resolve({
    accountKey: createHash('sha256').update(tokens.accessToken).digest('hex'),
    fetchCatalog: () => fetchClaudeModelCatalog(tokens.accessToken, options?.fetchOverride ?? globalThis.fetch),
    fallback: CLAUDE_MODEL_CATALOG,
    forceRefresh: options?.forceRefresh,
    throwOnError: options?.throwOnError,
  })
}

export function clearDesktopClaudeModelCatalogCache(): void {
  catalogCache.clear()
}
