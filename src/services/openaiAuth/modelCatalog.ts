import {
  OPENAI_CODEX_API_ENDPOINT,
  OPENAI_CODEX_CLIENT_VERSION,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_TOKEN_USER_AGENT,
} from './client.js'
import { createModelCatalogCache } from '../modelCatalogCache.js'
import { ensureFreshOpenAITokens } from './index.js'
import { getOpenAIOAuthTokens } from './storage.js'
import {
  OPENAI_CODEX_EFFECTIVE_CONTEXT_PERCENT,
  OPENAI_CODEX_MODEL_CATALOG,
  getOpenAIModelCatalogEntry,
  isOpenAIReasoningEffort,
  type OpenAIModelCatalogEntry,
} from './models.js'

export const OPENAI_CODEX_MODELS_ENDPOINT = new URL(
  'models',
  `${OPENAI_CODEX_API_ENDPOINT.replace(/\/responses$/, '')}/`,
).toString()

const MODEL_CATALOG_TTL_MS = 5 * 60_000
const MODEL_CATALOG_TIMEOUT_MS = 5_000
const MODEL_CATALOG_FAILURE_BACKOFF_MS = 60_000
const catalogCache = createModelCatalogCache<OpenAIModelCatalogEntry[]>({
  ttlMs: MODEL_CATALOG_TTL_MS,
  failureBackoffMs: MODEL_CATALOG_FAILURE_BACKOFF_MS,
})

type RemoteReasoningLevel = {
  effort?: unknown
}

type RemoteModelInfo = {
  slug?: unknown
  display_name?: unknown
  description?: unknown
  default_reasoning_level?: unknown
  supported_reasoning_levels?: unknown
  visibility?: unknown
  context_window?: unknown
  effective_context_window_percent?: unknown
}

function normalizeRemoteModel(model: RemoteModelInfo): OpenAIModelCatalogEntry | null {
  if (
    typeof model.slug !== 'string' ||
    !model.slug.trim() ||
    model.visibility !== 'list'
  ) {
    return null
  }

  const fallback = getOpenAIModelCatalogEntry(model.slug)
  const supportedReasoningEfforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
        .map((level) => (level as RemoteReasoningLevel)?.effort)
        .filter(isOpenAIReasoningEffort)
    : []
  const defaultReasoningEffort = isOpenAIReasoningEffort(
    model.default_reasoning_level,
  )
    ? model.default_reasoning_level
    : fallback?.defaultReasoningEffort ?? supportedReasoningEfforts[0] ?? 'medium'
  const contextWindow =
    typeof model.context_window === 'number' && Number.isFinite(model.context_window)
      ? Math.floor(
          model.context_window *
            (typeof model.effective_context_window_percent === 'number'
              ? model.effective_context_window_percent
              : OPENAI_CODEX_EFFECTIVE_CONTEXT_PERCENT) /
            100,
        )
      : fallback?.contextWindow

  return {
    value: model.slug,
    label:
      typeof model.display_name === 'string' && model.display_name.trim()
        ? model.display_name
        : fallback?.label ?? model.slug,
    description:
      typeof model.description === 'string'
        ? model.description.replace(/\.$/, '')
        : fallback?.description ?? '',
    defaultReasoningEffort,
    supportedReasoningEfforts:
      supportedReasoningEfforts.length > 0
        ? supportedReasoningEfforts
        : fallback?.supportedReasoningEfforts ?? ['low', 'medium', 'high'],
    ...(contextWindow ? { contextWindow } : {}),
  }
}

export type OpenAIModelCatalogTokens = {
  accessToken: string
  accountId?: string | null
  email?: string | null
}

export async function fetchOpenAICodexModelCatalog(
  fetchOverride: typeof fetch = globalThis.fetch,
  suppliedTokens?: OpenAIModelCatalogTokens | null,
): Promise<OpenAIModelCatalogEntry[]> {
  const tokens = suppliedTokens === undefined
    ? await ensureFreshOpenAITokens()
    : suppliedTokens
  if (!tokens) {
    throw new Error('OpenAI OAuth token is unavailable')
  }

  const url = new URL(OPENAI_CODEX_MODELS_ENDPOINT)
  url.searchParams.set('client_version', OPENAI_CODEX_CLIENT_VERSION)
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${tokens.accessToken}`,
    originator: OPENAI_CODEX_ORIGINATOR,
    'User-Agent': OPENAI_CODEX_TOKEN_USER_AGENT,
  })
  if (tokens.accountId) {
    headers.set('ChatGPT-Account-Id', tokens.accountId)
  }

  const response = await fetchOverride(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`OpenAI models endpoint returned HTTP ${response.status}`)
  }

  const body = (await response.json()) as { models?: unknown }
  if (!Array.isArray(body.models)) {
    throw new Error('OpenAI models endpoint returned an invalid response')
  }

  return body.models
    .map((model) => normalizeRemoteModel(model as RemoteModelInfo))
    .filter((model): model is OpenAIModelCatalogEntry => model !== null)
}

export async function getOpenAICodexModelCatalog(options?: {
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
  /** Explicit desktop credentials; null must never fall through to CLI storage. */
  tokens?: OpenAIModelCatalogTokens | null
}): Promise<OpenAIModelCatalogEntry[]> {
  const tokens = options?.tokens === undefined ? getOpenAIOAuthTokens() : options.tokens
  const accountKey = tokens
    ? tokens.accountId ?? tokens.email ?? 'authenticated-default'
    : 'logged-out'
  return catalogCache.resolve({
    accountKey,
    fetchCatalog: async () => {
      const models = await fetchOpenAICodexModelCatalog(options?.fetchOverride, options?.tokens)
      if (models.length === 0) {
        throw new Error('OpenAI models endpoint returned no visible models')
      }
      return models
    },
    fallback: OPENAI_CODEX_MODEL_CATALOG,
    ...(options?.forceRefresh ? { forceRefresh: true } : {}),
  })
}

export function clearOpenAICodexModelCatalogCache(): void {
  catalogCache.clear()
}
